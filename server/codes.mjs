// One-time email codes: issue, verify, expire.
//
// Only a SHA-256 of the code is stored, so a leaked database copy does not hand
// out working codes; the short TTL, the 5-attempt cap and the send rate limits
// are what make a 6-digit space safe to use at all.
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { stmt } from './db.mjs';
import { hitRate, sha256 } from './security.mjs';
import { sendCode } from './mail.mjs';

export const PURPOSES = new Set(['register', 'reset', 'change-email', 'change-password']);

function fail(status, error, extra = {}) {
  throw Object.assign(new Error(error), { status, payload: { error, ...extra } });
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function codeHash(email, purpose, code) {
  return sha256(`${email}|${purpose}|${code}`);
}

function sameHash(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function secondsUntilResend(email, purpose, now = Date.now()) {
  const row = stmt.codeLastCreated.get(normalizeEmail(email), purpose);
  if (!row) return 0;
  const ready = row.created_at + config.codeCooldownSec * 1000;
  return ready > now ? Math.ceil((ready - now) / 1000) : 0;
}

export async function issueCode({ email, accountId = null, purpose, name = '', ip = '' }) {
  if (!PURPOSES.has(purpose)) fail(400, 'bad_purpose');
  const address = normalizeEmail(email);
  const now = Date.now();
  const windowMs = config.codeWindowSec * 1000;

  const cooldown = secondsUntilResend(address, purpose, now);
  if (cooldown > 0) fail(429, 'too_soon', { retryAfter: cooldown });

  const recent = stmt.codeRecent.get(address, purpose, now - windowMs).n;
  if (recent >= config.codeMaxPerEmailPerWindow) {
    const oldest = stmt.codeOldestRecent.get(address, purpose, now - windowMs);
    const wait = oldest ? oldest.created_at + windowMs - now : windowMs;
    fail(429, 'too_many', { retryAfter: Math.ceil(wait / 1000) });
  }

  const perIp = hitRate(`code:${ip || 'unknown'}`, config.codeMaxPerIpPerWindow, windowMs, now);
  if (!perIp.allowed) fail(429, 'too_many', { retryAfter: perIp.retryAfter });

  // Broken SMTP is our fault, not the visitor's: failed sends are counted in
  // their own bucket so we neither hammer the mailbox nor punish the user, and a
  // successful send is never charged to it.
  const failWait = sendFailureWait(address, now, windowMs);
  if (failWait > 0) fail(429, 'mail_unavailable', { retryAfter: failWait });

  const code = generateCode();
  const info = stmt.codeInsert.run(
    address,
    accountId,
    purpose,
    codeHash(address, purpose, code),
    now + config.codeTtlSec * 1000,
    now
  );

  try {
    await sendCode({ to: address, code, purpose, name });
  } catch (err) {
    // Roll the row back, otherwise a mail that never arrived still costs the
    // user a slot and pushes their wait towards a 50 minute lockout.
    stmt.codeDelete.run(Number(info.lastInsertRowid));
    noteSendFailure(address, now, windowMs);
    throw err;
  }
  return { retryAfter: config.codeCooldownSec, ttl: config.codeTtlSec };
}

// Failed SMTP attempts per address. In memory on purpose: a restart clears it,
// which is exactly what you want once the mailbox has been fixed.
const sendFailures = new Map();

function sendFailureWait(address, now, windowMs) {
  const list = (sendFailures.get(address) || []).filter((t) => t > now - windowMs);
  if (list.length) sendFailures.set(address, list);
  else sendFailures.delete(address);
  if (list.length < config.codeMaxSendFailures) return 0;
  return Math.ceil((list[0] + windowMs - now) / 1000);
}

function noteSendFailure(address, now, windowMs) {
  const list = (sendFailures.get(address) || []).filter((t) => t > now - windowMs);
  list.push(now);
  sendFailures.set(address, list);
  if (sendFailures.size > 500) sendFailures.clear();
}

export function consumeCode({ email, purpose, code }) {
  if (!PURPOSES.has(purpose)) fail(400, 'bad_purpose');
  const address = normalizeEmail(email);
  const row = stmt.codeLatest.get(address, purpose);
  if (!row) fail(400, 'bad_code');
  if (row.exp <= Date.now()) fail(410, 'code_expired');
  if (row.attempts >= config.codeMaxAttempts) fail(409, 'too_many_attempts');

  if (!sameHash(codeHash(address, purpose, String(code ?? '').trim()), row.code_hash)) {
    stmt.codeBumpAttempts.run(row.id);
    const left = config.codeMaxAttempts - (row.attempts + 1);
    fail(400, 'bad_code', left <= 0 ? { locked: true } : { attemptsLeft: left });
  }

  stmt.codeMarkUsed.run(Date.now(), row.id);
  return row;
}

export function pruneCodes(now = Date.now()) {
  stmt.codePurge.run(now - 24 * 3600_000);
}