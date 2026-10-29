// End-to-end API tests. Boots the real server in-process against a throwaway DB.
// Run with: node tests/api.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORK = path.join(ROOT, '.local', 'test-run');
const jar = new Map();

let base = '';
let server;
let db;
let stmt;

async function call(method, url, { body, headers = {}, cookies = true } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (cookies && jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(`${base}${url}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === '' || /Max-Age=0/i.test(raw)) jar.delete(name);
    else jar.set(name, value);
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

before(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  process.env.LD_DATA_DIR = WORK;
  process.env.LD_DATA_KEY = crypto.randomBytes(32).toString('hex');
  process.env.LD_QUIZ_ANSWER = '刘克';
  process.env.LD_LOG = '0';
  process.env.LD_HOST = '127.0.0.1';

  ({ server } = await import('../server/index.mjs'));
  ({ default: db, stmt } = await import('../server/db.mjs'));
  const { hashPassword } = await import('../server/security.mjs');

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  stmt.accountInsert.run('liuke', await hashPassword('20050721'), Date.now());
});

after(() => {
  server?.close();
});

test('health endpoint answers', async () => {
  const res = await call('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
});

test('quiz answer is validated server-side', async () => {
  const wrong = await call('POST', '/api/quiz/answer', { body: { answer: '随便猜' } });
  assert.equal(wrong.status, 200);
  assert.equal(wrong.json.ok, false);
  const right = await call('POST', '/api/quiz/answer', { body: { answer: '刘克' } });
  assert.equal(right.json.ok, true);
});

test('quiz rejects cross-origin callers', async () => {
  const res = await call('POST', '/api/quiz/answer', {
    body: { answer: '刘克' },
    headers: { origin: 'http://evil.example' },
  });
  assert.equal(res.status, 403);
});

test('diary list requires a session', async () => {
  const res = await call('GET', '/api/diary');
  assert.equal(res.status, 401);
});

test('login rejects a wrong password', async () => {
  const bad = await call('POST', '/api/auth/login', {
    body: { account: 'liuke', password: 'nope' },
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, 'bad_credentials');
});

test('login works, session persists, CRUD works', async () => {
  const ok = await call('POST', '/api/auth/login', {
    body: { account: 'liuke', password: '20050721' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.name, 'liuke');
  assert.ok(jar.get('ld_sid'), 'session cookie set');

  const me = await call('GET', '/api/auth/me');
  assert.equal(me.json.user.name, 'liuke');

  const created = await call('POST', '/api/diary', {
    body: { date: '2026-10-20', title: '测试标题', weather: '晴', mood: '好', body: '第一段\n\n第二段' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.item.body, '第一段\n\n第二段');

  const id = created.json.item.id;
  const listed = await call('GET', '/api/diary');
  assert.equal(listed.json.items.length, 1);
  assert.equal(listed.json.items[0].title, '测试标题');

  const updated = await call('PUT', `/api/diary/${id}`, {
    body: { date: '2026-10-21', title: '改过', weather: '', mood: '', body: '新正文' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.item.title, '改过');
  assert.equal(updated.json.item.date, '2026-10-21');

  const removed = await call('DELETE', `/api/diary/${id}`);
  assert.equal(removed.status, 200);
  const after = await call('GET', '/api/diary');
  assert.equal(after.json.items.length, 0);
});

test('diary body is encrypted at rest', async () => {
  await call('POST', '/api/diary', {
    body: { date: '2026-10-22', title: '密文检查', body: '这篇文章不应该以明文落库' },
  });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const parts = ['liangchao.db', 'liangchao.db-wal']
    .map((f) => path.join(WORK, f))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f));
  const raw = Buffer.concat(parts);
  assert.equal(raw.includes(Buffer.from('这篇文章不应该以明文落库')), false);
  assert.equal(raw.includes(Buffer.from('密文检查')), false);
});

test('validation rejects bad dates and oversized bodies', async () => {
  const badDate = await call('POST', '/api/diary', { body: { date: '2026-13-40', body: 'x' } });
  assert.equal(badDate.status, 400);
  const tooLong = await call('POST', '/api/diary', {
    body: { date: '2026-10-23', body: 'x'.repeat(100001) },
  });
  assert.equal(tooLong.status, 400);
});

test('one account cannot read another account diary', async () => {
  const first = await call('GET', '/api/diary');
  const owned = first.json.items.length;
  assert.ok(owned >= 1);
  await call('POST', '/api/auth/logout');

  const { hashPassword } = await import('../server/security.mjs');
  const { stmt } = await import('../server/db.mjs');
  stmt.accountInsert.run('yangquan', await hashPassword('20000728'), Date.now());

  const login = await call('POST', '/api/auth/login', {
    body: { account: 'yangquan', password: '20000728' },
  });
  assert.equal(login.status, 200);
  const mine = await call('GET', '/api/diary');
  assert.equal(mine.json.items.length, 0);
});

test('logout clears the session', async () => {
  const out = await call('POST', '/api/auth/logout');
  assert.equal(out.status, 200);
  const me = await call('GET', '/api/auth/me');
  assert.equal(me.json.user, null);
  const list = await call('GET', '/api/diary');
  assert.equal(list.status, 401);
});