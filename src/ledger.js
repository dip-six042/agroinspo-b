// Earnings ledger (PRD §28). Entries are append-only (enforced by DB triggers); balances are
// always computed from entries, never stored. account_id NULL is the platform's own account.
//
//   pending   = entries whose available_at is still in the future, or that are under a hold
//   available = everything else, minus money already committed to an unpaid payout
import { newId, now } from './security.js';
import { COMMISSION, HOLD_DAYS } from './config.js';

const DAY = 86400000;

export function createLedger(db) {
  const add = ({ accountId = null, type, amount, sourceType, sourceId, paymentId = null, availableAt = now(), memo = '', createdBy = null }) => {
    if (!Number.isInteger(amount)) throw new Error('Ledger amounts are whole naira.');
    if (amount === 0) return null;
    const id = newId();
    db.run(
      `INSERT INTO ledger_entries (id, account_id, entry_type, amount_ngn, source_type, source_id, payment_id, available_at, memo, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, accountId, type, amount, sourceType, sourceId, paymentId, availableAt, memo, createdBy, now()
    );
    return id;
  };

  /**
   * Records a sale that pays a seller: gross to the seller, commission back to the platform,
   * and the provider's fee as a platform cost (the platform absorbs Kora fees from its commission).
   */
  function recordSale({ sellerId, purpose, sourceId, payment, availableFrom }) {
    const gross = payment.amount_ngn;
    const commission = Math.round(gross * COMMISSION[purpose]);
    const availableAt = new Date(new Date(availableFrom).getTime() + HOLD_DAYS[purpose] * DAY).toISOString();
    const memo = payment.description;
    db.tx(() => {
      add({ accountId: sellerId, type: 'sale', amount: gross, sourceType: purpose, sourceId, paymentId: payment.id, availableAt, memo });
      add({ accountId: sellerId, type: 'platform_fee', amount: -commission, sourceType: purpose, sourceId, paymentId: payment.id, availableAt, memo: `${Math.round(COMMISSION[purpose] * 100)}% platform commission` });
      add({ accountId: null, type: 'platform_fee', amount: commission, sourceType: purpose, sourceId, paymentId: payment.id, memo });
      if (payment.fee_ngn) add({ accountId: null, type: 'provider_fee', amount: -payment.fee_ngn, sourceType: purpose, sourceId, paymentId: payment.id, memo: 'Kora fee' });
    });
    return { gross, commission, net: gross - commission, availableAt };
  }

  /** Platform-only income (job listing fees). */
  function recordPlatformIncome({ purpose, sourceId, payment }) {
    db.tx(() => {
      add({ accountId: null, type: 'sale', amount: payment.amount_ngn, sourceType: purpose, sourceId, paymentId: payment.id, memo: payment.description });
      if (payment.fee_ngn) add({ accountId: null, type: 'provider_fee', amount: -payment.fee_ngn, sourceType: purpose, sourceId, paymentId: payment.id, memo: 'Kora fee' });
    });
  }

  /**
   * Reverses part or all of a sale after a refund, in proportion: the seller loses their share
   * and the platform returns its commission. Refunds are immediately effective.
   */
  function recordRefund({ purpose, sourceId, payment, refundNgn, createdBy, memo }) {
    const entries = db.all("SELECT * FROM ledger_entries WHERE source_type = ? AND source_id = ? AND payment_id = ? AND entry_type IN ('sale','platform_fee')", purpose, sourceId, payment.id);
    const ratio = refundNgn / payment.amount_ngn;
    db.tx(() => {
      for (const e of entries) {
        const amount = -Math.round(e.amount_ngn * ratio);
        // A refund follows the sale it reverses: refunding a still-pending sale stays pending with it
        // instead of eating into the seller's other, already-available earnings.
        add({ accountId: e.account_id, type: 'refund', amount, sourceType: purpose, sourceId, paymentId: payment.id, availableAt: e.available_at, memo: memo || 'Refund', createdBy });
      }
    });
  }

  // A hold freezes earnings that haven't left yet. Entries already in a payout aren't held:
  // that money is gone, so a later refund is recovered from future earnings instead.
  const activeHold = `(EXISTS (SELECT 1 FROM earning_holds h WHERE h.source_type = e.source_type AND h.source_id = e.source_id AND h.released_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM payout_items pi JOIN payouts p ON p.id = pi.payout_id WHERE pi.entry_id = e.id AND p.status IN ('pending','processing','paid')))`;

  function balances(accountId) {
    const t = now();
    const row = db.get(
      `SELECT
         COALESCE(SUM(CASE WHEN e.available_at <= :t AND NOT ${activeHold} THEN e.amount_ngn ELSE 0 END), 0) AS settled,
         COALESCE(SUM(CASE WHEN e.available_at > :t AND NOT ${activeHold} THEN e.amount_ngn ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN ${activeHold} THEN e.amount_ngn ELSE 0 END), 0) AS held,
         COALESCE(SUM(CASE WHEN e.entry_type IN ('sale') THEN e.amount_ngn ELSE 0 END), 0) AS gross,
         COALESCE(SUM(CASE WHEN e.entry_type = 'platform_fee' THEN e.amount_ngn ELSE 0 END), 0) AS fees,
         COALESCE(SUM(CASE WHEN e.entry_type = 'refund' THEN e.amount_ngn ELSE 0 END), 0) AS refunds,
         COALESCE(SUM(CASE WHEN e.entry_type IN ('payout','payout_reversal') THEN e.amount_ngn ELSE 0 END), 0) AS paid_out
       FROM ledger_entries e WHERE e.account_id IS :acct`,
      { t, acct: accountId }
    );
    // Money already promised to a payout that hasn't been paid yet.
    const committed = accountId
      ? db.get("SELECT COALESCE(SUM(amount_ngn),0) AS n FROM payouts WHERE user_id = ? AND status IN ('pending','processing')", accountId).n
      : 0;
    return {
      availableNgn: row.settled - committed,
      pendingNgn: row.pending,
      heldNgn: row.held,
      inPayoutNgn: committed,
      grossNgn: row.gross,
      platformFeesNgn: -row.fees,
      refundsNgn: -row.refunds,
      paidOutNgn: -row.paid_out
    };
  }

  /** Settled, unheld entries not yet covered by a payout (for payout_items traceability). */
  function payableEntries(accountId) {
    return db.all(
      `SELECT e.* FROM ledger_entries e
       WHERE e.account_id = :acct AND e.available_at <= :t AND NOT ${activeHold}
         AND e.entry_type NOT IN ('payout','payout_reversal')
         AND NOT EXISTS (SELECT 1 FROM payout_items pi JOIN payouts p ON p.id = pi.payout_id
                         WHERE pi.entry_id = e.id AND p.status IN ('pending','processing','paid'))`,
      { acct: accountId, t: now() }
    );
  }

  function hold(sourceType, sourceId, reason, by) {
    const existing = db.get('SELECT id FROM earning_holds WHERE source_type = ? AND source_id = ? AND released_at IS NULL', sourceType, sourceId);
    if (existing) return existing.id;
    const id = newId();
    db.run('INSERT INTO earning_holds (id, source_type, source_id, reason, created_by, created_at) VALUES (?,?,?,?,?,?)', id, sourceType, sourceId, reason, by, now());
    return id;
  }
  function release(sourceType, sourceId, by) {
    db.run('UPDATE earning_holds SET released_at = ?, released_by = ? WHERE source_type = ? AND source_id = ? AND released_at IS NULL', now(), by, sourceType, sourceId);
  }

  return { add, recordSale, recordPlatformIncome, recordRefund, balances, payableEntries, hold, release };
}
