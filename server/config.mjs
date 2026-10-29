// Central configuration. Everything comes from environment variables (or a
// KEY=VALUE .env file) so the same checkout runs locally and on the server.
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(process.env.LD_ENV_FILE || path.join(ROOT, 'server', '.env'));

const dataDir = path.resolve(process.env.LD_DATA_DIR || path.join(ROOT, '.data'));
fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  root: ROOT,
  dataDir,
  dbFile: path.join(dataDir, 'liangchao.db'),
  keyFile: path.join(dataDir, 'master.key'),
  port: Number(process.env.LD_PORT || 3000),
  host: process.env.LD_HOST || '127.0.0.1',
  // Static file serving is only for local development; on the server nginx does it.
  serveStatic: process.env.LD_SERVE_STATIC === '1',
  quizAnswer: process.env.LD_QUIZ_ANSWER || '刘克',
  sessionDays: Number(process.env.LD_SESSION_DAYS || 14),
  loginWindowSec: Number(process.env.LD_LOGIN_WINDOW ?? 60),
  loginMaxPerWindow: Number(process.env.LD_LOGIN_MAX ?? 5),
  lockBaseSec: 15,
  lockMaxSec: 900,
  quizPerMinute: Number(process.env.LD_QUIZ_PER_MINUTE ?? 6),
  maxBodyBytes: 256 * 1024,
  maxDiaryBody: 100000,
  masterKeyHex: process.env.LD_DATA_KEY || '',

  // ---------------------------------------------------------------- mail / codes
  // Outbound mail goes through an ordinary SMTP mailbox (QQ mail by default).
  // Port 25 is blocked by the cloud provider; 465 (implicit TLS) and 587 work.
  smtpHost: process.env.LD_SMTP_HOST || 'smtp.qq.com',
  smtpPort: Number(process.env.LD_SMTP_PORT || 465),
  // 1 = implicit TLS on connect (465). 0 = plaintext, only for the fake SMTP
  // server the tests spin up.
  smtpTls: process.env.LD_SMTP_TLS !== '0',
  smtpUser: process.env.LD_SMTP_USER || '',
  smtpPass: process.env.LD_SMTP_PASS || '',
  mailFrom: process.env.LD_MAIL_FROM || process.env.LD_SMTP_USER || '',
  mailFromName: process.env.LD_MAIL_FROM_NAME || '我们的小站',
  // With no SMTP account configured, print the code to stdout instead of
  // failing - so local development never needs a real mailbox.
  devMail: process.env.LD_DEV_MAIL === '1',

  codeTtlSec: 600, // a code lives 10 minutes
  codeCooldownSec: Number(process.env.LD_CODE_COOLDOWN ?? 60),
  // Rate-limit windows are 15 minutes, not an hour: the envelope is what stops
  // abuse, but an hour-long lockout is what makes someone wait 3000 seconds
  // because a mail got lost. Worst case here is a 15 minute wait.
  codeWindowSec: Number(process.env.LD_CODE_WINDOW ?? 900),
  codeMaxPerEmailPerWindow: Number(process.env.LD_CODE_HOURLY ?? 5),
  codeMaxPerIpPerWindow: Number(process.env.LD_CODE_IP_HOURLY ?? 10),
  codeMaxSendFailures: 3, // failed SMTP attempts do not burn the quota above
  codeMaxAttempts: 5,
  registerMaxPerIpPerWindow: Number(process.env.LD_REG_HOURLY ?? 3),
  mailTimeoutMs: 10_000,
  mailMaxConcurrent: 2,

  passwordMin: 8,
  passwordMax: 64,

  // Per-account caps: open signup means anyone can create rows, so the storage
  // has to be bounded somewhere or a 40 GB disk is somebody else's quota.
  maxEntriesPerAccount: 500,
  maxAccountBytes: 5 * 1024 * 1024,
  maxPendingHours: 24,

  // ---------------------------------------------------------------- plaza
  // The plaza is a shared wall: every signed-in account reads every post. There
  // is no per-account storage cap because each post is at most a few hundred
  // characters; the cooldown and the hourly ceiling are what keep it sane.
  plazaMaxLen: Number(process.env.LD_PLAZA_MAXLEN ?? 500),
  plazaCooldownSec: Number(process.env.LD_PLAZA_COOLDOWN ?? 20),
  plazaWindowSec: Number(process.env.LD_PLAZA_WINDOW ?? 900),
  plazaMaxPerWindow: Number(process.env.LD_PLAZA_HOURLY ?? 20),
  plazaPageSize: Number(process.env.LD_PLAZA_PAGE ?? 20),
};