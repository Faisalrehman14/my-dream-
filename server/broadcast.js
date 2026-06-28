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

function validateStartPayload(body) {
  if (!body?.pageId || !body?.pageToken || !body?.templateName || !body?.detail?.trim()) {
    return 'pageId, pageToken, templateName, and detail are required';
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
    templateName: payload.templateName,
    language: payload.language || 'en',
    detail: String(payload.detail).trim(),
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

async function sendOne(job, recipient) {
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${job.pageId}/messages` +
    `?access_token=${encodeURIComponent(job.pageToken)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipient.psid },
      messaging_type: 'UTILITY',
      message: {
        template: {
          name: job.templateName,
          language: { code: job.language },
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
  if (data.error) {
    const err = new Error(data.error.message || 'Send failed');
    err.code = data.error.code;
    throw err;
  }
  return data;
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
