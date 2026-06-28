/**
 * pages_manage_metadata — subscribe Page to Messenger webhooks
 */
const PageMeta = (function () {
  'use strict';

  const FIELDS = FB_CONFIG.webhookFields.join(',');

  async function getSubscription(pageId, pageToken) {
    const res = await GraphAPI.pageGet(pageToken, `/${pageId}/subscribed_apps`);
    const apps = res.data || [];
    const appId = FB_CONFIG.appId;
    const mine = apps.find((a) => String(a.id) === String(appId) || a.link);
    return { apps, subscribed: apps.length > 0, appEntry: mine };
  }

  async function subscribe(pageId, pageToken) {
    return GraphAPI.pagePost(
      pageToken,
      `/${pageId}/subscribed_apps?subscribed_fields=${encodeURIComponent(FIELDS)}`
    );
  }

  async function unsubscribe(pageId, pageToken) {
    const res = await GraphAPI.pageDelete(pageToken, `/${pageId}/subscribed_apps`);
    if (res && res.success === false) {
      throw new Error('Unsubscribe failed');
    }
    return res;
  }

  function renderStatus(el, state) {
    if (!el) return;
    if (state.loading) {
      el.innerHTML = '<p class="meta-status loading">Checking webhook subscription…</p>';
      return;
    }
    if (state.error) {
      el.innerHTML = `<p class="meta-status err">${escape(state.error)}</p>`;
      return;
    }
    if (state.subscribed) {
      el.innerHTML = `
        <p class="meta-status ok">✓ This Page is subscribed to real-time Messenger webhooks.</p>
        <p class="meta-muted">Fields: <code>${FIELDS}</code></p>
        <p class="meta-muted">Callback URL (set in Meta App dashboard): <code id="meta-callback-hint"></code></p>`;
      const hint = document.getElementById('meta-callback-hint');
      if (hint) hint.textContent = window.location.origin + '/webhook';
    } else {
      el.innerHTML = `
        <p class="meta-status warn">Page is not subscribed yet. Click below to enable real-time message delivery.</p>`;
    }
  }

  async function refresh(page, statusEl, actionsEl) {
    renderStatus(statusEl, { loading: true });
    try {
      const sub = await getSubscription(page.id, page.access_token);
      renderStatus(statusEl, { subscribed: sub.subscribed });
      if (typeof Readiness !== 'undefined') Readiness.setWebhook(sub.subscribed);
      if (actionsEl) {
        actionsEl.innerHTML = sub.subscribed
          ? `<button type="button" class="btn-outline-sm" id="btn-unsubscribe-page">Disconnect webhooks</button>`
          : `<button type="button" class="btn-primary" id="btn-subscribe-page">Subscribe Page to webhooks</button>`;
        document.getElementById('btn-subscribe-page')?.addEventListener('click', () =>
          doSubscribe(page, statusEl, actionsEl)
        );
        document.getElementById('btn-unsubscribe-page')?.addEventListener('click', () =>
          doUnsubscribe(page, statusEl, actionsEl)
        );
      }
      return sub;
    } catch (e) {
      renderStatus(statusEl, { error: e.message });
      return null;
    }
  }

  async function doSubscribe(page, statusEl, actionsEl) {
    try {
      await subscribe(page.id, page.access_token);
      if (typeof AppReview !== 'undefined') {
        AppReview.markPermissionUsed('pages_manage_metadata');
      }
      if (typeof toast === 'function') toast('Page subscribed to webhooks');
      await refresh(page, statusEl, actionsEl);
    } catch (e) {
      if (typeof toast === 'function') toast(e.message, true);
      renderStatus(statusEl, {
        error: e.message + ' — Also add Callback URL in Meta → Messenger → Webhooks.',
      });
    }
  }

  async function doUnsubscribe(page, statusEl, actionsEl) {
    try {
      await unsubscribe(page.id, page.access_token);
      if (typeof toast === 'function') toast('Webhooks disconnected');
      await refresh(page, statusEl, actionsEl);
    } catch (e) {
      if (typeof toast === 'function') toast(e.message, true);
    }
  }

  function escape(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  return { refresh, subscribe, getSubscription };
})();
