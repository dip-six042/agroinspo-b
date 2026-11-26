// Creates (or promotes) a platform admin. Production has no demo accounts, so run this once per admin.
// One admin is enough: production sets ALLOW_PAYOUT_SELF_APPROVAL=1, so that admin can approve payout batches.
//
//   ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='a long password' npm run create-admin
//
// On Render: open the service's Shell tab and run the command there, so it writes to the persistent disk.
import { openDatabase } from '../src/db.js';
import { hashPassword, newId, now } from '../src/security.js';

const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const name = String(process.env.ADMIN_NAME || 'Platform Admin').trim();
const password = String(process.env.ADMIN_PASSWORD || '');

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Set ADMIN_EMAIL to a valid email address.');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Set ADMIN_PASSWORD to at least 12 characters.');
  process.exit(1);
}

const db = openDatabase();
const t = now();
const existing = db.get('SELECT id FROM users WHERE email = ?', email);
if (existing) {
  db.run(`UPDATE users SET role = 'admin', password_hash = ?, email_verified = 1, updated_at = ? WHERE id = ?`, hashPassword(password), t, existing.id);
  console.log(`Updated ${email}: now an admin with the new password.`);
} else {
  db.run(
    `INSERT INTO users (id, email, password_hash, name, role, email_verified, onboarded, created_at, updated_at) VALUES (?,?,?,?, 'admin', 1, 1, ?, ?)`,
    newId(), email, hashPassword(password), name, t, t
  );
  console.log(`Created admin ${email}.`);
}
