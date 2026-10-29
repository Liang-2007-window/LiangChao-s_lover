// SMTP client tests against a fake in-process mail server.
// Run with: node tests/mail.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

// ---------------------------------------------------------------------------
// A tiny SMTP server: just enough protocol for the client under test.
// ---------------------------------------------------------------------------
const received = [];
let smtp;
let smtpPort = 0;
let behaviour = 'ok'; // 'ok' | 'authfail' | 'rcptfail'

function startFakeSmtp() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = '';
      let inData = false;
      let dataLines = [];
      let stage = 'command'; // command | user | pass
      let user = '';
      const send = (line) => socket.write(`${line}\r\n`);

      send('220 fake.local ESMTP ready');

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');

        while (true) {
          if (inData) {
            const end = buffer.indexOf('\r\n.\r\n');
            if (end === -1) return; // wait for the terminating dot
            const body = buffer.slice(0, end).split('\r\n');
            const rest = buffer.slice(end + 5);
            buffer = rest;
            inData = false;
            received.push({ user, body: body.join('\n') });
            dataLines = [];
            send('250 2.0.0 queued');
            continue;
          }

          const nl = buffer.indexOf('\r\n');
          if (nl === -1) return;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);

          if (stage === 'user' || stage === 'pass') {
            const value = Buffer.from(line, 'base64').toString('utf8').trim();
            if (stage === 'user') {
              user = value;
              stage = 'pass';
              send('334 UGFzc3dvcmQ6');
            } else {
              stage = 'command';
              if (behaviour === 'authfail') send('535 5.7.8 authentication failed');
              else send('235 2.7.0 accepted');
            }
            continue;
          }

          const verb = line.split(' ')[0].toUpperCase();
          if (verb === 'EHLO' || verb === 'HELO') {
            send('250-fake.local');
            send('250-AUTH LOGIN');
            send('250-SIZE 10485760');
            send('250 8BITMIME');
          } else if (verb === 'AUTH') {
            stage = 'user';
            send('334 VXNlcm5hbWU6');
          } else if (verb === 'MAIL') {
            send('250 2.1.0 ok');
          } else if (verb === 'RCPT') {
            if (behaviour === 'rcptfail') send('550 5.1.1 no such user');
            else send('250 2.1.5 ok');
          } else if (verb === 'DATA') {
            inData = true;
            send('354 start mail input');
          } else if (verb === 'QUIT') {
            send('221 2.0.0 bye');
            socket.end();
          } else if (verb === 'RSET') {
            send('250 ok');
          } else {
            send('502 5.5.2 not implemented');
          }
        }
      });

      socket.on('error', () => {});
    });

    server.listen(0, '127.0.0.1', () => {
      smtpPort = server.address().port;
      resolve(server);
    });
    smtp = server;
  });
}

let mail;

before(async () => {
  await startFakeSmtp();
  process.env.LD_SMTP_HOST = '127.0.0.1';
  process.env.LD_SMTP_PORT = String(smtpPort);
  process.env.LD_SMTP_TLS = '0';
  process.env.LD_SMTP_USER = '1373917993@qq.com';
  process.env.LD_SMTP_PASS = 'app-password';
  process.env.LD_LOG = '0';
  mail = await import('../server/mail.mjs');
});

after(() => {
  smtp?.close();
});

test('sendMail speaks SMTP and delivers the body', async () => {
  received.length = 0;
  behaviour = 'ok';
  await mail.sendMail({
    to: 'someone@example.com',
    subject: '【我们的小站】测试主题',
    text: '第一行\n第二行',
  });

  assert.equal(received.length, 1);
  const mail_ = received[0];
  assert.equal(mail_.user, '1373917993@qq.com');
  assert.match(mail_.body, /^From: =\?UTF-8\?B\?/m, 'from header is RFC2047 encoded');
  assert.match(mail_.body, /^To: <someone@example\.com>$/m);
  assert.match(mail_.body, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(mail_.body, /Content-Transfer-Encoding: base64/i);
  // Body is base64; decode it back and check the text survived.
  const blocks = mail_.body.split(/\n\n/);
  const payload = blocks[blocks.length - 1].replace(/\n/g, '');
  assert.equal(Buffer.from(payload, 'base64').toString('utf8'), '第一行\n第二行');
});

test('a rejected recipient surfaces as a 503 mail_failed via sendCode', async () => {
  received.length = 0;
  behaviour = 'rcptfail';
  await assert.rejects(
    () => mail.sendCode({ to: 'nobody@example.com', code: '123456', purpose: 'register', name: 'x' }),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.payload.error, 'mail_unavailable');
      return true;
    }
  );
  behaviour = 'ok';
});

test('a rejected AUTH login also surfaces as mail_failed', async () => {
  received.length = 0;
  behaviour = 'authfail';
  await assert.rejects(
    () => mail.sendCode({ to: 'someone@example.com', code: '123456', purpose: 'reset', name: 'x' }),
    (err) => err.status === 503 && err.payload.error === 'mail_unavailable'
  );
  behaviour = 'ok';
});

test('the raw protocol error is not swallowed by sendMail', async () => {
  received.length = 0;
  behaviour = 'authfail';
  await assert.rejects(
    () => mail.sendMail({ to: 'someone@example.com', subject: 'x', text: 'y' }),
    /smtp 535/
  );
  behaviour = 'ok';
});

test('code mails carry the code and the right purpose wording', () => {
  const register = mail.codeMailText({ name: 'liuke', code: '123456', purpose: 'register' });
  assert.match(register, /123456/);
  assert.match(register, /注册/);
  assert.match(register, /10 分钟/);

  const reset = mail.codeMailText({ name: 'liuke', code: '654321', purpose: 'reset' });
  assert.match(reset, /重设|重置|找回/);

  const changePass = mail.codeMailText({ name: 'liuke', code: '111111', purpose: 'change-password' });
  assert.match(changePass, /密码/);

  const changeMail = mail.codeMailText({ name: 'liuke', code: '222222', purpose: 'change-email' });
  assert.match(changeMail, /邮箱/);
});

test('every purpose has a subject line', () => {
  for (const purpose of ['register', 'reset', 'change-email', 'change-password']) {
    const code = mail.codeMailText({ name: 'x', code: '000000', purpose });
    assert.ok(code.length > 40, `template for ${purpose} is not empty`);
  }
});