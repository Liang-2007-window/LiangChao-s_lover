// Passwords, sessions and at-rest encryption for diary bodies.
// Nothing here touches the network; index.mjs wires it to HTTP.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.mjs';
import { stmt } from './db.mjs';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
// 16384*8*128 bytes = 16 MiB per hash; the cap leaves room for a second
// concurrent login on a 2 GB box instead of letting one request eat 64 MiB.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const AAD = Buffer.from('ld-diary-v2');
const SESSION_BYTES = 32;

function scryptAsync(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      keylen,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  if (salt.length < 8 || expected.length === 0) return false;
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      expected.length,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM },
      (err, out) => (err ? reject(err) : resolve(out))
    );
  }).catch(() => null);
  if (!key || key.length !== expected.length) return false;
  return crypto.timingSafeEqual(key, expected);
}

/* ------------------------------------------------------------------ master key */

let masterKeyCache = null;

export function masterKey() {
  if (masterKeyCache) return masterKeyCache;
  if (config.masterKeyHex) {
    const buf = Buffer.from(config.masterKeyHex, 'hex');
    if (buf.length !== 32) throw new Error('LD_DATA_KEY must be 64 hex characters (32 bytes)');
    masterKeyCache = buf;
    return buf;
  }
  // Fall back to a key file next to the database. Generated once, 0600, and it
  // is the only thing that can decrypt diary bodies - back it up.
  if (fs.existsSync(config.keyFile)) {
    const buf = Buffer.from(fs.readFileSync(config.keyFile, 'utf8').trim(), 'hex');
    if (buf.length !== 32) throw new Error(`bad master key file: ${config.keyFile}`);
    masterKeyCache = buf;
    return buf;
  }
  const buf = crypto.randomBytes(32);
  fs.writeFileSync(config.keyFile, buf.toString('hex') + '\n', { mode: 0o600 });
  masterKeyCache = buf;
  return buf;
}

/* ------------------------------------------------------------ diary encryption */

export function encryptText(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ct: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptText(row) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    masterKey(),
    Buffer.from(row.iv, 'base64')
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(row.ct, 'base64')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

/* -------------------------------------------------------------------- sessions */

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function newSessionToken() {
  return crypto.randomBytes(SESSION_BYTES).toString('base64url');
}

export function createSession(accountId, now = Date.now()) {
  const token = newSessionToken();
  stmt.sessionInsert.run(sha256(token), accountId, now + config.sessionDays * 86400_000, now);
  return token;
}

export function lookupSession(token, now = Date.now()) {
  if (!token) return null;
  const row = stmt.sessionGet.get(sha256(token));
  if (!row) return null;
  if (row.exp <= now) {
    stmt.sessionDelete.run(row.token_hash);
    return null;
  }
  // Sliding expiry, refreshed at most once a day to avoid a write per request.
  if (row.exp - now < (config.sessionDays - 1) * 86400_000) {
    stmt.sessionTouch.run(now + config.sessionDays * 86400_000, row.token_hash);
  }
  return row;
}

export function dropSession(token) {
  if (token) stmt.sessionDelete.run(sha256(token));
}

export function purgeSessions(now = Date.now()) {
  stmt.sessionPurge.run(now);
}

/* ------------------------------------------------- login throttling / rate limit */

export function lockState(lkey, now = Date.now()) {
  const row = stmt.failGet.get(lkey);
  if (!row) return { locked: false, retryAfter: 0, fails: 0 };
  if (row.until > now) {
    return { locked: true, retryAfter: Math.ceil((row.until - now) / 1000), fails: row.n };
  }
  return { locked: false, retryAfter: 0, fails: row.n };
}

export function noteLoginFailure(lkey, now = Date.now()) {
  const row = stmt.failGet.get(lkey);
  const stale = !row || now - row.last > 3600_000;
  const fails = stale ? 1 : row.n + 1;
  // 3 straight misses start the ladder: 15s, 30s, 60s ... capped at 15 minutes.
  let until = 0;
  if (fails >= 3) {
    const step = Math.min(config.lockMaxSec, config.lockBaseSec * 2 ** (fails - 3));
    until = now + step * 1000;
  }
  stmt.failUpsert.run(lkey, fails, now, until);
  return { fails, retryAfter: until ? Math.ceil((until - now) / 1000) : 0 };
}

export function clearLoginFailures(lkey) {
  stmt.failClear.run(lkey);
}

const rateBuckets = new Map();

// In-memory sliding window: enough for quiz submissions and login attempts on a
// single-process server, and it cannot grow without bound thanks to the sweep.
export function hitRate(key, limit, windowMs, now = Date.now()) {
  const cutoff = now - windowMs;
  let list = rateBuckets.get(key);
  if (!list) {
    list = [];
    rateBuckets.set(key, list);
  }
  while (list.length && list[0] <= cutoff) list.shift();
  if (list.length >= limit) {
    return { allowed: false, retryAfter: Math.ceil((list[0] + windowMs - now) / 1000) };
  }
  list.push(now);
  return { allowed: true, retryAfter: 0 };
}

setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [key, list] of rateBuckets) {
    while (list.length && list[0] <= cutoff) list.shift();
    if (!list.length) rateBuckets.delete(key);
  }
}, 5 * 60_000).unref();