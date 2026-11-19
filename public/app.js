/* Волна — клиент */
'use strict';

/* ------------------------------------------------------------------ utils */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

const timeOf = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dateKey = (ts) => new Date(ts).toDateString();

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (dateKey(ts) === today.toDateString()) return 'Сегодня';
  if (dateKey(ts) === yesterday.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

const initial = (name) => (name || '?').trim().charAt(0).toUpperCase();
const avatarHTML = (user, { size = '', online = null } = {}) => {
  const cls = `avatar ${size} c${(user.color || 0) % 8}`;
  const dot = online === null ? '' : `<i class="dot ${online ? 'online' : ''}"></i>`;
  return `<div class="${cls}" data-user="${esc(user.id)}">${esc(initial(user.name))}${dot}</div>`;
};

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 260);
  }, 3000);
}

/* ------------------------------------------------------------------ state */

const state = {
  token: localStorage.getItem('volna.token'),
  me: null,
  servers: [],
  dms: [],
  online: new Set(),
  view: { type: 'home' },
  server: null,
  channel: null,
  messages: [],
  hasMore: false,
  animId: null,
  unread: JSON.parse(localStorage.getItem('volna.unread') || '{}'),
  typing: new Map(),
  socket: null,
};

const saveUnread = () => localStorage.setItem('volna.unread', JSON.stringify(state.unread));
let pendingInvite = new URLSearchParams(location.search).get('invite');

/* -------------------------------------------------------------------- api */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.me) logout();
    const err = new Error(data.error || 'Что-то пошло не так');
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ------------------------------------------------------------------- auth */

let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  $$('.auth-tab').forEach((t) => t.classList.toggle('is-active', t.dataset.mode === mode));
  $('.auth-tabs').dataset.mode = mode;
  $('#authSubmit').textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
  $('#authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#authNote').innerHTML =
    mode === 'login'
      ? 'Нет аккаунта? <button class="link" data-switch="register">Создать за пару секунд</button>'
      : 'Уже есть аккаунт? <button class="link" data-switch="login">Войти</button>';
  $('#authError').textContent = '';
}

function initAuth() {
  $$('.auth-tab').forEach((tab) => tab.addEventListener('click', () => setAuthMode(tab.dataset.mode)));
  document.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-switch]');
    if (sw) {
      e.preventDefault();
      setAuthMode(sw.dataset.switch);
    }
  });

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#authName').value.trim();
    const password = $('#authPass').value;
    const btn = $('#authSubmit');
    const errEl = $('#authError');
    errEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Секунду…';
    try {
      const data = await api(authMode === 'login' ? '/login' : '/register', {
        method: 'POST',
        body: { username, password },
      });
      state.token = data.token;
      state.me = data.user;
      localStorage.setItem('volna.token', data.token);
      await boot();
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = authMode === 'login' ? 'Войти' : 'Создать аккаунт';
    }
  });
}

async function logout() {
  try {
    await api('/logout', { method: 'POST' });
  } catch (_) {
    /* ignore */
  }
  localStorage.removeItem('volna.token');
  if (state.socket) state.socket.disconnect();
  state.token = null;
  state.me = null;
  state.server = null;
  state.channel = null;
  $('#app').classList.add('is-hidden');
  $('#authScreen').classList.remove('is-hidden');
  setAuthMode('login');
  $('#authPass').value = '';
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  const data = await api('/bootstrap');
  state.me = data.user;
  state.servers = data.servers;
  state.dms = data.dms;
  state.online = new Set(data.online);

  $('#authScreen').classList.add('is-hidden');
  $('#app').classList.remove('is-hidden');

  renderRail();
  renderUserPanel();
  connectSocket();

  if (pendingInvite) {
    const code = pendingInvite;
    pendingInvite = null;
    history.replaceState(null, '', '/');
    prefillInvite(code);
  }

  const last = JSON.parse(localStorage.getItem('volna.last') || 'null');
  if (last && last.type === 'server' && state.servers.some((s) => s.id === last.serverId)) {
    await openServer(last.serverId, last.channelId);
  } else if (last && last.type === 'home' && last.channelId && state.dms.some((d) => d.id === last.channelId)) {
    await openDM(last.channelId);
  } else if (!state.dms.length && state.servers.length) {
    // новичку сразу показываем его сервер, а не пустой экран
    await openServer(state.servers[0].id);
  } else {
    openHome();
  }
}

function rememberLast() {
  const payload =
    state.view.type === 'server'
      ? { type: 'server', serverId: state.view.serverId, channelId: state.channel && state.channel.id }
      : { type: 'home', channelId: state.channel && state.channel.serverId ? null : state.channel && state.channel.id };
  localStorage.setItem('volna.last', JSON.stringify(payload));
}

/* ------------------------------------------------------------------ rail */

function renderRail() {
  $('#railServers').innerHTML = state.servers
    .map((s) => {
      const active = state.view.type === 'server' && state.view.serverId === s.id;
      return `<button class="rail-btn ${active ? 'is-active' : ''}" data-server="${s.id}" title="${esc(s.name)}">
        ${esc(initial(s.name))}
      </button>`;
    })
    .join('');

  $('#homeBtn').classList.toggle('is-active', state.view.type === 'home');

  $$('#railServers [data-server]').forEach((btn) =>
    btn.addEventListener('click', () => openServer(btn.dataset.server))
  );
}

/* --------------------------------------------------------------- sidebar */

function refreshSidebar() {
  const active = document.activeElement;
  if (active && active.id === 'dmSearch') return;
  renderSidebar();
}

