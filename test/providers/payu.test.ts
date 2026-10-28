import { describe, expect, it, vi } from 'vitest';
import { PaymentError } from '../../src/core/errors.js';
import { sha512Hex } from '../../src/core/crypto.js';
import { mapPayuRefundStatus, mapPayuStatus, payu, payuApiHash, payuRequestHash, payuResponseHash, PAYU_URLS } from '../../src/providers/payu/adapter.js';
import { silentLogger } from '../../src/core/logger.js';
import { fakeFetch, testContext } from '../helpers.js';

const KEY = 'gtKFFx';
const SALT = 'eCwWELxi';

function gateway(routes: Parameters<typeof fakeFetch>[0] = [], environment: 'sandbox' | 'live' = 'sandbox') {
  const ff = fakeFetch(routes);
  const gw = payu.create({ key: KEY, salt: SALT }, testContext('payu', ff.fetch, { environment, extractError: payu.extractError }));
  return { gw, requests: ff.requests };
}

/** A callback exactly as PayU would POST it to surl. */
function callback(overrides: Record<string, string> = {}) {
  const p: Record<string, string> = {
    mihpayid: '403993715531077182',
    status: 'success',
    unmappedstatus: 'captured',
    key: KEY,
    txnid: 'TXN001',
    amount: '499.00',
    productinfo: 'Test product',
    firstname: 'Asha',
    email: 'asha@example.com',
    udf1: '',
    udf2: '',
    udf3: '',
    udf4: '',
    udf5: '',
    ...overrides,
  };
  p.hash = payuResponseHash(p, KEY, SALT);
  return p;
}

describe('payu hashes', () => {
  it('request hash matches a known answer (computed independently with shasum)', () => {
    const h = payuRequestHash(
      { key: KEY, txnid: 'TXN001', amount: '499.00', productinfo: 'Test product', firstname: 'Asha', email: 'asha@example.com' },
      SALT,
    );
    expect(h).toBe('95d13679ca94891cce29e415bb70e474632d2f99f3b0714381a18167a622492d9c705c20390c09fd750a9c27a026e6f5e718921d7230552353e80cfe49b94696');
  });

  it('reverse hash matches a known answer', () => {
    const h = payuResponseHash(
      { status: 'success', txnid: 'TXN001', amount: '499.00', productinfo: 'Test product', firstname: 'Asha', email: 'asha@example.com' },
      KEY,
      SALT,
    );
    expect(h).toBe('e00320eeb42fa20153d87757379ec5b1789381863d2b6a0550f3ba21992b9d7dbac071a5413a0ebffe56af3a1ba175066c14b35f27f224a6650e21a3583c2f39');
  });

  it('reverse hash prefixes additional_charges', () => {
    const p = { additional_charges: '10.00', status: 'success', txnid: 'T', amount: '1.00', productinfo: 'p', firstname: 'f', email: 'e' };
    expect(payuResponseHash(p, KEY, SALT)).toBe(sha512Hex(`10.00|${SALT}|success|||||||||||e|f|p|1.00|T|${KEY}`));
  });

  it('reverse hash also reads additionalCharges (webhook spelling)', () => {
    const p = { additionalCharges: '10.00', status: 'success', txnid: 'T', amount: '1.00', productinfo: 'p', firstname: 'f', email: 'e' };
    expect(payuResponseHash(p, KEY, SALT)).toBe(sha512Hex(`10.00|${SALT}|success|||||||||||e|f|p|1.00|T|${KEY}`));
  });

  it('postservice hash only covers var1', () => {
    expect(payuApiHash(KEY, 'verify_payment', 'TXN001', SALT)).toBe(sha512Hex(`${KEY}|verify_payment|TXN001|${SALT}`));
  });
});

