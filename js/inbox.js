const Inbox = (function () {
  'use strict';

  const POLL_MS_INBOX = 2500;
  const POLL_MS_OTHER = 8000;

  let conversations = [];
  let activeConv = null;
  let activeCustomer = null;
  let activePageId = null;
  let pollPage = null;
  let pollTimer = null;
  let signalAck = 0;
  let onSelectCallback = null;
  let inboxViewActive = false;
  let refreshing = false;
  let pendingOutgoingEl = null;
  let allSubscribers = [];
  let allSubscribersPageId = null;
  let allCanReply = [];
  let allCanReplyPageId = null;
  let loadingAllSubscribers = false;
  let loadingAllCanReply = false;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isFromPage(message, pageId) {
    return String(message?.from?.id || '') === String(pageId || '');
  }

  function getReadState() {
    try {
      return JSON.parse(localStorage.getItem(FB_CONFIG.storageKeys.readState) || '{}');
    } catch {
      return {};
    }
  }

  function saveReadState(state) {
    localStorage.setItem(FB_CONFIG.storageKeys.readState, JSON.stringify(state));
  }

  function getConvReadAt(pageId, convId) {
    return getReadState()[pageId]?.[convId] || null;
  }

  function isConversationRead(pageId, conv) {
    const readAt = getConvReadAt(pageId, conv.id);
    if (!readAt) return false;
    if (!conv.updated_time) return true;
    return new Date(conv.updated_time) <= new Date(readAt);
  }

  function markConversationRead(pageId, conv) {
    if (!pageId || !conv?.id) return;
    const state = getReadState();
    if (!state[pageId]) state[pageId] = {};
    state[pageId][conv.id] = new Date().toISOString();
    saveReadState(state);
    conv.unread_count = 0;
  }

  function lastMessageFromPage(conv, pageId) {
    const last = conv.messages?.data?.[0];
    return isFromPage(last, pageId);
  }

  function shouldShowUnread(conv, pageId) {
    if (isConversationRead(pageId, conv)) return false;
    if (lastMessageFromPage(conv, pageId)) return false;
    return (conv.unread_count || 0) > 0;
  }

  function countTotalUnread(convs, pageId) {
    return convs.filter((c) => shouldShowUnread(c, pageId)).length;
  }

  async function syncSeenWithMeta(page, customerPsid) {
    if (!customerPsid) return;
    try {
      await GraphAPI.markConversationSeen(page.id, page.access_token, customerPsid);
    } catch {
      /* optional */
    }
  }

  async function fetchInboxSignal(pageId) {
    try {
      const res = await fetch(
        `/api/inbox-signal?pageId=${encodeURIComponent(pageId)}&since=${signalAck}&t=${Date.now()}`
      );
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  function customerPicture(customer) {
    const data = customer?.picture?.data;
    if (data?.is_silhouette) return null;
    return data?.url || customer?.picture?.url || null;
  }

  function customerInitials(customer) {
    const name = customer?.name || customer?.email || 'Customer';
    return GraphAPI.pageInitials?.(name) || name.charAt(0).toUpperCase();
  }

  function showLoading() {
    const el = document.getElementById('conv-list');
    if (!el) return;
    el.innerHTML = Array(5)
      .fill(
        `<div class="conv-skeleton">
          <div class="conv-skeleton-avatar"></div>
          <div class="conv-skeleton-lines">
            <div class="sk-line sk-line--lg"></div>
            <div class="sk-line"></div>
          </div>
        </div>`
      )
      .join('');
  }

  function appendOptimisticOutgoing(text) {
    removeOptimisticOutgoing();
    const box = document.getElementById('messages');
    if (!box) return;
    box.querySelector('.chat-empty-inline')?.remove();
    const div = document.createElement('div');
    div.className = 'msg out msg-pending';
    div.dataset.pending = '1';
    div.innerHTML = `<div class="bubble"><p class="bubble-text">${escape(text)}</p></div><time>Sending…</time>`;
    box.appendChild(div);
    pendingOutgoingEl = div;
    box.scrollTop = box.scrollHeight;
  }

  function removeOptimisticOutgoing() {
    pendingOutgoingEl?.remove();
    pendingOutgoingEl = null;
    document.querySelectorAll('.msg-pending').forEach((el) => el.remove());
  }

  function patchActiveConversationSnippet(text) {
    if (!activeConv) return;
    activeConv.snippet = text;
    activeConv.updated_time = new Date().toISOString();
    const idx = conversations.findIndex((c) => c.id === activeConv.id);
    if (idx !== -1) {
      conversations[idx] = { ...conversations[idx], snippet: text, updated_time: activeConv.updated_time };
    }
    const page = pollPage;
    if (page) renderList(conversations, page.id, page.name);
  }

  function showMessagesLoading() {
    const box = document.getElementById('messages');
    if (!box) return;
    box.innerHTML = '<div class="messages-loading"><span class="spinner"></span> Loading messages…</div>';
  }

  function emptyInboxHtml(pageName) {
    const page = pageName || 'your Page';
    return `
      <div class="empty-inbox-guide">
        <div class="empty-inbox-guide__icon" aria-hidden="true">💬</div>
        <h4>No conversations yet</h4>
        <p>When a customer messages <strong>${escape(page)}</strong> on Messenger, it will appear here automatically.</p>
        <button type="button" class="btn-outline-sm" id="btn-refresh-inbox-empty">Refresh</button>
      </div>`;
  }

  function avatarHtml(customer) {
    const name = customer?.name || customer?.email || 'Customer';
    const url = customerPicture(customer);
    const initials = customerInitials(customer);
    if (url) {
      return `<div class="conv-avatar-wrap">
        <img class="conv-avatar conv-avatar--img" src="${escapeAttr(url)}" alt="" loading="lazy" referrerpolicy="no-referrer"
          onerror="this.classList.add('hidden');this.nextElementSibling?.classList.remove('hidden')"/>
        <span class="conv-avatar conv-avatar--fb hidden">${escape(initials)}</span>
      </div>`;
    }
    return `<div class="conv-avatar conv-avatar--fb" aria-hidden="true">${escape(initials)}</div>`;
  }

  function renderList(convs, pageId, pageName) {
    const el = document.getElementById('conv-list');
    if (!convs.length) {
      el.innerHTML = emptyInboxHtml(pageName);
      document.getElementById('btn-refresh-inbox-empty')?.addEventListener('click', () => {
        if (typeof refreshInbox === 'function') refreshInbox();
      });
      if (typeof Readiness !== 'undefined') Readiness.setConversations(false);
      return;
    }

    if (typeof Readiness !== 'undefined') Readiness.setConversations(true);

    el.innerHTML = convs
      .map((c) => {
        const customer = GraphAPI.extractCustomerFromConversation(c, pageId);
        const name = customer?.name || customer?.email || 'Customer';
        const time = c.updated_time ? formatTime(c.updated_time) : '';
        const unread = shouldShowUnread(c, pageId) ? '<span class="unread-dot"></span>' : '';
        const active = activeConv?.id === c.id ? ' active' : '';
        const itemClass = shouldShowUnread(c, pageId) ? ' conv-item-unread' : '';
        return `
          <button type="button" class="conv-item${active}${itemClass}" data-id="${c.id}" data-psid="${customer?.id || ''}">
            ${avatarHtml(customer)}
            <div class="conv-body">
              <div class="conv-top"><strong>${escape(name)}</strong><span>${time}</span></div>
              <div class="conv-snippet">${escape(displaySnippet(c, customer, pageId))}${unread}</div>
            </div>
          </button>`;
      })
      .join('');

    el.querySelectorAll('.conv-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const conv = convs.find((x) => x.id === btn.dataset.id);
        if (onSelectCallback) onSelectCallback(conv, btn.dataset.psid);
      });
    });
  }

  function renderUtilityCard(gt) {
    const title = gt?.title ? `<p class="bubble-text bubble-text--title">${escape(gt.title)}</p>` : '';
    const sub = gt?.subtitle ? `<p class="bubble-text bubble-text--sub">${escape(gt.subtitle)}</p>` : '';
    if (!title && !sub) return '';
    return `<div class="msg-utility-card"><span class="msg-utility-badge">Notification</span>${title}${sub}</div>`;
  }

  function genericTemplateFromAttachment(att) {
    if (att?.generic_template) return att.generic_template;
    let payload = att?.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = null;
      }
    }
    return payload?.generic_template || payload?.template?.generic || null;
  }

  function renderAttachment(att) {
    const gt = genericTemplateFromAttachment(att);
    if (gt) return renderUtilityCard(gt);

    const type = String(att.type || '').toLowerCase();
    const url = att.payload?.url;
    const name = att.name || att.payload?.name || 'Attachment';

    if (type === 'image' && url) {
      return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="msg-attachment msg-attachment--image">
        <img src="${escapeAttr(url)}" alt="Image" loading="lazy" referrerpolicy="no-referrer"/>
      </a>`;
    }
    if (type === 'video' && url) {
      return `<div class="msg-attachment msg-attachment--video">
        <video controls preload="metadata" src="${escapeAttr(url)}"></video>
      </div>`;
    }
    if (type === 'audio' && url) {
      return `<div class="msg-attachment msg-attachment--audio"><audio controls src="${escapeAttr(url)}"></audio></div>`;
    }
    if ((type === 'file' || type === 'fallback') && url) {
      return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="msg-attachment msg-attachment--file">📎 ${escape(name)}</a>`;
    }
    if (type === 'template' || type === 'fallback') {
      return renderUtilityCard(genericTemplateFromAttachment(att)) ||
        `<span class="msg-attachment msg-attachment--generic">📋 Notification</span>`;
    }
    if (url) {
      return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="msg-attachment msg-attachment--file">Open attachment</a>`;
    }
    return `<span class="msg-attachment msg-attachment--generic">${escape(name)}</span>`;
  }

  function messageBodyHtml(m) {
    const parts = [];
    const text = (m.message || '').trim();
    if (text) parts.push(`<p class="bubble-text">${escape(text)}</p>`);

    const attachments = m.attachments?.data || m.attachments || [];
    const list = Array.isArray(attachments) ? attachments : [];
    if (list.length) {
      parts.push(
        `<div class="bubble-attachments">${list.map((a) => renderAttachment(a)).join('')}</div>`
      );
    }

    if (!parts.length) {
      parts.push('<p class="bubble-text bubble-text--utility">📋 Notification sent</p>');
    }
    return parts.join('');
  }

  function displaySnippet(conv, customer, pageId) {
    let snippet = conv.snippet || '';
    if (/attachment|sent an attachment/i.test(snippet) && typeof Utility !== 'undefined') {
      const cached = Utility.getPreview?.(pageId, customer?.id);
      if (cached) snippet = cached;
    }
    return snippet;
  }

  function renderMessages(messages, pageId) {
    const box = document.getElementById('messages');
    if (!messages.length) {
      box.innerHTML = '<p class="chat-empty-inline">No messages in this thread yet.</p>';
      return;
    }
    box.innerHTML = messages
      .map((m) => {
        const fromPage = isFromPage(m, pageId);
        const cls = fromPage ? 'msg out' : 'msg in';
        const time = m.created_time ? formatTime(m.created_time) : '';
        return `<div class="${cls}"><div class="bubble">${messageBodyHtml(m)}</div><time>${time}</time></div>`;
      })
      .join('');
    box.scrollTop = box.scrollHeight;
  }

  function showChatHeader(customer) {
    document.getElementById('chat-header').classList.remove('hidden');
    document.getElementById('composer-form').classList.remove('hidden');
    document.getElementById('chat-empty').classList.add('hidden');
    const name = customer?.name || customer?.email || 'Customer';
    document.getElementById('chat-name').textContent = name;
    const psidEl = document.getElementById('chat-psid');
    if (psidEl) psidEl.textContent = 'Messenger · replies in real time';

    const pic = customerPicture(customer);
    const img = document.getElementById('chat-avatar');
    const fb = document.getElementById('chat-avatar-fallback');
    const initials = customerInitials(customer);
    if (fb) {
      fb.textContent = initials;
      fb.classList.toggle('hidden', Boolean(pic));
    }
    if (img) {
      if (pic) {
        img.onerror = () => {
          img.classList.add('hidden');
          fb?.classList.remove('hidden');
        };
        img.onload = () => {
          img.classList.remove('hidden');
          fb?.classList.add('hidden');
        };
        img.src = pic;
        img.alt = name;
        img.referrerPolicy = 'no-referrer';
      } else {
        img.classList.add('hidden');
        img.removeAttribute('src');
        fb?.classList.remove('hidden');
      }
    }
  }

  async function refreshMessages(page, conv, silent) {
    if (!conv) return [];
    if (!silent) showMessagesLoading();
    try {
      const msgs = await GraphAPI.getConversationMessages(conv.id, page.access_token);
      removeOptimisticOutgoing();
      renderMessages(msgs, page.id);
      return msgs;
    } catch (e) {
      if (!silent) {
        const box = document.getElementById('messages');
        if (box) {
          box.innerHTML = `<p class="chat-empty-inline">${escape(e.message || 'Could not load messages')}</p>`;
        }
      }
      throw e;
    }
  }

  async function syncActiveThread(page, { silent = true, retries = 2 } = {}) {
    if (!activeConv) return;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(700);
      try {
        return await refreshMessages(page, activeConv, silent);
      } catch {
        if (attempt === retries) throw new Error('Could not refresh messages after sending');
      }
    }
  }

  async function refresh(page, options = {}) {
    const forceMessages = options.forceMessages === true;
    if (refreshing) {
      if (forceMessages && activeConv && pollPage) {
        await refreshMessages(pollPage, activeConv, true);
      }
      return;
    }
    refreshing = true;
    const prevActiveId = activeConv?.id;
    const prevUpdated = activeConv?.updated_time;

    try {
      const convs = await GraphAPI.getConversations(page.id, page.access_token);
      conversations = convs;
      updateUnreadBadge(countTotalUnread(conversations, page.id));
      renderList(conversations, page.id, page.name);
      populateUtilityRecipients(conversations, page.id);

      if (prevActiveId) {
        const updated = conversations.find((c) => c.id === prevActiveId);
        if (updated) {
          const changed =
            forceMessages ||
            updated.updated_time !== prevUpdated ||
            (updated.unread_count || 0) > 0;
          activeConv = updated;
          activeCustomer = GraphAPI.extractCustomerFromConversation(updated, page.id);
          if (changed) {
            const customerPsid =
              document.getElementById('reply-input')?.dataset.psid || activeCustomer?.id;
            await refreshMessages(page, updated, true);
            if (shouldShowUnread(updated, page.id) && customerPsid) {
              markConversationRead(page.id, updated);
              syncSeenWithMeta(page, customerPsid);
            }
            if (typeof updateDashboard === 'function') updateDashboard();
          }
        }
      }
    } finally {
      refreshing = false;
    }
  }

  async function load(page, onCustomerList) {
    activePageId = page.id;
    pollPage = page;
    onSelectCallback = (conv, psid) => selectConversation(page, conv, psid);

    showLoading();
    let convs;
    try {
      convs = await GraphAPI.getConversations(page.id, page.access_token);
    } catch (e) {
      const el = document.getElementById('conv-list');
      el.innerHTML = `
        <div class="empty-inbox-guide">
          <h4>Could not load inbox</h4>
          <p>${escape(e.message)}</p>
          <button type="button" class="btn-outline-sm" id="btn-refresh-inbox-empty">Try again</button>
        </div>`;
      document.getElementById('btn-refresh-inbox-empty')?.addEventListener('click', () => {
        if (typeof refreshInbox === 'function') refreshInbox();
      });
      throw e;
    }

    conversations = convs;
    signalAck = 0;
    updateUnreadBadge(countTotalUnread(conversations, page.id));
    renderList(conversations, page.id, page.name);
    populateUtilityRecipients(conversations, page.id, onCustomerList);

    const savedConv = localStorage.getItem(FB_CONFIG.storageKeys.activeConvId);
    if (savedConv) {
      const conv = conversations.find((c) => c.id === savedConv);
      if (conv) {
        const cust = GraphAPI.extractCustomerFromConversation(conv, page.id);
        await selectConversation(page, conv, cust?.id);
      }
    }
  }

  async function selectConversation(page, conv, psid) {
    activeConv = conv;
    activePageId = page.id;
    activeCustomer = GraphAPI.extractCustomerFromConversation(conv, page.id);
    const customerPsid = psid || activeCustomer?.id;
    localStorage.setItem(FB_CONFIG.storageKeys.activeConvId, conv.id);

    markConversationRead(page.id, conv);
    const idx = conversations.findIndex((c) => c.id === conv.id);
    if (idx !== -1) conversations[idx] = { ...conversations[idx], unread_count: 0 };

    updateUnreadBadge(countTotalUnread(conversations, page.id));

    document.querySelectorAll('.conv-item').forEach((el) => {
      const isActive = el.dataset.id === conv.id;
      const c = conversations.find((x) => x.id === el.dataset.id);
      el.classList.toggle('active', isActive);
      const unread = c && !isActive && shouldShowUnread(c, page.id);
      el.classList.toggle('conv-item-unread', !!unread);
      if (!unread) el.querySelector('.unread-dot')?.remove();
    });

    showChatHeader(activeCustomer);
    document.getElementById('reply-input').dataset.psid = customerPsid;

    await refreshMessages(page, conv, false);
    syncSeenWithMeta(page, customerPsid);
    if (typeof updateDashboard === 'function') updateDashboard();
  }

  async function sendReply(page, text) {
    const psid = document.getElementById('reply-input')?.dataset.psid;
    const trimmed = text.trim();
    if (!psid || !trimmed) throw new Error('Select a conversation first');
    if (!activeConv) throw new Error('Select a conversation first');

    appendOptimisticOutgoing(trimmed);

    try {
      await GraphAPI.sendMessage(page.id, page.access_token, psid, trimmed, {
        messaging_type: 'RESPONSE',
      });
    } catch (err) {
      removeOptimisticOutgoing();
      throw err;
    }

    markConversationRead(page.id, activeConv);
    activeConv.unread_count = 0;
    patchActiveConversationSnippet(trimmed);
    syncSeenWithMeta(page, psid);

    try {
      await syncActiveThread(page, { silent: true, retries: 2 });
    } catch {
      /* optimistic bubble stays until next poll */
    }

    refresh(page, { forceMessages: true }).catch(() => {});
  }

  function isCanReplyConversation(conv) {
    return conv?.can_reply === true || conv?.can_reply === 'true';
  }

  function collectUtilityRecipients(convs, pageId) {
    const seen = new Set();
    const list = [];
    convs.forEach((c) => {
      const cust = GraphAPI.extractCustomerFromConversation(c, pageId);
      if (!cust?.id || seen.has(cust.id)) return;
      seen.add(cust.id);
      list.push({
        psid: cust.id,
        name: cust.name || cust.email || cust.id,
      });
    });
    return list;
  }

  function formatInboxThreadExportLine(selectedItemId) {
    return `selected_item_id=${selectedItemId}&thread_type=FB_MESSAGE`;
  }

  function collectReplyableRecipients(convs, pageId) {
    const seen = new Set();
    const list = [];
    convs.forEach((c) => {
      if (!isCanReplyConversation(c)) return;
      const selectedItemId = GraphAPI.extractInboxSelectedItemId(c, pageId);
      if (!selectedItemId || seen.has(selectedItemId)) return;
      seen.add(selectedItemId);
      const cust = GraphAPI.extractCustomerFromConversation(c, pageId);
      list.push({
        psid: cust?.id || selectedItemId,
        selectedItemId,
        name: cust?.name || cust?.email || selectedItemId,
      });
    });
    return list;
  }

  function getUtilityRecipients(pageId) {
    if (allSubscribersPageId === pageId && allSubscribers.length) {
      return allSubscribers.slice();
    }
    return collectUtilityRecipients(conversations, pageId || activePageId);
  }

  function triggerTextDownload(filename, content) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  async function downloadReplyableIdsFile(page, onProgress) {
    if (!page?.id || !page?.access_token) throw new Error('Select a Page first');
    const recipients = await loadAllReplyableRecipients(page, onProgress);
    if (!recipients.length) {
      throw new Error(
        'No can-reply customers found. Meta inbox mein jahan reply blocked/done/spam ho, woh list mein nahi aate.'
      );
    }
    const content =
      recipients.map((r) => formatInboxThreadExportLine(r.selectedItemId || r.psid)).join('\n') + '\n';
    const safeName = String(page.name || 'page')
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 40);
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${safeName}-can-reply-inbox-threads-${date}.txt`;
    triggerTextDownload(filename, content);
    return { count: recipients.length, filename };
  }

  function getReplyableCount(pageId) {
    if (allCanReplyPageId === pageId && allCanReply.length) {
      return allCanReply.length;
    }
    return collectReplyableRecipients(conversations, pageId || activePageId).length;
  }

  function getSubscriberCount(pageId) {
    return getReplyableCount(pageId);
  }

  async function downloadSubscriberIdsFile(page, onProgress) {
    return downloadReplyableIdsFile(page, onProgress);
  }

  async function loadAllReplyableRecipients(page, onProgress) {
    if (!page?.id || !page?.access_token) return [];
    if (loadingAllCanReply && allCanReplyPageId === page.id) {
      return allCanReply.slice();
    }
    if (allCanReplyPageId === page.id && allCanReply.length) {
      return allCanReply.slice();
    }
    loadingAllCanReply = true;
    try {
      const convs = await GraphAPI.getAllCanReplyConversations(page.id, page.access_token, onProgress);
      allCanReply = collectReplyableRecipients(convs, page.id);
      allCanReplyPageId = page.id;
      return allCanReply.slice();
    } finally {
      loadingAllCanReply = false;
    }
  }

  function isLoadingAllSubscribers() {
    return loadingAllSubscribers;
  }

  async function loadAllSubscribers(page, onProgress) {
    if (!page?.id || !page?.access_token) return [];
    if (loadingAllSubscribers && allSubscribersPageId === page.id) {
      return allSubscribers;
    }
    loadingAllSubscribers = true;
    const loadStatus = document.getElementById('utility-subscriber-load');
    if (loadStatus) {
      loadStatus.classList.remove('hidden');
      loadStatus.textContent = 'Loading all subscribers…';
    }
    try {
      const convs = await GraphAPI.getAllConversations(page.id, page.access_token, (p) => {
        if (loadStatus) loadStatus.textContent = `Loading subscribers… ${p.loaded}`;
        onProgress?.(p);
      });
      allSubscribers = collectUtilityRecipients(convs, page.id);
      allSubscribersPageId = page.id;
      populateUtilityRecipients(convs, page.id);
      if (loadStatus) {
        loadStatus.textContent = `${allSubscribers.length} subscribers loaded`;
      }
      return allSubscribers;
    } finally {
      loadingAllSubscribers = false;
    }
  }

  function populateUtilityRecipients(convs, pageId, callback) {
    const sel = document.getElementById('utility-recipient');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">— Select customer —</option>';
    const recipients = collectUtilityRecipients(convs, pageId);
    recipients.forEach(({ psid, name }) => {
      const opt = document.createElement('option');
      opt.value = psid;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
    const countEl = document.getElementById('utility-subscriber-count');
    if (countEl) countEl.textContent = String(recipients.length);
    if (callback) callback(new Set(recipients.map((r) => r.psid)));
  }

  function updateUnreadBadge(n) {
    const b = document.getElementById('unread-badge');
    if (!b) return;
    if (n > 0) {
      b.textContent = n > 99 ? '99+' : n;
      b.classList.remove('hidden');
    } else {
      b.classList.add('hidden');
    }
  }

  async function pollTick() {
    if (!pollPage || document.hidden) return;
    try {
      const sig = await fetchInboxSignal(pollPage.id);
      const hasNew = Boolean(sig?.hasNew);
      if (hasNew && sig.at) signalAck = sig.at;

      if (inboxViewActive && activeConv) {
        await refreshMessages(pollPage, activeConv, true);
      }

      await refresh(pollPage, { forceMessages: hasNew });
    } catch {
      /* silent background refresh */
    }
  }

  function schedulePoll() {
    if (pollTimer) clearInterval(pollTimer);
    const ms = inboxViewActive ? POLL_MS_INBOX : POLL_MS_OTHER;
    pollTimer = setInterval(pollTick, ms);
  }

  function startPolling(page) {
    stopPolling();
    pollPage = page;
    signalAck = 0;
    schedulePoll();
    pollTick();
    if (!window.__pagechatInboxVisBound) {
      window.__pagechatInboxVisBound = true;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && pollPage) pollTick();
      });
    }
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function setInboxViewActive(active) {
    inboxViewActive = active;
    if (pollPage) schedulePoll();
    if (active && pollPage) pollTick();
  }

  function getConversations() {
    return conversations;
  }

  function getUnreadCount(pageId) {
    return countTotalUnread(conversations, pageId || activePageId);
  }

  async function openConversation(convId, page) {
    page = page || pollPage;
    if (!page || !convId) return;
    const conv = conversations.find((c) => c.id === convId);
    if (!conv) return;
    const cust = GraphAPI.extractCustomerFromConversation(conv, page.id);
    await selectConversation(page, conv, cust?.id);
  }

  function formatTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function escape(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  return {
    load,
    refresh,
    showLoading,
    sendReply,
    startPolling,
    stopPolling,
    setInboxViewActive,
    getConversations,
    getUtilityRecipients,
    getReplyableCount,
    loadAllReplyableRecipients,
    downloadReplyableIdsFile,
    getSubscriberCount,
    downloadSubscriberIdsFile,
    loadAllSubscribers,
    isLoadingAllSubscribers,
    getUnreadCount,
    openConversation,
  };
})();