function renderSidebar() {
  const head = $('#sidebarHead');
  const body = $('#sidebarBody');

  if (state.view.type === 'home') {
    head.innerHTML = `
      <div class="server-title">
        <b>Личные сообщения</b>
        <span>${state.dms.length ? `диалогов: ${state.dms.length}` : 'пока пусто'}</span>
      </div>
      <div class="head-actions">
        <button class="icon-btn" id="findUserBtn" title="Найти человека">
          <svg viewBox="0 0 24 24" width="17" height="17"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16.5 16.5 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>`;

    body.innerHTML = `
      <div style="padding:4px 4px 10px">
        <input id="dmSearch" class="dm-search" type="text" placeholder="Поиск людей…" autocomplete="off"
          style="width:100%;padding:9px 12px;border-radius:9px;background:var(--bg-input);border:1px solid var(--line-strong);outline:none;font-size:13px" />
      </div>
      <div id="dmSearchResults"></div>
      <div class="side-label">Прямые сообщения</div>
      <div id="dmList">
        ${
          state.dms.length
            ? state.dms.map(dmRow).join('')
            : '<p class="empty-hint">Пока ни одного диалога.<br>Найди человека по имени — и напиши первым.</p>'
        }
      </div>`;

    const search = $('#dmSearch');
    let t = null;
    search.addEventListener('input', () => {
      clearTimeout(t);
      const q = search.value.trim();
      if (!q) {
        $('#dmSearchResults').innerHTML = '';
        return;
      }
      t = setTimeout(() => runUserSearch(q), 220);
    });

    $$('#dmList [data-dm]').forEach((el) =>
      el.addEventListener('click', () => openDM(el.dataset.dm))
    );
    $('#findUserBtn').addEventListener('click', () => search.focus());
    return;
  }

  if (!state.server) {
    head.innerHTML = '<div class="server-title"><b>Загрузка…</b></div>';
    body.innerHTML = '';
    return;
  }

  const srv = state.server.server;
  const isOwner = srv.ownerId === state.me.id;
  head.innerHTML = `
    <div class="server-title">
      <b title="${esc(srv.name)}">${esc(srv.name)}</b>
      <span>${srv.memberCount} ${plural(srv.memberCount, ['участник', 'участника', 'участников'])}</span>
    </div>
    <div class="head-actions">
      <button class="icon-btn" id="inviteBtn" title="Пригласить">
        <svg viewBox="0 0 24 24" width="17" height="17"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <button class="icon-btn" id="serverMenuBtn" title="Меню">
        <svg viewBox="0 0 24 24" width="17" height="17"><circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>
      </button>
    </div>`;

  body.innerHTML = `
    <div class="side-label">
      <span>Текстовые каналы</span>
      <button id="addChannelBtn" title="Создать канал">
        <svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div id="channelList">
      ${state.server.channels
        .map((ch) => {
          const active = state.channel && state.channel.id === ch.id;
          const unread = state.unread[`ch:${ch.id}`] && !active;
          return `<button class="channel-item ${active ? 'is-active' : ''} ${unread ? 'unread' : ''}" data-channel="${ch.id}">
            <span class="hash">#</span>
            <span class="name">${esc(ch.name)}</span>
            ${isOwner ? '<span class="chan-del" data-del-channel="' + ch.id + '" title="Удалить канал">✕</span>' : ''}
          </button>`;
        })
        .join('')}
    </div>
    ${
      isOwner
        ? `<div class="side-label" style="padding-top:22px">Управление</div>
           <button class="channel-item" id="deleteServerBtn" style="color:var(--danger)">
             <span class="hash">⚠</span><span class="name">Удалить сервер</span>
           </button>`
        : `<div class="side-label" style="padding-top:22px">Управление</div>
           <button class="channel-item" id="leaveServerBtn" style="color:var(--danger)">
             <span class="hash">↩</span><span class="name">Покинуть сервер</span>
           </button>`
    }`;

  $$('#channelList [data-channel]').forEach((el) =>
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-del-channel]')) return;
      openChannel(el.dataset.channel);
    })
  );
  $$('#channelList [data-del-channel]').forEach((el) =>
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmModal('Удалить канал?', 'Вся история сообщений будет стёрта без возможности восстановления.');
      if (!ok) return;
      try {
        await api(`/channels/${el.dataset.delChannel}`, { method: 'DELETE' });
        toast('Канал удалён', 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  $('#inviteBtn').addEventListener('click', inviteModal);
  $('#addChannelBtn').addEventListener('click', createChannelModal);
  $('#serverMenuBtn').addEventListener('click', serverMenuModal);
  const del = $('#deleteServerBtn');
  if (del) del.addEventListener('click', deleteServerFlow);
  const leave = $('#leaveServerBtn');
  if (leave) leave.addEventListener('click', leaveServerFlow);
}

const plural = (n, forms) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
};

function dmRow(dm) {
  const active = state.channel && state.channel.id === dm.id;
  const unread = state.unread[`dm:${dm.id}`] && !active;
  const peer = dm.peer || { name: 'Удалённый', color: 7 };
  const preview = dm.lastMessage
    ? `${dm.lastMessage.author.name}: ${dm.lastMessage.content.replace(/\s+/g, ' ').slice(0, 34)}`
    : 'Начните диалог';
  return `<button class="dm-item ${active ? 'is-active' : ''} ${unread ? 'unread' : ''}" data-dm="${dm.id}">
    ${avatarHTML(peer, { size: 'avatar-sm', online: state.online.has(peer.id) })}
    <span class="dm-meta"><b>${esc(peer.name)}</b><span>${esc(preview)}</span></span>
  </button>`;
}

async function runUserSearch(q) {
  const box = $('#dmSearchResults');
  try {
    const { users } = await api(`/users?q=${encodeURIComponent(q)}`);
    if (!q) return;
    if (!users.length) {
      box.innerHTML = '<p class="empty-hint" style="padding:8px 12px">Никого не нашлось</p>';
      return;
    }
    box.innerHTML = users
      .map(
        (u) => `<button class="dm-item" data-user-result="${esc(u.id)}">
          ${avatarHTML(u, { size: 'avatar-sm', online: u.online })}
          <span class="dm-meta"><b>${esc(u.name)}</b><span>@${esc(u.name)}#${esc(u.tag)}</span></span>
        </button>`
      )
      .join('');
    $$('[data-user-result]', box).forEach((el) =>
      el.addEventListener('click', () => startDM(el.dataset.userResult))
    );
  } catch (err) {
    box.innerHTML = `<p class="empty-hint">${esc(err.message)}</p>`;
  }
}

/* ------------------------------------------------------------- user panel */

function renderUserPanel() {
  const me = state.me;
  $('#userPanel').innerHTML = `
    ${avatarHTML(me, { size: 'avatar-sm', online: true })}
    <span class="me-meta">
      <b>${esc(me.name)}</b>
      <span>@${esc(me.name)}#${esc(me.tag)}</span>
    </span>
    <button class="icon-btn" id="settingsBtn" title="Настройки">
      <svg viewBox="0 0 24 24" width="17" height="17"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a1.7 1.7 0 0 0-1.6-1H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 3 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 3V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 9h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
    </button>
    <button class="icon-btn" id="logoutBtn" title="Выйти">
      <svg viewBox="0 0 24 24" width="17" height="17"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`;

  $$('#userPanel [data-user]').forEach((el) => el.addEventListener('click', () => openProfile(state.me.id)));
  $('#settingsBtn').addEventListener('click', settingsModal);
  $('#logoutBtn').addEventListener('click', logout);
}

/* ------------------------------------------------------------- navigation */

function openHome() {
  state.view = { type: 'home' };
  state.server = null;
  state.channel = null;
  state.messages = [];
  $('#app').classList.remove('show-sidebar');
  renderRail();
  renderSidebar();
  renderMembers();
  renderChat();
  rememberLast();
}

async function openServer(serverId, channelId = null) {
  try {
    const data = await api(`/servers/${serverId}`);
    state.view = { type: 'server', serverId };
    state.server = data;
    state.servers = state.servers.map((s) =>
      s.id === serverId ? { ...s, memberCount: data.server.memberCount, name: data.server.name } : s
    );
    $('#app').classList.remove('show-sidebar');
    renderRail();
    renderSidebar();
    renderMembers();

    const target =
      data.channels.find((c) => c.id === channelId) ||
      data.channels.find((c) => state.channel && c.id === state.channel.id) ||
      data.channels[0];
    if (target) await openChannel(target.id, { keepSidebar: true });
    else {
      state.channel = null;
      renderChat();
    }
    rememberLast();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openChannel(channelId, { keepSidebar = false } = {}) {
  const ch =
    (state.server && state.server.channels.find((c) => c.id === channelId)) ||
    (state.channel && state.channel.id === channelId ? state.channel : null);
  if (!ch) return;
  state.channel = ch;
  delete state.unread[`ch:${channelId}`];
  saveUnread();
  state.messages = [];
  state.hasMore = false;
  state.typing.delete(channelId);
  if (!keepSidebar) $('#app').classList.remove('show-sidebar');

  renderSidebar();
  renderChat();
  renderMessages({ scroll: 'bottom' });

  try {
    const data = await api(`/channels/${channelId}/messages?limit=50`);
    state.messages = data.messages;
    state.hasMore = data.hasMore;
    renderMessages({ scroll: 'bottom' });
    markRead(channelId);
  } catch (err) {
    toast(err.message, 'error');
  }
  rememberLast();
}

async function openDM(dmId) {
  const dm = state.dms.find((d) => d.id === dmId);
  if (!dm) return;
  state.view = { type: 'home' };
  state.server = null;
  state.channel = { ...dm, isDM: true };
  delete state.unread[`dm:${dmId}`];
  saveUnread();
  state.messages = [];
  state.hasMore = false;
  state.typing.delete(dmId);
  $('#app').classList.remove('show-sidebar');
  renderRail();
  renderSidebar();
  renderMembers();
  renderChat();
  renderMessages({ scroll: 'bottom' });
  rememberLast();

  try {
    const data = await api(`/channels/${dmId}/messages?limit=50`);
    state.messages = data.messages;
    state.hasMore = data.hasMore;
    renderMessages({ scroll: 'bottom' });
    markRead(dmId);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function startDM(userId) {
  try {
    const { dm } = await api('/dm', { method: 'POST', body: { userId } });
    if (!state.dms.some((d) => d.id === dm.id)) state.dms.unshift(dm);
    state.dms.sort(
      (a, b) => (b.lastMessage ? b.lastMessage.createdAt : b.createdAt) - (a.lastMessage ? a.lastMessage.createdAt : a.createdAt)
    );
    await openDM(dm.id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function unreadKey(channelId) {
  return state.dms.some((d) => d.id === channelId) ? `dm:${channelId}` : `ch:${channelId}`;
}

function markRead(channelId) {
  delete state.unread[unreadKey(channelId)];
  saveUnread();
}

/* ------------------------------------------------------------------- chat */

function renderChat() {
  const head = $('#chatHead');
  const composer = $('#composer');
  const noChannel = $('#noChannel');
  const typingLine = $('#typingLine');
  const ch = state.channel;

  if (!ch) {
    head.innerHTML = `
      <button class="icon-btn mobile-only" id="mobileMenu" title="Меню">☰</button>
      <div class="chan-name">${state.view.type === 'home' ? 'Личные сообщения' : 'Каналы сервера'}</div>`;
    noChannel.innerHTML =
      state.view.type === 'home'
        ? `<div class="no-channel-art">
             <svg viewBox="0 0 24 24" width="56" height="56"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
           </div>
           <p><strong style="color:var(--text);font-size:16px">Личные сообщения</strong><br>Выберите диалог слева или найдите человека по имени</p>`
        : `<div class="no-channel-art">
             <svg viewBox="0 0 64 64" width="64" height="64"><path d="M12 38c6-15 14-15 20 0s14 15 20 0" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/></svg>
           </div>
           <p>В этом сервере пока нет каналов.<br>Создайте первый — кнопкой «+» в сайдбаре</p>`;
    composer.classList.add('is-hidden');
    noChannel.classList.remove('is-hidden');
    typingLine.style.visibility = 'hidden';
    $('#welcome').classList.add('is-hidden');
    $('#messages').innerHTML = '';
    const menu = $('#mobileMenu');
    if (window.innerWidth <= 760) {
      menu.style.display = 'grid';
      menu.addEventListener('click', () => $('#app').classList.toggle('show-sidebar'));
    }
    return;
  }

  noChannel.classList.add('is-hidden');
  composer.classList.remove('is-hidden');
  typingLine.style.visibility = 'visible';

  if (ch.isDM || ch.serverId === null) {
    const peer = ch.peer || { name: 'Удалённый', color: 7, tag: '' };
    const online = state.online.has(peer.id);
    head.innerHTML = `
      <button class="icon-btn mobile-only" id="mobileMenu" title="Меню">☰</button>
      ${avatarHTML(peer, { size: 'avatar-sm', online })}
      <div class="head-dm">
        <b>${esc(peer.name)}</b>
        <span>${online ? 'в сети' : 'не в сети'}</span>
      </div>`;
    $('#composerInput').placeholder = `Сообщение для ${peer.name}…`;
  } else {
    const topic = ch.topic || 'Без описания';
    head.innerHTML = `
      <button class="icon-btn mobile-only" id="mobileMenu" title="Меню">☰</button>
      <div class="chan-name"><span class="hash">#</span>${esc(ch.name)}</div>
      <div class="divider"></div>
      <div class="topic">${esc(topic)}</div>
      <div class="spacer"></div>
      <button class="icon-btn" id="membersToggle" title="Участники">
        <svg viewBox="0 0 24 24" width="18" height="18"><circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M17.5 19a5.5 5.5 0 0 0-2.2-4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>`;
    $('#composerInput').placeholder = `Сообщение в #${ch.name}…`;
    $('#membersToggle').addEventListener('click', () => $('#membersPane').classList.toggle('is-hidden'));
  }

  const menu = $('#mobileMenu');
  if (menu) menu.addEventListener('click', () => $('#app').classList.toggle('show-sidebar'));

  renderWelcome();
  renderTyping();
}

function renderWelcome() {
  const w = $('#welcome');
  const ch = state.channel;
  if (!ch || state.messages.length) {
    w.classList.add('is-hidden');
    return;
  }
  w.classList.remove('is-hidden');
  if (ch.isDM || ch.serverId === null) {
    const peer = ch.peer || { name: 'друг' };
    w.innerHTML = `
      <div class="welcome-badge">
        <svg viewBox="0 0 24 24" width="32" height="32"><path d="M12 20s-7-4.4-7-9.3A4 4 0 0 1 12 8a4 4 0 0 1 7 2.7C19 15.6 12 20 12 20z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
      </div>
      <h2>Это начало диалога с ${esc(peer.name)}</h2>
      <p>Напишите первое сообщение — и оно появится у собеседника мгновенно.</p>`;
  } else {
    w.innerHTML = `
      <div class="welcome-badge"><span style="font-size:30px;color:#a9a1ff">#</span></div>
      <h2>Добро пожаловать в #${esc(ch.name)}</h2>
      <p>${esc(ch.topic || 'Это начало канала. Здесь пока тихо — скажите первое слово.')}</p>`;
  }
}

function renderMessages({ scroll = 'keep', animateId = null } = {}) {
  const box = $('#messages');
  const scroller = $('.chat-body');
  const wasBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  const prevHeight = scroller.scrollHeight;
  const prevTop = scroller.scrollTop;

  renderWelcome();

  const list = state.messages;
  const frag = document.createDocumentFragment();

  if (state.hasMore) {
    const btn = document.createElement('button');
    btn.className = 'load-more';
    btn.textContent = 'Загрузить историю';
    btn.addEventListener('click', loadOlder);
    frag.appendChild(btn);
  }

  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'messages-empty';
    empty.textContent = state.channel ? 'Сообщений пока нет' : '';
    frag.appendChild(empty);
  }

  let prev = null;
  for (const m of list) {
    if (m.system) {
      frag.appendChild(systemNode(m));
      prev = null;
      continue;
    }
    const newDay = !prev || dateKey(prev.createdAt) !== dateKey(m.createdAt);
    if (newDay) frag.appendChild(dayNode(m.createdAt));
    const grouped =
      !newDay && prev && prev.userId === m.userId && m.createdAt - prev.createdAt < 5 * 60 * 1000;
    frag.appendChild(messageNode(m, { grouped, animate: m.id === animateId }));
    prev = m;
  }

  box.replaceChildren(frag);

  if (scroll === 'bottom' || (scroll === 'auto' && wasBottom)) {
    scroller.scrollTop = scroller.scrollHeight;
  } else if (scroll === 'restore') {
    scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight);
  }
  updateJumpButton();
}

function dayNode(ts) {
  const el = document.createElement('div');
  el.className = 'day-divider';
  el.textContent = dayLabel(ts);
  return el;
}

function systemNode(m) {
  const el = document.createElement('div');
  el.className = 'msg-system';
  el.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 3v18M5 8h14M5 16h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span></span>`;
  el.querySelector('span').textContent = m.content;
  return el;
}

function messageNode(m, { grouped = false, animate = false } = {}) {
  const el = document.createElement('div');
  el.className = 'msg-group' + (grouped ? '' : ' first-in-group');
  el.dataset.msg = m.id;
  if (animate) el.style.animation = 'msg-in .2s ease-out';

  const isMine = m.userId === state.me.id;
  const canDelete =
    isMine || (state.server && state.server.server.ownerId === state.me.id);
  const emojiOnly = /^(?:\p{Extended_Pictographic}|\uFE0F|\u200D|\s){1,12}$/u.test(m.content) && /\p{Extended_Pictographic}/u.test(m.content);

  const actions = `
    <div class="msg-actions">
      <button data-act="copy" title="Копировать текст">
        <svg viewBox="0 0 24 24" width="15" height="15"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 14V6a2 2 0 0 1 2-2h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
      ${isMine ? `<button data-act="edit" title="Редактировать">
        <svg viewBox="0 0 24 24" width="15" height="15"><path d="m4 20 4-1 10-10-3-3L5 16z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>` : ''}
      ${canDelete ? `<button data-act="delete" class="danger" title="Удалить">
        <svg viewBox="0 0 24 24" width="15" height="15"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>` : ''}
    </div>`;

  if (grouped) {
    el.innerHTML = `
      <div class="msg-spacer">${timeOf(m.createdAt)}</div>
      <div class="msg-body">
        <div class="msg-text ${emojiOnly ? 'emoji-only' : ''}"></div>
      </div>
      ${actions}`;
  } else {
    el.innerHTML = `
      ${avatarHTML(m.author)}
      <div class="msg-body">
        <div class="msg-meta">
          <b>${esc(m.author.name)}</b>
          <span class="tag">#${esc(m.author.tag)}</span>
          <time>${timeOf(m.createdAt)}</time>
        </div>
        <div class="msg-text ${emojiOnly ? 'emoji-only' : ''}"></div>
      </div>
      ${actions}`;
    const av = el.querySelector('[data-user]');
    if (av) av.addEventListener('click', () => openProfile(m.author.id));
  }

  const textEl = el.querySelector('.msg-text');
  textEl.textContent = m.content;
  if (m.editedAt) {
    const tag = document.createElement('span');
    tag.className = 'edited';
    tag.textContent = '(изменено)';
    textEl.appendChild(tag);
  }
  return el;
}

/* --------------------------------------------------------------- messages */

function updateJumpButton() {
  const scroller = $('.chat-body');
  const btn = $('#jumpBottom');
  const far = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 400;
  btn.classList.toggle('is-hidden', !far);
}

async function loadOlder() {
  if (!state.channel || !state.messages.length) return;
  const first = state.messages[0];
  try {
    const data = await api(`/channels/${state.channel.id}/messages?before=${first.createdAt}&limit=50`);
    state.messages = [...data.messages, ...state.messages];
    state.hasMore = data.hasMore;
    renderMessages({ scroll: 'restore' });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function sendMessage() {
  const input = $('#composerInput');
  const content = input.value.replace(/\s+$/, '');
  if (!content.trim() || !state.channel) return;
  input.value = '';
  autoGrow(input);
  try {
    const { message } = await api(`/channels/${state.channel.id}/messages`, {
      method: 'POST',
      body: { content },
    });
    receiveMessage(message);
  } catch (err) {
    toast(err.message, 'error');
    input.value = content;
  }
}

function receiveMessage(message) {
  const current = state.channel && message.channelId === state.channel.id;
  if (current) {
    if (!state.messages.some((m) => m.id === message.id)) {
      state.messages.push(message);
      const scroller = $('.chat-body');
      const nearBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 220;
      renderMessages({ scroll: nearBottom ? 'bottom' : 'keep', animateId: message.id });
      if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
    }
    markRead(message.channelId);
  } else {
    state.unread[unreadKey(message.channelId)] = Date.now();
    saveUnread();
    refreshSidebar();
  }

  // обновляем превью в списке чатов
  const dm = state.dms.find((d) => d.id === message.channelId);
  if (dm) {
    dm.lastMessage = message;
    state.dms.sort(
      (a, b) =>
        (b.lastMessage ? b.lastMessage.createdAt : b.createdAt) -
        (a.lastMessage ? a.lastMessage.createdAt : a.createdAt)
    );
    if (state.view.type === 'home') renderSidebar();
  }
  if (state.server) {
    const ch = state.server.channels.find((c) => c.id === message.channelId);
    if (ch) ch.lastMessage = message;
  }
}

/* ---------------------------------------------------------------- actions */

async function editMessage(messageId) {
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg) return;
  const html = `
    <h3>Изменить сообщение</h3>
    <p class="modal-sub">Правка появится у всех участников канала.</p>
    <form class="modal-form" id="editForm">
      <label class="field"><textarea name="content" maxlength="2000">${esc(msg.content)}</textarea></label>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-close>Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form>`;
  openModal(html, (root) => {
    const ta = root.querySelector('textarea');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    root.querySelector('#editForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const content = ta.value.trim();
      if (!content) return;
      try {
        await api(`/messages/${messageId}`, { method: 'PATCH', body: { content } });
        closeModal();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

async function deleteMessage(messageId) {
  const ok = await confirmModal('Удалить сообщение?', 'Это действие нельзя отменить.');
  if (!ok) return;
  try {
    await api(`/messages/${messageId}`, { method: 'DELETE' });
    state.messages = state.messages.filter((m) => m.id !== messageId);
    renderMessages({ scroll: 'keep' });
  } catch (err) {
    toast(err.message, 'error');
  }
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;

  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') logout();
  });
  socket.on('ready', ({ online }) => {
    state.online = new Set(online);
    if (state.server) {
      state.server.members = state.server.members.map((m) => ({
        ...m,
        online: state.online.has(m.id),
      }));
      renderMembers();
    }
    if (state.view.type === 'home') refreshSidebar();
  });
  socket.on('presence', ({ userId, online }) => {
    if (online) state.online.add(userId);
    else state.online.delete(userId);
    if (state.server) {
      state.server.members = state.server.members.map((m) =>
        m.id === userId ? { ...m, online } : m
      );
      renderMembers();
    }
    if (state.view.type === 'home') renderSidebar();
    if (state.channel && (state.channel.isDM || state.channel.serverId === null)) renderChat();
  });
  socket.on('message:new', ({ message }) => receiveMessage(message));
  socket.on('message:update', ({ message }) => {
    const idx = state.messages.findIndex((m) => m.id === message.id);
    if (idx > -1) {
      state.messages[idx] = message;
      renderMessages({ scroll: 'keep' });
    }
  });
  socket.on('message:delete', ({ channelId, messageId }) => {
    if (state.channel && channelId === state.channel.id) {
      state.messages = state.messages.filter((m) => m.id !== messageId);
      renderMessages({ scroll: 'keep' });
    }
  });
  socket.on('typing', ({ channelId, user }) => {
    if (!state.typing.has(channelId)) state.typing.set(channelId, new Map());
    state.typing.get(channelId).set(user.id, { user, at: Date.now() });
    if (state.channel && state.channel.id === channelId) renderTyping();
  });
  socket.on('typing:stop', ({ channelId, userId }) => {
    const map = state.typing.get(channelId);
    if (map) map.delete(userId);
    if (state.channel && state.channel.id === channelId) renderTyping();
  });
  socket.on('channel:created', ({ channel }) => {
    if (!state.server || !state.server.channels.some((c) => c.id === channel.id)) {
      if (state.server && channel.serverId === state.server.server.id) {
        state.server.channels.push(channel);
        renderSidebar();
        toast(`Создан канал #${channel.name}`, 'ok');
      }
    }
  });
  socket.on('channel:deleted', ({ channelId }) => {
    if (state.server && state.server.channels.some((c) => c.id === channelId)) {
      state.server.channels = state.server.channels.filter((c) => c.id !== channelId);
      if (state.channel && state.channel.id === channelId) {
        const next = state.server.channels[0];
        state.channel = null;
        state.messages = [];
        renderChat();
        if (next) openChannel(next.id);
      } else {
        renderSidebar();
      }
    }
  });
  socket.on('member:joined', ({ user }) => {
    if (!state.server) return;
    if (!state.server.members.some((m) => m.id === user.id)) {
      state.server.members.push(user);
      state.server.server.memberCount += 1;
      renderMembers();
      renderSidebar();
      if (state.channel) {
        state.messages.push({
          id: `sys_${Date.now()}`,
          channelId: state.channel.id,
          system: true,
          content: `${user.name} присоединился к серверу. Поздоровайтесь!`,
          createdAt: Date.now(),
          author: { id: 'system', name: 'Волна', tag: '', color: 0 },
        });
        renderMessages({ scroll: 'auto' });
      }
    }
  });
  socket.on('server:deleted', ({ serverId }) => {
    state.servers = state.servers.filter((s) => s.id !== serverId);
    if (state.view.type === 'server' && state.view.serverId === serverId) {
      toast('Сервер удалён владельцем', 'error');
      openHome();
      renderRail();
    } else {
      renderRail();
    }
  });
  socket.on('dm:created', ({ dm }) => {
    if (!state.dms.some((d) => d.id === dm.id)) {
      state.dms.unshift(dm);
      if (state.view.type === 'home') renderSidebar();
      toast(`${dm.peer ? dm.peer.name : 'Кто-то'} начал с вами диалог`, 'ok');
    }
  });
}

function renderTyping() {
  const line = $('#typingLine');
  const map = state.channel ? state.typing.get(state.channel.id) : null;
  if (!map || !map.size) {
    line.innerHTML = '';
    return;
  }
  for (const [id, entry] of map) {
    if (Date.now() - entry.at > 5000) map.delete(id);
  }
  if (!map.size) {
    line.innerHTML = '';
    return;
  }
  const names = [...map.values()].map((v) => v.user.name);
  const label =
    names.length === 1
      ? `${names[0]} печатает`
      : `${names.slice(0, 2).join(', ')} ${names.length > 2 ? 'и ещё ' + (names.length - 2) : ''} печатают`;
  line.innerHTML = `<span>${esc(label)}</span><span class="typing-dots"><i></i><i></i><i></i></span>`;
}

/* ---------------------------------------------------------------- members */

function renderMembers() {
  const pane = $('#membersPane');
  if (!state.server) {
    pane.classList.add('is-hidden');
    return;
  }
  const members = [...state.server.members].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.name.localeCompare(b.name, 'ru');
  });
  const online = members.filter((m) => m.online);
  const offline = members.filter((m) => !m.online);

  pane.classList.remove('is-hidden');
  pane.innerHTML = `
    <div class="side-label">В сети — ${online.length}</div>
    ${online.map(memberRow).join('') || '<p class="empty-hint">Только вы пока</p>'}
    ${offline.length ? `<div class="side-label">Не в сети — ${offline.length}</div>${offline.map(memberRow).join('')}` : ''}`;

  $$('#membersPane [data-member]').forEach((el) =>
    el.addEventListener('click', () => openProfile(el.dataset.member))
  );
}

