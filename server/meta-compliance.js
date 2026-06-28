/**
 * Meta Platform compliance — deauthorize & data-deletion callbacks
 * @see https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
 */
const crypto = require('crypto');

/** confirmationCode → { userId, createdAt, status } */
const deletionRequests = new Map();

function base64UrlDecode(input) {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function parseSignedRequest(signedRequest, appSecret) {
  if (!signedRequest || !appSecret) return null;
  const parts = String(signedRequest).split('.');
  if (parts.length !== 2) return null;
  const [encodedSig, payload] = parts;
  try {
    const sig = base64UrlDecode(encodedSig);
    const expected = crypto.createHmac('sha256', appSecret).update(payload).digest();
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
    return JSON.parse(base64UrlDecode(payload).toString('utf8'));
  } catch {
    return null;
  }
}

function makeConfirmationCode(userId) {
  return crypto
    .createHash('sha256')
    .update(`${userId}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
}

function registerDeletionRequest(userId) {
  const confirmation_code = makeConfirmationCode(userId);
  deletionRequests.set(confirmation_code, {
    userId: String(userId),
    createdAt: new Date().toISOString(),
    status: 'completed',
  });
  return confirmation_code;
}

function getDeletionStatus(code) {
  return deletionRequests.get(String(code || '').toUpperCase()) || null;
}

function attachMetaCompliance(app, { appSecret, getBaseUrl }) {
  app.get('/api/deauthorize', (_req, res) => {
    res.json({
      ok: true,
      message: 'Meta deauthorize callback — POST signed_request when a user removes the app.',
    });
  });

  app.post('/api/deauthorize', (req, res) => {
    const signed = req.body?.signed_request;
    if (!appSecret) {
      console.warn('[Deauth] APP_SECRET not set — cannot verify signed_request');
      return res.status(503).send('APP_SECRET required');
    }
    const data = parseSignedRequest(signed, appSecret);
    if (!data?.user_id) {
      console.warn('[Deauth] Invalid or missing signed_request');
      return res.status(400).send('Invalid signed_request');
    }
    console.log('[Deauth] User deauthorized app', { userId: data.user_id });
    // No persistent user database — nothing else to purge server-side.
    return res.status(200).send('OK');
  });

  app.get('/api/data-deletion', (_req, res) => {
    res.json({
      ok: true,
      message: 'Meta data deletion callback — POST signed_request when a user requests deletion.',
    });
  });

  app.post('/api/data-deletion', (req, res) => {
    const signed = req.body?.signed_request;
    if (!appSecret) {
      return res.status(503).json({ error: 'APP_SECRET required on server' });
    }
    const data = parseSignedRequest(signed, appSecret);
    if (!data?.user_id) {
      return res.status(400).json({ error: 'Invalid signed_request' });
    }
    const confirmation_code = registerDeletionRequest(data.user_id);
    const base = getBaseUrl(req);
    const url = `${base}/data-deletion/status.html?code=${confirmation_code}`;
    console.log('[DataDeletion] Request recorded', { userId: data.user_id, confirmation_code });
    return res.json({ url, confirmation_code });
  });

  app.get('/api/deletion-status/:code', (req, res) => {
    const row = getDeletionStatus(req.params.code);
    if (!row) return res.status(404).json({ error: 'Unknown confirmation code' });
    res.json({
      status: row.status,
      confirmation_code: req.params.code.toUpperCase(),
      requested_at: row.createdAt,
      message:
        'Your data deletion request has been processed. We do not store Facebook messages on our servers. Any webhook delivery logs are purged within 30 days.',
    });
  });
}

module.exports = {
  attachMetaCompliance,
  parseSignedRequest,
  getDeletionStatus,
  registerDeletionRequest,
};
