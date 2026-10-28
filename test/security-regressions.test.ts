/**
 * Regression tests for the attacks found in the pre-release design review (docs/design-review.md,
 * round 2). Each test is the original proof-of-concept, now asserting the attack fails.
 */
import { describe, expect, it } from 'vitest';
import { PaymentsClient } from '../src/client.js';
import type { FetchLike } from '../src/core/http.js';
import { silentLogger } from '../src/core/logger.js';
import { ccavenueEncrypt } from '../src/providers/ccavenue/adapter.js';
import { phonepeWebhookAuthorization } from '../src/providers/phonepe/adapter.js';
import { razorpayPaymentSignature } from '../src/providers/razorpay/adapter.js';
import { createWebhookHandler } from '../src/webhooks/handler.js';
import { fakeFetch } from './helpers.js';

function client(provider: string, creds: Record<string, string>, fetch: FetchLike) {
  return new PaymentsClient({
    env: {},
    logger: silentLogger,
    fetch,
    config: { mode: 'sandbox', maxRetries: 0, credentials: { [provider]: creds } as never },
  });
}

describe('security regressions', () => {
  it('razorpay: an order signature replayed as a subscription callback is rejected', async () => {
    const { fetch, requests } = fakeFetch([]);
    const c = client('razorpay', { keyId: 'rzp_test_x', keySecret: 'sek' }, fetch);
    const sig = razorpayPaymentSignature('order_CHEAP', 'pay_CHEAP', 'sek');
    const r = await c.verifyPayment('razorpay', {
      orderRef: 'BIG_ORDER_999',
      expectedAmount: 99_999_900,
      payload: { razorpay_payment_id: 'order_CHEAP', razorpay_subscription_id: 'pay_CHEAP', razorpay_signature: sig },
    });
    expect(r).toMatchObject({ valid: false, paid: false });
    expect(requests).toHaveLength(0);
  });

  it('ccavenue: a spliced ciphertext never yields paid=true without the status API agreeing', async () => {
    const workingKey = 'ABCDEF0123456789ABCDEF0123456789';
    const { fetch } = fakeFetch([]); // status API unavailable -> must not fall back to trusting decryption
    const c = client('ccavenue', { merchantId: 'm1', accessCode: 'AC1', workingKey }, fetch);
    const mk = (orderId: string, status: string, tracking: string) =>
      new URLSearchParams({ order_id: orderId, tracking_id: tracking, order_status: status, currency: 'INR', amount: '49999.00', billing_name: 'Attacker' }).toString();
    const S = Buffer.from(ccavenueEncrypt(mk('ORDA_7f3a9c1d2e4b', 'Success', '112233445566'), workingKey), 'hex');
    const F = Buffer.from(ccavenueEncrypt(mk('ORDB_0a1b2c3d4e5f', 'Aborted', '665544332211'), workingKey), 'hex');
    for (let k = 1; k < 6; k++) {
      const forged = Buffer.concat([F.subarray(0, (k + 1) * 16), S.subarray((k + 1) * 16)]).toString('hex');
      const r = await c.verifyPayment('ccavenue', { orderRef: 'ORDB_0a1b2c3d4e5f', expectedAmount: 4_999_900, payload: { encResp: forged } }).catch(() => null);
      expect(r?.paid ?? false).toBe(false);
    }
  });

  it('phonepe: an unauthenticated webhook body is re-typed from the status API', async () => {
    const { fetch } = fakeFetch([
      { match: 'oauth/token', body: { access_token: 'tok', expires_in: 3600 } },
      { match: '/checkout/v2/order/ORD_1/status', body: { orderId: 'OMO1', state: 'FAILED', amount: 100, paymentDetails: [{ state: 'FAILED', transactionId: 'T1', timestamp: 1 }] } },
    ]);
    const c = client('phonepe', { clientId: 'id', clientSecret: 's', clientVersion: '1', webhookUsername: 'u', webhookPassword: 'p' }, fetch);
    const seen: unknown[] = [];
    const handle = createWebhookHandler({ client: c, provider: 'phonepe', onEvent: async (e) => void seen.push(e) });
    const rawBody = JSON.stringify({ event: 'checkout.order.completed', payload: { merchantOrderId: 'ORD_1', orderId: 'OMO1', state: 'COMPLETED', amount: 100 } });
    expect((await handle({ headers: { authorization: phonepeWebhookAuthorization('u', 'p') }, rawBody })).status).toBe(200);
    expect(seen[0]).toMatchObject({ type: 'payment.failed', status: 'failed', bodyAuthenticated: true });
  });

  it('refund timeout is OUTCOME_UNKNOWN and not retryable', async () => {
    const fetch: FetchLike = async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    };
    const c = client('razorpay', { keyId: 'rzp_test_x', keySecret: 'sek' }, fetch);
    const err = await c.refund('razorpay', { orderRef: 'ORD_1', refundRef: 'RF_1', providerPaymentId: 'pay_1', amount: 100 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false });
  });

  it('a genuine callback is not paid unless bound to orderRef and expectedAmount', async () => {
    const { fetch } = fakeFetch([{ match: '/orders/order_CHEAP', body: { id: 'order_CHEAP', amount: 100, currency: 'INR', receipt: 'CHEAP_1', status: 'paid', notes: {} } }]);
    const c = client('razorpay', { keyId: 'rzp_test_x', keySecret: 'sek' }, fetch);
    const payload = { razorpay_order_id: 'order_CHEAP', razorpay_payment_id: 'pay_CHEAP', razorpay_signature: razorpayPaymentSignature('order_CHEAP', 'pay_CHEAP', 'sek') };
    expect((await c.verifyPayment('razorpay', { payload })).paid).toBe(false);
    expect((await c.verifyPayment('razorpay', { payload, orderRef: 'BIG_ORDER', expectedAmount: 100 })).paid).toBe(false);
    expect((await c.verifyPayment('razorpay', { payload, orderRef: 'CHEAP_1', expectedAmount: 100 })).paid).toBe(true);
    // Bound by the server-stored order id: a genuine cheap-order callback cannot pay the big order.
    expect((await c.verifyPayment('razorpay', { payload, providerOrderId: 'order_BIG', expectedAmount: 100 })).paid).toBe(false);
    expect((await c.verifyPayment('razorpay', { payload: { ...payload, razorpay_order_id: undefined as never }, providerOrderId: 'order_BIG', expectedAmount: 100 })).paid).toBe(false);
    expect((await c.verifyPayment('razorpay', { payload, providerOrderId: 'order_CHEAP', orderRef: 'CHEAP_1', expectedAmount: 100 })).paid).toBe(true);
  });

  it('webhook: a retry that arrives while the first delivery is processing gets 409, not 200', async () => {
    const c = new PaymentsClient({ env: {}, logger: silentLogger, config: { mode: 'mock' } });
    const hook = await c.simulateWebhook('razorpay', { type: 'payment.succeeded', orderRef: 'ORD_9', amount: 100 });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handle = createWebhookHandler({
      client: c,
      provider: 'razorpay',
      onEvent: async () => {
        calls++;
        if (calls === 1) {
          await gate;
          throw new Error('db down');
        }
      },
    });
    const first = handle(hook);
    await new Promise((r) => setTimeout(r, 5));
    expect((await handle(hook)).status).toBe(409);
    release();
    expect((await first).status).toBe(500);
    expect((await handle(hook)).status).toBe(200); // the gateway's next retry is processed
    expect(calls).toBe(2);
  });

  it('providerOptions cannot override the validated amount or redirect targets', async () => {
    const c = new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' }, logger: silentLogger });
    await expect(c.createPayment('payu', { orderRef: 'ord_po', amount: 100, providerOptions: { amount: '1.00' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(c.createPayment('stripe', { orderRef: 'ord_po2', amount: 100, providerOptions: { success_url: 'https://evil.example' } })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
