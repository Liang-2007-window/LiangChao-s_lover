// HTTP entry point: routing, session plumbing, request logging.
// Zero npm dependencies - node:http + node:sqlite + node:crypto only.
import http from 'node:http';
import { config } from './config.mjs';
import { stmt } from './db.mjs';
import {
  clearLoginFailures,
  createSession,
  dropSession,
  hitRate,
  lockState,
  lookupSession,
  noteLoginFailure,
  purgeSessions,
  verifyPassword,
} from './security.mjs';
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
  purgeSessions();
  const token = createSession(account.id);
  setSessionCookie(res, req, token);
  sendJson(res, 200, { user: { name: account.name }, diaryCount: stmt.diaryCount.get(account.id).n });
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
    user: { name: user.name },
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