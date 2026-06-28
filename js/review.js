/**
 * Meta App Review — guided walkthrough & submission text
 */
const AppReview = (function () {
  'use strict';

  const STEPS = [
    {
      id: 'public_profile',
      view: null,
      title: 'Step 1: public_profile',
      text: 'Your name and photo appear in the sidebar after login. This identifies the Page manager.',
      check: 'check-profile',
    },
    {
      id: 'pages_show_list',
      view: null,
      title: 'Step 2: pages_show_list',
      text: 'Use the "Active Page" dropdown in the sidebar — it lists every Page you manage.',
      check: 'check-pages',
    },
    {
      id: 'pages_messaging',
      view: 'inbox',
      title: 'Step 3: pages_messaging',
      text: 'Open Inbox → select a conversation → read messages → type a reply and press Send.',
      check: 'check-messaging',
    },
    {
      id: 'pages_read_engagement',
      view: 'engagement',
      title: 'Step 4: pages_read_engagement',
      text: 'Open Engagement → view posts with likes, comments, and shares for the selected Page.',
      check: 'check-engagement',
    },
    {
      id: 'pages_utility_messaging',
      view: 'utility',
      title: 'Step 5: pages_utility_messaging',
      text: 'Open Utility Messages → pick a customer → choose message type → send an order/shipping update.',
      check: 'check-utility',
    },
    {
      id: 'pages_manage_metadata',
      view: 'settings',
      title: 'Step 6: pages_manage_metadata',
      text: 'Open Settings → click "Subscribe Page to webhooks" → see green confirmation that the Page is connected for real-time messages.',
      check: 'check-metadata',
    },
  ];

  function appName() {
    return (typeof APP_BRAND !== 'undefined' && APP_BRAND.name) || 'Wayfair';
  }

  function getPermissionAnswers() {
    const n = appName();
    return {
      public_profile: `${n} uses public_profile solely to display the authenticated user's name and profile picture in the bottom-left sidebar of the dashboard immediately after Facebook Login. This allows Page managers and customer support agents to visually confirm they are signed in with the correct Facebook account before accessing their Page inbox. The profile data is rendered client-side only and is never stored on our servers, shared with third parties, or used for advertising or analytics purposes.`,

      pages_show_list: `${n} uses pages_show_list to retrieve the list of Facebook Pages that the authenticated user manages, and displays them in an "Active Page" dropdown selector in the dashboard sidebar. This is the essential first step in our onboarding flow — the user must select which Page's inbox and engagement data they want to work with. Without this permission, users who manage multiple Pages cannot navigate between them, and the entire platform becomes non-functional since all subsequent features (inbox, engagement, messaging) are scoped to the selected Page. Page names and IDs are used only to populate this selector and are not stored or shared.`,

      pages_messaging: `${n} uses pages_messaging to power its core feature: a real-time Messenger inbox for Facebook Page customer support. After selecting a Page, the user can view all active Messenger conversations with customers, open individual threads to read the full message history, and send direct replies to customers from within the dashboard — all without switching to Facebook. This permission is essential for businesses that rely on Messenger as a primary customer service channel. Messages are fetched from Meta's API and rendered in the browser session only. We do not store message content on our servers, we never initiate unsolicited messages, and we only send replies to existing user-initiated conversations where the customer has already contacted the Page.`,

      pages_read_engagement: `${n} uses pages_read_engagement to display post performance metrics for the selected Facebook Page in our Engagement screen. The dashboard fetches the Page's recent posts and shows each post's like count, comment count, and share count, along with aggregate totals at the top. This gives Page managers a quick overview of which content resonates with their audience and how active their community is. The data is displayed in read-only format for analytics purposes only. We do not modify posts, and this data is never used for advertising, retargeting, or shared with any third party.`,

      pages_utility_messaging: `${n} uses pages_utility_messaging to enable businesses to send one-to-one transactional notifications to customers who have already initiated contact with their Page on Messenger. In the Notifications screen, the user selects a customer from their existing inbox conversations, chooses a notification type (order/shipping, appointment/event, or account update), composes the message details, and sends it using Meta-approved utility message templates. All messages are strictly transactional in nature, sent only to customers who have previously messaged the Page, and comply fully with Meta's utility messaging policies. This feature is not used for marketing or promotional messaging.`,

      pages_manage_metadata: `${n} uses pages_manage_metadata to allow Page administrators to subscribe their Facebook Page to Messenger webhook events through our Settings screen. When the user clicks "Subscribe Page to webhooks," our platform registers the Page with Meta's webhook system to receive real-time push notifications for incoming messages, postbacks, and message echoes. This subscription enables our inbox to update in real time when new customer messages arrive, eliminating the need for manual page refreshes. The permission is used exclusively for webhook subscription management and no Page settings or metadata are modified for any other purpose.`,
    };
  }

  let stepIndex = 0;

  function init() {
    buildModal();
    bindCopyButtons();
  }

  function buildModal() {
    if (document.getElementById('review-modal')) return;

    const html = `
      <div id="review-modal" class="review-modal hidden">
        <div class="review-modal-inner">
          <button type="button" class="review-close" id="review-close" aria-label="Close">×</button>
          <span class="review-badge">Meta App Review Guide</span>
          <h2 id="review-step-title"></h2>
          <p id="review-step-text"></p>
          <div class="review-progress"><span id="review-progress-label"></span></div>
          <div class="review-actions">
            <button type="button" class="btn-outline-sm" id="review-skip">Skip guide</button>
            <button type="button" class="btn-primary" id="review-next">Next step →</button>
          </div>
        </div>
      </div>
      <div id="review-banner" class="review-banner hidden">
        <span>📋 Meta reviewer? Open the <button type="button" id="review-open-banner" class="btn-link">permission walkthrough</button></span>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    document.getElementById('review-close')?.addEventListener('click', closeGuide);
    document.getElementById('review-skip')?.addEventListener('click', closeGuide);
    document.getElementById('review-next')?.addEventListener('click', nextStep);
    document.getElementById('review-open-banner')?.addEventListener('click', () => openGuide(0));
  }

  function bindCopyButtons() {
    document.querySelectorAll('[data-copy-perm]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const perm = btn.dataset.copyPerm;
        const text = getPermissionAnswers()[perm] || '';
        navigator.clipboard?.writeText(text);
        if (typeof toast === 'function') toast('Copied: ' + perm);
      });
    });
  }

  function showBanner() {
    document.getElementById('review-banner')?.classList.remove('hidden');
  }

  function openGuide(start = 0) {
    stepIndex = start;
    document.getElementById('review-modal')?.classList.remove('hidden');
    renderStep();
  }

  function closeGuide() {
    document.getElementById('review-modal')?.classList.add('hidden');
    localStorage.setItem('pagechat_review_seen', '1');
  }

  function navigateToStepView(view) {
    if (!view) return;
    const portalViews = ['inbox', 'engagement', 'utility', 'settings', 'dashboard'];
    if (portalViews.includes(view) && !document.getElementById('view-' + view)) {
      window.open(`portal.html?view=${view}`, '_blank');
      return;
    }
    if (typeof switchView === 'function') switchView(view);
  }

  function nextStep() {
    const step = STEPS[stepIndex];
    navigateToStepView(step.view);
    stepIndex++;
    if (stepIndex >= STEPS.length) {
      closeGuide();
      if (typeof toast === 'function') toast('All 6 permissions demonstrated. Submit App Review in Meta Developer portal.');
      return;
    }
    renderStep();
  }

  function renderStep() {
    const step = STEPS[stepIndex];
    document.getElementById('review-step-title').textContent = step.title;
    document.getElementById('review-step-text').textContent = step.text;
    document.getElementById('review-progress-label').textContent =
      `Step ${stepIndex + 1} of ${STEPS.length}`;
    const btn = document.getElementById('review-next');
    if (btn) btn.textContent = stepIndex === STEPS.length - 1 ? 'Finish' : 'Next step →';
    if (step.view) navigateToStepView(step.view);
  }

  function onLoginComplete() {
    markCheck('check-profile');
    markCheck('check-pages');
    if (document.getElementById('admin-shell')) showBanner();
    if (document.getElementById('admin-shell') && !localStorage.getItem('pagechat_review_seen')) {
      setTimeout(() => openGuide(0), 600);
    }
  }

  function markPermissionUsed(perm) {
    const map = {
      public_profile: 'check-profile',
      pages_show_list: 'check-pages',
      pages_messaging: 'check-messaging',
      pages_read_engagement: 'check-engagement',
      pages_utility_messaging: 'check-utility',
      pages_manage_metadata: 'check-metadata',
    };
    if (map[perm]) markCheck(map[perm]);
    if (typeof Readiness !== 'undefined') Readiness.markDemo(perm);
  }

  function markCheck(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.add('done');
      el.querySelector('.check-icon')?.replaceWith(document.createTextNode('✓'));
    }
    const card = document.getElementById(`${id}-card`);
    if (card) {
      card.classList.add('done');
      const icon = card.querySelector('.check-icon');
      if (icon) icon.textContent = '✓';
    }
  }

  function getSubmissionPack(origin) {
    return {
      appUrl: origin + '/portal.html',
      landing: origin + '/',
      admin: origin + '/admin.html',
      privacy: origin + '/privacy.html',
      terms: origin + '/terms.html',
      dataDeletion: origin + '/data-deletion.html',
      webhook: origin + '/webhook',
      testInstructions: buildTestInstructions(origin),
      permissions: getPermissionAnswers(),
    };
  }

  const TEST_CREDS_LS = {
    email: 'wayfair_test_email',
    password: 'wayfair_test_password',
    pageName: 'wayfair_test_page',
  };

  function getTestCreds() {
    return {
      email: localStorage.getItem(TEST_CREDS_LS.email) || '',
      password: localStorage.getItem(TEST_CREDS_LS.password) || '',
      pageName: localStorage.getItem(TEST_CREDS_LS.pageName) || '',
    };
  }

  function saveTestCred(field, value) {
    const key = TEST_CREDS_LS[field];
    if (key) localStorage.setItem(key, value);
  }

  function buildTestInstructions(origin) {
    const creds = getTestCreds();
    const email = creds.email || '[YOUR_TEST_USER_EMAIL]';
    const password = creds.password || '[YOUR_TEST_USER_PASSWORD]';
    const pageName = creds.pageName || '[YOUR_TEST_PAGE_NAME]';
    const contact = (typeof APP_BRAND !== 'undefined' && APP_BRAND.contactEmail) || 'alirunyonali@gmail.com';

    return `${appName().toUpperCase()} — META APP REVIEW TEST INSTRUCTIONS
================================================

APP URL (User Portal): ${origin}/portal.html
LOGIN URL: ${origin}/portal.html
FACEBOOK LOGIN: Yes

LOGIN:
1. Open the user portal URL above.
2. Click "Continue with Facebook".
3. Log in with the test user credentials provided below.
4. Accept ALL requested permissions when prompted.

TEST USER CREDENTIALS:
Email: ${email}
Password: ${password}

TEST PAGE NAME: ${pageName}

FEATURE TESTS (match screencast):

1) public_profile — user name + photo in bottom-left sidebar.
2) pages_show_list — "Active Page" dropdown in sidebar.
3) pages_messaging — Inbox → open conversation → reply (test user must message Page first).
4) pages_read_engagement — Engagement → posts with likes, comments, shares.
5) pages_utility_messaging — Notifications → select customer → send order update.
6) pages_manage_metadata — Settings → Subscribe Page to webhooks.

