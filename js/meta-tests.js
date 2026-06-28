/**
 * Run API calls so Meta App Review "Testing" turns green
 */
const MetaTests = (function () {
  'use strict';

  async function runAll(page, pagesList) {
    const log = document.getElementById('meta-test-log');
    const results = [];

    function line(msg, ok) {
      results.push({ msg, ok });
      if (log) {
        log.innerHTML += `<div class="${ok ? 'ok' : 'err'}">${msg}</div>`;
        log.scrollTop = log.scrollHeight;
      }
    }

    if (log) log.innerHTML = '<strong>Running Meta API tests…</strong><br/>';

    try {
      await GraphAPI.getMe();
      line('✓ public_profile — GET /me', true);
      AppReview.markPermissionUsed('public_profile');
    } catch (e) {
      line('✗ public_profile — ' + e.message, false);
    }

    try {
      const pagesRes = await testPagesShowList();
      line(`✓ pages_show_list — GET /me/accounts (${pagesRes.count} page(s))`, true);
      AppReview.markPermissionUsed('pages_show_list');
      Readiness.markDemo('pages_show_list');
    } catch (e) {
      line('✗ pages_show_list — ' + e.message, false);
    }

    if (page) {
      let convs = [];
      try {
        convs = await GraphAPI.getConversations(page.id, page.access_token);
        line('✓ pages_messaging — GET conversations', true);
      } catch (e) {
        line('✗ pages_messaging — ' + e.message, false);
      }

      try {
        await GraphAPI.getPagePosts(page.id, page.access_token, 3);
        line('✓ pages_read_engagement — GET posts', true);
      } catch (e) {
        line('✗ pages_read_engagement — ' + e.message, false);
      }

      try {
        await PageMeta.getSubscription(page.id, page.access_token);
        line('✓ pages_manage_metadata — GET subscribed_apps', true);
      } catch (e) {
        line('✗ pages_manage_metadata — ' + e.message, false);
      }

      convs = convs.length ? convs : await GraphAPI.getConversations(page.id, page.access_token).catch(() => []);
      const cust = convs[0]
        ? GraphAPI.extractCustomerFromConversation(convs[0], page.id)
        : null;
      if (cust?.id) {
        try {
          await Utility.prepare(page);
          await Utility.send(
            page,
            cust.id,
            'PageChat Hub — Meta API test (utility message).',
            'POST_PURCHASE_UPDATE'
          );
          line('✓ pages_utility_messaging — POST utility template message', true);
          AppReview.markPermissionUsed('pages_utility_messaging');
          Readiness.markDemo('pages_utility_messaging');
        } catch (e) {
          line('✗ pages_utility_messaging — ' + e.message, false);
        }
      } else {
        line('⚠ pages_utility_messaging — no customer in inbox. Ask someone to message your Page first.', false);
      }
    }

    line('<br/><strong>Done.</strong> Wait 5–30 min, refresh Meta → App Review → Testing.', true);
    if (typeof toast === 'function') toast('API tests finished — refresh Meta dashboard');

    return results;
  }

  /** Dedicated test — Meta counts user-token /me/accounts for pages_show_list */
  async function testPagesShowList() {
    const res = await GraphAPI.userGet('/me/accounts?fields=id,name&limit=50');
    const data = res.data || [];
    return { count: data.length, data };
  }

  async function runPagesShowListOnly() {
    const log = document.getElementById('meta-test-log');
    if (log) log.innerHTML = '';
    try {
      const r = await testPagesShowList();
      if (log) {
        log.innerHTML = `<div class="ok">✓ pages_show_list OK — ${r.count} Page(s) returned.</div>
          <div class="ok">Meta may take 5–30 min to turn green. Refresh App Review → Testing.</div>`;
      }
      AppReview.markPermissionUsed('pages_show_list');
      if (typeof toast === 'function') toast(`${r.count} page(s) loaded`);
      return r;
    } catch (e) {
      if (log) log.innerHTML = `<div class="err">✗ ${e.message}</div>`;
      if (typeof toast === 'function') toast(e.message, true);
      throw e;
    }
  }

  return { runAll, runPagesShowListOnly, testPagesShowList };
})();
