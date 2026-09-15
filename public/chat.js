// public/chat.js — squadron chat (squadron-wide, leadership, and per-shop
// channels). One global, chatInit({ canHide }), called from switchView()'s
// chat branch on every entry, mirroring the leadership view's pattern.
//
// Polls the open channel every 12s for new messages — no WebSockets, no SSE.
// Push notifications (already wired server-side) cover the app-closed case.
// Uses the page's openModal/closeModal-free confirm (uiConfirm) for hiding a
// message; unlike duties.js/calendar.js there is no editor modal here.
(function () {
  let channels = [];
  let canHide = false;
  let shellReady = false;
  let activeChannelId = null;
  let messages = [];
  let loaded = false;          // last /api/chat/channels fetch succeeded
  let messagesLoaded = false;  // last messages fetch for the active channel succeeded
  let pollTimer = null;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toast = (msg, type) => (typeof showToast === 'function' ? showToast : uiToast)(msg, type);
  const $ = (id) => document.getElementById(id);

  const TRASH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h10M6 4V2.5h4V4M4 4l.6 9.4c0 .6.5 1.1 1.1 1.1h4.6c.6 0 1.1-.5 1.1-1.1L12 4"/></svg>';

  function shell() {
    $('chat-host').innerHTML = `
      <div class="chat-layout">
        <div class="chat-channels" id="chat-channels"><div class="skeleton"></div></div>
        <div class="chat-thread" id="chat-thread">
          <div class="res-empty">Pick a channel to start.</div>
        </div>
      </div>`;
    $('chat-channels').addEventListener('click', (e) => {
      const row = e.target.closest('.chat-channel-row');
      if (row) openChannel(Number(row.dataset.id));
    });
    shellReady = true;
  }

  function updateBadge() {
    const total = channels.reduce((n, c) => n + (c.unread_count || 0), 0);
    const desk = $('navb-chat');
    const mob  = $('navb-chat-m');
    if (desk) { desk.textContent = total; desk.hidden = !total; }
    if (mob)  { mob.textContent  = total; mob.hidden  = !total; }
  }

  async function loadChannels() {
    try {
      const res = await fetch('/api/chat/channels');
      if (!res.ok) throw new Error('request failed');
      channels = (await res.json()).channels;
      loaded = true;
    } catch (e) {
      console.error('chat', e);
      loaded = false;
    }
    renderChannels();
    updateBadge();
  }

  function renderChannels() {
    if (!loaded) {
      $('chat-channels').innerHTML = '<div class="res-offline">Chat needs a connection. Try again once you have signal.</div>';
      return;
    }
    if (!channels.length) {
      $('chat-channels').innerHTML = '<div class="res-empty">No channels yet.</div>';
      return;
    }
    $('chat-channels').innerHTML = channels.map(c => `
      <div class="chat-channel-row${c.id === activeChannelId ? ' active' : ''}" data-id="${c.id}">
        <span class="chat-channel-name">${esc(c.name)}</span>
        ${c.unread_count > 0 ? `<span class="chat-unread-badge">${c.unread_count}</span>` : ''}
      </div>`).join('');
  }

  async function openChannel(id) {
    activeChannelId = id;
    messages = [];
    messagesLoaded = false;
    renderChannels();
    await loadMessages();
    await fetch(`/api/chat/channels/${id}/read`, { method: 'POST' }).catch(() => {});
    await loadChannels(); // picks up the now-cleared unread badge
    startPolling();
  }

  async function loadMessages() {
    try {
      const res = await fetch(`/api/chat/channels/${activeChannelId}/messages`);
      if (!res.ok) throw new Error('request failed');
      messages = (await res.json()).messages;
      messagesLoaded = true;
    } catch (e) {
      console.error('chat', e);
      messagesLoaded = false;
    }
    renderThread();
  }

  async function pollNewMessages() {
    if (!activeChannelId || document.hidden) return;
    const lastId = messages.length ? messages[messages.length - 1].id : null;
    try {
      const url = `/api/chat/channels/${activeChannelId}/messages` + (lastId ? `?since=${lastId}` : '');
      const res = await fetch(url);
      if (!res.ok) return;
      const { messages: fresh } = await res.json();
      if (fresh.length) {
        messages = messages.concat(fresh);
        renderThread();
        fetch(`/api/chat/channels/${activeChannelId}/read`, { method: 'POST' }).catch(() => {});
      }
    } catch (e) { /* a missed poll tick is not worth surfacing */ }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollNewMessages, 12000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function messageRow(m) {
    if (m.hidden) {
      return `<div class="chat-msg chat-msg-hidden">Message hidden by leadership</div>`;
    }
    return `<div class="chat-msg">
      <div>
        <div class="chat-msg-meta">
          <span class="chat-msg-rank">${esc(m.author_rank)}</span>
          <span class="chat-msg-author">${esc(m.author_name)}</span>
          <span class="chat-msg-time">${fmtTime(m.created_at)}</span>
        </div>
        <div class="chat-msg-body">${esc(m.body)}</div>
      </div>
      ${canHide ? `<button class="chat-hide" type="button" aria-label="Hide message" data-id="${m.id}">${TRASH}</button>` : ''}
    </div>`;
  }

  function renderThread() {
    if (!activeChannelId) return;
    const channel = channels.find(c => c.id === activeChannelId);
    const title = channel ? esc(channel.name) : '';
    if (!messagesLoaded) {
      $('chat-thread').innerHTML = `
        <div class="chat-thread-hd">${title}</div>
        <div class="res-offline">Messages need a connection. Try again once you have signal.</div>`;
      return;
    }
    const body = messages.length
      ? messages.map(messageRow).join('')
      : '<div class="res-empty">No messages yet — say hi.</div>';
    $('chat-thread').innerHTML = `
      <div class="chat-thread-hd">${title}</div>
      <div class="chat-msg-list" id="chat-msg-list">${body}</div>
      <form class="chat-composer" id="chat-composer">
        <input type="text" id="chat-input" maxlength="2000" placeholder="Message ${title}" autocomplete="off">
        <button type="submit">Send</button>
      </form>`;
    $('chat-msg-list').scrollTop = $('chat-msg-list').scrollHeight;
    $('chat-composer').addEventListener('submit', sendMessage);
    if (canHide) {
      $('chat-msg-list').addEventListener('click', (e) => {
        const btn = e.target.closest('.chat-hide');
        if (btn) hideOne(Number(btn.dataset.id));
      });
    }
  }

  async function sendMessage(e) {
    e.preventDefault();
    const input = $('chat-input');
    const body = input.value;
    if (!body.trim()) return;
    input.disabled = true;
    try {
      const res = await fetch(`/api/chat/channels/${activeChannelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not send');
      input.value = '';
      await loadMessages();
    } catch (err) {
      toast(err.message || 'Could not send', 'error');
    }
    input.disabled = false;
    input.focus();
  }

  async function hideOne(id) {
    if (!await uiConfirm({ title: 'Hide this message?',
      message: 'It disappears from everyone’s view. This cannot be undone from here.',
      confirmLabel: 'Hide', danger: true })) return;
    try {
      const res = await fetch(`/api/chat/messages/${id}/hide`, { method: 'POST' });
      if (!res.ok && res.status !== 404) {
        throw new Error((await res.json().catch(() => ({}))).error || 'Could not hide');
      }
      await loadMessages();
    } catch (err) { toast(err.message || 'Could not hide', 'error'); }
  }

  window.chatInit = function ({ canHide: ch } = {}) {
    canHide = !!ch;
    if (!shellReady) { shell(); loadChannels(); return; }
    if (!loaded) { loadChannels(); return; }
    renderChannels();
    if (activeChannelId) renderThread();
  };

  // Called from index.html's updateNavBadges() on its regular poll cycle
  // to keep the chat badge current even when the user is on a different tab.
  window.chatInit.badgeCheck = async function () {
    try {
      const res = await fetch('/api/chat/channels');
      if (!res.ok) return;
      channels = (await res.json()).channels;
      loaded = true;
      updateBadge();
    } catch (_) { /* badge stays stale until next poll — acceptable */ }
  };

  // Logout hook (called from index.html's doLogout), same pattern as
  // calendarInit.reset()/dutiesInit.reset(): a same-tab sign-in as a
  // different member must not show the previous member's channels or
  // messages, and must not leave a poll timer running against a channel the
  // new member may not even be allowed to see.
  window.chatInit.reset = function () {
    channels = [];
    canHide = false;
    shellReady = false;
    activeChannelId = null;
    messages = [];
    loaded = false;
    messagesLoaded = false;
    stopPolling();
    updateBadge();
    const host = $('chat-host');
    if (host) host.innerHTML = '';
  };
})();
