const Utility = (function () {
  'use strict';

  const TEMPLATE_VERSION = 'v4';

  /** Page-owned Messenger utility templates (auto-approved by Meta). */
  const OWNED_TEMPLATES = {
    POST_PURCHASE_UPDATE: {
      bodyText: 'Good news! Your order is now {{1}}. Thank you for your order.',
      example: 'scheduled to arrive on 10 May',
      preview: 'Good news! Your order is now … Thank you for your order.',
    },
    CONFIRMED_EVENT_UPDATE: {
      bodyText: 'Reminder: your appointment is {{1}}.',
      example: 'confirmed for 10 May at 2:00 PM',
      preview: 'Reminder: your appointment is …',
    },
    ACCOUNT_UPDATE: {
      bodyText: 'Your account update: {{1}}.',
      example: 'your password was changed successfully',
      preview: 'Your account update: …',
    },
  };

  let preparedPageId = null;
  let preparePromise = null;
  const readyTemplates = new Map();

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function ownedTemplateName(pageId, categoryKey) {
    return `pagechat_${TEMPLATE_VERSION}_${categoryKey.toLowerCase()}_${String(pageId).slice(-10)}`;
  }

  function ownedPayload(name, def) {
    return {
      name,
      language: 'en',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: def.bodyText,
          example: { body_text: [[def.example]] },
        },
      ],
    };
  }

  function normalizeOwned(pageName, def) {
    return {
      name: pageName,
      language: 'en',
      status: 'APPROVED',
      body: def.bodyText,
      preview: def.preview,
      bodyParamCount: 1,
      paramRoles: ['detail'],
      buttons: [],
    };
  }

  async function findPageTemplate(pageId, pageToken, name) {
    const list = await GraphAPI.getPageMessageTemplates(pageId, pageToken, { name });
    return list.find((t) => t.name === name) || null;
  }

  async function ensureOwnedTemplate(pageId, pageToken, categoryKey) {
    const def = OWNED_TEMPLATES[categoryKey];
    if (!def) throw new Error('Unknown notification type');

    const primaryName = ownedTemplateName(pageId, categoryKey);
    let existing = await findPageTemplate(pageId, pageToken, primaryName);

    if (existing?.status === 'APPROVED') {
      return normalizeOwned(primaryName, def);
    }

    if (existing?.status === 'PENDING') {
      await sleep(1500);
      existing = await findPageTemplate(pageId, pageToken, primaryName);
      if (existing?.status === 'APPROVED') {
        return normalizeOwned(primaryName, def);
      }
    }

    const createName =
      existing?.status === 'REJECTED'
        ? `${primaryName}_${Date.now().toString(36).slice(-5)}`
        : primaryName;

    if (!existing || existing.status === 'REJECTED') {
      try {
        const created = await GraphAPI.createPageUtilityTemplate(
          pageId,
          pageToken,
          ownedPayload(createName, def)
        );
        if (created.status && created.status !== 'APPROVED') {
          await sleep(1200);
          const again = await findPageTemplate(pageId, pageToken, createName);
          if (again?.status !== 'APPROVED') {
            throw new Error(`Template "${createName}" is ${(again?.status || created.status).toLowerCase()}.`);
          }
        }
        return normalizeOwned(createName, def);
      } catch (err) {
        const again = await findPageTemplate(pageId, pageToken, createName);
        if (again?.status === 'APPROVED') return normalizeOwned(createName, def);
        throw err;
      }
    }

    throw new Error(`Template "${primaryName}" is ${existing.status.toLowerCase()}.`);
  }

  function buildSendComponents(tpl, detail, customerName) {
    const components = [];
    const roles = tpl.paramRoles?.length ? tpl.paramRoles : ['detail'];
    const bodyParameters = roles.map((role) => ({
      type: 'text',
      text: role === 'name' ? customerName || 'Customer' : detail,
    }));

    if (bodyParameters.length) {
      components.push({ type: 'body', parameters: bodyParameters });
    }

    if (tpl.buttons?.length) {
      components.push({
        type: 'buttons',
        parameters: tpl.buttons.map((btn) => {
          if (btn.type === 'URL') return { type: 'URL', url: 'https://www.example.com' };
          return { type: 'POSTBACK', payload: 'pagechat_notification' };
        }),
      });
    }

    return components;
  }

  function formatPreview(tpl) {
    if (!tpl?.preview) return 'Templates ready. You can send notifications.';
    return `Template ready: "${tpl.preview}"`;
  }

  async function prepare(page) {
    if (!page?.id || !page?.access_token) return;
    if (preparePromise && preparedPageId === page.id) return preparePromise;

    preparedPageId = page.id;
    preparePromise = (async () => {
      readyTemplates.clear();
      showStatus('Preparing Messenger notification templates…', true, true);
      const errors = [];
      for (const key of Object.keys(OWNED_TEMPLATES)) {
        try {
          const tpl = await ensureOwnedTemplate(page.id, page.access_token, key);
          readyTemplates.set(key, tpl);
        } catch (err) {
          errors.push(err.message);
        }
      }
      if (readyTemplates.size) {
        const activeType = document.getElementById('utility-tag')?.value;
        const activeTpl = readyTemplates.get(activeType);
        showStatus(formatPreview(activeTpl || readyTemplates.values().next().value), true);
      } else if (errors.length) {
        showStatus(errors[0], false);
      } else {
        hideStatus();
      }
    })();

    try {
      await preparePromise;
    } finally {
      preparePromise = null;
    }
  }

  function rememberPreview(pageId, psid, text, tpl) {
    if (!pageId || !psid || !text) return;
    const preview = tpl?.body
      ? tpl.body.replace(/\{\{1\}\}/, text.trim())
      : text.trim();
    try {
      const key = FB_CONFIG.storageKeys.utilityPreviews;
      const state = JSON.parse(localStorage.getItem(key) || '{}');
      if (!state[pageId]) state[pageId] = {};
      state[pageId][psid] = preview.slice(0, 160);
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }

  function getPreview(pageId, psid) {
    if (!pageId || !psid) return '';
    try {
      const key = FB_CONFIG.storageKeys.utilityPreviews;
      const state = JSON.parse(localStorage.getItem(key) || '{}');
      return state[pageId]?.[psid] || '';
    } catch {
      return '';
    }
  }

  async function send(page, psid, text, categoryKey, options = {}) {
    if (!page?.id || !page?.access_token) throw new Error('Select a Page first');
    if (!psid || !text?.trim()) throw new Error('Select a customer and enter a message');

    const detail = text.trim();
    const customerName = options.customerName || 'Customer';

    const tpl = await ensureOwnedTemplate(page.id, page.access_token, categoryKey);
    readyTemplates.set(categoryKey, tpl);

    const components = buildSendComponents(tpl, detail, customerName);
    const result = await GraphAPI.sendUtilityTemplateMessage(page.id, page.access_token, psid, {
      name: tpl.name,
      language: { code: tpl.language || 'en' },
      components,
    });
    rememberPreview(page.id, psid, detail, tpl);
    return result;
  }

  async function sendToAll(page, recipients, text, categoryKey, options = {}) {
    if (!page?.id || !page?.access_token) throw new Error('Select a Page first');
    if (!text?.trim()) throw new Error('Enter a message');
    if (!recipients?.length) throw new Error('No subscribers found in your inbox');

    const { onProgress, delayMs = 400 } = options;
    const results = { sent: 0, failed: [], total: recipients.length };

    for (let i = 0; i < recipients.length; i++) {
      const { psid, name } = recipients[i];
      onProgress?.({ current: i + 1, total: recipients.length, name });
      try {
        await send(page, psid, text, categoryKey, { customerName: name });
        results.sent++;
      } catch (err) {
        results.failed.push({ psid, name, error: err.message });
      }
      if (i < recipients.length - 1) await sleep(delayMs);
    }

    if (!results.sent && results.failed.length) {
      throw new Error(results.failed[0].error || 'Could not send notifications');
    }
    return results;
  }

  function showStatus(msg, ok, loading) {
    const el = document.getElementById('utility-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'status-msg ' + (ok ? 'ok' : 'err') + (loading ? ' status-msg--loading' : '');
    el.classList.remove('hidden');
  }

  function hideStatus() {
    const el = document.getElementById('utility-status');
    if (!el) return;
    el.classList.add('hidden');
  }

  function reset() {
    preparedPageId = null;
    preparePromise = null;
    readyTemplates.clear();
  }

  return { prepare, send, sendToAll, getPreview, showStatus, hideStatus, reset };
})();