describe('payu createPayment', () => {
  const base = {
    orderRef: 'TXN001',
    amount: 49900,
    description: 'Test product',
    returnUrl: 'https://shop.example/payu/return',
    customer: { name: 'Asha', email: 'asha@example.com', phone: '9876543210' },
  };

  it('builds a signed form_post without touching the network', async () => {
    const { gw, requests } = gateway();
    const res = await gw.createPayment({ ...base, metadata: { plan: 'gold', source: 'web' } });
    expect(requests).toHaveLength(0);
    expect(res.providerOrderId).toBe('TXN001');
    expect(res.checkout.type).toBe('form_post');
    if (res.checkout.type !== 'form_post') throw new Error('unreachable');
    const f = res.checkout.fields;
    expect(res.checkout.url).toBe('https://test.payu.in/_payment');
    expect(f).toMatchObject({
      key: KEY,
      txnid: 'TXN001',
      amount: '499.00',
      productinfo: 'Test product',
      firstname: 'Asha',
      email: 'asha@example.com',
      phone: '9876543210',
      surl: base.returnUrl,
      furl: base.returnUrl,
      udf1: 'gold',
      udf2: 'web',
      udf3: '',
    });
    expect(f.hash).toBe(payuRequestHash(f as never, SALT));
    expect(JSON.stringify(res)).not.toContain(SALT);
  });

  it('uses the live checkout host in live mode', async () => {
    const { gw } = gateway([], 'live');
    const res = await gw.createPayment(base);
    expect(res.checkout.type === 'form_post' && res.checkout.url).toBe('https://secure.payu.in/_payment');
    expect(PAYU_URLS.live.postservice).toContain('info.payu.in');
  });

  it('requires returnUrl', async () => {
    const { gw } = gateway();
    await expect(gw.createPayment({ ...base, returnUrl: undefined })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('enforces txnid <= 25 characters (M1)', async () => {
    const { gw } = gateway();
    await expect(gw.createPayment({ ...base, orderRef: 'T'.repeat(26) })).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/txnid/) });
    await expect(gw.createPayment({ ...base, orderRef: 'T'.repeat(25) })).resolves.toMatchObject({ orderRef: 'T'.repeat(25) });
  });

  it('enforces productinfo / firstname / email / udf limits (M2)', async () => {
    const { gw } = gateway();
    await expect(gw.createPayment({ ...base, description: 'p'.repeat(101) })).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/productinfo/) });
    await expect(gw.createPayment({ ...base, customer: { ...base.customer, name: 'n'.repeat(61) } })).rejects.toMatchObject({ message: expect.stringMatching(/firstname/) });
    await expect(gw.createPayment({ ...base, customer: { ...base.customer, email: `${'e'.repeat(45)}@x.com` } })).rejects.toMatchObject({ message: expect.stringMatching(/email/) });
    await expect(gw.createPayment({ ...base, metadata: { a: 'u'.repeat(256) } })).rejects.toMatchObject({ message: expect.stringMatching(/udf1/) });
    await expect(gw.createPayment({ ...base, description: 'p'.repeat(100), metadata: { a: 'u'.repeat(255) } })).resolves.toBeDefined();
  });

  it('only warns about surl/furl longer than 50 characters (M2)', async () => {
    const warn = vi.fn();
    const ctx = { ...testContext('payu', fakeFetch([]).fetch), logger: { ...silentLogger, warn } };
    const gw = payu.create({ key: KEY, salt: SALT }, ctx);
    const returnUrl = `https://shop.example/${'x'.repeat(60)}`;
    const res = await gw.createPayment({ ...base, returnUrl });
    expect(res.checkout.type === 'form_post' && res.checkout.fields.surl).toBe(returnUrl);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toMatch(/surl/);
  });

  it('rejects more than 5 metadata values', async () => {
    const { gw } = gateway();
    const metadata = { a: '1', b: '2', c: '3', d: '4', e: '5', f: '6' };
    await expect(gw.createPayment({ ...base, metadata })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('payu verifyPayment', () => {
  it('accepts a valid callback and maps status', async () => {
    const { gw } = gateway();
    const r = await gw.verifyPayment({ orderRef: 'TXN001', expectedAmount: 49900, payload: callback() });
    expect(r).toMatchObject({ valid: true, status: 'captured', providerPaymentId: '403993715531077182', amount: 49900, verifiedVia: 'signature' });
  });

  it('maps failure and pending', async () => {
    const { gw } = gateway();
    expect((await gw.verifyPayment({ payload: callback({ status: 'failure', unmappedstatus: 'failed' }) })).status).toBe('failed');
    expect((await gw.verifyPayment({ payload: callback({ status: 'pending', unmappedstatus: 'pending' }) })).status).toBe('pending');
  });

  it('accepts a callback with additional_charges', async () => {
    const { gw } = gateway();
    const r = await gw.verifyPayment({ payload: callback({ additional_charges: '11.80' }) });
    expect(r.valid).toBe(true);
  });

  it('rejects a tampered hash', async () => {
    const { gw } = gateway();
    const p = callback();
    p.amount = '1.00';
    const r = await gw.verifyPayment({ payload: p });
    expect(r).toMatchObject({ valid: false, reason: 'Hash mismatch' });
  });

  it('rejects an amount mismatch even with a valid hash', async () => {
    const { gw } = gateway();
    const r = await gw.verifyPayment({ expectedAmount: 99900, payload: callback() });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/Amount mismatch/);
  });

  it('rejects an orderRef mismatch', async () => {
    const { gw } = gateway();
    const r = await gw.verifyPayment({ orderRef: 'OTHER', payload: callback() });
    expect(r.valid).toBe(false);
  });
});

describe('payu status mapping', () => {
  it('maps refund states, including od_hit / processing / in_progress (M4)', () => {
    for (const s of ['QUEUED', 'REQUESTED', 'IN PROGRESS', 'in_progress', 'processing', 'od_hit']) expect(mapPayuRefundStatus(s)).toBe('pending');
    expect(mapPayuRefundStatus('SUCCESS')).toBe('processed');
    expect(mapPayuRefundStatus('FAILURE')).toBe('failed');
    expect(mapPayuRefundStatus('mystery')).toBe('unknown');
  });

  it('maps top-level and unmapped statuses', () => {
    expect(mapPayuStatus('success', 'captured')).toBe('captured');
    expect(mapPayuStatus('success', 'auth')).toBe('authorized');
    expect(mapPayuStatus('failure', 'userCancelled')).toBe('cancelled');
    expect(mapPayuStatus('Not Found')).toBe('created');
    expect(mapPayuStatus('weird')).toBe('unknown');
  });
});

describe('payu getPaymentStatus', () => {
  it('calls verify_payment with a form-encoded hashed body', async () => {
    const { gw, requests } = gateway([
      {
        match: 'POST https://test.payu.in/merchant/postservice',
        body: {
          status: 1,
          msg: '1 out of 1 Transactions Fetched Successfully',
          transaction_details: { TXN001: { mihpayid: '403993715531077182', status: 'success', unmappedstatus: 'captured', amt: '499.00', mode: 'UPI' } },
        },
      },
    ]);
    const r = await gw.getPaymentStatus({ orderRef: 'TXN001' });
    expect(r).toMatchObject({ status: 'captured', amount: 49900, providerPaymentId: '403993715531077182', method: 'upi' });
    const body = new URLSearchParams(requests[0]!.body);
    expect(requests[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(body.get('command')).toBe('verify_payment');
    expect(body.get('var1')).toBe('TXN001');
    expect(body.get('hash')).toBe(payuApiHash(KEY, 'verify_payment', 'TXN001', SALT));
    expect(requests[0]!.body).not.toContain(SALT);
  });

  it('maps a failed transaction with its reason', async () => {
    const { gw } = gateway([
      {
        match: 'postservice',
        body: { status: 1, transaction_details: { TXN001: { mihpayid: '1', status: 'failure', unmappedstatus: 'failed', amt: '499.00', error_Message: 'Bank declined' } } },
      },
    ]);
    const r = await gw.getPaymentStatus({ orderRef: 'TXN001' });
    expect(r).toMatchObject({ status: 'failed', failureReason: 'Bank declined' });
  });

  it('uses the live postservice host in live mode', async () => {
    const { gw, requests } = gateway([{ match: 'info.payu.in', body: { status: 0, transaction_details: { T: { status: 'Not Found', mihpayid: 'Not Found' } } } }], 'live');
    const r = await gw.getPaymentStatus({ orderRef: 'T' });
    expect(r.status).toBe('created');
    expect(r.providerPaymentId).toBeUndefined();
    expect(requests[0]!.url).toBe('https://info.payu.in/merchant/postservice.php?form=2');
  });
});

describe('payu refunds', () => {
  it('sends cancel_refund_transaction with mihpayid, token and amount', async () => {
    const { gw, requests } = gateway([
      { match: 'postservice', body: { status: 1, msg: 'Refund Request Queued', request_id: '130165813', mihpayid: '403993715531077182' } },
    ]);
    const r = await gw.refund!({ orderRef: 'TXN001', providerPaymentId: '403993715531077182', refundRef: 'RF-1', amount: 10000 });
    expect(r).toMatchObject({ status: 'pending', providerRefundId: '130165813', amount: 10000 });
    const body = new URLSearchParams(requests[0]!.body);
    expect(Object.fromEntries(body)).toMatchObject({ command: 'cancel_refund_transaction', var1: '403993715531077182', var2: 'RF-1', var3: '100.00' });
    expect(body.get('hash')).toBe(payuApiHash(KEY, 'cancel_refund_transaction', '403993715531077182', SALT));
  });

  it('uses txn_update_id when cancelling an authorised payment (M3)', async () => {
    const { gw } = gateway([{ match: 'postservice', body: { status: 1, msg: 'Cancel Request Queued', txn_update_id: '130165999', mihpayid: '1' } }]);
    const r = await gw.refund!({ orderRef: 'T', providerPaymentId: '1', refundRef: 'R', amount: 100 });
    expect(r.providerRefundId).toBe('130165999');
  });

  it('validates refundRef length', async () => {
    const { gw } = gateway();
    await expect(gw.refund!({ orderRef: 'T', providerPaymentId: '1', refundRef: 'x'.repeat(24), amount: 100 })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('surfaces a rejected refund', async () => {
    const { gw } = gateway([{ match: 'postservice', body: { status: 0, msg: 'Invalid amount', error_code: 105 } }]);
    const err = await gw.refund!({ orderRef: 'T', providerPaymentId: '1', refundRef: 'R', amount: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentError);
    expect(err).toMatchObject({ code: 'PROVIDER_ERROR', providerCode: '105' });
  });

  it('reads refund status via check_action_status', async () => {
    const { gw, requests } = gateway([
      { match: 'postservice', body: { status: 1, transaction_details: { '130165813': { '403993715531077182': { action: 'refund', status: 'success', amount: '100.00' } } } } },
    ]);
    const r = await gw.getRefundStatus!({ refundRef: 'RF-1', providerRefundId: '130165813' });
    expect(r).toMatchObject({ status: 'processed', amount: 10000 });
    expect(new URLSearchParams(requests[0]!.body).get('command')).toBe('check_action_status');
  });

  it('reads the documented nested sample (request_id twice, amt, uppercase status)', async () => {
    const { gw } = gateway([
      {
        match: 'postservice',
        body: { status: 1, msg: 'Refund Details', transaction_details: { '130165813': { '130165813': { mihpayid: '403993715531077182', request_id: '130165813', amt: '10.00', action: 'refund', status: 'QUEUED' } } } },
      },
    ]);
    const r = await gw.getRefundStatus!({ refundRef: 'RF-1', providerRefundId: '130165813' });
    expect(r).toMatchObject({ status: 'pending', amount: 1000 });
  });

  it('reads the flat OpenAPI sample (refund_status / refund_amount)', async () => {
    const { gw } = gateway([
      { match: 'postservice', body: { status: 1, msg: 'ok', request_id: '130165813', mihpayid: '403993715531077182', refund_status: 'success', refund_amount: '100.00', bank_ref_no: 'B', mode: 'CC' } },
    ]);
    const r = await gw.getRefundStatus!({ refundRef: 'RF-1', providerRefundId: '130165813' });
    expect(r).toMatchObject({ status: 'processed', amount: 10000 });
  });

  it('throws when check_action_status finds nothing', async () => {
    const { gw } = gateway([{ match: 'postservice', body: { status: 0, msg: '0 out of 1', transaction_details: { '130165813': 'No action status found' } } }]);
    await expect(gw.getRefundStatus!({ refundRef: 'RF-1', providerRefundId: '130165813' })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});

describe('payu webhooks', () => {
  it('simulateWebhook round-trips through parseWebhook', async () => {
    const { gw } = gateway();
    const sim = await gw.simulateWebhook!({ type: 'payment.succeeded', orderRef: 'TXN001', amount: 49900 });
    const ev = await gw.parseWebhook({ headers: sim.headers, rawBody: sim.rawBody });
    expect(ev).toMatchObject({ provider: 'payu', type: 'payment.succeeded', orderRef: 'TXN001', amount: 49900, status: 'captured' });
    expect(ev.occurredAt).toBe('2026-10-28T10:00:00.000Z');

    const failed = await gw.simulateWebhook!({ type: 'payment.failed', orderRef: 'TXN002', amount: 100 });
    expect((await gw.parseWebhook({ headers: failed.headers, rawBody: failed.rawBody })).type).toBe('payment.failed');
  });

  it('accepts a JSON body with the same reverse hash', async () => {
    const { gw } = gateway();
    const ev = await gw.parseWebhook({ headers: { 'Content-Type': 'application/json' }, rawBody: JSON.stringify(callback()) });
    expect(ev.type).toBe('payment.succeeded');
  });

  it('rejects a tampered webhook', async () => {
    const { gw } = gateway();
    const sim = await gw.simulateWebhook!({ type: 'payment.succeeded', orderRef: 'TXN001', amount: 49900 });
    const tampered = sim.rawBody.replace('amount=499.00', 'amount=4999.00');
    await expect(gw.parseWebhook({ headers: sim.headers, rawBody: tampered })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });
});

describe('payu module', () => {
  it('reports refundStatus as supported', () => {
    expect(payu.capabilities.features.refundStatus.support).toBe('supported');
  });

  it('requires key and salt', () => {
    expect(() => payu.create({ key: KEY }, testContext('payu', fakeFetch([]).fetch))).toThrow(/PAYU_MERCHANT_SALT/);
  });
});
