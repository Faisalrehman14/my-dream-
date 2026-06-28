const Utility = (function () {
  'use strict';

  const TEMPLATE_VERSION = 'v23';

  /** Minimal wraps — user text in {{1}}. "Good news! …" is OK per Meta + user preference. */
  const TEMPLATE_BODIES = [
    {
      bodyText: 'Good news! {{1}}',
      example: 'Your VIP bonus is now live.',
    },
    {
      bodyText: 'Good news! {{1}}.',
      example: 'Your VIP bonus is now live.',
    },
    {
      bodyText: '({{1}})',
      example: 'Your VIP bonus is now live.',
    },
    {
      bodyText: 'Message:\n{{1}}',
      example: 'We received your request and will reply shortly.',
    },
    {
      bodyText: 'Update:\n{{1}}',
      example: 'We received your request and will reply shortly.',
    },
  ];

  const META_TERMS_HINT =
    'Meta rule: 24 ghante ke baad sirf approved UTILITY template se message ja sakta hai. ' +
    'Promotional/sales words avoid karein. App Meta ki official template library use karti hai.';

  function formatUtilityError(err) {
    const raw = String(err?.message || '').trim();
    const msg = raw.toLowerCase();
    if (
      msg.includes('rejected') ||
      msg.includes('custom template') ||
      msg.includes('utility template') ||
      msg.includes('pages_utility_messaging')
    ) {
      return (
        'Meta ne is format ko approve nahi kiya — yeh app ki fault nahi, Meta ki policy hai. ' +
        META_TERMS_HINT +
        ' 2–3 min wait karke dubara Send karein.' +
        (raw && !msg.includes('meta ne is format') ? ` (${raw})` : '')
      );
    }
    if (
      msg.includes('template library') ||
      msg.includes('library clone') ||
      msg.includes('setup nahi ho saki')
    ) {
      return (
        (raw || 'Meta template library se setup nahi ho saki.') +
        ' Business Suite → Message templates check karein. ' +
        META_TERMS_HINT
      );
    }
    if (
      err?.subcode === 2018416 ||
      msg.includes('message template creation failed') ||
      msg.includes('creating message template')
    ) {
      return (
        'Meta ne is Page par custom template create reject kar diya. ' +
        'App ab Meta ki official library template use karegi — 1 min wait karke dubara Send karein. ' +
        META_TERMS_HINT
      );
    }
    return raw || 'Could not send notification.';
  }

  const SAFE_LIBRARY_KEYS = [];

  /** One wrapper cleanup per page per session — avoids spamming Meta DELETE. */
  const wrapperCleanupDone = new Map();

  /** pageId -> template object, or false when lookup failed */
  const templateCache = new Map();

  /** Meta app-level rate limit (code 4) — stop API bursts for ~20 min */
  const RATE_LIMIT_COOLDOWN_MS = 20 * 60 * 1000;
  const rateLimitUntil = new Map();
  const pageTemplatesListCache = new Map();
  const libraryBrowseCache = new Map();
  const resolveInflight = new Map();
  const PAGE_TEMPLATES_CACHE_MS = 90 * 1000;
  const LIBRARY_BROWSE_CACHE_MS = 30 * 60 * 1000;

  function rateLimitStorageKey(pageId) {
    return `pagechat_rl_${pageId}`;
  }

  function noteRateLimit(pageId) {
    if (!pageId) return;
    const until = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    rateLimitUntil.set(String(pageId), until);
    try {
      sessionStorage.setItem(rateLimitStorageKey(pageId), String(until));
    } catch {
      /* ignore */
    }
  }

  function isInRateLimitCooldown(pageId) {
    if (!pageId) return false;
    const id = String(pageId);
    let until = rateLimitUntil.get(id);
    if (!until) {
      try {
        until = parseInt(sessionStorage.getItem(rateLimitStorageKey(id)) || '', 10);
        if (until) rateLimitUntil.set(id, until);
      } catch {
        /* ignore */
      }
    }
    if (!until || Date.now() >= until) {
      rateLimitUntil.delete(id);
      return false;
    }
    return true;
  }

  function rateLimitCooldownMessage(pageId) {
    const until = rateLimitUntil.get(String(pageId)) || 0;
    const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    return (
      `Facebook app request limit reached. Wait ~${mins} min, then try once. ` +
      'Do not tap Continue or Send repeatedly.'
    );
  }

  function isRateLimitError(err) {
    return err?.code === 4 || err?.rateLimited === true;
  }

  /** Meta generic template create failure — custom templates often blocked per Page. */
  function isTemplateCreationFailedError(err) {
    if (err?.subcode === 2018416 || err?.templateCreationFailed) return true;
    const msg = String(err?.message || '').toLowerCase();
    return (
      msg.includes('message template creation failed') ||
      msg.includes('creating message template') ||
      msg.includes('an error occurred while creating message template')
    );
  }

  function rethrowIfRateLimited(err, pageId) {
    if (isRateLimitError(err)) {
      noteRateLimit(pageId);
      throw err;
    }
  }

  function invalidateTemplateListCache(pageId) {
    if (pageId) pageTemplatesListCache.delete(String(pageId));
  }

  function getOfflineCachedTemplate(pageId) {
    const state = getCustomTemplatesState()[pageId];
    if (!state?.readyName || !state?.readyBody) return null;
    if (!isUsableTemplateBody(state.readyBody)) return null;
    return {
      name: state.readyName,
      language: 'en',
      languageVariants: templateLanguageVariants('en'),
      status: 'APPROVED',
      body: state.readyBody,
      preview: state.readyBody.replace(/\{\{1\}\}/g, '…'),
      bodyParamCount: 1,
      paramRoles: ['detail'],
      buttons: [],
    };
  }

  function rawTplFromNorm(norm) {
    if (!norm?.name) return null;
    return {
      name: norm.name,
      status: 'APPROVED',
      language: norm.language || 'en',
      components: [{ type: 'BODY', text: norm.body || '' }],
    };
  }

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

  function getCachedTemplateName(pageId) {
    return getCustomTemplatesState()[pageId]?.readyName || null;
  }

  function saveCachedTemplateRecord(pageId, tpl) {
    if (!pageId || !tpl?.name) return;
    const state = getCustomTemplatesState();
    if (!state[pageId]) state[pageId] = {};
    state[pageId].readyName = tpl.name;
    state[pageId].readyBody = tpl.body || '';
    saveCustomTemplatesState(state);
  }

  async function loadSendableTemplateRecord(pageId, pageToken, name) {
    const raw = await fetchTemplateByName(pageId, pageToken, name);
    if (!raw || !isApprovedStatus(raw.status)) return null;
    const enriched = await enrichTemplateRecord(pageId, pageToken, raw);
    const body = templateBodyFromApi(enriched);
    if (!isUsableTemplateBody(body)) return null;
    const norm = normalizeFromApi(enriched);
    assertSafeTemplate(norm);
    return norm;
  }

  async function findExistingSendableTemplate(pageId, pageToken) {
    const cachedName = getCachedTemplateName(pageId);
    if (cachedName) {
      try {
        const cached = await loadSendableTemplateRecord(pageId, pageToken, cachedName);
        if (cached) return cached;
      } catch {
        /* try live list */
      }
    }

    const list = await listAllPageTemplates(pageId, pageToken);
    const candidates = list
      .filter((t) => isApprovedStatus(t.status) && isAllowedTemplateName(t.name))
      .sort(
        (a, b) =>
          templatePreferScore(b.name, templateBodyFromApi(b)) -
          templatePreferScore(a.name, templateBodyFromApi(a))
      );

    for (const raw of candidates.slice(0, 8)) {
      let body = templateBodyFromApi(raw);
      let tpl = raw;
      if (!body || !isUsableTemplateBody(body)) {
        tpl = await enrichTemplateRecord(pageId, pageToken, raw);
        body = templateBodyFromApi(tpl);
      }
      if (!isUsableTemplateBody(body)) continue;
      const norm = normalizeFromApi(tpl);
      assertSafeTemplate(norm);
      return norm;
    }
    return null;
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
      'your order is now',
      'order is now',
      'your order #',
      'reminder: your appointment',
      'your appointment is',
      'your recent purchase',
      'shipment tracking',
      'on its way',
      'track order',
    ];
    return blocked.some((phrase) => b.includes(phrase));
  }

  function isAllowedTemplateName(name) {
    const n = String(name || '').toLowerCase();
    if (!n.startsWith('pagechat_')) return false;
    const blocked = ['post_purchase', 'account_update', 'order_confirm'];
    if (blocked.some((part) => n.includes(part))) return false;
    if (n.includes('_custom_') && !n.includes('_lib_')) return true;
    if (n.includes('pagechat_lib_minimal_')) return true;
    return false;
  }

  /** Only PageChat-owned custom templates — library clones cannot be API-deleted (400). */
  function isDeletableWrapperTemplate(tpl) {
    const name = String(tpl?.name || '').toLowerCase();
    if (!name.startsWith('pagechat_') || name.includes('_lib_')) return false;
    const body = templateBodyFromApi(tpl);
    if (
      name.includes(`pagechat_${TEMPLATE_VERSION}_custom_`) &&
      isSendableTemplateBody(body)
    ) {
      return false;
    }
    if (
      name.includes('post_purchase') ||
      name.includes('account_update') ||
      name.includes('order_confirm')
    ) {
      return true;
    }
    if (body && hasUnwantedWrapper(body)) return true;
    if (name.includes('_custom_') && body && !isSendableTemplateBody(body)) return true;
    if (name.includes('pagechat_lib_minimal_') && body && isUsableTemplateBody(body)) return false;
    return false;
  }

  function isExactMessageBody(body) {
    const b = String(body || '').trim();
    if (b === '{{1}}') return true;
    return /^[\u200B-\u200D\u2060\uFEFF\u00A0]*\{\{1\}\}[\u200B-\u200D\u2060\uFEFF\u00A0]*$/.test(b);
  }

  function knownCustomBodyTexts() {
    return new Set(TEMPLATE_BODIES.map((item) => item.bodyText));
  }

  function isSendableCustomBody(body) {
    const b = String(body || '').trim();
    if (!b || hasUnwantedWrapper(b)) return false;
    if (isExactMessageBody(b)) return true;
    return knownCustomBodyTexts().has(b);
  }

  function isGoodNewsWrapperBody(body) {
    const b = String(body || '').trim();
    if (hasUnwantedWrapper(b)) return false;
    return /^Good news!\s*\{\{1\}\}/i.test(b);
  }

  function isUsableTemplateBody(body) {
    if (isSendableTemplateBody(body)) return true;
    if (isGoodNewsWrapperBody(body)) return true;
    const b = String(body || '').trim();
    if (!b || hasUnwantedWrapper(b)) return false;
    const params = b.match(/\{\{\d+\}\}/g) || [];
    if (params.length !== 1 || !b.includes('{{1}}')) return false;
    const staticLen = b.replace(/\{\{\d+\}\}/g, '').trim().length;
    return staticLen > 0 && staticLen <= 120;
  }

  /** Single {{1}} with short static text — used for Meta library clones. */
  function isSendableTemplateBody(body) {
    const b = String(body || '').trim();
    if (!b || hasUnwantedWrapper(b)) return false;
    if (isSendableCustomBody(b)) return true;
    const params = b.match(/\{\{\d+\}\}/g) || [];
    if (params.length !== 1 || !b.includes('{{1}}')) return false;
    const staticLen = b.replace(/\{\{\d+\}\}/g, '').trim().length;
    return staticLen > 0 && staticLen <= 80;
  }

  function bodyPreferScore(body) {
    const b = String(body || '').trim();
    if (b === 'Good news! {{1}}' || b === 'Good news! {{1}}.') return 100;
    if (isExactMessageBody(b)) return 95;
    if (b === '({{1}})') return 90;
    if (b === 'Message:\n{{1}}' || b === 'Update:\n{{1}}') return 75;
    return isSendableCustomBody(b) ? 60 : 0;
  }

  async function enrichTemplateRecord(pageId, pageToken, tpl) {
    if (!tpl?.name) return tpl;
    if (templateBodyFromApi(tpl)) return tpl;
    const fetched = await fetchTemplateByName(pageId, pageToken, tpl.name);
    return fetched || tpl;
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
        invalidateTemplateListCache(pageId);
      } catch (err) {
        if (err.code === 4 || err.rateLimited) {
          noteRateLimit(pageId);
          throw err;
        }
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

  function ownedPayload(name, def, language = 'en') {
    return {
      name,
      language,
      category: 'UTILITY',
      parameter_format: 'POSITIONAL',
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
    else if (n.includes('pagechat_lib_minimal_')) score = 88;
    else if (isOwnedCustomTemplate(n)) score = 90;
    else if (n.startsWith('pagechat_')) score = 60;
    const b = String(body || '').trim();
    score += bodyPreferScore(b);
    if (hasUnwantedWrapper(b)) score = 0;
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

  async function listAllPageTemplates(pageId, pageToken, { fresh = false } = {}) {
    const id = String(pageId);
    const cached = pageTemplatesListCache.get(id);
    if (!fresh && cached && Date.now() - cached.at < PAGE_TEMPLATES_CACHE_MS) {
      return cached.list;
    }
    const all = [];
    let after = null;
    for (let page = 0; page < 4; page++) {
      const query = { limit: 100 };
      if (after) query.after = after;
      const res = await GraphAPI.getPageMessageTemplatesPage(pageId, pageToken, query);
      const batch = res.data || [];
      all.push(...batch);
      after = res.paging?.cursors?.after;
      if (!after || !batch.length) break;
    }
    pageTemplatesListCache.set(id, { at: Date.now(), list: all });
    return all;
  }

  async function fetchTemplateByName(pageId, pageToken, name) {
    const list = await GraphAPI.getPageMessageTemplates(pageId, pageToken, {
      name,
      limit: 25,
    });
    const match = list.find((t) => t.name === name);
    if (match) return match;
    return (await listAllPageTemplates(pageId, pageToken)).find((t) => t.name === name) || null;
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
    if (!isUsableTemplateBody(body)) {
      const err = new Error('NOT_SENDABLE_TEMPLATE');
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

  async function waitForTemplateApproval(pageId, pageToken, name, attempts = 5) {
    for (let i = 0; i < attempts; i++) {
      await sleep(2500 + i * 2000);
      const tpl = await findPageTemplate(pageId, pageToken, name);
      if (tpl?.status === 'APPROVED') return tpl;
      if (tpl?.status === 'REJECTED') return tpl;
    }
    return findPageTemplate(pageId, pageToken, name);
  }

  async function finalizeTemplateRecord(pageId, pageToken, name) {
    for (let i = 0; i < 3; i++) {
      const fetched = await fetchTemplateByName(pageId, pageToken, name);
      const fresh = fetched ? await enrichTemplateRecord(pageId, pageToken, fetched) : null;
      if (fresh && isApprovedStatus(fresh.status)) {
        const body = templateBodyFromApi(fresh);
        if (!body || hasUnwantedWrapper(body) || !isUsableTemplateBody(body)) {
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
      existing = await waitForTemplateApproval(pageId, pageToken, name, 8);
      if (existing?.status === 'APPROVED') {
        return finalizeTemplateRecord(pageId, pageToken, name);
      }
      if (existing?.status === 'PENDING') return null;
    }
    if (existing?.status === 'REJECTED') return null;

    let lastErr = null;
    for (const lang of ['en']) {
      try {
        const createRes = await GraphAPI.createPageUtilityTemplate(
          pageId,
          pageToken,
          ownedPayload(name, def, lang)
        );
        invalidateTemplateListCache(pageId);
        if (createRes?.status === 'APPROVED') {
          const verified = await finalizeTemplateRecord(pageId, pageToken, name);
          if (verified) return verified;
        }
        const result = await waitForTemplateApproval(pageId, pageToken, name, 6);
        if (result?.status === 'APPROVED') {
          const verified = await finalizeTemplateRecord(pageId, pageToken, name);
          if (verified) return verified;
        }
        if (result?.status === 'REJECTED') {
          return null;
        }
      } catch (err) {
        lastErr = err;
        rethrowIfRateLimited(err, pageId);
        if (isTemplateCreationFailedError(err)) return null;
      }
    }
    return null;
  }

  function libraryPickButtons(pick) {
    return (
      pick?.buttons ||
      pick?.components?.find((c) => String(c.type || '').toUpperCase() === 'BUTTONS')?.buttons ||
      []
    );
  }

  /** Meta library clone inputs — match Graph API shape (URL needs text + base_url). */
  function libraryButtonInputFor(btn) {
    const type = String(btn.type || '').toUpperCase();
    if (type === 'URL' || type === 'WEB_URL') {
      return {
        type: 'URL',
        text: String(btn.text || btn.title || 'View').slice(0, 40),
        url: {
          base_url: 'https://www.example.com/',
        },
      };
    }
    if (type === 'PHONE_NUMBER') {
      return {
        type: 'PHONE_NUMBER',
        text: String(btn.text || btn.title || 'Call').slice(0, 40),
        phone_number: '+10000000000',
      };
    }
    if (type === 'POSTBACK') {
      return { type: 'POSTBACK' };
    }
    return { type: 'QUICK_REPLY' };
  }

  function libraryBodyInputs(pick) {
    const body = libraryPickBody(pick);
    if (!body || !pick?.body_params?.length) return null;
    return [{ type: 'body', text: body }];
  }

  function libraryButtonInputs(pick) {
    const buttons = libraryPickButtons(pick);
    if (!buttons.length) return null;
    const supported = buttons.filter((btn) => {
      const type = String(btn.type || '').toUpperCase();
      return type !== 'FORMS' && type !== 'FLOW';
    });
    if (!supported.length) return null;
    return supported.map(libraryButtonInputFor);
  }

  function buildLibraryClonePayload(cloneName, pick, { includeButtons = true } = {}) {
    const payload = {
      name: cloneName,
      category: 'UTILITY',
      language: parseTemplateLanguage(pick.language || 'en'),
      library_template_name: pick.name,
    };
    const bodyInputs = libraryBodyInputs(pick);
    if (bodyInputs) payload.library_template_body_inputs = bodyInputs;
    if (includeButtons) {
      const btnInputs = libraryButtonInputs(pick);
      if (btnInputs) payload.library_template_button_inputs = btnInputs;
    }
    return payload;
  }

  async function browseUtilityLibrary(pageToken) {
    const key = String(pageToken || '').slice(-16);
    const cached = libraryBrowseCache.get(key);
    if (cached && Date.now() - cached.at < LIBRARY_BROWSE_CACHE_MS) {
      return cached.list;
    }

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

    const queries = [
      { name_or_content: 'good news', language: 'en_US', limit: 50 },
      { limit: 50, language: 'en_US' },
    ];
    for (const query of queries) {
      try {
        add(await GraphAPI.searchUtilityTemplateLibrary(pageToken, query));
        if (collected.length >= 8) break;
      } catch (err) {
        if (isRateLimitError(err)) throw err;
      }
    }

    libraryBrowseCache.set(key, { at: Date.now(), list: collected });
    return collected;
  }

  function libraryPickBody(pick) {
    const fromComp = pick?.components?.find(
      (c) => String(c.type || '').toUpperCase() === 'BODY'
    )?.text;
    return String(pick?.body || fromComp || templateBodyFromApi(pick) || '').trim();
  }

  function isCloneableLibraryPick(pick) {
    const body = libraryPickBody(pick);
    if (!body || !/\{\{1\}\}/.test(body)) return false;
    if (hasUnwantedWrapper(body)) return false;
    const params = body.match(/\{\{\d+\}\}/g) || [];
    if (params.length !== 1) return false;
    const name = String(pick?.name || '').toLowerCase();
    if (name.includes('post_purchase') || name.includes('account_update') || name.includes('order_confirm')) {
      return false;
    }
    if (/order|delivery|shipment|purchase|appointment|account/i.test(name) && !/^good news/i.test(body)) {
      return false;
    }
    return true;
  }

  function scoreLibraryPick(pick) {
    const body = libraryPickBody(pick);
    if (!isCloneableLibraryPick(pick)) return -1;
    const staticLen = body.replace(/\{\{\d+\}\}/g, '').trim().length;
    const btnCount = libraryPickButtons(pick).length;
    let score = 220 - staticLen - btnCount * 35;
    if (/^good news!/i.test(body)) score += 55;
    if (body === 'Good news! {{1}}' || body === 'Good news! {{1}}.') score += 45;
    if (body === '({{1}})' || body.startsWith('Message:') || body.startsWith('Update:')) score += 25;
    if (staticLen > 80) score -= 40;
    return score;
  }

  function rankLibraryPicks(list) {
    return [...(list || [])]
      .map((pick) => ({ pick, score: scoreLibraryPick(pick) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((row) => row.pick);
  }

  async function cloneLibraryPickToPage(pageId, pageToken, pick, cloneName) {
    let existing = await findPageTemplate(pageId, pageToken, cloneName);
    if (existing?.status === 'REJECTED') return { error: new Error('Library clone rejected by Meta.') };
    if (existing?.status === 'PENDING') {
      existing = await waitForTemplateApproval(pageId, pageToken, cloneName, 6);
    }
    if (existing?.status === 'APPROVED') {
      const enriched = await enrichTemplateRecord(pageId, pageToken, existing);
      const norm = normalizeFromApi(enriched);
      if (isUsableTemplateBody(norm.body)) return { tpl: norm };
      return { error: new Error('Approved library clone body is not usable.') };
    }

    let lastError = null;
    for (let pass = 0; pass < 2; pass++) {
      const includeButtons = pass === 1;
      try {
        await GraphAPI.cloneUtilityLibraryTemplate(
          pageId,
          pageToken,
          buildLibraryClonePayload(cloneName, pick, { includeButtons })
        );
        invalidateTemplateListCache(pageId);
        const approved = await waitForTemplateApproval(pageId, pageToken, cloneName, 6);
        if (approved?.status === 'APPROVED') {
          const enriched = await enrichTemplateRecord(pageId, pageToken, approved);
          const norm = normalizeFromApi(enriched);
          if (isUsableTemplateBody(norm.body)) return { tpl: norm };
          return { error: new Error('Approved library clone body is not usable.') };
        }
        if (approved?.status === 'REJECTED') {
          lastError = new Error('Meta ne library template reject kar di.');
          break;
        }
      } catch (err) {
        lastError = err;
        rethrowIfRateLimited(err, pageId);
        const msg = String(err?.message || '').toLowerCase();
        if (
          !includeButtons &&
          (msg.includes('button') || msg.includes('body') || isTemplateCreationFailedError(err))
        ) {
          continue;
        }
        break;
      }
      break;
    }
    return { error: lastError || new Error('Library clone failed.') };
  }

  async function tryMinimalLibraryClone(pageId, pageToken) {
    const baseName = `pagechat_lib_minimal_${String(pageId).slice(-8)}`;
    const libList = (await browseUtilityLibrary(pageToken)).filter(isSafeLibraryPick);
    const ranked = rankLibraryPicks(libList);
    if (!ranked.length) {
      const fallback = libList.filter(isCloneableLibraryPick);
      ranked.push(...fallback.slice(0, 2));
    }
    if (!ranked.length) {
      throw new Error(
        'Meta template library mein koi suitable template nahi mila. Business Suite → Message templates check karein.'
      );
    }

    let lastError = null;
    for (let i = 0; i < Math.min(ranked.length, 2); i++) {
      const pick = ranked[i];
      const cloneName = i === 0 ? baseName : `${baseName}_${i}`;
      const result = await cloneLibraryPickToPage(pageId, pageToken, pick, cloneName);
      if (result.tpl) return result.tpl;
      if (result.error) lastError = result.error;
    }
    if (lastError) throw lastError;
    return null;
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
    const body = libraryPickBody(pick);
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
    const sendable = list
      .filter((t) => isApprovedStatus(t.status) && isAllowedTemplateName(t.name))
      .filter((t) => isUsableTemplateBody(templateBodyFromApi(t)))
      .sort(
        (a, b) =>
          templatePreferScore(b.name, templateBodyFromApi(b)) -
          templatePreferScore(a.name, templateBodyFromApi(a))
      );
    return sendable;
  }

  async function doResolveUtilityTemplate(pageId, pageToken, { createIfMissing = true } = {}) {
    if (isInRateLimitCooldown(pageId)) {
      const offline = getOfflineCachedTemplate(pageId);
      if (offline) return offline;
      const existing = await findExistingSendableTemplate(pageId, pageToken);
      if (existing) return existing;
      throw new Error(rateLimitCooldownMessage(pageId));
    }

    const existing = await findExistingSendableTemplate(pageId, pageToken);
    if (existing) {
      saveCachedTemplateRecord(pageId, existing);
      return existing;
    }
    if (!createIfMissing) return null;

    clearTemplateCache(pageId);
    let lastError = null;

    try {
      const libraryTpl = await tryMinimalLibraryClone(pageId, pageToken);
      if (libraryTpl) {
        assertSafeTemplate(libraryTpl);
        saveCachedTemplateRecord(pageId, libraryTpl);
        return libraryTpl;
      }
    } catch (err) {
      lastError = err;
      rethrowIfRateLimited(err, pageId);
    }

    for (const i of [0, 1]) {
      const def = getTemplateDef(i);
      const name = ownedTemplateName(pageId, i);
      try {
        const created = await tryCreateOwnedTemplate(pageId, pageToken, def, name);
        if (created && isUsableTemplateBody(created.body)) {
          assertSafeTemplate(created);
          saveCachedTemplateRecord(pageId, created);
          return created;
        }
      } catch (err) {
        lastError = err;
        rethrowIfRateLimited(err, pageId);
      }
    }

    throw new Error(
      formatUtilityError(
        lastError ||
          new Error(
            'Meta ki approved template library se setup nahi ho saki. ' +
              'Business Suite → Message templates check karein.'
          )
      )
    );
  }

  async function resolveUtilityTemplate(pageId, pageToken, options = {}) {
    const id = String(pageId);
    if (resolveInflight.has(id)) return resolveInflight.get(id);
    const job = doResolveUtilityTemplate(pageId, pageToken, options).finally(() => {
      resolveInflight.delete(id);
    });
    resolveInflight.set(id, job);
    return job;
  }

  async function resolveExactCustomTemplate(pageId, pageToken) {
    return resolveUtilityTemplate(pageId, pageToken, { createIfMissing: true });
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
    if (isInRateLimitCooldown(page.id)) {
      throw new Error(rateLimitCooldownMessage(page.id));
    }

    const detail = normalizeOutgoingText(msg);
    let lastErr = null;
    let candidates = [];

    const ready = readyTemplates.get('custom') || getOfflineCachedTemplate(page.id);
    if (ready?.name && isUsableTemplateBody(ready.body)) {
      candidates.push(rawTplFromNorm(ready));
    }
    if (!candidates.length) {
      candidates = await listLiveSendableTemplates(page.id, page.access_token);
    }

    for (const raw of candidates) {
      try {
        const { result, tpl } = await trySendUtilityTemplate(page, psid, detail, raw);
        templateCache.set(`${page.id}:${categoryKey || 'any'}`, tpl);
        readyTemplates.set(categoryKey || 'custom', tpl);
        saveCachedTemplateRecord(page.id, tpl);
        rememberPreview(page.id, psid, detail);
        return result;
      } catch (err) {
        lastErr = err;
        rethrowIfRateLimited(err, page.id);
        if (err.wrapperTemplate || err.notExact || err.templateBodyMissing) continue;
        if (err.templateNotFound || isTemplateNotFoundError(err)) continue;
        throw err;
      }
    }

    try {
      const created = await resolveUtilityTemplate(page.id, page.access_token, { createIfMissing: true });
      const raw = rawTplFromNorm(created) || created;
      const { result, tpl } = await trySendUtilityTemplate(page, psid, detail, raw);
      readyTemplates.set(categoryKey || 'custom', tpl);
      saveCachedTemplateRecord(page.id, tpl);
      rememberPreview(page.id, psid, detail);
      return result;
    } catch (err) {
      lastErr = err;
      rethrowIfRateLimited(err, page.id);
    }

    throw (
      lastErr ||
      new Error(formatUtilityError(new Error('Utility template send failed.')))
    );
  }

  async function prepare(page) {
    if (!page?.id || !page?.access_token) return;

    const categoryKey = getActiveCategoryKey();
    if (preparedPageId === page.id && readyTemplates.get('custom')) {
      showStatus(`Ready — Good news! + your text`, true);
      updateLivePreview(page, categoryKey);
      return;
    }
    if (preparePromise && preparedPageId === page.id) return preparePromise;

    preparedPageId = page.id;
    showStatus('Ready — Good news! + your text', true);
    updateLivePreview(page, categoryKey);

    preparePromise = (async () => {
      try {
        if (isInRateLimitCooldown(page.id)) {
          const offline = getOfflineCachedTemplate(page.id);
          if (offline) readyTemplates.set('custom', offline);
          showStatus(rateLimitCooldownMessage(page.id), false);
          return;
        }

        const cachedBody = getCustomTemplatesState()[page.id]?.readyBody;
        if (cachedBody) {
          readyTemplates.set('custom', {
            name: getCachedTemplateName(page.id),
            body: cachedBody,
            language: 'en',
          });
        }

        const tpl = await resolveUtilityTemplate(page.id, page.access_token, {
          createIfMissing: false,
        });
        if (tpl) {
          readyTemplates.set('custom', tpl);
          showStatus(`Ready — Good news! + your text`, true);
          updateLivePreview(page, categoryKey);
          return;
        }

        showStatus('Ready — Good news! + your text (Send par template setup)', true);
      } catch (err) {
        if (isRateLimitError(err)) {
          noteRateLimit(page.id);
          showStatus(rateLimitCooldownMessage(page.id), false);
        } else {
          showStatus('Ready — Good news! + your text', true);
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
      if (isRateLimitError(err)) noteRateLimit(page.id);
      clearTemplateCache(page.id);
      if (isRateLimitError(err)) throw new Error(rateLimitCooldownMessage(page.id));
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
    const ready = readyTemplates.get('custom') || readyTemplates.get(_categoryKey);
    const body = String(ready?.body || 'Good news! {{1}}');
    if (!msg) {
      preview.textContent = 'Good news! …';
      return;
    }
    if (body === '({{1}})') {
      preview.textContent = `(${msg})`;
    } else if (body === 'Message:\n{{1}}') {
      preview.textContent = `Message:\n${msg}`;
    } else if (body === 'Update:\n{{1}}') {
      preview.textContent = `Update:\n${msg}`;
    } else if (body === 'Good news! {{1}}.') {
      preview.textContent = `Good news! ${msg}.`;
    } else {
      preview.textContent = `Good news! ${msg}`;
    }
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
    formatUtilityError,
    showStatus,
    hideStatus,
    reset,
  };
})();
