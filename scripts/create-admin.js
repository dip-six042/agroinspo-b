// Creates (or promotes) a platform admin and sets its password, from the command line.
//   ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='a long password' npm run create-admin
// On Render's free plan (no Shell), set ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD in the dashboard instead:
// the server creates the admin on start if it doesn't exist (src/index.js).
import { openDatabase } from '../src/db.js';
import { upsertAdmin } from '../src/admin.js';

try {
  const email = process.env.ADMIN_EMAIL;
  const result = upsertAdmin(openDatabase(), { email, name: process.env.ADMIN_NAME, password: process.env.ADMIN_PASSWORD });
  console.log(result === 'created' ? `Created admin ${email}.` : `Updated ${email}: now an admin with the new password.`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
