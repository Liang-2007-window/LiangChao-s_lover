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
  loginWindowSec: 60,
  loginMaxPerWindow: 5,
  lockBaseSec: 15,
  lockMaxSec: 900,
  quizPerMinute: 6,
  maxBodyBytes: 256 * 1024,
  maxDiaryBody: 100000,
  masterKeyHex: process.env.LD_DATA_KEY || '',
};