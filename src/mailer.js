// Email delivery. Until an email provider is chosen (tracker: "Email delivery provider"),
// every message is written to the email_outbox table and logged, so verification and
// reset flows can be exercised end to end. Swap `deliver` for a provider client
// (e.g. Postmark, SES, Resend) without touching callers.
import { newId, now } from './security.js';

export function createMailer(db, { log = true } = {}) {
  async function deliver(msg) {
    db.run(
      'INSERT INTO email_outbox (id, to_email, subject, body, created_at) VALUES (?, ?, ?, ?, ?)',
      newId(),
      msg.to,
      msg.subject,
      msg.text,
      now()
    );
    if (log) console.log(`[mail] to=${msg.to} subject="${msg.subject}"\n${msg.text}\n`);
  }
  return { send: deliver };
}