WEBHOOK CALLBACK: ${origin}/webhook
Privacy Policy: ${origin}/privacy.html
Data Deletion: ${origin}/data-deletion.html
Contact: ${contact}`;
  }

  function buildReviewerInstructions(origin) {
    const o = origin || (typeof location !== 'undefined' ? location.origin : '');
    const n = appName();
    const creds = getTestCreds();
    const email = creds.email || '[YOUR_TEST_USER_EMAIL]';
    const password = creds.password || '[YOUR_TEST_USER_PASSWORD]';
    const pageName = creds.pageName || '[YOUR_TEST_PAGE_NAME]';
    const contact = (typeof APP_BRAND !== 'undefined' && APP_BRAND.contactEmail) || 'alirunyonali@gmail.com';

    return `${n.toUpperCase()} — Facebook Page Messenger Manager
==========================================

APP OVERVIEW
${n} is a web-based dashboard for Facebook Page managers. It helps businesses read and reply to Messenger conversations, view post engagement metrics, send transactional utility notifications, and subscribe Pages to webhooks for real-time inbox updates.

FACEBOOK LOGIN — CONFIRMATION
Yes, Facebook Login is fully integrated and is the ONLY authentication method. We use the Facebook JavaScript SDK (OAuth) with the following Login permissions:
• public_profile
• pages_show_list
• pages_messaging
• pages_read_engagement
• pages_utility_messaging
• pages_manage_metadata

