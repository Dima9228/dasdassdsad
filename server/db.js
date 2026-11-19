'use strict';

/**
 * Крошечная JSON-база с атомарной записью на диск.
 * Никаких нативных зависимостей — данные лежат в data/db.json.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.VOLNA_DATA
  ? path.resolve(process.env.VOLNA_DATA)
  : path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');

function empty() {
  return { users: [], servers: [], channels: [], messages: [], sessions: {} };
}

let data = empty();
let dirty = false;
let flushing = null;

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    data = Object.assign(empty(), parsed);
    for (const key of ['users', 'servers', 'channels', 'messages']) {
      if (!Array.isArray(data[key])) data[key] = [];
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[db] не удалось прочитать базу, начинаю с пустой:', err.message);
    }
    data = empty();
  }
  return data;
}

function writeNow() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('[db] ошибка записи:', err.message);
    dirty = true;
  }
}

function touch() {
  dirty = true;
  if (!flushing) {
    flushing = setTimeout(() => {
      flushing = null;
      writeNow();
    }, 250);
    if (flushing.unref) flushing.unref();
  }
}

function flush() {
  if (flushing) {
    clearTimeout(flushing);
    flushing = null;
  }
  writeNow();
}

load();

process.on('SIGINT', () => {
  flush();
  process.exit(0);
});
process.on('SIGTERM', () => {
  flush();
  process.exit(0);
});

module.exports = {
  get data() {
    return data;
  },
  touch,
  flush,
  reload: load,
};
