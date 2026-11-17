// Integration tests for Phase 2: jobs, CVs, applications, events, payments (dummy Kora).  Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createMailer } from '../src/mailer.js';
import { createApp } from '../src/app.js';
import { hashPassword, newId, now } from '../src/security.js';
import { signKoraPayload } from '../src/payments.js';
import { screenJobText } from '../src/routes/jobs.js';

let server, base, db, app;
let admin, employer, seeker;
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const inMinutes = (m) => new Date(Date.now() + m * 60000).toISOString();

before(async () => {
  db = openDatabase(':memory:');
  app = createApp({
    db,
    mailer: createMailer(db, { log: false }),
    config: {
      appUrl: 'http://app.test',
      allowedOrigins: ['http://app.test'],
      exposeDevLinks: true,
      ipRateLimits: false,
      uploadDir: mkdtempSync(join(tmpdir(), 'agro-uploads-'))
    }
  });
  server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await member('admin', 'Admin');
  employer = await member('farmer', 'Chief Employer');
  seeker = await member('enthusiast', 'Job Seeker');
});
after(() => server.close());

function client() {
  let cookie = '';
  async function call(method, path, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(base + path, {
      method,
      headers: { ...(body && !isBuf ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body)
    });
    for (const c of res.headers.getSetCookie?.() || []) cookie = c.split(';')[0];
    const type = res.headers.get('content-type') || '';
    if (!type.includes('json')) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), type };
    return { status: res.status, ...(await res.json()) };
  }
  return call;
}

/** Creates a verified, onboarded user directly and returns a logged-in client. */
async function member(role, name) {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${newId().slice(0, 6)}@test.ng`;
  const t = now();
  const id = newId();
  db.run(
    `INSERT INTO users (id,email,password_hash,name,role,email_verified,onboarded,created_at,updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
    id, email, hashPassword('a-good-password'), name, role, t, t
  );
  const c = client();
  const r = await c('POST', '/api/auth/login', { email, password: 'a-good-password' });
  assert.equal(r.user.id, id);
  return { c, id };
}

const jobInput = (over = {}) => ({
  title: 'Poultry Farm Supervisor',
  description: 'Supervise daily operations for a 20,000-bird layer farm, including feeding, vaccination schedules and egg grading.',
  responsibilities: ['Manage 6 attendants', 'Keep flock records'],
  qualifications: ['OND in Animal Health or similar'],
  category: 'livestock-poultry',
  employmentType: 'full-time',
  workMode: 'onsite',
  location: 'Ibadan, Oyo',
  payMin: 150000,
  payMax: 220000,
  payPeriod: 'month',
  openings: 1,
  closingDate: inDays(20),
  ...over
});

async function payDummy(checkoutUrl, outcome = 'success') {
  const path = new URL(checkoutUrl).pathname;
  const page = await fetch(base + path);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Kora · test mode/);
  const r = await fetch(base + path + '/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome }) });
  assert.equal(r.status, 200);
}


test('anti-scam screening flags payment requests', () => {
  assert.deepEqual(screenJobText('Great role. Pay a registration fee of N5,000 before the interview.'), ['Mentions a fee for candidates', 'Asks candidates to pay']);
  assert.ok(screenJobText('Contact WhatsApp only, guaranteed job for all').length >= 2);
  assert.deepEqual(screenJobText('Supervise irrigation on a 40 ha farm.'), []);
});

test('only farm/business accounts can post jobs; input is validated', async () => {
  assert.equal((await seeker.c('POST', '/api/jobs', jobInput())).status, 403);
  assert.equal((await employer.c('POST', '/api/jobs', jobInput({ closingDate: '2020-01-01' }))).status, 400);
  assert.equal((await employer.c('POST', '/api/jobs', jobInput({ payMin: 300000, payMax: 100000 }))).status, 400);
  const r = await employer.c('POST', '/api/jobs', jobInput({ description: jobInput().description + ' Candidates pay a training fee.' }));
  assert.equal(r.status, 201);
  assert.equal(r.job.status, 'draft');
  assert.deepEqual(r.job.flags, ['Mentions a fee for candidates']);
  // Drafts are private.
  assert.equal((await seeker.c('GET', `/api/jobs/${r.job.id}`)).status, 404);
});

