// Agro Inspo server entry point.
//   Development:  npm run server   (API on :8787; run `npm run dev` alongside — Vite proxies /api)
//   Production:   npm run build && NODE_ENV=production npm start   (serves the API and the built site)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { createMailer } from './mailer.js';
import { createApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
// The built site (frontend/dist). Set STATIC_DIR when it's deployed elsewhere, or empty to serve the API only.
const DIST = process.env.STATIC_DIR || join(here, '..', '..', 'frontend', 'dist');
const PORT = Number(process.env.PORT || 8787);

const db = openDatabase();
const api = createApp({ db, mailer: createMailer(db) });

// Reminders, listing expiry and other scheduled work.
setInterval(() => api.tick(), 60_000).unref();
api.tick();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff2': 'font/woff2'
};

async function serveStatic(req, res) {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://local').pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, path);
  if (!file.startsWith(DIST)) file = join(DIST, 'index.html');
  try {
    if (!(await stat(file)).isFile()) throw new Error();
  } catch {
    file = join(DIST, 'index.html'); // SPA fallback
  }
  try {
    const body = await readFile(file);
    const isAsset = file.includes(`${join(DIST, 'assets')}`);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Run `npm run build` to create the site bundle.');
  }
}

createServer((req, res) => {
  if (req.url.startsWith('/api/')) return api(req, res);
  return serveStatic(req, res);
}).listen(PORT, () => console.log(`Agro Inspo server on http://localhost:${PORT}`));
