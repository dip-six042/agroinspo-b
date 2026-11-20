import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createMailer } from '../src/mailer.js';
import { createApp } from '../src/app.js';
import { hashPassword, newId, now } from '../src/security.js';

let server, base, db;

before(async () => {
  db = openDatabase(':memory:');
  const app = createApp({
    db,
    mailer: createMailer(db, { log: false }),
    config: { appUrl: 'http://app.test', allowedOrigins: ['http://app.test'], exposeDevLinks: true, ipRateLimits: false }
  });
  server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  const t = now();
  db.run(
    `INSERT INTO users (id,email,password_hash,name,role,email_verified,onboarded,created_at,updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
    newId(), 'admin@test.ng', hashPassword('admin-password-1'), 'Admin', 'admin', t, t
  );
});
after(() => server.close());

function client() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        Origin: 'http://app.test',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) cookie = c.split(';')[0].endsWith('=') ? '' : c.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, ...json };
  };
}

const entry = {
  fullName: 'Ada Okonkwo',
  email: 'ada@farm.test',
  phone: '+2348012345678',
  sector: 'crops',
  capacityNgn: 500000,
  country: 'Nigeria',
  location: 'Oyo',
  updatesOptIn: true,
  consent: true
};

test('the portal is a waiting list and does not accept funds', async () => {
  const c = client();
  const portal = await c('GET', '/api/investment/portal');
  assert.equal(portal.acceptingFunds, false);
  assert.equal(portal.phase, 'waiting_list');
  assert.equal(portal.officialLaunchAt, null);

  const refused = await c('POST', '/api/investment/waitlist', { ...entry, consent: false });
  assert.equal(refused.status, 400);

  const created = await c('POST', '/api/investment/waitlist', entry);
  assert.equal(created.status, 201);
  const mail = db.get('SELECT subject, body FROM email_outbox WHERE to_email = ?', 'ada@farm.test');
  assert.match(mail.subject, /waiting list/);
  assert.match(mail.body, /not an investment/);

  const again = await c('POST', '/api/investment/waitlist', entry);
  assert.equal(again.status, 409);

  assert.equal((await c('GET', '/api/admin/investment')).status, 401);
});

test('an admin sets the launch date and still cannot take funds', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { email: 'admin@test.ng', password: 'admin-password-1' })).status, 200);
  const early = await c('PATCH', '/api/admin/investment/settings', { readyForReview: true, readinessConfirmed: true });
  assert.equal(early.status, 400);

  const saved = await c('PATCH', '/api/admin/investment/settings', { officialLaunchAt: '2026-01-01T00:00:00.000Z', announcement: 'The investment portal is being prepared. Join the waiting list for updates only.' });
  assert.equal(saved.status, 200);
  assert.equal(saved.portal.plannedOpenAt, '2028-01-01T00:00:00.000Z');
  assert.equal(saved.portal.acceptingFunds, false);

  const unconfirmed = await c('PATCH', '/api/admin/investment/settings', { readyForReview: true });
  assert.equal(unconfirmed.status, 400);
  const ready = await c('PATCH', '/api/admin/investment/settings', { readyForReview: true, readinessConfirmed: true });
  assert.equal(ready.portal.readyForReview, true);
  assert.equal(ready.portal.acceptingFunds, false);

  const list = await c('GET', '/api/admin/investment?sector=crops');
  assert.equal(list.registrations.length, 1);
  assert.equal(list.registrations[0].email, 'ada@farm.test');

  const sent = await c('POST', '/api/admin/investment/updates', { subject: 'Portal update', message: 'We are still preparing the portal and are not taking funds.' });
  assert.equal(sent.sent, 1);
});