We do NOT use email, user_friends, user_gender, user_birthday, or any other Meta user permissions beyond those listed above.

HOW TO ACCESS THE APP
1. Open: ${o}/portal.html
2. Click "Continue with Facebook".
3. Log in with the Facebook test user credentials provided in the Access Codes section below.
4. When prompted, click "Allow" / accept ALL requested permissions.

NAVIGATION & FEATURE TESTING

After login, you will see the main dashboard with a left sidebar:

A) public_profile — Confirm name and profile photo at bottom-left of sidebar.
B) pages_show_list — Open "Active Page" dropdown; select "${pageName}".
C) pages_messaging — Click Inbox. Prerequisite: test user must have messaged the Page on Messenger. Open conversation → reply → Send.
D) pages_read_engagement — Click Engagement; view posts with like, comment, and share counts.
E) pages_utility_messaging — Click Notifications; select customer, choose "Order / shipping update", send notification.
F) pages_manage_metadata — Click Settings → Subscribe Page to webhooks → confirm subscribed status.

SUPPORTING URLS
• Landing: ${o}/
• Privacy: ${o}/privacy.html
• Terms: ${o}/terms.html
• Data deletion: ${o}/data-deletion.html
• Webhook: ${o}/webhook

TEST USER: ${email} / ${password} | Page: ${pageName}
CONTACT: ${contact}`;
  }

  function buildAccessCodes() {
    const creds = getTestCreds();
    const email = creds.email || '[YOUR_TEST_USER_EMAIL]';
    const password = creds.password || '[YOUR_TEST_USER_PASSWORD]';
    const pageName = creds.pageName || '[YOUR_TEST_PAGE_NAME]';

    return `FACEBOOK TEST USER (App Role: Administrator or Tester)
