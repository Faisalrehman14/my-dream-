/**
 * Server-side notification broadcast queue.
 * Sends utility messages slowly to respect Meta rate limits (safe for 5k+ customers).
 */
const crypto = require('crypto');

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
const DELAY_MS = Number(process.env.BROADCAST_DELAY_MS) || 2500;
const RATE_LIMIT_PAUSE_MS = Number(process.env.BROADCAST_RATE_LIMIT_PAUSE_MS) || 1200000;
const MAX_RECIPIENTS = Number(process.env.BROADCAST_MAX_RECIPIENTS) || 10000;

const jobs = new Map();
let processorRunning = false;

function normalizeOutgoingText(text) {
  return String(text ?? '').normalize('NFC');
}

const JSON_UTF8 = { 'Content-Type': 'application/json; charset=utf-8' };

function utf8JsonBody(body) {
  return Buffer.from(JSON.stringify(body), 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publicJob(job) {
  const remaining = Math.max(0, job.total - job.index);
  const etaMinutes = Math.ceil((remaining * DELAY_MS) / 60000);
  return {
    id: job.id,
    status: job.status,
    message: job.message,
    total: job.total,
    sent: job.sent,
    failed: job.failed.length,
    index: job.index,
    progress: job.total ? Math.round((job.index / job.total) * 100) : 0,
    etaMinutes,
    pausedUntil: job.pausedUntil || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    recentFailures: job.failed.slice(-5),
  };
}

function isAllowedUtilityTemplateName(name) {
  const n = String(name || '').toLowerCase();
  if (!n.startsWith('pagechat_') || !n.includes('_custom_') || n.includes('_lib_')) return false;
  const blocked = ['post_purchase', 'account_update', 'order_confirm', 'good_news'];
  return !blocked.some((part) => n.includes(part));
}

function validateStartPayload(body) {
  if (!body?.pageId || !body?.pageToken || !body?.detail?.trim()) {
    return 'pageId, pageToken, and detail are required';
  }
  if (!body.directOnly && !body?.templateName) {
    return 'templateName is required unless directOnly is true';
  }
  if (!body.directOnly && !isAllowedUtilityTemplateName(body.templateName)) {
    return 'Only pagechat custom templates are allowed (library/order templates blocked)';
  }
  if (!Array.isArray(body.recipients) || !body.recipients.length) {
    return 'At least one recipient is required';
  }
  if (body.recipients.length > MAX_RECIPIENTS) {
    return `Maximum ${MAX_RECIPIENTS} recipients per campaign`;
  }
  for (const r of body.recipients) {
    if (!r?.psid) return 'Each recipient needs a psid';
  }
  return null;
}

function createJob(payload) {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'queued',
    pageId: String(payload.pageId),
    pageToken: payload.pageToken,
    templateName: payload.templateName || '',
    language: payload.language || 'en',
    detail: normalizeOutgoingText(payload.detail).trim(),
    directOnly: Boolean(payload.directOnly),
    recipients: payload.recipients.map((r) => ({
      psid: String(r.psid),
      name: r.name || r.psid,
    })),
    sent: 0,
    failed: [],
    total: payload.recipients.length,
    index: 0,
    pausedUntil: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    message: 'Queued — starting soon',
  };
  jobs.set(id, job);
  scheduleProcessor();
  return job;
}

async function sendDirect(job, recipient) {
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${job.pageId}/messages` +
    `?access_token=${encodeURIComponent(job.pageToken)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: JSON_UTF8,
    body: utf8JsonBody({
      recipient: { id: recipient.psid },
      messaging_type: 'RESPONSE',
      message: { text: job.detail },
    }),
  });
  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error.message || 'Send failed');
    err.code = data.error.code;
    throw err;
  }
  return data;
}

function templateBodyFromRecord(tpl) {
  const components = tpl?.components || [];
  const bodyComp = components.find((c) => String(c.type || '').toUpperCase() === 'BODY');
  return bodyComp?.text || '';
}

function hasUnwantedWrapper(body) {
  const b = String(body || '').toLowerCase();
  const blocked = [
    'your account update',
    'contact us if this was not you',
    'account update:',
    'thank you for your order',
    'good news!',
    'good news',
    'your order is now',
    'order is now',
    'reminder: your appointment',
    'your appointment is',
    'your recent purchase',
    'shipment tracking',
  ];
  return blocked.some((phrase) => b.includes(phrase));
}

