/**
 * PageChat Hub — Facebook Page Messenger Manager
 */
(function () {
  'use strict';

  let pages = [];
  let activePage = null;

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    AppReview.init();
    Readiness.init();
    bindUI();
    Readiness.runTechnicalChecks();
    await bootstrapAuth();
  }

  async function bootstrapAuth() {
    setStatus('Loading…');
    await loadEnvConfig();

    if (!Auth.getAppId()) {
      setStatus('App configuration missing. Contact the website owner.', true);
      showHelp(
        'Owner: add FACEBOOK_APP_ID in Railway Variables, then redeploy. Until App Review is approved, only Test Users can log in (Meta → App Roles).'
      );
      return;
    }

    try {
      await Auth.initSDK();
      setStatus('Ready — click Connect with Facebook.');
      const session = await Auth.checkSession();
      if (session) await enterApp(session);
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  /** Reload env.js (Railway injects App ID) then merge into FB_CONFIG */
  async function loadEnvConfig() {
    try {
      const res = await fetch('/js/env.js?t=' + Date.now());
      if (res.ok) {
        const code = await res.text();
        if (code.includes('appId')) {
          new Function(code)();
          if (window.__PAGECHAT__?.appId) {
            FB_CONFIG.appId = window.__PAGECHAT__.appId;
          }
        }
      }
    } catch {
      /* static hosting — uses js/env.js stub or config.js */
    }
    if (!FB_CONFIG.appId && window.__PAGECHAT__?.appId) {
      FB_CONFIG.appId = window.__PAGECHAT__.appId;
    }
  }

  function bindUI() {
    document.getElementById('btn-login')?.addEventListener('click', onLogin);
    document.getElementById('btn-logout')?.addEventListener('click', onLogout);
    document.getElementById('page-select')?.addEventListener('change', onPageChange);
    document.getElementById('btn-refresh-inbox')?.addEventListener('click', refreshInbox);
    document.getElementById('btn-refresh-posts')?.addEventListener('click', refreshEngagement);
    document.getElementById('composer-form')?.addEventListener('submit', onSendReply);
    document.getElementById('utility-form')?.addEventListener('submit', onSendUtility);
    document.getElementById('btn-copy-notes')?.addEventListener('click', copyNotes);
    document.getElementById('btn-copy-script')?.addEventListener('click', copyVideoScript);
    document.getElementById('btn-copy-all-urls')?.addEventListener('click', copyAllUrls);
    document.getElementById('btn-start-review-guide')?.addEventListener('click', () => AppReview.openGuide(0));
    document.getElementById('btn-run-meta-tests')?.addEventListener('click', onRunMetaTests);
    document.getElementById('btn-test-pages-list')?.addEventListener('click', () => MetaTests.runPagesShowListOnly());
    document.getElementById('btn-meta-done')?.addEventListener('click', () => Readiness.confirmMetaSetupDone());

    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
  }

  async function onLogin() {
    try {
      if (!Auth.getAppId()) {
        toast('App not configured yet', true);
        return;
      }
      await Auth.initSDK();
      setStatus('Opening Facebook…');
      showHelp('');
      const auth = await Auth.login();
      await enterApp(auth);
    } catch (e) {
      setStatus('Could not sign in', true);
      showHelp(e.message);
      toast(e.message, true);
    }
  }

  async function enterApp(authResponse) {
    try {
      const user = await Auth.fetchUser();
      document.querySelector('.landing-main')?.classList.add('hidden');
      document.querySelector('.landing-header')?.classList.add('hidden');
      document.querySelector('.landing-footer')?.classList.add('hidden');
      document.getElementById('app-shell').classList.remove('hidden');

      document.getElementById('sidebar-avatar').src = user.picture?.data?.url || '';
      document.getElementById('sidebar-name').textContent = user.name;

      pages = await GraphAPI.getPages();
      if (!pages.length) {
        toast(
          'No Facebook Page found on this account. Create a Page or use an account that manages one.',
          true
        );
        showHelp(
          'You need a Facebook Page to use PageChat Hub. Go to facebook.com/pages/create, then sign in again.'
        );
        return;
      }

      const sel = document.getElementById('page-select');
      sel.innerHTML = pages.map((p) => `<option value="${p.id}">${escape(p.name)}</option>`).join('');

      const saved = localStorage.getItem(FB_CONFIG.storageKeys.activePageId);
      if (saved && pages.find((p) => p.id === saved)) sel.value = saved;
      await setActivePage(pages.find((p) => p.id === sel.value) || pages[0]);
      AppReview.renderSettingsBlocks(window.location.origin);
      AppReview.onLoginComplete();
      let scopes = authResponse?.grantedScopes || '';
      if (!scopes) {
        try {
          const perms = await GraphAPI.userGet('/me/permissions');
          scopes = (perms.data || []).filter((p) => p.status === 'granted').map((p) => p.permission).join(',');
        } catch { /* ignore */ }
      }
      await Readiness.onLogin(pages, scopes);
      updateVideoScript();
      switchView('review');
      toast('Welcome! Open Submission Center — fix blockers before Meta submit.');
    } catch (e) {
      toast(e.message, true);
      showHelp(
        e.message +
          ' — If this is a new user, ensure the Meta app is Live or add them as Tester in App Roles.'
      );
    }
  }

  async function setActivePage(page) {
    activePage = page;
    localStorage.setItem(FB_CONFIG.storageKeys.activePageId, page.id);
    Inbox.stopPolling();
    try {
      await Inbox.load(page);
    } catch (e) {
      toast('Inbox: ' + e.message, true);
    }
    const eng = await Engagement.load(page);
    if (eng?.ok) AppReview.markPermissionUsed('pages_read_engagement');
    Inbox.startPolling(page);
    refreshPageMeta();
  }

  async function onPageChange(e) {
    const page = pages.find((p) => p.id === e.target.value);
    if (page) await setActivePage(page);
  }

  async function refreshInbox() {
    if (!activePage) return;
    await Inbox.load(activePage);
    toast('Inbox updated');
  }

  async function refreshEngagement() {
    if (!activePage) return;
    await Engagement.load(activePage);
    AppReview.markPermissionUsed('pages_read_engagement');
    toast('Engagement updated');
  }

  async function onSendReply(e) {
    e.preventDefault();
    const input = document.getElementById('reply-input');
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    try {
      await Inbox.sendReply(activePage, text);
      AppReview.markPermissionUsed('pages_messaging');
      Readiness.markDemo('pages_messaging');
      toast('Message sent');
    } catch (err) {
      input.value = text;
      toast(err.message, true);
    }
  }

  async function onSendUtility(e) {
    e.preventDefault();
    const psid = document.getElementById('utility-recipient').value;
    const text = document.getElementById('utility-body').value.trim();
    const tag = document.getElementById('utility-tag').value;
    if (!psid || !text) {
      Utility.showStatus('Select a customer and enter a message.', false);
      return;
    }
    try {
      await Utility.send(activePage, psid, text, tag);
      AppReview.markPermissionUsed('pages_utility_messaging');
      Readiness.markDemo('pages_utility_messaging');
      Utility.showStatus('Utility message sent successfully.', true);
      toast('Utility message sent');
    } catch (err) {
      Utility.showStatus(err.message, false);
      toast(err.message, true);
    }
  }

  async function onLogout() {
    Inbox.stopPolling();
    await Auth.logout();
    localStorage.removeItem(FB_CONFIG.storageKeys.activeConvId);
    location.reload();
  }

  function switchView(name) {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    if (name === 'settings') {
      setupSettingsUrls();
      refreshPageMeta();
    }
    if (name === 'review') {
      Readiness.render();
      updateVideoScript();
    }
  }

  function refreshPageMeta() {
    if (!activePage) return;
    const statusEl = document.getElementById('webhook-status');
    const actionsEl = document.getElementById('webhook-actions');
    PageMeta.refresh(activePage, statusEl, actionsEl);
  }

  window.switchView = switchView;
  window.toast = toast;
  window.refreshInbox = refreshInbox;

  function updateVideoScript() {
    const el = document.getElementById('video-script');
    if (el) el.textContent = Readiness.getVideoScript();
  }

  function copyVideoScript() {
    navigator.clipboard?.writeText(Readiness.getVideoScript());
    toast('Video script copied');
  }

  async function onRunMetaTests() {
    if (!activePage) {
      toast('Log in and select a Page first', true);
      return;
    }
    const btn = document.getElementById('btn-run-meta-tests');
    if (btn) btn.disabled = true;
    try {
      await MetaTests.runAll(activePage, pages);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function copyAllUrls() {
    const o = location.origin;
    const text = `App URL: ${o}/
Privacy: ${o}/privacy.html
Data deletion: ${o}/data-deletion.html
Terms: ${o}/terms.html
Deauthorize: ${o}/deauth.html
Webhook: ${o}/webhook`;
    navigator.clipboard?.writeText(text);
    toast('All URLs copied');
  }

  function setupSettingsUrls() {
    const origin = window.location.origin;
    const webhook = `${origin}/webhook`;
    const cb = document.getElementById('webhook-callback');
    const wd = document.getElementById('webhook-url-display');
    if (cb) cb.textContent = webhook;
    if (wd) wd.textContent = webhook;
  }

  function copyNotes() {
    const ta = document.getElementById('review-notes');
    ta.select();
    navigator.clipboard?.writeText(ta.value);
    toast('Copied');
  }

  function setStatus(msg, err) {
    const el = document.getElementById('login-status');
    if (el) {
      el.textContent = msg;
      el.style.color = err ? '#e41e3f' : '#65676b';
    }
  }

  function showHelp(msg) {
    const el = document.getElementById('login-help');
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
    d.textContent = s;
    return d.innerHTML;
  }
})();