function memberRow(m) {
  return `<button class="member ${m.online ? '' : 'offline'}" data-member="${m.id}">
    ${avatarHTML(m, { size: 'avatar-sm', online: m.online })}
    <span class="m-meta">
      <b>${esc(m.name)} ${m.owner ? '<span class="owner-crown" title="Владелец">✦</span>' : ''}</b>
      <span>${m.online ? 'в сети' : 'офлайн'}</span>
    </span>
  </button>`;
}

/* ----------------------------------------------------------------- modals */

function openModal(html, onMount) {
  const root = $('#modalRoot');
  root.classList.remove('is-hidden');
  root.setAttribute('aria-hidden', 'false');
  root.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  root.onclick = (e) => {
    if (e.target === root) closeModal();
  };
  $$('[data-close]', root).forEach((b) => b.addEventListener('click', closeModal));
  document.onkeydown = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  if (onMount) onMount($('.modal', root));
}

function closeModal() {
  const root = $('#modalRoot');
  root.classList.add('is-hidden');
  root.innerHTML = '';
  root.onclick = null;
  document.onkeydown = null;
}

function confirmModal(title, text, confirmText = 'Удалить') {
  return new Promise((resolve) => {
    openModal(
      `<h3>${esc(title)}</h3>
       <p class="modal-sub">${esc(text)}</p>
       <div class="modal-actions">
         <button class="btn btn-ghost" data-close>Отмена</button>
         <button class="btn btn-danger" id="confirmYes">${esc(confirmText)}</button>
       </div>`,
      (root) => {
        root.querySelector('#confirmYes').addEventListener('click', () => {
          closeModal();
          resolve(true);
        });
        $('[data-close]', root).addEventListener('click', () => resolve(false));
      }
    );
  });
}

