import { describe, expect, it } from 'vitest';
import { PaymentError } from '../../src/core/errors.js';
import type { FetchLike } from '../../src/core/http.js';
import { phonepe, phonepeWebhookAuthorization, PHONEPE_HOSTS } from '../../src/providers/phonepe/adapter.js';
import { fakeFetch, testContext, type FakeRoute } from '../helpers.js';

const creds = {
  clientId: 'TEST_CLIENT',
  clientSecret: 'test_secret',
  clientVersion: '1',
  webhookUsername: 'hookuser',
  webhookPassword: 'hookpass',
};

// testContext's clock is 2026-10-28T10:00:00Z.
const NOW_S = Math.floor(Date.parse('2026-10-28T10:00:00.000Z') / 1000);
const tokenRoute: FakeRoute = {
  match: 'POST https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token',
  body: { access_token: 'tok-1', token_type: 'O-Bearer', issued_at: NOW_S, expires_at: NOW_S + 3600 },
};

function gateway(routes: FakeRoute[], environment: 'sandbox' | 'live' = 'sandbox') {
  const ff = fakeFetch(routes);
  const gw = phonepe.create(creds, testContext('phonepe', ff.fetch, { environment, extractError: phonepe.extractError }));
  return { gw, requests: ff.requests };
}

const completedStatus = {
  orderId: 'OMO123',
  state: 'COMPLETED',
  amount: 49900,
  expireAt: 1761660000000,
  paymentDetails: [
    { paymentMode: 'UPI_COLLECT', transactionId: 'OM_OLD', timestamp: 1000, amount: 49900, state: 'FAILED', errorCode: 'X' },
    { paymentMode: 'UPI_INTENT', transactionId: 'OM_NEW', timestamp: 2000, amount: 49900, state: 'COMPLETED' },
  ],
};

