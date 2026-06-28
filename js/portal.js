/**
 * Wayfair — End User Portal
 */
(function () {
  'use strict';

  let pages = [];
  let activePage = null;
  let engagementCache = null;
  let loginInFlight = false;
  let broadcastPollTimer = null;
  let activeBroadcastId = null;

  const VIEW_TITLES = {
    dashboard: 'Dashboard',
    inbox: 'Inbox',
    engagement: 'Engagement',
    utility: 'Notifications',
    settings: 'Settings',
  };

  document.addEventListener('DOMContentLoaded', () => {
    markPortalReady();
    init();
  });

  function markPortalReady() {
    document.documentElement.classList.remove('portal-boot');
    document.documentElement.classList.add('portal-ready');
  }

  function showAppShell() {
    const shell = document.getElementById('app-shell');
    shell?.classList.remove('hidden');
    shell?.removeAttribute('hidden');
    shell?.setAttribute('aria-hidden', 'false');
  }

  function hideAppShell() {
    const shell = document.getElementById('app-shell');
    shell?.classList.add('hidden');
    shell?.setAttribute('hidden', '');
    shell?.setAttribute('aria-hidden', 'true');
  }

  function showLoginScreen() {
    document.getElementById('login-screen')?.classList.remove('hidden');
    hideAppShell();
  }

  function brand() {
    return typeof APP_BRAND !== 'undefined' ? APP_BRAND : { name: 'Wayfair', tagline: 'Page Manager' };
  }

  function brandInitial() {
    return (brand().name || 'W').charAt(0).toUpperCase();
  }

  function applyBranding() {
    const b = brand();
    const initial = brandInitial();
    document.title = `Dashboard — ${b.name}`;

    [
      'login-brand-mark',
      'login-card-mark',
      'sidebar-brand-mark',
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = initial;
    });

    const heroTitle = document.getElementById('login-hero-title');
    if (heroTitle) heroTitle.textContent = b.name;

    const heroTag = document.getElementById('login-hero-tagline');
    if (heroTag) heroTag.textContent = b.tagline || 'Facebook Page Messenger Manager';

    const sidebarName = document.getElementById('sidebar-brand-name');
    if (sidebarName) sidebarName.textContent = b.name;
  }

  function formatStat(n) {
    const num = Number(n);
    if (!Number.isFinite(num) || num === 0) return '0';
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (num >= 10_000) return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(num);
  }

  async function init() {
    applyBranding();
    bindUI();
    if (isReviewMode() && typeof AppReview !== 'undefined') {
      AppReview.init();
    }
    await bootstrapAuth();
  }

  async function bootstrapAuth() {
    setStatus('Loading…');
    await loadEnvConfig();

    if (!Auth.getAppId()) {
      setStatus('App configuration missing. Contact the website owner.', true);
      showHelp('The app owner must set FACEBOOK_APP_ID in server environment variables.');
      return;
    }

    try {
      await Auth.initSDK();
      setStatus('Ready — click Continue with Facebook.');
      const session = await Auth.checkSession();
      if (session) await enterApp(session);
    } catch (e) {
      setStatus(e.message, true);
    }
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
    } catch { /* static hosting */ }
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
    document.querySelectorAll('input[name="utility-send-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        updateUtilitySendMode();
        if (isUtilityBulkMode() && activePage) {
          Inbox.loadAllSubscribers?.(activePage).then(() => updateUtilitySendMode()).catch(() => {});
        }
      });
    });
    document.getElementById('utility-tag')?.addEventListener('change', () => {
      Utility.reset?.();
      Utility.prepare?.(activePage).catch(() => {});
      Utility.refreshPreview?.(activePage);
    });
    document.getElementById('utility-message')?.addEventListener('input', () => {
      Utility.updateTemplateForm?.(activePage);
    });
    updateUtilitySendMode();
    document.getElementById('broadcast-cancel-btn')?.addEventListener('click', onCancelBroadcast);
    document.getElementById('sidebar-toggle')?.addEventListener('click', toggleSidebar);
    document.getElementById('dash-view-all-inbox')?.addEventListener('click', () => switchView('inbox'));

    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    document.querySelectorAll('.dash-action-card, [data-go]').forEach((card) => {
      if (card.dataset.go) {
        card.addEventListener('click', () => switchView(card.dataset.go));
      }
    });
  }

  function setLoginLoading(loading) {
    const btn = document.getElementById('btn-login');
    const label = document.getElementById('btn-login-label');
    if (!btn) return;
    btn.disabled = loading;
    btn.classList.toggle('is-loading', loading);
    if (label) label.textContent = loading ? 'Connecting…' : 'Continue with Facebook';
  }

  function toggleSidebar() {
    document.getElementById('sidebar')?.classList.toggle('open');
  }

  async function onLogin() {
    if (loginInFlight) return;
    try {
      if (!Auth.getAppId()) {
        toast('App not configured yet', true);
        return;
      }
      loginInFlight = true;
      setLoginLoading(true);
      await Auth.initSDK();
      setStatus('Opening Facebook…');
      showHelp('');
      await enterApp(await Auth.login());
    } catch (e) {
      setStatus('Could not sign in', true);
      const help = e.rateLimited
        ? `${e.message} If you were testing login many times, Facebook temporarily blocks the app.`
        : e.message;
      showHelp(help);
      toast(e.message, true);
    } finally {
      loginInFlight = false;
      setLoginLoading(false);
    }
  }

  async function enterApp(authResponse) {
    try {
      GraphAPI.clearPageTokenCache?.();

      const user = await Auth.fetchUser();
      document.getElementById('login-screen')?.classList.add('hidden');
      showAppShell();

      document.getElementById('sidebar-avatar').src = user.picture?.data?.url || '';
      document.getElementById('sidebar-name').textContent = user.name;
      updateGreeting(user.name);

      pages = await GraphAPI.getPages();
      if (!pages.length) {
        toast('No Facebook Page found. Create a Page or use an account that manages one.', true);
        showHelp('Go to facebook.com/pages/create, then sign in again.');
        return;
      }

      renderPageSelect(pages);

      const saved = localStorage.getItem(FB_CONFIG.storageKeys.activePageId);
      const sel = document.getElementById('page-select');
      if (saved && pages.find((p) => p.id === saved)) sel.value = saved;
      await setActivePage(pages.find((p) => p.id === sel.value) || pages[0]);
      const params = new URLSearchParams(location.search);
      switchView(params.get('view') || 'dashboard');
      if (isReviewMode() && typeof AppReview !== 'undefined') {
        AppReview.renderSettingsBlocks(location.origin);
        if (params.get('guide') === '1') {
          setTimeout(() => AppReview.openGuide(0), 600);
        }
      }
      toast('Welcome back!');
    } catch (e) {
      toast(e.message, true);
      showHelp(e.message);
    }
  }

  async function setActivePage(page) {
    try {
      page = await GraphAPI.resolvePage(page);
    } catch (e) {
      if (e.userSessionInvalid && handleInvalidSession(e)) return;
      page.access_token = page.access_token || pages.find((p) => p.id === page.id)?.access_token;
    }
    activePage = page;
    const idx = pages.findIndex((p) => p.id === page.id);
    if (idx >= 0) pages[idx] = page;
    localStorage.setItem(FB_CONFIG.storageKeys.activePageId, page.id);
    await updatePageBranding(page);
    updateTopbarPage(page);

    Inbox.stopPolling();
    Inbox.showLoading();
    refreshPageMeta();
    loadEngagementInBackground(page);

    try {
      await Inbox.load(page);
      flashSyncPill();
    } catch (e) {
      toast('Inbox: ' + e.message, true);
    }
    updateUtilitySendMode();
    Inbox.startPolling(page);
    updateDashboard();
    Utility.loadTemplateForm?.(page);
  }

  function updateTopbarPage(page) {
    const sub = document.getElementById('topbar-subtitle');
    if (sub) sub.textContent = page?.name ? `Managing ${page.name}` : '';
  }

  function flashSyncPill() {
    const pill = document.getElementById('sync-pill');
    if (!pill) return;
    pill.classList.remove('hidden');
    pill.textContent = 'Synced';
    clearTimeout(flashSyncPill._t);
    flashSyncPill._t = setTimeout(() => pill.classList.add('hidden'), 3200);
  }

  function renderPageSelect(pages) {
    const sel = document.getElementById('page-select');
    if (!sel) return;
    sel.innerHTML = pages.map((p) => `<option value="${p.id}">${escape(p.name)}</option>`).join('');
  }

  function setAvatarSlot(imgId, fallbackId, name, url) {
    const img = document.getElementById(imgId);
    const fb = document.getElementById(fallbackId);
    const initials = GraphAPI.pageInitials?.(name) || brandInitial();
    if (fb) {
      fb.textContent = initials;
      fb.classList.toggle('hidden', Boolean(url));
    }
    if (!img) return;
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
      img.alt = name || '';
      img.referrerPolicy = 'no-referrer';
    } else {
      img.classList.add('hidden');
      img.removeAttribute('src');
      fb?.classList.remove('hidden');
    }
  }

  async function updatePageBranding(page) {
    if (!page) return;
    const label = document.getElementById('dash-page-label');
    if (label) label.textContent = `Managing ${page.name}`;

    let url = GraphAPI.pagePictureUrl?.(page);
    if (!url && GraphAPI.fetchPagePicture) {
      try {
        url = await GraphAPI.fetchPagePicture(page);
        if (url) page.pictureUrl = url;
      } catch {
        /* initials fallback */
      }
    }

    setAvatarSlot('page-avatar', 'page-avatar-fallback', page.name, url);
    setAvatarSlot('dash-page-avatar', 'dash-page-avatar-fallback', page.name, url);
  }

  async function loadEngagementInBackground(page) {
    try {
      engagementCache = await Engagement.load(page, { debugToken: false, userMode: true });
      updateDashboard();
    } catch (e) {
      if (e.userSessionInvalid) handleInvalidSession(e);
      else engagementCache = { posts: [] };
    }
  }

  function updateGreeting(name) {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const el = document.getElementById('dash-greeting');
    if (el) el.textContent = `${greeting}, ${name.split(' ')[0]}`;
  }

  function renderRecentConversations() {
    const el = document.getElementById('dash-recent-convs');
    if (!el) return;

    const convs = Inbox.getConversations?.() || [];
    if (!convs.length) {
      el.innerHTML = '<p class="portal-empty-hint">No conversations yet. New messages will appear here.</p>';
      return;
    }

    el.innerHTML = convs.slice(0, 5).map((c) => {
      const name = escape(c.participants?.data?.[0]?.name || 'Customer');
      const snippet = escape(c.snippet || 'Open conversation');
      const unread = (c.unread_count || 0) > 0;
      const updated = c.updated_time
        ? new Date(c.updated_time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : '';
      return `
        <button type="button" class="portal-recent-item" data-conv-id="${escape(c.id)}">
          <div class="portal-recent-avatar">${name.charAt(0).toUpperCase()}</div>
          <div class="portal-recent-body">
            <div class="portal-recent-top">
              <strong>${name}</strong>
              <span class="portal-recent-time">${updated}</span>
            </div>
            <span class="portal-recent-snippet${unread ? ' is-unread' : ''}">${snippet}</span>
          </div>
          ${unread ? '<span class="portal-recent-dot" aria-label="Unread"></span>' : ''}
        </button>`;
    }).join('');

    el.querySelectorAll('.portal-recent-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchView('inbox');
        Inbox.openConversation?.(btn.dataset.convId, activePage);
      });
    });
  }

  function updateDashboard() {
    const convs = Inbox.getConversations?.() || [];
    const unread =
      typeof Inbox.getUnreadCount === 'function'
        ? Inbox.getUnreadCount(activePage?.id)
        : convs.filter((c) => (c.unread_count || 0) > 0).length;
    const posts = engagementCache?.posts || [];
    const totalEng = posts.reduce((n, p) => {
      const likes =
        p.reactions?.summary?.total_count ?? p.likes?.summary?.total_count ?? 0;
      const comments = p.comments?.summary?.total_count ?? 0;
      const shares = p.shares?.count ?? (typeof p.shares === 'number' ? p.shares : 0);
      return n + likes + comments + shares;
    }, 0);

    setDashStat('dash-conversations', formatStat(convs.length));
    setDashStat('dash-unread', formatStat(unread));
    setDashStat('dash-posts', formatStat(posts.length));
    setDashStat('dash-engagement', formatStat(totalEng));

    const badge = document.getElementById('unread-badge');
    if (badge) {
      if (unread > 0) {
        badge.textContent = unread > 99 ? '99+' : unread;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }

    renderRecentConversations();
  }

  function setDashStat(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  async function onPageChange(e) {
    const page = pages.find((p) => p.id === e.target.value);
    if (page) {
      await updatePageBranding(page);
      await setActivePage(page);
    }
  }

  async function refreshInbox() {
    if (!activePage) return;
    await Inbox.refresh(activePage, { forceMessages: true });
    updateDashboard();
    flashSyncPill();
    toast('Inbox updated');
  }

  async function refreshEngagement() {
    if (!activePage) return;
    engagementCache = await Engagement.load(activePage, { forceToken: true, userMode: true });
    updateDashboard();
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
      updateDashboard();
      toast('Message sent');
    } catch (err) {
      input.value = text;
      toast(err.message, true);
    }
  }

  function updateBroadcastUI(job) {
    if (!job) return;
    const panel = document.getElementById('broadcast-campaign');
    panel?.classList.remove('hidden');
    const bar = document.getElementById('broadcast-progress-bar');
    if (bar) bar.style.width = `${job.progress || 0}%`;
    const status = document.getElementById('broadcast-campaign-status');
    if (status) status.textContent = job.message || '';
    const stats = document.getElementById('broadcast-campaign-stats');
    if (stats) {
      stats.textContent = `Sent: ${job.sent || 0} · Failed: ${job.failed || 0} · ${job.progress || 0}% · ETA ~${job.etaMinutes || 0} min`;
    }
    Utility.showStatus(job.message || 'Bulk send running…', job.status !== 'cancelled', job.status === 'running');
  }

  function stopBroadcastPolling() {
    if (broadcastPollTimer) clearInterval(broadcastPollTimer);
    broadcastPollTimer = null;
  }

  function startBroadcastPolling(jobId) {
    activeBroadcastId = jobId;
    stopBroadcastPolling();
    broadcastPollTimer = setInterval(async () => {
      try {
        const job = await Utility.pollBulkCampaign(jobId, updateBroadcastUI);
        if (job.status === 'completed' || job.status === 'cancelled') {
          stopBroadcastPolling();
          activeBroadcastId = null;
          Utility.showStatus(job.message, job.status === 'completed');
          toast(job.message);
          updateUtilitySendMode();
        }
      } catch {
        /* keep polling */
      }
    }, 2500);
  }

  async function resumeBroadcastIfAny() {
    try {
      const job = await Utility.resumeActiveCampaign?.(updateBroadcastUI);
      if (job && (job.status === 'running' || job.status === 'paused' || job.status === 'queued')) {
        startBroadcastPolling(job.id);
      }
    } catch {
      /* ignore */
    }
  }

  async function onCancelBroadcast() {
    if (!activeBroadcastId) return;
    if (!confirm('Cancel the bulk send queue?')) return;
    try {
      const job = await Utility.cancelBulkCampaign(activeBroadcastId);
      stopBroadcastPolling();
      activeBroadcastId = null;
      updateBroadcastUI(job);
      Utility.showStatus('Bulk send cancelled.', false);
      updateUtilitySendMode();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function isUtilityBulkMode() {
    return document.querySelector('input[name="utility-send-mode"]:checked')?.value === 'all';
  }

  function updateUtilitySendMode() {
    const bulk = isUtilityBulkMode();
    const field = document.getElementById('utility-recipient-field');
    const sel = document.getElementById('utility-recipient');
    const btn = document.getElementById('utility-submit-btn');
    const count = Number(document.getElementById('utility-subscriber-count')?.textContent || 0);
    const campaignRunning = Boolean(activeBroadcastId);
    if (field) field.classList.toggle('hidden', bulk);
    if (sel) sel.required = !bulk;
    if (btn) {
      if (campaignRunning) {
        btn.textContent = 'Bulk send running…';
        btn.disabled = true;
      } else {
        const etaMin = Math.ceil((count * 2.5) / 60);
        btn.textContent = bulk
          ? `Queue send to ${count} subscribers (~${etaMin} min)`
          : 'Send notification';
        btn.disabled = bulk && count === 0;
      }
    }
  }

  async function onSendUtility(e) {
    e.preventDefault();
    const sel = document.getElementById('utility-recipient');
    const psid = sel?.value;
    const text = document.getElementById('utility-message').value.trim();
    const tag = document.getElementById('utility-tag').value;
    const customerName = sel?.options[sel.selectedIndex]?.text?.trim();
    const btn = document.getElementById('utility-submit-btn');
    const bulk = isUtilityBulkMode();

    if (!text) {
      Utility.showStatus('Enter a message.', false);
      return;
    }
    if (!bulk && !psid) {
      Utility.showStatus('Select a customer and enter a message.', false);
      return;
    }

    const recipients = bulk ? Inbox.getUtilityRecipients?.(activePage?.id) || [] : [];
    if (bulk && !recipients.length) {
      Utility.showStatus('Loading subscribers…', true, true);
      try {
        const loaded = await Inbox.loadAllSubscribers?.(activePage);
        recipients.push(...(loaded || []));
        updateUtilitySendMode();
      } catch (err) {
        Utility.showStatus(err.message, false);
        return;
      }
    }
    if (bulk && !recipients.length) {
      Utility.showStatus('No subscribers found. Customers must message your Page first.', false);
      return;
    }
    if (bulk) {
      const etaMin = Math.ceil((recipients.length * 2.5) / 60);
      const ok = confirm(
        `Queue notification for ${recipients.length} subscribers?\n\n` +
          `Server will send ~24 per minute (~${etaMin} min total).\n` +
          `If Facebook rate-limits, it auto-pauses and resumes.\n\n` +
          `Keep this tab open to watch progress (or come back later — server continues on Railway).`
      );
      if (!ok) return;
    }

    if (btn) btn.disabled = true;
    try {
      Utility.ensureTemplateFormValid?.(activePage);
      if (bulk) {
        const result = await Utility.sendToAll(activePage, recipients, text, tag, {
          onProgress({ current, total, name }) {
            Utility.showStatus(`Preparing queue… ${current}/${total} (${name})`, true, true);
          },
        });
        if (result.mode === 'server' && result.job) {
          updateBroadcastUI(result.job);
          startBroadcastPolling(result.job.id);
          toast(`Bulk queue started for ${result.total} subscribers`);
        } else {
          let msg = `Sent to ${result.sent} of ${result.total} subscriber${result.total === 1 ? '' : 's'}.`;
          if (result.failed.length) msg += ` ${result.failed.length} failed.`;
          Utility.showStatus(msg, result.sent > 0);
          toast(msg);
        }
      } else {
        await Utility.send(activePage, psid, text, tag, { customerName });
        Utility.showStatus('Notification sent successfully.', true);
        toast('Notification sent');
      }
      Inbox.refresh?.(activePage, { forceMessages: true });
    } catch (err) {
      const msg = Utility.formatUtilityError?.(err) || err.message;
      Utility.showStatus(msg, false);
      toast(msg, true);
    } finally {
      updateUtilitySendMode();
    }
  }

  function handleInvalidSession(err) {
    if (!err?.userSessionInvalid) return false;
    Inbox.stopPolling();
    GraphAPI.clearPageTokenCache?.();
    toast('Facebook session expired — please sign in again.', true);
    showLoginScreen();
    setStatus('Session expired. Click Continue with Facebook.', true);
    showHelp('Your Facebook login expired. Sign in again to continue.');
    return true;
  }

  async function onLogout() {
    Inbox.stopPolling();
    Utility.reset?.();
    GraphAPI.clearPageTokenCache?.();
    await Auth.logout();
    localStorage.removeItem(FB_CONFIG.storageKeys.activeConvId);
    location.reload();
  }

  function switchView(name) {
    document.querySelectorAll('.nav-item').forEach((n) =>
      n.classList.toggle('active', n.dataset.view === name)
    );
    document.querySelectorAll('.view').forEach((v) =>
      v.classList.toggle('active', v.id === 'view-' + name)
    );
    document.getElementById('topbar-title').textContent = VIEW_TITLES[name] || name;
    document.getElementById('sidebar')?.classList.remove('open');

    const live = document.getElementById('inbox-live-indicator');
    if (name === 'inbox') {
      Inbox.setInboxViewActive?.(true);
      if (live) live.classList.remove('hidden');
      if (activePage) Inbox.refresh?.(activePage, { forceMessages: false });
    } else {
      Inbox.setInboxViewActive?.(false);
      if (live) live.classList.add('hidden');
    }
    if (name === 'settings') refreshPageMeta();
    if (name === 'dashboard') updateDashboard();
    if (name === 'utility' && activePage) {
      Utility.loadTemplateForm?.(activePage);
      Utility.prepare?.(activePage).catch(() => {});
      Inbox.loadAllSubscribers?.(activePage).then(() => updateUtilitySendMode()).catch(() => {});
      resumeBroadcastIfAny();
      updateUtilitySendMode();
    }
  }

  function refreshPageMeta() {
    if (!activePage) return;
    PageMeta.refresh(
      activePage,
      document.getElementById('webhook-status'),
      document.getElementById('webhook-actions')
    );
  }

  async function refreshPageTokens() {
    Inbox.stopPolling();
    GraphAPI.clearPageTokenCache?.();
    await Auth.loginReauthorize();
    pages = await GraphAPI.getPages();
    const sel = document.getElementById('page-select');
    if (sel && pages.length) {
      sel.innerHTML = pages.map((p) => `<option value="${p.id}">${escape(p.name)}</option>`).join('');
      const id = activePage?.id || sel.value;
      sel.value = id;
      await setActivePage(pages.find((p) => p.id === id) || pages[0]);
    }
    toast('Permissions refreshed');
  }

  window.switchView = switchView;
  window.toast = toast;
  window.refreshInbox = refreshInbox;
  window.refreshPageTokens = refreshPageTokens;

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
    t.classList.remove('hidden', 'is-error', 'is-success');
    t.classList.add(err ? 'is-error' : 'is-success');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 4500);
  }

  function escape(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
})();