function createServerModal() {
  openModal(
    `<h3>Создать сервер</h3>
     <p class="modal-sub">Сервер — это пространство с каналами для вашей компании.</p>
     <form class="modal-form" id="serverForm">
       <label class="field">
         <span class="field-label">Название</span>
         <input name="name" maxlength="32" placeholder="Например, «Друзья»" autofocus required />
       </label>
       <div class="modal-actions">
         <button type="button" class="btn btn-ghost" data-close>Отмена</button>
         <button type="submit" class="btn btn-primary">Создать</button>
       </div>
     </form>`,
    (root) => {
      root.querySelector('input').focus();
      root.querySelector('#serverForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = root.querySelector('input').value.trim();
        if (name.length < 2) return;
        try {
          const data = await api('/servers', { method: 'POST', body: { name } });
          state.servers.push(data.server);
          closeModal();
          renderRail();
          await openServer(data.server.id, data.channel.id);
          toast('Сервер создан', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
  );
}

function joinServerModal() {
  openModal(
    `<h3>Присоединиться к серверу</h3>
     <p class="modal-sub">Введите код приглашения — 8 символов из ссылки друга.</p>
     <form class="modal-form" id="joinForm">
       <label class="field">
         <span class="field-label">Код приглашения</span>
         <input name="code" maxlength="12" placeholder="a1b2c3d4" autocomplete="off" required
           style="font-family:ui-monospace,monospace;letter-spacing:2px;text-align:center" />
       </label>
       <div class="modal-actions">
         <button type="button" class="btn btn-ghost" data-close>Отмена</button>
         <button type="submit" class="btn btn-primary">Присоединиться</button>
       </div>
     </form>`,
    (root) => {
      root.querySelector('input').focus();
      root.querySelector('#joinForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = root.querySelector('input').value.trim();
        try {
          const data = await api('/servers/join', { method: 'POST', body: { code } });
          if (!state.servers.some((s) => s.id === data.server.id)) state.servers.push(data.server);
          closeModal();
          renderRail();
          await openServer(data.server.id, data.channels[0] && data.channels[0].id);
          toast(`Вы на сервере «${data.server.name}»`, 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
  );
}

function createChannelModal() {
  if (!state.server) return;
  openModal(
    `<h3>Новый канал</h3>
     <p class="modal-sub">В канале можно общаться на отдельную тему.</p>
     <form class="modal-form" id="chanForm">
       <label class="field">
         <span class="field-label">Название</span>
         <input name="name" maxlength="24" placeholder="например, музыка" autofocus required />
       </label>
       <label class="field">
         <span class="field-label">Описание <span style="text-transform:none">(необязательно)</span></span>
         <input name="topic" maxlength="120" placeholder="О чём этот канал?" />
       </label>
       <div class="modal-actions">
         <button type="button" class="btn btn-ghost" data-close>Отмена</button>
         <button type="submit" class="btn btn-primary">Создать канал</button>
       </div>
     </form>`,
    (root) => {
      root.querySelector('input').focus();
      root.querySelector('#chanForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = root.querySelector('[name=name]').value.trim();
        const topic = root.querySelector('[name=topic]').value.trim();
        try {
          const { channel } = await api(`/servers/${state.server.server.id}/channels`, {
            method: 'POST',
            body: { name, topic },
          });
          closeModal();
          if (!state.server.channels.some((c) => c.id === channel.id)) {
            state.server.channels.push(channel);
            renderSidebar();
          }
          await openChannel(channel.id);
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
  );
}

function inviteModal() {
  const srv = state.server && state.server.server;
  if (!srv) return;
  const link = `${location.origin}/?invite=${srv.invite}`;
  openModal(
    `<h3>Пригласить на «${esc(srv.name)}»</h3>
     <p class="modal-sub">Отправьте код или ссылку — по ним можно вступить на сервер.</p>
     <div class="invite-box">
       <input class="invite-code" id="inviteCode" value="${esc(srv.invite)}" readonly />
       <button class="btn btn-primary" id="copyInvite" style="padding:0 16px">Копировать</button>
     </div>
     <div class="invite-box">
       <input class="invite-code" style="font-size:12px;letter-spacing:0;font-family:var(--font);color:var(--text-dim)" value="${esc(link)}" readonly />
       <button class="btn btn-ghost" id="copyLink" style="padding:0 14px">Ссылка</button>
     </div>
     <div class="modal-actions"><button class="btn btn-ghost" data-close>Закрыть</button></div>`,
    (root) => {
      const copy = (text) => {
        navigator.clipboard.writeText(text).then(
          () => toast('Скопировано', 'ok'),
          () => toast('Не удалось скопировать', 'error')
        );
      };
      root.querySelector('#copyInvite').addEventListener('click', () => copy(srv.invite));
      root.querySelector('#copyLink').addEventListener('click', () => copy(link));
    }
  );
}

function serverMenuModal() {
  const srv = state.server && state.server.server;
  if (!srv) return;
  const isOwner = srv.ownerId === state.me.id;
  openModal(
    `<h3>${esc(srv.name)}</h3>
     <p class="modal-sub">${srv.memberCount} ${plural(srv.memberCount, ['участник', 'участника', 'участников'])} · код ${esc(srv.invite)}</p>
     <div class="modal-actions" style="flex-direction:column;align-items:stretch;gap:8px">
       <button class="btn btn-ghost" id="menuInvite">Пригласить людей</button>
       <button class="btn btn-ghost" id="menuChannel">Создать канал</button>
       ${
         isOwner
           ? '<button class="btn btn-danger" id="menuDelete">Удалить сервер</button>'
           : '<button class="btn btn-danger" id="menuLeave">Покинуть сервер</button>'
       }
       <button class="btn btn-ghost" data-close>Закрыть</button>
     </div>`,
    (root) => {
      root.querySelector('#menuInvite').addEventListener('click', inviteModal);
      root.querySelector('#menuChannel').addEventListener('click', createChannelModal);
      const del = root.querySelector('#menuDelete');
      if (del) del.addEventListener('click', deleteServerFlow);
      const leave = root.querySelector('#menuLeave');
      if (leave) leave.addEventListener('click', leaveServerFlow);
    }
  );
}

async function deleteServerFlow() {
  const srv = state.server && state.server.server;
  if (!srv) return;
  const ok = await confirmModal(
    `Удалить «${srv.name}»?`,
    'Сервер, каналы и вся переписка исчезнут навсегда.',
    'Удалить сервер'
  );
  if (!ok) return;
  try {
    await api(`/servers/${srv.id}`, { method: 'DELETE' });
    state.servers = state.servers.filter((s) => s.id !== srv.id);
    openHome();
    renderRail();
    toast('Сервер удалён', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function leaveServerFlow() {
  const srv = state.server && state.server.server;
  if (!srv) return;
  const ok = await confirmModal(`Покинуть «${srv.name}»?`, 'Вы сможете вернуться по коду приглашения.', 'Покинуть');
  if (!ok) return;
  try {
    await api(`/servers/${srv.id}/leave`, { method: 'POST' });
    state.servers = state.servers.filter((s) => s.id !== srv.id);
    openHome();
    renderRail();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function findUserById(id) {
  if (state.me && state.me.id === id) return state.me;
  if (state.server) {
    const m = state.server.members.find((x) => x.id === id);
    if (m) return m;
  }
  for (const dm of state.dms) {
    if (dm.peer && dm.peer.id === id) return dm.peer;
  }
  for (const m of state.messages) {
    if (m.author && m.author.id === id) return m.author;
  }
  return null;
}

function openProfile(userId) {
  const user = findUserById(userId);
  if (!user) return;
  const isMe = user.id === state.me.id;
  const online = state.online.has(user.id);
  openModal(
    `<div class="profile-head">
       ${avatarHTML(user, { size: 'avatar-lg', online })}
       <div>
         <b>${esc(user.name)}</b>
         <span>@${esc(user.name)}#${esc(user.tag)}</span>
         <span style="display:block;color:${online ? 'var(--ok)' : 'var(--text-mute)'};font-size:12px">
           ${online ? '● в сети' : '○ не в сети'}
         </span>
       </div>
     </div>
     <div class="profile-bio">${esc(user.bio || 'Пользователь пока ничего о себе не рассказал.')}</div>
     <div class="modal-actions">
       <button class="btn btn-ghost" data-close>Закрыть</button>
       ${
         isMe
           ? '<button class="btn btn-primary" id="profileSettings">Настроить профиль</button>'
           : `<button class="btn btn-primary" id="profileDM">Написать сообщение</button>`
       }
     </div>`,
    (root) => {
      if (isMe) root.querySelector('#profileSettings').addEventListener('click', settingsModal);
      else
        root.querySelector('#profileDM').addEventListener('click', () => {
          closeModal();
          startDM(user.id);
        });
    }
  );
}

function settingsModal() {
  const me = state.me;
  openModal(
    `<h3>Настройки профиля</h3>
     <p class="modal-sub">Так вас видят другие участники.</p>
     <form class="modal-form" id="settingsForm">
       <label class="field">
         <span class="field-label">Имя пользователя</span>
         <input name="username" maxlength="20" value="${esc(me.name)}" required />
       </label>
       <label class="field">
         <span class="field-label">О себе</span>
         <textarea name="bio" maxlength="140" placeholder="Пара слов о себе">${esc(me.bio || '')}</textarea>
       </label>
       <div class="field">
         <span class="field-label">Цвет аватара</span>
         <div class="color-row" id="colorRow">
           ${Array.from({ length: 8 })
             .map(
               (_, i) =>
                 `<button type="button" class="c${i} ${i === me.color ? 'is-active' : ''}" data-color="${i}" aria-label="Цвет ${i + 1}"></button>`
             )
             .join('')}
         </div>
       </div>
       <div class="modal-actions">
         <button type="button" class="btn btn-ghost" data-close>Отмена</button>
         <button type="submit" class="btn btn-primary">Сохранить</button>
       </div>
     </form>`,
    (root) => {
      let color = me.color;
      $$('#colorRow button', root).forEach((b) =>
        b.addEventListener('click', () => {
          color = Number(b.dataset.color);
          $$('#colorRow button', root).forEach((x) => x.classList.toggle('is-active', x === b));
        })
      );
      root.querySelector('#settingsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = root.querySelector('[name=username]').value.trim();
        const bio = root.querySelector('[name=bio]').value.trim();
        try {
          const { user } = await api('/me', { method: 'PATCH', body: { username, bio, color } });
          state.me = { ...state.me, ...user };
          closeModal();
          renderUserPanel();
          toast('Профиль обновлён', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
  );
}

/* ------------------------------------------------------------- composer UI */

const EMOJIS = [
  '😀','😄','😁','😅','😂','🤣','🙂','😉','😊','😍','😘','😎','🤔','😴','🥳','😢',
  '😭','😡','🤯','🥺','😱','🤗','😬','🙃','😇','🤩','😋','🤤','🫡','🤝','👍','👎',
  '👏','🙌','🙏','💪','🔥','💯','✨','🎉','🎊','❤️','🧡','💛','💚','💙','💜','🖤',
  '💔','⭐','🌊','⚡','☀️','🌙','🍕','🍔','☕','🍺','🎮','🎧','🎵','📌','✅','❌',
];

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 168) + 'px';
}

function initComposer() {
  const input = $('#composerInput');
  const form = $('#composer');
  let typingSent = 0;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  input.addEventListener('input', () => {
    autoGrow(input);
    if (!state.channel) return;
    const now = Date.now();
    if (now - typingSent > 2200) {
      typingSent = now;
      if (state.socket) state.socket.emit('typing', { channelId: state.channel.id });
    }
  });

  // эмодзи
  const pop = $('#emojiPop');
  pop.innerHTML = EMOJIS.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join('');
  $('#emojiBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    pop.classList.toggle('is-hidden');
  });
  pop.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-emoji]');
    if (!btn) return;
    const emoji = btn.dataset.emoji;
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    input.focus();
    input.selectionStart = input.selectionEnd = start + emoji.length;
    autoGrow(input);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#emojiPop') && !e.target.closest('#emojiBtn')) pop.classList.add('is-hidden');
  });

  const scroller = $('.chat-body');
  scroller.addEventListener('scroll', updateJumpButton);
  $('#jumpBottom').addEventListener('click', () => {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  });
}

/* ------------------------------------------------------------------- init */

function initEvents() {
  $('#homeBtn').addEventListener('click', openHome);
  $('#addServerBtn').addEventListener('click', createServerModal);
  $('#joinServerBtn').addEventListener('click', joinServerModal);

  $('#messages').addEventListener('click', async (e) => {
    const group = e.target.closest('[data-msg]');
    if (group) {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const id = group.dataset.msg;
      const msg = state.messages.find((m) => m.id === id);
      if (btn.dataset.act === 'copy' && msg) {
        navigator.clipboard.writeText(msg.content).then(
          () => toast('Текст скопирован', 'ok'),
          () => toast('Не удалось скопировать', 'error')
        );
      }
      if (btn.dataset.act === 'edit') editMessage(id);
      if (btn.dataset.act === 'delete') deleteMessage(id);
      return;
    }
  });

  const scroller = $('.chat-body');
  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop < 40 && state.hasMore) {
      state.hasMore = false;
      loadOlder();
    }
  });

}

function prefillInvite(code) {
  joinServerModal();
  const input = $('.modal [name=code]');
  if (input) input.value = code;
}

async function init() {
  initAuth();
  initComposer();
  initEvents();

  if (!state.token) return;
  try {
    const { user } = await api('/me');
    state.me = user;
    await boot();
  } catch (err) {
    localStorage.removeItem('volna.token');
    state.token = null;
    state.me = null;
  }
}

init();
