const Utility = (function () {
  'use strict';

  const TEMPLATE_VERSION = 'v6';

  /** Page-owned Messenger utility templates (auto-approved by Meta). */
  const OWNED_TEMPLATES = {
    POST_PURCHASE_UPDATE: {
      prefix: 'Your order update:',
      suffix: ' Thank you for your order.',
      example: 'scheduled to arrive on 10 May',
      detailPlaceholder: 'scheduled to arrive on 10 May',
    },
    CONFIRMED_EVENT_UPDATE: {
      prefix: 'Your appointment is scheduled for',
      suffix: '. Reply if you need help.',
      example: '10 May at 2:00 PM',
      detailPlaceholder: '10 May at 2:00 PM',
    },
    ACCOUNT_UPDATE: {
      prefix: 'Your account update:',
      suffix: ' Contact us if this was not you.',
      example: 'your password was changed successfully',
      detailPlaceholder: 'your password was changed successfully',
    },
  };

  const MARKETING_WORDS = /\b(sale|discount|offer|free|buy now|click here|limited time|promo|deal|win|% off|subscribe now)\b/i;

  let preparedPageId = null;
  let preparePromise = null;
  const readyTemplates = new Map();

  function getCustomTemplatesState() {
    try {
      return JSON.parse(localStorage.getItem(FB_CONFIG.storageKeys.utilityTemplates) || '{}');
    } catch {
      return {};
    }
  }

  function saveCustomTemplatesState(state) {
    localStorage.setItem(FB_CONFIG.storageKeys.utilityTemplates, JSON.stringify(state));
  }

  function buildBodyText(prefix, suffix) {
    const safeSuffix = String(suffix || '').trim() || '.';
    const gap = safeSuffix.startsWith('.') || safeSuffix.startsWith(',') ? '' : ' ';
    return `${String(prefix || '').trim()} {{1}}${gap}${safeSuffix}`;
  }

  function formatTemplatePreview(def, detailExample) {
    const sample = detailExample || def?.example || '…';
    return `${def.prefix} ${sample}${def.suffix}`;
  }

  function getDefaultTemplateDef(categoryKey) {
    const base = OWNED_TEMPLATES[categoryKey];
    if (!base) return null;
    const prefix = base.prefix;
    const suffix = base.suffix;
    return {
      prefix,
      suffix,
      bodyText: buildBodyText(prefix, suffix),
      example: base.example,
      preview: formatTemplatePreview({ prefix, suffix, example: base.example }),
    };
  }

  function getSavedPrefix(pageId, categoryKey) {
    const state = getCustomTemplatesState()[pageId]?.[categoryKey];
    if (state?.prefix?.trim()) return state.prefix.trim();
    if (state?.bodyText?.includes('{{1}}')) {
      return state.bodyText.split('{{1}}')[0].trim();
    }
    return '';
  }

  function getTemplateDef(categoryKey, pageId) {
    const base = getDefaultTemplateDef(categoryKey);
    if (!base) return null;
    const prefix = getSavedPrefix(pageId, categoryKey) || base.prefix;
    const suffix = base.suffix;
    const bodyText = buildBodyText(prefix, suffix);
    return {
      prefix,
      suffix,
      bodyText,
      example: base.example,
      preview: formatTemplatePreview({ prefix, suffix, example: base.example }),
    };
  }

  function validateCustomPrefix(prefix) {
    const text = String(prefix || '').trim();
    if (!text) return 'Enter your custom message text.';
    if (text.includes('{{1}}')) return 'Do not type {{1}} — use Message details for that part.';
    if (MARKETING_WORDS.test(text)) {
      return 'Meta rejects promotional words in utility messages. Use neutral appointment/order updates only.';
    }
    if (text.length > 120) return 'Keep custom text short and transactional (max 120 characters).';
    return '';
  }

  function saveCustomTemplate(pageId, categoryKey, prefix) {
    const error = validateCustomPrefix(prefix);
    if (error) throw new Error(error);
    const text = prefix.trim();
    const state = getCustomTemplatesState();
    if (!state[pageId]) state[pageId] = {};
    state[pageId][categoryKey] = { prefix: text };
    saveCustomTemplatesState(state);
    readyTemplates.delete(categoryKey);
    if (preparedPageId === pageId) preparedPageId = null;
  }

  function templateHash(bodyText) {
    let hash = 0;
    const text = String(bodyText || '');
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36).slice(0, 6);
  }

  function ownedTemplateName(pageId, categoryKey, bodyText) {
    const hash = templateHash(bodyText);
    return `pagechat_${TEMPLATE_VERSION}_${categoryKey.toLowerCase()}_${String(pageId).slice(-10)}_${hash}`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  async function findAnyApprovedTemplate(pageId, pageToken, categoryKey) {
    const list = await GraphAPI.getPageMessageTemplates(pageId, pageToken, { limit: 100 });
    const tag = categoryKey.toLowerCase();
    return (
      list.find(
        (t) =>
          t.status === 'APPROVED' &&
          t.name.startsWith('pagechat_') &&
          (t.name.includes(tag) || t.name.includes('pagechat_lib_'))
      ) || null
    );
  }

  async function waitForTemplateApproval(pageId, pageToken, name, attempts = 5) {
    for (let i = 0; i < attempts; i++) {
      await sleep(1200 + i * 600);
      const tpl = await findPageTemplate(pageId, pageToken, name);
      if (tpl?.status === 'APPROVED' || tpl?.status === 'REJECTED') return tpl;
    }
    return findPageTemplate(pageId, pageToken, name);
  }

  function normalizeLibraryTemplate(name, libTpl) {
    const body = libTpl?.body || 'Your update: {{1}}. Thank you.';
    return {
      name,
      language: String(libTpl?.language || 'en').replace('_US', '').slice(0, 2) || 'en',
      status: 'APPROVED',
      body,
      preview: body.replace(/\{\{1\}\}/g, '…'),
      bodyParamCount: 1,
      paramRoles: ['detail'],
      buttons: libTpl?.buttons || [],
    };
  }

  async function tryCreateOwnedTemplate(pageId, pageToken, def, name) {
    const existing = await findPageTemplate(pageId, pageToken, name);
    if (existing?.status === 'APPROVED') return normalizeOwned(name, def);
    if (existing?.status === 'REJECTED' || existing?.status === 'PENDING') return null;

    await GraphAPI.createPageUtilityTemplate(pageId, pageToken, ownedPayload(name, def));
    const result = await waitForTemplateApproval(pageId, pageToken, name);
    if (result?.status === 'APPROVED') return normalizeOwned(name, def);
    return null;
  }

  async function tryMetaLibraryTemplate(pageId, pageToken, categoryKey) {
    const search = {
      POST_PURCHASE_UPDATE: 'order delivery',
      CONFIRMED_EVENT_UPDATE: 'appointment reminder',
      ACCOUNT_UPDATE: 'account update',
    };
    const query = search[categoryKey];
    if (!query) return null;

    let libList = [];
    try {
      libList = await GraphAPI.searchUtilityTemplateLibrary(pageToken, {
        name_or_content: query,
        language: 'en',
      });
    } catch {
      return null;
    }

    const pick =
      (libList || []).find((t) => t.category === 'UTILITY') || (libList || [])[0];
    if (!pick?.name) return null;

    const cloneName = `pagechat_lib_${categoryKey.toLowerCase().slice(0, 14)}_${String(pageId).slice(-8)}`;
    const existing = await findPageTemplate(pageId, pageToken, cloneName);
    if (existing?.status === 'APPROVED') return normalizeLibraryTemplate(cloneName, pick);

    if (existing?.status !== 'REJECTED' && existing?.status !== 'PENDING') {
      try {
        await GraphAPI.cloneUtilityLibraryTemplate(pageId, pageToken, {
          name: cloneName,
          category: 'UTILITY',
          language: pick.language || 'en_US',
          library_template_name: pick.name,
        });
      } catch {
        return null;
      }
    }

    const approved = await waitForTemplateApproval(pageId, pageToken, cloneName);
    if (approved?.status === 'APPROVED') return normalizeLibraryTemplate(cloneName, pick);
    return null;
  }

  async function ensureOwnedTemplate(pageId, pageToken, categoryKey) {
    const customDef = getTemplateDef(categoryKey, pageId);
    if (!customDef) throw new Error('Unknown notification type');

    const approvedExisting = await findAnyApprovedTemplate(pageId, pageToken, categoryKey);
    if (approvedExisting) {
      return normalizeOwned(approvedExisting.name, customDef);
    }

    const defaultDef = getDefaultTemplateDef(categoryKey);
    const tries = [];
    if (customDef.bodyText !== defaultDef.bodyText) tries.push(customDef);
    tries.push(defaultDef);

    for (const def of tries) {
      const baseName = ownedTemplateName(pageId, categoryKey, def.bodyText);
      const names = [
        baseName,
        `${baseName}_${Date.now().toString(36).slice(-5)}`,
        `${baseName}_${Date.now().toString(36)}`,
      ];

      for (const name of names) {
        const created = await tryCreateOwnedTemplate(pageId, pageToken, def, name);
        if (created) {
          if (def === defaultDef && customDef.bodyText !== defaultDef.bodyText) {
            showStatus(
              'Meta rejected custom text. Using default approved template instead.',
              true
            );
          }
          return created;
        }
      }
    }

    const libraryTpl = await tryMetaLibraryTemplate(pageId, pageToken, categoryKey);
    if (libraryTpl) {
      showStatus('Using Meta pre-approved notification template.', true);
      return libraryTpl;
    }

    throw new Error(
      'Meta rejected the notification template. Use simple transactional text only — ' +
        'no sales, offers, or promotions. Example custom text: "Your appointment is scheduled for"'
    );
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

    if (recipients.length >= 10) {
      return startBulkCampaign(page, recipients, text, categoryKey, options);
    }

    const { onProgress, delayMs = 2500 } = options;
    const results = { sent: 0, failed: [], total: recipients.length, mode: 'browser' };

    for (let i = 0; i < recipients.length; i++) {
      const { psid, name } = recipients[i];
      onProgress?.({ current: i + 1, total: recipients.length, name });
      try {
        await send(page, psid, text, categoryKey, { customerName: name });
        results.sent++;
      } catch (err) {
        if (err.code === 4 || err.rateLimited) {
          throw new Error(
            'Facebook rate limit reached. Use bulk send — the server will continue slowly and auto-resume.'
          );
        }
        results.failed.push({ psid, name, error: err.message });
      }
      if (i < recipients.length - 1) await sleep(delayMs);
    }

    if (!results.sent && results.failed.length) {
      throw new Error(results.failed[0].error || 'Could not send notifications');
    }
    return results;
  }

  async function startBulkCampaign(page, recipients, text, categoryKey, options = {}) {
    const detail = text.trim();
    const tpl = await ensureOwnedTemplate(page.id, page.access_token, categoryKey);
    readyTemplates.set(categoryKey, tpl);
    options.onProgress?.({
      current: 0,
      total: recipients.length,
      name: 'Starting server queue…',
    });
    const job = await GraphAPI.startBroadcastCampaign({
      pageId: page.id,
      pageToken: page.access_token,
      templateName: tpl.name,
      language: tpl.language || 'en',
      detail,
      recipients,
    });
    return {
      mode: 'server',
      job,
      sent: job.sent,
      failed: [],
      total: job.total,
    };
  }

  async function pollBulkCampaign(jobId, onUpdate) {
    const job = await GraphAPI.getBroadcastCampaign(jobId);
    onUpdate?.(job);
    return job;
  }

  async function cancelBulkCampaign(jobId) {
    return GraphAPI.cancelBroadcastCampaign(jobId);
  }

  async function resumeActiveCampaign(onUpdate) {
    const job = await GraphAPI.getActiveBroadcastCampaign();
    if (!job) return null;
    onUpdate?.(job);
    return job;
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

  function getActiveCategoryKey() {
    return document.getElementById('utility-tag')?.value || '';
  }

  function setTemplateFormError(message) {
    const el = document.getElementById('utility-template-error');
    if (!el) return;
    if (message) {
      el.textContent = message;
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  function updateDetailFieldHints(categoryKey) {
    const body = document.getElementById('utility-body');
    const hint = document.getElementById('utility-body-hint');
    const example = OWNED_TEMPLATES[categoryKey]?.detailPlaceholder;
    if (body && example) body.placeholder = example;
    if (hint && example) {
      hint.innerHTML = `Yeh detail aapke custom text ke baad add hogi. Example: <em>${example}</em>`;
    }
  }

  function updateLivePreview(page, categoryKey) {
    const preview = document.getElementById('utility-template-preview');
    const detail = document.getElementById('utility-body')?.value?.trim();
    if (!preview || !page?.id || !categoryKey) return;
    const def = getTemplateDef(categoryKey, page.id);
    preview.textContent = formatTemplatePreview(def, detail || def.example);
  }

  function loadTemplateForm(page) {
    const categoryKey = getActiveCategoryKey();
    const input = document.getElementById('utility-custom-text');
    if (!categoryKey || !input) return;

    const def = getTemplateDef(categoryKey, page?.id);
    input.value = def?.prefix || '';
    setTemplateFormError('');
    updateDetailFieldHints(categoryKey);
    updateLivePreview(page, categoryKey);
  }

  function updateTemplateForm(page) {
    const categoryKey = getActiveCategoryKey();
    const input = document.getElementById('utility-custom-text');
    if (!categoryKey || !input || !page?.id) return;

    const prefix = input.value;
    const error = validateCustomPrefix(prefix);
    setTemplateFormError(error);
    updateLivePreview(page, categoryKey);

    if (!error) {
      try {
        saveCustomTemplate(page.id, categoryKey, prefix);
      } catch (err) {
        setTemplateFormError(err.message);
      }
    }
  }

  function ensureTemplateFormValid(page) {
    const categoryKey = getActiveCategoryKey();
    const prefix = document.getElementById('utility-custom-text')?.value || '';
    const error = validateCustomPrefix(prefix);
    if (error) throw new Error(error);
    saveCustomTemplate(page.id, categoryKey, prefix);
    return getTemplateDef(categoryKey, page.id);
  }

  function refreshPreview(page) {
    updateLivePreview(page, getActiveCategoryKey());
  }

  return {
    prepare,
    send,
    sendToAll,
    startBulkCampaign,
    pollBulkCampaign,
    cancelBulkCampaign,
    resumeActiveCampaign,
    getPreview,
    loadTemplateForm,
    updateTemplateForm,
    refreshPreview,
    ensureTemplateFormValid,
    showStatus,
    hideStatus,
    reset,
  };
})();
