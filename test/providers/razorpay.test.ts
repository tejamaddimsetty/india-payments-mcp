import { describe, expect, it } from 'vitest';
import { PaymentError } from '../../src/core/errors.js';
import { razorpay, razorpayPaymentSignature, razorpaySubscriptionSignature, razorpayWebhookSignature } from '../../src/providers/razorpay/adapter.js';
import { fakeFetch, testContext } from '../helpers.js';

const creds = { keyId: 'rzp_test_abc123', keySecret: 'secret_xyz', webhookSecret: 'whsec_test' };

function gateway(routes: Parameters<typeof fakeFetch>[0] = []) {
  const f = fakeFetch(routes);
  return { gw: razorpay.create(creds, testContext('razorpay', f.fetch, { extractError: razorpay.extractError })), ...f };
}

describe('razorpay', () => {
  it('payment signature matches the documented HMAC(order_id|payment_id)', () => {
    // Known-answer vector computed independently with openssl:
    // printf 'order_1|pay_1' | openssl dgst -sha256 -hmac secret_xyz
    expect(razorpayPaymentSignature('order_1', 'pay_1', 'secret_xyz')).toBe('66cde319a89e4717b9bd8ea528286ffcf01a3ad2c5626e3d0bb9a653f1440a05');
  });

  it('creates an order and returns a Checkout.js action', async () => {
    const { gw, requests } = gateway([
      { match: 'POST https://api.razorpay.com/v1/orders', body: { id: 'order_123', amount: 49900, currency: 'INR', receipt: 'ord_1', status: 'created', notes: {} } },
    ]);
    const res = await gw.createPayment({ orderRef: 'ord_1', amount: 49900, currency: 'INR', customer: { email: 'a@b.in' } });
    expect(res.providerOrderId).toBe('order_123');
    expect(res.checkout.type).toBe('js_sdk');
    if (res.checkout.type === 'js_sdk') {
      expect(res.checkout.options.key).toBe('rzp_test_abc123');
      // Checkout `name` is mandatory; falls back when RAZORPAY_MERCHANT_NAME is unset.
      expect(res.checkout.options.name).toBe('Payment');
      expect(JSON.stringify(res.checkout.options)).not.toContain('secret_xyz');
    }
    const sent = JSON.parse(requests[0]!.body!);
    expect(sent).toMatchObject({ amount: 49900, currency: 'INR', receipt: 'ord_1' });
    expect(requests[0]!.headers.authorization).toBe('Basic ' + Buffer.from('rzp_test_abc123:secret_xyz').toString('base64'));
  });

  it('verifies a genuine callback and rejects a tampered one', async () => {
    const { gw } = gateway([
      { match: 'GET https://api.razorpay.com/v1/orders/order_9', body: { id: 'order_9', amount: 1000, currency: 'INR', receipt: 'ord_9', status: 'paid', notes: {} } },
    ]);
    const sig = razorpayPaymentSignature('order_9', 'pay_9', creds.keySecret);
    const good = await gw.verifyPayment({ orderRef: 'ord_9', expectedAmount: 1000, payload: { razorpay_order_id: 'order_9', razorpay_payment_id: 'pay_9', razorpay_signature: sig } });
    expect(good.valid).toBe(true);
    const bad = await gw.verifyPayment({ providerOrderId: 'order_9', payload: { razorpay_order_id: 'order_9', razorpay_payment_id: 'pay_10', razorpay_signature: sig } });
    expect(bad).toMatchObject({ valid: false, reason: 'Signature mismatch' });
    const wrongAmount = await gw.verifyPayment({ orderRef: 'ord_9', expectedAmount: 999, payload: { razorpay_order_id: 'order_9', razorpay_payment_id: 'pay_9', razorpay_signature: sig } });
    expect(wrongAmount.valid).toBe(false);
  });

  it('signs with the server-stored providerOrderId, not the one Checkout returned', async () => {
    const { gw, requests } = gateway();
    const sig = razorpayPaymentSignature('order_9', 'pay_9', creds.keySecret);
    // Stored id alone (no payload order id) is enough.
    expect(await gw.verifyPayment({ providerOrderId: 'order_9', payload: { razorpay_payment_id: 'pay_9', razorpay_signature: sig } }))
      .toMatchObject({ valid: true, providerOrderId: 'order_9', status: 'authorized' });
    // A genuine signature for another order does not verify against the stored id.
    const otherSig = razorpayPaymentSignature('order_other', 'pay_9', creds.keySecret);
    expect((await gw.verifyPayment({ providerOrderId: 'order_9', payload: { razorpay_payment_id: 'pay_9', razorpay_signature: otherSig } })).valid).toBe(false);
    // Payload carrying a different order id is rejected outright.
    expect(await gw.verifyPayment({ providerOrderId: 'order_9', payload: { razorpay_order_id: 'order_other', razorpay_payment_id: 'pay_9', razorpay_signature: otherSig } }))
      .toMatchObject({ valid: false, reason: expect.stringMatching(/not the stored order_9/) });
    // Neither providerOrderId nor orderRef: cannot bind.
    expect(await gw.verifyPayment({ payload: { razorpay_order_id: 'order_9', razorpay_payment_id: 'pay_9', razorpay_signature: sig } }))
      .toMatchObject({ valid: false, reason: expect.stringMatching(/providerOrderId/) });
    // Malformed stored id.
    expect((await gw.verifyPayment({ providerOrderId: 'pay_9', payload: { razorpay_payment_id: 'pay_9', razorpay_signature: sig } })).valid).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('verifies a subscription callback against the stored sub_ id', async () => {
    const { gw } = gateway([
      { match: 'GET https://api.razorpay.com/v1/subscriptions/sub_1', body: { id: 'sub_1', notes: { subscription_ref: 's1' } } },
      { match: 'GET https://api.razorpay.com/v1/payments/pay_1', body: { id: 'pay_1', order_id: null, amount: 500, amount_refunded: 0, currency: 'INR', status: 'captured', method: 'card', refund_status: null, created_at: 1 } },
    ]);
    const sig = razorpaySubscriptionSignature('pay_1', 'sub_1', creds.keySecret);
    expect(await gw.verifyPayment({ providerOrderId: 'sub_1', payload: { razorpay_payment_id: 'pay_1', razorpay_subscription_id: 'sub_1', razorpay_signature: sig } }))
      .toMatchObject({ valid: true, orderRef: 's1', providerOrderId: 'sub_1', status: 'captured' });
    expect((await gw.verifyPayment({ providerOrderId: 'sub_2', payload: { razorpay_payment_id: 'pay_1', razorpay_subscription_id: 'sub_1', razorpay_signature: sig } })).valid).toBe(false);
    expect((await gw.verifyPayment({ providerOrderId: 'order_1', payload: { razorpay_payment_id: 'pay_1', razorpay_subscription_id: 'sub_1', razorpay_signature: sig } })).valid).toBe(false);
  });

  it('creates subscriptions with documented params and rejects daily plans under 7 days', async () => {
    const { gw, requests } = gateway([
      { match: 'POST https://api.razorpay.com/v1/plans', body: { id: 'plan_1' } },
      { match: 'POST https://api.razorpay.com/v1/subscriptions/sub_1/cancel', body: { id: 'sub_1', status: 'active', notes: { subscription_ref: 's1' } } },
      { match: 'POST https://api.razorpay.com/v1/subscriptions', body: { id: 'sub_1', status: 'created' } },
    ]);
    await expect(gw.createSubscription!({ subscriptionRef: 's0', totalCount: 12, plan: { name: 'D', amount: 100, interval: 'day', intervalCount: 6 } }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    expect(requests).toHaveLength(0);
    const sub = await gw.createSubscription!({ subscriptionRef: 's1', totalCount: 12, providerCustomerId: 'cust_1', plan: { name: 'W', amount: 100, interval: 'day', intervalCount: 7 } });
    expect(JSON.parse(requests[0]!.body!)).toMatchObject({ period: 'daily', interval: 7 });
    const body = JSON.parse(requests[1]!.body!);
    expect(body).toMatchObject({ plan_id: 'plan_1', customer_notify: true, notes: { subscription_ref: 's1', customer_id: 'cust_1' } });
    expect(body.customer_id).toBeUndefined();
    if (sub.checkout?.type === 'js_sdk') expect(sub.checkout.options.name).toBe('Payment');
    await gw.cancelSubscription!({ providerSubscriptionId: 'sub_1', atCycleEnd: true });
    expect(JSON.parse(requests[2]!.body!)).toEqual({ cancel_at_cycle_end: true });
  });

  it('uses RAZORPAY_MERCHANT_NAME for the Checkout name', async () => {
    const f = fakeFetch([{ match: 'POST https://api.razorpay.com/v1/orders', body: { id: 'order_1', amount: 100, currency: 'INR', receipt: 'o1', status: 'created', notes: {} } }]);
    const gw = razorpay.create({ ...creds, merchantName: 'Acme Ltd' }, testContext('razorpay', f.fetch));
    const res = await gw.createPayment({ orderRef: 'o1', amount: 100 });
    if (res.checkout.type === 'js_sdk') expect(res.checkout.options.name).toBe('Acme Ltd');
    expect(razorpay.capabilities.credentials.find((c) => c.env === 'RAZORPAY_MERCHANT_NAME')).toMatchObject({ key: 'merchantName', required: false, secret: false });
    expect(razorpay.capabilities.paymentMethods).not.toContain('cardless_emi');
  });

  it('reads subscription, dispute and settlement entities from webhooks', async () => {
    const { gw } = gateway();
    const send = (event: string, payload: Record<string, unknown>) => {
      const rawBody = JSON.stringify({ event, payload, created_at: 1700000000 });
      return gw.parseWebhook({ headers: { 'x-razorpay-signature': razorpayWebhookSignature(rawBody, creds.webhookSecret) }, rawBody });
    };
    expect(await send('subscription.charged', {
      subscription: { entity: { id: 'sub_1', notes: { subscription_ref: 's1' } } },
      payment: { entity: { id: 'pay_1', order_id: 'order_x', amount: 500, amount_refunded: 0, currency: 'INR', status: 'captured' } },
    })).toMatchObject({ type: 'subscription.charged', orderRef: 's1', providerOrderId: 'sub_1', providerPaymentId: 'pay_1', amount: 500 });
    expect(await send('subscription.halted', { subscription: { entity: { id: 'sub_2', notes: { subscription_ref: 's2' } } } }))
      .toMatchObject({ type: 'subscription.halted', orderRef: 's2', providerOrderId: 'sub_2' });
    expect(await send('payment.dispute.created', {
      payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 1000, amount_refunded: 0, currency: 'INR', status: 'captured' } },
      dispute: { entity: { id: 'disp_1', amount: 400, currency: 'INR' } },
    })).toMatchObject({ type: 'dispute.created', amount: 400 });
    expect(await send('settlement.processed', { settlement: { entity: { id: 'setl_1', amount: 9900, utr: 'UTR1' } } }))
      .toMatchObject({ type: 'settlement.processed', amount: 9900, id: 'settlement.processed:setl_1' });
  });

  it('maps order status from the best payment attempt', async () => {
    const { gw } = gateway([
      { match: '/orders/order_5/payments', body: { items: [
        { id: 'pay_a', status: 'failed', amount: 500, amount_refunded: 0, currency: 'INR', method: 'card', created_at: 1 },
        { id: 'pay_b', status: 'captured', amount: 500, amount_refunded: 200, currency: 'INR', method: 'upi', created_at: 2 },
      ] } },
      { match: '/orders/order_5', body: { id: 'order_5', amount: 500, currency: 'INR', receipt: 'ord_5', status: 'paid', notes: {} } },
    ]);
    const st = await gw.getPaymentStatus({ orderRef: 'ord_5', providerOrderId: 'order_5' });
    // captured with 200 of 500 refunded
    expect(st.status).toBe('partially_refunded');
    expect(st.providerPaymentId).toBe('pay_b');
    expect(st.method).toBe('upi');
  });

  it('webhook round trip, and rejects a bad signature', async () => {
    const { gw } = gateway();
    const sim = await gw.simulateWebhook!({ type: 'payment.succeeded', orderRef: 'ord_7', amount: 700 });
    const evt = await gw.parseWebhook({ headers: sim.headers, rawBody: sim.rawBody });
    expect(evt).toMatchObject({ type: 'payment.succeeded', orderRef: 'ord_7', amount: 700, status: 'captured' });
    expect(sim.headers['x-razorpay-signature']).toBe(razorpayWebhookSignature(sim.rawBody, creds.webhookSecret));
    await expect(gw.parseWebhook({ headers: sim.headers, rawBody: sim.rawBody.replace('700', '70000') })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('maps provider errors', async () => {
    const { gw } = gateway([{ match: '/orders', status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'amount must be atleast INR 1.00' } } }]);
    const err = await gw.createPayment({ orderRef: 'ord_x', amount: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentError);
    expect(err).toMatchObject({ code: 'PROVIDER_ERROR', providerCode: 'BAD_REQUEST_ERROR', retryable: false });
  });

  it('refuses mismatched key and mode', () => {
    const f = fakeFetch([]);
    expect(() => razorpay.create({ ...creds, keyId: 'rzp_live_x' }, testContext('razorpay', f.fetch))).toThrow(/live key/);
    expect(() => razorpay.create(creds, testContext('razorpay', f.fetch, { environment: 'live' }))).toThrow(/test key/);
    expect(() => razorpay.create({}, testContext('razorpay', f.fetch))).toThrow(/RAZORPAY_KEY_ID/);
  });
});
