// Outbound mail for verification codes.
//
// Hand-rolled SMTP instead of nodemailer: the whole backend runs with zero npm
// dependencies, and all this actually needs is "connect, AUTH LOGIN, one
// message, QUIT". Port 25 is blocked by the cloud provider, so the default is
// implicit TLS on 465.
import net from 'node:net';
import tls from 'node:tls';
import { config } from './config.mjs';

/* ------------------------------------------------------------------ encoding */

function encodeHeaderWord(value) {
  // RFC 2047: a raw UTF-8 Subject is often decoded as garbage or scored as spam.
  return `=?UTF-8?B?${Buffer.from(String(value), 'utf8').toString('base64')}?=`;
}

function base64Lines(text) {
  const b64 = Buffer.from(String(text), 'utf8').toString('base64');
  const out = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out;
}

function buildMessage({ to, subject, text }) {
  const from = config.mailFrom;
  const headers = [
    `From: ${encodeHeaderWord(config.mailFromName)} <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeaderWord(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = base64Lines(text).map((line) => (line.startsWith('.') ? `.${line}` : line));
  return `${headers.join('\r\n')}\r\n\r\n${body.join('\r\n')}\r\n`;
}

/* ------------------------------------------------------------------- session */

const MAX_REPLY_BYTES = 16 * 1024;

function mailError(message = 'mail_unavailable') {
  return Object.assign(new Error(message), {
    status: 503,
    payload: { error: 'mail_unavailable' },
  });
}

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.waiter = null;
    this.failure = null;
    this.closed = false;

    socket.setTimeout(config.mailTimeoutMs, () => this.fail(new Error('smtp timeout')));
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      if (this.buffer.length > MAX_REPLY_BYTES) this.fail(new Error('smtp reply too large'));
      this.drain();
    });
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => {
      this.closed = true;
      if (this.waiter) this.fail(new Error('smtp closed'));
    });
  }

  drain() {
    if (!this.waiter) return;
    // A reply is one or more lines "250-..." ending with "250 ...".
    const lines = this.buffer.split('\r\n');
    for (let i = 0; i < lines.length - 1; i += 1) {
      if (/^\d{3} /.test(lines[i])) {
        const reply = lines.slice(0, i + 1).join('\n');
        const rest = lines.slice(i + 1).join('\r\n');
        this.buffer = rest;
        const { resolve, reject } = this.waiter;
        this.waiter = null;
        const code = Number(reply.slice(0, 3));
        if (code >= 400) reject(mailError(`smtp ${code}`));
        else resolve({ code, reply });
        this.drain();
        return;
      }
    }
  }

  fail(err) {
    this.failure = err;
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(err instanceof Error && err.status ? err : mailError('smtp failed'));
    }
    this.destroy();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
  }

  read() {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.drain();
    });
  }

  async command(line, expect = [250]) {
    this.socket.write(`${line}\r\n`);
    const { code, reply } = await this.read();
    if (!expect.includes(code)) throw mailError(`smtp unexpected ${code}`);
    return reply;
  }
}

// `smtp closed` can arrive before the reply we are waiting for, so the socket
// close handler rejects whatever read() is pending.

function connectSocket() {
  return new Promise((resolve, reject) => {
    const options = { host: config.smtpHost, port: config.smtpPort };
    const onError = (err) => {
      socket.destroy();
      reject(mailError(`connect ${err.code || 'error'}`));
    };
    const socket = config.smtpTls
      ? tls.connect({ ...options, servername: config.smtpHost }, () => {
          socket.removeListener('error', onError);
          resolve(socket);
        })
      : net.connect(options, () => {
          socket.removeListener('error', onError);
          resolve(socket);
        });
    socket.once('error', onError);
    socket.setTimeout(config.mailTimeoutMs, () => onError(new Error('connect timeout')));
  });
}

/* -------------------------------------------------------------- concurrency */

let active = 0;
const waiting = [];

function acquire() {
  if (active < config.mailMaxConcurrent) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

/* ------------------------------------------------------------------ sending */

async function sendRaw({ to, subject, text }) {
  const socket = await connectSocket();
  const session = new SmtpSession(socket);
  try {
    await session.read(); // 220 greeting
    await session.command('EHLO liangchao');
    if (config.smtpUser) {
      await session.command('AUTH LOGIN', [334]);
      await session.command(Buffer.from(config.smtpUser, 'utf8').toString('base64'), [334]);
      await session.command(Buffer.from(config.smtpPass, 'utf8').toString('base64'), [235]);
    }
    await session.command(`MAIL FROM:<${config.mailFrom}>`);
    await session.command(`RCPT TO:<${to}>`, [250, 251]);
    await session.command('DATA', [354]);
    socket.write(buildMessage({ to, subject, text }));
    await session.command('.');
    await session.command('QUIT', [221]).catch(() => {});
  } finally {
    session.destroy();
  }
}

export async function sendMail({ to, subject, text }) {
  await acquire();
  try {
    await sendRaw({ to, subject, text });
  } finally {
    release();
  }
}

const PURPOSE_SUBJECT = {
  register: '注册验证码',
  reset: '重置密码验证码',
  'change-email': '更换邮箱验证码',
  'change-password': '修改密码验证码',
};

const PURPOSE_ACTION = {
  register: '注册「我们的小站」',
  reset: '重置密码',
  'change-email': '更换邮箱',
  'change-password': '修改密码',
};

export function codeMailText({ name, code, purpose }) {
  const action = PURPOSE_ACTION[purpose] || '继续操作';
  const who = name ? `，${name}` : '';
  return [
    `你好${who}：`,
    '',
    `你正在${action}，验证码是：`,
    '',
    `    ${code}`,
    '',
    `10 分钟内有效，只能使用一次。`,
    `如果不是你本人操作，忽略这封邮件即可，你的账号不会发生任何变化。`,
    '',
    '—— 我们的小站',
  ].join('\n');
}

// Dev/test only: dev mode has no mailbox to read, so the last few codes are kept
// in memory. Nothing is ever pushed here when SMTP is configured.
export const devOutbox = [];

// Returns { dev: true } when there is no mailbox configured and the code was
// only printed locally, so callers/tests can tell a real send from a stub.
export async function sendCode({ to, code, purpose, name }) {
  const subject = `【我们的小站】${PURPOSE_SUBJECT[purpose] || '验证码'}`;
  const text = codeMailText({ name, code, purpose });

  if (!config.smtpUser) {
    if (!config.devMail) throw mailError('smtp not configured');
    devOutbox.push({ to, purpose, code, at: Date.now() });
    if (devOutbox.length > 50) devOutbox.shift();
    console.log(`[mail:dev] to=${to} purpose=${purpose} code=${code}`);
    return { dev: true };
  }

  try {
    await sendMail({ to, subject, text });
  } catch (err) {
    // Never log the code; the address domain is enough to tell a config problem
    // from an address problem.
    console.error(
      `[mail] failed purpose=${purpose} to=${String(to).split('@')[1] || '?'} err=${err.message}`
    );
    throw mailError();
  }
  return { dev: false };
}