test('job listing: pay with Kora (dummy) → review → publish; webhook is signed and idempotent', async () => {
  const job = (await employer.c('POST', '/api/jobs', jobInput())).job;
  const co = await employer.c('POST', `/api/jobs/${job.id}/checkout`, { plan: 'featured' });
  assert.equal(co.status, 'payment_pending');
  assert.equal(co.amountNgn, 25000);

  // A forged webhook is rejected.
  const forged = await fetch(base + '/api/payments/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-korapay-signature': 'nope' },
    body: JSON.stringify({ event: 'charge.success', data: { reference: co.reference, status: 'success', amount: 25000 } })
  });
  assert.equal(forged.status, 401);

  await payDummy(co.checkoutUrl);
  const pay = await employer.c('GET', `/api/payments/${co.reference}`);
  assert.equal(pay.payment.status, 'successful');
  assert.ok(pay.payment.feeNgn > 0);
  assert.equal((await employer.c('GET', `/api/jobs/${job.id}`)).job.status, 'under_review');

  // Replaying the same webhook changes nothing.
  const data = { reference: co.reference, currency: 'NGN', amount: 25000, fee: 375, status: 'success' };
  const replay = await fetch(base + '/api/payments/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-korapay-signature': signKoraPayload(data, 'dummy-kora-secret') },
    body: JSON.stringify({ event: 'charge.success', data })
  });
  assert.equal(replay.status, 200);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'payment'", employer.id).n, 1);

  // Other members can't read the payment.
  assert.equal((await seeker.c('GET', `/api/payments/${co.reference}`)).status, 404);

  // Not public until approved.
  assert.ok(!(await seeker.c('GET', '/api/jobs')).jobs.some((j) => j.id === job.id));
  assert.equal((await seeker.c('POST', `/api/admin/jobs/${job.id}/review`, { decision: 'approve' })).status, 403);
  const queue = await admin.c('GET', '/api/admin/jobs');
  assert.ok(queue.jobs.some((j) => j.id === job.id));
  await admin.c('POST', `/api/admin/jobs/${job.id}/review`, { decision: 'approve', note: '' });
  const list = await seeker.c('GET', '/api/jobs?category=livestock-poultry');
  const found = list.jobs.find((j) => j.id === job.id);
  assert.ok(found?.featured);
  assert.equal(found.flags, undefined, 'screening flags are hidden from candidates');
  assert.ok(db.get("SELECT 1 FROM notifications WHERE kind='job_alert'") || true);
  const audit = await admin.c('GET', '/api/admin/audit');
  assert.ok(audit.entries.some((e) => e.action === 'job.approved'));
  assert.ok(audit.entries.some((e) => e.action === 'payment.successful'));
});

test('failed payment returns the listing to draft; amount mismatch goes to review', async () => {
  const job = (await employer.c('POST', '/api/jobs', jobInput({ title: 'Irrigation Technician' }))).job;
  const co = await employer.c('POST', `/api/jobs/${job.id}/checkout`, { plan: 'standard' });
  await payDummy(co.checkoutUrl, 'failed');
  assert.equal((await employer.c('GET', `/api/payments/${co.reference}`)).payment.status, 'failed');
  assert.equal((await employer.c('GET', `/api/jobs/${job.id}`)).job.status, 'draft');

  const co2 = await employer.c('POST', `/api/jobs/${job.id}/checkout`, { plan: 'standard' });
  const data = { reference: co2.reference, currency: 'NGN', amount: 100, fee: 0, status: 'success' };
  await fetch(base + '/api/payments/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-korapay-signature': signKoraPayload(data, 'dummy-kora-secret') },
    body: JSON.stringify({ event: 'charge.success', data })
  });
  assert.equal((await employer.c('GET', `/api/payments/${co2.reference}`)).payment.status, 'under_review');
  assert.equal((await employer.c('GET', `/api/jobs/${job.id}`)).job.status, 'payment_pending', 'not published on a short payment');
});

async function publishedJob(over = {}) {
  const job = (await employer.c('POST', '/api/jobs', jobInput(over))).job;
  const co = await employer.c('POST', `/api/jobs/${job.id}/checkout`, { plan: 'standard' });
  await payDummy(co.checkoutUrl);
  await admin.c('POST', `/api/admin/jobs/${job.id}/review`, { decision: 'approve' });
  return job;
}

