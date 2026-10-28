import { describe, expect, it } from 'vitest';
import { PaymentError } from '../../src/core/errors.js';
import {
  mapStripePaymentIntentStatus,
  mapStripeSessionStatus,
  parseStripeSignatureHeader,
  stripe,
  stripeWebhookSignature,
} from '../../src/providers/stripe/adapter.js';
import { encodeStripeForm } from '../../src/providers/stripe/form.js';
import { fakeFetch, testContext } from '../helpers.js';

const creds = { secretKey: 'sk_test_abc123', publishableKey: 'pk_test_pub456', webhookSecret: 'whsec_test' };
// testContext's clock: 2026-10-28T10:00:00Z
const NOW = Math.floor(Date.parse('2026-10-28T10:00:00.000Z') / 1000);

function gateway(routes: Parameters<typeof fakeFetch>[0] = [], c: typeof creds | { secretKey: string } = creds) {
  const f = fakeFetch(routes);
  return { gw: stripe.create(c, testContext('stripe', f.fetch, { extractError: stripe.extractError })), ...f };
}

function form(body: string | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body ?? ''));
}

function signed(rawBody: string, t = NOW, secret = creds.webhookSecret) {
  return { 'Stripe-Signature': `t=${t},v1=${stripeWebhookSignature(t, rawBody, secret)}` };
}

describe('stripe form encoder', () => {
  it('encodes nested objects, arrays, booleans and skips null/undefined', () => {
    const p = encodeStripeForm({
      mode: 'payment',
      line_items: [{ price_data: { currency: 'inr', unit_amount: 49900, product_data: { name: 'T-shirt' } }, quantity: 1 }],
      automatic_payment_methods: { enabled: true },
      expand: ['payment_intent', 'customer'],
      customer_email: undefined,
      description: null,
      metadata: { order_ref: 'A1', empty: '' },
    });
    expect([...p]).toEqual([
      ['mode', 'payment'],
      ['line_items[0][price_data][currency]', 'inr'],
      ['line_items[0][price_data][unit_amount]', '49900'],
      ['line_items[0][price_data][product_data][name]', 'T-shirt'],
      ['line_items[0][quantity]', '1'],
      ['automatic_payment_methods[enabled]', 'true'],
      ['expand[0]', 'payment_intent'],
      ['expand[1]', 'customer'],
      ['metadata[order_ref]', 'A1'],
      ['metadata[empty]', ''],
    ]);
    expect(p.toString()).toContain('line_items%5B0%5D%5Bquantity%5D=1');
  });
});

