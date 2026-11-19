'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const MAX_MESSAGE = 2000;
const COLORS = 8;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));

/* ------------------------------------------------------------------ utils */

const rand = (n) => crypto.randomBytes(n).toString('hex');
const uid = (prefix) => `${prefix}_${rand(8)}`;
const now = () => Date.now();
const norm = (s) => String(s == null ? '' : s).trim();

function hashPassword(password, salt = rand(16)) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function publicUser(u) {
  if (!u) return { id: 'deleted', name: 'Удалённый', tag: '0000', color: 0 };
  return {
    id: u.id,
    name: u.name,
    tag: u.tag,
    color: u.color,
    bio: u.bio || '',
    createdAt: u.createdAt,
  };
}

function publicServer(s) {
  return {
    id: s.id,
    name: s.name,
    ownerId: s.ownerId,
    invite: s.invite,
    color: s.color,
    memberCount: s.members.length,
    createdAt: s.createdAt,
  };
}

function enrichMessage(m) {
  const author = db.data.users.find((u) => u.id === m.userId);
  const isSystem = m.userId === 'system';
  return {
    id: m.id,
    channelId: m.channelId,
    userId: m.userId,
    content: m.content,
    createdAt: m.createdAt,
    editedAt: m.editedAt || null,
    system: isSystem,
    author: isSystem
      ? { id: 'system', name: 'Волна', tag: '', color: 0 }
      : publicUser(author),
  };
}

function channelSummary(ch) {
  const last = [...db.data.messages].reverse().find((m) => m.channelId === ch.id);
  return {
    id: ch.id,
    serverId: ch.serverId,
    name: ch.name,
    topic: ch.topic || '',
    createdAt: ch.createdAt,
    lastMessage: last ? enrichMessage(last) : null,
  };
}

function normChannelName(raw) {
  return norm(raw)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_.-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
}

function normalizeTag(tag) {
  return String(tag || '').padStart(4, '0');
}

function findUser(identifier) {
  if (!identifier) return null;
  const raw = String(identifier).trim().replace(/^@/, '');
  const [name, tag] = raw.split('#');
  const lower = name.toLowerCase();
  const matches = db.data.users.filter((u) => u.name.toLowerCase() === lower);
  if (!matches.length) return null;
  if (tag) return matches.find((u) => u.tag === normalizeTag(tag)) || null;
  return matches[0];
}

function serverOfChannel(ch) {
  if (!ch || !ch.serverId) return null;
  return db.data.servers.find((s) => s.id === ch.serverId) || null;
}

function canAccessChannel(user, ch) {
  if (!ch) return false;
  if (ch.serverId) {
    const s = serverOfChannel(ch);
    return !!s && s.members.includes(user.id);
  }
  return Array.isArray(ch.members) && ch.members.includes(user.id);
}

function serverFor(userId, serverId) {
  const s = db.data.servers.find((x) => x.id === serverId);
  if (!s || !s.members.includes(userId)) return null;
  return s;
}

function dmPeers(ch, meId) {
  return ch.members.filter((id) => id !== meId);
}

function dmPayload(ch, meId) {
  const peerId = dmPeers(ch, meId)[0];
  const peer = db.data.users.find((u) => u.id === peerId);
  return {
    id: ch.id,
    serverId: null,
    name: peer ? `${peer.name}#${peer.tag}` : 'Удалённый',
    createdAt: ch.createdAt,
    lastMessage: (() => {
      const last = [...db.data.messages].reverse().find((m) => m.channelId === ch.id);
      return last ? enrichMessage(last) : null;
    })(),
    peer: peer ? publicUser(peer) : null,
  };
}

function roomFor(ch) {
  return ch.serverId ? `server:${ch.serverId}` : `dm:${ch.id}`;
}

function createSession(userId) {
  const token = rand(32);
  db.data.sessions[token] = { userId, createdAt: now() };
  db.touch();
  return token;
}

function authFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return resolveToken(token);
}

function resolveToken(token) {
  if (!token) return null;
  const session = db.data.sessions[token];
  if (!session) return null;
  return db.data.users.find((u) => u.id === session.userId) || null;
}

function requireAuth(req, res, next) {
  const user = authFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Требуется авторизация' });
  req.user = user;
  req.token = req.headers.authorization.slice(7);
  next();
}

