// Earnings, statements, payout accounts and batches, finance overview, support tickets and disputes (PRD §28, §33).
import { randomBytes } from 'node:crypto';
import { newId, now } from '../security.js';
import { COMMISSION, HOLD_DAYS, MIN_PAYOUT_NGN, ALLOW_SELF_APPROVAL, BOOK_REFUND_DAYS } from '../config.js';

const DAY = 86400000;

// Sample list for development. In test/live mode, load the full list from Kora's banks endpoint.
export const BANKS = [
  ['044', 'Access Bank'], ['023', 'Citibank Nigeria'], ['050', 'Ecobank Nigeria'], ['070', 'Fidelity Bank'], ['011', 'First Bank of Nigeria'],
  ['214', 'First City Monument Bank'], ['058', 'Guaranty Trust Bank'], ['030', 'Heritage Bank'], ['082', 'Keystone Bank'], ['50211', 'Kuda Microfinance Bank'],
  ['50515', 'Moniepoint Microfinance Bank'], ['999992', 'OPay'], ['999991', 'PalmPay'], ['076', 'Polaris Bank'], ['221', 'Stanbic IBTC Bank'],
  ['232', 'Sterling Bank'], ['032', 'Union Bank of Nigeria'], ['033', 'United Bank for Africa'], ['215', 'Unity Bank'], ['035', 'Wema Bank'], ['057', 'Zenith Bank']
];

