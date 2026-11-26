// Creating the first platform admin. Production has no demo accounts.
import { hashPassword, newId, now } from './security.js';

export function checkAdminInput(email, password) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('ADMIN_EMAIL must be a valid email address.');
  if (String(password || '').length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
  return e;
}

/** Creates the admin, or with `reset` promotes an existing account and sets its password. */
export function upsertAdmin(db, { email, name = 'Platform Admin', password, reset = true }) {
  const e = checkAdminInput(email, password);
  const t = now();
  const existing = db.get('SELECT id, role FROM users WHERE email = ?', e);
  if (existing) {
    if (!reset) return 'exists';
    db.run(`UPDATE users SET role = 'admin', password_hash = ?, email_verified = 1, updated_at = ? WHERE id = ?`, hashPassword(password), t, existing.id);
    return 'updated';
  }
  db.run(
    `INSERT INTO users (id, email, password_hash, name, role, email_verified, onboarded, created_at, updated_at) VALUES (?,?,?,?, 'admin', 1, 1, ?, ?)`,
    newId(), e, hashPassword(password), String(name).trim() || 'Platform Admin', t, t
  );
  return 'created';
}
