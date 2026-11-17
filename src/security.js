// Password hashing, tokens and a small in-memory rate limiter.
import { scryptSync, randomBytes, timingSafeEqual, createHash, randomUUID } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [alg, n, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: SCRYPT.r,
    p: SCRYPT.p
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A random URL-safe token and its SHA-256 hash (only the hash is stored). */
export function newToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
export const inFuture = (ms) => new Date(Date.now() + ms).toISOString();

/** Fixed-window limiter keyed by caller + bucket. Fine for one process; use Redis when scaling out. */
export function createRateLimiter() {
  const hits = new Map();
  return function limit(key, max, windowMs) {
    const t = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < t) {
      hits.set(key, { count: 1, reset: t + windowMs });
      if (hits.size > 50_000) for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}