const csvCell = (v) => {
  const s = String(v ?? '');
  // Neutralise spreadsheet formulas and quote everything.
  return `"${(/^[=+\-@]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`;
};
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export function registerFinance(kit) {
  const { db, route, audit, notify, payments, ledger, HttpError, bad, str, oneOf, requireActive } = kit;
  const naira = (n) => '₦' + Number(n).toLocaleString('en-NG');
  const mask = (acct) => acct ? `•••• ${acct.slice(-4)}` : '';

  const entryView = (e) => ({
    id: e.id, type: e.entry_type, amountNgn: e.amount_ngn, sourceType: e.source_type, sourceId: e.source_id,
    availableAt: e.available_at, memo: e.memo, createdAt: e.created_at, pending: e.available_at > now()
  });

  const rules = () => ({
    commissionPct: Object.fromEntries(Object.entries(COMMISSION).map(([k, v]) => [k, Math.round(v * 100)])),
    holdDays: HOLD_DAYS,
    minPayoutNgn: MIN_PAYOUT_NGN,
    bookRefundDays: BOOK_REFUND_DAYS,
    selfApproval: ALLOW_SELF_APPROVAL,
    schedule: 'Weekly, after finance approval'
  });

  /* ---------- earnings ---------- */
  route('GET', '/api/me/earnings', (ctx) => {
    const acct = db.get('SELECT * FROM payout_accounts WHERE user_id = ?', ctx.user.id);
    return {
      balances: ledger.balances(ctx.user.id),
      entries: db.all('SELECT * FROM ledger_entries WHERE account_id = ? ORDER BY created_at DESC LIMIT 200', ctx.user.id).map(entryView),
      payouts: db.all('SELECT * FROM payouts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', ctx.user.id)
        .map((p) => ({ reference: p.reference, amountNgn: p.amount_ngn, status: p.status, failureReason: p.failure_reason, createdAt: p.created_at, paidAt: p.paid_at })),
      payoutAccount: acct ? { bankCode: acct.bank_code, bankName: acct.bank_name, accountNumber: mask(acct.account_number), accountName: acct.account_name, verifiedAt: acct.verified_at } : null,
      rules: rules()
    };
  }, { auth: true });

  route('GET', '/api/me/statement', (ctx) => {
    const from = ctx.query.get('from') || '0000';
    const to = ctx.query.get('to') || '9999';
    const rows = db.all('SELECT * FROM ledger_entries WHERE account_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at', ctx.user.id, from, to + 'T23:59:59.999Z');
    let running = 0;
    const body = csv([
      ['Date', 'Type', 'Description', 'Source', 'Source ID', 'Amount (NGN)', 'Running total (NGN)', 'Available from'],
      ...rows.map((e) => {
        running += e.amount_ngn;
        return [e.created_at.slice(0, 19).replace('T', ' '), e.entry_type, e.memo, e.source_type, e.source_id, e.amount_ngn, running, e.available_at.slice(0, 10)];
      })
    ]);
    return { file: { buffer: Buffer.from('﻿' + body, 'utf8'), mime: 'text/csv; charset=utf-8', filename: `agroinspo-statement-${new Date().toISOString().slice(0, 10)}.csv` } };
  }, { auth: true });

  route('GET', '/api/banks', () => ({ banks: BANKS.map(([code, name]) => ({ code, name })) }));

  route('PUT', '/api/me/payout-account', async (ctx) => {
    requireActive(ctx);
    if (!kit.limit(`payacct:${ctx.user.id}`, 5, 24 * 3600_000)) throw new HttpError(429, 'rate_limited', 'You can change your payout account 5 times a day.');
    const bank = BANKS.find(([c]) => c === String(ctx.body.bankCode || ''));
    if (!bank) throw bad('Choose your bank from the list.');
    const accountNumber = String(ctx.body.accountNumber || '').replace(/\s/g, '');
    if (!/^\d{10}$/.test(accountNumber)) throw bad('Nigerian account numbers (NUBAN) have 10 digits.');
    let resolved;
    try {
      resolved = await payments.resolveAccount({ bankCode: bank[0], accountNumber });
    } catch {
      throw bad('We couldn’t confirm that account with the bank. Check the number and bank.');
    }
    db.run(
      `INSERT INTO payout_accounts (user_id, bank_code, bank_name, account_number, account_name, verified_at, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET bank_code=excluded.bank_code, bank_name=excluded.bank_name, account_number=excluded.account_number,
         account_name=excluded.account_name, verified_at=excluded.verified_at, updated_at=excluded.updated_at`,
      ctx.user.id, bank[0], bank[1], accountNumber, resolved.accountName, now(), now()
    );
    audit(ctx, 'payout_account.changed', 'user', ctx.user.id, { bank: bank[1], last4: accountNumber.slice(-4) });
    // Security notice: a changed payout account is the classic account-takeover target.
    notify(ctx.user.id, 'security', 'Payout account changed', `${bank[1]} ${mask(accountNumber)}. Payouts to a new account start after 24 hours. If this wasn’t you, contact support now.`, 'earnings');
    return { payoutAccount: { bankCode: bank[0], bankName: bank[1], accountNumber: mask(accountNumber), accountName: resolved.accountName, verifiedAt: now() } };
  }, { auth: true });

  /* ---------- admin: finance overview, adjustments ---------- */
  route('GET', '/api/admin/finance', () => {
    const platform = ledger.balances(null);
    const sellers = db.get(`SELECT COALESCE(SUM(amount_ngn),0) AS owed FROM ledger_entries WHERE account_id IS NOT NULL`).owed;
    const collected = db.get("SELECT COALESCE(SUM(amount_ngn),0) AS g, COALESCE(SUM(refunded_ngn),0) AS r, COALESCE(SUM(fee_ngn),0) AS f FROM payments WHERE status IN ('successful','partially_refunded','refunded','under_review')");
    const byPurpose = db.all("SELECT purpose, COUNT(*) AS n, SUM(amount_ngn) AS gross FROM payments WHERE status IN ('successful','partially_refunded','refunded') GROUP BY purpose");
    return {
      collectedNgn: collected.g,
      refundedNgn: collected.r,
      providerFeesNgn: collected.f,
      platformRevenueNgn: platform.availableNgn + platform.pendingNgn,
      owedToSellersNgn: sellers,
      paymentsUnderReview: db.get("SELECT COUNT(*) AS n FROM payments WHERE status = 'under_review'").n,
      byPurpose,
      rules: rules()
    };
  }, { roles: ['admin'] });

  route('POST', '/api/admin/adjustments', (ctx) => {
    const user = db.get('SELECT id, name FROM users WHERE id = ?', String(ctx.body.userId || ''));
    if (!user) throw new HttpError(404, 'not_found', 'Member not found.');
    const amount = Number(ctx.body.amountNgn);
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 5_000_000) throw bad('Adjustment must be a whole number of naira, not zero.');
    const reason = str(ctx.body.reason, 'Reason', { min: 10, max: 500 });
    // Corrections are new entries, never edits (PRD §33).
    ledger.add({ accountId: user.id, type: 'adjustment', amount, sourceType: 'adjustment', sourceId: newId(), memo: reason, createdBy: ctx.user.id });
    audit(ctx, 'ledger.adjustment', 'user', user.id, { amountNgn: amount, reason });
    notify(user.id, 'payment', 'Earnings adjusted', `${amount > 0 ? '+' : ''}${naira(amount)} · ${reason}`, 'earnings');
    return { ok: true };
  }, { roles: ['admin'] });

  /* ---------- admin: payout batches (maker-checker) ---------- */
  const batchView = (b) => {
    const rows = db.all(
      `SELECT p.*, u.name FROM payouts p JOIN users u ON u.id = p.user_id WHERE p.batch_id = ? ORDER BY u.name`, b.id
    );
    return {
      id: b.id, status: b.status, totalNgn: b.total_ngn, createdAt: b.created_at, approvedAt: b.approved_at, completedAt: b.completed_at,
      createdBy: db.get('SELECT name FROM users WHERE id = ?', b.created_by)?.name,
      approvedBy: b.approved_by ? db.get('SELECT name FROM users WHERE id = ?', b.approved_by)?.name : null,
      payouts: rows.map((p) => ({
        id: p.id, reference: p.reference, user: { id: p.user_id, name: p.name }, amountNgn: p.amount_ngn, status: p.status,
        account: JSON.parse(p.account_snapshot), failureReason: p.failure_reason, paidAt: p.paid_at
      }))
    };
  };

  route('GET', '/api/admin/payout-batches', () => ({
    batches: db.all('SELECT * FROM payout_batches ORDER BY created_at DESC LIMIT 30').map(batchView),
    minPayoutNgn: MIN_PAYOUT_NGN
  }), { roles: ['admin'] });

  route('POST', '/api/admin/payout-batches', (ctx) => {
    if (db.get("SELECT 1 FROM payout_batches WHERE status = 'draft'")) throw new HttpError(409, 'draft_exists', 'Approve or cancel the current draft batch first.');
    const cutoff = new Date(Date.now() - DAY).toISOString();
    const candidates = db.all(
      `SELECT DISTINCT e.account_id AS id FROM ledger_entries e JOIN users u ON u.id = e.account_id WHERE e.account_id IS NOT NULL AND u.status = 'active'`
    );
    const batchId = newId();
    const skipped = [];
    let total = 0;
    db.tx(() => {
      db.run('INSERT INTO payout_batches (id, created_by, created_at) VALUES (?,?,?)', batchId, ctx.user.id, now());
      for (const { id } of candidates) {
        const bal = ledger.balances(id);
        if (bal.availableNgn < MIN_PAYOUT_NGN) continue;
        const acct = db.get('SELECT * FROM payout_accounts WHERE user_id = ?', id);
        const name = db.get('SELECT name FROM users WHERE id = ?', id).name;
        if (!acct) { skipped.push({ name, reason: 'No payout account' }); continue; }
        if (acct.verified_at > cutoff) { skipped.push({ name, reason: 'Payout account changed in the last 24 hours' }); continue; }
        const pid = newId();
        const reference = `AI-PO-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
        db.run(
          'INSERT INTO payouts (id, batch_id, user_id, amount_ngn, reference, account_snapshot, created_at) VALUES (?,?,?,?,?,?,?)',
          pid, batchId, id, bal.availableNgn, reference,
          JSON.stringify({ bank: acct.bank_name, bankCode: acct.bank_code, last4: acct.account_number.slice(-4), name: acct.account_name }), now()
        );
        for (const e of ledger.payableEntries(id)) db.run('INSERT OR IGNORE INTO payout_items (payout_id, entry_id) VALUES (?,?)', pid, e.id);
        total += bal.availableNgn;
      }
      db.run('UPDATE payout_batches SET total_ngn = ? WHERE id = ?', total, batchId);
      audit(ctx, 'payout_batch.created', 'payout_batch', batchId, { totalNgn: total });
    });
    return { status: 201, body: { batch: batchView(db.get('SELECT * FROM payout_batches WHERE id = ?', batchId)), skipped } };
  }, { roles: ['admin'] });

  route('POST', '/api/admin/payout-batches/:id/cancel', (ctx) => {
    const b = db.get('SELECT * FROM payout_batches WHERE id = ?', ctx.params.id);
    if (!b || b.status !== 'draft') throw bad('Only draft batches can be cancelled.');
    db.tx(() => {
      db.run("UPDATE payout_batches SET status = 'cancelled' WHERE id = ?", b.id);
      db.run("UPDATE payouts SET status = 'cancelled' WHERE batch_id = ?", b.id);
      audit(ctx, 'payout_batch.cancelled', 'payout_batch', b.id);
    });
    return { ok: true };
  }, { roles: ['admin'] });

  // A second admin approves; then each payout is sent through Kora.
  route('POST', '/api/admin/payout-batches/:id/approve', async (ctx) => {
    const b = db.get('SELECT * FROM payout_batches WHERE id = ?', ctx.params.id);
    if (!b || b.status !== 'draft') throw bad('Only draft batches can be approved.');
    if (b.created_by === ctx.user.id && !ALLOW_SELF_APPROVAL)
      throw new HttpError(403, 'maker_checker', 'A different admin must approve a batch you prepared.');
    const claimed = db.run("UPDATE payout_batches SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ? AND status = 'draft'", ctx.user.id, now(), b.id).changes;
    if (!claimed) throw bad('This batch is already being processed.');
    audit(ctx, 'payout_batch.approved', 'payout_batch', b.id, { totalNgn: b.total_ngn });
    const results = { paid: 0, failed: 0 };
    for (const p of db.all("SELECT * FROM payouts WHERE batch_id = ? AND status = 'pending'", b.id)) {
      const acct = db.get('SELECT * FROM payout_accounts WHERE user_id = ?', p.user_id);
      const user = db.get('SELECT email FROM users WHERE id = ?', p.user_id);
      db.run("UPDATE payouts SET status = 'processing' WHERE id = ?", p.id);
      let r;
      try {
        r = await payments.payout({
          reference: p.reference, amountNgn: p.amount_ngn, bankCode: acct.bank_code, accountNumber: acct.account_number,
          accountName: acct.account_name, narration: 'Agro Inspo earnings', email: user.email
        });
      } catch (err) {
        r = { status: 'failed', reason: 'Provider error' };
      }
      if (r.status === 'successful') {
        db.tx(() => {
          db.run("UPDATE payouts SET status = 'paid', provider_ref = ?, paid_at = ? WHERE id = ?", r.providerRef || '', now(), p.id);
          ledger.add({ accountId: p.user_id, type: 'payout', amount: -p.amount_ngn, sourceType: 'payout', sourceId: p.id, memo: `Payout ${p.reference}`, createdBy: ctx.user.id });
        });
        notify(p.user_id, 'payout', 'Payout sent', `${naira(p.amount_ngn)} to ${JSON.parse(p.account_snapshot).bank} ${'•••• ' + JSON.parse(p.account_snapshot).last4}. Reference ${p.reference}.`, 'earnings');
        results.paid++;
      } else if (r.status === 'failed') {
        db.run("UPDATE payouts SET status = 'failed', failure_reason = ? WHERE id = ?", r.reason || 'Failed', p.id);
        notify(p.user_id, 'payout', 'Payout failed', `${r.reason || 'The bank rejected the transfer.'} Check your payout account; the money stays in your balance.`, 'earnings');
        audit(ctx, 'payout.failed', 'payout', p.id, { reason: r.reason });
        results.failed++;
      }
      // 'processing' stays as is until Kora's webhook confirms it (test/live mode).
    }
    db.run("UPDATE payout_batches SET status = 'completed', completed_at = ? WHERE id = ?", now(), b.id);
    return { results, batch: batchView(db.get('SELECT * FROM payout_batches WHERE id = ?', b.id)) };
  }, { roles: ['admin'] });

  // Reconciliation report: every payout and the ledger entries it covered.
  route('GET', '/api/admin/payout-batches/:id/report', (ctx) => {
    const b = db.get('SELECT * FROM payout_batches WHERE id = ?', ctx.params.id);
    if (!b) throw new HttpError(404, 'not_found', 'Batch not found.');
    const rows = [['Payout reference', 'Member', 'Bank', 'Account', 'Amount (NGN)', 'Status', 'Provider reference', 'Entries covered', 'Sum of entries (NGN)', 'Matches']];
    for (const p of db.all('SELECT p.*, u.name FROM payouts p JOIN users u ON u.id = p.user_id WHERE batch_id = ?', b.id)) {
      const s = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(e.amount_ngn),0) AS total FROM payout_items pi JOIN ledger_entries e ON e.id = pi.entry_id WHERE pi.payout_id = ?', p.id);
      const a = JSON.parse(p.account_snapshot);
      rows.push([p.reference, p.name, a.bank, `****${a.last4}`, p.amount_ngn, p.status, p.provider_ref, s.n, s.total, s.total >= p.amount_ngn ? 'yes' : 'CHECK']);
    }
    return { file: { buffer: Buffer.from('﻿' + csv(rows), 'utf8'), mime: 'text/csv; charset=utf-8', filename: `payout-batch-${b.created_at.slice(0, 10)}.csv` } };
  }, { roles: ['admin'] });

  /* ---------- support tickets & disputes ---------- */
  function subjectFor(ctx, type, id) {
    if (!type) return { paymentId: null };
    if (type === 'booking') {
      const b = db.get('SELECT * FROM bookings WHERE id = ?', id);
      if (!b || (b.client_id !== ctx.user.id && b.specialist_id !== ctx.user.id)) throw bad('Choose one of your bookings.');
      return { paymentId: b.payment_id, booking: b };
    }
    if (type === 'book_purchase') {
      const p = db.get('SELECT * FROM book_purchases WHERE id = ? AND buyer_id = ?', id, ctx.user.id);
      if (!p) throw bad('Choose one of your purchases.');
      return { paymentId: p.payment_id, purchase: p };
    }
    if (type === 'event_ticket') {
      const r = db.get('SELECT * FROM event_registrations WHERE event_id = ? AND user_id = ?', id, ctx.user.id);
      if (!r?.payment_id) throw bad('Choose an event you bought a ticket for.');
      return { paymentId: r.payment_id };
    }
    if (type === 'job_listing') {
      const j = db.get('SELECT * FROM jobs WHERE id = ? AND employer_id = ?', id, ctx.user.id);
      if (!j) throw bad('Choose one of your job listings.');
      return { paymentId: db.get("SELECT id FROM payments WHERE purpose='job_listing' AND subject_id=? AND status IN ('successful','partially_refunded') ORDER BY created_at DESC", j.id)?.id ?? null };
    }
    if (type === 'sponsorship') {
      const sp = db.get('SELECT * FROM event_sponsorships WHERE id = ? AND business_id = ?', id, ctx.user.id);
      if (!sp?.payment_id) throw bad('Choose one of your paid sponsorships.');
      return { paymentId: sp.payment_id, sponsorship: sp };
    }
    if (type === 'advert') {
      const ad = db.get('SELECT * FROM ad_campaigns WHERE id = ? AND business_id = ?', id, ctx.user.id);
      if (!ad?.payment_id) throw bad('Choose one of your paid adverts.');
      return { paymentId: ad.payment_id };
    }
    if (type === 'payout') {
      const p = db.get('SELECT * FROM payouts WHERE reference = ? AND user_id = ?', id, ctx.user.id);
      if (!p) throw bad('Choose one of your payouts.');
      return { paymentId: null };
    }
    throw bad('Unknown subject.');
  }

  const ticketView = (t, withMessages) => ({
    id: t.id, category: t.category, subjectType: t.subject_type, subjectId: t.subject_id, title: t.title, status: t.status,
    resolution: t.resolution, createdAt: t.created_at, updatedAt: t.updated_at, user: t.user_name ? { id: t.user_id, name: t.user_name } : undefined,
    ...(withMessages ? {
      messages: db.all('SELECT m.*, u.name FROM ticket_messages m JOIN users u ON u.id = m.user_id WHERE ticket_id = ? ORDER BY created_at', t.id)
        .map((m) => ({ id: m.id, body: m.body, fromStaff: !!m.from_staff, name: m.from_staff ? 'Agro Inspo support' : m.name, createdAt: m.created_at }))
    } : {})
  });

  route('POST', '/api/support', (ctx) => {
    if (!kit.limit(`ticket:${ctx.user.id}`, 10, 24 * 3600_000)) throw new HttpError(429, 'rate_limited', 'You’ve opened a lot of tickets today. We’ll get to them soon.');
    const category = oneOf(ctx.body.category, ['dispute', 'refund', 'payment', 'account', 'technical', 'other'], 'Category');
    const subjectType = ctx.body.subjectType ? oneOf(ctx.body.subjectType, ['booking', 'book_purchase', 'event_ticket', 'job_listing', 'payout', 'sponsorship', 'advert'], 'Subject') : '';
    const subjectId = String(ctx.body.subjectId || '');
    const title = str(ctx.body.title, 'Subject line', { min: 5, max: 140 });
    const message = str(ctx.body.message, 'Message', { min: 20, max: 4000 });
    const subject = subjectFor(ctx, subjectType, subjectId);
    let holdId = null;
    // A dispute about a recent consultation freezes the specialist's earning until it's resolved.
    if (category === 'dispute' && subject.booking) {
      const b = subject.booking;
      if (b.client_id !== ctx.user.id) throw bad('Only the client can dispute a consultation. Specialists can open a support ticket instead.');
      if (!['completed', 'no_show', 'in_progress', 'confirmed'].includes(b.status)) throw bad('This booking can’t be disputed.');
      const endedAt = b.completed_at ? new Date(b.completed_at).getTime() : new Date(b.starts_at).getTime() + b.duration_min * 60000;
      if (Date.now() - endedAt > HOLD_DAYS.consultation * DAY) throw bad(`Disputes must be raised within ${HOLD_DAYS.consultation} days of the session.`);
      holdId = ledger.hold('consultation', b.id, `Dispute: ${title}`, ctx.user.id);
      db.run("UPDATE bookings SET status = 'disputed', updated_at = ? WHERE id = ?", now(), b.id);
      notify(b.specialist_id, 'booking', 'A client raised a dispute', `${title}. Earnings for this session are on hold while support reviews it.`, `booking:${b.id}`);
    }
    if (category === 'refund' && subject.purchase) {
      const p = subject.purchase;
      if (p.status !== 'paid') throw bad('This purchase can’t be refunded.');
      if (Date.now() - new Date(p.paid_at).getTime() > BOOK_REFUND_DAYS * DAY) throw bad(`Book refunds must be requested within ${BOOK_REFUND_DAYS} days.`);
      holdId = ledger.hold('book_purchase', p.id, `Refund request: ${title}`, ctx.user.id);
    }
    // A sponsor disputing undelivered sponsorship freezes the host's earning for it.
    if (category === 'dispute' && subject.sponsorship) {
      const sp = subject.sponsorship;
      if (!['confirmed', 'completed'].includes(sp.status)) throw bad('This sponsorship can’t be disputed.');
      const ev = db.get('SELECT * FROM events WHERE id = ?', sp.event_id);
      const endedAt = new Date(ev.starts_at).getTime() + ev.duration_min * 60000;
      if (Date.now() - endedAt > HOLD_DAYS.sponsorship * DAY) throw bad(`Sponsorship disputes must be raised within ${HOLD_DAYS.sponsorship} days of the event.`);
      holdId = ledger.hold('sponsorship', sp.id, `Dispute: ${title}`, ctx.user.id);
      notify(ev.host_id, 'sponsorship', 'A sponsor raised a dispute', `${title}. Earnings for this sponsorship are on hold while support reviews it.`, `event:${ev.id}`);
    }
    const id = newId();
    db.tx(() => {
      db.run(
        'INSERT INTO support_tickets (id, user_id, category, subject_type, subject_id, title, hold_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, ctx.user.id, category, subjectType, subjectId, title, holdId, now(), now()
      );
      db.run('INSERT INTO ticket_messages (id, ticket_id, user_id, body, created_at) VALUES (?,?,?,?,?)', newId(), id, ctx.user.id, message, now());
    });
    return { status: 201, body: { ticket: { id, status: 'open' } } };
  }, { auth: true });

  route('GET', '/api/me/support', (ctx) => ({
    tickets: db.all('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC', ctx.user.id).map((t) => ticketView(t, false))
  }), { auth: true });

  route('GET', '/api/support/:id', (ctx) => {
    const t = db.get('SELECT t.*, u.name AS user_name FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?', ctx.params.id);
    if (!t || (t.user_id !== ctx.user.id && ctx.user.role !== 'admin')) throw new HttpError(404, 'not_found', 'Ticket not found.');
    return { ticket: ticketView(t, true) };
  }, { auth: true });

  route('POST', '/api/support/:id/messages', (ctx) => {
    const t = db.get('SELECT * FROM support_tickets WHERE id = ?', ctx.params.id);
    const staff = ctx.user.role === 'admin';
    if (!t || (t.user_id !== ctx.user.id && !staff)) throw new HttpError(404, 'not_found', 'Ticket not found.');
    if (t.status === 'resolved' && !staff) throw bad('This ticket is resolved. Open a new one if you need more help.');
    const body = str(ctx.body.body, 'Message', { min: 1, max: 4000 });
    db.run('INSERT INTO ticket_messages (id, ticket_id, user_id, from_staff, body, created_at) VALUES (?,?,?,?,?,?)', newId(), t.id, ctx.user.id, staff ? 1 : 0, body, now());
    db.run('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?', staff ? 'waiting_on_user' : 'open', now(), t.id);
    if (staff) notify(t.user_id, 'support', 'Support replied', t.title, `support:${t.id}`);
    return { ok: true };
  }, { auth: true });

  route('GET', '/api/admin/support', (ctx) => {
    const status = oneOf(ctx.query.get('status') || 'open', ['open', 'waiting_on_user', 'resolved'], 'Status');
    return {
      tickets: db.all('SELECT t.*, u.name AS user_name FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.status = ? ORDER BY t.updated_at ASC LIMIT 200', status)
        .map((t) => ticketView(t, true))
    };
  }, { roles: ['admin'] });

  // Resolve a ticket, optionally refunding (full or partial) and releasing any hold.
  route('POST', '/api/admin/support/:id/resolve', async (ctx) => {
    const t = db.get('SELECT * FROM support_tickets WHERE id = ?', ctx.params.id);
    if (!t) throw new HttpError(404, 'not_found', 'Ticket not found.');
    if (t.status === 'resolved') throw bad('Already resolved.');
    const resolution = str(ctx.body.resolution, 'Resolution', { min: 10, max: 2000 });
    const refundNgn = ctx.body.refundNgn ? Number(ctx.body.refundNgn) : 0;
    let paymentId = null;
    if (t.subject_type === 'booking') paymentId = db.get('SELECT payment_id FROM bookings WHERE id = ?', t.subject_id)?.payment_id;
    if (t.subject_type === 'book_purchase') paymentId = db.get('SELECT payment_id FROM book_purchases WHERE id = ?', t.subject_id)?.payment_id;
    if (t.subject_type === 'event_ticket') paymentId = db.get('SELECT payment_id FROM event_registrations WHERE event_id = ? AND user_id = ?', t.subject_id, t.user_id)?.payment_id;
    if (t.subject_type === 'sponsorship') paymentId = db.get('SELECT payment_id FROM event_sponsorships WHERE id = ?', t.subject_id)?.payment_id;
    if (t.subject_type === 'advert') paymentId = db.get('SELECT payment_id FROM ad_campaigns WHERE id = ?', t.subject_id)?.payment_id;
    if (t.subject_type === 'job_listing') paymentId = db.get("SELECT id FROM payments WHERE purpose='job_listing' AND subject_id=? AND status IN ('successful','partially_refunded') ORDER BY created_at DESC", t.subject_id)?.id;
    if (refundNgn) {
      if (!paymentId) throw bad('There’s no payment linked to this ticket to refund.');
      const p = await kit.refundPayment(paymentId, refundNgn, `Support: ${t.title}`, ctx.user);
      if (t.subject_type === 'book_purchase' && p.refunded_ngn >= p.amount_ngn)
        db.run("UPDATE book_purchases SET status = 'refunded' WHERE id = ?", t.subject_id); // access is withdrawn with a full refund
      if (t.subject_type === 'booking') db.run("UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?", p.refunded_ngn >= p.amount_ngn ? 'refunded' : 'completed', now(), t.subject_id);
    } else if (t.subject_type === 'booking') {
      db.run("UPDATE bookings SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'disputed'", now(), t.subject_id);
    }
    const source = { booking: 'consultation', book_purchase: 'book_purchase', sponsorship: 'sponsorship' }[t.subject_type];
    if (source) ledger.release(source, t.subject_id, ctx.user.id);
    db.tx(() => {
      db.run("UPDATE support_tickets SET status = 'resolved', resolution = ?, updated_at = ? WHERE id = ?", resolution, now(), t.id);
      db.run('INSERT INTO ticket_messages (id, ticket_id, user_id, from_staff, body, created_at) VALUES (?,?,?,?,?,?)', newId(), t.id, ctx.user.id, 1, resolution, now());
      audit(ctx, 'support.resolved', 'ticket', t.id, { refundNgn, subject: `${t.subject_type}:${t.subject_id}` });
    });
    notify(t.user_id, 'support', 'Your support request is resolved', resolution.slice(0, 160), `support:${t.id}`);
    if (t.subject_type === 'booking') {
      const b = db.get('SELECT specialist_id FROM bookings WHERE id = ?', t.subject_id);
      if (b) notify(b.specialist_id, 'booking', 'Dispute resolved', refundNgn ? `The client was refunded ${naira(refundNgn)}.` : 'No refund was due; your earning is released.', `booking:${t.subject_id}`);
    }
    return { ok: true };
  }, { roles: ['admin'] });
}
