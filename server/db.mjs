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
`);

export const stmt = {
  accountByName: db.prepare('SELECT * FROM accounts WHERE name = ?'),
  accountById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
  accountInsert: db.prepare('INSERT INTO accounts (name, pass_hash, created_at) VALUES (?, ?, ?)'),
  accountSetHash: db.prepare('UPDATE accounts SET pass_hash = ? WHERE id = ?'),
  accountAll: db.prepare('SELECT id, name, created_at FROM accounts ORDER BY id'),

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
  sessionPurge: db.prepare('DELETE FROM sessions WHERE exp <= ?'),

  failGet: db.prepare('SELECT * FROM login_fails WHERE lkey = ?'),
  failUpsert: db.prepare(
    `INSERT INTO login_fails (lkey, n, last, until) VALUES (?, ?, ?, ?)
     ON CONFLICT(lkey) DO UPDATE SET n = excluded.n, last = excluded.last, until = excluded.until`
  ),
  failClear: db.prepare('DELETE FROM login_fails WHERE lkey = ?'),

  metaGet: db.prepare('SELECT v FROM meta WHERE k = ?'),
  metaSet: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
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