describe('stripe', () => {
  it('rejects missing keys and test/live mismatches', () => {
    const f = fakeFetch([]);
    expect(() => stripe.create({}, testContext('stripe', f.fetch))).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => stripe.create({ secretKey: 'sk_test_x' }, testContext('stripe', f.fetch, { environment: 'live' }))).toThrow(PaymentError);
    expect(() => stripe.create({ secretKey: 'sk_live_x' }, testContext('stripe', f.fetch))).toThrow(/live key/);
    expect(() => stripe.create({ secretKey: 'rk_live_x' }, testContext('stripe', f.fetch))).toThrow(/live key/);
    expect(() => stripe.create({ secretKey: 'pk_test_x' }, testContext('stripe', f.fetch))).toThrow(/must start with/);
    expect(() => stripe.create({ secretKey: 'sk_live_x', publishableKey: 'pk_test_y' }, testContext('stripe', f.fetch, { environment: 'live' }))).toThrow(/PUBLISHABLE/);
    expect(stripe.create({ secretKey: 'rk_test_x' }, testContext('stripe', f.fetch)).id).toBe('stripe');
    expect(stripe.create({ secretKey: 'sk_live_x' }, testContext('stripe', f.fetch, { environment: 'live' })).environment).toBe('live');
  });

  it('creates a Checkout Session with the expected form body and Idempotency-Key', async () => {
    const { gw, requests } = gateway([
      {
        match: 'POST https://api.stripe.com/v1/checkout/sessions',
        body: { id: 'cs_test_1', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_1', status: 'open', payment_status: 'unpaid', amount_total: 49900, currency: 'inr', mode: 'payment', client_reference_id: 'ord_1', expires_at: NOW + 86400 },
      },
    ]);
    const res = await gw.createPayment({
      orderRef: 'ord_1',
      amount: 49900,
      description: 'Design consulting',
      returnUrl: 'https://shop.example/return?x=1',
      customer: { email: 'a@b.com', name: 'Asha' },
      metadata: { plan: 'pro' },
      providerOptions: { metadata: { extra: 'y' } },
    });
    expect(res).toMatchObject({ providerOrderId: 'cs_test_1', status: 'created', amount: 49900, currency: 'INR' });
    expect(res.checkout).toEqual({ type: 'redirect', url: 'https://checkout.stripe.com/c/pay/cs_test_1', method: 'GET' });
    expect(res.expiresAt).toBe(new Date((NOW + 86400) * 1000).toISOString());

    const r = requests[0]!;
    expect(r.headers.authorization).toBe('Bearer sk_test_abc123');
    expect(r.headers['idempotency-key']).toBe('checkout_session:ord_1');
    expect(r.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(r.headers['stripe-version']).toBeTruthy();
    expect(form(r.body)).toEqual({
      mode: 'payment',
      'line_items[0][price_data][currency]': 'inr',
      'line_items[0][price_data][unit_amount]': '49900',
      'line_items[0][price_data][product_data][name]': 'Design consulting',
      'line_items[0][quantity]': '1',
      success_url: 'https://shop.example/return?x=1&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://shop.example/return?x=1',
      client_reference_id: 'ord_1',
      customer_email: 'a@b.com',
      billing_address_collection: 'required',
      'metadata[order_ref]': 'ord_1',
      'metadata[plan]': 'pro',
      'metadata[extra]': 'y',
      'payment_intent_data[description]': 'Design consulting',
      'payment_intent_data[metadata][order_ref]': 'ord_1',
    });
  });

  it('uses the caller idempotencyKey and requires returnUrl for Checkout', async () => {
    const { gw, requests } = gateway([
      { match: 'POST https://api.stripe.com/v1/checkout/sessions', body: { id: 'cs_2', url: 'https://checkout.stripe.com/x', status: 'open', amount_total: 100, currency: 'inr' } },
    ]);
    await gw.createPayment({ orderRef: 'ord_2', amount: 100, returnUrl: 'https://s.example/r', idempotencyKey: 'idem-1' });
    expect(requests[0]!.headers['idempotency-key']).toBe('idem-1');
    expect(form(requests[0]!.body).success_url).toBe('https://s.example/r?session_id={CHECKOUT_SESSION_ID}');
    await expect(gw.createPayment({ orderRef: 'ord_3', amount: 100 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.createPayment({ orderRef: 'ord_3', amount: 4.99, returnUrl: 'https://s.example/r' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it("payment_intent flow returns a Stripe.js action and needs the publishable key", async () => {
    const { gw, requests } = gateway([
      { match: 'POST https://api.stripe.com/v1/payment_intents', body: { id: 'pi_1', object: 'payment_intent', amount: 1000, currency: 'usd', status: 'requires_payment_method', client_secret: 'pi_1_secret_abc' } },
    ]);
    const res = await gw.createPayment({
      orderRef: 'ord_pi',
      amount: 1000,
      currency: 'USD',
      description: 'SaaS export',
      customer: { name: 'John Doe' },
      billingAddress: { line1: '1 Main St', city: 'Austin', country: 'US', postalCode: '73301' },
      providerOptions: { flow: 'payment_intent' },
    });
    expect(res.providerOrderId).toBe('pi_1');
    expect(res.status).toBe('created');
    expect(res.checkout.type).toBe('js_sdk');
    if (res.checkout.type === 'js_sdk') {
      expect(res.checkout.sdk).toBe('stripe');
      expect(res.checkout.scriptUrl).toBe('https://js.stripe.com/v3/');
      expect(res.checkout.options).toMatchObject({ publishableKey: 'pk_test_pub456', clientSecret: 'pi_1_secret_abc', billingDetails: { name: 'John Doe', address: { postal_code: '73301' } } });
      expect(JSON.stringify(res.checkout.options)).not.toContain('sk_test');
    }
    const sent = form(requests[0]!.body);
    expect(sent).toMatchObject({ amount: '1000', currency: 'usd', 'automatic_payment_methods[enabled]': 'true', description: 'SaaS export', 'metadata[order_ref]': 'ord_pi' });
    expect(sent.flow).toBeUndefined();
    expect(requests[0]!.headers['idempotency-key']).toBe('payment_intent:ord_pi');

    const noPk = gateway([], { secretKey: 'sk_test_abc123' }).gw;
    await expect(noPk.createPayment({ orderRef: 'o', amount: 100, providerOptions: { flow: 'payment_intent' } })).rejects.toMatchObject({ code: 'CONFIG_MISSING' });
  });

  it('maps Stripe API errors via extractError', async () => {
    const { gw } = gateway([
      { match: 'POST https://api.stripe.com/v1/checkout/sessions', status: 400, body: { error: { type: 'invalid_request_error', code: 'amount_too_small', message: 'Amount must be at least ₹0.50 inr' } } },
    ]);
    await expect(gw.createPayment({ orderRef: 'o', amount: 1, returnUrl: 'https://s.example/r' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      providerCode: 'amount_too_small',
    });
  });

  it('verifies the redirect by fetching the Session (status_api) and binds orderRef + amount', async () => {
    const session = {
      id: 'cs_9', object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 1000, currency: 'inr', client_reference_id: 'ord_9',
      payment_intent: { id: 'pi_9', object: 'payment_intent', amount: 1000, currency: 'inr', status: 'succeeded', latest_charge: { id: 'ch_9', amount: 1000, amount_refunded: 0 } },
    };
    const { gw, requests } = gateway([{ match: 'GET https://api.stripe.com/v1/checkout/sessions/cs_9', body: session }]);
    const good = await gw.verifyPayment({ orderRef: 'ord_9', expectedAmount: 1000, payload: { session_id: 'cs_9' } });
    expect(good).toMatchObject({ valid: true, status: 'captured', verifiedVia: 'status_api', providerPaymentId: 'pi_9', orderRef: 'ord_9' });
    expect(requests[0]!.url).toContain('expand%5B%5D=payment_intent');
    expect(requests[0]!.headers['idempotency-key']).toBeUndefined();

    expect((await gw.verifyPayment({ orderRef: 'ord_other', payload: { session_id: 'cs_9' } })).valid).toBe(false);
    expect((await gw.verifyPayment({ orderRef: 'ord_9', expectedAmount: 999, payload: { session_id: 'cs_9' } })).valid).toBe(false);
    expect((await gw.verifyPayment({ payload: {} })).valid).toBe(false);
  });

  it('reports an unpaid session as genuine but not captured', async () => {
    const { gw } = gateway([
      { match: '/checkout/sessions/cs_open', body: { id: 'cs_open', mode: 'payment', status: 'open', payment_status: 'unpaid', amount_total: 1000, currency: 'inr', client_reference_id: 'o', payment_intent: null } },
    ]);
    const res = await gw.verifyPayment({ orderRef: 'o', expectedAmount: 1000, payload: { session_id: 'cs_open' } });
    expect(res).toMatchObject({ valid: true, status: 'created' });
  });

  it('maps PaymentIntent and Session statuses', () => {
    expect(mapStripePaymentIntentStatus({ status: 'requires_payment_method' })).toBe('created');
    expect(mapStripePaymentIntentStatus({ status: 'requires_payment_method', last_payment_error: { message: 'declined' } })).toBe('failed');
    expect(mapStripePaymentIntentStatus({ status: 'requires_action' })).toBe('pending');
    expect(mapStripePaymentIntentStatus({ status: 'processing' })).toBe('pending');
    expect(mapStripePaymentIntentStatus({ status: 'requires_capture' })).toBe('authorized');
    expect(mapStripePaymentIntentStatus({ status: 'succeeded' })).toBe('captured');
    expect(mapStripePaymentIntentStatus({ status: 'succeeded' }, { amount: 1000, amount_refunded: 400 })).toBe('partially_refunded');
    expect(mapStripePaymentIntentStatus({ status: 'succeeded' }, { amount: 1000, amount_refunded: 1000 })).toBe('refunded');
    expect(mapStripePaymentIntentStatus({ status: 'canceled' })).toBe('cancelled');
    expect(mapStripeSessionStatus({ status: 'open', payment_status: 'unpaid', payment_intent: null })).toBe('created');
    expect(mapStripeSessionStatus({ status: 'expired', payment_status: 'unpaid', payment_intent: null })).toBe('expired');
    expect(mapStripeSessionStatus({ status: 'complete', payment_status: 'paid', payment_intent: 'pi_x' })).toBe('captured');
    expect(mapStripeSessionStatus({ status: 'complete', payment_status: 'unpaid', payment_intent: null })).toBe('pending');
  });

  it('getPaymentStatus reads a PaymentIntent with its latest charge', async () => {
    const { gw, requests } = gateway([
      {
        match: 'GET https://api.stripe.com/v1/payment_intents/pi_5',
        body: { id: 'pi_5', object: 'payment_intent', amount: 5000, currency: 'inr', status: 'succeeded', metadata: { order_ref: 'ord_5' }, latest_charge: { id: 'ch_5', amount: 5000, amount_refunded: 2000, payment_method_details: { type: 'upi' } } },
      },
    ]);
    const st = await gw.getPaymentStatus({ orderRef: 'ord_5', providerOrderId: 'pi_5' });
    expect(st).toMatchObject({ status: 'partially_refunded', orderRef: 'ord_5', providerPaymentId: 'pi_5', amount: 5000, amountRefunded: 2000, currency: 'INR', method: 'upi' });
    expect(requests[0]!.url).toContain('expand%5B%5D=latest_charge');
    await expect(gw.getPaymentStatus({ orderRef: 'ord_5' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.getPaymentStatus({ orderRef: 'ord_5', providerOrderId: 'order_5' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refunds with refundRef as Idempotency-Key and a Stripe-legal reason', async () => {
    const { gw, requests } = gateway([
      { match: 'POST https://api.stripe.com/v1/refunds', body: { id: 're_1', amount: 300, status: 'pending', payment_intent: 'pi_1', metadata: { refund_ref: 'rf_1' } } },
      { match: 'GET https://api.stripe.com/v1/refunds/re_1', body: { id: 're_1', amount: 300, status: 'succeeded', metadata: { refund_ref: 'rf_1' } } },
      { match: 'GET https://api.stripe.com/v1/refunds?', body: { data: [{ id: 're_0', amount: 1, status: 'failed', metadata: { refund_ref: 'other' } }, { id: 're_1', amount: 300, status: 'canceled', metadata: { refund_ref: 'rf_1' } }] } },
    ]);
    const r = await gw.refund!({ orderRef: 'ord_1', providerPaymentId: 'pi_1', amount: 300, refundRef: 'rf_1', reason: 'Requested_By_Customer' });
    expect(r).toMatchObject({ providerRefundId: 're_1', status: 'pending', amount: 300 });
    expect(requests[0]!.headers['idempotency-key']).toBe('rf_1');
    expect(form(requests[0]!.body)).toEqual({
      payment_intent: 'pi_1',
      amount: '300',
      reason: 'requested_by_customer',
      'metadata[refund_ref]': 'rf_1',
      'metadata[order_ref]': 'ord_1',
    });

    await gw.refund!({ orderRef: 'ord_1', providerPaymentId: 'pi_1', refundRef: 'rf_2', reason: 'customer changed mind' });
    const second = form(requests[1]!.body);
    expect(second.reason).toBeUndefined();
    expect(second['metadata[reason]']).toBe('customer changed mind');
    expect(second.amount).toBeUndefined();

    await expect(gw.refund!({ orderRef: 'o', refundRef: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' });

    expect((await gw.getRefundStatus!({ refundRef: 'rf_1', providerRefundId: 're_1' })).status).toBe('processed');
    const byRef = await gw.getRefundStatus!({ refundRef: 'rf_1', providerPaymentId: 'pi_1' });
    expect(byRef).toMatchObject({ providerRefundId: 're_1', status: 'failed' });
  });

  it('webhook signature matches the documented HMAC(t.body) known-answer vector', () => {
    // printf '1700000000.{"id":"evt_1"}' | openssl dgst -sha256 -hmac whsec_test
    expect(stripeWebhookSignature(1700000000, '{"id":"evt_1"}', 'whsec_test')).toBe('c89214b5b5da833daed6f0b8c5bb6bd58cea9022bd80ccc78230f3942d632925');
    expect(parseStripeSignatureHeader('t=1,v1=a,v0=z,v1=b')).toEqual({ timestamp: 1, v1: ['a', 'b'] });
  });

  it('accepts a valid webhook and rejects tampered / expired / unsigned ones', async () => {
    const { gw } = gateway();
    const rawBody = JSON.stringify({
      id: 'evt_1', object: 'event', type: 'checkout.session.completed', created: NOW,
      data: { object: { id: 'cs_1', object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 49900, currency: 'inr', client_reference_id: 'ord_1', payment_intent: 'pi_1' } },
    });
    const ev = await gw.parseWebhook({ headers: signed(rawBody), rawBody });
    expect(ev).toMatchObject({ id: 'evt_1', type: 'payment.succeeded', orderRef: 'ord_1', providerOrderId: 'cs_1', providerPaymentId: 'pi_1', status: 'captured', amount: 49900, currency: 'INR' });

    await expect(gw.parseWebhook({ headers: signed(rawBody), rawBody: rawBody.replace('49900', '100') })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(gw.parseWebhook({ headers: signed(rawBody, NOW, 'whsec_wrong'), rawBody })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(gw.parseWebhook({ headers: signed(rawBody, NOW - 301), rawBody })).rejects.toThrow(/tolerance/);
    await expect(gw.parseWebhook({ headers: {}, rawBody })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    // Within tolerance is fine.
    expect((await gw.parseWebhook({ headers: signed(rawBody, NOW - 299), rawBody })).id).toBe('evt_1');
  });

  it('accepts any of several v1 signatures (secret rolling)', async () => {
    const { gw } = gateway();
    const rawBody = JSON.stringify({ id: 'evt_2', type: 'payment_intent.payment_failed', created: NOW, data: { object: { id: 'pi_2', amount: 100, currency: 'inr', status: 'requires_payment_method', metadata: { order_ref: 'ord_2' }, last_payment_error: { message: 'declined' } } } });
    const good = stripeWebhookSignature(NOW, rawBody, creds.webhookSecret);
    const old = stripeWebhookSignature(NOW, rawBody, 'whsec_old');
    const ev = await gw.parseWebhook({ headers: { 'stripe-signature': `t=${NOW},v1=${old},v1=${good},v0=deadbeef` }, rawBody });
    expect(ev).toMatchObject({ type: 'payment.failed', status: 'failed', orderRef: 'ord_2', providerPaymentId: 'pi_2' });
    await expect(gw.parseWebhook({ headers: { 'stripe-signature': `t=${NOW},v1=${old},v0=${good}` }, rawBody })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('normalises refund, dispute, subscription and invoice events', async () => {
    const { gw } = gateway();
    const parse = async (type: string, object: Record<string, unknown>, previous_attributes?: Record<string, unknown>) => {
      const rawBody = JSON.stringify({ id: `evt_${type}`, type, created: NOW, data: { object, previous_attributes } });
      return gw.parseWebhook({ headers: signed(rawBody), rawBody });
    };
    expect(await parse('refund.updated', { id: 're_1', amount: 300, currency: 'inr', status: 'succeeded', payment_intent: 'pi_1', metadata: { refund_ref: 'rf_1', order_ref: 'o1' } }))
      .toMatchObject({ type: 'refund.processed', providerRefundId: 're_1', refundRef: 'rf_1', orderRef: 'o1', providerPaymentId: 'pi_1' });
    expect((await parse('refund.updated', { id: 're_2', amount: 1, status: 'failed', metadata: {} })).type).toBe('refund.failed');
    expect(await parse('charge.refunded', { id: 'ch_1', amount: 1000, amount_refunded: 400, payment_intent: 'pi_1', currency: 'inr' }))
      .toMatchObject({ type: 'refund.processed', status: 'partially_refunded', amount: 400 });
    expect((await parse('charge.dispute.created', { id: 'dp_1', amount: 1000, charge: 'ch_1', payment_intent: 'pi_1' })).type).toBe('dispute.created');
    expect((await parse('customer.subscription.deleted', { id: 'sub_1', status: 'canceled', metadata: { subscription_ref: 's1' } }))).toMatchObject({ type: 'subscription.cancelled', orderRef: 's1' });
    expect((await parse('customer.subscription.updated', { id: 'sub_1', status: 'past_due' }, { status: 'active' })).type).toBe('subscription.halted');
    expect((await parse('customer.subscription.updated', { id: 'sub_1', status: 'active' }, { metadata: {} })).type).toBe('unknown');
    expect((await parse('customer.subscription.created', { id: 'sub_1', status: 'active' })).type).toBe('subscription.activated');
    expect(await parse('invoice.paid', { id: 'in_1', amount_paid: 9900, currency: 'inr', parent: { subscription_details: { subscription: 'sub_1', metadata: { subscription_ref: 's1' } } } }))
      .toMatchObject({ type: 'subscription.charged', providerOrderId: 'sub_1', orderRef: 's1', amount: 9900 });
    expect((await parse('invoice.paid', { id: 'in_2', amount_paid: 1, subscription: 'sub_2' })).providerOrderId).toBe('sub_2');
    expect((await parse('checkout.session.async_payment_failed', { id: 'cs_1', mode: 'payment', status: 'complete', payment_status: 'unpaid' })).type).toBe('payment.failed');
    expect((await parse('checkout.session.completed', { id: 'cs_s', mode: 'subscription', status: 'complete', payment_status: 'paid' })).type).toBe('unknown');
    expect((await parse('some.new.event', { id: 'x' })).type).toBe('unknown');
  });

  it('simulateWebhook round-trips through parseWebhook', async () => {
    const { gw } = gateway();
    for (const type of ['payment.succeeded', 'payment.failed', 'refund.processed'] as const) {
      const sim = await gw.simulateWebhook!({ type, orderRef: 'ord_sim', amount: 2500, refundRef: 'rf_sim' });
      expect(sim.headers['stripe-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      const ev = await gw.parseWebhook({ headers: sim.headers, rawBody: sim.rawBody });
      expect(ev.type).toBe(type);
      expect(ev.orderRef).toBe('ord_sim');
      expect(ev.amount).toBe(2500);
      if (type === 'refund.processed') expect(ev.refundRef).toBe('rf_sim');
    }
  });

  it('creates subscription Checkout Sessions and cancels subscriptions', async () => {
    const { gw, requests } = gateway([
      { match: 'POST https://api.stripe.com/v1/checkout/sessions', body: { id: 'cs_sub', url: 'https://checkout.stripe.com/s', mode: 'subscription', status: 'open', subscription: null } },
      { match: 'DELETE https://api.stripe.com/v1/subscriptions/sub_1', body: { id: 'sub_1', status: 'canceled', metadata: { subscription_ref: 's1' } } },
      { match: 'POST https://api.stripe.com/v1/subscriptions/sub_2', body: { id: 'sub_2', status: 'active', cancel_at_period_end: true, metadata: {} } },
    ]);
    const sub = await gw.createSubscription!({
      subscriptionRef: 's1',
      plan: { name: 'Pro', amount: 99900, interval: 'month' },
      returnUrl: 'https://s.example/r',
      customer: { email: 'a@b.com' },
    });
    expect(sub).toMatchObject({ providerSubscriptionId: 'cs_sub', status: 'pending_authorization', checkout: { type: 'redirect', url: 'https://checkout.stripe.com/s' } });
    expect(form(requests[0]!.body)).toMatchObject({
      mode: 'subscription',
      'line_items[0][price_data][recurring][interval]': 'month',
      'line_items[0][price_data][recurring][interval_count]': '1',
      'line_items[0][price_data][unit_amount]': '99900',
      'subscription_data[metadata][subscription_ref]': 's1',
      client_reference_id: 's1',
    });
    expect(requests[0]!.headers['idempotency-key']).toBe('subscription_session:s1');

    expect((await gw.cancelSubscription!({ providerSubscriptionId: 'sub_1' })).status).toBe('cancelled');
    const atEnd = await gw.cancelSubscription!({ providerSubscriptionId: 'sub_2', atCycleEnd: true });
    expect(atEnd.status).toBe('active');
    expect(form(requests[2]!.body)).toEqual({ cancel_at_period_end: 'true' });
  });

  it('createCustomer always sends an Idempotency-Key; listSettlements maps payouts', async () => {
    const { gw, requests } = gateway([
      { match: 'POST https://api.stripe.com/v1/customers', body: { id: 'cus_1' } },
      { match: 'GET https://api.stripe.com/v1/payouts', body: { data: [{ id: 'po_1', amount: 123400, currency: 'inr', status: 'paid', arrival_date: NOW, trace_id: { status: 'supported', value: 'UTR123' } }] } },
    ]);
    expect((await gw.createCustomer!({ name: 'A', email: 'a@b.com' })).providerCustomerId).toBe('cus_1');
    expect(requests[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    const s = await gw.listSettlements!({ from: '2026-10-01', to: '2026-10-28', count: 10 });
    expect(s.items[0]).toMatchObject({ id: 'po_1', amount: 123400, currency: 'INR', status: 'paid', utr: 'UTR123' });
    expect(requests[1]!.url).toContain('limit=10');
    expect(requests[1]!.url).toContain('arrival_date%5Bgte%5D=');
  });

  it('capabilities are blunt about India availability', () => {
    expect(stripe.capabilities.summary).toMatch(/invite-only/);
    expect(stripe.capabilities.features.payouts.support).toBe('not_implemented');
    expect(stripe.capabilities.constraints.join(' ')).toMatch(/15,000/);
  });
});
