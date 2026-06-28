/**
 * PageChat Hub — Production server (Railway / Render)
 * Serves the web app + Messenger webhook on one HTTPS URL.
 */
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { attachMetaCompliance } = require('./meta-compliance');
const { attachBroadcastRoutes } = require('./broadcast');

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'pagechat_verify_token';
const APP_SECRET = process.env.APP_SECRET || '';
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || '';
const ADMIN_ACCESS_KEY = process.env.ADMIN_ACCESS_KEY || '';
const APP_NAME = process.env.APP_BRAND_NAME || 'Wayfair';
const BUILD = process.env.PAGECHAT_BUILD || '20260601-33';

const WEB_ROOT = path.join(__dirname, '..');

/** pageId → timestamp of last webhook message (client polls for instant inbox refresh) */
const inboxSignals = new Map();

app.use(express.json({ type: 'application/json' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api', (req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

function baseUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

attachMetaCompliance(app, {
  appSecret: APP_SECRET,
  getBaseUrl: baseUrl,
});

attachBroadcastRoutes(app);

// ─── Meta Webhook ─────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Webhook] Verified successfully');
    return res.status(200).send(challenge);
  }
  console.warn('[Webhook] Verification failed — check VERIFY_TOKEN');
  return res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (APP_SECRET && !verifySignature(req)) {
    console.warn('[Webhook] Invalid signature');
    return res.sendStatus(403);
  }

  const body = req.body;
  if (body.object === 'page') {
    body.entry?.forEach((entry) => {
      const pageId = String(entry.id);
      entry.messaging?.forEach((event) => {
        const isMessage = Boolean(event.message);
        const isEcho = Boolean(event.message?.is_echo);
        const isRead = Boolean(event.read);
        const isDelivery = Boolean(event.delivery);
        if (isMessage || isRead || isDelivery) {
          inboxSignals.set(pageId, Date.now());
          if (isMessage) {
            console.log('[Message]', {
              pageId,
              sender: event.sender?.id,
              echo: isEcho,
              text: event.message.text,
            });
          }
        }
      });
    });
  }

  res.sendStatus(200);
});

app.get('/api/inbox-signal', (req, res) => {
  const pageId = String(req.query.pageId || '');
  const since = Number(req.query.since) || 0;
  const at = inboxSignals.get(pageId) || 0;
  res.json({ pageId, at, hasNew: at > since });
});

app.get('/health', (_, res) => {
  res.json({
    ok: true,
    app: APP_NAME,
    build: BUILD,
    webhook: '/webhook',
    deauthorizeCallback: '/api/deauthorize',
    dataDeletionCallback: '/api/data-deletion',
    facebookAppIdSet: Boolean(FACEBOOK_APP_ID),
    verifyTokenSet: VERIFY_TOKEN !== 'pagechat_verify_token',
    appSecretSet: Boolean(APP_SECRET),
    complianceReady: Boolean(APP_SECRET && FACEBOOK_APP_ID),
  });
});

// App ID for public users (no manual entry on login page)
/** Inspect token scopes (APP_SECRET required on Railway) */
app.post('/api/debug-token', async (req, res) => {
  const input = req.body?.input_token;
  if (!input) {
    return res.status(400).json({ error: { message: 'input_token required' } });
  }
  if (!APP_SECRET || !FACEBOOK_APP_ID) {
    return res.status(503).json({
      error: { message: 'Set APP_SECRET and FACEBOOK_APP_ID on the server to debug tokens.' },
    });
  }
  try {
    const appToken = `${FACEBOOK_APP_ID}|${APP_SECRET}`;
    const ver = process.env.GRAPH_API_VERSION || 'v21.0';
    const url =
      `https://graph.facebook.com/${ver}/debug_token` +
      `?input_token=${encodeURIComponent(input)}` +
      `&access_token=${encodeURIComponent(appToken)}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

app.get('/js/env.js', (_, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('application/javascript').send(
    `window.__PAGECHAT__=${JSON.stringify({
      appId: FACEBOOK_APP_ID,
      adminKey: ADMIN_ACCESS_KEY,
      build: BUILD,
    })};`
  );
});

// ─── Static app (frontend) — do not cache JS/CSS/HTML (avoids stale api.js on Railway) ───
app.use((req, res, next) => {
  if (/\.(js|css|html)$/.test(req.path) || req.path === '/js/env.js') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(WEB_ROOT, { etag: true, lastModified: true, maxAge: 0 }));

app.get('*', (req, res, next) => {
  if (
    req.path.startsWith('/webhook') ||
    req.path.startsWith('/api/') ||
    req.path === '/health'
  ) {
    return next();
  }
  const file = path.join(WEB_ROOT, req.path);
  if (req.path.includes('.')) return res.status(404).send('Not found');
  res.sendFile(path.join(WEB_ROOT, 'index.html'));
});

function verifySignature(req) {
  const sig = req.get('X-Hub-Signature-256');
  if (!sig) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', APP_SECRET).update(JSON.stringify(req.body)).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

app.listen(PORT, () => {
  console.log(`${APP_NAME} live on port ${PORT}`);
  console.log(`Webhook URL: /webhook`);
  console.log(`Verify token: ${VERIFY_TOKEN}`);
});
