const Engagement = (function () {
  'use strict';

  const ICONS = {
    like: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>',
    comment: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    share: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/></svg>',
  };

  function getLikeCount(post) {
    return (
      post.reactions?.summary?.total_count ??
      post.likes?.summary?.total_count ??
      post.like_count ??
      0
    );
  }

  function getCommentCount(post) {
    return post.comments?.summary?.total_count ?? post.comments_count ?? 0;
  }

  function getShareCount(post) {
    if (typeof post.shares === 'number') return post.shares;
    return post.shares?.count ?? 0;
  }

  function renderLoading() {
    const feed = document.getElementById('posts-feed');
    const stats = document.getElementById('engagement-stats');
    if (stats) {
      stats.innerHTML = [1, 2, 3, 4]
        .map(() => '<div class="stat-card stat-card--skeleton"><span class="stat-val">&nbsp;</span><span class="stat-label">&nbsp;</span></div>')
        .join('');
    }
    if (feed) {
      feed.innerHTML = [1, 2]
        .map(
          () => `
        <article class="post-card post-card--skeleton">
          <div class="sk-line sk-line--lg"></div>
          <div class="sk-line"></div>
          <div class="sk-metrics"></div>
        </article>`
        )
        .join('');
    }
  }

  function displayMode(options) {
    if (options?.reviewMode === true) return 'review';
    if (options?.userMode === true) return 'user';
    if (typeof isReviewMode === 'function' && isReviewMode()) return 'review';
    return 'user';
  }

  async function load(page, options = {}) {
    renderLoading();
    const mode = displayMode(options);
    try {
      const result = await GraphAPI.getPagePosts(page.id, page.access_token, 25, options);
      renderStats(result.posts, { mode, pageName: page.name });
      renderPosts(result.posts, { ...result, mode, pageName: page.name });
      return { ok: true, posts: result.posts };
    } catch (e) {
      document.getElementById('engagement-stats').innerHTML = '';
      if (e.userSessionInvalid) {
        showEmptyState('session');
        throw e;
      }
      if (e.code === 'NO_POSTS') {
        showEmptyState('no_posts', page, e.debug);
      } else {
        showEmptyState('error', page, null, e.message);
      }
      return { ok: false, error: e.message };
    }
  }

  function renderStats(posts, meta = {}) {
    let likes = 0;
    let comments = 0;
    let shares = 0;
    let hasMetrics = false;
    posts.forEach((p) => {
      if (p._hasMetrics) hasMetrics = true;
      likes += getLikeCount(p);
      comments += getCommentCount(p);
      shares += getShareCount(p);
    });
    const review = meta.mode === 'review';
    const user = meta.mode === 'user';
    const dash = review && !hasMetrics;
    const el = document.getElementById('engagement-stats');
    el.innerHTML = `
      <div class="stat-card">
        <span class="stat-icon stat-icon--posts" aria-hidden="true">📄</span>
        <span class="stat-val">${posts.length}</span>
        <span class="stat-label">Recent posts</span>
      </div>
      <div class="stat-card">
        <span class="stat-icon stat-icon--likes" aria-hidden="true">❤</span>
        <span class="stat-val">${dash ? '—' : formatNum(likes)}</span>
        <span class="stat-label">Total likes</span>
      </div>
      <div class="stat-card">
        <span class="stat-icon stat-icon--comments" aria-hidden="true">💬</span>
        <span class="stat-val">${dash ? '—' : formatNum(comments)}</span>
        <span class="stat-label">Comments</span>
      </div>
      <div class="stat-card">
        <span class="stat-icon stat-icon--shares" aria-hidden="true">↗</span>
        <span class="stat-val">${dash ? '—' : formatNum(shares)}</span>
        <span class="stat-label">Shares</span>
      </div>`;
  }

  function formatNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function renderPosts(posts, result) {
    const feed = document.getElementById('posts-feed');
    const { debug, perm, engagementBlocked, blockReason, mode, pageName } = result || {};
    const review = mode === 'review';
    const user = mode === 'user';
    const withMetrics = posts.filter((p) => p._hasMetrics).length;
    const metricsMissing = posts.length > 0 && withMetrics === 0;

    if (typeof Readiness !== 'undefined') {
      Readiness.setPosts(posts.length > 0);
      if ((!engagementBlocked && withMetrics > 0) || (review && posts.length > 0)) {
        Readiness.markDemo('pages_read_engagement');
      }
    }

    let alertHtml = '';
    if (review && posts.length > 0) {
      alertHtml = renderReviewDemoBanner(posts.length, pageName, perm?.status);
    } else if (!user && engagementBlocked && (blockReason || perm?.reason)) {
      alertHtml = renderAlertBanner(blockReason || perm?.reason, perm?.status);
    }

    const debugHtml =
      !user && !review && debug?.length && (metricsMissing || engagementBlocked)
        ? `<details class="engagement-technical">
            <summary>Technical details</summary>
            <pre class="api-debug">${debug.map(escape).join('\n')}</pre>
          </details>`
        : '';

    const postsHtml = posts.length
      ? posts.map((p) => renderPostCard(p, { mode })).join('')
      : '<p class="engagement-empty">No posts to display yet.</p>';

    feed.innerHTML = alertHtml + debugHtml + postsHtml;

    bindAlertActions();
    if ((withMetrics > 0 || (review && posts.length > 0)) && typeof AppReview !== 'undefined') {
      AppReview.markPermissionUsed('pages_read_engagement');
    }
  }

  function renderReviewDemoBanner(postCount, pageName, permStatus) {
    const granted = permStatus?.granted?.includes('pages_read_engagement');
    return `
      <div class="engagement-alert engagement-alert--review" role="status">
        <div class="engagement-alert__icon engagement-alert__icon--ok" aria-hidden="true">✓</div>
        <div class="engagement-alert__body">
          <span class="review-perm-badge">pages_read_engagement</span>
          <h3 class="engagement-alert__title">Post engagement dashboard</h3>
          <p class="engagement-alert__text">This screen uses <strong>pages_read_engagement</strong> to load your Page's posts and display <strong>like</strong>, <strong>comment</strong>, and <strong>share</strong> counts for each post — read-only analytics for Page managers.</p>
          <p class="engagement-alert__meta">${postCount} post(s) loaded from <strong>${escape(pageName || 'your Page')}</strong>${granted ? ' · Permission granted at login' : ''}</p>
        </div>
      </div>`;
  }

  function renderAlertBanner(reason, permStatus) {
    const granted = permStatus?.granted?.includes('pages_read_engagement');
    const configs = {
      session: {
        type: 'error',
        title: 'Session expired',
        text: 'Your Facebook login is no longer valid. Sign in again to load engagement data.',
        primary: 'Sign in again',
        primaryAction: 'logout',
      },
      advanced_access: {
        type: 'warn',
        title: 'Advanced Access required',
        text: 'Your login includes pages_read_engagement, but Meta has not approved Advanced Access for this app yet. In Meta Developers → App Review → Permissions, request Advanced Access for pages_read_engagement, then sign in again.',
        primary: 'Reconnect Facebook',
        primaryAction: 'reauth',
      },
      new_pages_token: {
        type: 'info',
        title: 'Page access token required',
        text: 'Facebook\'s New Pages experience only accepts a Page access token (not a user token) for post engagement. Sign out → log in → Allow all, then Refresh so we can fetch a fresh Page token with pages_read_engagement.',
        primary: 'Sign out & sign in',
        primaryAction: 'logout',
      },
      permission: {
        type: 'warn',
        title: 'Engagement permission required',
        text: 'Meta blocked read access to likes and comments. Add pages_read_engagement in your app use case, then sign in again.',
        primary: 'Reconnect Facebook',
        primaryAction: 'reauth',
      },
      page_token: {
        type: 'info',
        title: granted ? 'Reconnect to refresh Page access' : 'Permission not on this login',
        text: granted
          ? 'Your account shows the permission, but this Page token cannot read counts yet. Sign out and sign in with Allow all.'
          : 'pages_read_engagement was not included when you logged in. Sign in again and accept all permissions.',
        primary: 'Sign out & sign in',
        primaryAction: 'logout',
      },
      user: {
        type: 'warn',
        title: 'Missing permission',
        text: 'Log in again and allow pages_read_engagement when Facebook asks.',
        primary: 'Reconnect Facebook',
        primaryAction: 'reauth',
      },
    };
    const c = configs[reason] || configs.page_token;

    return `
      <div class="engagement-alert engagement-alert--${c.type}" role="alert">
        <div class="engagement-alert__icon" aria-hidden="true">!</div>
        <div class="engagement-alert__body">
          <h3 class="engagement-alert__title">${escape(c.title)}</h3>
          <p class="engagement-alert__text">${escape(c.text)}</p>
          <div class="engagement-alert__actions">
            <button type="button" class="btn-primary btn-sm" data-eng-action="${c.primaryAction}">${escape(c.primary)}</button>
            <button type="button" class="btn-outline-sm btn-sm" data-eng-action="refresh">Refresh</button>
            <button type="button" class="btn-text btn-sm" data-eng-action="help">Setup guide</button>
          </div>
        </div>
      </div>
      <dialog class="engagement-dialog" id="engagement-setup-dialog">
        <div class="engagement-dialog__inner">
          <button type="button" class="engagement-dialog__close" data-eng-action="close-dialog" aria-label="Close">&times;</button>
          <h3>Enable engagement metrics</h3>
          <ol class="engagement-dialog__steps">
            <li>Open <strong>Meta Developers</strong> → your app → <strong>Use cases</strong> → <strong>Manage everything on your Page</strong></li>
            <li><strong>Add permissions</strong> → enable <code>pages_read_engagement</code> → Save</li>
            <li><strong>App Roles</strong> → your Facebook account as <strong>Administrator</strong></li>
            <li>In ${typeof APP_BRAND !== 'undefined' ? APP_BRAND.name : 'Wayfair'}: <strong>Sign out</strong> → <strong>Continue with Facebook</strong> → <strong>Allow all</strong></li>
            <li>Return here and click <strong>Refresh</strong></li>
          </ol>
          ${permStatus ? `<p class="meta-muted"><strong>Granted:</strong> ${escape(permStatus.granted?.join(', ') || 'none')}</p>` : ''}
        </div>
      </dialog>`;
  }

  function renderPostCard(p, meta = {}) {
    const review = meta.mode === 'review';
    const user = meta.mode === 'user';
    const likes = getLikeCount(p);
    const comments = getCommentCount(p);
    const shares = getShareCount(p);
    const date = p.created_time ? new Date(p.created_time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
    const link = p.permalink_url
      ? `<a class="post-link" href="${escapeAttr(p.permalink_url)}" target="_blank" rel="noopener noreferrer">View on Facebook →</a>`
      : '';
    const noMetrics = !p._hasMetrics;
    const likeVal = review && noMetrics ? '—' : likes;
    const commentVal = review && noMetrics ? '—' : comments;
    const shareVal = review && noMetrics ? '—' : shares;
    const showHint = noMetrics && !review && !user;

    return `
      <article class="post-card${noMetrics && !user ? ' post-card--muted' : ''}">
        <p class="post-text">${escape(p.message || '(Media post)')}</p>
        <div class="post-metrics">
          <span class="post-metric" title="Likes">${ICONS.like}<strong>${likeVal}</strong>${review ? ' <span class="post-metric-label">Likes</span>' : ''}</span>
          <span class="post-metric" title="Comments">${ICONS.comment}<strong>${commentVal}</strong>${review ? ' <span class="post-metric-label">Comments</span>' : ''}</span>
          <span class="post-metric" title="Shares">${ICONS.share}<strong>${shareVal}</strong>${review ? ' <span class="post-metric-label">Shares</span>' : ''}</span>
          ${showHint ? '<span class="post-metric-hint">Counts unavailable</span>' : ''}
        </div>
        <footer class="post-footer">
          <time datetime="${escapeAttr(p.created_time || '')}">${escape(date)}</time>
          ${link}
        </footer>
      </article>`;
  }

  function showEmptyState(kind, page, debug, message) {
    const feed = document.getElementById('posts-feed');
    if (!feed) return;

    if (kind === 'session') {
      feed.innerHTML = renderAlertBanner('session');
      bindAlertActions();
      return;
    }

    if (kind === 'no_posts') {
      feed.innerHTML = `
        <div class="engagement-empty-state">
          <div class="engagement-empty-state__icon" aria-hidden="true">📭</div>
          <h3>No posts from Facebook yet</h3>
          <p>Page <strong>${escape(page?.name || '')}</strong> returned no posts via the API. Create a text or photo post on Facebook (Reels/Stories may not appear), then refresh.</p>
          <button type="button" class="btn-primary" id="btn-retry-engagement">Refresh</button>
          ${debug?.length ? `<details class="engagement-technical"><summary>Technical details</summary><pre class="api-debug">${debug.map(escape).join('\n')}</pre></details>` : ''}
        </div>`;
      document.getElementById('btn-retry-engagement')?.addEventListener('click', () => {
        if (typeof refreshEngagement === 'function') refreshEngagement();
      });
      return;
    }

    feed.innerHTML = `
      <div class="engagement-empty-state">
        <div class="engagement-empty-state__icon" aria-hidden="true">⚠</div>
        <h3>Could not load engagement</h3>
        <p>${escape(message || 'Unknown error')}</p>
        <button type="button" class="btn-primary" id="btn-retry-engagement">Try again</button>
      </div>`;
    document.getElementById('btn-retry-engagement')?.addEventListener('click', () => {
      if (typeof refreshEngagement === 'function') refreshEngagement();
    });
  }

  function bindAlertActions() {
    const feed = document.getElementById('posts-feed');
    const dialog = document.getElementById('engagement-setup-dialog');

    feed?.querySelectorAll('[data-eng-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-eng-action');
        if (action === 'close-dialog') {
          dialog?.close();
          return;
        }
        if (action === 'help') {
          dialog?.showModal?.();
          return;
        }
        if (action === 'refresh') {
          if (typeof refreshEngagement === 'function') await refreshEngagement();
          return;
        }
        if (action === 'logout') {
          document.getElementById('btn-logout')?.click();
          return;
        }
        if (action === 'reauth') {
          try {
            if (typeof window.refreshPageTokens === 'function') {
              await window.refreshPageTokens();
            } else {
              await Auth.rerequestPermissions();
              if (typeof refreshEngagement === 'function') await refreshEngagement();
            }
          } catch (e) {
            if (typeof toast === 'function') toast(e.message, true);
          }
        }
      });
    });
  }

  function escape(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  return { load };
})();
