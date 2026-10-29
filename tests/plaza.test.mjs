// Plaza API tests. Boots the real server in-process against a throwaway DB.
// Run with: node tests/plaza.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORK = path.join(ROOT, '.local', 'test-run-plaza');
const PASSWORD = 'abcd1234';

let base = '';
let server;
let stmt;
let config;

// One cookie per account: the tests check that the plaza is shared, so two
// accounts have to be logged in at the same time.
const jars = new Map();

async function call(who, method, url, { body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  const sid = jars.get(who);
  if (sid) h.cookie = `ld_sid=${sid}`;
  const res = await fetch(`${base}${url}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    const value = pair.slice(eq + 1).trim();
    if (value && !/Max-Age=0/i.test(raw)) jars.set(who, value);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { status: res.status, json, text };
}

async function login(who) {
  const res = await call(who, 'POST', '/api/auth/login', {
    body: { account: who, password: PASSWORD },
  });
  assert.equal(res.status, 200, `login failed for ${who}: ${res.text}`);
  return res;
}

before(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  process.env.LD_DATA_DIR = WORK;
  process.env.LD_DATA_KEY = crypto.randomBytes(32).toString('hex');
  process.env.LD_QUIZ_ANSWER = '刘克';
  process.env.LD_LOG = '0';
  process.env.LD_HOST = '127.0.0.1';
  process.env.LD_PLAZA_COOLDOWN = '0';
  process.env.LD_PLAZA_HOURLY = '100';
  process.env.LD_LOGIN_MAX = '1000';

  ({ server } = await import('../server/index.mjs'));
  ({ stmt } = await import('../server/db.mjs'));
  ({ config } = await import('../server/config.mjs'));
  const { hashPassword } = await import('../server/security.mjs');

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const now = Date.now();
  for (const name of ['Alice', 'Bob']) {
    stmt.accountInsert.run(name, await hashPassword(PASSWORD), now);
  }
});

after(() => {
  server?.close();
});

test('the plaza needs a session', async () => {
  const read = await call(null, 'GET', '/api/plaza');
  assert.equal(read.status, 401);
  const write = await call(null, 'POST', '/api/plaza', { body: { body: 'hi' } });
  assert.equal(write.status, 401);
});

test('a signed-in account can post and gets it back', async () => {
  await login('Alice');
  const res = await call('Alice', 'POST', '/api/plaza', { body: { body: '第一条' } });
  assert.equal(res.status, 201);
  assert.equal(res.json.item.body, '第一条');
  assert.equal(res.json.item.author, 'Alice');
  assert.equal(res.json.item.mine, true);
  assert.ok(res.json.item.id > 0);
  assert.ok(res.json.item.createdAt > 0);
});

test('post text is stored verbatim', async () => {
  const text = '<b>粗体</b> & 第二行\n\n空一行';
  const res = await call('Alice', 'POST', '/api/plaza', { body: { body: text } });
  assert.equal(res.status, 201);
  assert.equal(res.json.item.body, text);
});

test('blank and oversized posts are rejected', async () => {
  const empty = await call('Alice', 'POST', '/api/plaza', { body: { body: '   \n\n ' } });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, 'empty_post');

  const long = await call('Alice', 'POST', '/api/plaza', { body: { body: 'x'.repeat(501) } });
  assert.equal(long.status, 400);
  assert.equal(long.json.error, 'too_long');

  const ok = await call('Alice', 'POST', '/api/plaza', { body: { body: 'x'.repeat(500) } });
  assert.equal(ok.status, 201);
});

test('everyone signed in sees everyone else, and only their own is mine', async () => {
  await login('Bob');
  const res = await call('Bob', 'GET', '/api/plaza?limit=50');
  assert.equal(res.status, 200);
  const fromAlice = res.json.items.filter((item) => item.author === 'Alice');
  assert.ok(fromAlice.length >= 1);
  assert.ok(fromAlice.every((item) => item.mine === false));

  const own = await call('Alice', 'GET', '/api/plaza?limit=50');
  assert.ok(own.json.items.some((item) => item.mine === true));
  assert.equal(typeof res.json.total, 'number');
});

test('a post can only be deleted by its author', async () => {
  const made = await call('Alice', 'POST', '/api/plaza', { body: { body: '要被删的' } });
  const id = made.json.item.id;

  const bobsTurn = await call('Bob', 'DELETE', `/api/plaza/${id}`);
  assert.equal(bobsTurn.status, 404);

  const alicesTurn = await call('Alice', 'DELETE', `/api/plaza/${id}`);
  assert.equal(alicesTurn.status, 200);
  assert.equal(alicesTurn.json.ok, true);

  const again = await call('Alice', 'DELETE', `/api/plaza/${id}`);
  assert.equal(again.status, 404);

  const listed = await call('Alice', 'GET', '/api/plaza?limit=50');
  assert.ok(!listed.json.items.some((item) => item.id === id));
});

test('paging walks back through ids without gaps or repeats', async () => {
  // A fresh account keeps the ids from the tests above out of this page walk.
  const { hashPassword } = await import('../server/security.mjs');
  stmt.accountInsert.run('Pager', await hashPassword(PASSWORD), Date.now());
  await login('Pager');
  const posted = [];
  for (let i = 1; i <= 5; i += 1) {
    const res = await call('Pager', 'POST', '/api/plaza', { body: { body: `p${i}` } });
    assert.equal(res.status, 201);
    posted.push(res.json.item.id);
  }

  const seen = [];
  let before = 0;
  let hasMore = true;
  let pages = 0;
  while (hasMore && pages < 10) {
    const q = `/api/plaza?limit=2${before ? `&before=${before}` : ''}`;
    const res = await call('Pager', 'GET', q);
    assert.equal(res.status, 200);
    seen.push(...res.json.items.map((item) => item.id));
    hasMore = res.json.hasMore;
    if (res.json.items.length) before = res.json.items[res.json.items.length - 1].id;
    pages += 1;
  }

  assert.equal(new Set(seen).size, seen.length, 'no repeats between pages');
  assert.deepEqual(seen, [...seen].sort((a, b) => b - a), 'newest first');
  for (const id of posted) assert.ok(seen.includes(id), `post ${id} was not paged in`);
});

test('posting twice in a row is rate limited', async () => {
  const { hashPassword } = await import('../server/security.mjs');
  stmt.accountInsert.run('Speedy', await hashPassword(PASSWORD), Date.now());
  await login('Speedy');

  const first = await call('Speedy', 'POST', '/api/plaza', { body: { body: '一' } });
  assert.equal(first.status, 201);

  config.plazaCooldownSec = 60;
  try {
    const second = await call('Speedy', 'POST', '/api/plaza', { body: { body: '二' } });
    assert.equal(second.status, 429);
    assert.equal(second.json.error, 'too_fast');
    assert.ok(second.json.retryAfter > 0 && second.json.retryAfter <= 60);
  } finally {
    config.plazaCooldownSec = 0;
  }
});

test('an hourly ceiling applies even without a cooldown', async () => {
  const { hashPassword } = await import('../server/security.mjs');
  stmt.accountInsert.run('Chatty', await hashPassword(PASSWORD), Date.now());
  await login('Chatty');

  config.plazaPerHour = 2;
  try {
    assert.equal((await call('Chatty', 'POST', '/api/plaza', { body: { body: 'a' } })).status, 201);
    assert.equal((await call('Chatty', 'POST', '/api/plaza', { body: { body: 'b' } })).status, 201);
    const third = await call('Chatty', 'POST', '/api/plaza', { body: { body: 'c' } });
    assert.equal(third.status, 429);
    assert.equal(third.json.error, 'too_many');
    assert.ok(third.json.retryAfter > 0 && third.json.retryAfter <= 3600);
  } finally {
    config.plazaPerHour = 100;
  }
});