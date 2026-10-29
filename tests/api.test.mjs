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
let devOutbox = [];

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
  // No real mailbox here: codes go to the in-memory dev outbox.
  process.env.LD_DEV_MAIL = '1';
  process.env.LD_CODE_COOLDOWN = '0';
  process.env.LD_CODE_HOURLY = '100';
  process.env.LD_CODE_IP_HOURLY = '100';
  process.env.LD_REG_HOURLY = '100';
  process.env.LD_LOGIN_MAX = '1000';
  process.env.LD_QUIZ_PER_MINUTE = '1000';
  process.env.LD_PLAZA_COOLDOWN = '0';
  process.env.LD_PLAZA_HOURLY = '100';

  ({ server } = await import('../server/index.mjs'));
  ({ default: db, stmt } = await import('../server/db.mjs'));
  const { hashPassword } = await import('../server/security.mjs');
  ({ devOutbox } = await import('../server/mail.mjs'));

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  stmt.accountInsert.run('liuke', await hashPassword('20050721'), Date.now());
});

// Latest dev-mode code for an address + purpose (null when none was sent).
function lastCode(email, purpose) {
  for (let i = devOutbox.length - 1; i >= 0; i -= 1) {
    const item = devOutbox[i];
    if (item.to === email && item.purpose === purpose) return item.code;
  }
  return null;
}

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

/* ------------------------------------------------------- signup and account */

test('registration validates name, password strength and email shape', async () => {
  const noDigit = await call('POST', '/api/auth/register', {
    body: { account: 'weak1', password: 'abcdefgh', email: 'weak1@example.com' },
  });
  assert.equal(noDigit.status, 400);
  assert.equal(noDigit.json.error, 'weak_password');

  const noLetter = await call('POST', '/api/auth/register', {
    body: { account: 'weak2', password: '12345678', email: 'weak2@example.com' },
  });
  assert.equal(noLetter.status, 400);
  assert.equal(noLetter.json.error, 'weak_password');

  const tooShort = await call('POST', '/api/auth/register', {
    body: { account: 'weak3', password: 'a1', email: 'weak3@example.com' },
  });
  assert.equal(tooShort.status, 400);

  const badEmail = await call('POST', '/api/auth/register', {
    body: { account: 'weak4', password: 'abcd1234', email: 'not-an-email' },
  });
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.json.error, 'bad_email');

  const badName = await call('POST', '/api/auth/register', {
    body: { account: 'a', password: 'abcd1234', email: 'ok@example.com' },
  });
  assert.equal(badName.status, 400);
  assert.equal(badName.json.error, 'bad_account');
});