function isExactMessageBody(body) {
  const b = String(body || '').trim();
  if (b === '{{1}}') return true;
  return /^[\u200B-\u200D\u2060\uFEFF\u00A0]*\{\{1\}\}[\u200B-\u200D\u2060\uFEFF\u00A0]*$/.test(b);
}

const SENDABLE_CUSTOM_BODIES = new Set([
  '({{1}})',
  'Message:\n{{1}}',
  'Update:\n{{1}}',
  'Hello,\n\n{{1}}',
]);

function isSendableCustomBody(body) {
  const b = String(body || '').trim();
  if (!b || hasUnwantedWrapper(b)) return false;
  if (isExactMessageBody(b)) return true;
  return SENDABLE_CUSTOM_BODIES.has(b);
}

async function fetchTemplateByName(pageId, pageToken, name) {
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/message_templates` +
    `?fields=name,status,language,components&limit=25` +
    `&name=${encodeURIComponent(name)}` +
    `&access_token=${encodeURIComponent(pageToken)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error.message || 'Template lookup failed');
    err.code = data.error.code;
    throw err;
  }
  const match = (data.data || []).find((t) => t.name === name);
  if (match?.components?.length) return match;
  const allUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/message_templates` +
    `?fields=name,status,language,components&limit=100` +
    `&access_token=${encodeURIComponent(pageToken)}`;
  const allRes = await fetch(allUrl);
  const allData = await allRes.json();
  if (allData.error) {
    const err = new Error(allData.error.message || 'Template lookup failed');
    err.code = allData.error.code;
    throw err;
  }
  return (allData.data || []).find((t) => t.name === name) || match || null;
}

async function assertExactTemplateForSend(pageId, pageToken, templateName) {
  const tpl = await fetchTemplateByName(pageId, pageToken, templateName);
  if (!tpl) {
    throw new Error(
      `Template "${templateName}" not found on Meta. Open Notifications, wait for v17 setup, start a new bulk send.`
    );
  }
  const body = templateBodyFromRecord(tpl);
  if (!body) {
    throw new Error(
      `Template "${templateName}" has no readable body on Meta. Open Notifications and wait for setup.`
    );
  }
  if (!isSendableCustomBody(body) || hasUnwantedWrapper(body)) {
    throw new Error(
      `Blocked wrapper template "${templateName}" (body starts: ${body.slice(0, 48)}…). Cancel this bulk job and start a new send after opening Notifications.`
    );
  }
  return tpl;
}

async function sendUtility(job, recipient) {
  if (!isAllowedUtilityTemplateName(job.templateName)) {
    throw new Error(
      'Blocked library/order template on server. Open Notifications, wait for custom template setup, then start a new bulk send.'
    );
  }
  await assertExactTemplateForSend(job.pageId, job.pageToken, job.templateName);
  const langs = templateLanguageVariants(job.language);
  let lastErr = null;
  for (const code of langs) {
    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/${job.pageId}/messages` +
      `?access_token=${encodeURIComponent(job.pageToken)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: JSON_UTF8,
      body: utf8JsonBody({
        recipient: { id: recipient.psid },
        messaging_type: 'UTILITY',
        message: {
          template: {
            name: job.templateName,
            language: { code },
            components: [
              {
                type: 'body',
                parameters: [{ type: 'text', text: job.detail }],
              },
            ],
          },
        },
      }),
    });
    const data = await res.json();
    if (!data.error) return data;
    const err = new Error(data.error.message || 'Send failed');
    err.code = data.error.code;
    lastErr = err;
    if (err.code === 4) throw err;
    if (err.code !== 100 && !String(err.message).toLowerCase().includes('template cannot be found') && !String(err.message).includes('(#100)')) {
      throw err;
    }
  }
  throw lastErr || new Error('(#100) Template cannot be found.');
}

function parseTemplateLanguage(lang) {
  if (!lang) return 'en';
  if (typeof lang === 'string') return lang.trim();
  return 'en';
}

function templateLanguageVariants(lang) {
  const raw = parseTemplateLanguage(lang);
  const variants = [];
  const add = (code) => {
    const v = String(code || '').trim();
    if (v && !variants.includes(v)) variants.push(v);
  };
  add(raw);
  if (raw.includes('_')) add(raw.split('_')[0]);
  else if (raw.length === 2) add(`${raw}_US`);
  add('en_US');
  add('en');
  return variants;
}

function isMessagingWindowError(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (err?.code === 551) return true;
  if (msg.includes('outside') && msg.includes('window')) return true;
  if (msg.includes('24 hour') || msg.includes('24-hour')) return true;
  if (msg.includes('messaging window')) return true;
  if (err?.code === 10 && (msg.includes('outside') || msg.includes('window') || msg.includes('24 hour'))) {
    return true;
  }
  return false;
}

async function sendOne(job, recipient) {
  try {
    return await sendDirect(job, recipient);
  } catch (err) {
    if (err.code === 4) throw err;
    if (!isMessagingWindowError(err)) throw err;
    if (!job.templateName) {
      throw new Error(
        'No utility template on this Page. Open Notifications while logged in, wait for template setup, then retry bulk send.'
      );
    }
    if (!isAllowedUtilityTemplateName(job.templateName)) {
      throw new Error(
        'Blocked library/order template. Open Notifications, wait for custom template, then start a new bulk send.'
      );
    }
    return sendUtility(job, recipient);
  }
}

async function processJobs() {
  if (processorRunning) return;
  processorRunning = true;

  try {
    while (true) {
      const job = [...jobs.values()].find(
        (j) => j.status === 'queued' || j.status === 'running' || j.status === 'paused'
      );
      if (!job) break;

      if (job.status === 'cancelled') {
        job.message = 'Cancelled by user';
        continue;
      }

      if (job.index >= job.total) {
        job.status = 'completed';
        job.message = `Completed — sent ${job.sent} of ${job.total}`;
        job.updatedAt = Date.now();
        continue;
      }

      if (job.pausedUntil && Date.now() < job.pausedUntil) {
        job.status = 'paused';
        const mins = Math.ceil((job.pausedUntil - Date.now()) / 60000);
        job.message = `Facebook rate limit — auto-resume in ~${mins} min`;
        job.updatedAt = Date.now();
        await sleep(5000);
        continue;
      }

      if (job.pausedUntil && Date.now() >= job.pausedUntil) {
        job.pausedUntil = null;
      }

      job.status = 'running';
      const recipient = job.recipients[job.index];
      job.message = `Sending ${job.index + 1} of ${job.total}… (${recipient.name})`;

      try {
        await sendOne(job, recipient);
        job.sent++;
      } catch (e) {
        if (e.code === 4) {
          job.pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
          job.status = 'paused';
          job.message = 'Facebook rate limit hit — pausing ~20 minutes, then continuing automatically';
          job.updatedAt = Date.now();
          await sleep(5000);
          continue;
        }
        job.failed.push({
          psid: recipient.psid,
          name: recipient.name,
          error: e.message,
        });
      }

      job.index++;
      job.updatedAt = Date.now();
      await sleep(DELAY_MS);
    }
  } finally {
    processorRunning = false;
    const hasActive = [...jobs.values()].some(
      (j) => j.status === 'queued' || j.status === 'running' || j.status === 'paused'
    );
    if (hasActive) scheduleProcessor();
  }
}

function scheduleProcessor() {
  setImmediate(() => {
    processJobs().catch((err) => console.error('[Broadcast]', err.message));
  });
}

function attachBroadcastRoutes(app) {
  app.post('/api/broadcast/start', (req, res) => {
    const error = validateStartPayload(req.body);
    if (error) return res.status(400).json({ error });

    const active = [...jobs.values()].find(
      (j) => j.status === 'queued' || j.status === 'running' || j.status === 'paused'
    );
    if (active) {
      return res.status(409).json({
        error: 'Another broadcast is already running. Wait for it to finish or cancel it first.',
        job: publicJob(active),
      });
    }

    const job = createJob(req.body);
    console.log('[Broadcast] Started', job.id, job.total, 'recipients');
    res.json({ job: publicJob(job) });
  });

  app.get('/api/broadcast/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ job: publicJob(job) });
  });

  app.post('/api/broadcast/:id/cancel', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Campaign not found' });
    if (job.status === 'completed' || job.status === 'cancelled') {
      return res.json({ job: publicJob(job) });
    }
    job.status = 'cancelled';
    job.message = 'Cancelled';
    job.updatedAt = Date.now();
    console.log('[Broadcast] Cancelled', job.id);
    res.json({ job: publicJob(job) });
  });

  app.get('/api/broadcast/active/status', (_, res) => {
    const active = [...jobs.values()].find(
      (j) => j.status === 'queued' || j.status === 'running' || j.status === 'paused'
    );
    res.json({ job: active ? publicJob(active) : null });
  });
}

module.exports = { attachBroadcastRoutes };