Email: ${email}
Password: ${password}

TEST FACEBOOK PAGE
Page name: ${pageName}
(The test user must be an admin of this Page)

INBOX PREREQUISITE
Before testing pages_messaging and pages_utility_messaging:
1. Log into Facebook/Messenger as the test user.
2. Send a message to the test Page "${pageName}" on Messenger.
3. Then log into the app and open Inbox.

No payment, membership, or access code is required.`;
  }

  function getMetaSubmissionFields(origin) {
    const o = origin || (typeof location !== 'undefined' ? location.origin : '');
    return {
      siteUrl: `${o}/`,
      loginUrl: `${o}/portal.html`,
      instructions: buildReviewerInstructions(o),
      accessCodes: buildAccessCodes(),
      giftCodes:
        'Not applicable. This is a free web application accessed via browser. No app store download, payment, subscription, or gift codes are required.',
      geo: 'Not applicable. The app is accessible worldwide via HTTPS. There are no geo-blocking or geo-fencing restrictions.',
      facebookLogin: 'Yes',
    };
  }

  function buildFullSubmissionSummary(origin) {
    const f = getMetaSubmissionFields(origin);
    const n = appName();
    const o = origin || location.origin;
    return `${n} — META APP REVIEW SUBMISSION
================================

Site URL:
${f.siteUrl}

Login URL:
${f.loginUrl}

instructions-web-2:
${f.instructions}

accesscode-web-1:
${f.accessCodes}

accesscode-web-2:
${f.giftCodes}

geo-web-5:
${f.geo}

fblogin-web-1:
${f.facebookLogin}