test('signup is pending until the emailed code comes back', async () => {
  const res = await call('POST', '/api/auth/register', {
    body: { account: 'Newbie', password: 'abcd1234', email: 'Newbie@Example.com' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.pending, true);
  assert.equal(res.json.email, 'newbie@example.com', 'email is lower-cased');

  // The address is stored, never echoed back to an anonymous caller via login.
  const early = await call('POST', '/api/auth/login', {
    body: { account: 'newbie', password: 'abcd1234' },
  });
  assert.equal(early.status, 401);
  assert.equal(early.json.error, 'unverified');

  // A fresh account of the same name cannot be created while it is pending.
  const again = await call('POST', '/api/auth/register', {
    body: { account: 'newbie', password: 'abcd1234', email: 'other@example.com' },
  });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'name_taken');

  const code = lastCode('newbie@example.com', 'register');
  assert.match(code, /^\d{6}$/);

  const wrong = await call('POST', '/api/auth/verify-email', {
    body: { account: 'newbie', code: '000000' === code ? '111111' : '000000' },
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error, 'bad_code');

  const ok = await call('POST', '/api/auth/verify-email', {
    body: { account: 'newbie', code },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.name, 'Newbie');
  assert.equal(ok.json.user.verified, true);
  assert.equal(ok.json.user.email, 'newbie@example.com');
  assert.ok(jar.get('ld_sid'), 'verifying signs you in');

  const me = await call('GET', '/api/auth/me');
  assert.equal(me.json.user.verified, true);
  assert.equal(me.json.user.email, 'newbie@example.com');

  const reused = await call('POST', '/api/auth/verify-email', {
    body: { account: 'newbie', code },
  });
  assert.equal(reused.status, 409);
  assert.equal(reused.json.error, 'already_verified');

  const login = await call('POST', '/api/auth/login', {
    body: { account: 'newbie', password: 'abcd1234' },
  });
  assert.equal(login.status, 200);
});

test('a new account starts with an empty diary of its own', async () => {
  const list = await call('GET', '/api/diary');
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 0);
});

test('reset asks for a code and reports unknown accounts like known ones', async () => {
  const unknown = await call('POST', '/api/auth/code', {
    body: { purpose: 'reset', account: 'nobody-here' },
  });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.sent, true, 'unknown account must not be enumerable');

  const known = await call('POST', '/api/auth/code', {
    body: { purpose: 'reset', account: 'newbie' },
  });
  assert.equal(known.status, 200);
  assert.equal(known.json.sent, true);
  assert.ok(lastCode('newbie@example.com', 'reset'));
});

test('reset changes the password and kills existing sessions', async () => {
  const code = lastCode('newbie@example.com', 'reset');

  const weak = await call('POST', '/api/auth/reset', {
    body: { account: 'newbie', code, password: 'short' },
  });
  assert.equal(weak.status, 400);
  assert.equal(weak.json.error, 'weak_password');

  const wrong = await call('POST', '/api/auth/reset', {
    body: { account: 'newbie', code: code === '000000' ? '111111' : '000000', password: 'abcd9999' },
  });
  assert.equal(wrong.status, 400);

  // still logged in from the verification step, until the reset happens
  const before = await call('GET', '/api/auth/me');
  assert.ok(before.json.user);

  const ok = await call('POST', '/api/auth/reset', {
    body: { account: 'newbie', code, password: 'abcd9999' },
  });
  assert.equal(ok.status, 200);

  const me = await call('GET', '/api/auth/me');
  assert.equal(me.json.user, null, 'old sessions are revoked');
  jar.clear();

  const oldPass = await call('POST', '/api/auth/login', {
    body: { account: 'newbie', password: 'abcd1234' },
  });
  assert.equal(oldPass.status, 401);

  const newPass = await call('POST', '/api/auth/login', {
    body: { account: 'newbie', password: 'abcd9999' },
  });
  assert.equal(newPass.status, 200);
});

test('changing email requires the code sent to the current address', async () => {
  // Give another account an address so the uniqueness check has something to hit.
  const { stmt } = await import('../server/db.mjs');
  const liuke = stmt.accountByName.get('liuke');
  stmt.accountSetEmailVerified.run('taken@example.com', Date.now(), liuke.id);

  const sent = await call('POST', '/api/auth/code', { body: { purpose: 'change-email' } });
  assert.equal(sent.status, 200);
  const code = lastCode('newbie@example.com', 'change-email');
  assert.ok(code);

  const taken = await call('PUT', '/api/account/email', {
    body: { email: 'taken@example.com', code },
  });
  assert.equal(taken.status, 409);
  assert.equal(taken.json.error, 'email_taken');

  const ok = await call('PUT', '/api/account/email', {
    body: { email: 'newbie2@example.com', code },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.email, 'newbie2@example.com');
});

test('changing the password needs both the code and the strength rule', async () => {
  await call('POST', '/api/auth/code', { body: { purpose: 'change-password' } });
  const code = lastCode('newbie2@example.com', 'change-password');
  assert.ok(code, 'code goes to the current address');

  const weak = await call('PUT', '/api/account/password', {
    body: { password: 'abcdefgh', code: 'wrong!' },
  });
  assert.equal(weak.status, 400);

  const ok = await call('PUT', '/api/account/password', {
    body: { password: 'zzzz1234', code },
  });
  assert.equal(ok.status, 200);
  assert.ok(jar.get('ld_sid'), 'the current device stays signed in');

  const me = await call('GET', '/api/auth/me');
  assert.equal(me.json.user.name, 'Newbie');

  await call('POST', '/api/auth/logout');
  const login = await call('POST', '/api/auth/login', {
    body: { account: 'newbie', password: 'zzzz1234' },
  });
  assert.equal(login.status, 200);
});

test('an account cannot store more entries than its quota', async () => {
  const { hashPassword } = await import('../server/security.mjs');
  const { stmt } = await import('../server/db.mjs');
  const { sealEntry } = await import('../server/entry.mjs');
  const { config } = await import('../server/config.mjs');

  stmt.accountInsert.run('bulk', await hashPassword('bulk1234'), Date.now());
  const bulk = stmt.accountByName.get('bulk');
  const sealed = sealEntry({ date: '2026-01-01', title: 't', body: 'b' });
  for (let i = 0; i < config.maxEntriesPerAccount; i += 1) {
    stmt.diaryInsert.run(bulk.id, sealed.date, sealed.ct, sealed.iv, sealed.tag, Date.now(), Date.now());
  }

  await call('POST', '/api/auth/logout');
  const login = await call('POST', '/api/auth/login', {
    body: { account: 'bulk', password: 'bulk1234' },
  });
  assert.equal(login.status, 200);

  const over = await call('POST', '/api/diary', {
    body: { date: '2026-01-02', title: 'x', body: 'y' },
  });
  assert.equal(over.status, 409);
  assert.equal(over.json.error, 'quota_exceeded');
});

test('a mail that never leaves costs neither the quota nor the cooldown', async () => {
  const { config } = await import('../server/config.mjs');
  await call('POST', '/api/auth/logout');
  const saved = { ...config };
  // Point the SMTP client at a closed port: the send fails instantly, which is
  // the "server says sent, mailbox stays empty" case from the other direction.
  Object.assign(config, {
    codeCooldownSec: 60,
    smtpUser: 'nobody@example.com',
    smtpPass: 'x',
    smtpHost: '127.0.0.1',
    smtpPort: 1,
    smtpTls: false,
  });
  try {
    const body = { account: 'MailFail', email: 'fail@example.com', password: 'abc12345' };
    const first = await call('POST', '/api/auth/register', { body });
    assert.equal(first.status, 503);
    assert.equal(first.json.error, 'mail_unavailable');
    // The pending row is debris when no code went out, and the code row must be
    // gone too - otherwise the 60s cooldown starts for a mail nobody got.
    assert.equal(stmt.accountByName.get('MailFail'), undefined);
    assert.equal(stmt.codeLastCreated.get('fail@example.com', 'register'), undefined);

    config.smtpUser = ''; // back to the in-memory dev outbox
    const second = await call('POST', '/api/auth/register', { body });
    assert.equal(second.status, 201);
    assert.equal(second.json.pending, true);
  } finally {
    Object.assign(config, {
      codeCooldownSec: saved.codeCooldownSec,
      codeMaxPerEmailPerWindow: saved.codeMaxPerEmailPerWindow,
      smtpUser: saved.smtpUser,
      smtpPass: saved.smtpPass,
      smtpHost: saved.smtpHost,
      smtpPort: saved.smtpPort,
      smtpTls: saved.smtpTls,
    });
  }
});

test('code limits are bounded by a 15 minute window', async () => {
  const { hashPassword } = await import('../server/security.mjs');
  const { config } = await import('../server/config.mjs');

  stmt.accountInsert.run('Quota', await hashPassword('abc12345'), Date.now());
  const quota = stmt.accountByName.get('Quota');
  stmt.accountSetEmailVerified.run('quota@example.com', Date.now(), quota.id);

  const saved = { ...config };
  Object.assign(config, { codeCooldownSec: 0, codeMaxPerEmailPerWindow: 2 });
  try {
    const body = { purpose: 'reset', account: 'Quota' };
    assert.equal((await call('POST', '/api/auth/code', { body })).status, 200);
    assert.equal((await call('POST', '/api/auth/code', { body })).status, 200);
    const third = await call('POST', '/api/auth/code', { body });
    assert.equal(third.status, 429);
    assert.equal(third.json.error, 'too_many');
    // The old code answered "wait up to an hour", which the page printed as
    // "3000 seconds later". Never again.
    assert.ok(third.json.retryAfter > 0);
    assert.ok(
      third.json.retryAfter <= config.codeWindowSec,
      `retryAfter ${third.json.retryAfter}s exceeds the ${config.codeWindowSec}s window`
    );
  } finally {
    Object.assign(config, {
      codeCooldownSec: saved.codeCooldownSec,
      codeMaxPerEmailPerWindow: saved.codeMaxPerEmailPerWindow,
    });
  }
});