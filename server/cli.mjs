#!/usr/bin/env node
// Admin CLI. Runs on the server (or locally against a copy of the database).
//
//   node server/cli.mjs add-account <name> <password> [email]
//   node server/cli.mjs set-password <name> <password>
//   node server/cli.mjs set-email <name> <email>
//   node server/cli.mjs import-json <name> <file.json>
//   node server/cli.mjs import-blob <name> <file.enc.json> <password>
//   node server/cli.mjs list
//   node server/cli.mjs backup [dir]
//   node server/cli.mjs prune
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import db, { stmt } from './db.mjs';
import { hashPassword, purgeSessions } from './security.mjs';
import { sealEntry } from './entry.mjs';
import { pruneCodes } from './codes.mjs';

const [, , command, ...args] = process.argv;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function insertDiary(accountId, entry) {
  const sealed = sealEntry(entry);
  const now = Date.now();
  const info = stmt.diaryInsert.run(
    accountId,
    sealed.date,
    sealed.ct,
    sealed.iv,
    sealed.tag,
    now,
    now
  );
  return Number(info.lastInsertRowid);
}

function accountOrDie(name) {
  const row = stmt.accountByName.get(name);
  if (!row) die(`no such account: ${name}`);
  return row;
}

async function addAccount(name, password, email) {
  if (!name || !password) die('usage: add-account <name> <password> [email]');
  if (stmt.accountByName.get(name)) die(`account already exists: ${name}`);
  if (email && stmt.accountByEmail.get(email)) die(`email already used: ${email}`);
  const hash = await hashPassword(password);
  const now = Date.now();
  const info = stmt.accountInsert.run(name, hash, now);
  const id = Number(info.lastInsertRowid);
  if (email) stmt.accountSetEmailVerified.run(email, now, id);
  console.log(`created account ${name} (id ${id})${email ? ` email ${email} (verified)` : ''}`);
}

async function setPassword(name, password) {
  const account = accountOrDie(name);
  const hash = await hashPassword(password);
  stmt.accountSetHash.run(hash, Date.now(), account.id);
  console.log(`password updated for ${name}`);
}

// Bypass for the case where the address itself is lost: admin sets it directly.
function setEmail(name, email) {
  if (!name || !email) die('usage: set-email <name> <email>');
  const account = accountOrDie(name);
  const taken = stmt.accountByEmail.get(email);
  if (taken && taken.id !== account.id) die(`email already used by ${taken.name}`);
  stmt.accountSetEmailVerified.run(String(email).trim().toLowerCase(), Date.now(), account.id);
  console.log(`email for ${name} set to ${email} (verified)`);
}

function listAccounts() {
  for (const a of stmt.accountAll.all()) {
    const n = stmt.diaryCount.get(a.id).n;
    const email = a.email || '-';
    const verified = a.verified ? 'ok' : 'UNVERIFIED';
    console.log(
      `${a.id}\t${a.name}\t${email}\t${verified}\t${n} diaries\tcreated ${new Date(a.created_at).toISOString()}`
    );
  }
}

function importJson(name, file) {
  const account = accountOrDie(name);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.items || raw.list || [];
  if (!list.length) die('empty journal file');
  let inserted = 0;
  for (const entry of list) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date || '')) die(`bad date in ${file}: ${entry.date}`);
    insertDiary(account.id, entry);
    inserted += 1;
  }
  console.log(`imported ${inserted} entries into ${name}`);
}

// --- decrypt the old client-side blob (PBKDF2 + HKDF + AES-GCM) ---------------
// Only needed once, when importing the pre-dynamic diary files. The old config
// is no longer part of the site, so point at it explicitly:
//   LD_AUTH_CONFIG=.local/legacy/auth-config.js node server/cli.mjs import-blob ...
function readAuthConfig() {
  const file = process.env.LD_AUTH_CONFIG || path.join(config.root, 'js', 'auth-config.js');
  if (!fs.existsSync(file)) die(`cannot find ${file} (set LD_AUTH_CONFIG)`);
  const text = fs.readFileSync(file, 'utf8');
  const m = /window\.AUTH_CONFIG\s*=\s*(\{[\s\S]*?\});\s*$/m.exec(text);
  if (!m) die(`cannot parse ${file}`);
  return JSON.parse(m[1]);
}

function decryptLegacyBlob(name, file, password) {
  const cfg = readAuthConfig();
  const key = name.toLowerCase();
  const account = (cfg.accounts || {})[key];
  if (!account) die(`account ${name} missing from auth-config.js`);
  const canon =
    name.normalize('NFKC').trim().toLowerCase() + '\u0000' + password.normalize('NFKC');
  const master = crypto.pbkdf2Sync(canon, Buffer.from(account.salt, 'base64'), account.iter || cfg.iter, 32, 'sha256');
  const infoVerify = Buffer.from('ld/verify/v1');
  const infoAes = Buffer.from('ld/aes/v1');
  const verify = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), infoVerify, 32));
  if (verify.toString('base64') !== account.verify) die('wrong password (verify mismatch)');
  const aesKey = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), infoAes, 32));
  const blob = JSON.parse(fs.readFileSync(file, 'utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(blob.iv, 'base64'));
  decipher.setAAD(Buffer.from('ld-diary-v1'));
  const last = Buffer.from(blob.ct, 'base64');
  // WebCrypto appends the 16-byte tag to the ciphertext; node expects it set apart.
  const ct = last.subarray(0, last.length - 16);
  const tag = last.subarray(last.length - 16);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

function importBlob(name, file, password) {
  const account = accountOrDie(name);
  const entries = decryptLegacyBlob(name, file, password);
  if (!Array.isArray(entries)) die('unexpected blob shape');
  let inserted = 0;
  for (const entry of entries) {
    insertDiary(account.id, entry);
    inserted += 1;
  }
  console.log(`imported ${inserted} legacy entries into ${name}`);
}

function backup(dir) {
  const target = dir || path.join(config.dataDir, 'backups');
  fs.mkdirSync(target, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(target, `liangchao-${stamp}.db`);
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  console.log(`backup written: ${out}`);
}

function prune() {
  purgeSessions();
  pruneCodes();
  // Signups that never confirmed their address only ever held a password hash.
  let dropped = 0;
  const cutoff = Date.now() - config.maxPendingHours * 3600_000;
  for (const row of stmt.pendingAccounts.all(cutoff)) {
    stmt.accountDelete.run(row.id);
    dropped += 1;
  }
  const before = fs.statSync(config.dbFile).size;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const after = fs.statSync(config.dbFile).size;
  console.log(`sessions purged, ${dropped} unverified signups dropped; db size ${before} -> ${after}`);
}

switch (command) {
  case 'add-account':
    await addAccount(args[0], args[1], args[2]);
    break;
  case 'set-password':
    await setPassword(args[0], args[1]);
    break;
  case 'set-email':
    setEmail(args[0], args[1]);
    break;
  case 'import-json':
    importJson(args[0], args[1]);
    break;
  case 'import-blob':
    importBlob(args[0], args[1], args[2]);
    break;
  case 'list':
    listAccounts();
    break;
  case 'backup':
    backup(args[0]);
    break;
  case 'prune':
    prune();
    break;
  default:
    console.log(
      'commands: add-account | set-password | set-email | import-json | import-blob | list | backup | prune'
    );
    process.exit(command ? 1 : 0);
}