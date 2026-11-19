'use strict';

/**
 * Дымовой тест: поднимает сервер на временной базе и проверяет
 * основные сценарии — регистрацию, серверы, каналы, сообщения,
 * личные сообщения и realtime-доставку через Socket.IO.
 *
 * Запуск: npm test
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volna-test-'));

let passed = 0;
const ok = (cond, label) => {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
};

async function call(pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}/api${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connected = (socket) =>
  new Promise((resolve, reject) => {
    if (socket.connected) return resolve();
    const timer = setTimeout(() => reject(new Error('timeout: connect')), 3000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
  });

const once = (socket, event, timeout = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${event}`)), timeout);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch (_) {
      /* ещё не поднялся */
    }
    await wait(100);
  }
  throw new Error('сервер не поднялся');
}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), VOLNA_DATA: tmpDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForServer();
    console.log('\nAPI');

    const alice = (await call('/register', { method: 'POST', body: { username: 'alice', password: 'pass1234' } })).data;
    const bob = (await call('/register', { method: 'POST', body: { username: 'bob', password: 'pass1234' } })).data;
    ok(alice.token && bob.token, 'регистрация двух пользователей');
    ok(alice.user.tag.length === 4, 'выдан четырёхзначный тег');

    const boot = (await call('/bootstrap', { token: alice.token })).data;
    ok(boot.servers.length === 1, 'стартовый сервер создан автоматически');

    const detail = (await call(`/servers/${boot.servers[0].id}`, { token: alice.token })).data;
    ok(detail.channels.length === 2, 'в стартовом сервере два канала');
    const channel = detail.channels[0];

    const joined = await call('/servers/join', {
      method: 'POST',
      body: { code: boot.servers[0].invite },
      token: bob.token,
    });
    ok(joined.status === 200, 'вступление по коду приглашения');

    const dup = await call('/servers/join', {
      method: 'POST',
      body: { code: boot.servers[0].invite },
      token: bob.token,
    });
    ok(dup.status === 400, 'повторное вступление отклонено');

    const sent = await call(`/channels/${channel.id}/messages`, {
      method: 'POST',
      body: { content: 'Привет!' },
      token: alice.token,
    });
    ok(sent.status === 200 && sent.data.message.content === 'Привет!', 'отправка сообщения');

    const empty = await call(`/channels/${channel.id}/messages`, {
      method: 'POST',
      body: { content: '   ' },
      token: alice.token,
    });
    ok(empty.status === 400, 'пустое сообщение отклонено');

    const history = (await call(`/channels/${channel.id}/messages`, { token: bob.token })).data;
    ok(history.messages.some((m) => m.content === 'Привет!'), 'история доступна участнику сервера');

    const outsider = (await call('/register', { method: 'POST', body: { username: 'eve', password: 'pass1234' } })).data;
    const denied = await call(`/channels/${channel.id}/messages`, { token: outsider.token });
    ok(denied.status === 404, 'посторонний не читает канал');

    const dm = (await call('/dm', { method: 'POST', body: { userId: bob.user.id }, token: alice.token })).data.dm;
    ok(dm && dm.peer.name === 'bob', 'личный диалог создан');
    const dm2 = (await call('/dm', { method: 'POST', body: { userId: alice.user.id }, token: bob.token })).data.dm;
    ok(dm2.id === dm.id, 'повторный DM не дублируется');

    console.log('\nRealtime');
    const sA = io(BASE, { auth: { token: alice.token }, transports: ['websocket'] });
    const readyA = once(sA, 'ready', 5000);
    const sB = io(BASE, { auth: { token: bob.token }, transports: ['websocket'] });
    const readyB = once(sB, 'ready', 5000);
    await Promise.all([connected(sA), connected(sB)]);
    ok(true, 'оба клиента подключились к сокету');

    await Promise.all([readyA, readyB]);
    ok(true, 'сервер прислал ready со списком онлайна');

    const presence = once(sA, 'presence');
    const sC = io(BASE, { auth: { token: outsider.token }, transports: ['websocket'] });
    const p = await presence;
    ok(p.online === true && p.userId === outsider.user.id, 'событие presence о новом онлайне');
    sC.disconnect();

    const delivery = once(sB, 'message:new');
    await call(`/channels/${channel.id}/messages`, {
      method: 'POST',
      body: { content: 'реалтайм' },
      token: alice.token,
    });
    const got = await delivery;
    ok(got.message.content === 'реалтайм' && got.message.author.name === 'alice', 'сообщение доставлено второму участнику в реальном времени');

    const typing = once(sB, 'typing');
    sA.emit('typing', { channelId: channel.id });
    const t = await typing;
    ok(t.channelId === channel.id && t.user.name === 'alice', 'индикатор набора текста');

    const dmArrival = once(sB, 'message:new');
    await call(`/channels/${dm.id}/messages`, { method: 'POST', body: { content: 'в личку' }, token: alice.token });
    const dmGot = await dmArrival;
    ok(dmGot.message.content === 'в личку', 'личное сообщение доставлено адресату');

    const channelEvent = once(sB, 'channel:created');
    await call(`/servers/${boot.servers[0].id}/channels`, { method: 'POST', body: { name: 'музыка' }, token: alice.token });
    const chEvent = await channelEvent;
    ok(chEvent.channel.name === 'музыка', 'создание канала разослано участникам');

    const dupChannel = await call(`/servers/${boot.servers[0].id}/channels`, {
      method: 'POST',
      body: { name: 'музыка' },
      token: alice.token,
    });
    ok(dupChannel.status === 409, 'дубликат канала отклонён');

    sA.disconnect();
    sB.disconnect();

    console.log(`\nВсе проверки пройдены: ${passed}`);
  } finally {
    child.kill('SIGTERM');
    await wait(200);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
