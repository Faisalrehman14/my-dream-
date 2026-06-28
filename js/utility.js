const Utility = (function () {
  'use strict';

  const TEMPLATE_VERSION = 'v10';

  /** User's full custom text goes in {{1}}. */
  const TEMPLATE_BODIES = [
    {
      bodyText: 'Message:\n{{1}}',
      example: 'Are you there? We are here for you.',
    },
    {
      bodyText: 'Update:\n{{1}}',
      example: 'Are you there? We are here for you.',
    },
    {
      bodyText: 'Notification:\n{{1}}',
      example: 'Are you there? We are here for you.',
    },
  ];

  const LIBRARY_FALLBACK_KEYS = [
    'CONFIRMED_EVENT_UPDATE',
    'POST_PURCHASE_UPDATE',
    'ACCOUNT_UPDATE',
  ];

  /** pageId -> template object, or false when lookup failed */
  const templateCache = new Map();

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

  function getTemplateDef(index = 0) {
    const body = TEMPLATE_BODIES[index] || TEMPLATE_BODIES[0];
    return {
      bodyText: body.bodyText,
      example: body.example,
      preview: body.example,
    };
  }

  function templateLanguageCode(lang) {
    const raw = String(lang || 'en').trim();
    if (!raw) return 'en';
    if (raw.includes('_')) return raw;
    return raw.length === 2 ? raw : 'en';
  }

  function normalizeTemplateRecord(name, language, def) {
    return {
      name,
      language: templateLanguageCode(language),
      status: 'APPROVED',
      body: def?.bodyText || '',
      preview: def?.preview || '',
      bodyParamCount: 1,
      paramRoles: ['detail'],
      buttons: [],
    };
  }

  function validateMessage(text) {
    const msg = String(text || '').trim();
    if (!msg) return 'Enter your notification message.';
    if (msg.includes('{{1}}')) return 'Just type your message normally — do not use {{1}}.';
    if (MARKETING_WORDS.test(msg)) {
      return 'Meta rejects promotional words. Use friendly updates only (no sales/offers).';
    }
    if (msg.length > 640) return 'Message is too long (max 640 characters).';
    return '';
  }

  function getSavedDraft(pageId) {
    return getCustomTemplatesState()[pageId]?._draft || '';
  }

  function saveDraft(pageId, text) {
    const state = getCustomTemplatesState();
    if (!state[pageId]) state[pageId] = {};
    state[pageId]._draft = text.trim();
    saveCustomTemplatesState(state);
  }

  function ownedTemplateName(pageId, bodyIndex = 0) {
    return `pagechat_${TEMPLATE_VERSION}_custom_${String(pageId).slice(-10)}_${bodyIndex}`;
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

  async function findPageTemplate(pageId, pageToken, name) {
    const list = await GraphAPI.getPageMessageTemplates(pageId, pageToken, { name });
    return list.find((t) => t.name === name) || null;
  }

  function isOwnedCustomTemplate(name) {
    return (
      String(name || '').startsWith('pagechat_') &&
      String(name).includes('_custom_') &&
      !String(name).includes('_lib_')
    );
  }

  async function listPageTemplates(pageId, pageToken) {
    return GraphAPI.getPageMessageTemplates(pageId, pageToken, { limit: 100 });
  }

  async function findOwnedCustomTemplate(pageId, pageToken) {
    const list = await listPageTemplates(pageId, pageToken);
    const owned = list.filter((t) => t.status === 'APPROVED' && isOwnedCustomTemplate(t.name));
    return (
      owned.find((t) => t.name.startsWith(`pagechat_${TEMPLATE_VERSION}_custom_`)) ||
      owned.sort((a, b) => String(b.name).localeCompare(String(a.name)))[0] ||
      null
    );
  }

  async function findApprovedLibClone(pageId, pageToken, categoryKey) {
    const cloneName = `pagechat_lib_${String(categoryKey || '')
      .toLowerCase()
      .slice(0, 14)}_${String(pageId).slice(-8)}`;
    const tpl = await findPageTemplate(pageId, pageToken, cloneName);
    return tpl?.status === 'APPROVED' ? tpl : null;
  }

  async function waitForTemplateApproval(pageId, pageToken, name, attempts = 10) {
    for (let i = 0; i < attempts; i++) {
      await sleep(1000 + i * 800);
      const tpl = await findPageTemplate(pageId, pageToken, name);
      if (tpl?.status === 'APPROVED') return tpl;
      if (tpl?.status === 'REJECTED') return tpl;
    }
    return findPageTemplate(pageId, pageToken, name);
  }

  async function tryCreateOwnedTemplate(pageId, pageToken, def, name) {
    let existing = await findPageTemplate(pageId, pageToken, name);
    if (existing?.status === 'APPROVED') {
      return normalizeTemplateRecord(name, existing.language, def);
    }
    if (existing?.status === 'PENDING') {
      existing = await waitForTemplateApproval(pageId, pageToken, name);
      if (existing?.status === 'APPROVED') {
        return normalizeTemplateRecord(name, existing.language, def);
      }
      if (existing?.status === 'PENDING') return null;
    }
    if (existing?.status === 'REJECTED') return null;

    try {
      const created = await GraphAPI.createPageUtilityTemplate(
        pageId,
        pageToken,
        ownedPayload(name, def)
      );
      if (created?.status === 'APPROVED') {
        return normalizeTemplateRecord(name, created.language, def);
      }
      const result = await waitForTemplateApproval(pageId, pageToken, name);
      if (result?.status === 'APPROVED') {
        return normalizeTemplateRecord(name, result.language, def);
      }
    } catch (err) {
      if (err.code === 4 || err.rateLimited) throw err;
    }
    return null;
  }

  function normalizeLibraryTemplate(name, libTpl) {
    const body = libTpl?.body || libTpl?.components?.[0]?.text || 'Message:\n{{1}}';
    return {
      name,
      language: templateLanguageCode(libTpl?.language || 'en'),
      status: 'APPROVED',
      body,
      preview: body.replace(/\{\{1\}\}/g, '…'),
      bodyParamCount: 1,
      paramRoles: ['detail'],
      buttons: libTpl?.buttons || [],
    };
  }

  async function tryMetaLibraryTemplate(pageId, pageToken, categoryKey) {
    const search = {
      POST_PURCHASE_UPDATE: 'order delivery',
      CONFIRMED_EVENT_UPDATE: 'appointment reminder',
      ACCOUNT_UPDATE: 'account update',
    };
    const query = search[categoryKey];
    if (!query) return null;

    const existing = await findApprovedLibClone(pageId, pageToken, categoryKey);
    if (existing) {
      return normalizeLibraryTemplate(existing.name, existing);
    }

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
    const pending = await findPageTemplate(pageId, pageToken, cloneName);
    if (pending?.status === 'APPROVED') {
      return normalizeLibraryTemplate(cloneName, pick);
    }

    if (pending?.status !== 'REJECTED' && pending?.status !== 'PENDING') {
      try {
        await GraphAPI.cloneUtilityLibraryTemplate(pageId, pageToken, {
          name: cloneName,
          category: 'UTILITY',
          language: pick.language || 'en_US',
          library_template_name: pick.name,
        });
      } catch (err) {
        if (err.code === 4 || err.rateLimited) throw err;
        return null;
      }
    }

    const approved = await waitForTemplateApproval(pageId, pageToken, cloneName);
    if (approved?.status === 'APPROVED') {
      return normalizeLibraryTemplate(cloneName, pick);
    }
    return null;
  }

  async function ensureUtilityTemplate(pageId, pageToken, categoryKey) {
    const owned = await findOwnedCustomTemplate(pageId, pageToken);
    if (owned) {
      return normalizeTemplateRecord(owned.name, owned.language, getTemplateDef());
    }

    let lastError = null;

    for (let i = 0; i < TEMPLATE_BODIES.length; i++) {
      const def = getTemplateDef(i);
      const names = [
        ownedTemplateName(pageId, i),
        `${ownedTemplateName(pageId, i)}_${Date.now().toString(36).slice(-5)}`,
      ];
      for (const name of names) {
        try {
          const created = await tryCreateOwnedTemplate(pageId, pageToken, def, name);
          if (created) return created;
        } catch (err) {
          lastError = err;
          if (err.code === 4 || err.rateLimited) throw err;
        }
      }
    }

    const libOrder = [
      categoryKey,
      ...LIBRARY_FALLBACK_KEYS.filter((k) => k !== categoryKey),
    ].filter(Boolean);

    for (const key of libOrder) {
      if (!LIBRARY_FALLBACK_KEYS.includes(key)) continue;
      try {
        const libTpl = await tryMetaLibraryTemplate(pageId, pageToken, key);
        if (libTpl) return libTpl;
      } catch (err) {
        lastError = err;
        if (err.code === 4 || err.rateLimited) throw err;
      }
    }

    throw new Error(
      lastError?.message ||
        'Could not prepare an approved utility template. Wait a few minutes and try again.'
    );
  }

  async function getUtilityTemplate(page, categoryKey) {
    const cacheKey = `${page.id}:${categoryKey || 'any'}`;
    if (templateCache.has(cacheKey)) {
      const cached = templateCache.get(cacheKey);
      if (cached) return cached;
    }
    const tpl = await ensureUtilityTemplate(page.id, page.access_token, categoryKey);
    templateCache.set(cacheKey, tpl);
    return tpl;
  }

  function clearTemplateCache(pageId) {
    for (const key of [...templateCache.keys()]) {
      if (key.startsWith(`${pageId}:`)) templateCache.delete(key);
    }
  }

  function isRateLimitError(err) {
    return err?.code === 4 || err?.rateLimited === true;
  }

  function isMessagingWindowError(err) {
    const msg = String(err?.message || '').toLowerCase();
    return (
      err?.code === 10 ||
      err?.code === 200 ||
      err?.code === 551 ||
      msg.includes('outside') ||
      msg.includes('24 hour') ||
      msg.includes('messaging window') ||
      msg.includes('utility template') ||
      msg.includes('utility message')
    );
  }

  async function sendViaUtility(page, psid, msg, categoryKey) {
    const tpl = await getUtilityTemplate(page, categoryKey);
    readyTemplates.set(categoryKey || 'custom', tpl);
    const result = await GraphAPI.sendUtilityTemplateMessage(page.id, page.access_token, psid, {
      name: tpl.name,
      language: { code: tpl.language || 'en' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: msg }] }],
    });
    rememberPreview(page.id, psid, msg);
    return result;
  }

  async function prepare(page) {
    if (!page?.id || !page?.access_token) return;
    if (preparePromise && preparedPageId === page.id) return preparePromise;

    preparedPageId = page.id;
    preparePromise = (async () => {
      readyTemplates.clear();
      clearTemplateCache(page.id);
      showStatus('Preparing utility template for Meta…', true, true);
      try {
        const tpl = await getUtilityTemplate(page, getActiveCategoryKey());
        readyTemplates.set('custom', tpl);
        showStatus('Ready — type your message and send.', true);
      } catch (err) {
        if (isRateLimitError(err)) {
          showStatus(err.message, false);
        } else {
          showStatus(
            'Template will be created when you send. Type your message and tap Send.',
            true
          );
        }
      }
    })();

    try {
      await preparePromise;
    } finally {
      preparePromise = null;
    }
  }

  function rememberPreview(pageId, psid, text) {
    if (!pageId || !psid || !text) return;
    const preview = text.trim();
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

    const msg = text.trim();
    const error = validateMessage(msg);
    if (error) throw new Error(error);

    if (options.forceUtility !== true) {
      try {
        const result = await GraphAPI.sendMessage(page.id, page.access_token, psid, msg);
        rememberPreview(page.id, psid, msg);
        return result;
      } catch (err) {
        if (isRateLimitError(err)) throw err;
        if (!isMessagingWindowError(err)) throw err;
      }
    }

    try {
      return await sendViaUtility(page, psid, msg, categoryKey);
    } catch (err) {
      clearTemplateCache(page.id);
      if (isRateLimitError(err)) throw err;
      throw err;
    }
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
        if (isRateLimitError(err)) {
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
    options.onProgress?.({
      current: 0,
      total: recipients.length,
      name: 'Preparing utility template…',
    });
    const tpl = await getUtilityTemplate(page, categoryKey);
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
      directOnly: false,
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
    templateCache.clear();
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

  function updateLivePreview(_page, _categoryKey) {
    const preview = document.getElementById('utility-template-preview');
    const msg = document.getElementById('utility-message')?.value?.trim();
    if (!preview) return;
    preview.textContent = msg || 'we are here for you';
  }

  function loadTemplateForm(page) {
    const input = document.getElementById('utility-message');
    if (!input) return;
    input.value = getSavedDraft(page?.id) || '';
    setTemplateFormError('');
    updateLivePreview(page, getActiveCategoryKey());
  }

  function updateTemplateForm(page) {
    const input = document.getElementById('utility-message');
    if (!input || !page?.id) return;
    const error = validateMessage(input.value);
    setTemplateFormError(error);
    updateLivePreview(page, getActiveCategoryKey());
    if (!error) saveDraft(page.id, input.value);
  }

  function ensureTemplateFormValid(page) {
    const msg = document.getElementById('utility-message')?.value || '';
    const error = validateMessage(msg);
    if (error) throw new Error(error);
    saveDraft(page.id, msg);
    return getTemplateDef();
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