documents-web-1 (optional screencast):
${o}/portal.html?review=1&view=engagement&guide=1`;
  }

  function renderMetaSubmission(origin) {
    const root = document.getElementById('meta-submission-root');
    if (!root) return;

    const o = origin || location.origin;
    const saved = getTestCreds();
    const fields = getMetaSubmissionFields(o);

    const FORM_FIELDS = [
      { id: 'site-url', metaId: 'Site URL', value: fields.siteUrl },
      { id: 'login-url', metaId: 'Login URL', value: fields.loginUrl },
      { id: 'instructions-web-2', metaId: 'instructions-web-2 — Reviewer instructions', value: fields.instructions, large: true },
      { id: 'accesscode-web-1', metaId: 'accesscode-web-1 — Test credentials', value: fields.accessCodes, large: true },
      { id: 'accesscode-web-2', metaId: 'accesscode-web-2 — Gift codes (optional)', value: fields.giftCodes },
      { id: 'geo-web-5', metaId: 'geo-web-5 — Geo restrictions (optional)', value: fields.geo },
      { id: 'fblogin-web-1', metaId: 'fblogin-web-1 — Facebook Login integrated?', value: fields.facebookLogin, pill: true },
    ];

    root.innerHTML = `
      <div class="settings-block meta-submission-intro">
        <h3>Meta form → Reviewer instructions</h3>
        <p class="meta-muted">Paste into <strong>Meta Developers → App Review</strong>. Fill test credentials below — answers update automatically.</p>
      </div>
      <div class="settings-block meta-submission-creds">
        <h3>Test credentials (saved in browser)</h3>
        <div class="creds-row"><label for="meta-test-email">Test user email</label><input type="email" id="meta-test-email" value="${escapeAttr(saved.email)}" placeholder="testuser@meta.com" /></div>
        <div class="creds-row"><label for="meta-test-password">Test user password</label><input type="password" id="meta-test-password" value="${escapeAttr(saved.password)}" placeholder="From Meta test user" /></div>
        <div class="creds-row"><label for="meta-test-page">Test Page name</label><input type="text" id="meta-test-page" value="${escapeAttr(saved.pageName)}" placeholder="e.g. MKMG GR" /></div>
        <p class="meta-muted">Meta → App Roles → add test user as Administrator/Tester. Test user must message the Page on Messenger before inbox testing.</p>
      </div>
      ${FORM_FIELDS.map((f) => renderSubmissionField(f)).join('')}
      <div class="settings-block meta-submission-summary">
        <h3>Copy everything at once</h3>
        <pre class="code-block" id="meta-submission-summary"></pre>
        <button type="button" id="btn-copy-meta-submission-all" class="btn-primary">Copy full submission pack</button>
      </div>`;

    bindMetaSubmissionInputs(o);
    updateSubmissionSummary(o);
    syncOverviewTestCreds(saved);

    document.getElementById('btn-copy-meta-submission-all')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(buildFullSubmissionSummary(o));
      if (typeof toast === 'function') toast('Full submission pack copied');
    });

    root.querySelectorAll('[data-copy-submission]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-copy-submission');
        const current = getMetaSubmissionFields(o);
        const map = {
          'site-url': current.siteUrl,
          'login-url': current.loginUrl,
          'instructions-web-2': current.instructions,
          'accesscode-web-1': current.accessCodes,
          'accesscode-web-2': current.giftCodes,
          'geo-web-5': current.geo,
          'fblogin-web-1': current.facebookLogin,
        };
        navigator.clipboard?.writeText(map[key] || '');
        if (typeof toast === 'function') toast('Copied');
      });
    });
  }

  function renderSubmissionField(f) {
    const label = f.metaId.includes(' — ') ? f.metaId.split(' — ')[1] : f.metaId;
    const metaId = f.metaId.split(' — ')[0];
    const body = f.pill
      ? `<p class="dh-answer-pill">${esc(f.value)}</p>`
      : f.large
        ? `<textarea class="meta-submission-textarea" readonly rows="12">${esc(f.value)}</textarea>`
        : `<pre class="code-block meta-submission-value">${esc(f.value)}</pre>`;

    return `
      <article class="data-handling-card meta-submission-card" id="submission-${f.id}">
        <span class="data-handling-id">${esc(metaId)}</span>
        <h4>${esc(label)}</h4>
        ${body}
        <button type="button" class="btn-outline-sm btn-sm" data-copy-submission="${f.id}">Copy</button>
      </article>`;
  }

  function bindMetaSubmissionInputs(origin) {
    bindTestCredInputs(origin);
  }

  function bindTestCredInputs(origin) {
    [
      ['meta-test-email', 'email'],
      ['meta-test-password', 'password'],
      ['meta-test-page', 'pageName'],
      ['test-email', 'email'],
      ['test-password', 'password'],
      ['test-page-name', 'pageName'],
    ].forEach(([id, field]) => {
      const el = document.getElementById(id);
      if (!el || el.dataset.credBound === '1') return;
      el.dataset.credBound = '1';
      el.addEventListener('input', (e) => {
        saveTestCred(field, e.target.value);
        syncAllTestCredInputs(field, e.target.value);
        refreshSubmissionFields(origin);
      });
    });
  }

  function syncAllTestCredInputs(field, value) {
    const ids = {
      email: ['meta-test-email', 'test-email'],
      password: ['meta-test-password', 'test-password'],
      pageName: ['meta-test-page', 'test-page-name'],
    };
    (ids[field] || []).forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.value !== value) el.value = value;
    });
  }

  function syncOverviewTestCreds(saved) {
    syncAllTestCredInputs('email', saved.email);
    syncAllTestCredInputs('password', saved.password);
    syncAllTestCredInputs('pageName', saved.pageName);
  }

  function refreshSubmissionFields(origin) {
    const fields = getMetaSubmissionFields(origin);
    const map = {
      'site-url': fields.siteUrl,
      'login-url': fields.loginUrl,
      'instructions-web-2': fields.instructions,
      'accesscode-web-1': fields.accessCodes,
      'accesscode-web-2': fields.giftCodes,
      'geo-web-5': fields.geo,
    };
    Object.entries(map).forEach(([id, text]) => {
      const card = document.getElementById(`submission-${id}`);
      const ta = card?.querySelector('textarea');
      const pre = card?.querySelector('pre.meta-submission-value');
      if (ta) ta.value = text;
      if (pre) pre.textContent = text;
    });
    const notes = document.getElementById('review-notes');
    if (notes) notes.value = buildTestInstructions(origin);
    updateSubmissionSummary(origin);
  }

  function updateSubmissionSummary(origin) {
    const el = document.getElementById('meta-submission-summary');
    if (el) el.textContent = buildFullSubmissionSummary(origin);
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function renderSettingsBlocks(origin) {
    const pack = getSubmissionPack(origin);
    const permsHtml = Object.entries(pack.permissions)
      .map(
        ([perm, answer]) => `
        <div class="perm-answer-block">
          <div class="perm-answer-head">
            <code>${perm}</code>
            <button type="button" class="btn-outline-sm" data-copy-perm="${perm}">Copy answer</button>
          </div>
          <p class="perm-answer-text">${answer}</p>
        </div>`
      )
      .join('');

    const el = document.getElementById('permission-answers');
    if (el) el.innerHTML = permsHtml;
    bindCopyButtons();

    const notes = document.getElementById('review-notes');
    if (notes) notes.value = pack.testInstructions;

    const urls = document.getElementById('meta-urls');
    if (urls) {
      urls.innerHTML = `
        <li><strong>User Portal:</strong> ${pack.appUrl}</li>
        <li><strong>Landing:</strong> ${pack.landing}</li>
        <li><strong>Admin:</strong> ${pack.admin}</li>
        <li><strong>Privacy:</strong> ${pack.privacy}</li>
        <li><strong>Data deletion:</strong> ${pack.dataDeletion}</li>
        <li><strong>Terms:</strong> ${pack.terms}</li>
        <li><strong>Webhook:</strong> ${pack.webhook}</li>
        <li><strong>Screencast:</strong> ${pack.appUrl}?review=1&amp;view=engagement&amp;guide=1</li>`;
    }

    renderMetaSubmission(origin);
  }

  function getVideoScript(origin) {
    const base = origin || (typeof location !== 'undefined' ? location.origin : '');
    const n = appName();
    return `VIDEO SCRIPT (read while recording — English, 2–4 minutes)