/* -------------------------------------------------------------------------
 * Presence
 * ---------------------------------------------------------------------- */

const socketsByUser = new Map(); // userId -> Set<socketId>

function isOnline(userId) {
  return socketsByUser.has(userId) && socketsByUser.get(userId).size > 0;
}

function onlineIds() {
  return [...socketsByUser.keys()].filter(isOnline);
}

function trackSocket(userId, socketId) {
  if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
  const set = socketsByUser.get(userId);
  const wasOnline = set.size > 0;
  set.add(socketId);
  return !wasOnline;
}

function untrackSocket(userId, socketId) {
  const set = socketsByUser.get(userId);
  if (!set) return false;
  set.delete(socketId);
  if (set.size === 0) {
    socketsByUser.delete(userId);
    return true;
  }
  return false;
}

/* -------------------------------------------------------------------------
 * Auth API
 * ---------------------------------------------------------------------- */

app.post('/api/register', (req, res) => {
  const name = norm(req.body && req.body.username);
  const password = String((req.body && req.body.password) || '');

  if (!/^[\p{L}\p{N}_.-]{2,20}$/u.test(name)) {
    return res.status(400).json({
      error: 'Имя: 2–20 символов, буквы, цифры, точка, дефис или подчёркивание',
    });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Пароль должен быть не короче 4 символов' });
  }
  if (db.data.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'Такое имя уже занято' });
  }

  const { salt, hash } = hashPassword(password);
  const user = {
    id: uid('u'),
    name,
    tag: String(1000 + Math.floor(Math.random() * 9000)),
    color: Math.floor(Math.random() * COLORS),
    bio: '',
    salt,
    hash,
    createdAt: now(),
  };
  db.data.users.push(user);

  // стартовый сервер, чтобы человек сразу попал в живой интерфейс
  const channelGeneral = {
    id: uid('c'),
    serverId: null,
    name: 'общий',
    topic: 'Добро пожаловать! Здесь всё начинается.',
    createdAt: now(),
  };
  const channelFlood = {
    id: uid('c'),
    serverId: null,
    name: 'флудилка',
    topic: 'Мемы, музыка, всё подряд.',
    createdAt: now(),
  };
  const startServer = {
    id: uid('s'),
    name: `${name} · дом`,
    ownerId: user.id,
    invite: rand(4),
    color: user.color,
    members: [user.id],
    createdAt: now(),
  };
  channelGeneral.serverId = startServer.id;
  channelFlood.serverId = startServer.id;

  db.data.servers.push(startServer);
  db.data.channels.push(channelGeneral, channelFlood);

  db.data.messages.push({
    id: uid('m'),
    channelId: channelGeneral.id,
    userId: 'system',
    content: `Сервер «${startServer.name}» создан. Пригласи друзей по коду ${startServer.invite} — и начните болтать.`,
    createdAt: now(),
    system: true,
  });

  const token = createSession(user.id);
  db.touch();
  res.json({ token, user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const name = norm(req.body && req.body.username);
  const password = String((req.body && req.body.password) || '');
  const user = db.data.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: 'Неверное имя или пароль' });
  }
  res.json({ token: createSession(user.id), user: publicUser(user) });
});

