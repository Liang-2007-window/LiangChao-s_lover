// SQLite access. Uses the SQLite build that ships inside Node (node:sqlite),
// so the whole backend runs with zero npm dependencies - important on a
// 2C/2G box where every installed package is extra disk, RAM and attack surface.
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.mjs';

const db = new DatabaseSync(config.dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA cache_size = -8000;
  PRAGMA temp_store = MEMORY;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id        INTEGER PRIMARY KEY,
    name      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS diary (
    id         INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date       TEXT    NOT NULL,
    ct         TEXT    NOT NULL,
    iv         TEXT    NOT NULL,
    tag        TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS diary_acct_date ON diary(account_id, date DESC, id DESC);

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    exp        INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_exp ON sessions(exp);

  CREATE TABLE IF NOT EXISTS login_fails (
    lkey  TEXT PRIMARY KEY,
    n     INTEGER NOT NULL DEFAULT 0,
    last  INTEGER NOT NULL,
    until INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS rate_events (
    key   TEXT    NOT NULL,
    ts    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rate_events_key_ts ON rate_events(key, ts);

  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS email_codes (
    id         INTEGER PRIMARY KEY,
    email      TEXT    NOT NULL,
    account_id INTEGER,
    purpose    TEXT    NOT NULL,
    code_hash  TEXT    NOT NULL,
    exp        INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    used_at    INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS email_codes_lookup ON email_codes(email, purpose, created_at DESC);

  -- The plaza: one shared wall for every signed-in account. Bodies are stored
  -- as plain text on purpose - posts are public by definition, and keeping them
  -- readable means listing a page never has to decrypt 20 payloads.
  CREATE TABLE IF NOT EXISTS plaza (
    id         INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS plaza_account ON plaza(account_id, id DESC);
`);

// ALTER TABLE has no IF NOT EXISTS, so migrations are spelled out and skipped
// once the column is already there - the database is the same file on a dev box
// and on the server, and either may be older than the code.
function hasColumn(table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

if (!hasColumn('accounts', 'email')) db.exec('ALTER TABLE accounts ADD COLUMN email TEXT');
if (!hasColumn('accounts', 'verified')) {
  db.exec('ALTER TABLE accounts ADD COLUMN verified INTEGER NOT NULL DEFAULT 1');
}
if (!hasColumn('accounts', 'updated_at')) db.exec('ALTER TABLE accounts ADD COLUMN updated_at INTEGER');

// NULL emails never collide, so the partial index lets the two legacy accounts
// live without one until they bind an address.
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS accounts_email ON accounts(email COLLATE NOCASE) WHERE email IS NOT NULL'
);

export const stmt = {
  accountByName: db.prepare('SELECT * FROM accounts WHERE name = ?'),
  accountById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
  accountByEmail: db.prepare('SELECT * FROM accounts WHERE email = ? COLLATE NOCASE'),
  accountInsert: db.prepare('INSERT INTO accounts (name, pass_hash, created_at) VALUES (?, ?, ?)'),
  // Open signup: the row exists but stays unverified until the emailed code
  // comes back, so a typo'd address never turns into a working account.
  accountInsertPending: db.prepare(
    'INSERT INTO accounts (name, pass_hash, email, created_at, updated_at, verified) VALUES (?, ?, ?, ?, ?, 0)'
  ),
  accountSetHash: db.prepare('UPDATE accounts SET pass_hash = ?, updated_at = ? WHERE id = ?'),
  accountSetEmail: db.prepare('UPDATE accounts SET email = ?, updated_at = ? WHERE id = ?'),
  accountSetVerified: db.prepare('UPDATE accounts SET verified = 1, updated_at = ? WHERE id = ?'),
  accountSetEmailVerified: db.prepare(
    'UPDATE accounts SET email = ?, verified = 1, updated_at = ? WHERE id = ?'
  ),
  accountDelete: db.prepare('DELETE FROM accounts WHERE id = ?'),
  accountAll: db.prepare('SELECT id, name, email, verified, created_at FROM accounts ORDER BY id'),
  pendingAccounts: db.prepare('SELECT id, name, email FROM accounts WHERE verified = 0 AND created_at < ?'),
  accountBytes: db.prepare('SELECT COALESCE(SUM(LENGTH(ct)), 0) AS n FROM diary WHERE account_id = ?'),

  diaryByAccount: db.prepare(
    'SELECT * FROM diary WHERE account_id = ? ORDER BY date DESC, id DESC'
  ),
  diaryByAccountAsc: db.prepare(
    'SELECT * FROM diary WHERE account_id = ? ORDER BY date ASC, id ASC'
  ),
  diaryById: db.prepare('SELECT * FROM diary WHERE id = ? AND account_id = ?'),
  diaryInsert: db.prepare(
    `INSERT INTO diary (account_id, date, ct, iv, tag, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  diaryUpdate: db.prepare(
    `UPDATE diary SET date = ?, ct = ?, iv = ?, tag = ?, updated_at = ?
     WHERE id = ? AND account_id = ?`
  ),
  diaryDelete: db.prepare('DELETE FROM diary WHERE id = ? AND account_id = ?'),
  diaryCount: db.prepare('SELECT COUNT(*) AS n FROM diary WHERE account_id = ?'),

  sessionInsert: db.prepare(
    'INSERT INTO sessions (token_hash, account_id, exp, created_at) VALUES (?, ?, ?, ?)'
  ),
  sessionGet: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
  sessionTouch: db.prepare('UPDATE sessions SET exp = ? WHERE token_hash = ?'),
  sessionDelete: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  sessionDeleteByAccount: db.prepare('DELETE FROM sessions WHERE account_id = ?'),
  sessionPurge: db.prepare('DELETE FROM sessions WHERE exp <= ?'),

  codeInsert: db.prepare(
    `INSERT INTO email_codes (email, account_id, purpose, code_hash, exp, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ),
  codeLatest: db.prepare(
    `SELECT * FROM email_codes
     WHERE email = ? COLLATE NOCASE AND purpose = ? AND used_at IS NULL
     ORDER BY created_at DESC, id DESC LIMIT 1`
  ),
  codeRecent: db.prepare(
    `SELECT COUNT(*) AS n FROM email_codes
     WHERE email = ? COLLATE NOCASE AND purpose = ? AND created_at > ?`
  ),
  // Cooldown is measured from the last code sent, used or not, so redeeming a
  // code cannot be used to skip the "one per minute" rule.
  codeLastCreated: db.prepare(
    `SELECT created_at FROM email_codes
     WHERE email = ? COLLATE NOCASE AND purpose = ?
     ORDER BY created_at DESC, id DESC LIMIT 1`
  ),
  codeBumpAttempts: db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?'),
  codeMarkUsed: db.prepare('UPDATE email_codes SET used_at = ? WHERE id = ?'),
  codePurge: db.prepare('DELETE FROM email_codes WHERE created_at < ?'),

  failGet: db.prepare('SELECT * FROM login_fails WHERE lkey = ?'),
  failUpsert: db.prepare(
    `INSERT INTO login_fails (lkey, n, last, until) VALUES (?, ?, ?, ?)
     ON CONFLICT(lkey) DO UPDATE SET n = excluded.n, last = excluded.last, until = excluded.until`
  ),
  failClear: db.prepare('DELETE FROM login_fails WHERE lkey = ?'),

  metaGet: db.prepare('SELECT v FROM meta WHERE k = ?'),
  metaSet: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),

  // ------------------------------------------------------------------ plaza
  // id DESC is chronological order (ids only ever grow), so no date column is
  // needed for sorting and the cursor is just "the last id I saw".
  plazaPageLatest: db.prepare(
    `SELECT p.id, p.body, p.created_at, p.account_id, a.name AS author
     FROM plaza p JOIN accounts a ON a.id = p.account_id
     ORDER BY p.id DESC LIMIT ?`
  ),
  plazaPageBefore: db.prepare(
    `SELECT p.id, p.body, p.created_at, p.account_id, a.name AS author
     FROM plaza p JOIN accounts a ON a.id = p.account_id
     WHERE p.id < ? ORDER BY p.id DESC LIMIT ?`
  ),
  plazaInsert: db.prepare('INSERT INTO plaza (account_id, body, created_at) VALUES (?, ?, ?)'),
  plazaById: db.prepare(
    `SELECT p.id, p.body, p.created_at, p.account_id, a.name AS author
     FROM plaza p JOIN accounts a ON a.id = p.account_id WHERE p.id = ?`
  ),
  plazaDeleteOwn: db.prepare('DELETE FROM plaza WHERE id = ? AND account_id = ?'),
  plazaDeleteAny: db.prepare('DELETE FROM plaza WHERE id = ?'),
  plazaCount: db.prepare('SELECT COUNT(*) AS n FROM plaza'),
  plazaLastByAccount: db.prepare(
    'SELECT created_at FROM plaza WHERE account_id = ? ORDER BY id DESC LIMIT 1'
  ),
  plazaRecentByAccount: db.prepare(
    'SELECT COUNT(*) AS n FROM plaza WHERE account_id = ? AND created_at > ?'
  ),
  // Oldest post inside the rolling hour: once it ages out, the account may post
  // again, which is exactly the retryAfter the client gets.
  plazaOldestRecent: db.prepare(
    'SELECT created_at FROM plaza WHERE account_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 1'
  ),
};

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getMeta(k, fallback = null) {
  const row = stmt.metaGet.get(k);
  return row ? row.v : fallback;
}

export function setMeta(k, v) {
  stmt.metaSet.run(k, String(v));
}

export default db;