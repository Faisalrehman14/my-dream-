const Utility = (function () {
  'use strict';

  const TEMPLATE_VERSION = 'v20';

  /** Meta rejects {{1}} at start/end — invisible chars wrap the variable; customer sees only {{1}} text. */
  const EXACT_BODY_INVISIBLE = '\u2060';

  /** User text replaces {{1}} — first option is invisible-wrapped exact message (best for emoji). */
  const TEMPLATE_BODIES = [
    {
      bodyText: `${EXACT_BODY_INVISIBLE}{{1}}${EXACT_BODY_INVISIBLE}`,
      example: 'Hello, we are here for you.',
    },
    {
      bodyText: `\u200B{{1}}\u200B`,
      example: 'Hello, we are here for you.',
    },
    {
      bodyText: 'Hello,\n\n{{1}}',
      example: 'Hello, we are here for you.',
    },
    {
      bodyText: 'Message:\n{{1}}',
      example: 'Hello, we are here for you.',
    },
    {
      bodyText: 'Update:\n{{1}}',
      example: 'Hello, we are here for you.',
    },
  ];

  /** One wrapper cleanup per page per session — avoids spamming Meta DELETE. */
  const wrapperCleanupDone = new Map();

  const SAFE_LIBRARY_KEYS = [];

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

  function parseTemplateLanguage(lang) {
    if (!lang) return 'en';
    if (typeof lang === 'string') return lang.trim();
    if (typeof lang === 'object' && lang.code) return String(lang.code).trim();
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
    if (raw.includes('_')) {
      add(raw.split('_')[0]);
    } else if (raw.length === 2) {
      add(`${raw}_US`);
      add(`${raw}_GB`);
    }
    add('en_US');
    add('en');
    return variants;
  }

  function isApprovedStatus(status) {
    return String(status || '').toUpperCase() === 'APPROVED';
  }

  function templateBodyFromApi(tpl) {
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

  function isAllowedTemplateName(name) {
    const n = String(name || '').toLowerCase();
    if (!n.startsWith('pagechat_') || !n.includes('_custom_') || n.includes('_lib_')) return false;
    const blocked = ['post_purchase', 'account_update', 'order_confirm', 'good_news'];
    return !blocked.some((part) => n.includes(part));
  }

  /** Only PageChat-owned custom templates — library clones cannot be API-deleted (400). */
  function isDeletableWrapperTemplate(tpl) {
    const name = String(tpl?.name || '').toLowerCase();
    if (!name.startsWith('pagechat_') || name.includes('_lib_')) return false;
    const body = templateBodyFromApi(tpl);
    if (
      name.includes(`pagechat_${TEMPLATE_VERSION}_custom_`) &&
      isExactMessageBody(body)
    ) {
      return false;
    }
    if (
      name.includes('post_purchase') ||
      name.includes('account_update') ||
      name.includes('order_confirm') ||
      name.includes('good_news')
    ) {
      return true;
    }
    if (body && hasUnwantedWrapper(body)) return true;
    if (name.includes('_custom_') && body && !isExactMessageBody(body)) return true;
    return false;
  }

  function isExactMessageBody(body) {
    const b = String(body || '').trim();
    if (b === '{{1}}') return true;
    return /^[\u200B-\u200D\u2060\uFEFF]*\{\{1\}\}[\u200B-\u200D\u2060\uFEFF]*$/.test(b);
  }

  function getExactCreateBodyDefs() {
    return TEMPLATE_BODIES.slice(0, 2);
  }

  async function enrichTemplateRecord(pageId, pageToken, tpl) {
    if (!tpl?.name) return tpl;
    if (templateBodyFromApi(tpl)) return tpl;
    return (await fetchTemplateByName(pageId, pageToken, tpl.name)) || tpl;
  }

  async function cleanupWrapperTemplatesFromPage(pageId, pageToken, force = false) {
    if (!force && wrapperCleanupDone.get(pageId)) return 0;

    const all = await listAllPageTemplates(pageId, pageToken);
    let removed = 0;
    const seen = new Set();
    for (const tpl of all) {
      const name = String(tpl?.name || '').trim();
      if (!name || seen.has(name) || !isDeletableWrapperTemplate(tpl)) continue;
      seen.add(name);
      try {
        await GraphAPI.deletePageMessageTemplate(pageId, pageToken, name);
        removed++;
      } catch (err) {
        if (err.code === 4 || err.rateLimited) throw err;
      }
    }
    wrapperCleanupDone.set(pageId, true);
    if (removed) await sleep(800);
    return removed;
  }

  function assertSafeTemplate(tpl) {
    const name = tpl?.name || '';
    const body = tpl?.body || '';
    if (!isAllowedTemplateName(name)) {
      throw new Error('Blocked Meta library template. Wait 1–2 min on Notifications for custom setup.');
    }
    if (hasUnwantedWrapper(body)) {
      throw new Error('Blocked order/account wrapper template. Wait 1–2 min on Notifications tab.');
    }
  }

  function isOwnedSendableTemplate(tpl) {
    const body = tpl?.body || templateBodyFromApi(tpl) || '';
    const name = String(tpl?.name || '');
    if (!isOwnedCustomTemplate(name)) return false;
    if (!isAllowedTemplateName(name)) return false;
    if (hasUnwantedWrapper(body)) return false;
    return true;
  }

  function isSendableTemplate(tpl) {
    return isOwnedSendableTemplate(tpl);
  }

  function normalizeFromApi(tpl) {
    const components = tpl?.components || [];
    const bodyComp = components.find((c) => String(c.type || '').toUpperCase() === 'BODY');
    const body = bodyComp?.text || '';
    const language = parseTemplateLanguage(tpl.language);
    return {
      name: tpl.name,
      language,
      languageVariants: templateLanguageVariants(language),
      status: 'APPROVED',
      body,
      preview: body.replace(/\{\{1\}\}/g, '…') || 'Notification',
      bodyParamCount: 1,
      paramRoles: ['detail'],
      buttons: [],
    };
  }

  function normalizeTemplateRecord(name, language, def) {
    const lang = parseTemplateLanguage(language);
    return {
      name,
      language: lang,
      languageVariants: templateLanguageVariants(lang),
      status: 'APPROVED',
      body: def?.bodyText || '',
      preview: def?.preview || '',
      bodyParamCount: 1,
      paramRoles: ['detail'],
      buttons: [],
    };
  }

  function normalizeOutgoingText(text) {
    return String(text ?? '').normalize('NFC');
  }

  function validateMessage(text) {
    const msg = normalizeOutgoingText(text).trim();
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

  function ownedPayload(name, def, language = 'en_US') {
    return {
      name,
      language,
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

  function templatePreferScore(name, body = '') {
    const n = String(name || '');
    let score = 10;
    if (n.startsWith(`pagechat_${TEMPLATE_VERSION}`)) score = 100;
    else if (isOwnedCustomTemplate(n)) score = 90;
    else if (n.startsWith('pagechat_')) score = 60;
    const b = String(body || '').trim();
    if (b === '{{1}}') score += 15;
    else if (hasUnwantedWrapper(b)) score = 0;
    return score;
  }

  function uniqueLanguageCodes(lang) {
    const variants = [parseTemplateLanguage(lang), ...templateLanguageVariants(lang)];
    return [...new Set(variants.filter(Boolean))];
  }

  async function findPageTemplate(pageId, pageToken, name) {
    return fetchTemplateByName(pageId, pageToken, name);
  }

  function isOwnedCustomTemplate(name) {
    return (
      String(name || '').startsWith('pagechat_') &&
      String(name).includes('_custom_') &&
      !String(name).includes('_lib_')
    );
  }

  async function listPageTemplates(pageId, pageToken) {
    return listAllPageTemplates(pageId, pageToken);
  }

  async function listAllPageTemplates(pageId, pageToken) {
    const all = [];
    let after = null;
    for (let page = 0; page < 10; page++) {
      const query = { limit: 100 };
      if (after) query.after = after;
      const res = await GraphAPI.getPageMessageTemplatesPage(pageId, pageToken, query);
      const batch = res.data || [];
      all.push(...batch);
      after = res.paging?.cursors?.after;
      if (!after || !batch.length) break;
    }
    return all;
  }

  async function fetchTemplateByName(pageId, pageToken, name) {
    const list = await GraphAPI.getPageMessageTemplates(pageId, pageToken, {
      name,
      limit: 25,
    });
    const match = list.find((t) => t.name === name);
    if (match?.components?.length) return match;
    const fromAll = (await listAllPageTemplates(pageId, pageToken)).find((t) => t.name === name);
    return fromAll || match || null;
  }

  async function loadExactTemplateForSend(pageId, pageToken, name) {
    const raw = await fetchTemplateByName(pageId, pageToken, name);
    if (!raw) {
      const err = new Error('TEMPLATE_NOT_FOUND');
      err.templateNotFound = true;
      throw err;
    }
    const body = templateBodyFromApi(raw);
    if (!body) {
      const err = new Error('TEMPLATE_BODY_MISSING');
      err.templateBodyMissing = true;
      throw err;
    }
    const norm = normalizeFromApi(raw);
    assertSafeTemplate(norm);
    if (!isExactMessageBody(body)) {
      const err = new Error('NOT_EXACT_TEMPLATE');
      err.notExact = true;
      err.templateBody = body;
      throw err;
    }
    if (hasUnwantedWrapper(body)) {
      const err = new Error('WRAPPER_TEMPLATE');
      err.wrapperTemplate = true;
      throw err;
    }
    return { raw, norm };
  }

  async function findOwnedCustomTemplate(pageId, pageToken) {
    const list = await listPageTemplates(pageId, pageToken);
    const owned = list.filter(
      (t) =>
        isApprovedStatus(t.status) &&
        isOwnedCustomTemplate(t.name) &&
        !hasUnwantedWrapper(templateBodyFromApi(t))
    );
    if (!owned.length) return null;
    return [...owned].sort(
      (a, b) =>
        templatePreferScore(b.name, templateBodyFromApi(b)) -
        templatePreferScore(a.name, templateBodyFromApi(a))
    )[0];
  }

  async function findApprovedLibClone(pageId, pageToken, categoryKey) {
    const cloneName = `pagechat_lib_${String(categoryKey || '')
      .toLowerCase()
      .slice(0, 14)}_${String(pageId).slice(-8)}`;
    const tpl = await findPageTemplate(pageId, pageToken, cloneName);
    return tpl?.status && isApprovedStatus(tpl.status) ? tpl : null;
  }

  async function waitForTemplateApproval(pageId, pageToken, name, attempts = 15) {
    for (let i = 0; i < attempts; i++) {
      await sleep(1000 + i * 800);
      const tpl = await findPageTemplate(pageId, pageToken, name);
      if (tpl?.status === 'APPROVED') return tpl;
      if (tpl?.status === 'REJECTED') return tpl;
    }
    return findPageTemplate(pageId, pageToken, name);
  }

  async function finalizeTemplateRecord(pageId, pageToken, name) {
    for (let i = 0; i < 6; i++) {
      const fetched = await fetchTemplateByName(pageId, pageToken, name);
      const fresh = fetched ? await enrichTemplateRecord(pageId, pageToken, fetched) : null;
      if (fresh && isApprovedStatus(fresh.status)) {
        const body = templateBodyFromApi(fresh);
        if (!body || hasUnwantedWrapper(body) || !isExactMessageBody(body)) {
          return null;
        }
        return normalizeFromApi(fresh);
      }
      if (fresh?.status === 'REJECTED') return null;
      if (i < 5) await sleep(1200);
    }
    return null;
  }

  async function tryCreateOwnedTemplate(pageId, pageToken, def, name) {
    let existing = await findPageTemplate(pageId, pageToken, name);
    if (existing?.status === 'APPROVED') {
      return finalizeTemplateRecord(pageId, pageToken, name);
    }
    if (existing?.status === 'PENDING') {
      existing = await waitForTemplateApproval(pageId, pageToken, name, 20);
      if (existing?.status === 'APPROVED') {
        return finalizeTemplateRecord(pageId, pageToken, name);
      }
      if (existing?.status === 'PENDING') return null;
    }
    if (existing?.status === 'REJECTED') {
      const err = new Error(`Template "${name}" was rejected by Meta.`);
      err.templateRejected = true;
      throw err;
    }

    let lastErr = null;
    for (const lang of ['en_US', 'en']) {
      try {
        const createRes = await GraphAPI.createPageUtilityTemplate(
          pageId,
          pageToken,
          ownedPayload(name, def, lang)
        );
        if (createRes?.status === 'APPROVED') {
          const verified = await finalizeTemplateRecord(pageId, pageToken, name);
          if (verified) return verified;
        }
        const result = await waitForTemplateApproval(pageId, pageToken, name, 12);
        if (result?.status === 'APPROVED') {
          const verified = await finalizeTemplateRecord(pageId, pageToken, name);
          if (verified) return verified;
        }
        if (result?.status === 'REJECTED') {
          lastErr = new Error(`Meta rejected template "${name}".`);
        }
      } catch (err) {
        lastErr = err;
        if (err.code === 4 || err.rateLimited) throw err;
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }

  function libraryButtonInputs(pick) {
    const buttons =
      pick?.buttons ||
      pick?.components?.find((c) => String(c.type || '').toUpperCase() === 'BUTTONS')?.buttons ||
      [];
    if (!buttons.length) return null;
    return JSON.stringify(
      buttons.map((btn) => {
        const type = String(btn.type || '').toUpperCase();
        if (type === 'URL' || type === 'WEB_URL') {
          return {
            type: 'URL',
            url: {
              base_url: 'https://www.example.com/{{1}}',
              url_suffix_example: 'https://www.example.com/support',
            },
          };
        }
        if (type === 'PHONE_NUMBER') {
          return { type: 'PHONE_NUMBER', phone_number: '+10000000000' };
        }
        return { type: 'QUICK_REPLY', text: 'OK' };
      })
    );
  }

  function buildLibraryClonePayload(cloneName, pick) {
    const payload = {
      name: cloneName,
      category: 'UTILITY',
      language: parseTemplateLanguage(pick.language || 'en_US'),
      library_template_name: pick.name,
    };
    const btnInputs = libraryButtonInputs(pick);
    if (btnInputs) payload.library_template_button_inputs = btnInputs;
    return payload;
  }

  async function browseUtilityLibrary(pageToken) {
    const collected = [];
    const seen = new Set();
    const add = (list) => {
      for (const t of list || []) {
        if (t?.name && !seen.has(t.name)) {
          seen.add(t.name);
          collected.push(t);
        }
      }
    };
    try {
      add(await GraphAPI.searchUtilityTemplateLibrary(pageToken, { limit: 50 }));
    } catch {
      /* ignore */
    }
    for (const q of ['hello', 'update', 'order', 'delivery', 'account', 'appointment', 'message']) {
      try {
        add(
          await GraphAPI.searchUtilityTemplateLibrary(pageToken, {
            name_or_content: q,
            language: 'en',
            limit: 25,
          })
        );
      } catch {
        /* ignore */
      }
    }
    return collected;
  }

  function pickLibraryTemplate(list) {
    if (!list?.length) return null;
    return [...list].sort((a, b) => {
      const btnA = (a.buttons || []).length;
      const btnB = (b.buttons || []).length;
      if (btnA !== btnB) return btnA - btnB;
      return String(a.name || '').length - String(b.name || '').length;
    })[0];
  }

  async function tryMetaLibraryTemplate(pageId, pageToken, categoryKey) {
    const existing = await findApprovedLibClone(pageId, pageToken, categoryKey);
    if (existing) {
      const normalized = normalizeFromApi(existing);
      if (isSendableTemplate(normalized)) return normalized;
    }

    const libList = (await browseUtilityLibrary(pageToken)).filter(isSafeLibraryPick);
    const searchHint = {
      POST_PURCHASE_UPDATE: /order|delivery|ship|purchase/i,
      CONFIRMED_EVENT_UPDATE: /appointment|event|remind|confirm/i,
    };
    const hint = searchHint[categoryKey];
    const pick =
      (hint ? libList.find((t) => hint.test(String(t.name || '') + String(t.body || ''))) : null) ||
      pickLibraryTemplate(libList);
    if (!pick?.name) return null;

    const cloneName = `pagechat_lib_${categoryKey.toLowerCase().slice(0, 14)}_${String(pageId).slice(-8)}`;
    let pending = await findPageTemplate(pageId, pageToken, cloneName);
    if (pending?.status === 'APPROVED') {
      return normalizeFromApi(pending);
    }
    if (pending?.status === 'PENDING') {
      pending = await waitForTemplateApproval(pageId, pageToken, cloneName);
      if (pending?.status === 'APPROVED') return normalizeFromApi(pending);
      if (pending?.status === 'PENDING') return null;
    }
    if (pending?.status === 'REJECTED') {
      const altName = `${cloneName}_${Date.now().toString(36).slice(-4)}`;
      pending = null;
      try {
        await GraphAPI.cloneUtilityLibraryTemplate(
          pageId,
          pageToken,
          buildLibraryClonePayload(altName, pick)
        );
        const approved = await waitForTemplateApproval(pageId, pageToken, altName);
        if (approved?.status === 'APPROVED') return normalizeFromApi(approved);
      } catch (err) {
        if (err.code === 4 || err.rateLimited) throw err;
      }
      return null;
    }

    try {
      await GraphAPI.cloneUtilityLibraryTemplate(
        pageId,
        pageToken,
        buildLibraryClonePayload(cloneName, pick)
      );
    } catch (err) {
      if (err.code === 4 || err.rateLimited) throw err;
      throw err;
    }

    const approved = await waitForTemplateApproval(pageId, pageToken, cloneName);
    if (approved?.status === 'APPROVED') {
      return normalizeFromApi(approved);
    }
    return null;
  }

  function isSafeLibraryPick(pick) {
    const body = String(pick?.body || pick?.components?.[0]?.text || '');
    const name = String(pick?.name || '').toLowerCase();
    if (hasUnwantedWrapper(body)) return false;
    if (name.includes('account_update') || name.includes('account update')) return false;
    return true;
  }

  async function trySafeLibraryTemplate(pageId, pageToken) {
    for (const key of SAFE_LIBRARY_KEYS) {
      try {
        const tpl = await tryMetaLibraryTemplate(pageId, pageToken, key);
        if (tpl && isSendableTemplate(tpl)) return tpl;
      } catch (err) {
        if (err.code === 4 || err.rateLimited) throw err;
      }
    }

    const libList = await browseUtilityLibrary(pageToken);
    const pick = libList.find(isSafeLibraryPick);
    if (!pick?.name) return null;

    const cloneName = `pagechat_lib_safe_${String(pageId).slice(-8)}`;
    const existing = await findPageTemplate(pageId, pageToken, cloneName);
    if (existing?.status === 'APPROVED' && isSendableTemplate(normalizeFromApi(existing))) {
      return normalizeFromApi(existing);
    }
    if (existing?.status === 'PENDING') {
      const approved = await waitForTemplateApproval(pageId, pageToken, cloneName, 20);
      if (approved?.status === 'APPROVED') return normalizeFromApi(approved);
      return null;
    }
    if (existing?.status === 'REJECTED') return null;

    try {
      await GraphAPI.cloneUtilityLibraryTemplate(
        pageId,
        pageToken,
        buildLibraryClonePayload(cloneName, pick)
      );
    } catch (err) {
      if (err.code === 4 || err.rateLimited) throw err;
      return null;
    }

    const approved = await waitForTemplateApproval(pageId, pageToken, cloneName, 20);
    if (approved?.status === 'APPROVED') return normalizeFromApi(approved);
    return null;
  }

  async function ensureUtilityTemplate(pageId, pageToken, _categoryKey) {
    const owned = await findOwnedCustomTemplate(pageId, pageToken);
    if (owned) {
      const verified = await finalizeTemplateRecord(pageId, pageToken, owned.name);
      if (verified) return verified;
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

    const hint = lastError?.message?.includes('pages_utility_messaging')
      ? ' Sign out and sign in again — allow all permissions.'
      : '';
    throw new Error(
      (lastError?.message ||
        'Could not prepare an approved utility template. Wait a few minutes and try again.') + hint
    );
  }

  async function listLiveSendableTemplates(pageId, pageToken) {
    const list = await listAllPageTemplates(pageId, pageToken);
    const candidates = list.filter(
      (t) =>
        isApprovedStatus(t.status) &&
        isOwnedCustomTemplate(t.name) &&
        isAllowedTemplateName(t.name)
    );
    const sendable = [];
    for (const raw of candidates) {
      const tpl = await enrichTemplateRecord(pageId, pageToken, raw);
      const body = templateBodyFromApi(tpl);
      if (!isExactMessageBody(body)) continue;
      if (hasUnwantedWrapper(body)) continue;
      sendable.push(tpl);
    }
    return sendable.sort(
      (a, b) =>
        templatePreferScore(b.name, templateBodyFromApi(b)) -
        templatePreferScore(a.name, templateBodyFromApi(a))
    );
  }

  async function resolveExactCustomTemplate(pageId, pageToken) {
    const live = await listLiveSendableTemplates(pageId, pageToken);
    if (live.length) {
      const verified = await finalizeTemplateRecord(pageId, pageToken, live[0].name);
      if (verified) {
        assertSafeTemplate(verified);
        return verified;
      }
    }

    clearTemplateCache(pageId);
    const nameSuffixes = [
      '',
      `_${Date.now().toString(36).slice(-5)}`,
      `_${Date.now().toString(36)}`,
    ];
    let lastError = null;
    for (const def of getExactCreateBodyDefs()) {
      for (let s = 0; s < nameSuffixes.length; s++) {
        const name =
          s === 0
            ? ownedTemplateName(pageId, 0)
            : `${ownedTemplateName(pageId, 0)}${nameSuffixes[s]}`;
        try {
          const created = await tryCreateOwnedTemplate(pageId, pageToken, def, name);
          if (created && isExactMessageBody(created.body)) {
            assertSafeTemplate(created);
            return created;
          }
        } catch (err) {
          lastError = err;
          if (err.code === 4 || err.rateLimited) throw err;
          if (err.templateRejected) continue;
        }
      }
    }

    throw new Error(
      (lastError?.message ||
        'Meta rejected the exact-message template. Wait 1–2 min on Notifications, then retry.') +
        (lastError?.message?.includes('pages_utility_messaging')
          ? ' Sign out and sign in again — allow all permissions.'
          : '')
    );
  }

  async function getVerifiedUtilityTemplate(page, categoryKey) {
    return resolveExactCustomTemplate(page.id, page.access_token);
  }

  async function getUtilityTemplate(page, categoryKey) {
    return getVerifiedUtilityTemplate(page, categoryKey);
  }

  function clearTemplateCache(pageId) {
    for (const key of [...templateCache.keys()]) {
      if (key.startsWith(`${pageId}:`)) templateCache.delete(key);
    }
    if (pageId) wrapperCleanupDone.delete(pageId);
  }

  function isRateLimitError(err) {
    return err?.code === 4 || err?.rateLimited === true;
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

  function isTemplateNotFoundError(err) {
    const msg = String(err?.message || '').toLowerCase();
    return err?.code === 100 || msg.includes('template cannot be found') || msg.includes('(#100)');
  }

  async function trySendUtilityTemplate(page, psid, msg, rawTemplate) {
    const { raw, norm } = await loadExactTemplateForSend(
      page.id,
      page.access_token,
      rawTemplate.name
    );
    const detail = normalizeOutgoingText(msg);
    const langs = uniqueLanguageCodes(raw.language);
    let lastErr = null;
    for (const code of langs) {
      try {
        const result = await GraphAPI.sendUtilityTemplateMessage(page.id, page.access_token, psid, {
          name: norm.name,
          language: { code },
          components: [{ type: 'body', parameters: [{ type: 'text', text: detail }] }],
        });
        return { result, tpl: { ...norm, language: code } };
      } catch (err) {
        lastErr = err;
        if (isRateLimitError(err)) throw err;
        if (!isTemplateNotFoundError(err)) throw err;
      }
    }
    throw lastErr || new Error('(#100) Template cannot be found.');
  }

  async function sendViaUtility(page, psid, msg, categoryKey) {
    clearTemplateCache(page.id);
    const detail = normalizeOutgoingText(msg);
    let lastErr = null;

    for (let round = 0; round < 2; round++) {
      let candidates = await listLiveSendableTemplates(page.id, page.access_token);

      for (const raw of candidates) {
        try {
          const { result, tpl } = await trySendUtilityTemplate(page, psid, detail, raw);
          templateCache.set(`${page.id}:${categoryKey || 'any'}`, tpl);
          readyTemplates.set(categoryKey || 'custom', tpl);
          rememberPreview(page.id, psid, detail);
          return result;
        } catch (err) {
          lastErr = err;
          if (isRateLimitError(err)) throw err;
          if (err.wrapperTemplate || err.notExact || err.templateBodyMissing) continue;
          if (err.templateNotFound) continue;
          if (!isTemplateNotFoundError(err)) throw err;
        }
      }

      if (round === 0) {
        try {
          await resolveExactCustomTemplate(page.id, page.access_token);
        } catch (err) {
          lastErr = err;
          if (isRateLimitError(err)) throw err;
        }
      }
    }

    throw (
      lastErr ||
      new Error(
        'No exact-message template ({{1}} only). Open Notifications, wait 1–2 min for setup, then retry.'
      )
    );
  }

  async function prepare(page) {
    if (!page?.id || !page?.access_token) return;
    if (preparePromise && preparedPageId === page.id) return preparePromise;

    preparedPageId = page.id;
    preparePromise = (async () => {
      readyTemplates.clear();
      clearTemplateCache(page.id);
      showStatus('Preparing exact-message template…', true, true);
      try {
        cleanupWrapperTemplatesFromPage(page.id, page.access_token).catch(() => {});
        const tpl = await getUtilityTemplate(page, getActiveCategoryKey());
        readyTemplates.set('custom', tpl);
        showStatus(`Ready — exact template: ${tpl.name}`, true);
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

    const msg = normalizeOutgoingText(text).trim();
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
    const detail = normalizeOutgoingText(text).trim();
    options.onProgress?.({
      current: 0,
      total: recipients.length,
      name: 'Preparing utility template…',
    });
    const tpl = await getVerifiedUtilityTemplate(page, categoryKey);
    const { norm: verified } = await loadExactTemplateForSend(
      page.id,
      page.access_token,
      tpl.name
    );
    options.onProgress?.({
      current: 0,
      total: recipients.length,
      name: 'Starting server queue…',
    });
    const job = await GraphAPI.startBroadcastCampaign({
      pageId: page.id,
      pageToken: page.access_token,
      templateName: verified.name,
      language: verified.language,
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
