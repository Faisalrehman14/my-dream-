/**
 * Graph API wrapper for PageChat Hub
 * Uses fetch() with explicit access_token — never FB.api({ access_token })
 */
const GraphAPI = (function () {
  'use strict';

  const POST_LIST_FIELDS = 'id,message,created_time,permalink_url';
  /** Try multiple field syntaxes — wrong syntax returns 400 on entire request */
  const METRICS_FIELDS = 'reactions.summary(total_count),comments.summary(total_count)';

  /** pageId -> access_token (avoid re-fetching; each fetch can rotate/invalidate prior tokens) */
  const pageTokenCache = new Map();
  let permissionCache = null;
  let permissionCacheAt = 0;
  const PERM_CACHE_MS = 60000;

  function apiVersion() {
    return FB_CONFIG.version || 'v21.0';
  }

  function getUserAccessToken() {
    const auth = typeof FB !== 'undefined' && FB.getAuthResponse?.();
    return auth?.accessToken || null;
  }

  /** Parse "/me/accounts?fields=id,name" without breaking on "?" inside values */
  function parsePathWithQuery(pathWithQuery) {
    const raw = String(pathWithQuery || '').trim();
    const normalized = raw.startsWith('/') ? raw : `/${raw}`;
    const u = new URL(normalized, 'https://graph.facebook.com');
    const segments = u.pathname.split('/').filter(Boolean);
    const query = {};
    u.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    return { segments, query };
  }

  function graphUrl(pathSegments, query, accessToken) {
    const base = `https://graph.facebook.com/${apiVersion()}`;
    const path = pathSegments.map((s) => String(s)).join('/');
    const url = new URL(`${base}/${path}`);
    if (query) {
      Object.entries(query).forEach(([k, v]) => {
        if (v != null) url.searchParams.set(k, String(v));
      });
    }
    url.searchParams.set('access_token', accessToken);
    return url.toString();
  }

  function isInvalidTokenError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    const code = err?.code;
    return (
      code === 190 ||
      code === 102 ||
      msg.includes('invalidated') ||
      msg.includes('invalid oauth') ||
      msg.includes('error validating access token') ||
      msg.includes('session has expired') ||
      msg.includes('session is invalid')
    );
  }

  /** Only user-token 190 should trigger full logout — page token errors are recoverable */
  function isUserSessionError(err) {
    return err?.userSessionInvalid === true;
  }

  function tagGraphError(err, tokenRole) {
    if (err.pageTokenRequired) return err;
    if (!isInvalidTokenError(err)) return err;
    if (tokenRole === 'user') err.userSessionInvalid = true;
    if (tokenRole === 'page') err.pageTokenInvalid = true;
    return err;
  }

  function graphErrorFromPayload(e) {
    let msg = e.error_user_msg || e.message || JSON.stringify(e);
    if (e.code === 4) {
      msg =
        'Facebook app request limit reached. Wait 15–30 minutes, then try once. Do not tap Continue repeatedly.';
    }
    const err = new Error(msg);
    err.code = e.code;
    err.subcode = e.error_subcode;
    err.fbtrace_id = e.fbtrace_id;
    if (e.code === 4) err.rateLimited = true;
    if (e.error_subcode === 2069032) {
      err.pageTokenRequired = true;
    } else if (isInvalidTokenError(err)) {
      err.invalidToken = true;
    }
    if (isEngagementError(msg) || e.code === 10 || e.code === 200 || e.code === 283) {
      err.engagementDenied = true;
    }
    return err;
  }

  function parseGraphResponse(data) {
    if (data?.error) throw graphErrorFromPayload(data.error);
    return data;
  }

  function parseBatchItem(item) {
    const parsed = typeof item.body === 'string' ? JSON.parse(item.body) : item.body;
    if (item.code !== 200 || parsed?.error) {
      throw graphErrorFromPayload(parsed?.error || { message: `Batch HTTP ${item.code}`, code: item.code });
    }
    return parsed;
  }

  async function graphBatchGet(relativeUrls, accessToken) {
    if (!relativeUrls.length) return [];
    const batch = relativeUrls.map((relative_url) => ({ method: 'GET', relative_url }));
    const url = `https://graph.facebook.com/${apiVersion()}/`;
    const body = new URLSearchParams();
    body.set('batch', JSON.stringify(batch));
    body.set('access_token', accessToken);
    const res = await fetch(url, { method: 'POST', body });
    const data = await res.json();
    if (data?.error) parseGraphResponse(data);
    return Array.isArray(data) ? data : [];
  }

  async function graphFetch(url) {
    const res = await fetch(url);
    const data = await res.json();
    try {
      return parseGraphResponse(data);
    } catch (e) {
      e.httpStatus = res.status;
      throw e;
    }
  }

  async function graphGet(pathSegments, query, accessToken, tokenRole) {
    try {
      return await graphFetch(graphUrl(pathSegments, query, accessToken));
    } catch (e) {
      throw tagGraphError(e, tokenRole);
    }
  }

  function userGet(pathSegments, query) {
    const token = getUserAccessToken();
    if (!token) return Promise.reject(new Error('Not logged in to Facebook'));
    return graphGet(pathSegments, query, token, 'user');
  }

  function pageGet(pageToken, pathSegments, query) {
    return graphGet(pathSegments, query, pageToken, 'page');
  }

  /** New Pages experience: Page access token ONLY — user token fallback is rejected (2069032) */
  async function graphGetForEngagement(pathSegments, query, pageToken, debug) {
    return pageGet(pageToken, pathSegments, query);
  }

  async function graphBatchGetForEngagement(relativeUrls, pageToken, debug) {
    return graphBatchGet(relativeUrls, pageToken);
  }

  async function debugTokenScopes(accessToken) {
    if (!accessToken) return null;
    try {
      const res = await fetch('/api/debug-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input_token: accessToken }),
      });
      return await res.json();
    } catch {
      return null;
    }
  }

  async function logTokenScopes(token, label, debug) {
    const info = await debugTokenScopes(token);
    const scopes = info?.data?.scopes;
    if (!scopes?.length) return;
    debug.push(`${label} scopes: ${scopes.join(', ')}`);
    if (!scopes.includes('pages_read_engagement')) {
      debug.push(`${label}: missing pages_read_engagement on this token`);
    }
  }

  async function graphPost(pathSegments, query, body, accessToken) {
    const url = graphUrl(pathSegments, query, accessToken);
    const init = { method: 'POST' };
    if (body != null && typeof body === 'object' && Object.keys(body).length > 0) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const data = await res.json();
    try {
      return parseGraphResponse(data);
    } catch (e) {
      e.httpStatus = res.status;
      throw e;
    }
  }

  function pagePost(pageToken, pathSegments, query, body) {
    return graphPost(pathSegments, query, body, pageToken);
  }

  async function pageDeleteReq(pageToken, pathSegments, query) {
    const url = graphUrl(pathSegments, query, pageToken);
    const res = await fetch(url, { method: 'DELETE' });
    return parseGraphResponse(await res.json());
  }

  async function getMe() {
    return userGet(['me'], { fields: 'id,name,picture.type(large)' });
  }

  async function getPages() {
    const res = await userGet(['me', 'accounts'], {
      fields: 'id,name,picture.type(large),access_token,category,unread_message_count',
      limit: 50,
    });
    const pages = res.data || [];
    for (const p of pages) {
      if (p.access_token) pageTokenCache.set(p.id, p.access_token);
    }
    return pages;
  }

  function pagePictureUrl(page) {
    const data = page?.picture?.data;
    if (data?.is_silhouette) return null;
    return data?.url || page?.picture?.url || page?.pictureUrl || null;
  }

  function pageInitials(name) {
    const parts = String(name || 'Page')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return String(name || 'P').substring(0, 2).toUpperCase();
  }

  /** Fetch real Page profile photo (accounts list often returns silhouette only) */
  async function fetchPagePicture(page) {
    const cached = pagePictureUrl(page);
    if (cached) return cached;

    const token = page.access_token || pageTokenCache.get(page.id);
    const tries = [];
    if (token) {
      tries.push(() => pageGet(token, [page.id], { fields: 'picture.type(large)' }));
      tries.push(() =>
        pageGet(token, [page.id, 'picture'], { type: 'large', redirect: 'false' })
      );
    }
    tries.push(() => userGet([page.id], { fields: 'picture.type(large)' }));

    for (const run of tries) {
      try {
        const res = await run();
        const url = res.picture?.data?.url || res.data?.url;
        const silhouette = res.picture?.data?.is_silhouette ?? res.data?.is_silhouette;
        if (url && !silhouette) return url;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  function clearPageTokenCache() {
    pageTokenCache.clear();
  }

  /**
   * Refresh Page token once per page per session (not on every API call).
   * Bulk refresh in getPages() was invalidating tokens still used by Inbox.
   */
  async function getFreshPageAccessToken(pageId, fallbackToken, { force = false } = {}) {
    if (!force && pageTokenCache.has(pageId)) {
      return pageTokenCache.get(pageId);
    }
    try {
      const res = await userGet([pageId], { fields: 'access_token' });
      if (res.access_token) {
        pageTokenCache.set(pageId, res.access_token);
        return res.access_token;
      }
    } catch (e) {
      if (e.userSessionInvalid) throw e;
      console.warn('[PageChat] Could not refresh page token:', e.message);
    }
    if (fallbackToken) pageTokenCache.set(pageId, fallbackToken);
    return fallbackToken;
  }

  async function resolvePage(page) {
    const token = await getFreshPageAccessToken(page.id, page.access_token, { force: false });
    return { ...page, access_token: token };
  }

  async function getConversations(pageId, pageToken) {
    const res = await pageGet(pageToken, [pageId, 'conversations'], {
      fields:
        'id,updated_time,snippet,unread_count,message_count,' +
        'participants{id,name,picture.type(large)},' +
        'messages.limit(1){id,message,from,created_time,attachments{type,mime_type,name,payload,generic_template{title,subtitle}}}',
      limit: 50,
    });
    return res.data || [];
  }

  const CONVERSATION_LIST_FIELDS =
    'id,updated_time,snippet,participants{id,name,picture.type(large)}';

  async function getAllConversations(pageId, pageToken, onProgress) {
    const all = [];
    let after = null;
    const limit = 100;

    while (true) {
      const query = { fields: CONVERSATION_LIST_FIELDS, limit };
      if (after) query.after = after;
      const res = await pageGet(pageToken, [pageId, 'conversations'], query);
      const batch = res.data || [];
      all.push(...batch);
      onProgress?.({ loaded: all.length, pageSize: batch.length });
      after = res.paging?.cursors?.after;
      if (!after || !batch.length) break;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    return all;
  }

  async function startBroadcastCampaign(payload) {
    const res = await fetch('/api/broadcast/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || 'Could not start broadcast');
      err.job = data.job;
      throw err;
    }
    return data.job;
  }

  async function getBroadcastCampaign(jobId) {
    const res = await fetch(`/api/broadcast/${encodeURIComponent(jobId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Campaign not found');
    return data.job;
  }

  async function cancelBroadcastCampaign(jobId) {
    const res = await fetch(`/api/broadcast/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not cancel campaign');
    return data.job;
  }

  async function getActiveBroadcastCampaign() {
    const res = await fetch('/api/broadcast/active/status');
    const data = await res.json();
    return data.job || null;
  }

  async function markConversationSeen(pageId, pageToken, recipientPsid) {
    if (!recipientPsid) return null;
    return pagePost(pageToken, [pageId, 'messages'], null, {
      recipient: { id: recipientPsid },
      sender_action: 'mark_seen',
    });
  }

  async function getConversationMessages(conversationId, pageToken) {
    const res = await pageGet(pageToken, [conversationId], {
      fields:
        'messages.limit(100){id,message,from{id,name},created_time,attachments{type,mime_type,name,payload,generic_template{title,subtitle}}}',
    });
    const data = res.messages?.data || [];
    return data.slice().reverse();
  }

  async function sendMessage(pageId, pageToken, recipientPsid, text, options = {}) {
    const result = await pagePost(pageToken, [pageId, 'messages'], null, {
      recipient: { id: recipientPsid },
      message: { text },
      ...options,
    });
    return result;
  }

  async function getPageMessageTemplates(pageId, pageToken, query = {}) {
    const res = await pageGet(pageToken, [pageId, 'message_templates'], {
      limit: 100,
      ...query,
    });
    return res.data || [];
  }

  async function createPageUtilityTemplate(pageId, pageToken, template) {
    return pagePost(pageToken, [pageId, 'message_templates'], null, template);
  }

  async function searchUtilityTemplateLibrary(pageToken, query = {}) {
    const res = await pageGet(pageToken, ['message_template_library'], {
      platform: 'messenger',
      language: 'en',
      limit: 25,
      ...query,
    });
    return res.data || [];
  }

  async function cloneUtilityLibraryTemplate(pageId, pageToken, payload) {
    return pagePost(pageToken, [pageId, 'message_templates'], null, payload);
  }

  async function sendUtilityTemplateMessage(pageId, pageToken, recipientPsid, template) {
    return pagePost(pageToken, [pageId, 'messages'], null, {
      recipient: { id: recipientPsid },
      messaging_type: 'UTILITY',
      message: { template },
    });
  }

  async function sendUtilityMessage(pageId, pageToken, recipientPsid, templateName, bodyText, language = 'en') {
    return sendUtilityTemplateMessage(pageId, pageToken, recipientPsid, {
      name: templateName,
      language: { code: language },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: bodyText }],
        },
      ],
    });
  }

  function isEngagementError(message) {
    const m = message || '';
    return (
      m.includes('(#10)') ||
      m.includes('pages_read_engagement') ||
      m.includes('Page Public Content Access')
    );
  }

  function postHasMetrics(item) {
    return (
      item.reactions?.summary?.total_count != null ||
      item.comments?.summary?.total_count != null
    );
  }

  /** Post IDs must be {pageId}_{storyId}; bare page id breaks /reactions edges */
  function ensurePostId(postId, pageId) {
    const id = String(postId || '').trim();
    if (!id) return null;
    if (id.includes('_')) return id;
    if (pageId && id !== String(pageId)) return `${pageId}_${id}`;
    return null;
  }

  function normalizePostItem(item) {
    const normalized = {
      id: item.id,
      message: item.message || item.title || item.description || '(Media post)',
      created_time: item.created_time,
      permalink_url: item.permalink_url,
      reactions: item.reactions,
      comments: item.comments,
      shares: item.shares,
    };
    normalized._hasMetrics = postHasMetrics(normalized);
    return normalized;
  }

  /** One probe — if this fails, skip dozens of per-post calls that all 400 */
  async function probeEngagementMetrics(pageId, pageToken, samplePostId, debug) {
    const pid = ensurePostId(samplePostId, pageId);
    if (!pid) return { ok: false, denied: false };
    try {
      await graphGetForEngagement([pid], { fields: METRICS_FIELDS }, pageToken, debug);
      debug.push('engagement probe: ✓ can read counts');
      return { ok: true, denied: false };
    } catch (e) {
      if (e.invalidToken) throw e;
      debug.push(`engagement probe: ✗ ${e.message}`);
      return { ok: false, denied: Boolean(e.engagementDenied || isEngagementError(e.message)) };
    }
  }

  async function fetchPostMetrics(postId, pageId, pageToken, debug) {
    const pid = ensurePostId(postId, pageId);
    if (!pid) return null;
    try {
      const res = await graphGetForEngagement([pid], { fields: METRICS_FIELDS }, pageToken, debug);
      const item = normalizePostItem({ id: pid, ...res, _metricsSource: 'fields' });
      if (item._hasMetrics) debug.push(`  ${pid}: ✓`);
      return item._hasMetrics ? item : null;
    } catch (e) {
      if (e.invalidToken) throw e;
      debug.push(`  ${pid}: ${e.message}`);
      return null;
    }
  }

  async function enrichPostsEngagement(posts, pageId, pageToken, debug) {
    const slice = posts.slice(0, 15);
    const need = slice.filter((p) => !p._hasMetrics);
    const ids = need.map((p) => ensurePostId(p.id, pageId)).filter(Boolean);

    if (ids.length) {
      try {
        const rel = ids.map((id) => `${id}?fields=${encodeURIComponent(METRICS_FIELDS)}`);
        const batchRes = await graphBatchGetForEngagement(rel, pageToken, debug);
        const byId = {};
        let ok = 0;
        batchRes.forEach((item, i) => {
          try {
            const body = parseBatchItem(item);
            const normalized = normalizePostItem({ id: ids[i], ...body });
            if (normalized._hasMetrics) {
              byId[ids[i]] = normalized;
              ok++;
            }
          } catch (e) {
            debug.push(`  batch ${ids[i]}: ${e.message}`);
          }
        });
        if (ok > 0) {
          debug.push(`batch metrics: ✓ ${ok}/${ids.length}`);
          return slice.map((p) => {
            const pid = ensurePostId(p.id, pageId) || p.id;
            return byId[pid] ? { ...p, id: pid, ...byId[pid] } : { ...p, id: pid };
          });
        }
      } catch (e) {
        if (e.invalidToken) throw e;
        debug.push(`batch: ${e.message}`);
      }
    }

    const out = [];
    for (const post of slice) {
      if (post._hasMetrics) {
        out.push(post);
        continue;
      }
      const pid = ensurePostId(post.id, pageId) || post.id;
      const metrics = await fetchPostMetrics(pid, pageId, pageToken, debug);
      out.push(metrics ? { ...post, id: pid, ...metrics } : { ...post, id: pid });
    }
    return out;
  }

  async function tryLoadPostsWithMetrics(pageId, pageToken, limitStr, debug) {
    const listFields = `${POST_LIST_FIELDS},${METRICS_FIELDS}`;
    for (const segments of [
      [pageId, 'posts'],
      [pageId, 'published_posts'],
    ]) {
      try {
        const res = await graphGetForEngagement(segments, { fields: listFields, limit: limitStr }, pageToken, debug);
        const posts = (res.data || [])
          .map((row) => normalizePostItem({ ...row, id: ensurePostId(row.id, pageId) || row.id }))
          .filter((p) => p.id);
        if (posts.some((p) => p._hasMetrics)) {
          debug.push(`${segments[1]}+metrics: ✓ ${posts.length} post(s)`);
          return { posts, source: `${segments[1]}+metrics` };
        }
      } catch (e) {
        if (e.invalidToken) throw e;
        debug.push(`${segments[1]}+metrics: ✗ ${e.message}`);
      }
    }
    return null;
  }

  /**
   * Load posts — basic fields only (no 400), then per-post metrics via edges.
   */
  async function getPagePosts(pageId, pageToken, limit = 25, options = {}) {
    const debug = [];
    const forceToken = options.forceToken === true;
    pageToken = await getFreshPageAccessToken(pageId, pageToken, { force: forceToken });
    debug.push(forceToken ? 'Page token refreshed (engagement)' : 'Page access token ready');
    if (options.debugToken !== false) {
      await logTokenScopes(pageToken, 'Page token', debug);
      const userToken = getUserAccessToken();
      if (userToken) await logTokenScopes(userToken, 'User token', debug);
    }

    let posts = [];
    let source = '';
    const limitStr = String(limit);

    const listTries = [
      { name: 'posts', segments: [pageId, 'posts'], fields: POST_LIST_FIELDS },
      { name: 'published_posts', segments: [pageId, 'published_posts'], fields: POST_LIST_FIELDS },
      { name: 'feed', segments: [pageId, 'feed'], fields: POST_LIST_FIELDS },
    ];

    for (const a of listTries) {
      try {
        const res = await pageGet(pageToken, a.segments, { fields: a.fields, limit: limitStr });
        posts = (res.data || [])
          .map((row) => normalizePostItem({ ...row, id: ensurePostId(row.id, pageId) || row.id }))
          .filter((p) => p.id);
        if (posts.length) {
          source = a.name;
          debug.push(`${a.name}: ✓ ${posts.length} post(s)`);
          break;
        }
        debug.push(`${a.name}: 0 results`);
      } catch (e) {
        if (e.invalidToken) throw e;
        debug.push(`${a.name}: ✗ ${e.message}`);
      }
    }

    if (posts.length && !posts.some((p) => p._hasMetrics)) {
      const bundled = await tryLoadPostsWithMetrics(pageId, pageToken, limitStr, debug);
      if (bundled) {
        posts = bundled.posts;
        source = bundled.source;
      }
    }

    if (!posts.length) {
      const err = new Error('No posts found on this Page.');
      err.debug = debug;
      err.code = 'NO_POSTS';
      throw err;
    }

    const perm = await getPermissionStatus().catch(() => ({ granted: [], declined: [] }));
    const hasUserPerm = perm.granted.includes('pages_read_engagement');

    if (!hasUserPerm) {
      debug.push('pages_read_engagement NOT in your login — add in Meta App use case, then Sign out & log in');
      return {
        posts,
        source,
        debug,
        engagementBlocked: true,
        perm: { ok: false, reason: 'user', status: perm },
      };
    }

    let enriched = posts;
    if (!posts.some((p) => p._hasMetrics)) {
      const probe = await probeEngagementMetrics(pageId, pageToken, posts[0].id, debug);
      if (probe.ok) {
        enriched = await enrichPostsEngagement(posts, pageId, pageToken, debug);
      } else if (probe.denied) {
        debug.push('Skipping per-post metrics calls — Meta blocked engagement reads for this token');
      }
    } else {
      debug.push('Metrics loaded with post list (no per-post calls)');
    }
    const withMetrics = enriched.filter((p) => p._hasMetrics).length;

    if (withMetrics === 0) {
      const debugText = debug.join(' ');
      const hasUserEngagement = perm.granted.includes('pages_read_engagement');
      let reason = 'page_token';
      if (!hasUserEngagement) reason = 'user';
      else if (debugText.includes('2069032') || debugText.includes('Page access token is required')) {
        reason = 'new_pages_token';
      } else if (isEngagementError(debugText)) reason = 'advanced_access';
      else if (debugText.includes('190') && debugText.includes('invalidated')) reason = 'session';

      debug.push(
        reason === 'new_pages_token'
          ? 'Meta New Pages experience requires a Page token with pages_read_engagement — sign out, allow all permissions, refresh.'
          : reason === 'advanced_access'
          ? 'Permission is on your login but Meta still blocks counts — request Advanced Access for pages_read_engagement in App Review, then re-login.'
          : reason === 'user'
            ? 'pages_read_engagement missing from login — Sign out and Allow all permissions.'
            : 'Sign out → Continue with Facebook → Allow all, then Refresh.'
      );
      return {
        posts: enriched,
        source: source + ' (no metrics)',
        debug,
        engagementBlocked: true,
        blockReason: reason,
        perm: { ok: false, reason, status: perm },
      };
    }

    return { posts: enriched, source: source + ' + metrics', debug, perm: { ok: true, status: perm } };
  }

  async function getPermissionStatus(force = false) {
    if (!force && permissionCache && Date.now() - permissionCacheAt < PERM_CACHE_MS) {
      return permissionCache;
    }
    const res = await userGet(['me', 'permissions'], {});
    const all = res.data || [];
    permissionCache = {
      granted: all.filter((p) => p.status === 'granted').map((p) => p.permission),
      declined: all.filter((p) => p.status === 'declined').map((p) => p.permission),
      expired: all.filter((p) => p.status === 'expired').map((p) => p.permission),
    };
    permissionCacheAt = Date.now();
    return permissionCache;
  }

  function clearPermissionCache() {
    permissionCache = null;
    permissionCacheAt = 0;
  }

  async function getGrantedPermissions() {
    return (await getPermissionStatus()).granted;
  }

  async function hasEngagementPermission() {
    const status = await getPermissionStatus();
    return status.granted.includes('pages_read_engagement');
  }

  function extractCustomerFromConversation(conv, pageId) {
    const parts = conv.participants?.data || [];
    const pageKey = String(pageId || '');
    const customer = parts.find((p) => String(p.id) !== pageKey);
    return customer || parts[0] || null;
  }

  // Legacy wrappers for page-meta.js (path string style)
  function pageGetPath(pageToken, pathWithQuery) {
    const { segments, query } = parsePathWithQuery(pathWithQuery);
    return pageGet(pageToken, segments, query);
  }

  function pagePostPath(pageToken, pathWithQuery, body) {
    const { segments, query } = parsePathWithQuery(pathWithQuery);
    return pagePost(pageToken, segments, Object.keys(query).length ? query : null, body);
  }

  function pageDeletePath(pageToken, pathWithQuery) {
    const { segments, query } = parsePathWithQuery(pathWithQuery);
    return pageDeleteReq(pageToken, segments, query);
  }

  function userGetPath(pathWithQuery) {
    const { segments, query } = parsePathWithQuery(pathWithQuery);
    return userGet(segments, query);
  }

  return {
    getMe,
    getPages,
    pagePictureUrl,
    pageInitials,
    fetchPagePicture,
    getFreshPageAccessToken,
    resolvePage,
    clearPageTokenCache,
    debugTokenScopes,
    isInvalidTokenError,
    isUserSessionError,
    getConversations,
    getAllConversations,
    startBroadcastCampaign,
    getBroadcastCampaign,
    cancelBroadcastCampaign,
    getActiveBroadcastCampaign,
    getConversationMessages,
    markConversationSeen,
    sendMessage,
    getPageMessageTemplates,
    createPageUtilityTemplate,
    searchUtilityTemplateLibrary,
    cloneUtilityLibraryTemplate,
    sendUtilityTemplateMessage,
    sendUtilityMessage,
    getPagePosts,
    getGrantedPermissions,
    getPermissionStatus,
    clearPermissionCache,
    hasEngagementPermission,
    isEngagementError,
    extractCustomerFromConversation,
    pageGet: pageGetPath,
    pagePost: pagePostPath,
    pageDelete: pageDeletePath,
    userGet: userGetPath,
    getUserAccessToken,
  };
})();
