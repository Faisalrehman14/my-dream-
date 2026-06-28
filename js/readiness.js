/**
 * Submission Readiness — reduce Meta App Review rejection risk
 */
const Readiness = (function () {
  'use strict';

  const LS = {
    messaging: 'pagechat_done_messaging',
    utility: 'pagechat_done_utility',
    metadata: 'pagechat_done_metadata',
    testEmail: 'pagechat_test_email',
    testPass: 'pagechat_test_pass',
    testPage: 'pagechat_test_page',
    metaPrivacy: 'pagechat_meta_privacy',
    metaTerms: 'pagechat_meta_terms',
    metaDeletion: 'pagechat_meta_deletion',
    metaDeauth: 'pagechat_meta_deauth',
    metaDeletionCb: 'pagechat_meta_deletion_cb',
    metaOAuth: 'pagechat_meta_oauth',
    metaScreencast: 'pagechat_meta_screencast',
    metaTester: 'pagechat_meta_tester',
    metaInbox: 'pagechat_meta_inbox',
  };

  let state = {
    hasAppId: false,
    isHttps: false,
    healthOk: false,
    appSecretSet: false,
    complianceReady: false,
    complianceEndpointsOk: false,
    loggedIn: false,
    hasPages: false,
    hasConversations: false,
    hasPosts: false,
    webhookSubscribed: false,
    grantedScopes: [],
    demos: {},
    metaManual: {},
  };

  function init() {
    bindMetaCheckboxes();
    bindTestCredentials();
    restoreDemoFlags();
    verifyMetaUrls();
  }

  /** Auto-tick URL checkboxes if pages load on Railway */
  async function verifyMetaUrls() {
    const origin = location.origin;
    if (!origin.startsWith('http')) return;
    const checks = [
      ['meta-chk-privacy', 'privacy'],
      ['meta-chk-terms', 'terms'],
      ['meta-chk-deletion', 'deletion'],
      ['meta-chk-deauth', 'deauth'],
      ['meta-chk-deletion-cb', 'deletionCb'],
      ['meta-chk-oauth', 'oauth'],
    ];
    for (const [id, field] of checks) {
      try {
        let path;
        if (field === 'oauth') path = '/';
        else if (field === 'terms') path = '/terms.html';
        else if (field === 'privacy') path = '/privacy.html';
        else if (field === 'deletion') path = '/data-deletion.html';
        else if (field === 'deauth') path = '/api/deauthorize';
        else if (field === 'deletionCb') path = '/api/data-deletion';
        else path = '/';
        const res = await fetch(origin + path, { method: field === 'deauth' || field === 'deletionCb' ? 'GET' : 'HEAD' });
        if (res.ok) {
          const el = document.getElementById(id);
          if (el) {
            el.checked = true;
            const lsMap = {
              privacy: LS.metaPrivacy,
              terms: LS.metaTerms,
              deletion: LS.metaDeletion,
              deauth: LS.metaDeauth,
              deletionCb: LS.metaDeletionCb,
              oauth: LS.metaOAuth,
            };
            localStorage.setItem(lsMap[field], '1');
            state.metaManual[field] = true;
          }
        }
      } catch { /* ignore */ }
    }
    render();
  }

  function confirmMetaSetupDone() {
    [
      'meta-chk-privacy',
      'meta-chk-terms',
      'meta-chk-deletion',
      'meta-chk-deauth',
      'meta-chk-deletion-cb',
      'meta-chk-oauth',
      'meta-chk-tester',
      'meta-chk-inbox',
      'meta-chk-screencast',
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.checked = true;
      const map = {
        'meta-chk-privacy': ['privacy', LS.metaPrivacy],
        'meta-chk-terms': ['terms', LS.metaTerms],
        'meta-chk-deletion': ['deletion', LS.metaDeletion],
        'meta-chk-deauth': ['deauth', LS.metaDeauth],
        'meta-chk-deletion-cb': ['deletionCb', LS.metaDeletionCb],
        'meta-chk-oauth': ['oauth', LS.metaOAuth],
        'meta-chk-tester': ['tester', LS.metaTester],
        'meta-chk-inbox': ['inbox', LS.metaInbox],
        'meta-chk-screencast': ['screencast', LS.metaScreencast],
      };
      const m = map[id];
      if (m) {
        state.metaManual[m[0]] = true;
        localStorage.setItem(m[1], '1');
      }
    });
    render();
    if (typeof toast === 'function') toast('Checklist updated');
  }

  function restoreDemoFlags() {
    state.demos = {
      profile: true,
      pages: true,
      messaging: localStorage.getItem(LS.messaging) === '1',
      engagement: localStorage.getItem('pagechat_done_engagement') === '1',
      utility: localStorage.getItem(LS.utility) === '1',
      metadata: localStorage.getItem(LS.metadata) === '1',
    };
  }

  function markDemo(key) {
    const map = {
      pages_messaging: ['messaging', LS.messaging],
      pages_read_engagement: ['engagement', 'pagechat_done_engagement'],
      pages_utility_messaging: ['utility', LS.utility],
      pages_manage_metadata: ['metadata', LS.metadata],
    };
    const entry = map[key];
    if (entry) {
      state.demos[entry[0]] = true;
      localStorage.setItem(entry[1], '1');
    }
    render();
  }

  function setConversations(ok) {
    state.hasConversations = ok;
    if (ok) {
      const el = document.getElementById('meta-chk-inbox');
      if (el) {
        el.checked = true;
        localStorage.setItem(LS.metaInbox, '1');
        state.metaManual.inbox = true;
      }
    }
    render();
  }

  function setPosts(ok) {
    state.hasPosts = ok;
    render();
  }

  function setWebhook(ok) {
    state.webhookSubscribed = ok;
    if (ok) markDemo('pages_manage_metadata');
    render();
  }

  function setScopes(scopesStr) {
    state.grantedScopes = (scopesStr || '').split(',').map((s) => s.trim()).filter(Boolean);
    render();
  }

  async function runTechnicalChecks() {
    state.hasAppId = Boolean(FB_CONFIG.appId);
    state.isHttps = location.protocol === 'https:';
    try {
      const res = await fetch('/health');
      const data = await res.json();
      state.healthOk = data.ok === true;
      state.appSecretSet = data.appSecretSet === true;
      state.complianceReady = data.complianceReady === true;
    } catch {
      state.healthOk = false;
      state.appSecretSet = false;
      state.complianceReady = false;
    }
    try {
      const deauth = await fetch('/api/deauthorize');
      const del = await fetch('/api/data-deletion');
      state.complianceEndpointsOk = deauth.ok && del.ok;
    } catch {
      state.complianceEndpointsOk = false;
    }
    render();
  }

  function requiredScopes() {
    return FB_CONFIG.scopes.split(',');
  }

  function missingScopes() {
    const missing = requiredScopes().filter((s) => !state.grantedScopes.includes(s));
    if (!state.loggedIn) return missing;
    // public_profile is default with Facebook Login — name/photo visible = granted
    if (missing.length === 1 && missing[0] === 'public_profile') return [];
    if (state.hasPages && missing.includes('pages_show_list') && missing.length === 1) return [];
    return missing;
  }

  async function refreshGrantedFromApi() {
    try {
      const perms = await GraphAPI.userGet('/me/permissions');
      const granted = (perms.data || [])
        .filter((p) => p.status === 'granted')
        .map((p) => p.permission);
      if (state.loggedIn) {
        try {
          await GraphAPI.getMe();
          if (!granted.includes('public_profile')) granted.push('public_profile');
        } catch { /* me failed */ }
      }
      if (state.hasPages && !granted.includes('pages_show_list')) {
        granted.push('pages_show_list');
      }
      setScopes(granted.join(','));
    } catch {
      renderScopesPanel();
    }
  }

  function getBlockers() {
    const b = [];
    if (!state.hasAppId) b.push({ level: 'critical', text: 'FACEBOOK_APP_ID not set on server (Railway Variables).' });
    if (!state.appSecretSet) {
      b.push({
        level: 'critical',
        text: 'APP_SECRET not set on Railway — required for webhooks, deauth callback, and data deletion callback.',
      });
    }
    if (!state.complianceEndpointsOk) {
      b.push({ level: 'critical', text: 'Compliance endpoints /api/deauthorize and /api/data-deletion not reachable.' });
    }
    if (!state.isHttps) b.push({ level: 'critical', text: 'Use HTTPS URL in Meta submission (Railway), not localhost.' });
    if (!state.healthOk) b.push({ level: 'warn', text: 'Server /health check failed — redeploy Railway.' });
    if (!state.loggedIn) b.push({ level: 'critical', text: 'Log in with Facebook first.' });
    if (missingScopes().length) {
      b.push({
        level: 'critical',
        text: 'Missing permissions after login: ' + missingScopes().join(', ') + ' — log out and Allow all.',
      });
    }
    if (!state.hasPages) b.push({ level: 'critical', text: 'No Facebook Page on account — create/connect a Page.' });
    if (!state.hasConversations) {
      b.push({
        level: 'critical',
        text: 'Inbox is empty — test user MUST message your Page on Messenger before review.',
      });
    }
    if (!state.demos.messaging) {
      b.push({ level: 'critical', text: 'Send at least one reply from Inbox (pages_messaging proof).' });
    }
    if (!state.hasPosts) {
      b.push({ level: 'warn', text: 'No Page posts — create 1 post on Facebook for Engagement demo.' });
    }
    if (!state.demos.engagement) {
      b.push({ level: 'warn', text: 'Open Engagement tab and load posts.' });
    }
    if (!state.demos.utility) {
      b.push({ level: 'warn', text: 'Send one Notification (pages_utility_messaging proof).' });
    }
    if (!state.webhookSubscribed) {
      b.push({ level: 'critical', text: 'Settings → Subscribe Page to webhooks (pages_manage_metadata).' });
    }
    if (!state.metaManual.privacy) b.push({ level: 'critical', text: 'Meta Basic: Privacy Policy URL not confirmed.' });
    if (!state.metaManual.terms) b.push({ level: 'critical', text: 'Meta Basic: Terms of Service URL not confirmed.' });
    if (!state.metaManual.deletion) b.push({ level: 'critical', text: 'Meta Basic: User data deletion instructions URL not confirmed.' });
    if (!state.metaManual.deauth) {
      b.push({
        level: 'critical',
        text: 'Meta Basic: Deauthorize callback URL → paste /api/deauthorize (not deauth.html).',
      });
    }
    if (!state.metaManual.deletionCb) {
      b.push({
        level: 'critical',
        text: 'Meta Basic: Data Deletion Request URL → paste /api/data-deletion (server callback).',
      });
    }
    if (!state.metaManual.oauth) b.push({ level: 'critical', text: 'Facebook Login: OAuth redirect URIs not confirmed.' });
    if (!state.metaManual.tester) {
      b.push({ level: 'critical', text: 'Add Facebook test user in Meta → App Roles (Administrator or Tester).' });
    }
    if (!state.metaManual.inbox && !state.hasConversations) {
      b.push({ level: 'critical', text: 'Test user must send a Messenger message to your Page before submit.' });
    }
    if (!getTestEmail()) b.push({ level: 'critical', text: 'Fill test user email for Meta submission (Dashboard or App Review tab).' });
    if (!getTestPassword()) b.push({ level: 'critical', text: 'Fill test user password for Meta submission.' });
    if (!state.metaManual.screencast) b.push({ level: 'critical', text: 'Record & upload screencast showing all 6 permissions in English.' });
    return b;
  }

  function getTestPassword() {
    return (
      document.getElementById('test-password')?.value ||
      localStorage.getItem(LS.testPass) ||
      (typeof AppReview !== 'undefined' && AppReview.getTestCreds?.().password) ||
      ''
    ).trim();
  }

  function getScore() {
    const checks = [
      state.hasAppId,
      state.appSecretSet,
      state.complianceEndpointsOk,
      state.isHttps,
      state.healthOk,
      state.loggedIn,
      state.hasPages,
      state.hasConversations,
      state.demos.messaging,
      state.demos.engagement || state.hasPosts,
      state.demos.utility,
      state.webhookSubscribed,
      missingScopes().length === 0,
      state.metaManual.privacy,
      state.metaManual.terms,
      state.metaManual.deletion,
      state.metaManual.deauth,
      state.metaManual.deletionCb,
      state.metaManual.oauth,
      state.metaManual.tester,
      state.metaManual.inbox || state.hasConversations,
      state.metaManual.screencast,
      Boolean(getTestEmail()),
      Boolean(getTestPassword()),
    ];
    const pass = checks.filter(Boolean).length;
    return Math.round((pass / checks.length) * 100);
  }

  function canSubmit() {
    const critical = getBlockers().filter((x) => x.level === 'critical');
    return critical.length === 0 && getScore() >= 95;
  }

  async function onLogin(pagesList, scopesStr) {
    state.loggedIn = true;
    state.hasPages = pagesList.length > 0;
    setScopes(scopesStr);
    await refreshGrantedFromApi();
    runTechnicalChecks();
    renderScopesPanel();
    render();
  }

  function renderScopesPanel() {
    const el = document.getElementById('granted-scopes-panel');
    if (!el) return;
    const required = FB_CONFIG.scopes.split(',');
    const missing = missingScopes();
    el.classList.remove('hidden');
    if (!missing.length) {
      el.innerHTML =
        '<p class="scopes-ok">✓ All permissions granted on your login token. If Meta Testing is still grey, wait 30 min and refresh — call count ≠ Completed.</p>';
      return;
    }
    el.innerHTML = `
      <p class="scopes-warn"><strong>⚠️ Meta Testing will not turn green</strong> — these permissions are not granted on your login token:</p>
      <ul>${missing.map((p) => `<li><code>${p}</code></li>`).join('')}</ul>
      <p>Fix: Sign out → Connect with Facebook → <strong>Allow all</strong> permissions on the popup.</p>`;
  }

  function render() {
    const scoreEl = document.getElementById('readiness-score');
    const blockersEl = document.getElementById('readiness-blockers');
    const submitEl = document.getElementById('submit-verdict');
    if (!scoreEl) return;

    const score = getScore();
    scoreEl.textContent = score + '%';
    scoreEl.className = 'readiness-score ' + (score >= 95 ? 'good' : score >= 70 ? 'mid' : 'bad');

    const blockers = getBlockers();
    if (blockersEl) {
      blockersEl.innerHTML = blockers.length
        ? blockers
            .map(
              (b) =>
                `<li class="blocker ${b.level}"><strong>${b.level === 'critical' ? '⛔' : '⚠️'}</strong> ${b.text}</li>`
            )
            .join('')
        : '<li class="blocker ok">✅ No blockers — you can submit App Review.</li>';
    }

    if (submitEl) {
      if (canSubmit()) {
        submitEl.className = 'submit-verdict ready';
        submitEl.innerHTML =
          '<strong>✅ Ready to submit</strong><p>Record screencast matching App Review walkthrough, then submit in Meta portal.</p>';
      } else {
        submitEl.className = 'submit-verdict not-ready';
        submitEl.innerHTML =
          '<strong>⛔ Not ready yet</strong><p>Fix all red blockers above. Submitting early causes rejection.</p>';
      }
    }

    updateReviewNotesWithCredentials();
  }

  function bindMetaCheckboxes() {
    const items = [
      ['meta-chk-privacy', LS.metaPrivacy, 'privacy'],
      ['meta-chk-terms', LS.metaTerms, 'terms'],
      ['meta-chk-deletion', LS.metaDeletion, 'deletion'],
      ['meta-chk-deauth', LS.metaDeauth, 'deauth'],
      ['meta-chk-deletion-cb', LS.metaDeletionCb, 'deletionCb'],
      ['meta-chk-oauth', LS.metaOAuth, 'oauth'],
      ['meta-chk-tester', LS.metaTester, 'tester'],
      ['meta-chk-inbox', LS.metaInbox, 'inbox'],
      ['meta-chk-screencast', LS.metaScreencast, 'screencast'],
    ];
    items.forEach(([id, key, field]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.checked = localStorage.getItem(key) === '1';
      state.metaManual[field] = el.checked;
      el.addEventListener('change', () => {
        localStorage.setItem(key, el.checked ? '1' : '0');
        state.metaManual[field] = el.checked;
        render();
      });
    });
  }

  function bindTestCredentials() {
    const email = document.getElementById('test-email');
    const pass = document.getElementById('test-password');
    const page = document.getElementById('test-page-name');
    if (email) {
      email.value = localStorage.getItem(LS.testEmail) || '';
      email.addEventListener('input', () => {
        localStorage.setItem(LS.testEmail, email.value);
        render();
      });
    }
    if (pass) {
      pass.value = localStorage.getItem(LS.testPass) || '';
      pass.addEventListener('input', () => {
        localStorage.setItem(LS.testPass, pass.value);
        render();
      });
    }
    if (page) {
      page.addEventListener('input', () => {
        localStorage.setItem(LS.testPage, page.value);
        updateReviewNotesWithCredentials();
      });
      page.value = localStorage.getItem(LS.testPage) || '';
    }
  }

  function getTestEmail() {
    return (
      document.getElementById('test-email')?.value ||
      localStorage.getItem(LS.testEmail) ||
      (typeof AppReview !== 'undefined' && AppReview.getTestCreds?.().email) ||
      ''
    ).trim();
  }

  function updateReviewNotesWithCredentials() {
    const notes = document.getElementById('review-notes');
    if (!notes || typeof AppReview === 'undefined') return;
    const origin = location.origin;
    const pack = AppReview.getSubmissionPack(origin);
    const email = getTestEmail();
    const pass = document.getElementById('test-password')?.value || '***';
    const pageName = document.getElementById('test-page-name')?.value || '[YOUR PAGE NAME]';
    notes.value = pack.testInstructions
      .replace('Email: _______________________', 'Email: ' + email)
      .replace('Password: _______________________', 'Password: ' + (pass || '***'))
      .replace('TEST PAGE NAME: _______________________', 'TEST PAGE NAME: ' + pageName);
  }

  function getVideoScript() {
    const n = (typeof APP_BRAND !== 'undefined' && APP_BRAND.name) || 'Wayfair';
    return `VIDEO SCRIPT (read while recording — English, 2–4 minutes)
1. Open ${location.origin}/portal.html — "${n} manages Facebook Page Messenger for businesses."
2. Continue with Facebook — Allow ALL permissions.
3. Sidebar: name + photo (public_profile).
4. Page dropdown (pages_show_list).
5. Inbox — open chat, reply, Send (pages_messaging).
6. Engagement — posts, likes, comments (pages_read_engagement).
7. Notifications — send shipping update (pages_utility_messaging).
8. Settings — Subscribe Page to webhooks (pages_manage_metadata).
9. "Thank you."`;
  }

  return {
    init,
    runTechnicalChecks,
    onLogin,
    markDemo,
    setConversations,
    setPosts,
    setWebhook,
    setScopes,
    render,
    canSubmit,
    getVideoScript,
    getBlockers,
    confirmMetaSetupDone,
    verifyMetaUrls,
  };
})();
