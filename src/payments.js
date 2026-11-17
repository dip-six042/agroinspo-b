// Payments through Kora (Korapay) — PRD §9, FR-10, §28.
//
// KORA_MODE selects the adapter:
//   dummy (default) – no network calls. Checkout is a local test page that simulates
//                     Kora's hosted checkout and sends a correctly signed webhook back.
//   test / live     – real Kora API with your test or live secret key.
//
// Either way the rest of the app sees the same flow:
//   initialise → customer pays on the checkout page → signed webhook (and/or verify on return)
//   → payment marked successful exactly once → the purchase is fulfilled.
//
// Kora references (check against the current docs before going live):
//   POST {base}/charges/initialize   body: amount, currency, reference, redirect_url, notification_url, narration, customer
//   GET  {base}/charges/:reference   returns data.status ('success' | 'failed' | 'processing' | ...)
//   Webhook header x-korapay-signature = HMAC-SHA256(JSON.stringify(body.data), secret key)
import { createHmac, timingSafeEqual } from 'node:crypto';

const KORA_BASE = 'https://api.korapay.com/merchant/api/v1';

export function signKoraPayload(data, secret) {
  return createHmac('sha256', secret).update(JSON.stringify(data)).digest('hex');
}

export function verifyKoraSignature(data, signature, secret) {
  if (typeof signature !== 'string' || !secret) return false;
  const expected = Buffer.from(signKoraPayload(data, secret));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Maps Kora's charge status to ours. */
export function mapKoraStatus(status) {
  if (status === 'success') return 'successful';
  if (status === 'failed' || status === 'expired' || status === 'cancelled') return 'failed';
  return 'pending';
}

export function createPaymentProvider(config = {}) {
  const mode = config.mode || process.env.KORA_MODE || 'dummy';
  const secret = config.secretKey || process.env.KORA_SECRET_KEY || (mode === 'dummy' ? 'dummy-kora-secret' : '');
  const apiUrl = config.apiUrl || process.env.API_PUBLIC_URL || process.env.APP_URL || 'http://localhost:8787';

  if (mode !== 'dummy' && !secret) throw new Error('KORA_SECRET_KEY is required when KORA_MODE is test or live.');

  if (mode === 'dummy') {
    return {
      name: 'kora-dummy',
      mode,
      secret,
      async initialize({ reference }) {
        return { checkoutUrl: `${apiUrl}/api/payments/dummy-checkout/${encodeURIComponent(reference)}`, providerRef: `DUMMY-${reference}` };
      },
      async verify() {
        // The dummy checkout reports results only via its webhook.
        return null;
      },
      async refund({ reference, amountNgn }) {
        return { status: 'successful', providerRef: `DUMMY-RF-${reference}-${amountNgn}` };
      },
      // Account 0000000000 always fails, so failure handling can be tested.
      async resolveAccount({ bankCode, accountNumber }) {
        if (!/^\d{10}$/.test(accountNumber)) throw new Error('Account numbers have 10 digits.');
        return { accountName: 'TEST ACCOUNT HOLDER', bankCode };
      },
      async payout({ reference, accountNumber }) {
        if (accountNumber === '0000000000') return { status: 'failed', reason: 'Bank rejected the transfer (test account).' };
        return { status: 'successful', providerRef: `DUMMY-PO-${reference}` };
      }
    };
  }

  const call = async (method, path, body) => {
    const res = await fetch(`${KORA_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.status === false) throw new Error(`Kora ${path} failed: ${json.message || res.status}`);
    return json.data;
  };

  return {
    name: 'kora',
    mode,
    secret,
    async initialize({ reference, amountNgn, description, customer, redirectUrl }) {
      const data = await call('POST', '/charges/initialize', {
        amount: amountNgn,
        currency: 'NGN',
        reference,
        narration: description.slice(0, 100),
        redirect_url: redirectUrl,
        notification_url: `${apiUrl}/api/payments/webhook`,
        customer: { name: customer.name, email: customer.email }
      });
      return { checkoutUrl: data.checkout_url, providerRef: data.reference || reference };
    },
    async verify(reference) {
      const data = await call('GET', `/charges/${encodeURIComponent(reference)}`);
      return { status: mapKoraStatus(data.status), amountNgn: Number(data.amount), feeNgn: Number(data.fee || 0), raw: data };
    },
    // TODO(kora): confirm field names against Kora's Refunds API docs before enabling test/live mode.
    async refund({ reference, amountNgn, reason }) {
      const data = await call('POST', '/refunds/initiate', {
        payment_reference: reference, reference: `RF-${reference}-${Date.now()}`, amount: amountNgn, reason: reason.slice(0, 100)
      });
      return { status: data.status === 'failed' ? 'failed' : 'successful', providerRef: data.reference || '' };
    },
    // TODO(kora): confirm against Kora's "resolve bank account" docs.
    async resolveAccount({ bankCode, accountNumber }) {
      const data = await call('POST', '/misc/banks/resolve', { bank: bankCode, account: accountNumber, currency: 'NGN' });
      return { accountName: data.account_name, bankCode };
    },
    // TODO(kora): confirm against Kora's Payouts (disburse) docs; final status also arrives by webhook.
    async payout({ reference, amountNgn, bankCode, accountNumber, accountName, narration, email }) {
      const data = await call('POST', '/transactions/disburse', {
        reference,
        destination: {
          type: 'bank_account', amount: amountNgn, currency: 'NGN', narration,
          bank_account: { bank: bankCode, account: accountNumber },
          customer: { name: accountName, email }
        }
      });
      const st = data.status === 'success' ? 'successful' : data.status === 'failed' ? 'failed' : 'processing';
      return { status: st, providerRef: data.reference || reference, reason: data.message || '' };
    }
  };
}
