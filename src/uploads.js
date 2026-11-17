// Saves a raw upload to private storage after checking its bytes match the declared type.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { newId, now } from './security.js';
import { sniff } from './routes/books.js';

export function saveUpload(kit, ctx, kind, ownerId = ctx.user.id) {
  const { db, cfg, bad } = kit;
  if (!sniff(ctx.rawBody, ctx.contentType)) throw bad('The file doesn’t match its type.');
  const id = newId();
  mkdirSync(cfg.uploadDir, { recursive: true });
  writeFileSync(join(cfg.uploadDir, id), ctx.rawBody);
  const filename = decodeURIComponent(String(ctx.req.headers['x-filename'] || kind)).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  db.run('INSERT INTO files (id, owner_id, kind, filename, mime, size_bytes, sha256, storage_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id, ownerId, kind, filename, ctx.contentType, ctx.rawBody.length, createHash('sha256').update(ctx.rawBody).digest('hex'), id, now());
  return { id, filename, sizeBytes: ctx.rawBody.length };
}

export function fileResponse(kit, fileId, inline = true) {
  const f = kit.db.get('SELECT * FROM files WHERE id = ?', fileId);
  const path = f && join(kit.cfg.uploadDir, f.storage_key);
  if (!f || !existsSync(path)) throw new kit.HttpError(404, 'not_found', 'File not found.');
  return { file: { buffer: readFileSync(path), mime: f.mime, filename: f.filename, inline } };
}