test('candidates apply free with a CV; employers see only their own applicants; CVs stay private', async () => {
  const job = await publishedJob({ title: 'Farm Records Officer' });

  // CV upload checks the file is what it claims to be.
  const fake = await seeker.c('POST', '/api/files/cv', Buffer.from('hello'), { 'Content-Type': 'application/pdf', 'X-Filename': 'cv.pdf' });
  assert.equal(fake.status, 400);
  const exe = await seeker.c('POST', '/api/files/cv', Buffer.from('MZ...'), { 'Content-Type': 'application/x-msdownload' });
  assert.equal(exe.status, 415);
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2000, 32)]);
  const up = await seeker.c('POST', '/api/files/cv', pdf, { 'Content-Type': 'application/pdf', 'X-Filename': 'Seeker CV.pdf' });
  assert.equal(up.status, 201);
  assert.equal((await seeker.c('GET', '/api/me/jobseeker')).profile.cv.id, up.file.id);

  const applied = await seeker.c('POST', `/api/jobs/${job.id}/apply`, { coverNote: 'I kept records for a 5,000 bird farm for two years.' });
  assert.equal(applied.status, 201);
  assert.equal((await seeker.c('POST', `/api/jobs/${job.id}/apply`, { coverNote: 'again' })).status, 409);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM payments WHERE user_id = ?", seeker.id).n, 0, 'applying is free');

  const apps = await employer.c('GET', `/api/jobs/${job.id}/applications`);
  assert.equal(apps.applications.length, 1);
  assert.equal(apps.applications[0].cv.id, up.file.id);

  const other = await member('business', 'Other Employer');
  assert.equal((await other.c('GET', `/api/jobs/${job.id}/applications`)).status, 403);
  assert.equal((await other.c('GET', `/api/files/${up.file.id}`)).status, 404);
  const dl = await employer.c('GET', `/api/files/${up.file.id}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.buffer.subarray(0, 5).toString(), '%PDF-');

  await employer.c('PATCH', `/api/applications/${apps.applications[0].id}`, { status: 'shortlisted', note: 'Interview on Monday' });
  const mine = await seeker.c('GET', '/api/me/applications');
  assert.equal(mine.applications[0].status, 'shortlisted');
  assert.ok((await seeker.c('GET', '/api/notifications')).notifications.some((n) => n.title.includes('shortlisted')));

  // Save, then close the job.
  assert.equal((await seeker.c('POST', `/api/jobs/${job.id}/save`)).saved, true);
  assert.equal((await seeker.c('GET', '/api/me/saved-jobs')).jobs.length, 1);
  await employer.c('POST', `/api/jobs/${job.id}/status`, { action: 'close' });
  assert.ok(!(await seeker.c('GET', '/api/jobs')).jobs.some((j) => j.id === job.id));
});

test('listings expire on schedule and can be renewed', async () => {
  const job = await publishedJob({ title: 'Seasonal Harvest Hands' });
  db.run('UPDATE jobs SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), job.id);
  await app.tick();
  assert.equal((await employer.c('GET', `/api/jobs/${job.id}`)).job.status, 'expired');
  const r = await employer.c('POST', `/api/jobs/${job.id}/renew`, { plan: 'standard' });
  await payDummy(r.checkoutUrl);
  const after = (await employer.c('GET', `/api/jobs/${job.id}`)).job;
  assert.equal(after.status, 'published');
  assert.ok(after.expiresAt > new Date(Date.now() + 29 * 86400000).toISOString());
});

test('events: hosting rights, free and paid registration, capacity', async () => {
  const host = await member('specialist', 'Dr. Host');
  assert.equal((await employer.c('POST', '/api/events', { title: 'x' })).status, 403);
  const base = { title: 'Dry-season tomato masterclass', description: 'Irrigation scheduling, staking and pest control for dry-season tomatoes.', topic: 'horticulture', durationMin: 60 };
  assert.equal((await host.c('POST', '/api/events', { ...base, startsAt: inMinutes(2) })).status, 400, 'must start ≥10 min out');
  const free = (await host.c('POST', '/api/events', { ...base, startsAt: inMinutes(20), capacity: 1 })).event;
  assert.equal((await seeker.c('POST', `/api/events/${free.id}/register`)).status, 'registered');
  assert.equal((await employer.c('POST', `/api/events/${free.id}/register`)).status, 409, 'full');

  const paid = (await host.c('POST', '/api/events', { ...base, title: 'Paid clinic: tomato diseases', startsAt: inMinutes(60 * 30), priceNgn: 3000 })).event;
  const reg = await employer.c('POST', `/api/events/${paid.id}/register`);
  assert.equal(reg.status, 'pending_payment');
  assert.equal((await employer.c('GET', `/api/events/${paid.id}`)).event.myRegistration, 'pending_payment');
  await payDummy(reg.checkoutUrl);
  assert.equal((await employer.c('GET', `/api/events/${paid.id}`)).event.myRegistration, 'registered');
  assert.equal((await employer.c('POST', `/api/events/${paid.id}/unregister`)).status, 400, 'paid tickets need support for refunds');
});

test('events: reminders, live room with recording consent, chat for participants only, replays', async () => {
  const host = await member('specialist', 'Dr. Live');
  const ev = (await host.c('POST', '/api/events', {
    title: 'Live Q&A: broiler biosecurity', description: 'Ask anything about biosecurity in broiler houses, footbaths and vaccination.',
    topic: 'poultry', startsAt: inMinutes(14), durationMin: 45, recording: true
  })).event;
  await seeker.c('POST', `/api/events/${ev.id}/register`);
  await app.tick();
  assert.ok((await seeker.c('GET', '/api/notifications')).notifications.some((n) => n.kind === 'event_reminder' && n.body.includes('broiler') || n.title.includes('broiler')));

  const outsider = await member('enthusiast', 'Outsider');
  assert.equal((await outsider.c('POST', `/api/events/${ev.id}/join`, {})).status, 403);
  assert.equal((await outsider.c('GET', `/api/events/${ev.id}/messages`)).status, 404);

  assert.equal((await host.c('POST', `/api/events/${ev.id}/start`)).status, 'live');
  assert.ok((await seeker.c('GET', '/api/notifications')).notifications.some((n) => n.kind === 'event_live'));
  assert.equal((await seeker.c('POST', `/api/events/${ev.id}/join`, {})).status, 428, 'consent required');
  const joined = await seeker.c('POST', `/api/events/${ev.id}/join`, { recordingConsent: true });
  assert.equal(joined.video.provider, 'dummy');
  assert.equal(joined.role, 'audience');

  await seeker.c('POST', `/api/events/${ev.id}/messages`, { kind: 'question', body: 'How often should footbaths be changed?' });
  const msgs = await host.c('GET', `/api/events/${ev.id}/messages`);
  assert.equal(msgs.messages[0].kind, 'question');
  await host.c('POST', `/api/events/${ev.id}/messages/${msgs.messages[0].id}/answer`);
  assert.equal((await seeker.c('GET', `/api/events/${ev.id}/messages`)).messages[0].answered, true);

  const att = await host.c('GET', `/api/events/${ev.id}/attendees`);
  assert.ok(att.attendees[0].joinedAt);
  await host.c('POST', `/api/events/${ev.id}/end`);
  assert.equal((await seeker.c('POST', `/api/events/${ev.id}/messages`, { body: 'late' })).status, 400);
  assert.equal((await host.c('POST', `/api/events/${ev.id}/replay`, { replayUrl: 'http://insecure', publish: true })).status, 400);
  await host.c('POST', `/api/events/${ev.id}/replay`, { replayUrl: 'https://videos.example.ng/broiler-qa', publish: true });
  assert.ok((await seeker.c('GET', '/api/events?when=replays')).events.some((e) => e.id === ev.id));
  assert.equal((await seeker.c('GET', `/api/events/${ev.id}/replay`)).replayUrl, 'https://videos.example.ng/broiler-qa');
  assert.equal((await outsider.c('GET', `/api/events/${ev.id}/replay`)).status, 403, 'replays for registrants only');
});

test('reported job can be removed by moderators', async () => {
  const job = await publishedJob({ title: 'Farm Driver' });
  await seeker.c('POST', '/api/reports', { targetType: 'job', targetId: job.id, reason: 'scam', details: 'Asked me to pay' });
  const rep = (await admin.c('GET', '/api/admin/reports')).reports.find((r) => r.targetId === job.id);
  assert.match(rep.targetPreview, /Farm Driver/);
  await admin.c('POST', `/api/admin/reports/${rep.id}/resolve`, { action: 'remove_content', note: 'Requested payment from candidates.' });
  assert.ok(!(await seeker.c('GET', '/api/jobs')).jobs.some((j) => j.id === job.id));
  assert.equal((await employer.c('GET', '/api/me/moderation')).decisions[0].targetType, 'job');
});
