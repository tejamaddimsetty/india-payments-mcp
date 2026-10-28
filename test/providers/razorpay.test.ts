import { describe, expect, it } from 'vitest';
import { PaymentError } from '../../src/core/errors.js';
import { razorpay, razorpayPaymentSignature, razorpayWebhookSignature } from '../../src/providers/razorpay/adapter.js';
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
    const bad = await gw.verifyPayment({ payload: { razorpay_order_id: 'order_9', razorpay_payment_id: 'pay_10', razorpay_signature: sig } });
    expect(bad.valid).toBe(false);
    const wrongAmount = await gw.verifyPayment({ orderRef: 'ord_9', expectedAmount: 999, payload: { razorpay_order_id: 'order_9', razorpay_payment_id: 'pay_9', razorpay_signature: sig } });
    expect(wrongAmount.valid).toBe(false);
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
