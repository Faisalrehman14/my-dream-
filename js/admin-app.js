/**
 * Wayfair — Admin / Meta Command Center
 */
(function () {
  'use strict';

  const LS_ADMIN_KEY = 'pagechat_admin_unlocked';
  let pages = [];
  let activePage = null;
  let webhookSubscribed = false;

  const VIEW_TITLES = {
    overview: 'Dashboard',
    setup: 'Meta Setup',
    review: 'App Review',
    data: 'Data Handling',
    testing: 'API Testing',
    urls: 'URLs & Docs',
    webhooks: 'Webhooks',
  };

  const PERM_META = [
    { id: 'check-profile', code: 'public_profile', label: 'Profile', desc: 'User identity in sidebar' },
    { id: 'check-pages', code: 'pages_show_list', label: 'Pages', desc: 'Page dropdown' },
    { id: 'check-messaging', code: 'pages_messaging', label: 'Messaging', desc: 'Inbox & replies' },
    { id: 'check-engagement', code: 'pages_read_engagement', label: 'Engagement', desc: 'Post metrics' },
    { id: 'check-utility', code: 'pages_utility_messaging', label: 'Utility', desc: 'Notifications' },
    { id: 'check-metadata', code: 'pages_manage_metadata', label: 'Webhooks', desc: 'Real-time inbox' },
  ];

  function brandName() {
    return (typeof APP_BRAND !== 'undefined' && APP_BRAND.name) || 'Wayfair';
  }

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    AppReview.init();
    Readiness.init();
    bindUI();
    renderPermGrid();
    Readiness.runTechnicalChecks();
    await loadEnvConfig();
    applyBranding();
    checkAdminGate();
    initTestCredsFromStorage();
  }

  function applyBranding() {
    const name = brandName();
    document.title = `Admin — ${name}`;
    document.getElementById('admin-brand-title')?.replaceChildren(document.createTextNode(name));
    document.getElementById('admin-hero-title')?.replaceChildren(document.createTextNode(`${name} · Submission Readiness`));
  }

  async function loadEnvConfig() {
    try {
      const res = await fetch('/js/env.js?t=' + Date.now());
      if (res.ok) {
        const code = await res.text();
        if (code.includes('appId')) {
          new Function(code)();
          if (window.__PAGECHAT__?.appId) FB_CONFIG.appId = window.__PAGECHAT__.appId;
        }
      }
    } catch { /* static */ }
    if (!FB_CONFIG.appId && window.__PAGECHAT__?.appId) {
      FB_CONFIG.appId = window.__PAGECHAT__.appId;
    }
  }

  function getExpectedAdminKey() {
    return (window.__PAGECHAT__?.adminKey || '').trim();
  }

  function checkAdminGate() {
    const expected = getExpectedAdminKey();
    const hint = document.getElementById('admin-key-hint');
    if (!expected) {
      if (hint) hint.textContent = 'No access key configured — set ADMIN_ACCESS_KEY in Railway, or enter any key in dev mode.';
      if (sessionStorage.getItem(LS_ADMIN_KEY) === '1') showLoginStep();
      return;
    }
    if (sessionStorage.getItem(LS_ADMIN_KEY) === expected) {
      showLoginStep();
      bootstrapAuth();
    }
  }

  function bindUI() {
    document.getElementById('btn-admin-unlock')?.addEventListener('click', onUnlock);
    document.getElementById('admin-key')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onUnlock();
    });
    document.getElementById('btn-admin-login')?.addEventListener('click', onAdminLogin);
    document.getElementById('btn-admin-logout')?.addEventListener('click', onLogout);
    document.getElementById('admin-page-select')?.addEventListener('change', onPageChange);
    document.getElementById('btn-copy-notes')?.addEventListener('click', copyNotes);
    document.getElementById('btn-copy-script')?.addEventListener('click', copyVideoScript);
    document.getElementById('btn-copy-recording-url')?.addEventListener('click', copyRecordingUrl);
    document.getElementById('btn-copy-all-urls')?.addEventListener('click', copyAllUrls);
    document.getElementById('btn-copy-oauth')?.addEventListener('click', copyOAuthUris);
    document.getElementById('btn-copy-meta-basic-all')?.addEventListener('click', copyMetaBasicAll);
    document.getElementById('btn-start-review-guide')?.addEventListener('click', () => AppReview.openGuide(0));
    document.getElementById('btn-run-meta-tests')?.addEventListener('click', onRunMetaTests);
    document.getElementById('btn-test-pages-list')?.addEventListener('click', () => MetaTests.runPagesShowListOnly());
    document.getElementById('btn-meta-done')?.addEventListener('click', () => Readiness.confirmMetaSetupDone());

    document.getElementById('qa-screencast')?.addEventListener('click', () => {
      window.open(`${location.origin}/portal.html?review=1&view=engagement&guide=1`, '_blank');
    });
    document.getElementById('qa-walkthrough')?.addEventListener('click', () => AppReview.openGuide(0));
    document.getElementById('qa-meta-setup')?.addEventListener('click', () => switchView('setup'));
    document.getElementById('qa-data-handling')?.addEventListener('click', () => switchView('data'));
    document.getElementById('qa-run-tests')?.addEventListener('click', () => {
      switchView('testing');
      onRunMetaTests();
    });

    document.querySelectorAll('.admin-sidebar .nav-item').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
  }

  function renderPermGrid() {
    const grid = document.getElementById('admin-perm-grid');
    if (!grid) return;
    grid.innerHTML = PERM_META.map(
      (p) => `
      <div class="admin-perm-card" id="${p.id}-card">
        <span class="admin-perm-card__icon check-icon">○</span>
        <code>${p.code}</code>
        <strong>${escape(p.label)}</strong>
        <span>${escape(p.desc)}</span>
      </div>`
    ).join('');
  }

  function syncPermCards() {
    PERM_META.forEach((p) => {
      const li = document.getElementById(p.id);
      const card = document.getElementById(`${p.id}-card`);
      const done = li?.classList.contains('done');
      if (card) {
        card.classList.toggle('done', !!done);
        const icon = card.querySelector('.check-icon');
        if (icon) icon.textContent = done ? '✓' : '○';
      }
    });
  }

  function renderMetaBasicFields() {
    const el = document.getElementById('meta-basic-fields');
    if (!el) return;
    const o = location.origin;
    const h = location.hostname;
    const email = (typeof APP_BRAND !== 'undefined' && APP_BRAND.contactEmail) || 'your@email.com';
    const cat = (typeof APP_BRAND !== 'undefined' && APP_BRAND.metaCategory) || 'Business';
    const fields = [
      { label: 'Display name', value: brandName(), key: 'display_name' },
      { label: 'App domains', value: h, key: 'app_domains' },
      { label: 'Contact email', value: email, key: 'contact_email' },
      { label: 'Privacy Policy URL', value: `${o}/privacy.html`, key: 'privacy' },
      { label: 'Terms of Service URL', value: `${o}/terms.html`, key: 'terms' },
      { label: 'User data deletion instructions URL', value: `${o}/data-deletion.html`, key: 'deletion' },
      { label: 'Category', value: cat, key: 'category' },
      { label: 'Site URL', value: `${o}/`, key: 'site_url' },
      { label: 'App login URL (for reviewers)', value: `${o}/portal.html`, key: 'login_url' },
      { label: 'Webhook callback', value: `${o}/webhook`, key: 'webhook' },
    ];
    el.innerHTML = fields
      .map(
        (f) => `
      <div class="meta-copy-row">
        <div class="meta-copy-row__head">
          <strong>${escape(f.label)}</strong>
          <button type="button" class="btn-text btn-sm" data-copy-meta="${escapeAttr(f.key)}">Copy</button>
        </div>
        <pre class="meta-copy-value" id="meta-val-${f.key}">${escape(f.value)}</pre>
      </div>`
      )
      .join('');
    el.querySelectorAll('[data-copy-meta]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-copy-meta');
        const val = document.getElementById(`meta-val-${key}`)?.textContent || '';
        navigator.clipboard?.writeText(val);
        toast(`Copied: ${key.replace('_', ' ')}`);
      });
    });
  }

  function renderMetaComplianceFields() {
    const el = document.getElementById('meta-compliance-fields');
    if (!el) return;
    const o = location.origin;
    const fields = [
      {
        label: 'Deauthorize callback URL',
        value: `${o}/api/deauthorize`,
        key: 'deauth_callback',
        hint: 'Meta → Settings → Basic → Deauthorize. Server accepts POST signed_request.',
      },
      {
        label: 'Data Deletion Request URL',
        value: `${o}/api/data-deletion`,
        key: 'deletion_callback',
        hint: 'Meta → Settings → Basic → Data Deletion Requests. Server returns confirmation_code + status URL.',
      },
      {
        label: 'Deletion status page (for users)',
        value: `${o}/data-deletion/status.html?code=CODE`,
        key: 'deletion_status',
        hint: 'Returned to users after Facebook-initiated deletion request.',
      },
      {
        label: 'Deauthorize info page (optional)',
        value: `${o}/deauth.html`,
        key: 'deauth_page',
        hint: 'Human-readable page — not the Meta callback URL.',
      },
    ];
    el.innerHTML = fields
      .map(
        (f) => `
      <div class="meta-copy-row">
        <div class="meta-copy-row__head">
          <strong>${escape(f.label)}</strong>
          <button type="button" class="btn-text btn-sm" data-copy-meta="${escapeAttr(f.key)}">Copy</button>
        </div>
        <p class="meta-muted meta-copy-hint">${escape(f.hint)}</p>
        <pre class="meta-copy-value" id="meta-val-${f.key}">${escape(f.value)}</pre>
      </div>`
      )
      .join('');
    el.querySelectorAll('[data-copy-meta]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-copy-meta');
        const val = document.getElementById(`meta-val-${key}`)?.textContent || '';
        navigator.clipboard?.writeText(val);
        toast(`Copied: ${key.replace(/_/g, ' ')}`);
      });
    });
  }

  function copyMetaBasicAll() {
    const rows = document.querySelectorAll('.meta-copy-value');
    const text = Array.from(rows)
      .map((r) => r.textContent)
      .join('\n');
    navigator.clipboard?.writeText(text);
    toast('All Meta Basic fields copied');
  }

  async function runHealthCheck() {
    const healthEl = document.getElementById('status-health');
    const appEl = document.getElementById('status-appid-val');
    const appCard = document.getElementById('status-appid');
    const secretEl = document.getElementById('status-secret-val');
    const secretCard = document.getElementById('status-secret');
    const complianceEl = document.getElementById('status-compliance-val');
    const complianceCard = document.getElementById('status-compliance');
    const httpsEl = document.getElementById('status-https-val');

    if (httpsEl) httpsEl.textContent = location.protocol === 'https:' ? 'Active' : 'Required';
    document.getElementById('status-https')?.querySelector('.admin-status-dot')?.classList.toggle('ok', location.protocol === 'https:');

    const appId = FB_CONFIG.appId || window.__PAGECHAT__?.appId || '';
    if (appEl) appEl.textContent = appId ? appId.slice(0, 8) + '…' : 'Missing';
    appCard?.querySelector('.admin-status-dot')?.classList.toggle('ok', Boolean(appId));
    appCard?.querySelector('.admin-status-dot')?.classList.toggle('err', !appId);

    const pill = document.getElementById('admin-app-id-pill');
    if (pill && appId) {
      pill.textContent = `App ID ${appId}`;
      pill.classList.remove('hidden');
    }

    let health = null;
    try {
      const res = await fetch('/health');
      health = await res.json();
      if (healthEl) {
        const span = healthEl.querySelector('span:last-child');
        if (span) span.textContent = health.ok ? `Online · ${health.build || ''}` : 'Error';
        healthEl.querySelector('.admin-status-dot')?.classList.toggle('ok', health.ok === true);
        healthEl.querySelector('.admin-status-dot')?.classList.toggle('err', health.ok !== true);
      }
      if (secretEl) secretEl.textContent = health.appSecretSet ? 'Set' : 'Missing';
      secretCard?.querySelector('.admin-status-dot')?.classList.toggle('ok', health.appSecretSet === true);
      secretCard?.querySelector('.admin-status-dot')?.classList.toggle('err', !health.appSecretSet);
      if (complianceEl) complianceEl.textContent = health.complianceReady ? 'Ready' : 'Fix secret';
      complianceCard?.querySelector('.admin-status-dot')?.classList.toggle('ok', health.complianceReady === true);
      complianceCard?.querySelector('.admin-status-dot')?.classList.toggle('err', !health.complianceReady);
    } catch {
      if (healthEl) {
        const span = healthEl.querySelector('span:last-child');
        if (span) span.textContent = 'Offline';
        healthEl.querySelector('.admin-status-dot')?.classList.add('err');
      }
      if (secretEl) secretEl.textContent = 'Unknown';
      if (complianceEl) complianceEl.textContent = 'Unknown';
    }

    try {
      const deauth = await fetch('/api/deauthorize');
      const del = await fetch('/api/data-deletion');
      const ok = deauth.ok && del.ok;
      if (complianceEl && ok && health?.complianceReady) complianceEl.textContent = 'Ready';
      complianceCard?.querySelector('.admin-status-dot')?.classList.toggle('ok', ok && health?.complianceReady);
    } catch { /* ignore */ }

    updateWebhookStatus();
  }

  function updateWebhookStatus() {
    const el = document.getElementById('status-webhook-val');
    const card = document.getElementById('status-webhook');
    if (el) el.textContent = webhookSubscribed ? 'Subscribed' : 'Not subscribed';
    card?.querySelector('.admin-status-dot')?.classList.toggle('ok', webhookSubscribed);
    card?.querySelector('.admin-status-dot')?.classList.toggle('warn', !webhookSubscribed);
  }

  async function updateAdminPageAvatar(page) {
    if (!page) return;
    const img = document.getElementById('admin-page-avatar');
    const fb = document.getElementById('admin-page-avatar-fallback');
    let url = GraphAPI.pagePictureUrl?.(page);
    if (!url && GraphAPI.fetchPagePicture) {
      try {
        url = await GraphAPI.fetchPagePicture(page);
      } catch { /* fallback */ }
    }
    const initials = GraphAPI.pageInitials?.(page.name) || 'P';
    if (fb) {
      fb.textContent = initials;
      fb.classList.toggle('hidden', Boolean(url));
    }
    if (img) {
      if (url) {
        img.onload = () => {
          img.classList.remove('hidden');
          fb?.classList.add('hidden');
        };
        img.onerror = () => {
          img.classList.add('hidden');
          fb?.classList.remove('hidden');
        };
        img.src = url;
        img.alt = page.name;
      } else {
        img.classList.add('hidden');
        fb?.classList.remove('hidden');
      }
    }
  }

  function onUnlock() {
    const input = document.getElementById('admin-key')?.value.trim();
    const expected = getExpectedAdminKey();
    if (expected && input !== expected) {
      toast('Invalid access key', true);
      return;
    }
    if (!input && expected) {
      toast('Enter the admin access key', true);
      return;
    }
    sessionStorage.setItem(LS_ADMIN_KEY, expected || input || '1');
    showLoginStep();
    bootstrapAuth();
  }

  function showLoginStep() {
    document.getElementById('admin-key-step')?.classList.add('hidden');
    document.getElementById('admin-login-step')?.classList.remove('hidden');
  }

  async function bootstrapAuth() {
    if (!Auth.getAppId()) {
      setAdminStatus('Set FACEBOOK_APP_ID in Railway.', true);
      return;
    }
    try {
      await Auth.initSDK();
      setAdminStatus('Ready — sign in with your admin Facebook account.');
      runHealthCheck();
      const session = await Auth.checkSession();
      if (session) await enterAdmin(session);
    } catch (e) {
      setAdminStatus(e.message, true);
    }
  }

  async function onAdminLogin() {
    try {
      if (!Auth.getAppId()) {
        toast('App not configured', true);
        return;
      }
      await Auth.initSDK();
      setAdminStatus('Opening Facebook…');
      await enterAdmin(await Auth.login());
    } catch (e) {
      setAdminStatus('Could not sign in', true);
      showAdminHelp(e.message);
      toast(e.message, true);
    }
  }

  async function enterAdmin(authResponse) {
    try {
      const user = await Auth.fetchUser();
      document.getElementById('admin-gate')?.classList.add('hidden');
      document.getElementById('admin-shell')?.classList.remove('hidden');

      document.getElementById('admin-avatar').src = user.picture?.data?.url || '';
      document.getElementById('admin-name').textContent = user.name;

      pages = await GraphAPI.getPages();
      const sel = document.getElementById('admin-page-select');
      if (pages.length) {
        sel.innerHTML = pages.map((p) => `<option value="${p.id}">${escape(p.name)}</option>`).join('');
        const saved = localStorage.getItem(FB_CONFIG.storageKeys.activePageId);
        if (saved && pages.find((p) => p.id === saved)) sel.value = saved;
        activePage = pages.find((p) => p.id === sel.value) || pages[0];
        await updateAdminPageAvatar(activePage);
      } else {
        sel.innerHTML = '<option value="">No Pages found</option>';
      }

      AppReview.renderSettingsBlocks(window.location.origin);
      renderOAuthSetup(window.location.origin);
      renderMetaBasicFields();
      AppReview.onLoginComplete();
      AppReview.markPermissionUsed('public_profile');

      let scopes = authResponse?.grantedScopes || '';
      if (!scopes) {
        try {
          const perms = await GraphAPI.getPermissionStatus();
          scopes = perms.granted.join(',');
        } catch { /* ignore */ }
      }

      if (pages.length) {
        AppReview.markPermissionUsed('pages_show_list');
        await Readiness.onLogin(pages, scopes);
      }
      updateVideoScript();
      await refreshPageMeta();
      runHealthCheck();
      switchView('overview');
      syncPermCards();
      toast(`${brandName()} admin ready`);
    } catch (e) {
      toast(e.message, true);
      showAdminHelp(e.message);
    }
  }

  async function onPageChange(e) {
    activePage = pages.find((p) => p.id === e.target.value) || null;
    if (activePage) {
      localStorage.setItem(FB_CONFIG.storageKeys.activePageId, activePage.id);
      await updateAdminPageAvatar(activePage);
      await refreshPageMeta();
    }
  }

  async function onLogout() {
    await Auth.logout();
    sessionStorage.removeItem(LS_ADMIN_KEY);
    location.reload();
  }

  function switchView(name) {
    document.querySelectorAll('.admin-sidebar .nav-item').forEach((n) =>
      n.classList.toggle('active', n.dataset.view === name)
    );
    document.querySelectorAll('.admin-main .view').forEach((v) =>
      v.classList.toggle('active', v.id === 'view-' + name)
    );
    document.getElementById('admin-topbar-title').textContent = VIEW_TITLES[name] || name;

    if (name === 'setup' || name === 'urls') renderOAuthSetup(window.location.origin);
    if (name === 'setup') {
      renderMetaBasicFields();
      renderMetaComplianceFields();
    }
    if (name === 'data') DataHandling.render();
    if (name === 'webhooks') {
      setupWebhookUrls();
      refreshPageMeta();
    }
    if (name === 'overview' || name === 'review') {
      Readiness.render();
      updateVideoScript();
      syncPermCards();
    }
    if (name === 'review' || name === 'urls') {
      AppReview.renderSettingsBlocks(window.location.origin);
    }
  }

  function initTestCredsFromStorage() {
    if (typeof AppReview === 'undefined' || !AppReview.getTestCreds) return;
    const saved = AppReview.getTestCreds();
    ['test-email', 'meta-test-email'].forEach((id) => {
      const el = document.getElementById(id);
      if (el && saved.email) el.value = saved.email;
    });
    ['test-password', 'meta-test-password'].forEach((id) => {
      const el = document.getElementById(id);
      if (el && saved.password) el.value = saved.password;
    });
    ['test-page-name', 'meta-test-page'].forEach((id) => {
      const el = document.getElementById(id);
      if (el && saved.pageName) el.value = saved.pageName;
    });
    AppReview.bindTestCredInputs?.(window.location.origin);
  }

  async function refreshPageMeta() {
    if (!activePage) return;
    const sub = await PageMeta.refresh(
      activePage,
      document.getElementById('webhook-status'),
      document.getElementById('webhook-actions')
    );
    webhookSubscribed = sub?.subscribed === true;
    updateWebhookStatus();
  }

  function setupWebhookUrls() {
    const webhook = `${location.origin}/webhook`;
    const cb = document.getElementById('webhook-callback');
    const wd = document.getElementById('webhook-url-display');
    if (cb) cb.textContent = webhook;
    if (wd) wd.textContent = webhook;
  }

  function updateVideoScript() {
    const el = document.getElementById('video-script');
    if (el) {
      el.textContent =
        typeof AppReview !== 'undefined'
          ? AppReview.getVideoScript(window.location.origin)
          : Readiness.getVideoScript();
    }
  }

  function copyVideoScript() {
    const text =
      typeof AppReview !== 'undefined'
        ? AppReview.getVideoScript(window.location.origin)
        : Readiness.getVideoScript();
    navigator.clipboard?.writeText(text);
    toast('Video script copied');
  }

  function copyRecordingUrl() {
    const url = `${window.location.origin}/portal.html?review=1&view=engagement&guide=1`;
    navigator.clipboard?.writeText(url);
    toast('Screencast URL copied');
  }

  async function onRunMetaTests() {
    if (!activePage) {
      toast('Select a Page first', true);
      return;
    }
    const btn = document.getElementById('btn-run-meta-tests');
    if (btn) btn.disabled = true;
    try {
      await MetaTests.runAll(activePage, pages);
    } finally {
      if (btn) btn.disabled = false;
      syncPermCards();
    }
  }

  function renderOAuthSetup(origin) {
    const host = location.hostname;
    const uris = [`${origin}/`, `${origin}/portal.html`, `${origin}/admin.html`].join('\n');
    const el = document.getElementById('oauth-redirect-uris');
    const domain = document.getElementById('oauth-allowed-domain');
    if (el) el.textContent = uris;
    if (domain) domain.textContent = host;
  }

  function copyOAuthUris() {
    const o = location.origin;
    navigator.clipboard?.writeText(`${o}/\n${o}/portal.html\n${o}/admin.html`);
    toast('OAuth redirect URIs copied');
  }

  function copyAllUrls() {
    const o = location.origin;
    const n = brandName();
    const text = `${n} — Meta URLs
App URL: ${o}/portal.html
Landing: ${o}/
Admin: ${o}/admin.html
Privacy: ${o}/privacy.html
Data deletion: ${o}/data-deletion.html
Terms: ${o}/terms.html
Webhook: ${o}/webhook
Screencast: ${o}/portal.html?review=1&view=engagement&guide=1`;
    navigator.clipboard?.writeText(text);
    toast('All URLs copied');
  }

  function copyNotes() {
    const ta = document.getElementById('review-notes');
    navigator.clipboard?.writeText(ta?.value || '');
    toast('Copied');
  }

  window.switchView = switchView;
  window.toast = toast;

  function setAdminStatus(msg, err) {
    const el = document.getElementById('admin-login-status');
    if (el) {
      el.textContent = msg;
      el.style.color = err ? '#e41e3f' : '#65676b';
    }
  }

  function showAdminHelp(msg) {
    const el = document.getElementById('admin-login-help');
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  function toast(msg, err) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.background = err ? '#e41e3f' : '#1c1e21';
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 4500);
  }

  function escape(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s ?? '').replace(/"/g, '&quot;');
  }
})();
