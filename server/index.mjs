// HTTP entry point: routing, session plumbing, request logging.
// Zero npm dependencies - node:http + node:sqlite + node:crypto only.
import http from 'node:http';
import { config } from './config.mjs';
import { stmt } from './db.mjs';
import {
  clearLoginFailures,
  createSession,
  dropSession,
  hashPassword,
  hitRate,
  lockState,
  lookupSession,
  noteLoginFailure,
  purgeSessions,
  verifyPassword,
} from './security.mjs';
import { PURPOSES, consumeCode, issueCode, normalizeEmail } from './codes.mjs';
import {
  clientIp,
  cookie,
  originAllowed,
  parseCookies,
  readJson,
  sendJson,
  sendText,
  wantsHttps,
} from './http.mjs';
import { serveStatic } from './static.mjs';
import { openEntry, sealEntry } from './entry.mjs';

const SESSION_COOKIE = 'ld_sid';
const startedAt = Date.now();
// Same shape and cost as a real hash, so a login for a non-existent account
// burns the same CPU time as a wrong password.
const DUMMY_HASH = `scrypt$16384$8$1$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_RE = /^[\w\u4e00-\u9fa5.-]{2,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function fail(status, error, extra = {}) {
  throw Object.assign(new Error(error), { status, payload: { error, ...extra } });
}

function cleanText(value, max, field) {
  if (value === undefined || value === null) return '';
  const s = String(value).replace(/\r\n/g, '\n').trim();
  if (s.length > max) fail(400, 'too_long', { field });
  return s;
}

function validDate(value) {
  if (!DATE_RE.test(value)) fail(400, 'bad_date');
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) fail(400, 'bad_date');
  return value;
}

/* ------------------------------------------------- account field validation */

function checkAccountName(value) {
  const name = cleanText(value, 40, 'account');
  if (!NAME_RE.test(name)) fail(400, 'bad_account');
  return name;
}

// The rule the site promises on its own signup form: at least 8 characters and
// both letters and digits, so "12345678" and "abcdefgh" are both refused.
function checkPassword(value) {
  const password = String(value ?? '');
  if (password.length < config.passwordMin || password.length > config.passwordMax) {
    fail(400, 'weak_password', { min: config.passwordMin });
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) fail(400, 'weak_password');
  return password;
}

function checkEmail(value) {
  const email = normalizeEmail(cleanText(value, 254, 'email'));
  if (!EMAIL_RE.test(email)) fail(400, 'bad_email');
  return email;
}

function publicUser(row) {
  return { name: row.name, email: row.email || null, verified: !!row.verified };
}

function normalizeDiaryInput(input) {
  const date = validDate(String(input.date || '').trim());
  return {
    date,
    title: cleanText(input.title, 80, 'title'),
    weather: cleanText(input.weather, 16, 'weather'),
    mood: cleanText(input.mood, 16, 'mood'),
    body: cleanText(input.body, config.maxDiaryBody, 'body'),
  };
}

function rowToItem(row) {
  return openEntry(row);
}

// Open signup means strangers get rows on a 40 GB disk, so each account has a
// hard cap on both entry count and total ciphertext bytes.
function assertQuota(user) {
  if (stmt.diaryCount.get(user.id).n >= config.maxEntriesPerAccount) {
    fail(409, 'quota_exceeded', { limit: 'entries', max: config.maxEntriesPerAccount });
  }
  if (stmt.accountBytes.get(user.id).n >= config.maxAccountBytes) {
    fail(409, 'quota_exceeded', { limit: 'bytes', max: config.maxAccountBytes });
  }
}

function currentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  const session = lookupSession(token);
  if (!session) return { user: null, token };
  const account = stmt.accountById.get(session.account_id);
  if (!account) return { user: null, token };
  return { user: account, token };
}

function setSessionCookie(res, req, token) {
  res.setHeader(
    'set-cookie',
    cookie(SESSION_COOKIE, token, {
      maxAge: config.sessionDays * 86400,
      secure: wantsHttps(req),
    })
  );
}

function guardWrite(req) {
  if (!originAllowed(req)) fail(403, 'bad_origin');
}

/* ------------------------------------------------------------------- handlers */

async function login(req, res) {
  guardWrite(req);
  const ip = clientIp(req);
  const limit = hitRate(`login:${ip}`, config.loginMaxPerWindow, config.loginWindowSec * 1000);
  if (!limit.allowed) fail(429, 'too_many', { retryAfter: limit.retryAfter });

  const body = await readJson(req);
  const name = cleanText(body.account, 40, 'account');
  const password = String(body.password ?? '');
  if (!name || !password) fail(400, 'missing_credentials');

  const lkey = `${ip}|${name.toLowerCase()}`;
  const lock = lockState(lkey);
  if (lock.locked) fail(429, 'locked', { retryAfter: lock.retryAfter });

  const account = stmt.accountByName.get(name);
  // Always run one hash comparison so "no such account" and "wrong password"
  // take the same time and cannot be told apart by a timing probe.
  let ok = false;
  if (account) ok = await verifyPassword(password, account.pass_hash);
  else await verifyPassword(password, DUMMY_HASH);

  if (!account || !ok) {
    const state = noteLoginFailure(lkey);
    fail(401, 'bad_credentials', state.retryAfter ? { retryAfter: state.retryAfter } : {});
  }

  clearLoginFailures(lkey);
  // A signup whose emailed code never came back is not a usable account yet.
  if (!account.verified) fail(401, 'unverified', { account: account.name, email: account.email });
  purgeSessions();
  const token = createSession(account.id);
  setSessionCookie(res, req, token);
  sendJson(res, 200, { user: publicUser(account), diaryCount: stmt.diaryCount.get(account.id).n });
}

async function logout(req, res) {
  guardWrite(req);
  const { token } = currentUser(req);
  dropSession(token);
  res.setHeader('set-cookie', cookie(SESSION_COOKIE, '', { maxAge: 0 }));
  sendJson(res, 200, { ok: true });
}

async function me(req, res) {
  const { user } = currentUser(req);
  if (!user) return sendJson(res, 200, { user: null });
  sendJson(res, 200, {
    user: publicUser(user),
    diaryCount: stmt.diaryCount.get(user.id).n,
  });
}

async function listDiary(req, res, url) {
  const { user } = currentUser(req);
  if (!user) fail(401, 'unauthorized');
  const order = url.searchParams.get('order') === 'old' ? 'asc' : 'desc';
  const rows =
    order === 'asc'
      ? stmt.diaryByAccountAsc.all(user.id)
      : stmt.diaryByAccount.all(user.id);
  sendJson(res, 200, { order, items: rows.map(rowToItem) });
}

async function createDiary(req, res) {
  guardWrite(req);
  const { user } = currentUser(req);
  if (!user) fail(401, 'unauthorized');
  assertQuota(user);
  const input = normalizeDiaryInput(await readJson(req));
  const now = Date.now();
  const sealed = sealEntry(input);
  const info = stmt.diaryInsert.run(
    user.id,
    input.date,
    sealed.ct,
    sealed.iv,
    sealed.tag,
    now,
    now
  );
  const row = stmt.diaryById.get(Number(info.lastInsertRowid), user.id);
  sendJson(res, 201, { item: rowToItem(row) });
}

async function updateDiary(req, res, id) {
  guardWrite(req);
  const { user } = currentUser(req);
  if (!user) fail(401, 'unauthorized');
  const existing = stmt.diaryById.get(id, user.id);
  if (!existing) fail(404, 'not_found');
  const input = normalizeDiaryInput(await readJson(req));
  const sealed = sealEntry(input);
  stmt.diaryUpdate.run(
    input.date,
    sealed.ct,
    sealed.iv,
    sealed.tag,
    Date.now(),
    id,
    user.id
  );
  sendJson(res, 200, { item: rowToItem(stmt.diaryById.get(id, user.id)) });
}

async function deleteDiary(req, res, id) {
  guardWrite(req);
  const { user } = currentUser(req);
  if (!user) fail(401, 'unauthorized');
  const info = stmt.diaryDelete.run(id, user.id);
  if (!info.changes) fail(404, 'not_found');
  sendJson(res, 200, { ok: true });
}

async function quizAnswer(req, res) {
  guardWrite(req);
  const ip = clientIp(req);
  const limit = hitRate(`quiz:${ip}`, config.quizPerMinute, 60_000);
  if (!limit.allowed) fail(429, 'too_many', { retryAfter: limit.retryAfter });
  const body = await readJson(req);
  const answer = String(body.answer ?? '').trim();
  if (!answer) fail(400, 'empty_answer');
  const ok = answer.toLowerCase() === config.quizAnswer.trim().toLowerCase();
  sendJson(res, 200, { ok });
}

/* -------------------------------------------------- signup, reset, account */

async function register(req, res) {
  guardWrite(req);
  const ip = clientIp(req);
  const limit = hitRate(`register:${ip}`, config.registerMaxPerIpPerHour, 3600_000);
  if (!limit.allowed) fail(429, 'too_many', { retryAfter: limit.retryAfter });

  const body = await readJson(req);
  const name = checkAccountName(body.account);
  const password = checkPassword(body.password);
  const email = checkEmail(body.email);

  if (stmt.accountByName.get(name)) fail(409, 'name_taken');
  if (stmt.accountByEmail.get(email)) fail(409, 'email_taken');

  const hash = await hashPassword(password);
  const now = Date.now();
  let info;
  try {
    info = stmt.accountInsertPending.run(name, hash, email, now, now);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) fail(409, 'name_taken');
    throw err;
  }
  const accountId = Number(info.lastInsertRowid);

  try {
    const sent = await issueCode({ email, accountId, purpose: 'register', name, ip });
    sendJson(res, 201, { pending: true, account: name, email, retryAfter: sent.retryAfter });
  } catch (err) {
    // A signup that never received a code is just debris - drop it so the same
    // name can be tried again instead of being blocked forever.
    stmt.accountDelete.run(accountId);
    throw err;
  }
}

async function verifyEmail(req, res) {
  guardWrite(req);
  const ip = clientIp(req);
  const limit = hitRate(`verify:${ip}`, 20, 60_000);
  if (!limit.allowed) fail(429, 'too_many', { retryAfter: limit.retryAfter });

  const body = await readJson(req);
  const account = stmt.accountByName.get(cleanText(body.account, 40, 'account'));
  // Same generic answer whether the account is missing, already verified or the
  // code is wrong: signup confirmation is not an enumeration oracle.
  if (!account || !account.email) fail(400, 'bad_code');
  if (account.verified) fail(409, 'already_verified');

  consumeCode({ email: account.email, purpose: 'register', code: body.code });
  stmt.accountSetVerified.run(Date.now(), account.id);
  purgeSessions();
  const token = createSession(account.id);
  setSessionCookie(res, req, token);
  sendJson(res, 200, { user: publicUser({ ...account, verified: 1 }), diaryCount: 0 });
}

async function requestCode(req, res) {
  guardWrite(req);
  const ip = clientIp(req);
  const body = await readJson(req);
  const purpose = String(body.purpose || '');
  if (!PURPOSES.has(purpose)) fail(400, 'bad_purpose');

  if (purpose === 'register' || purpose === 'reset') {
    const account = stmt.accountByName.get(cleanText(body.account, 40, 'account'));
    const usable = account && account.email && (purpose === 'register' ? !account.verified : true);
    // Unknown account: answer exactly like a sent code, otherwise this endpoint
    // tells anyone which names exist.
    if (!usable) return sendJson(res, 200, { sent: true, retryAfter: config.codeCooldownSec });
    const sent = await issueCode({
      email: account.email,
      accountId: account.id,
      purpose,
      name: account.name,
      ip,
    });
    return sendJson(res, 200, { sent: true, retryAfter: sent.retryAfter });
  }

  const { user } = currentUser(req);
  if (!user) fail(401, 'unauthorized');
  if (!user.email) fail(400, 'no_email');
  const sent = await issueCode({
    email: user.email,
    accountId: user.id,
    purpose,
    name: user.name,
    ip,
  });
  sendJson(res, 200, { sent: true, retryAfter: sent.retryAfter });
}

async function resetPassword(req, res) {
  guardWrite(req);
  const ip = clientIp(req);
  const limit = hitRate(`reset:${ip}`, 10, 3600_000);
  if (!limit.allowed) fail(429, 'too_many', { retryAfter: limit.retryAfter });

  const body = await readJson(req);
  const account = stmt.accountByName.get(cleanText(body.account, 40, 'account'));
  const password = checkPassword(body.password);
  if (!account || !account.email) fail(400, 'bad_code');

  consumeCode({ email: account.email, purpose: 'reset', code: body.code });
  stmt.accountSetHash.run(await hashPassword(password), Date.now(), account.id);
  // A password reset is also "log me out everywhere", otherwise an attacker who
  // already holds a session keeps it after the victim recovers the account.
  stmt.sessionDeleteByAccount.run(account.id);
  sendJson(res, 200, { ok: true });
}

async function changeEmail(req, res) {
  guardWrite(req);
  const { user } = currentUser(req);
  if (!user) fail(401, 'unauthorized');
  if (!user.email) fail(400, 'no_email');

  const body = await readJson(req);
  const email = checkEmail(body.email);
  const taken = stmt.accountByEmail.get(email);
  if (taken && taken.id !== user.id) fail(409, 'email_taken');

  consumeCode({ email: user.email, purpose: 'change-email', code: body.code });
  try {
    stmt.accountSetEmail.run(email, Date.now(), user.id);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) fail(409, 'email_taken');
    throw err;
  }
  sendJson(res, 200, { user: publicUser({ ...user, email }) });
}

async function changePassword(req, res) {
  guardWrite(req);
  const { user } = currentUser(req);
  if (!user) fail(401, 'unauthorized');
  if (!user.email) fail(400, 'no_email');

  const body = await readJson(req);
  const password = checkPassword(body.password);
  consumeCode({ email: user.email, purpose: 'change-password', code: body.code });

  stmt.accountSetHash.run(await hashPassword(password), Date.now(), user.id);
  // Every other device is signed out; this one gets a brand new token so the
  // old cookie (if leaked) stops working too.
  stmt.sessionDeleteByAccount.run(user.id);
  setSessionCookie(res, req, createSession(user.id));
  sendJson(res, 200, { ok: true });
}

async function health(req, res) {
  const mem = process.memoryUsage();
  sendJson(res, 200, {
    ok: true,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    rssMb: Math.round(mem.rss / 1048576),
    node: process.version,
  });
}

/* --------------------------------------------------------------------- router */

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  if (path === '/api/health' && method === 'GET') return health(req, res);
  if (path === '/api/auth/login' && method === 'POST') return login(req, res);
  if (path === '/api/auth/logout' && method === 'POST') return logout(req, res);
  if (path === '/api/auth/me' && method === 'GET') return me(req, res);
  if (path === '/api/auth/register' && method === 'POST') return register(req, res);
  if (path === '/api/auth/verify-email' && method === 'POST') return verifyEmail(req, res);
  if (path === '/api/auth/code' && method === 'POST') return requestCode(req, res);
  if (path === '/api/auth/reset' && method === 'POST') return resetPassword(req, res);
  if (path === '/api/account/email' && method === 'PUT') return changeEmail(req, res);
  if (path === '/api/account/password' && method === 'PUT') return changePassword(req, res);
  if (path === '/api/diary' && method === 'GET') return listDiary(req, res, url);
  if (path === '/api/diary' && method === 'POST') return createDiary(req, res);
  if (path === '/api/quiz/answer' && method === 'POST') return quizAnswer(req, res);

  const m = /^\/api\/diary\/(\d+)$/.exec(path);
  if (m) {
    const id = Number(m[1]);
    if (method === 'PUT' || method === 'PATCH') return updateDiary(req, res, id);
    if (method === 'DELETE') return deleteDiary(req, res, id);
  }

  fail(404, 'not_found');
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  res.on('finish', () => {
    if (process.env.LD_LOG === '0') return;
    const ms = Date.now() - t0;
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        m: req.method,
        u: req.url,
        s: res.statusCode,
        ms,
        ip: clientIp(req),
      })
    );
  });

  try {
    if (req.url.startsWith('/api/')) {
      await route(req, res);
      return;
    }
    if (config.serveStatic && serveStatic(req, res, req.url)) return;
    sendText(res, 404, 'not found');
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('handler error:', err);
    if (!res.headersSent) {
      sendJson(res, status, err.payload || { error: status >= 500 ? 'server_error' : 'bad_request' });
    } else {
      res.end();
    }
  }
});

// 2C/2G: keep the process small and predictable.
server.keepAliveTimeout = 20_000;
server.headersTimeout = 25_000;

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.mjs')) {
  server.listen(config.port, config.host, () => {
    console.log(
      `liangchao api listening on http://${config.host}:${config.port} ` +
        `(data: ${config.dataDir}, static: ${config.serveStatic ? 'on' : 'off'})`
    );
  });
}

export { server, route };