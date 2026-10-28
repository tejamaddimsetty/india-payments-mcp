import { describe, expect, it } from 'vitest';
import { PaymentError } from '../../src/core/errors.js';
import { cashfree, cashfreeWebhookSignature, CASHFREE_API_VERSION } from '../../src/providers/cashfree/adapter.js';
import { fakeFetch, testContext, type FakeRoute } from '../helpers.js';

const creds = { clientId: 'TEST_app_id', clientSecret: 'cfsk_ma_test_secret' };
const NOW_MS = Date.parse('2026-10-28T10:00:00.000Z');

function setup(routes: FakeRoute[]) {
  const f = fakeFetch(routes);
  const gw = cashfree.create(creds, testContext('cashfree', f.fetch, { extractError: cashfree.extractError }));
  return { gw, requests: f.requests };
}

const order = (status: string, amount = 499) => ({
  cf_order_id: 2149460581,
  order_id: 'order_123',
  order_amount: amount,
  order_currency: 'INR',
  order_status: status,
  payment_session_id: 'session_abc',
  order_expiry_time: '2026-11-27T10:00:00+05:30',
});

function signed(body: unknown, timestamp = String(NOW_MS)) {
  const rawBody = JSON.stringify(body);
  return { rawBody, headers: { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': cashfreeWebhookSignature(timestamp, rawBody, creds.clientSecret) } };
}

describe('cashfree createPayment', () => {
  it('sends rupees, customer details, return_url placeholder and idempotency key', async () => {
    const { gw, requests } = setup([{ match: 'POST https://sandbox.cashfree.com/pg/orders', body: order('ACTIVE') }]);
    const res = await gw.createPayment({
      orderRef: 'order_123',
      amount: 49900,
      customer: { phone: '98765 43210', email: 'a@b.in', name: 'Asha' },
      returnUrl: 'https://shop.example/return?x=1',
      notifyUrl: 'https://shop.example/hook',
      description: 'T-shirt',
      metadata: { sku: 'TS-1' },
      idempotencyKey: 'idem-1',
    });
    const req = requests[0]!;
    expect(req.headers['x-client-id']).toBe('TEST_app_id');
    expect(req.headers['x-client-secret']).toBe('cfsk_ma_test_secret');
    expect(req.headers['x-api-version']).toBe(CASHFREE_API_VERSION);
    expect(req.headers['x-idempotency-key']).toBe('idem-1');
    const body = JSON.parse(req.body!);
    expect(body.order_amount).toBe(499);
    expect(body.order_id).toBe('order_123');
    expect(body.order_currency).toBe('INR');
    expect(body.customer_details.customer_phone).toBe('9876543210');
    expect(body.customer_details.customer_id).toMatch(/^cust_[0-9a-f]{24}$/);
    expect(body.order_meta).toEqual({ return_url: 'https://shop.example/return?x=1&order_id={order_id}', notify_url: 'https://shop.example/hook' });
    expect(body.order_note).toBe('T-shirt');
    expect(body.order_tags).toEqual({ sku: 'TS-1' });

    expect(res.amount).toBe(49900);
    expect(res.status).toBe('created');
    expect(res.providerOrderId).toBe('2149460581');
    expect(res.checkout).toEqual({
      type: 'js_sdk',
      sdk: 'cashfree',
      scriptUrl: 'https://sdk.cashfree.com/js/v3/cashfree.js',
      options: { mode: 'sandbox', paymentSessionId: 'session_abc' },
    });
  });

  it('keeps a return_url that already has {order_id} and converts odd paise exactly', async () => {
    const { gw, requests } = setup([{ match: 'POST', body: order('ACTIVE', 10.15) }]);
    await gw.createPayment({ orderRef: 'order_123', amount: 1015, customer: { phone: '9999999999' }, returnUrl: 'https://s.example/r/{order_id}' });
    const body = JSON.parse(requests[0]!.body!);
    expect(body.order_amount).toBe(10.15);
    expect(body.order_meta.return_url).toBe('https://s.example/r/{order_id}');
    expect(requests[0]!.headers['x-idempotency-key']).toBeUndefined();
  });

  it('rejects a missing phone with a VALIDATION error and hint, without calling Cashfree', async () => {
    const { gw, requests } = setup([]);
    const err = await gw.createPayment({ orderRef: 'order_123', amount: 49900, customer: { email: 'a@b.in' } }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentError);
    expect(err.code).toBe('VALIDATION');
    expect(err.hint).toMatch(/phone/);
    expect(requests).toHaveLength(0);
  });

  it('uses the production host and mode in live', async () => {
    const f = fakeFetch([{ match: 'POST https://api.cashfree.com/pg/orders', body: order('ACTIVE') }]);
    const gw = cashfree.create({ clientId: 'app_live', clientSecret: 'cfsk_ma_prod_x' }, testContext('cashfree', f.fetch, { environment: 'live' }));
    const res = await gw.createPayment({ orderRef: 'order_123', amount: 49900, customer: { phone: '9999999999' } });
    expect(res.checkout.type === 'js_sdk' && res.checkout.options.mode).toBe('production');
  });

  it('refuses test keys in live and prod secrets in sandbox', () => {
    const f = fakeFetch([]);
    expect(() => cashfree.create(creds, testContext('cashfree', f.fetch, { environment: 'live' }))).toThrow(/sandbox/);
    expect(() => cashfree.create({ clientId: 'x', clientSecret: 'cfsk_ma_prod_x' }, testContext('cashfree', f.fetch))).toThrow(/production/);
    expect(() => cashfree.create({ clientId: 'x' }, testContext('cashfree', f.fetch))).toThrow(/CASHFREE_CLIENT_SECRET/);
  });
});

describe('cashfree getPaymentStatus', () => {
  const statusRoutes = (orderStatus: string, payments: unknown[]): FakeRoute[] => [
    { match: '/orders/order_123/payments', body: payments },
    { match: 'GET https://sandbox.cashfree.com/pg/orders/order_123', body: order(orderStatus) },
  ];

  it('PAID order with a SUCCESS attempt among failures -> captured, picks the success', async () => {
    const { gw } = setup(
      statusRoutes('PAID', [
        { cf_payment_id: 1, payment_status: 'FAILED', payment_time: '2026-10-28T09:00:00+05:30', payment_group: 'credit_card', payment_message: 'declined' },
        { cf_payment_id: 2, payment_status: 'SUCCESS', payment_time: '2026-10-28T09:05:00+05:30', payment_group: 'upi' },
        { cf_payment_id: 3, payment_status: 'USER_DROPPED', payment_time: '2026-10-28T09:10:00+05:30', payment_group: 'net_banking' },
      ]),
    );
    const s = await gw.getPaymentStatus({ orderRef: 'order_123' });
    expect(s.status).toBe('captured');
    expect(s.providerPaymentId).toBe('2');
    expect(s.amount).toBe(49900);
    expect(s.method).toBe('upi');
    expect(s.failureReason).toBeUndefined();
  });

  it.each([
    ['ACTIVE', [], 'created'],
    ['ACTIVE', [{ cf_payment_id: 1, payment_status: 'PENDING' }], 'pending'],
    ['ACTIVE', [{ cf_payment_id: 1, payment_status: 'FAILED', payment_message: 'Insufficient funds' }], 'failed'],
    ['ACTIVE', [{ cf_payment_id: 1, payment_status: 'USER_DROPPED' }], 'cancelled'],
    ['ACTIVE', [{ cf_payment_id: 1, payment_status: 'CANCELLED' }], 'cancelled'],
    ['EXPIRED', [{ cf_payment_id: 1, payment_status: 'FAILED' }], 'expired'],
    ['TERMINATED', [], 'cancelled'],
  ])('order %s with attempts %j -> %s', async (orderStatus, payments, expected) => {
    const { gw } = setup(statusRoutes(orderStatus, payments));
    const s = await gw.getPaymentStatus({ orderRef: 'order_123' });
    expect(s.status).toBe(expected);
    if (expected === 'failed') expect(s.failureReason).toBe('Insufficient funds');
  });
});

describe('cashfree verifyPayment', () => {
  const routes: FakeRoute[] = [
    { match: '/orders/order_123/payments', body: [{ cf_payment_id: 9, payment_status: 'SUCCESS', payment_group: 'upi' }] },
    { match: 'GET https://sandbox.cashfree.com/pg/orders/order_123', body: order('PAID') },
  ];

  it('confirms via the status API', async () => {
    const { gw } = setup(routes);
    const v = await gw.verifyPayment({ orderRef: 'order_123', expectedAmount: 49900, payload: { order_id: 'order_123' } });
    expect(v).toMatchObject({ valid: true, status: 'captured', verifiedVia: 'status_api', providerPaymentId: '9', amount: 49900 });
  });

  it('rejects a swapped order_id and an amount mismatch', async () => {
    const { gw, requests } = setup(routes);
    const swapped = await gw.verifyPayment({ orderRef: 'order_999', payload: { order_id: 'order_123' } });
    expect(swapped.valid).toBe(false);
    expect(requests).toHaveLength(0);
    const wrongAmount = await gw.verifyPayment({ orderRef: 'order_123', expectedAmount: 100, payload: { order_id: 'order_123' } });
    expect(wrongAmount.valid).toBe(false);
    expect(wrongAmount.reason).toMatch(/Amount mismatch/);
  });

  it('is a valid callback but reports the unpaid status', async () => {
    const { gw } = setup([
      { match: '/orders/order_123/payments', body: [{ cf_payment_id: 9, payment_status: 'USER_DROPPED' }] },
      { match: 'GET https://sandbox.cashfree.com/pg/orders/order_123', body: order('ACTIVE') },
    ]);
    const v = await gw.verifyPayment({ payload: { order_id: 'order_123' } });
    expect(v.valid).toBe(true);
    expect(v.status).toBe('cancelled');
  });
});

describe('cashfree refunds', () => {
  const refundBody = { cf_refund_id: 'cf_r_1', cf_payment_id: 9, refund_id: 'rf_1', order_id: 'order_123', refund_amount: 100.5, refund_currency: 'INR', refund_status: 'PENDING' };

  it('creates a partial refund in rupees with refund_id = refundRef', async () => {
    const { gw, requests } = setup([{ match: 'POST https://sandbox.cashfree.com/pg/orders/order_123/refunds', body: refundBody }]);
    const r = await gw.refund!({ orderRef: 'order_123', amount: 10050, refundRef: 'rf_1', reason: 'size', speed: 'instant' });
    expect(JSON.parse(requests[0]!.body!)).toEqual({ refund_amount: 100.5, refund_id: 'rf_1', refund_speed: 'INSTANT', refund_note: 'size' });
    expect(r).toMatchObject({ refundRef: 'rf_1', providerRefundId: 'cf_r_1', status: 'pending', amount: 10050 });
  });

  it('looks up the order amount for a full refund', async () => {
    const { gw, requests } = setup([
      { match: 'POST https://sandbox.cashfree.com/pg/orders/order_123/refunds', body: { ...refundBody, refund_amount: 499 } },
      { match: 'GET https://sandbox.cashfree.com/pg/orders/order_123', body: order('PAID') },
    ]);
    const r = await gw.refund!({ orderRef: 'order_123', refundRef: 'rf_1' });
    expect(requests.map((x) => x.method)).toEqual(['GET', 'POST']);
    const body = JSON.parse(requests[1]!.body!);
    expect(body.refund_amount).toBe(499);
    expect(body.refund_speed).toBe('STANDARD');
    expect(r.amount).toBe(49900);
  });

  it('fetches refund status', async () => {
    const { gw, requests } = setup([{ match: '/orders/order_123/refunds/rf_1', body: { ...refundBody, refund_status: 'SUCCESS' } }]);
    const r = await gw.getRefundStatus!({ orderRef: 'order_123', refundRef: 'rf_1' });
    expect(requests[0]!.method).toBe('GET');
    expect(r.status).toBe('processed');
    await expect(gw.getRefundStatus!({ refundRef: 'rf_1' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('cashfree webhooks', () => {
  const successBody = {
    data: {
      order: { order_id: 'order_123', order_amount: 499, order_currency: 'INR', order_tags: null },
      payment: { cf_payment_id: 5114910, payment_status: 'SUCCESS', payment_amount: 499, payment_currency: 'INR', payment_group: 'upi' },
    },
    event_time: '2026-10-28T15:29:00+05:30',
    type: 'PAYMENT_SUCCESS_WEBHOOK',
  };

  it('accepts a valid signature and normalises', async () => {
    const { gw } = setup([]);
    const e = await gw.parseWebhook(signed(successBody));
    expect(e).toMatchObject({
      id: 'PAYMENT_SUCCESS_WEBHOOK:5114910',
      type: 'payment.succeeded',
      orderRef: 'order_123',
      providerPaymentId: '5114910',
      status: 'captured',
      amount: 49900,
      currency: 'INR',
      occurredAt: '2026-10-28T09:59:00.000Z',
    });
  });

  it('accepts a seconds timestamp', async () => {
    const { gw } = setup([]);
    const e = await gw.parseWebhook(signed(successBody, String(NOW_MS / 1000 - 60)));
    expect(e.type).toBe('payment.succeeded');
  });

  it('rejects a tampered body', async () => {
    const { gw } = setup([]);
    const w = signed(successBody);
    await expect(gw.parseWebhook({ ...w, rawBody: w.rawBody.replace('499', '1') })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(gw.parseWebhook({ headers: {}, rawBody: w.rawBody })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('rejects a stale (correctly signed) webhook', async () => {
    const { gw } = setup([]);
    await expect(gw.parseWebhook(signed(successBody, String(NOW_MS - 6 * 60 * 1000)))).rejects.toThrow(/tolerance/);
  });

  it('maps user-dropped and refund webhooks', async () => {
    const { gw } = setup([]);
    const dropped = await gw.parseWebhook(
      signed({ ...successBody, type: 'PAYMENT_USER_DROPPED_WEBHOOK', data: { ...successBody.data, payment: { ...successBody.data.payment, payment_status: 'USER_DROPPED' } } }),
    );
    expect(dropped).toMatchObject({ type: 'payment.failed', status: 'cancelled' });
    const refund = await gw.parseWebhook(
      signed({ type: 'REFUND_STATUS_WEBHOOK', data: { refund: { cf_refund_id: 77, cf_payment_id: 5114910, refund_id: 'rf_1', order_id: 'order_123', refund_amount: 100, refund_currency: 'INR', refund_status: 'CANCELLED' } } }),
    );
    expect(refund).toMatchObject({ type: 'refund.failed', id: 'REFUND_STATUS_WEBHOOK:77:CANCELLED', refundRef: 'rf_1', providerRefundId: '77', amount: 10000 });
  });

  it.each(['payment.succeeded', 'payment.failed', 'refund.processed'] as const)('simulateWebhook(%s) round-trips', async (type) => {
    const { gw } = setup([]);
    const sim = await gw.simulateWebhook!({ type, orderRef: 'order_123', amount: 49900, refundRef: 'rf_1', providerPaymentId: 'p1' });
    const e = await gw.parseWebhook({ headers: sim.headers, rawBody: sim.rawBody });
    expect(e.type).toBe(type);
    expect(e.orderRef).toBe('order_123');
    expect(e.amount).toBe(49900);
    expect(e.providerPaymentId).toBe('p1');
    if (type === 'refund.processed') expect(e.refundRef).toBe('rf_1');
  });
});

describe('cashfree extractError', () => {
  it('maps the error body into PaymentError', async () => {
    const { gw } = setup([
      { match: 'POST', status: 400, body: { message: 'order_id already exists', code: 'order_already_exists', type: 'invalid_request_error' } },
    ]);
    const err = await gw.createPayment({ orderRef: 'order_123', amount: 49900, customer: { phone: '9999999999' } }).catch((e) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_ERROR', httpStatus: 400, providerCode: 'order_already_exists', providerMessage: 'order_id already exists' });
    expect(cashfree.extractError!({ type: 'authentication_error', message: 'bad key' }, 401)).toEqual({ code: 'authentication_error', message: 'bad key' });
    expect(cashfree.extractError!('oops', 500)).toEqual({});
  });
});
