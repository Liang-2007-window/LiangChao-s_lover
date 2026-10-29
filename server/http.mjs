// Small HTTP helpers - parsing, cookies, JSON responses, origin checks.
import { config } from './config.mjs';

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function sendText(res, status, text, extraHeaders = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function cookie(name, value, { maxAge, httpOnly = true, sameSite = 'Lax', secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (httpOnly) parts.push('HttpOnly');
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  // No domain yet: the site is served over plain HTTP from a bare IP, so a
  // Secure cookie would simply never be sent back.
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function readBody(req, limit = config.maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload_too_large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(Object.assign(new Error('aborted'), { status: 400 })));
  });
}

export async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('bad_json'), { status: 400 });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw Object.assign(new Error('bad_json'), { status: 400 });
  }
  return data;
}

// nginx forwards the real peer in X-Forwarded-For; anything else must be ignored
// or a client could forge its own IP and dodge the login lockout.
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

export function hostOf(value) {
  if (!value) return '';
  return String(value).trim().toLowerCase().replace(/:\d+$/, '');
}

// Cross-site writes are rejected: a browser always sends Origin for them.
export function originAllowed(req) {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const host = hostOf(req.headers.host);
  const source = origin || referer;
  if (!source) return true; // curl / same-origin navigations
  try {
    return hostOf(new URL(source).host) === host;
  } catch {
    return false;
  }
}

export function wantsHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}