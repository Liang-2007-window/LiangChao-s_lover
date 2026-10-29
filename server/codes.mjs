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

  const cooldown = secondsUntilResend(address, purpose, now);
  if (cooldown > 0) fail(429, 'too_soon', { retryAfter: cooldown });

  const recent = stmt.codeRecent.get(address, purpose, now - 3600_000).n;
  if (recent >= config.codeMaxPerEmailPerHour) fail(429, 'too_many', { retryAfter: 600 });

  const perIp = hitRate(`code:${ip || 'unknown'}`, config.codeMaxPerIpPerHour, 3600_000, now);
  if (!perIp.allowed) fail(429, 'too_many', { retryAfter: perIp.retryAfter });

  const code = generateCode();
  stmt.codeInsert.run(
    address,
    accountId,
    purpose,
    codeHash(address, purpose, code),
    now + config.codeTtlSec * 1000,
    now
  );

  // If the mail cannot be sent the row stays behind and simply expires; the
  // caller retries after the cooldown.
  await sendCode({ to: address, code, purpose, name });
  return { retryAfter: config.codeCooldownSec, ttl: config.codeTtlSec };
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