1. Open ${base}/portal.html
   "${n} is a dashboard for Facebook Page managers — Messenger inbox and post engagement in one place."

2. Click Continue with Facebook
   Log in and tap Allow for ALL permissions, including pages_read_engagement.

3. Sidebar (bottom-left)
   "My profile name and photo confirm who is signed in." (public_profile)

4. Active Page dropdown
   "I select which Facebook Page to manage." (pages_show_list)

5. Inbox tab
   Open a conversation, scroll messages, type a reply, click Send.
   (pages_messaging — customer must have messaged the Page first)

6. Engagement tab
   "Posts from my Page load here. Each row shows Likes, Comments, and Shares — read using pages_read_engagement."
   Point to the stat cards and post metric columns.

7. Notifications tab
   Select a customer, choose Order/shipping update, send message.
   (pages_utility_messaging)

8. Settings tab
   Click Subscribe Page to webhooks — green confirmation.
   (pages_manage_metadata)

9. "Thank you for reviewing ${n}."`;
  }

  return {
    init,
    onLoginComplete,
    markPermissionUsed,
    openGuide,
    renderSettingsBlocks,
    renderMetaSubmission,
    getSubmissionPack,
    getMetaSubmissionFields,
    buildFullSubmissionSummary,
    getVideoScript,
    getPermissionAnswers,
    getTestCreds,
    bindTestCredInputs,
    PERMISSION_ANSWERS: getPermissionAnswers(),
  };
})();
