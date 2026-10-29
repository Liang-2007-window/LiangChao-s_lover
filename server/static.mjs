// Dev-only static file server. In production nginx serves these files directly;
// this exists so `node server/index.mjs` gives a working page on localhost.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// Dev only: never let the browser keep an old script or stylesheet around after
// an edit - that once made a brand new page call a function the browser's cached
// copy did not have yet. Media can still be cached briefly.
const CACHE = {
  '.html': 'no-cache',
  '.css': 'no-cache',
  '.js': 'no-cache',
  '.mjs': 'no-cache',
};

export function serveStatic(req, res, urlPath) {
  const root = config.root;
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(root + path.sep) && full !== root) {
    res.writeHead(403).end('forbidden');
    return true;
  }
  if (full.includes(`${path.sep}.`)) {
    res.writeHead(404).end('not found');
    return true;
  }
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return false;
  }
  if (stat.isDirectory()) {
    res.writeHead(301, { location: `${urlPath.replace(/\/?$/, '/')}` }).end();
    return true;
  }
  const ext = path.extname(full).toLowerCase();
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'last-modified': stat.mtime.toUTCString(),
    'cache-control': CACHE[ext] || 'public, max-age=3600',
  };
  res.writeHead(200, headers);
  fs.createReadStream(full).pipe(res);
  return true;
}