describe('phonepe adapter', () => {
  it('requires the three OAuth credentials', () => {
    const { fetch } = fakeFetch([]);
    expect(() => phonepe.create({ clientId: 'x', clientSecret: 'y' }, testContext('phonepe', fetch))).toThrow(/PHONEPE_CLIENT_VERSION/);
  });

  it('fetches one token, form-encoded, and reuses it across requests', async () => {
    const { gw, requests } = gateway([tokenRoute, { match: '/checkout/v2/order/', body: completedStatus }]);
    await Promise.all([gw.getPaymentStatus({ orderRef: 'ord_1' }), gw.getPaymentStatus({ orderRef: 'ord_2' })]);
    await gw.getPaymentStatus({ orderRef: 'ord_3' });

    const tokenCalls = requests.filter((r) => r.url.includes('/oauth/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(tokenCalls[0]!.body);
    expect(Object.fromEntries(form)).toEqual({
      client_id: 'TEST_CLIENT',
      client_version: '1',
      client_secret: 'test_secret',
      grant_type: 'client_credentials',
    });
    const apiCalls = requests.filter((r) => r.url.includes('/checkout/v2/order/'));
    expect(apiCalls).toHaveLength(3);
    for (const c of apiCalls) expect(c.headers.authorization).toBe('O-Bearer tok-1');
  });

  it('refreshes the token once on a 401 and retries', async () => {
    const requests: string[] = [];
    let tokenN = 0;
    let statusN = 0;
    const fetch: FetchLike = async (url, init) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      requests.push(`${init?.method} ${url} ${auth ?? ''}`);
      if (url.includes('/oauth/token')) {
        tokenN++;
        return Response.json({ access_token: `tok-${tokenN}`, expires_at: NOW_S + 3600 });
      }
      statusN++;
      if (statusN === 1) return Response.json({ code: 'UNAUTHORIZED', message: 'token expired' }, { status: 401 });
      return Response.json(completedStatus);
    };
    const gw = phonepe.create(creds, testContext('phonepe', fetch, { extractError: phonepe.extractError }));
    const res = await gw.getPaymentStatus({ orderRef: 'ord_1' });
    expect(res.status).toBe('captured');
    expect(tokenN).toBe(2);
    expect(requests.filter((r) => r.includes('/order/')).map((r) => r.split(' ').pop())).toEqual(['tok-1', 'tok-2']);
  });

  it('does not loop on a persistent 401', async () => {
    const { gw, requests } = gateway([tokenRoute, { match: '/checkout/v2/order/', status: 401, body: { code: 'UNAUTHORIZED', message: 'nope' } }]);
    await expect(gw.getPaymentStatus({ orderRef: 'ord_1' })).rejects.toMatchObject({ code: 'AUTH', providerCode: 'UNAUTHORIZED' });
    expect(requests.filter((r) => r.url.includes('/order/'))).toHaveLength(2);
  });

  it('refreshes a token that is about to expire', async () => {
    const { gw, requests } = gateway([
      { ...tokenRoute, body: { access_token: 'tok-short', expires_at: NOW_S + 30 } },
      { match: '/checkout/v2/order/', body: completedStatus },
    ]);
    await gw.getPaymentStatus({ orderRef: 'a' });
    await gw.getPaymentStatus({ orderRef: 'b' });
    expect(requests.filter((r) => r.url.includes('/oauth/token'))).toHaveLength(2);
  });

  it('creates a payment and returns a redirect checkout', async () => {
    const { gw, requests } = gateway([
      tokenRoute,
      {
        match: 'POST https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/pay',
        body: { orderId: 'OMO2510281000', state: 'PENDING', expireAt: 1761646800000, redirectUrl: 'https://mercury-uat.phonepe.com/transact/uat_v2?token=abc' },
      },
    ]);
    const res = await gw.createPayment({
      orderRef: 'ord_42',
      amount: 49900,
      description: 'Pro plan',
      returnUrl: 'https://shop.example/return?order=ord_42',
      metadata: { udf3: 'explicit', plan: 'pro' },
      providerOptions: { expireAfter: 1200 },
    });
    const call = requests.find((r) => r.url.endsWith('/checkout/v2/pay'))!;
    expect(call.headers.authorization).toBe('O-Bearer tok-1');
    expect(JSON.parse(call.body!)).toEqual({
      merchantOrderId: 'ord_42',
      amount: 49900,
      expireAfter: 1200,
      metaInfo: { udf3: 'explicit', udf1: 'pro' },
      paymentFlow: { type: 'PG_CHECKOUT', message: 'Pro plan', merchantUrls: { redirectUrl: 'https://shop.example/return?order=ord_42' } },
    });
    expect(res.providerOrderId).toBe('OMO2510281000');
    expect(res.status).toBe('created');
    expect(res.checkout).toEqual({ type: 'redirect', url: 'https://mercury-uat.phonepe.com/transact/uat_v2?token=abc', method: 'GET' });
    expect(res.expiresAt).toBe(new Date(1761646800000).toISOString());
  });

  it('rejects bad create input before calling PhonePe', async () => {
    const { gw, requests } = gateway([tokenRoute]);
    const base = { orderRef: 'ord_1', amount: 100, returnUrl: 'https://x.test/r' };
    await expect(gw.createPayment({ ...base, amount: 99 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.createPayment({ ...base, returnUrl: undefined })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.createPayment({ ...base, orderRef: 'bad ref!' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.createPayment({ ...base, providerOptions: { expireAfter: 60 } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.createPayment({ ...base, currency: 'USD' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.createPayment({ ...base, metadata: { udf2: 'x'.repeat(257) } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.createPayment({ ...base, metadata: { udf12: 'has space' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.createPayment({ ...base, metadata: { udf11: 'x'.repeat(51) } })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(requests).toHaveLength(0);
  });

  it('accepts metaInfo values at the documented limits', async () => {
    const { gw, requests } = gateway([tokenRoute, { match: 'POST https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/pay', body: { orderId: 'OMO1', state: 'PENDING', expireAt: 1, redirectUrl: 'https://x' } }]);
    await gw.createPayment({ orderRef: 'ord_1', amount: 100, returnUrl: 'https://x.test/r', metadata: { udf10: 'free text, any chars! '.padEnd(256, 'x'), udf15: 'a_b-c+d@e.f' } });
    const call = requests.find((r) => r.url.endsWith('/checkout/v2/pay'))!;
    expect(JSON.parse(call.body!).metaInfo.udf15).toBe('a_b-c+d@e.f');
  });

  it('maps order status and picks the latest attempt', async () => {
    const { gw, requests } = gateway([tokenRoute, { match: '/checkout/v2/order/ord_1/status', body: completedStatus }]);
    const res = await gw.getPaymentStatus({ orderRef: 'ord_1' });
    expect(requests.at(-1)!.url).toBe('https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/order/ord_1/status?details=false&errorContext=true');
    expect(res).toMatchObject({ status: 'captured', providerOrderId: 'OMO123', providerPaymentId: 'OM_NEW', method: 'upi', amount: 49900 });
  });

  it.each([
    [{ state: 'FAILED', amount: 100, errorCode: 'TXN_FAILED', detailedErrorCode: 'ZA', paymentDetails: [{ transactionId: 't', timestamp: 1, state: 'FAILED' }] }, 'failed', 'ZA'],
    [{ state: 'PENDING', amount: 100, paymentDetails: [{ transactionId: 't', timestamp: 1, state: 'PENDING' }] }, 'pending', undefined],
    [{ state: 'PENDING', amount: 100, paymentDetails: [] }, 'created', undefined],
    [{ state: 'WEIRD', amount: 100 }, 'unknown', undefined],
  ])('maps %j', async (body, status, reason) => {
    const { gw } = gateway([tokenRoute, { match: '/checkout/v2/order/', body }]);
    const res = await gw.getPaymentStatus({ orderRef: 'ord_1' });
    expect(res.status).toBe(status);
    expect(res.failureReason).toBe(reason);
  });

  it('verifies via the status API and enforces amount and orderRef', async () => {
    const { gw } = gateway([tokenRoute, { match: '/checkout/v2/order/', body: completedStatus }]);
    const ok = await gw.verifyPayment({ orderRef: 'ord_1', expectedAmount: 49900, payload: {} });
    expect(ok).toMatchObject({ valid: true, status: 'captured', verifiedVia: 'status_api', providerPaymentId: 'OM_NEW' });
    const wrongAmount = await gw.verifyPayment({ orderRef: 'ord_1', expectedAmount: 100, payload: {} });
    expect(wrongAmount.valid).toBe(false);
    const swapped = await gw.verifyPayment({ orderRef: 'ord_1', payload: { merchantOrderId: 'ord_2' } });
    expect(swapped.valid).toBe(false);
    const noRef = await gw.verifyPayment({ payload: {} });
    expect(noRef.valid).toBe(false);
  });

  it('creates a refund (retry-safe body) and reads refund status', async () => {
    const { gw, requests } = gateway([
      tokenRoute,
      { match: 'POST https://api-preprod.phonepe.com/apis/pg-sandbox/payments/v2/refund', body: { refundId: 'OMR1', amount: 10000, state: 'PENDING' } },
      { match: 'GET https://api-preprod.phonepe.com/apis/pg-sandbox/payments/v2/refund/rf_1/status', body: { refundId: 'OMR1', amount: 10000, state: 'COMPLETED' } },
    ]);
    const r = await gw.refund!({ orderRef: 'ord_1', refundRef: 'rf_1', amount: 10000 });
    expect(JSON.parse(requests.at(-1)!.body!)).toEqual({ merchantRefundId: 'rf_1', originalMerchantOrderId: 'ord_1', amount: 10000 });
    expect(r).toMatchObject({ providerRefundId: 'OMR1', status: 'pending', amount: 10000 });
    const s = await gw.getRefundStatus!({ refundRef: 'rf_1' });
    expect(s).toMatchObject({ status: 'processed', providerRefundId: 'OMR1' });
  });

  it('looks up the order amount for a full refund', async () => {
    const { gw, requests } = gateway([
      tokenRoute,
      { match: '/checkout/v2/order/', body: completedStatus },
      { match: '/payments/v2/refund', body: { refundId: 'OMR2', amount: 49900, state: 'PENDING' } },
    ]);
    await gw.refund!({ orderRef: 'ord_1', refundRef: 'rf_full' });
    expect(JSON.parse(requests.at(-1)!.body!).amount).toBe(49900);
    await expect(gw.refund!({ orderRef: 'ord_1', refundRef: 'rf_tiny', amount: 50 })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('accepts a webhook with the right Authorization and rejects others', async () => {
    const { gw } = gateway([]);
    const rawBody = JSON.stringify({
      event: 'checkout.order.completed',
      payload: { merchantId: 'M', merchantOrderId: 'ord_9', orderId: 'OMO9', state: 'COMPLETED', amount: 49900, paymentDetails: [{ paymentMode: 'UPI_QR', transactionId: 'OM9', timestamp: 1761645600000, state: 'COMPLETED' }] },
    });
    const auth = phonepeWebhookAuthorization('hookuser', 'hookpass');
    expect(auth).toMatch(/^[0-9a-f]{64}$/);
    const ev = await gw.parseWebhook({ headers: { Authorization: auth }, rawBody });
    expect(ev).toMatchObject({ type: 'payment.succeeded', orderRef: 'ord_9', providerOrderId: 'OMO9', providerPaymentId: 'OM9', status: 'captured', amount: 49900 });
    expect(ev.id).toBe('checkout.order.completed:OMO9:COMPLETED');

    const bad = phonepeWebhookAuthorization('hookuser', 'wrong');
    await expect(gw.parseWebhook({ headers: { authorization: bad }, rawBody })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(gw.parseWebhook({ headers: {}, rawBody })).rejects.toBeInstanceOf(PaymentError);
    await expect(gw.parseWebhook({ headers: { authorization: `SHA256 ${auth}` }, rawBody })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('maps refund webhooks', async () => {
    const { gw } = gateway([]);
    const rawBody = JSON.stringify({
      event: 'pg.refund.failed',
      payload: { merchantRefundId: 'rf_1', originalMerchantOrderId: 'ord_1', refundId: 'OMR1', state: 'FAILED', amount: 100 },
    });
    const ev = await gw.parseWebhook({ headers: { authorization: phonepeWebhookAuthorization('hookuser', 'hookpass') }, rawBody });
    expect(ev).toMatchObject({ type: 'refund.failed', refundRef: 'rf_1', orderRef: 'ord_1', providerRefundId: 'OMR1', status: undefined });
  });

  it('reads a flat (unwrapped) refund webhook like the documented UPI sample', async () => {
    const { gw } = gateway([]);
    const rawBody = JSON.stringify({ originalMerchantOrderId: 'ord_1', amount: 1000, state: 'COMPLETED', timestamp: 1761645600000, refundId: 'OMR2', errorCode: null, detailedErrorCode: null, splitInstruments: [] });
    const ev = await gw.parseWebhook({ headers: { authorization: phonepeWebhookAuthorization('hookuser', 'hookpass') }, rawBody });
    expect(ev).toMatchObject({
      type: 'refund.processed',
      providerEventType: 'pg.refund.completed',
      orderRef: 'ord_1',
      providerRefundId: 'OMR2',
      refundRef: undefined,
      amount: 1000,
      status: undefined,
      occurredAt: new Date(1761645600000).toISOString(),
    });
    expect(ev.id).toBe('pg.refund.completed:OMR2:COMPLETED');
  });

  it.each(['payment.succeeded', 'payment.failed', 'refund.processed'] as const)('simulateWebhook(%s) round-trips', async (type) => {
    const { gw } = gateway([]);
    const sim = await gw.simulateWebhook!({ type, orderRef: 'ord_sim', amount: 25000, refundRef: 'rf_sim' });
    const ev = await gw.parseWebhook({ headers: sim.headers, rawBody: sim.rawBody });
    expect(ev.type).toBe(type);
    expect(ev.orderRef).toBe('ord_sim');
    expect(ev.amount).toBe(25000);
    if (type === 'refund.processed') expect(ev.refundRef).toBe('rf_sim');
    else expect(ev.status).toBe(type === 'payment.succeeded' ? 'captured' : 'failed');
  });

  it('uses split OAuth/API hosts in live mode', async () => {
    const { gw, requests } = gateway(
      [
        { match: 'POST https://api.phonepe.com/apis/identity-manager/v1/oauth/token', body: { access_token: 'live-tok', expires_at: NOW_S + 3600 } },
        { match: 'GET https://api.phonepe.com/apis/pg/checkout/v2/order/', body: completedStatus },
      ],
      'live',
    );
    await gw.getPaymentStatus({ orderRef: 'ord_1' });
    expect(requests.map((r) => r.url.split('?')[0])).toEqual([PHONEPE_HOSTS.live.token, `${PHONEPE_HOSTS.live.api}/checkout/v2/order/ord_1/status`]);
    expect(gw.environment).toBe('live');
  });

  it('extracts provider error code and message', async () => {
    const { gw } = gateway([tokenRoute, { match: '/checkout/v2/pay', status: 400, body: { code: 'BAD_REQUEST', message: 'Order already exists' } }]);
    await expect(gw.createPayment({ orderRef: 'ord_1', amount: 100, returnUrl: 'https://x.test/r' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      providerCode: 'BAD_REQUEST',
      providerMessage: 'Order already exists',
    });
  });

  it('declares no customer/subscription/settlement methods', () => {
    const { gw } = gateway([]);
    expect(gw.createCustomer).toBeUndefined();
    expect(gw.createSubscription).toBeUndefined();
    expect(gw.listSettlements).toBeUndefined();
    const f = gw.capabilities().features;
    expect(f.customers.support).toBe('unsupported');
    expect(f.subscriptions.support).toBe('not_implemented');
  });
});
