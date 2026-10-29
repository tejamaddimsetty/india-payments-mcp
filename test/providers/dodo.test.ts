import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';
import { PaymentsClient } from '../../src/client.js';
import { silentLogger } from '../../src/core/logger.js';
import { dodo, dodoMatchedAmount, dodoWebhookSignature, mapDodoPaymentStatus, mapDodoRefundStatus } from '../../src/providers/dodo/adapter.js';
import { fakeFetch, testContext, type FakeRoute } from '../helpers.js';

// The public Standard Webhooks reference test vector key (github.com/standard-webhooks), not a real secret.
// Assembled at runtime so secret scanners don't mistake it for a Stripe whsec_ key.
const VECTOR_KEY = ['whsec', 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'].join('_');
const creds = { apiKey: 'dodo_test_abc123', webhookKey: VECTOR_KEY };
// testContext's clock: 2026-10-28T10:00:00Z
const NOW = Math.floor(Date.parse('2026-10-28T10:00:00.000Z') / 1000);
const API = 'https://test.dodopayments.com';

const product = (price: Record<string, unknown>, id = 'pdt_fixed') => ({ match: `GET ${API}/products/${id}`, body: { product_id: id, name: 'Pro plan', price: { type: 'one_time_price', currency: 'INR', price: 149900, ...price } } });
const SESSION: FakeRoute = { match: `POST ${API}/checkouts`, body: { session_id: 'cks_123', checkout_url: 'https://test.checkout.dodopayments.com/session/cks_123' } };
const payment = (over: Record<string, unknown> = {}) => ({
  payment_id: 'pay_1',
  status: 'succeeded',
  total_amount: 149900,
  currency: 'INR',
  tax: 0,
  checkout_session_id: 'cks_123',
  metadata: { order_ref: 'ord_1', expected_amount: '149900', expected_currency: 'INR' },
  product_cart: [{ product_id: 'pdt_fixed', quantity: 1 }],
  refunds: [],
  ...over,
});

function gateway(routes: FakeRoute[] = [], c: Record<string, string | undefined> = creds, environment: 'sandbox' | 'live' = 'sandbox') {
  const f = fakeFetch(routes);
  return { gw: dodo.create(c, testContext('dodo', f.fetch, { extractError: dodo.extractError, environment })), ...f };
}

function signed(rawBody: string, opts: { id?: string; t?: number; secret?: string } = {}) {
  const id = opts.id ?? 'msg_1';
  const t = opts.t ?? NOW;
  return { 'webhook-id': id, 'webhook-timestamp': String(t), 'webhook-signature': `v1,${dodoWebhookSignature(opts.secret ?? creds.webhookKey, id, t, rawBody)}` };
}

describe('dodo configuration', () => {
  it('needs an API key and refuses keys from the other mode', () => {
    expect(() => gateway([], {})).toThrow(/DODO_PAYMENTS_API_KEY/);
    expect(() => gateway([], { apiKey: 'dodo_live_x' }, 'sandbox')).toThrow(/dodo_live_ key with PAYMENTS_MODE=sandbox/);
    expect(() => gateway([], { apiKey: 'dodo_test_x' }, 'live')).toThrow(/dodo_test_ key with PAYMENTS_MODE=live/);
    expect(() => gateway([], { apiKey: 'legacy_unprefixed' }, 'live')).not.toThrow();
  });

  it('talks to test.dodopayments.com in sandbox and live.dodopayments.com in live, with a Bearer key', async () => {
    const sb = gateway([product({}), SESSION]);
    await sb.gw.createPayment({ orderRef: 'ord_1', amount: 149900, currency: 'INR', providerOptions: { productId: 'pdt_fixed' } });
    expect(sb.requests.every((r) => r.url.startsWith(`${API}/`))).toBe(true);
    expect(sb.requests[0]!.headers.authorization).toBe('Bearer dodo_test_abc123');
    const LIVE = 'https://live.dodopayments.com';
    const lv = gateway([{ ...product({}), match: `GET ${LIVE}/products/pdt_fixed` }, { ...SESSION, match: `POST ${LIVE}/checkouts` }], { apiKey: 'dodo_live_k' }, 'live');
    await lv.gw.createPayment({ orderRef: 'ord_1', amount: 149900, currency: 'INR', providerOptions: { productId: 'pdt_fixed' } });
    expect(lv.requests.every((r) => r.url.startsWith(`${LIVE}/`))).toBe(true);
  });
});

describe('dodo createPayment', () => {
  it('creates a checkout session for the product, binds order_ref and the amount, returns a redirect', async () => {
    const { gw, requests } = gateway([product({}), SESSION]);
    const r = await gw.createPayment({
      orderRef: 'ord_1',
      amount: 149900,
      currency: 'INR',
      customer: { name: 'Asha', email: 'asha@example.com', phone: '+919876543210' },
      billingAddress: { country: 'IN', city: 'Bengaluru', line1: '1 MG Road', postalCode: '560001' },
      returnUrl: 'https://shop.example.com/return?orderRef=ord_1',
      metadata: { order_ref: 'FORGED', plan: 'pro' },
      providerOptions: { productId: 'pdt_fixed', allowed_payment_method_types: ['upi_intent', 'credit', 'debit'] },
    });
    const body = JSON.parse(requests[1]!.body!);
    expect(body).toEqual({
      allowed_payment_method_types: ['upi_intent', 'credit', 'debit'],
      product_cart: [{ product_id: 'pdt_fixed', quantity: 1 }],
      customer: { email: 'asha@example.com', name: 'Asha', phone_number: '+919876543210' },
      billing_address: { country: 'IN', city: 'Bengaluru', street: '1 MG Road', zipcode: '560001' },
      return_url: 'https://shop.example.com/return?orderRef=ord_1',
      feature_flags: { allow_discount_code: false, allow_currency_selection: false },
      metadata: { order_ref: 'ord_1', plan: 'pro', expected_amount: '149900', expected_currency: 'INR' },
    });
    expect(r).toMatchObject({ provider: 'dodo', providerOrderId: 'cks_123', status: 'created', amount: 149900, currency: 'INR' });
    expect(r.checkout).toEqual({ type: 'redirect', url: 'https://test.checkout.dodopayments.com/session/cks_123', method: 'GET' });
  });

  it('uses DODO_PAYMENTS_DEFAULT_PRODUCT_ID when no productId is passed, and needs one or the other', async () => {
    const { gw, requests } = gateway([product({}, 'pdt_default'), SESSION], { ...creds, defaultProductId: 'pdt_default' });
    await gw.createPayment({ orderRef: 'ord_1', amount: 149900, currency: 'INR' });
    expect(requests[0]!.url).toBe(`${API}/products/pdt_default`);
    await expect(gateway().gw.createPayment({ orderRef: 'ord_1', amount: 149900, currency: 'INR' })).rejects.toThrow(/DODO_PAYMENTS_DEFAULT_PRODUCT_ID/);
  });

  it('refuses a fixed-price product that would charge a different amount, currency or a discount, before any POST', async () => {
    for (const [price, msg] of [
      [{ price: 99900 }, /costs 99900 INR/],
      [{ currency: 'USD' }, /priced in USD, not INR/],
      [{ discount_bps: 1000 }, /10% discount/],
      [{ type: 'recurring_price' }, /recurring_price price/],
    ] as const) {
      const { gw, requests } = gateway([product(price)]);
      await expect(gw.createPayment({ orderRef: 'ord_1', amount: 149900, currency: 'INR', providerOptions: { productId: 'pdt_fixed' } })).rejects.toThrow(msg);
      expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    }
  });

  it('pay-what-you-want products take the amount, above their minimum', async () => {
    const pwyw = { match: `GET ${API}/products/pdt_pwyw`, body: { product_id: 'pdt_pwyw', price: { type: 'one_time_price', currency: 'USD', price: 500, pay_what_you_want: true } } };
    const { gw, requests } = gateway([pwyw, SESSION]);
    await gw.createPayment({ orderRef: 'ord_1', amount: 2500, currency: 'USD', providerOptions: { productId: 'pdt_pwyw' } });
    expect(JSON.parse(requests[1]!.body!).product_cart).toEqual([{ product_id: 'pdt_pwyw', quantity: 1, amount: 2500 }]);
    await expect(gateway([pwyw]).gw.createPayment({ orderRef: 'ord_2', amount: 100, currency: 'USD', providerOptions: { productId: 'pdt_pwyw' } })).rejects.toThrow(/below the pay-what-you-want minimum/);
  });

  it('enforces Dodo metadata limits', async () => {
    const { gw } = gateway([product({})]);
    await expect(gw.createPayment({ orderRef: 'ord_1', amount: 149900, currency: 'INR', metadata: { ['k'.repeat(41)]: 'v' }, providerOptions: { productId: 'pdt_fixed' } })).rejects.toThrow(/longer than 40/);
  });

  it('a lost POST /checkouts response is OUTCOME_UNKNOWN and is not retried (Dodo has no idempotency key)', async () => {
    const { gw, requests } = gateway([product({}), { match: `POST ${API}/checkouts`, status: 503, body: { code: 'INTERNAL', message: 'down' } }]);
    await expect(gw.createPayment({ orderRef: 'ord_1', amount: 149900, currency: 'INR', providerOptions: { productId: 'pdt_fixed' } })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });
});

describe('dodo verifyPayment and status', () => {
  const PAY: FakeRoute = { match: `GET ${API}/payments/pay_1`, body: payment() };
  const CKS: FakeRoute = { match: `GET ${API}/checkouts/cks_123`, body: { id: 'cks_123', payment_id: 'pay_1', payment_status: 'succeeded' } };

  it('re-reads the payment server-side: the unsigned return status is ignored', async () => {
    const { gw } = gateway([CKS, { ...PAY, body: payment({ status: 'failed' }) }]);
    const v = await gw.verifyPayment({ orderRef: 'ord_1', expectedAmount: 149900, providerOrderId: 'cks_123', payload: { payment_id: 'pay_1', status: 'succeeded' } });
    expect(v).toMatchObject({ valid: true, status: 'failed', verifiedVia: 'status_api', providerPaymentId: 'pay_1' });
  });

  it('captured when the order, session and amount match', async () => {
    const { gw } = gateway([CKS, PAY]);
    expect(await gw.verifyPayment({ orderRef: 'ord_1', expectedAmount: 149900, providerOrderId: 'cks_123', payload: { payment_id: 'pay_1' } })).toMatchObject({ valid: true, status: 'captured', amount: 149900, providerOrderId: 'cks_123' });
  });

  it('rejects another order\'s payment, another session\'s payment, and a different amount', async () => {
    expect((await gateway([CKS, PAY]).gw.verifyPayment({ orderRef: 'ord_OTHER', expectedAmount: 149900, providerOrderId: 'cks_123', payload: { payment_id: 'pay_1' } })).valid).toBe(false);
    const swapped = await gateway([CKS]).gw.verifyPayment({ orderRef: 'ord_1', expectedAmount: 149900, providerOrderId: 'cks_123', payload: { payment_id: 'pay_EVIL' } });
    expect(swapped).toMatchObject({ valid: false });
    expect(swapped.reason).toMatch(/does not belong to checkout session/);
    const cheap = await gateway([CKS, { ...PAY, body: payment({ total_amount: 100 }) }]).gw.verifyPayment({ orderRef: 'ord_1', expectedAmount: 149900, providerOrderId: 'cks_123', payload: { payment_id: 'pay_1' } });
    expect(cheap).toMatchObject({ valid: false });
    expect(cheap.reason).toMatch(/Amount mismatch/);
    expect((await gateway([CKS, { ...PAY, body: payment({ currency: 'USD', total_amount: 1800 }) }]).gw.verifyPayment({ orderRef: 'ord_1', expectedAmount: 149900, providerOrderId: 'cks_123', payload: { payment_id: 'pay_1' } })).valid).toBe(false);
  });

  it('tax added on top of a tax-exclusive price still binds to the price', async () => {
    const { gw } = gateway([CKS, { ...PAY, body: payment({ total_amount: 176882, tax: 26982 }) }]);
    expect(await gw.verifyPayment({ orderRef: 'ord_1', expectedAmount: 149900, providerOrderId: 'cks_123', payload: { payment_id: 'pay_1' } })).toMatchObject({ valid: true, status: 'captured', amount: 149900 });
    expect(dodoMatchedAmount({ total_amount: 176882, tax: 26982 }, 149900)).toBe(149900);
    expect(dodoMatchedAmount({ total_amount: 176882, tax: 0 }, 149900)).toBe(176882);
  });

  it('session without a payment yet is "created"; status lookup needs a stored id', async () => {
    const { gw } = gateway([{ ...CKS, body: { id: 'cks_123', payment_id: null, payment_status: null } }]);
    expect(await gw.getPaymentStatus({ orderRef: 'ord_1', providerOrderId: 'cks_123' })).toMatchObject({ status: 'created' });
    await expect(gw.getPaymentStatus({ orderRef: 'ord_1' })).rejects.toThrow(/cannot search by orderRef/);
  });

  it('status reports the matched price, refund state, and refuses another order\'s payment', async () => {
    const s = await gateway([{ ...PAY, body: payment({ total_amount: 176882, tax: 26982, refund_status: 'partial', payment_method_type: 'upi_intent' }) }]).gw.getPaymentStatus({ orderRef: 'ord_1', providerPaymentId: 'pay_1' });
    expect(s).toMatchObject({ status: 'partially_refunded', amount: 149900, method: 'upi_intent', providerOrderId: 'cks_123' });
    await expect(gateway([PAY]).gw.getPaymentStatus({ orderRef: 'ord_OTHER', providerPaymentId: 'pay_1' })).rejects.toThrow(/belongs to order ord_1/);
  });

  it('maps every documented IntentStatus; unclear ones are never "captured"', () => {
    expect(mapDodoPaymentStatus('succeeded')).toBe('captured');
    expect(mapDodoPaymentStatus('succeeded', 'full')).toBe('refunded');
    expect(mapDodoPaymentStatus('failed')).toBe('failed');
    expect(mapDodoPaymentStatus('cancelled')).toBe('cancelled');
    for (const s of ['processing', 'requires_customer_action', 'requires_merchant_action', 'requires_payment_method', 'requires_confirmation']) expect(mapDodoPaymentStatus(s)).toBe('pending');
    expect(mapDodoPaymentStatus('requires_capture')).toBe('authorized');
    expect(mapDodoPaymentStatus('partially_captured_and_capturable')).toBe('authorized');
    expect(mapDodoPaymentStatus('partially_captured')).toBe('unknown');
    expect(mapDodoPaymentStatus('brand_new_status')).toBe('unknown');
    expect(mapDodoRefundStatus('review')).toBe('pending');
  });
});

describe('dodo refunds', () => {
  const PAY: FakeRoute = { match: `GET ${API}/payments/pay_1`, body: payment() };
  const CREATED: FakeRoute = { match: `POST ${API}/refunds`, body: { refund_id: 'rfn_1', payment_id: 'pay_1', status: 'pending', amount: 149900, currency: 'INR', metadata: { refund_ref: 'rf_1' } } };

  it('full refund: refund_ref in metadata, no items and no currency', async () => {
    const { gw, requests } = gateway([PAY, CREATED]);
    const r = await gw.refund!({ orderRef: 'ord_1', providerPaymentId: 'pay_1', refundRef: 'rf_1', reason: 'requested' });
    expect(JSON.parse(requests[1]!.body!)).toEqual({ payment_id: 'pay_1', reason: 'requested', metadata: { refund_ref: 'rf_1', order_ref: 'ord_1' } });
    expect(r).toMatchObject({ providerRefundId: 'rfn_1', status: 'pending', amount: 149900 });
  });

  it('partial refund is one item in the payment currency; the matched price counts as full', async () => {
    const { gw, requests } = gateway([PAY, CREATED]);
    await gw.refund!({ orderRef: 'ord_1', providerPaymentId: 'pay_1', refundRef: 'rf_1', amount: 50000 });
    expect(JSON.parse(requests[1]!.body!)).toMatchObject({ items: [{ item_id: 'pdt_fixed', amount: 50000 }], currency: 'INR' });
    const taxed = gateway([{ ...PAY, body: payment({ total_amount: 176882, tax: 26982 }) }, CREATED]);
    await taxed.gw.refund!({ orderRef: 'ord_1', providerPaymentId: 'pay_1', refundRef: 'rf_1', amount: 149900 });
    expect(JSON.parse(taxed.requests[1]!.body!).items).toBeUndefined();
  });

  it('returns the existing refund for the same refundRef instead of refunding twice', async () => {
    const withRefund = payment({ refunds: [{ refund_id: 'rfn_old', status: 'succeeded', amount: 149900 }] });
    const OLD: FakeRoute = { match: `GET ${API}/refunds/rfn_old`, body: { refund_id: 'rfn_old', payment_id: 'pay_1', status: 'succeeded', amount: 149900, metadata: { refund_ref: 'rf_1' } } };
    const { gw, requests } = gateway([{ ...PAY, body: withRefund }, OLD]);
    expect(await gw.refund!({ orderRef: 'ord_1', providerPaymentId: 'pay_1', refundRef: 'rf_1' })).toMatchObject({ providerRefundId: 'rfn_old', status: 'processed' });
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    await expect(gateway([{ ...PAY, body: withRefund }, OLD]).gw.refund!({ orderRef: 'ord_1', providerPaymentId: 'pay_1', refundRef: 'rf_1', amount: 100 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('finds an existing refund whose list entry has no metadata by fetching it', async () => {
    const { gw } = gateway([
      { ...PAY, body: payment({ refunds: [{ refund_id: 'rfn_x', status: 'pending' }] }) },
      { match: `GET ${API}/refunds/rfn_x`, body: { refund_id: 'rfn_x', payment_id: 'pay_1', status: 'pending', amount: 149900, metadata: { refund_ref: 'rf_1' } } },
    ]);
    expect(await gw.getRefundStatus!({ refundRef: 'rf_1', providerPaymentId: 'pay_1' })).toMatchObject({ providerRefundId: 'rfn_x', status: 'pending' });
  });

  it('refuses another order\'s payment, missing ids and over-long reasons; a lost POST is OUTCOME_UNKNOWN', async () => {
    await expect(gateway([PAY]).gw.refund!({ orderRef: 'ord_OTHER', providerPaymentId: 'pay_1', refundRef: 'rf_1' })).rejects.toThrow(/belongs to order ord_1/);
    await expect(gateway().gw.refund!({ orderRef: 'ord_1', refundRef: 'rf_1' })).rejects.toThrow(/providerPaymentId/);
    await expect(gateway([PAY]).gw.refund!({ orderRef: 'ord_1', providerPaymentId: 'pay_1', refundRef: 'rf_1', reason: 'x'.repeat(3001) })).rejects.toThrow(/3000/);
    await expect(gateway([PAY, { match: `POST ${API}/refunds`, status: 502, body: {} }]).gw.refund!({ orderRef: 'ord_1', providerPaymentId: 'pay_1', refundRef: 'rf_1' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  });

  it('through PaymentsClient, a lost refund response is resolved by looking the refund up', async () => {
    let posted = false;
    const fetch = async (url: string, init?: RequestInit) => {
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      if (init?.method === 'POST' && url.endsWith('/refunds')) {
        posted = true;
        return json({}, 504);
      }
      if (url.endsWith('/payments/pay_1')) return json(payment(posted ? { refunds: [{ refund_id: 'rfn_9', status: 'pending', amount: 149900 }] } : {}));
      if (url.endsWith('/refunds/rfn_9')) return json({ refund_id: 'rfn_9', payment_id: 'pay_1', status: 'pending', amount: 149900, metadata: { refund_ref: 'rf_9' } });
      return json({ code: 'NOT_FOUND' }, 404);
    };
    const c = new PaymentsClient({ env: { PAYMENTS_MODE: 'sandbox', DODO_PAYMENTS_API_KEY: 'dodo_test_k' }, fetch, logger: silentLogger, config: { maxRetries: 0 } });
    expect(await c.refund('dodo', { orderRef: 'ord_1', providerPaymentId: 'pay_1', refundRef: 'rf_9' })).toMatchObject({ providerRefundId: 'rfn_9', status: 'pending' });
  });
});

describe('dodo webhooks (Standard Webhooks)', () => {
  const body = JSON.stringify({ business_id: 'bus_1', type: 'payment.succeeded', timestamp: '2026-10-28T10:00:00Z', data: { payload_type: 'Payment', payment_id: 'pay_1', checkout_session_id: 'cks_123', status: 'succeeded', total_amount: 176882, tax: 26982, currency: 'INR', metadata: { order_ref: 'ord_1', expected_amount: '149900' } } });

  it('matches the Standard Webhooks reference test vector', () => {
    expect(dodoWebhookSignature(VECTOR_KEY, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}')).toBe('g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('verifies and normalises a payment event (matched price, dedupe id = webhook-id)', async () => {
    const e = await gateway().gw.parseWebhook({ headers: signed(body), rawBody: body });
    expect(e).toMatchObject({ provider: 'dodo', id: 'msg_1', type: 'payment.succeeded', providerEventType: 'payment.succeeded', orderRef: 'ord_1', providerOrderId: 'cks_123', providerPaymentId: 'pay_1', status: 'captured', amount: 149900, currency: 'INR' });
  });

  it('accepts any of several space-separated v1 signatures (secret rotation)', async () => {
    const h = signed(body);
    const e = await gateway().gw.parseWebhook({ headers: { ...h, 'webhook-signature': `v1,AAAA ${h['webhook-signature']} v2,ignored` }, rawBody: body });
    expect(e.type).toBe('payment.succeeded');
  });

  it('rejects tampering, wrong secret, missing headers, and stale or future timestamps', async () => {
    const { gw } = gateway();
    await expect(gw.parseWebhook({ headers: signed(body), rawBody: body.replace('176882', '1') })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(gw.parseWebhook({ headers: signed(body, { secret: 'whsec_' + Buffer.from('other').toString('base64') }), rawBody: body })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(gw.parseWebhook({ headers: { ...signed(body), 'webhook-id': 'msg_2' }, rawBody: body })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(gw.parseWebhook({ headers: { 'webhook-id': 'msg_1' }, rawBody: body })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(gw.parseWebhook({ headers: signed(body, { t: NOW - 301 }), rawBody: body })).rejects.toThrow(/tolerance/);
    await expect(gw.parseWebhook({ headers: signed(body, { t: NOW + 301 }), rawBody: body })).rejects.toThrow(/tolerance/);
    await expect(gateway([], { apiKey: 'dodo_test_k' }).gw.parseWebhook({ headers: signed(body), rawBody: body })).rejects.toMatchObject({ code: 'CONFIG_MISSING' });
  });

  it('maps refund, subscription, dispute and unknown events', async () => {
    const { gw } = gateway();
    const ev = async (type: string, data: Record<string, unknown>) => {
      const raw = JSON.stringify({ type, timestamp: '2026-10-28T10:00:00Z', data });
      return gw.parseWebhook({ headers: signed(raw), rawBody: raw });
    };
    expect(await ev('refund.succeeded', { refund_id: 'rfn_1', payment_id: 'pay_1', amount: 50000, currency: 'INR', metadata: { refund_ref: 'rf_1', order_ref: 'ord_1' } })).toMatchObject({ type: 'refund.processed', providerRefundId: 'rfn_1', refundRef: 'rf_1', amount: 50000, status: undefined });
    expect((await ev('refund.failed', {})).type).toBe('refund.failed');
    expect((await ev('payment.cancelled', { status: 'cancelled' })).status).toBe('cancelled');
    expect((await ev('subscription.active', {})).type).toBe('subscription.activated');
    expect((await ev('subscription.on_hold', {})).type).toBe('subscription.halted');
    expect((await ev('dispute.opened', {})).type).toBe('dispute.created');
    expect((await ev('license_key.created', {})).type).toBe('unknown');
  });

  it('agrees with the official standardwebhooks library (the one Dodo\'s SDK uses), in both directions', async () => {
    const { gw } = gateway();
    // Real clock: the library checks the timestamp against Date.now().
    const now = new Date();
    const id = 'msg_lib_1';
    const raw = JSON.stringify({ type: 'refund.succeeded', timestamp: now.toISOString(), data: { refund_id: 'rfn_1', metadata: { refund_ref: 'rf_1' } } });
    const libSig = new Webhook(creds.webhookKey).sign(id, now, raw);
    expect(libSig).toBe(`v1,${dodoWebhookSignature(creds.webhookKey, id, Math.floor(now.getTime() / 1000), raw)}`);
    const sim = await gw.simulateWebhook!({ type: 'payment.succeeded', orderRef: 'ord_1', amount: 100, currency: 'USD' });
    // Our simulator signs with testContext's fixed clock; re-sign the same body at "now" for the library's tolerance.
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { 'webhook-id': sim.headers['webhook-id']!, 'webhook-timestamp': ts, 'webhook-signature': `v1,${dodoWebhookSignature(creds.webhookKey, sim.headers['webhook-id']!, ts, sim.rawBody)}` };
    expect(() => new Webhook(creds.webhookKey).verify(sim.rawBody, headers)).not.toThrow();
    expect(() => new Webhook(creds.webhookKey).verify(sim.rawBody.replace('100', '1'), headers)).toThrow();
  });

  it('simulateWebhook output round-trips through parseWebhook', async () => {
    const { gw } = gateway();
    for (const type of ['payment.succeeded', 'payment.failed', 'refund.processed'] as const) {
      const sim = await gw.simulateWebhook!({ type, orderRef: 'ord_1', amount: 149900, currency: 'INR', refundRef: 'rf_1', providerOrderId: 'cks_123' });
      const e = await gw.parseWebhook({ headers: sim.headers, rawBody: sim.rawBody });
      expect(e.type).toBe(type);
      expect(e.orderRef).toBe('ord_1');
      // Payment events carry the session, so the generated handler's session check accepts them.
      if (type !== 'refund.processed') expect(e).toMatchObject({ providerOrderId: 'cks_123', currency: 'INR', amount: 149900 });
    }
  });
});

describe('dodo customers, subscriptions, payouts', () => {
  it('creates a customer (name and email required)', async () => {
    const { gw, requests } = gateway([{ match: `POST ${API}/customers`, body: { customer_id: 'cus_1' } }]);
    expect(await gw.createCustomer!({ name: 'Asha', email: 'a@example.com', phone: '+919876543210' })).toMatchObject({ providerCustomerId: 'cus_1' });
    expect(JSON.parse(requests[0]!.body!)).toEqual({ name: 'Asha', email: 'a@example.com', phone_number: '+919876543210' });
    await expect(gw.createCustomer!({ email: 'a@example.com' })).rejects.toThrow(/name and email/);
  });

  it('subscriptions: checkout for a recurring product, refusing one-time products and plan creation', async () => {
    const rec = { match: `GET ${API}/products/pdt_sub`, body: { product_id: 'pdt_sub', price: { type: 'recurring_price', currency: 'INR', price: 49900 } } };
    const { gw, requests } = gateway([rec, SESSION]);
    const s = await gw.createSubscription!({ subscriptionRef: 'sub_ref_1', providerPlanId: 'pdt_sub', customer: { email: 'a@example.com' }, returnUrl: 'https://x.example/return' });
    expect(s).toMatchObject({ providerSubscriptionId: 'cks_123', status: 'pending_authorization', checkout: { type: 'redirect' } });
    expect(JSON.parse(requests[1]!.body!)).toMatchObject({ product_cart: [{ product_id: 'pdt_sub', quantity: 1 }], metadata: { subscription_ref: 'sub_ref_1' } });
    await expect(gateway([product({})]).gw.createSubscription!({ subscriptionRef: 's', providerPlanId: 'pdt_fixed' })).rejects.toThrow(/not a recurring one/);
    await expect(gateway().gw.createSubscription!({ subscriptionRef: 's', plan: { name: 'x', amount: 1, interval: 'month' } })).rejects.toThrow(/providerPlanId/);
    const mock = new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' }, logger: silentLogger });
    await expect(mock.createSubscription('dodo', { subscriptionRef: 's', plan: { name: 'x', amount: 1, interval: 'month' } })).rejects.toThrow(/providerPlanId/);
  });

  it('cancels with PATCH (now or at period end); a checkout session is not cancellable', async () => {
    const { gw, requests } = gateway([{ match: `PATCH ${API}/subscriptions/sub_1`, body: { subscription_id: 'sub_1', status: 'cancelled' } }]);
    expect(await gw.cancelSubscription!({ providerSubscriptionId: 'sub_1' })).toMatchObject({ status: 'cancelled' });
    expect(JSON.parse(requests[0]!.body!)).toEqual({ status: 'cancelled', cancel_reason: 'cancelled_by_merchant' });
    await gw.cancelSubscription!({ providerSubscriptionId: 'sub_1', atCycleEnd: true });
    expect(JSON.parse(requests[1]!.body!)).toEqual({ cancel_at_next_billing_date: true });
    await expect(gw.cancelSubscription!({ providerSubscriptionId: 'cks_123' })).rejects.toThrow(/checkout session/);
  });

  it('lists payouts as settlements', async () => {
    const { gw, requests } = gateway([{ match: `GET ${API}/payouts`, body: { items: [{ payout_id: 'po_1', amount: 50000, currency: 'USD', status: 'success', fee: 500, tax: 0, updated_at: '2026-10-18T00:00:00Z' }] } }]);
    const r = await gw.listSettlements!({ from: '2026-10-01', to: '2026-10-28' });
    expect(r.items).toEqual([{ id: 'po_1', amount: 50000, currency: 'USD', status: 'success', settledAt: '2026-10-18T00:00:00Z', fees: 500, tax: 0 }]);
    expect(requests[0]!.url).toContain('created_at_gte=2026-10-01T00%3A00%3A00.000Z');
  });
});

describe('dodo through PaymentsClient (mock and guards)', () => {
  it('mock mode needs a product id like the real adapter, then runs the lifecycle', async () => {
    const mock = new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' }, logger: silentLogger });
    await expect(mock.createPayment('dodo', { orderRef: 'ord_m_1', amount: 149900, currency: 'INR' })).rejects.toThrow(/DODO_PAYMENTS_DEFAULT_PRODUCT_ID/);
    const created = await mock.createPayment('dodo', { orderRef: 'ord_m_1', amount: 149900, currency: 'INR', providerOptions: { productId: 'pdt_x' } });
    expect(created.checkout.type).toBe('manual');
    await mock.mockGateway('dodo').complete('ord_m_1', 'success');
    expect(await mock.verifyPayment('dodo', { orderRef: 'ord_m_1', expectedAmount: 149900, payload: {} })).toMatchObject({ valid: false, paid: false });
    expect(await mock.verifyPayment('dodo', { orderRef: 'ord_m_1', expectedAmount: 149900, providerOrderId: created.providerOrderId, payload: {} })).toMatchObject({ paid: true });
    await expect(mock.getPaymentStatus('dodo', { orderRef: 'ord_m_1' })).rejects.toThrow(/providerOrderId or providerPaymentId/);
  });

  it('providerOptions cannot change the cart, customer, currency, discounts or charge a saved method', async () => {
    const c = new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' }, logger: silentLogger });
    for (const k of ['product_cart', 'billing_currency', 'discount_codes', 'confirm', 'payment_method_id', 'customer', 'feature_flags']) {
      await expect(c.createPayment('dodo', { orderRef: 'ord_p_1', amount: 1, currency: 'USD', providerOptions: { productId: 'p', [k]: 'x' } })).rejects.toThrow(/protected dodo fields/);
    }
  });
});

describe('dodo review fixes (docs/research/verification/dodo-review.md, dodo-doc-verification.md)', () => {
  const PAY: FakeRoute = { match: `GET ${API}/payments/pay_1`, body: payment() };
  const CKS: FakeRoute = { match: `GET ${API}/checkouts/cks_123`, body: { id: 'cks_123', payment_id: 'pay_1', payment_status: 'succeeded' } };

  it('H1: a payment carrying our order_ref but from another session (or none) is never valid; verify needs the session', async () => {
    const forged = payment({ checkout_session_id: null, currency: 'VND' });
    expect(await gateway([{ ...PAY, body: forged }]).gw.verifyPayment({ orderRef: 'ord_1', expectedAmount: 149900, payload: { payment_id: 'pay_1' } })).toMatchObject({ valid: false });
    const other = gateway([{ match: `GET ${API}/checkouts/cks_123`, body: { id: 'cks_123', payment_id: 'pay_1' } }, { ...PAY, body: payment({ checkout_session_id: 'cks_EVIL' }) }]);
    const v = await other.gw.verifyPayment({ orderRef: 'ord_1', expectedAmount: 149900, providerOrderId: 'cks_123', payload: { payment_id: 'pay_1' } });
    expect(v).toMatchObject({ valid: false });
    expect(v.reason).toMatch(/belongs to session cks_EVIL/);
    const c = new PaymentsClient({ env: { PAYMENTS_MODE: 'sandbox', DODO_PAYMENTS_API_KEY: 'dodo_test_k' }, logger: silentLogger, fetch: fakeFetch([PAY]).fetch });
    expect(await c.verifyPayment('dodo', { orderRef: 'ord_1', expectedAmount: 149900, payload: { payment_id: 'pay_1' } })).toMatchObject({ valid: false, paid: false });
  });

  it('H1: currency must be the order currency (same number in another currency is not paid)', async () => {
    const v = await gateway([CKS, { ...PAY, body: payment({ currency: 'VND' }) }]).gw.verifyPayment({ orderRef: 'ord_1', expectedAmount: 149900, providerOrderId: 'cks_123', payload: { payment_id: 'pay_1' } });
    expect(v).toMatchObject({ valid: false });
    expect(v.reason).toMatch(/Currency mismatch/);
    expect((await gateway([{ ...PAY, body: payment({ currency: 'VND' }) }]).gw.getPaymentStatus({ orderRef: 'ord_1', providerPaymentId: 'pay_1' })).status).toBe('unknown');
    const raw = JSON.stringify({ type: 'payment.succeeded', data: { payment_id: 'pay_1', status: 'succeeded', total_amount: 149900, currency: 'VND', metadata: { order_ref: 'ord_1', expected_currency: 'INR' } } });
    expect((await gateway().gw.parseWebhook({ headers: signed(raw), rawBody: raw })).status).toBe('unknown');
  });

  it('H1: generated Dodo webhook handler ignores events for another session or currency', async () => {
    const { generateIntegration } = await import('../../src/codegen/index.js');
    const svc = generateIntegration({ provider: 'dodo', framework: 'express' }).files.find((f) => f.path.endsWith('service.ts'))!.contents;
    expect(svc).toContain('event.providerOrderId !== attempt.providerOrderId');
    expect(svc).toContain('event.providerPaymentId !== attempt.providerPaymentId');
    expect(svc).toContain('providerOrderId: attempt.providerOrderId });');
  });

  it('M1: providerOptions cannot redirect the customer or change what the payment page asks', async () => {
    const c = new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' }, logger: silentLogger });
    for (const k of ['return_url', 'custom_fields', 'customization', 'product_collection_id', 'billing_address', 'tax_id']) {
      await expect(c.createPayment('dodo', { orderRef: 'ord_p_2', amount: 1, currency: 'USD', providerOptions: { productId: 'p', [k]: 'x' } })).rejects.toThrow(/protected dodo fields/);
    }
  });

  it('M2: partial refunds of payments where Dodo added tax on top are refused; full ones go through', async () => {
    const taxed: FakeRoute = { ...PAY, body: payment({ total_amount: 176882, tax: 26982 }) };
    const { gw, requests } = gateway([taxed]);
    await expect(gw.refund!({ orderRef: 'ord_1', providerPaymentId: 'pay_1', refundRef: 'rf_1', amount: 149899 })).rejects.toThrow(/partial refunds of such payments/);
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('M3: a full refund of a taxed payment reports the price, so a retry is not a conflict', async () => {
    const taxed = payment({ total_amount: 176882, tax: 26982, refunds: [{ refund_id: 'rfn_t', status: 'pending', amount: 176882 }] });
    const { gw } = gateway([{ ...PAY, body: taxed }, { match: `GET ${API}/refunds/rfn_t`, body: { refund_id: 'rfn_t', payment_id: 'pay_1', status: 'pending', amount: 176882, metadata: { refund_ref: 'rf_t' } } }]);
    expect(await gw.refund!({ orderRef: 'ord_1', providerPaymentId: 'pay_1', refundRef: 'rf_t', amount: 149900 })).toMatchObject({ providerRefundId: 'rfn_t', amount: 149900 });
    expect(await gw.getRefundStatus!({ refundRef: 'rf_t', providerPaymentId: 'pay_1' })).toMatchObject({ amount: 149900 });
  });

  it('M4: payments without our order_ref are neither reported as ours nor refunded', async () => {
    const foreign: FakeRoute = { ...PAY, body: payment({ metadata: {} }) };
    await expect(gateway([foreign]).gw.getPaymentStatus({ orderRef: 'ord_1', providerPaymentId: 'pay_1' })).rejects.toThrow(/not created by this library/);
    await expect(gateway([foreign]).gw.refund!({ orderRef: 'ord_1', providerPaymentId: 'pay_1', refundRef: 'rf_1' })).rejects.toThrow(/not created by this library/);
  });

  it('L1: a webhook key too short to be a secret is refused', () => {
    expect(() => gateway([], { apiKey: 'dodo_test_k', webhookKey: 'whsec_' })).toThrow(/too short/);
    expect(() => gateway([], { apiKey: 'dodo_test_k', webhookKey: 'whsec_ab' })).toThrow(/too short/);
  });

  it('L3: payouts request a full page and reject bad dates', async () => {
    const { gw, requests } = gateway([{ match: `GET ${API}/payouts`, body: { items: [] } }]);
    await gw.listSettlements!({ count: 500 });
    expect(requests[0]!.url).toContain('page_size=100');
    await expect(gw.listSettlements!({ from: 'yesterday' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('doc check: deprecated discount, purchasing power parity and localized prices are refused', async () => {
    for (const [p, extra, msg] of [
      [{ discount: 10 }, {}, /10% discount/],
      [{ purchasing_power_parity: true }, {}, /purchasing power parity/],
      [{}, { pricing_mode: 'by_country' }, /localized prices/],
    ] as const) {
      const route = product(p);
      const { gw } = gateway([{ ...route, body: { ...route.body, ...extra } }]);
      await expect(gw.createPayment({ orderRef: 'ord_1', amount: 149900, currency: 'INR', providerOptions: { productId: 'pdt_fixed' } })).rejects.toThrow(msg);
    }
  });

  it('doc check: metadata values must be strings, numbers or booleans', async () => {
    const { gw } = gateway([product({})]);
    await expect(gw.createPayment({ orderRef: 'ord_1', amount: 149900, currency: 'INR', metadata: { x: null as unknown as string }, providerOptions: { productId: 'pdt_fixed' } })).rejects.toThrow(/strings, numbers or booleans/);
  });
});
