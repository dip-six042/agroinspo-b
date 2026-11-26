// Integration tests for Phase 3: consultations, ledger, payouts, disputes, books, creators, messaging.  Run: npm test
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
import { questionsFor } from '../src/routes/creators.js';
import { createLedger } from '../src/ledger.js';

let server, base, db, app;
let admin, admin2, spec, farmer, other;
const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();

function client() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
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
  };
}
async function member(role, name) {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${newId().slice(0, 6)}@test.ng`;
  const id = newId();
  db.run(`INSERT INTO users (id,email,password_hash,name,role,email_verified,onboarded,created_at,updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
    id, email, hashPassword('a-good-password'), name, role, now(), now());
  const c = client();
  await c('POST', '/api/auth/login', { email, password: 'a-good-password' });
  return { c, id };
}
async function pay(checkoutUrl, outcome = 'success') {
  const path = new URL(checkoutUrl).pathname;
  const r = await fetch(base + path + '/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome }) });
  assert.equal(r.status, 200);
}

before(async () => {
  db = openDatabase(':memory:');
  app = createApp({
    db, mailer: createMailer(db, { log: false }),
    config: { appUrl: 'http://app.test', allowedOrigins: ['http://app.test'], exposeDevLinks: true, ipRateLimits: false, uploadDir: mkdtempSync(join(tmpdir(), 'agro-p3-')) }
  });
  server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await member('admin', 'Admin One');
  admin2 = await member('admin', 'Admin Two');
  spec = await member('specialist', 'Dr. Ada Agronomist');
  farmer = await member('farmer', 'Farmer Bello');
  other = await member('enthusiast', 'Other Person');
  // Specialist sets up profile, a service and slots.
  assert.equal((await spec.c('PUT', '/api/me/specialist', { headline: 'Soil fertility and maize agronomy', specialties: ['Soil testing'], credentials: ['PhD Soil Science'], experienceYears: 12 })).ok, true);
});
after(() => server.close());

async function service(price = 20000, duration = 60) {
  return (await spec.c('POST', '/api/me/services', { title: 'Soil test review', description: 'We go through your soil lab report and agree a fertiliser plan.', topic: 'soil-health', mode: 'video', durationMin: duration, priceNgn: price })).service;
}
async function slot(hoursAhead) {
  await spec.c('POST', '/api/me/slots', { startsAt: [inHours(hoursAhead)], durationMin: 60 });
  const mine = await spec.c('GET', '/api/me/specialist');
  return mine.slots.find((s) => Math.abs(new Date(s.startsAt) - new Date(inHours(hoursAhead))) < 60000);
}
async function book(svc, sl) {
  const r = await farmer.c('POST', '/api/bookings', { serviceId: svc.id, slotId: sl.id, objective: 'My maize leaves are yellowing and I have a soil report to review.' });
  assert.equal(r.status, 201, JSON.stringify(r));
  await pay(r.checkoutUrl);
  return r.bookingId;
}

test('booking: directory, checkout, slot locking, ledger entries in pending', async () => {
  const svc = await service();
  const sl = await slot(48);
  const dir = await other.c('GET', '/api/specialists?topic=soil-health');
  assert.ok(dir.specialists.some((s) => s.id === spec.id && s.fromPriceNgn === 20000));
  const prof = await other.c('GET', `/api/specialists/${spec.id}`);
  assert.ok(prof.slots.some((s) => s.id === sl.id));

  const r = await farmer.c('POST', '/api/bookings', { serviceId: svc.id, slotId: sl.id, objective: 'My maize leaves are yellowing and I have a soil report to review.' });
  // The held slot can't be taken by someone else.
  assert.equal((await other.c('POST', '/api/bookings', { serviceId: svc.id, slotId: sl.id, objective: 'Another person trying to grab the same time slot.' })).status, 409);
  await pay(r.checkoutUrl);
  const b = (await farmer.c('GET', `/api/bookings/${r.bookingId}`)).booking;
  assert.equal(b.status, 'confirmed');
  assert.equal(b.freeCancel, true);
  assert.equal(b.commissionNgn, undefined, 'clients don’t see the commission split');
  const sb = (await spec.c('GET', `/api/bookings/${r.bookingId}`)).booking;
  assert.deepEqual([sb.commissionNgn, sb.netNgn], [2000, 18000]);
  const earn = await spec.c('GET', '/api/me/earnings');
  assert.equal(earn.balances.pendingNgn, 18000);
  assert.equal(earn.balances.availableNgn, 0);
  // Another member can't see the booking.
  assert.equal((await other.c('GET', `/api/bookings/${r.bookingId}`)).status, 404);
});

test('cancellation rules: free ≥24h ahead with full refund; late client cancel needs confirmation and isn’t refunded', async () => {
  const svc = await service(10000);
  const early = await book(svc, await slot(72));
  const c1 = await farmer.c('POST', `/api/bookings/${early}/cancel`, { reason: 'Plans changed' });
  assert.equal(c1.refundedNgn, 10000);
  assert.equal((await farmer.c('GET', `/api/bookings/${early}`)).booking.status, 'refunded');

  const late = await book(svc, await slot(5));
  const c2 = await farmer.c('POST', `/api/bookings/${late}/cancel`, { reason: '' });
  assert.equal(c2.status, 409);
  const c3 = await farmer.c('POST', `/api/bookings/${late}/cancel`, { reason: '', acceptNoRefund: true });
  assert.equal(c3.refundedNgn, 0);

  // Specialist cancellations always refund in full.
  const third = await book(svc, await slot(6));
  assert.equal((await spec.c('POST', `/api/bookings/${third}/cancel`, { reason: 'Field emergency' })).refundedNgn, 10000);
});

test('reschedule lets the client cancel late for free; reviews once after completion', async () => {
  const svc = await service(15000);
  const id = await book(svc, await slot(30));
  const newSlot = await slot(10);
  const r = await spec.c('POST', `/api/bookings/${id}/reschedule`, { slotId: newSlot.id, reason: 'Clashes with a field visit' });
  assert.equal(r.booking.rescheduled, true);
  assert.equal((await farmer.c('GET', `/api/bookings/${id}`)).booking.freeCancel, true);

  // Pretend the session time has come: move it into the past via its slot/booking (not ledger) for the test.
  db.run('UPDATE bookings SET starts_at = ? WHERE id = ?', new Date(Date.now() - 20 * 60000).toISOString(), id);
  const j = await farmer.c('POST', `/api/bookings/${id}/join`);
  assert.equal(j.video.provider, 'dummy');
  await spec.c('POST', `/api/bookings/${id}/join`);
  assert.equal((await other.c('POST', `/api/bookings/${id}/join`)).status, 404);
  assert.equal((await spec.c('POST', `/api/bookings/${id}/complete`, { clientNoShow: true })).status, 400, 'client joined, so no no-show');
  await spec.c('POST', `/api/bookings/${id}/complete`, {});
  assert.equal((await farmer.c('POST', `/api/bookings/${id}/review`, { rating: 5, comment: 'Clear plan, saved me a bag of urea.' })).status, 201);
  assert.equal((await farmer.c('POST', `/api/bookings/${id}/review`, { rating: 4 })).status, 409);
  const prof = await other.c('GET', `/api/specialists/${spec.id}`);
  assert.equal(prof.specialist.rating, 5);
  assert.equal(prof.reviews[0].by, 'Farmer');
});

test('a session the specialist never joins is refunded automatically', async () => {
  const svc = await service(12000);
  const id = await book(svc, await slot(3));
  db.run('UPDATE bookings SET starts_at = ? WHERE id = ?', new Date(Date.now() - 4 * 3600000).toISOString(), id);
  await app.tick();
  const b = (await farmer.c('GET', `/api/bookings/${id}`)).booking;
  assert.equal(b.status, 'refunded');
  assert.equal(b.payment.refundedNgn, 12000);
});

test('ledger entries can’t be edited or deleted', () => {
  assert.throws(() => db.run("UPDATE ledger_entries SET amount_ngn = 1"), /immutable/);
  assert.throws(() => db.run('DELETE FROM ledger_entries'), /immutable/);
});

test('disputes hold earnings until support resolves them with a partial refund', async () => {
  const svc = await service(20000);
  const id = await book(svc, await slot(8));
  db.run('UPDATE bookings SET starts_at = ? WHERE id = ?', new Date(Date.now() - 90 * 60000).toISOString(), id);
  await farmer.c('POST', `/api/bookings/${id}/join`);
  await spec.c('POST', `/api/bookings/${id}/join`);
  await spec.c('POST', `/api/bookings/${id}/complete`, {});
  const t = await farmer.c('POST', '/api/support', { category: 'dispute', subjectType: 'booking', subjectId: id, title: 'Call dropped after 10 minutes', message: 'The specialist left the call after ten minutes and did not return.' });
  assert.equal(t.status, 201);
  assert.equal((await farmer.c('GET', `/api/bookings/${id}`)).booking.status, 'disputed');
  assert.ok((await spec.c('GET', '/api/me/earnings')).balances.heldNgn >= 18000);
  assert.equal((await other.c('POST', '/api/support', { category: 'dispute', subjectType: 'booking', subjectId: id, title: 'Not mine', message: 'Trying to dispute someone else’s booking here.' })).status, 400);

  const queue = await admin.c('GET', '/api/admin/support');
  assert.ok(queue.tickets.some((x) => x.id === t.ticket.id));
  await admin.c('POST', `/api/admin/support/${t.ticket.id}/resolve`, { resolution: 'Session was cut short; refunding half the fee.', refundNgn: 10000 });
  const b = (await farmer.c('GET', `/api/bookings/${id}`)).booking;
  assert.equal(b.payment.refundedNgn, 10000);
  const refunds = db.all("SELECT * FROM ledger_entries WHERE source_id = ? AND entry_type = 'refund'", id);
  assert.equal(refunds.reduce((s, e) => s + e.amount_ngn, 0), -10000, 'seller and platform give back the refunded amount between them');
  assert.ok(!db.get('SELECT 1 FROM earning_holds WHERE source_id = ? AND released_at IS NULL', id), 'hold released');
  const sale = db.get("SELECT available_at FROM ledger_entries WHERE source_id = ? AND entry_type = 'sale'", id);
  assert.ok(refunds.filter((e) => e.account_id).every((e) => e.available_at === sale.available_at),
    'a refund of a still-pending sale stays pending with it rather than reducing other available earnings');
});

test('payouts: account check, maker-checker approval, ledger debit, failures keep the balance, reconciliation report', async () => {
  // Credit available earnings directly with an admin adjustment (available immediately).
  await admin.c('POST', '/api/admin/adjustments', { userId: spec.id, amountNgn: 50000, reason: 'Test credit for payout run' });
  assert.equal((await spec.c('PUT', '/api/me/payout-account', { bankCode: '058', accountNumber: '12345' })).status, 400);
  const pa = await spec.c('PUT', '/api/me/payout-account', { bankCode: '058', accountNumber: '0123456789' });
  assert.equal(pa.payoutAccount.accountNumber, '•••• 6789');
  // New accounts wait 24h before payouts.
  let batch = await admin.c('POST', '/api/admin/payout-batches');
  assert.ok(batch.skipped.some((s) => /24 hours/.test(s.reason)));
  await admin.c('POST', `/api/admin/payout-batches/${batch.batch.id}/cancel`);
  db.run('UPDATE payout_accounts SET verified_at = ? WHERE user_id = ?', new Date(Date.now() - 2 * 86400000).toISOString(), spec.id);

  const before = (await spec.c('GET', '/api/me/earnings')).balances.availableNgn;
  batch = await admin.c('POST', '/api/admin/payout-batches');
  const mine = batch.batch.payouts.find((p) => p.user.id === spec.id);
  assert.equal(mine.amountNgn, before);
  assert.equal((await spec.c('GET', '/api/me/earnings')).balances.availableNgn, 0, 'committed to payout');
  assert.equal((await admin.c('POST', `/api/admin/payout-batches/${batch.batch.id}/approve`)).status, 403, 'maker can’t approve');
  const done = await admin2.c('POST', `/api/admin/payout-batches/${batch.batch.id}/approve`);
  assert.equal(done.results.paid, 1);
  const after = await spec.c('GET', '/api/me/earnings');
  assert.equal(after.balances.availableNgn, 0);
  assert.equal(after.balances.paidOutNgn, before);
  assert.equal(after.payouts[0].status, 'paid');
  const report = await admin.c('GET', `/api/admin/payout-batches/${batch.batch.id}/report`);
  assert.match(report.buffer.toString(), /AI-PO-.*,"yes"/);

  // A failing bank account leaves the money in the balance.
  await admin.c('POST', '/api/admin/adjustments', { userId: farmer.id, amountNgn: 8000, reason: 'Test credit for failed payout' });
  db.run(`INSERT INTO payout_accounts (user_id, bank_code, bank_name, account_number, account_name, verified_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    farmer.id, '044', 'Access Bank', '0000000000', 'TEST', new Date(Date.now() - 2 * 86400000).toISOString(), now());
  const b2 = await admin.c('POST', '/api/admin/payout-batches');
  await admin2.c('POST', `/api/admin/payout-batches/${b2.batch.id}/approve`);
  const fe = await farmer.c('GET', '/api/me/earnings');
  assert.equal(fe.payouts[0].status, 'failed');
  assert.equal(fe.balances.availableNgn, 8000);
  // Statement download.
  const st = await spec.c('GET', '/api/me/statement');
  assert.match(st.type, /text\/csv/);
  assert.match(st.buffer.toString(), /payout/);
});

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4000, 32)]);

test('a refund request on earnings already paid out never shows a negative available balance', async () => {
  const ledgerT = createLedger(db);
  const seller = await member('specialist', 'Paid Out Seller');
  const buyer = await member('farmer', 'Late Refunder');
  const sale = newId();
  db.run("INSERT INTO ledger_entries (id, account_id, entry_type, amount_ngn, source_type, source_id, available_at, memo, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    newId(), seller.id, 'sale', 8000, 'book_purchase', sale, inHours(-48), 'Book', now());
  const pid = newId();
  db.run("INSERT INTO payout_batches (id, created_by, status, total_ngn, created_at) VALUES (?,?,?,?,?)", 'b-' + pid, admin.id, 'completed', 8000, now());
  db.run("INSERT INTO payouts (id, batch_id, user_id, amount_ngn, reference, account_snapshot, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
    pid, 'b-' + pid, seller.id, 8000, 'REF-' + pid, '{}', 'paid', now());
  db.run('INSERT INTO payout_items (payout_id, entry_id) SELECT ?, id FROM ledger_entries WHERE source_id = ?', pid, sale);
  ledgerT.add({ accountId: seller.id, type: 'payout', amount: -8000, sourceType: 'payout', sourceId: pid });
  ledgerT.hold('book_purchase', sale, 'refund request', buyer.id);
  const bal = ledgerT.balances(seller.id);
  assert.equal(bal.availableNgn, 0);
  assert.equal(bal.heldNgn, 0);
});

test('books: upload, review, purchase, buyer-only download, refund withdraws access', async () => {
  assert.equal((await farmer.c('POST', '/api/books', { title: 'x' })).status, 403, 'only specialists and creators publish');
  const bk = (await spec.c('POST', '/api/books', { title: 'Soil Testing for Smallholders', description: 'A practical guide to sampling, reading lab results and turning them into a fertiliser plan for maize and cassava.', topic: 'soil-health', priceNgn: 5000, pages: 64 })).book;
  assert.equal((await spec.c('POST', `/api/books/${bk.id}/submit`, { rightsDeclaration: true })).status, 400, 'needs files');
  assert.equal((await spec.c('POST', `/api/books/${bk.id}/files/cover`, Buffer.from('not an image'), { 'Content-Type': 'image/png' })).status, 400);
  await spec.c('POST', `/api/books/${bk.id}/files/cover`, png, { 'Content-Type': 'image/png', 'X-Filename': 'cover.png' });
  await spec.c('POST', `/api/books/${bk.id}/files/book`, pdf, { 'Content-Type': 'application/pdf', 'X-Filename': 'soil.pdf' });
  assert.equal((await spec.c('POST', `/api/books/${bk.id}/submit`, {})).status, 400, 'rights declaration required');
  await spec.c('POST', `/api/books/${bk.id}/submit`, { rightsDeclaration: true });
  assert.equal((await other.c('GET', `/api/books/${bk.id}`)).status, 404, 'not public before review');
  await admin.c('POST', `/api/admin/books/${bk.id}/review`, { decision: 'approve' });
  assert.ok((await other.c('GET', '/api/books')).books.some((b) => b.id === bk.id));
  assert.equal((await other.c('GET', `/api/books/${bk.id}/cover`)).status, 200);

  assert.equal((await other.c('GET', `/api/books/${bk.id}/download`)).status, 403);
  const buy = await other.c('POST', `/api/books/${bk.id}/buy`);
  await pay(buy.checkoutUrl);
  assert.equal((await other.c('POST', `/api/books/${bk.id}/buy`)).status, 409);
  const dl = await other.c('GET', `/api/books/${bk.id}/download`);
  assert.equal(dl.buffer.subarray(0, 5).toString(), '%PDF-');
  const lib = await other.c('GET', '/api/me/library');
  assert.equal(lib.books[0].id, bk.id);
  const earn = await spec.c('GET', '/api/me/earnings');
  assert.ok(earn.entries.some((e) => e.sourceType === 'book_purchase' && e.amountNgn === 5000 && e.pending));

  const t = await other.c('POST', '/api/support', { category: 'refund', subjectType: 'book_purchase', subjectId: lib.books[0].purchase.id, title: 'Wrong book', message: 'I bought the wrong title by mistake and have not used it.' });
  await admin.c('POST', `/api/admin/support/${t.ticket.id}/resolve`, { resolution: 'Refunded in full as requested within the refund window.', refundNgn: 5000 });
  assert.equal((await other.c('GET', `/api/books/${bk.id}/download`)).status, 403, 'access withdrawn after full refund');
});

test('creator screening gates articles per topic; quiz answers never leave the server', async () => {
  const quiz = await other.c('GET', '/api/creator/quiz/poultry');
  assert.ok(quiz.questions.length >= 5);
  assert.equal(quiz.questions[0].answer, undefined);
  const sample = 'Biosecurity starts at the gate. '.repeat(10);
  const bad = await other.c('POST', '/api/creator/applications', { topic: 'poultry', sample, answers: {}, acceptTerms: true });
  assert.equal(bad.application.status, 'failed_quiz');
  assert.equal((await other.c('POST', '/api/creator/applications', { topic: 'poultry', sample, answers: {}, acceptTerms: true })).status, 400, 'retest waits');

  const answers = Object.fromEntries(questionsFor('crops').map((q) => [q.id, q.answer]));
  const good = await other.c('POST', '/api/creator/applications', { topic: 'crops', sample, answers, acceptTerms: true });
  assert.equal(good.application.status, 'pending');
  const article = { topic: 'crops', kind: 'article', body: 'Fall armyworm scouting guide. '.repeat(15) };
  assert.equal((await other.c('POST', '/api/posts', article)).error.code, 'creator_required');
  await admin.c('POST', `/api/admin/creator-applications/${good.application.id}/decide`, { decision: 'approved', note: '' });
  const posted = await other.c('POST', '/api/posts', article);
  assert.equal(posted.status, 201);
  assert.equal(posted.post.authorScreenedForTopic, true);
  assert.equal((await other.c('POST', '/api/posts', { ...article, topic: 'poultry' })).status, 403, 'approval covers one topic only');
});

test('messaging: conversations, unread counts, blocks stop messages', async () => {
  const { conversationId } = await farmer.c('POST', '/api/conversations', { userId: spec.id });
  await farmer.c('POST', `/api/conversations/${conversationId}/messages`, { body: 'Hello Doctor, can we talk about my soil report?' });
  assert.equal((await spec.c('GET', '/api/conversations')).unreadTotal, 1);
  const thread = await spec.c('GET', `/api/conversations/${conversationId}/messages`);
  assert.equal(thread.messages[0].mine, false);
  assert.equal((await spec.c('GET', '/api/conversations')).unreadTotal, 0);
  assert.equal((await other.c('GET', `/api/conversations/${conversationId}/messages`)).status, 404);
  await spec.c('POST', '/api/blocks', { userId: farmer.id, kind: 'block' });
  assert.equal((await farmer.c('POST', `/api/conversations/${conversationId}/messages`, { body: 'Are you there?' })).status, 403);
});

test('cancelling a paid event refunds every ticket and reverses host earnings', async () => {
  const ev = (await spec.c('POST', '/api/events', { title: 'Paid clinic: soil sampling', description: 'Hands-on walk-through of soil sampling and reading lab results.', topic: 'soil-health', startsAt: inHours(48), durationMin: 60, priceNgn: 3000 })).event;
  const reg = await farmer.c('POST', `/api/events/${ev.id}/register`);
  await pay(reg.checkoutUrl);
  const pending = db.get("SELECT COALESCE(SUM(amount_ngn),0) AS n FROM ledger_entries WHERE source_type='event_ticket' AND source_id=? AND account_id=?", ev.id, spec.id).n;
  assert.equal(pending, 2700);
  const r = await spec.c('POST', `/api/events/${ev.id}/cancel`, { reason: 'Speaker unwell' });
  assert.equal(r.refundFailures, 0);
  const net = db.get("SELECT COALESCE(SUM(amount_ngn),0) AS n FROM ledger_entries WHERE source_type='event_ticket' AND source_id=? AND account_id=?", ev.id, spec.id).n;
  assert.equal(net, 0);
  assert.equal(db.get("SELECT status FROM payments WHERE purpose='event_ticket' AND subject_id=?", ev.id).status, 'refunded');
});