app.post('/api/logout', requireAuth, (req, res) => {
  delete db.data.sessions[req.token];
  db.touch();
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.patch('/api/me', requireAuth, (req, res) => {
  const body = req.body || {};
  if (typeof body.bio === 'string') req.user.bio = body.bio.slice(0, 140);
  if (Number.isInteger(body.color)) req.user.color = ((body.color % COLORS) + COLORS) % COLORS;
  if (typeof body.username === 'string') {
    const name = norm(body.username);
    if (!/^[\p{L}\p{N}_.-]{2,20}$/u.test(name)) {
      return res.status(400).json({ error: 'Некорректное имя' });
    }
    const taken = db.data.users.some(
      (u) => u.id !== req.user.id && u.name.toLowerCase() === name.toLowerCase()
    );
    if (taken) return res.status(409).json({ error: 'Такое имя уже занято' });
    req.user.name = name;
  }
  db.touch();
  res.json({ user: publicUser(req.user) });
});

/* -------------------------------------------------------------------------
 * Bootstrap / servers / channels
 * ---------------------------------------------------------------------- */

app.get('/api/bootstrap', requireAuth, (req, res) => {
  const me = req.user;
  const servers = db.data.servers
    .filter((s) => s.members.includes(me.id))
    .map(publicServer)
    .sort((a, b) => a.createdAt - b.createdAt);
  const dms = db.data.channels
    .filter((c) => !c.serverId && c.members.includes(me.id))
    .map((c) => dmPayload(c, me.id))
    .sort((a, b) => (b.lastMessage ? b.lastMessage.createdAt : b.createdAt) - (a.lastMessage ? a.lastMessage.createdAt : a.createdAt));

  res.json({ user: publicUser(me), servers, dms, online: onlineIds() });
});

app.get('/api/servers/:id', requireAuth, (req, res) => {
  const s = serverFor(req.user.id, req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  const channels = db.data.channels
    .filter((c) => c.serverId === s.id)
    .map(channelSummary)
    .sort((a, b) => a.createdAt - b.createdAt);
  const members = s.members
    .map((id) => db.data.users.find((u) => u.id === id))
    .filter(Boolean)
    .map((u) => ({ ...publicUser(u), online: isOnline(u.id), owner: u.id === s.ownerId }));

  res.json({ server: publicServer(s), channels, members });
});

app.post('/api/servers', requireAuth, (req, res) => {
  const name = norm(req.body && req.body.name);
  if (name.length < 2 || name.length > 32) {
    return res.status(400).json({ error: 'Название сервера: от 2 до 32 символов' });
  }
  const s = {
    id: uid('s'),
    name,
    ownerId: req.user.id,
    invite: rand(4),
    color: Math.floor(Math.random() * COLORS),
    members: [req.user.id],
    createdAt: now(),
  };
  const ch = {
    id: uid('c'),
    serverId: s.id,
    name: 'общий',
    topic: '',
    createdAt: now(),
  };
  db.data.servers.push(s);
  db.data.channels.push(ch);
  db.touch();

  io.in(`user:${req.user.id}`).socketsJoin(`server:${s.id}`);
  res.json({ server: publicServer(s), channel: channelSummary(ch) });
});

app.post('/api/servers/join', requireAuth, (req, res) => {
  const code = norm(req.body && req.body.code).toLowerCase();
  const s = db.data.servers.find((x) => x.invite === code);
  if (!s) return res.status(404).json({ error: 'Приглашение не найдено' });
  if (s.members.includes(req.user.id)) {
    return res.status(400).json({ error: 'Вы уже на этом сервере' });
  }
  s.members.push(req.user.id);
  db.touch();

  const channels = db.data.channels.filter((c) => c.serverId === s.id);
  const sockets = io.in(`user:${req.user.id}`);
  sockets.socketsJoin(`server:${s.id}`);
  io.to(`server:${s.id}`).emit('member:joined', {
    serverId: s.id,
    user: { ...publicUser(req.user), online: true, owner: false },
  });

  res.json({
    server: publicServer(s),
    channels: channels.map(channelSummary).sort((a, b) => a.createdAt - b.createdAt),
  });
});

app.post('/api/servers/:id/leave', requireAuth, (req, res) => {
  const s = serverFor(req.user.id, req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  if (s.ownerId === req.user.id) {
    return res.status(400).json({ error: 'Владелец не может покинуть сервер — удалите его' });
  }
  s.members = s.members.filter((id) => id !== req.user.id);
  db.touch();
  io.in(`user:${req.user.id}`).socketsLeave(`server:${s.id}`);
  res.json({ ok: true });
});

app.delete('/api/servers/:id', requireAuth, (req, res) => {
  const s = db.data.servers.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  if (s.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Удалять сервер может только владелец' });
  }
  const channelIds = db.data.channels.filter((c) => c.serverId === s.id).map((c) => c.id);
  db.data.channels = db.data.channels.filter((c) => c.serverId !== s.id);
  db.data.messages = db.data.messages.filter((m) => !channelIds.includes(m.channelId));
  db.data.servers = db.data.servers.filter((x) => x.id !== s.id);
  db.touch();
  io.to(`server:${s.id}`).emit('server:deleted', { serverId: s.id });
  res.json({ ok: true });
});

app.post('/api/servers/:id/channels', requireAuth, (req, res) => {
  const s = serverFor(req.user.id, req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  const name = normChannelName(req.body && req.body.name);
  if (name.length < 1) {
    return res.status(400).json({ error: 'Название канала: буквы, цифры, дефис' });
  }
  if (db.data.channels.some((c) => c.serverId === s.id && c.name === name)) {
    return res.status(409).json({ error: 'Такой канал уже есть' });
  }
  const ch = {
    id: uid('c'),
    serverId: s.id,
    name,
    topic: norm(req.body && req.body.topic).slice(0, 120),
    createdAt: now(),
  };
  db.data.channels.push(ch);
  db.touch();
  const summary = channelSummary(ch);
  io.to(`server:${s.id}`).emit('channel:created', { serverId: s.id, channel: summary });
  res.json({ channel: summary });
});

app.delete('/api/channels/:id', requireAuth, (req, res) => {
  const ch = db.data.channels.find((c) => c.id === req.params.id);
  if (!ch || !ch.serverId) return res.status(404).json({ error: 'Канал не найден' });
  const s = serverOfChannel(ch);
  if (!s || !s.members.includes(req.user.id)) {
    return res.status(403).json({ error: 'Нет доступа' });
  }
  if (s.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Удалять каналы может только владелец сервера' });
  }
  db.data.channels = db.data.channels.filter((c) => c.id !== ch.id);
  db.data.messages = db.data.messages.filter((m) => m.channelId !== ch.id);
  db.touch();
  io.to(`server:${s.id}`).emit('channel:deleted', { serverId: s.id, channelId: ch.id });
  res.json({ ok: true });
});

/* -------------------------------------------------------------------------
 * Messages
 * ---------------------------------------------------------------------- */

app.get('/api/channels/:id/messages', requireAuth, (req, res) => {
  const ch = db.data.channels.find((c) => c.id === req.params.id);
  if (!canAccessChannel(req.user, ch)) return res.status(404).json({ error: 'Канал не найден' });

  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = Number(req.query.before) || Infinity;
  const list = db.data.messages
    .filter((m) => m.channelId === ch.id && m.createdAt < before)
    .sort((a, b) => a.createdAt - b.createdAt);

  const slice = list.slice(-limit);
  res.json({
    messages: slice.map(enrichMessage),
    hasMore: list.length > slice.length,
  });
});

app.post('/api/channels/:id/messages', requireAuth, (req, res) => {
  const ch = db.data.channels.find((c) => c.id === req.params.id);
  if (!canAccessChannel(req.user, ch)) return res.status(404).json({ error: 'Канал не найден' });

  const content = String((req.body && req.body.content) || '').replace(/\s+$/g, '');
  if (!content.trim()) return res.status(400).json({ error: 'Пустое сообщение' });
  if (content.length > MAX_MESSAGE) return res.status(400).json({ error: 'Слишком длинное сообщение' });

  const msg = {
    id: uid('m'),
    channelId: ch.id,
    userId: req.user.id,
    content,
    createdAt: now(),
  };
  db.data.messages.push(msg);
  db.touch();

  const payload = enrichMessage(msg);
  io.to(roomFor(ch)).emit('message:new', { message: payload });
  res.json({ message: payload });
});

app.patch('/api/messages/:id', requireAuth, (req, res) => {
  const msg = db.data.messages.find((m) => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  const ch = db.data.channels.find((c) => c.id === msg.channelId);
  if (!canAccessChannel(req.user, ch)) return res.status(403).json({ error: 'Нет доступа' });
  if (msg.userId !== req.user.id) return res.status(403).json({ error: 'Можно править только свои сообщения' });

  const content = String((req.body && req.body.content) || '').trim();
  if (!content) return res.status(400).json({ error: 'Пустое сообщение' });
  if (content.length > MAX_MESSAGE) return res.status(400).json({ error: 'Слишком длинное сообщение' });

  msg.content = content;
  msg.editedAt = now();
  db.touch();
  io.to(roomFor(ch)).emit('message:update', { message: enrichMessage(msg) });
  res.json({ message: enrichMessage(msg) });
});

app.delete('/api/messages/:id', requireAuth, (req, res) => {
  const msg = db.data.messages.find((m) => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  const ch = db.data.channels.find((c) => c.id === msg.channelId);
  if (!canAccessChannel(req.user, ch)) return res.status(403).json({ error: 'Нет доступа' });

  const srv = serverOfChannel(ch);
  const canModerate = srv && srv.ownerId === req.user.id;
  if (msg.userId !== req.user.id && !canModerate) {
    return res.status(403).json({ error: 'Нет прав на удаление' });
  }

  db.data.messages = db.data.messages.filter((m) => m.id !== msg.id);
  db.touch();
  io.to(roomFor(ch)).emit('message:delete', { channelId: ch.id, messageId: msg.id });
  res.json({ ok: true });
});

/* -------------------------------------------------------------------------
 * Direct messages & users
 * ---------------------------------------------------------------------- */

app.post('/api/dm', requireAuth, (req, res) => {
  const targetId = req.body && req.body.userId;
  if (targetId === req.user.id) return res.status(400).json({ error: 'Это вы' });
  const target = db.data.users.find((u) => u.id === targetId);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  let ch = db.data.channels.find(
    (c) => !c.serverId && c.members.length === 2 && c.members.includes(req.user.id) && c.members.includes(target.id)
  );
  if (!ch) {
    ch = { id: uid('c'), serverId: null, name: '', topic: '', members: [req.user.id, target.id], createdAt: now() };
    db.data.channels.push(ch);
    db.touch();
    io.in(`user:${req.user.id}`).socketsJoin(`dm:${ch.id}`);
    io.in(`user:${target.id}`).socketsJoin(`dm:${ch.id}`);
    io.to(`user:${target.id}`).emit('dm:created', { dm: dmPayload(ch, target.id) });
  }
  res.json({ dm: dmPayload(ch, req.user.id) });
});

app.get('/api/users', requireAuth, (req, res) => {
  const q = norm(req.query.q).toLowerCase();
  if (q.length < 1) return res.json({ users: [] });
  const users = db.data.users
    .filter((u) => u.id !== req.user.id && `${u.name}#${u.tag}`.toLowerCase().includes(q))
    .slice(0, 12)
    .map((u) => ({
      ...publicUser(u),
      online: isOnline(u.id),
      dm: (() => {
        const ch = db.data.channels.find(
          (c) => !c.serverId && c.members.length === 2 && c.members.includes(req.user.id) && c.members.includes(u.id)
        );
        return ch ? ch.id : null;
      })(),
    }));
  res.json({ users });
});

/* -------------------------------------------------------------------------
 * Sockets
 * ---------------------------------------------------------------------- */

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const session = token && db.data.sessions[token];
  if (!session) return next(new Error('unauthorized'));
  const user = db.data.users.find((u) => u.id === session.userId);
  if (!user) return next(new Error('unauthorized'));
  socket.data.userId = user.id;
  socket.data.token = token;
  next();
});

io.on('connection', (socket) => {
  const user = db.data.users.find((u) => u.id === socket.data.userId);
  if (!user) return socket.disconnect(true);

  socket.join(`user:${user.id}`);
  for (const s of db.data.servers) {
    if (s.members.includes(user.id)) socket.join(`server:${s.id}`);
  }
  for (const c of db.data.channels) {
    if (!c.serverId && c.members.includes(user.id)) socket.join(`dm:${c.id}`);
  }

  const firstSocket = trackSocket(user.id, socket.id);
  if (firstSocket) io.emit('presence', { userId: user.id, online: true });

  socket.emit('ready', { online: onlineIds() });

  let typingTimer = null;

  socket.on('typing', (payload) => {
    const channelId = payload && payload.channelId;
    const ch = db.data.channels.find((c) => c.id === channelId);
    if (!canAccessChannel(user, ch)) return;

    socket.to(roomFor(ch)).emit('typing', { channelId, user: publicUser(user) });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      socket.to(roomFor(ch)).emit('typing:stop', { channelId, userId: user.id });
    }, 4000);
  });

  socket.on('disconnect', () => {
    clearTimeout(typingTimer);
    if (untrackSocket(user.id, socket.id)) {
      io.emit('presence', { userId: user.id, online: false });
    }
  });
});

/* ------------------------------------------------------------------ static */

app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Волна слушает http://0.0.0.0:${PORT}`);
});
