// Payments: initialise, Kora webhook, status checks, dummy checkout, admin list.
import { randomBytes } from 'node:crypto';
import { newId, now } from '../security.js';
import { signKoraPayload, verifyKoraSignature, mapKoraStatus } from '../payments.js';

const naira = (n) => '₦' + Number(n).toLocaleString('en-NG');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function registerPayments(kit) {
  const { db, route, audit, notify, payments, HttpError, cfg, fulfil } = kit;

  const view = (p) => ({
    reference: p.reference,
    purpose: p.purpose,
    subjectId: p.subject_id,
    description: p.description,
    amountNgn: p.amount_ngn,
    feeNgn: p.fee_ngn,
    refundedNgn: p.refunded_ngn ?? 0,
    status: p.status,
    provider: p.provider,
    paidAt: p.paid_at,
    createdAt: p.created_at,
    checkoutUrl: p.status === 'initiated' || p.status === 'pending' ? p.checkout_url : ''
  });

  /** Starts a payment and returns the checkout URL. Used by jobs and events. */
  kit.createPayment = async ({ user, purpose, subjectId, amountNgn, description, meta = {}, returnPath = '' }) => {
    if (!Number.isInteger(amountNgn) || amountNgn <= 0) throw new HttpError(400, 'invalid_amount', 'Nothing to pay for.');
    const reference = `AI-${{ job_listing: 'JOB', event_ticket: 'EVT', consultation: 'CON', book_purchase: 'BK', advert: 'AD', sponsorship: 'SPN' }[purpose]}-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const id = newId();
    const t = now();
    db.run(
      `INSERT INTO payments (id, reference, user_id, purpose, subject_id, description, amount_ngn, provider, status, meta, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'initiated', ?, ?, ?)`,
      id, reference, user.id, purpose, subjectId, description, amountNgn, payments.name, JSON.stringify({ ...meta, returnPath }), t, t
    );
    try {
      const init = await payments.initialize({
        reference,
        amountNgn,
        description,
        customer: { name: user.name, email: user.email },
        redirectUrl: `${cfg.appUrl}/?payment=${encodeURIComponent(reference)}`
      });
      db.run("UPDATE payments SET checkout_url = ?, provider_ref = ?, status = 'pending', updated_at = ? WHERE id = ?", init.checkoutUrl, init.providerRef, now(), id);
    } catch (err) {
      db.run("UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ?", now(), id);
      console.error('[payments] initialise failed', err);
      throw new HttpError(502, 'payment_unavailable', 'We couldn’t start the payment. Try again in a few minutes.');
    }
    audit({ user, ip: '' }, 'payment.initiated', 'payment', reference, { purpose, amountNgn });
    return db.get('SELECT * FROM payments WHERE id = ?', id);
  };

  /**
   * Applies a provider result exactly once. Successful payments are fulfilled inside the
   * same transaction, so a duplicate webhook or a simultaneous status check can't double-fulfil.
   */
  function applyResult(reference, { status, amountNgn, feeNgn = 0 }, source) {
    return db.tx(() => {
      const p = db.get('SELECT * FROM payments WHERE reference = ?', reference);
      if (!p) return null;
      if (['successful', 'refunded', 'partially_refunded', 'under_review'].includes(p.status)) return p;
      if (status === 'successful' && amountNgn !== undefined && Number(amountNgn) !== p.amount_ngn) {
        db.run("UPDATE payments SET status = 'under_review', updated_at = ? WHERE id = ?", now(), p.id);
        audit({ user: null, ip: '' }, 'payment.amount_mismatch', 'payment', reference, { expected: p.amount_ngn, got: amountNgn, source });
        return db.get('SELECT * FROM payments WHERE id = ?', p.id);
      }
      if (status === 'successful') {
        db.run("UPDATE payments SET status = 'successful', fee_ngn = ?, paid_at = ?, updated_at = ? WHERE id = ?", Math.round(feeNgn), now(), now(), p.id);
        audit({ user: null, ip: '' }, 'payment.successful', 'payment', reference, { amountNgn: p.amount_ngn, source });
        const done = db.get('SELECT * FROM payments WHERE id = ?', p.id);
        fulfil[p.purpose]?.(done);
        notify(p.user_id, 'payment', 'Payment received', `${naira(p.amount_ngn)} for ${p.description}. Reference ${reference}.`, `payment:${reference}`);
        return done;
      }
      if (status === 'failed' && p.status !== 'failed') {
        db.run("UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ?", now(), p.id);
        audit({ user: null, ip: '' }, 'payment.failed', 'payment', reference, { source });
        fulfil[`${p.purpose}:failed`]?.(p);
      }
      return db.get('SELECT * FROM payments WHERE id = ?', p.id);
    });
  }

  /** Handles a Kora webhook body. Returns false when the signature is wrong. */
  function handleWebhook(body, signature) {
    const data = body?.data;
    if (!data || typeof data !== 'object' || !verifyKoraSignature(data, signature, payments.secret)) return false;
    const eventKey = `${body.event}:${data.reference}:${data.status}`;
    const p = db.get('SELECT id FROM payments WHERE reference = ?', data.reference);
    const fresh = db.run(
      'INSERT OR IGNORE INTO payment_events (id, payment_id, event_key, payload, verified, created_at) VALUES (?,?,?,?,1,?)',
      newId(), p?.id ?? null, eventKey, JSON.stringify(body), now()
    ).changes;
    if (!fresh || !p) return true; // duplicate delivery or unknown reference: acknowledge, do nothing
    if (body.event === 'charge.success' || body.event === 'charge.failed') {
      applyResult(data.reference, { status: mapKoraStatus(data.status), amountNgn: data.amount, feeNgn: data.fee }, 'webhook');
    }
    return true;
  }
  kit.handleKoraWebhook = handleWebhook;

  /**
   * Refunds all or part of a successful payment through Kora, then reverses the matching
   * ledger entries in proportion. Returns the updated payment row.
   */
  kit.refundPayment = async (paymentId, amountNgn, reason, actor) => {
    const p = db.get('SELECT * FROM payments WHERE id = ?', paymentId);
    if (!p) throw new HttpError(404, 'not_found', 'Payment not found.');
    if (!['successful', 'partially_refunded', 'under_review'].includes(p.status)) throw new HttpError(409, 'not_refundable', 'Only completed payments can be refunded.');
    const left = p.amount_ngn - p.refunded_ngn;
    const amount = amountNgn === undefined ? left : amountNgn;
    if (!Number.isInteger(amount) || amount <= 0 || amount > left) throw new HttpError(400, 'invalid_amount', `Refund must be between ₦1 and ${naira(left)}.`);
    const r = await payments.refund({ reference: p.reference, amountNgn: amount, reason });
    if (r.status !== 'successful') throw new HttpError(502, 'refund_failed', 'Kora couldn’t process the refund. Try again or refund manually.');
    db.tx(() => {
      const refunded = p.refunded_ngn + amount;
      db.run('UPDATE payments SET refunded_ngn = ?, status = ?, updated_at = ? WHERE id = ?',
        refunded, refunded >= p.amount_ngn ? 'refunded' : 'partially_refunded', now(), p.id);
      const sourceId = p.subject_id;
      kit.ledger.recordRefund({ purpose: p.purpose, sourceId, payment: p, refundNgn: amount, createdBy: actor?.id ?? null, memo: reason });
      audit({ user: actor ?? null, ip: '' }, 'payment.refunded', 'payment', p.reference, { amountNgn: amount, reason });
      notify(p.user_id, 'payment', 'Refund issued', `${naira(amount)} for ${p.description}. It can take a few working days to reach your account.`, `payment:${p.reference}`);
    });
    return db.get('SELECT * FROM payments WHERE id = ?', p.id);
  };

  route('POST', '/api/payments/webhook', (ctx) => {
    const ok = handleWebhook(ctx.body, ctx.req.headers['x-korapay-signature']);
    if (!ok) throw new HttpError(401, 'bad_signature', 'Invalid signature.');
    return { ok: true };
  }, { webhook: true });

  // Status check used by the payment-return screen. Falls back to asking Kora directly,
  // in case the webhook is delayed.
  route('GET', '/api/payments/:reference', async (ctx) => {
    let p = db.get('SELECT * FROM payments WHERE reference = ?', ctx.params.reference);
    if (!p || (p.user_id !== ctx.user.id && ctx.user.role !== 'admin')) throw new HttpError(404, 'not_found', 'Payment not found.');
    if (p.status === 'pending') {
      const v = await payments.verify(p.reference).catch(() => null);
      if (v && v.status !== 'pending') p = applyResult(p.reference, v, 'verify') || p;
    }
    return { payment: view(p), returnPath: JSON.parse(p.meta || '{}').returnPath || '' };
  }, { auth: true });

  route('GET', '/api/me/payments', (ctx) => ({
    payments: db.all('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', ctx.user.id).map(view)
  }), { auth: true });

  route('GET', '/api/admin/payments', (ctx) => {
    const status = ctx.query.get('status');
    const rows = db.all(
      `SELECT p.*, u.name AS user_name FROM payments p JOIN users u ON u.id = p.user_id
       ${status ? 'WHERE p.status = :status' : ''} ORDER BY p.created_at DESC LIMIT 200`,
      status ? { status } : {}
    );
    const totals = db.get("SELECT COALESCE(SUM(amount_ngn),0) AS gross, COALESCE(SUM(fee_ngn),0) AS fees, COUNT(*) AS n FROM payments WHERE status = 'successful'");
    return { payments: rows.map((p) => ({ ...view(p), user: { id: p.user_id, name: p.user_name } })), totals };
  }, { roles: ['admin'] });

  route('POST', '/api/admin/payments/:reference/refund', async (ctx) => {
    const p = db.get('SELECT * FROM payments WHERE reference = ?', ctx.params.reference);
    if (!p) throw new HttpError(404, 'not_found', 'Payment not found.');
    const reason = kit.str(ctx.body.reason, 'Reason', { min: 5, max: 300 });
    const amount = ctx.body.amountNgn === undefined || ctx.body.amountNgn === null ? undefined : Number(ctx.body.amountNgn);
    const updated = await kit.refundPayment(p.id, amount, reason, ctx.user);
    kit.fulfil[`${p.purpose}:refunded`]?.(updated);
    return { payment: view(updated) };
  }, { roles: ['admin'] });

  /* ---------- dummy Kora checkout (KORA_MODE=dummy only) ---------- */
  const requireDummy = () => {
    if (payments.mode !== 'dummy') throw new HttpError(404, 'not_found', 'Not found.');
  };

  route('GET', '/api/payments/dummy-checkout/:reference', (ctx) => {
    requireDummy();
    const p = db.get('SELECT * FROM payments WHERE reference = ?', ctx.params.reference);
    if (!p) throw new HttpError(404, 'not_found', 'Payment not found.');
    const done = p.status !== 'pending' && p.status !== 'initiated';
    return {
      html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kora test checkout</title><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f4f1;color:#141414;display:grid;place-items:center;min-height:100vh;padding:16px}
.card{width:100%;max-width:420px;background:#fff;border-radius:24px;padding:28px;box-shadow:0 24px 60px -20px rgba(0,0,0,.25)}
.tag{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;background:#fff3c4;color:#7a5a00;padding:4px 10px;border-radius:99px}
h1{font-size:15px;font-weight:500;margin:18px 0 4px;color:#575753}.amt{font-size:40px;letter-spacing:-.03em;margin:0}
.row{display:flex;justify-content:space-between;font-size:13px;color:#575753;border-top:1px solid #eee;padding:10px 0}
button{width:100%;height:48px;border:0;border-radius:99px;font:600 15px system-ui;cursor:pointer;margin-top:10px}
.pay{background:#00a86b;color:#fff}.fail{background:#fff;border:1px solid #ddd;color:#a1281b}.cancel{background:none;color:#575753;font-weight:500}
p.note{font-size:12px;color:#73736e;margin-top:16px}</style></head><body><main class="card">
<span class="tag">Kora · test mode (dummy)</span>
<h1>${escapeHtml(p.description)}</h1><p class="amt">${naira(p.amount_ngn)}</p>
<div class="row"><span>Reference</span><span>${escapeHtml(p.reference)}</span></div>
<div class="row"><span>Status</span><span id="st">${escapeHtml(p.status)}</span></div>
${done ? `<button class="cancel" onclick="back()">Return to Agro Inspo</button>` : `
<button class="pay" onclick="go('success')">Pay ${naira(p.amount_ngn)} (test)</button>
<button class="fail" onclick="go('failed')">Simulate a failed payment</button>
<button class="cancel" onclick="back()">Cancel and return</button>`}
<p class="note">No money moves. This page stands in for Kora’s hosted checkout until real test keys are added (KORA_MODE=test).</p>
</main><script>
const ref=${JSON.stringify(p.reference)};const ret=${JSON.stringify(`${cfg.appUrl}/?payment=`)}+encodeURIComponent(ref);
function back(){location.href=ret}
async function go(outcome){document.querySelectorAll('button').forEach(b=>b.disabled=true);
const r=await fetch(location.pathname+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({outcome})});
document.getElementById('st').textContent=r.ok?(outcome==='success'?'successful':'failed'):'error';setTimeout(back,600)}
</script></body></html>`
    };
  });

  // Simulates Kora calling our webhook: builds the same payload shape and signs it with the secret.
  route('POST', '/api/payments/dummy-checkout/:reference/complete', (ctx) => {
    requireDummy();
    const p = db.get('SELECT * FROM payments WHERE reference = ?', ctx.params.reference);
    if (!p) throw new HttpError(404, 'not_found', 'Payment not found.');
    const success = ctx.body.outcome === 'success';
    const data = {
      reference: p.reference,
      currency: 'NGN',
      amount: p.amount_ngn,
      fee: success ? Math.min(2000, Math.round(p.amount_ngn * 0.015)) : 0,
      status: success ? 'success' : 'failed',
      payment_method: 'card'
    };
    const body = { event: success ? 'charge.success' : 'charge.failed', data };
    handleWebhook(body, signKoraPayload(data, payments.secret));
    return { ok: true };
  });
}
