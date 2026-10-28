/**
 * Regression tests for the attacks found in the pre-release design review (docs/design-review.md,
 * round 2). Each test is the original proof-of-concept, now asserting the attack fails.
 */
import { describe, expect, it } from 'vitest';
import { PaymentsClient } from '../src/client.js';
import type { FetchLike } from '../src/core/http.js';
import { silentLogger } from '../src/core/logger.js';
import { ccavenueEncrypt } from '../src/providers/ccavenue/adapter.js';
import { mapPayuStatus } from '../src/providers/payu/adapter.js';
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
    const { fetch } = fakeFetch([{ match: '/orders/order_CHEAP', body: { id: 'order_CHEAP', amount: 100, amount_paid: 100, currency: 'INR', receipt: 'CHEAP_1', status: 'paid', notes: {} } }]);
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

/**
 * Round 3 (docs/research/verification/round3-project.md). Each proof (P1-P7) and finding is now a
 * regression test asserting the attack or drift no longer works.
 */
describe('round 3 regressions', () => {
  const rzp = { keyId: 'rzp_test_x', keySecret: 'sek' };
  const rzpPayload = (order: string, pay: string) => ({ razorpay_order_id: order, razorpay_payment_id: pay, razorpay_signature: razorpayPaymentSignature(order, pay, 'sek') });

  it('H1/P1: a Razorpay payment that is only authorised (order attempted, amount_paid 0) is not paid', async () => {
    const { fetch } = fakeFetch([{ match: '/orders/order_A', body: { id: 'order_A', amount: 49900, amount_paid: 0, amount_due: 49900, currency: 'INR', receipt: 'ord_1', status: 'attempted', notes: {} } }]);
    const c = client('razorpay', rzp, fetch);
    const v = await c.verifyPayment('razorpay', { orderRef: 'ord_1', expectedAmount: 49900, providerOrderId: 'order_A', payload: rzpPayload('order_A', 'pay_X') });
    expect(v).toMatchObject({ valid: true, paid: false, status: 'authorized' });
    expect(v.reason).toMatch(/authoris/i);
  });

  it('H1: a fully paid Razorpay order is captured and paid; an unbound callback stays authorized', async () => {
    const { fetch, requests } = fakeFetch([{ match: '/orders/order_OK', body: { id: 'order_OK', amount: 49900, amount_paid: 49900, currency: 'INR', receipt: 'ord_ok', status: 'paid', notes: {} } }]);
    const c = client('razorpay', rzp, fetch);
    expect(await c.verifyPayment('razorpay', { orderRef: 'ord_ok', expectedAmount: 49900, providerOrderId: 'order_OK', payload: rzpPayload('order_OK', 'pay_OK') })).toMatchObject({ paid: true, status: 'captured' });
    const before = requests.length;
    expect(await c.verifyPayment('razorpay', { providerOrderId: 'order_OK', payload: rzpPayload('order_OK', 'pay_OK') })).toMatchObject({ valid: true, paid: false, status: 'authorized' });
    expect(requests.length).toBe(before); // no order lookup -> authorised only
  });

  it('H2/P2: partial_payment is refused, and a partially paid order verifies as not paid', async () => {
    const { fetch, requests } = fakeFetch([
      { match: '/orders/order_P/payments', body: { items: [{ id: 'pay_P', status: 'captured', amount: 100, amount_refunded: 0, currency: 'INR', method: 'upi', created_at: 1 }] } },
      { match: '/orders/order_P', body: { id: 'order_P', amount: 49900, amount_paid: 100, amount_due: 49800, currency: 'INR', receipt: 'ord_2', status: 'attempted', notes: {} } },
    ]);
    const c = client('razorpay', rzp, fetch);
    for (const providerOptions of [{ partial_payment: true }, { first_payment_min_amount: 100 }]) {
      await expect(c.createPayment('razorpay', { orderRef: 'ord_2', amount: 49900, providerOptions })).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect(requests).toHaveLength(0);
    const v = await c.verifyPayment('razorpay', { orderRef: 'ord_2', expectedAmount: 49900, providerOrderId: 'order_P', payload: rzpPayload('order_P', 'pay_P') });
    expect(v).toMatchObject({ valid: true, paid: false });
    const st = await c.getPaymentStatus('razorpay', { orderRef: 'ord_2', providerOrderId: 'order_P' });
    expect(st.status).toBe('pending');
    expect(st.failureReason).toMatch(/partially paid/);
  });

  it('H3/P4: money-routing, redirect and binding keys in providerOptions are refused per gateway, with no request sent', async () => {
    const { fetch, requests } = fakeFetch([]);
    const c = new PaymentsClient({ env: {}, logger: silentLogger, fetch, config: { mode: 'sandbox', maxRetries: 0, credentials: {
      razorpay: rzp, cashfree: { clientId: 'TESTcf', clientSecret: 's' }, stripe: { secretKey: 'sk_test_x', publishableKey: 'pk_test_x' },
      paytm: { mid: 'MID', merchantKey: '0123456789abcdef' }, payu: { key: 'k', salt: 's' }, phonepe: { clientId: 'a', clientSecret: 'b', clientVersion: '1' },
      ccavenue: { merchantId: 'm', accessCode: 'a', workingKey: 'ABCDEF0123456789ABCDEF0123456789' },
    } as never } });
    const base = { orderRef: 'ord_4', amount: 49900, customer: { name: 'A', email: 'a@example.com', phone: '9999999999' }, returnUrl: 'https://shop.example/ret' };
    const cases: Array<[Parameters<PaymentsClient['createPayment']>[0], Record<string, unknown>]> = [
      ['cashfree', { order_meta: { notify_url: 'https://evil.example/hook' } }],
      ['cashfree', { order_splits: [{ vendor_id: 'v1', percentage: 100 }] }],
      ['razorpay', { transfers: [{ account: 'acc_other', amount: 49900, currency: 'INR' }] }],
      ['stripe', { flow: 'payment_intent', capture_method: 'manual' }],
      ['stripe', { flow: 'payment_intent', transfer_data: { destination: 'acct_other' } }],
      ['stripe', { on_behalf_of: 'acct_other' }],
      ['stripe', { application_fee_amount: 100 }],
      ['stripe', { flow: 'payment_intent', metadata: { order_ref: 'SOMEONE_ELSE' } }],
      ['stripe', { flow: 'payment_intent', confirm: true, customer: 'cus_other', payment_method: 'pm_other' }],
      ['paytm', { splitSettlementInfo: { splitMethod: 'AMOUNT' } }],
      ['paytm', { requestType: 'NATIVE_SUBSCRIPTION' }],
      ['payu', { splitRequest: '{}' }],
      ['phonepe', { merchantUrls: { redirectUrl: 'https://evil.example' } }],
      ['ccavenue', { sub_account_id: 'other' }],
    ];
    for (const [provider, providerOptions] of cases) {
      await expect(c.createPayment(provider, { ...base, providerOptions }), `${provider} ${Object.keys(providerOptions)}`).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    // createSubscription is guarded too.
    const sub = { subscriptionRef: 'sub_ref1', plan: { name: 'p', amount: 100, interval: 'month' as const }, returnUrl: 'https://shop.example/ret', totalCount: 12 };
    for (const providerOptions of [{ success_url: 'https://evil.example/s' }, { line_items: [{ price: 'price_cheap', quantity: 1 }] }, { subscription_data: { trial_period_days: 365 } }, { metadata: { subscription_ref: 'x' } }]) {
      await expect(c.createSubscription('stripe', { ...sub, providerOptions })).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    for (const providerOptions of [{ plan_id: 'plan_cheap' }, { total_count: 1 }, { notes: { subscription_ref: 'x' } }, { offer_id: 'offer_x' }]) {
      await expect(c.createSubscription('razorpay', { ...sub, providerOptions })).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect(requests).toHaveLength(0);
  });

  it('H3: input.metadata cannot override the Stripe order_ref binding key', async () => {
    const { fetch, requests } = fakeFetch([{ match: 'POST https://api.stripe.com/v1/payment_intents', body: { id: 'pi_1', amount: 49900, currency: 'inr', status: 'requires_payment_method', client_secret: 'cs', metadata: {} } }]);
    const c = client('stripe', { secretKey: 'sk_test_x', publishableKey: 'pk_test_x' }, fetch);
    await c.createPayment('stripe', { orderRef: 'ord_meta', amount: 49900, metadata: { order_ref: 'SOMEONE_ELSE' }, providerOptions: { flow: 'payment_intent' } });
    const sent = new URLSearchParams(requests[0]!.body!);
    expect(sent.get('metadata[order_ref]')).toBe('ord_meta');
  });

  it('H1/P5: a Stripe PaymentIntent in requires_capture is authorised, not paid', async () => {
    const { fetch } = fakeFetch([{ match: '/payment_intents/pi_1', body: { id: 'pi_1', amount: 49900, currency: 'inr', status: 'requires_capture', metadata: { order_ref: 'ord_5' } } }]);
    const c = client('stripe', { secretKey: 'sk_test_x' }, fetch);
    const v = await c.verifyPayment('stripe', { orderRef: 'ord_5', expectedAmount: 49900, payload: { payment_intent: 'pi_1' } });
    expect(v).toMatchObject({ valid: true, paid: false, status: 'authorized' });
  });

  it('M1: a replayed Stripe success URL after a full refund is not paid; a partial refund still is', async () => {
    const session = (refunded: number) => ({
      id: 'cs_1', status: 'complete', payment_status: 'paid', amount_total: 49900, currency: 'inr', client_reference_id: 'ord_m1', metadata: { order_ref: 'ord_m1' },
      payment_intent: { id: 'pi_1', amount: 49900, currency: 'inr', status: 'succeeded', metadata: { order_ref: 'ord_m1' }, latest_charge: { id: 'ch_1', amount: 49900, amount_refunded: refunded } },
    });
    const full = client('stripe', { secretKey: 'sk_test_x' }, fakeFetch([{ match: '/checkout/sessions/cs_1', body: session(49900) }]).fetch);
    expect(await full.verifyPayment('stripe', { orderRef: 'ord_m1', expectedAmount: 49900, payload: { session_id: 'cs_1' } })).toMatchObject({ valid: true, paid: false, status: 'refunded' });
    const part = client('stripe', { secretKey: 'sk_test_x' }, fakeFetch([{ match: '/checkout/sessions/cs_1', body: session(100) }]).fetch);
    expect(await part.verifyPayment('stripe', { orderRef: 'ord_m1', expectedAmount: 49900, payload: { session_id: 'cs_1' } })).toMatchObject({ paid: true, status: 'partially_refunded' });
  });

  it('M1: Cashfree reports refunded / partially_refunded from the order refunds list', async () => {
    const routes = (refunds: unknown[]) => [
      { match: '/orders/ord_cf/refunds', body: refunds },
      { match: '/orders/ord_cf/payments', body: [{ cf_payment_id: 7, payment_status: 'SUCCESS', payment_amount: 499, payment_group: 'upi', payment_time: '2026-10-28T10:00:00Z' }] },
      { match: '/orders/ord_cf', body: { cf_order_id: 1, order_id: 'ord_cf', order_amount: 499, order_currency: 'INR', order_status: 'PAID' } },
    ];
    const creds = { clientId: 'TESTcf', clientSecret: 's' };
    const full = client('cashfree', creds, fakeFetch(routes([{ refund_id: 'rf1', refund_amount: 499, refund_status: 'SUCCESS' }])).fetch);
    expect(await full.getPaymentStatus('cashfree', { orderRef: 'ord_cf' })).toMatchObject({ status: 'refunded', amountRefunded: 49900 });
    expect(await full.verifyPayment('cashfree', { orderRef: 'ord_cf', expectedAmount: 49900, payload: { order_id: 'ord_cf' } })).toMatchObject({ valid: true, paid: false, status: 'refunded' });
    const part = client('cashfree', creds, fakeFetch(routes([{ refund_id: 'rf1', refund_amount: 100, refund_status: 'SUCCESS' }, { refund_id: 'rf2', refund_amount: 399, refund_status: 'PENDING' }])).fetch);
    expect(await part.getPaymentStatus('cashfree', { orderRef: 'ord_cf' })).toMatchObject({ status: 'partially_refunded', amountRefunded: 10000 });
    const none = client('cashfree', creds, fakeFetch(routes([])).fetch);
    expect(await none.verifyPayment('cashfree', { orderRef: 'ord_cf', expectedAmount: 49900, payload: {} })).toMatchObject({ paid: true, status: 'captured' });
  });

  it('M2/P3: a Razorpay refund whose response was lost is found by refundRef instead of being re-sent', async () => {
    let posts = 0;
    const fetch: FetchLike = async (url, init) => {
      const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
      if ((init?.method ?? 'GET') === 'POST') {
        posts++;
        throw new Error('socket hang up'); // reached Razorpay, response lost
      }
      if (url.includes('/payments/pay_X/refunds')) return json({ items: [{ id: 'rfnd_1', payment_id: 'pay_X', amount: 49900, status: 'processed', receipt: 'rf_1', notes: { refund_ref: 'rf_1' } }] });
      return json({}, 404);
    };
    const c = client('razorpay', rzp, fetch);
    const r = await c.refund('razorpay', { orderRef: 'ord_1', providerPaymentId: 'pay_X', refundRef: 'rf_1', amount: 49900 });
    expect(r).toMatchObject({ providerRefundId: 'rfnd_1', status: 'processed' });
    expect(posts).toBe(1);
    // A replay is answered from the idempotency store: still one POST.
    await c.refund('razorpay', { orderRef: 'ord_1', providerPaymentId: 'pay_X', refundRef: 'rf_1', amount: 49900 });
    expect(posts).toBe(1);
  });

  it('M2: a duplicate-receipt rejection returns the existing refund; an unknown outcome with no refund found stays OUTCOME_UNKNOWN', async () => {
    const dup = fakeFetch([
      { match: 'POST https://api.razorpay.com/v1/payments/pay_D/refund', status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Duplicate receipt: a refund with this receipt already exists' } } },
      { match: '/payments/pay_D/refunds', body: { items: [{ id: 'rfnd_D', payment_id: 'pay_D', amount: 500, status: 'pending', receipt: 'rf_D', notes: [] }] } },
    ]);
    const c = new PaymentsClient({ env: {}, logger: silentLogger, fetch: dup.fetch, config: { mode: 'sandbox', maxRetries: 0, credentials: { razorpay: rzp } as never } });
    expect(await c.refund('razorpay', { orderRef: 'o', providerPaymentId: 'pay_D', refundRef: 'rf_D', amount: 500 })).toMatchObject({ providerRefundId: 'rfnd_D' });
    // Same refundRef, different amount on the gateway: a conflict, not a silent success.
    const c2 = new PaymentsClient({ env: {}, logger: silentLogger, fetch: dup.fetch, config: { mode: 'sandbox', maxRetries: 0, credentials: { razorpay: rzp } as never } });
    await expect(c2.refund('razorpay', { orderRef: 'o', providerPaymentId: 'pay_D', refundRef: 'rf_D', amount: 400 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const lost: FetchLike = async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST') throw new Error('socket hang up');
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await expect(client('razorpay', rzp, lost).refund('razorpay', { orderRef: 'o', providerPaymentId: 'pay_L', refundRef: 'rf_L', amount: 500 })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  });

  it('M2: Razorpay getRefundStatus finds a refund by providerPaymentId + refundRef', async () => {
    const { fetch } = fakeFetch([{ match: '/payments/pay_Q/refunds', body: { items: [{ id: 'rfnd_other', payment_id: 'pay_Q', amount: 1, status: 'processed', receipt: 'x', notes: {} }, { id: 'rfnd_Q', payment_id: 'pay_Q', amount: 200, status: 'processed', receipt: null, notes: { refund_ref: 'rf_Q' } }] } }]);
    const c = client('razorpay', rzp, fetch);
    expect(await c.getRefundStatus('razorpay', { refundRef: 'rf_Q', providerPaymentId: 'pay_Q' })).toMatchObject({ providerRefundId: 'rfnd_Q', amount: 200 });
    await expect(c.getRefundStatus('razorpay', { refundRef: 'nope', providerPaymentId: 'pay_Q' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('M2: a PayU duplicate token (error 106) is OUTCOME_UNKNOWN, not "refund rejected"', async () => {
    const { fetch } = fakeFetch([{ match: 'postservice', body: { status: 0, msg: 'Token already exists', error_code: 106 } }]);
    const c = client('payu', { key: 'k', salt: 's' }, fetch);
    await expect(c.refund('payu', { orderRef: 'o', providerPaymentId: '123', refundRef: 'rf_P', amount: 100 })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', providerCode: '106' });
  });

  it('M3/P7: the mock enforces the real adapters\' rules', async () => {
    const c = new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' }, logger: silentLogger });
    const created = await c.createPayment('razorpay', { orderRef: 'm_rzp', amount: 10000 });
    c.mockGateway('razorpay').complete('m_rzp', 'success');
    await expect(c.createPayment('payu', { orderRef: 'm_payu', amount: 77700, currency: 'USD' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(c.createPayment('phonepe', { orderRef: 'm_pp', amount: 77700, currency: 'USD' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await c.createPayment('payu', { orderRef: 'm_payu2', amount: 77700 });
    c.mockGateway('payu').complete('m_payu2', 'success');
    // Settlements: only this provider's payments.
    const s = await c.listSettlements('razorpay', {});
    expect(s.items).toHaveLength(1);
    expect(s.items[0]!.amount).toBe(10000 - Math.round(10000 * 0.02));
    // Status needs providerOrderId, refunds need providerPaymentId, like the real Razorpay adapter.
    await expect(c.getPaymentStatus('razorpay', { orderRef: 'm_rzp' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const st = await c.getPaymentStatus('razorpay', { orderRef: 'm_rzp', providerOrderId: created.providerOrderId });
    await expect(c.refund('razorpay', { orderRef: 'm_rzp', refundRef: 'rf_m' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(c.refund('razorpay', { orderRef: 'm_rzp', refundRef: 'rf_m2', providerPaymentId: 'pay_wrong' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await c.refund('razorpay', { orderRef: 'm_rzp', refundRef: 'rf_m3', providerPaymentId: st.providerPaymentId, amount: 100 })).toMatchObject({ status: 'processed' });
    // Webhook types the real adapter refuses are refused in mock mode too.
    await expect(c.simulateWebhook('payu', { type: 'refund.processed', orderRef: 'm_payu2', amount: 77700 })).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    await expect(c.simulateWebhook('ccavenue', { type: 'refund.processed', orderRef: 'x_cc', amount: 100 })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('M3: a duplicate refundRef is rejected by the mock where the real gateway rejects it', async () => {
    const mock = new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' }, logger: silentLogger });
    await mock.createPayment('payu', { orderRef: 'm_dup', amount: 1000 });
    const { payment } = mock.mockGateway('payu').complete('m_dup', 'success');
    await mock.mockGateway('payu').refund({ orderRef: 'm_dup', refundRef: 'rf_dup', providerPaymentId: payment.providerPaymentId, amount: 100 });
    await expect(mock.mockGateway('payu').refund({ orderRef: 'm_dup', refundRef: 'rf_dup', providerPaymentId: payment.providerPaymentId, amount: 100 })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('mock verify mirrors status-lookup gateways; signature gateways still reject unsigned payloads', async () => {
    const c = new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' }, logger: silentLogger });
    for (const provider of ['cashfree', 'phonepe', 'stripe'] as const) {
      await c.createPayment(provider, { orderRef: `lk_${provider}`, amount: 500 });
      expect(await c.verifyPayment(provider, { orderRef: `lk_${provider}`, expectedAmount: 500, payload: {} })).toMatchObject({ valid: true, paid: false, status: 'created', verifiedVia: 'status_api' });
      c.mockGateway(provider).complete(`lk_${provider}`, 'success');
      expect(await c.verifyPayment(provider, { orderRef: `lk_${provider}`, expectedAmount: 500, payload: { order_id: `lk_${provider}` } })).toMatchObject({ valid: true, paid: true, status: 'captured', verifiedVia: 'status_api' });
      expect(await c.verifyPayment(provider, { orderRef: `lk_${provider}`, expectedAmount: 1, payload: {} })).toMatchObject({ valid: false, paid: false });
      expect(await c.verifyPayment(provider, { orderRef: `lk_${provider}`, expectedAmount: 500, payload: { order_id: 'other' } })).toMatchObject({ valid: false, paid: false });
    }
    for (const provider of ['razorpay', 'payu', 'paytm', 'ccavenue'] as const) {
      await c.createPayment(provider, { orderRef: `sg_${provider}`, amount: 500 });
      c.mockGateway(provider).complete(`sg_${provider}`, 'success');
      expect(await c.verifyPayment(provider, { orderRef: `sg_${provider}`, expectedAmount: 500, payload: {} })).toMatchObject({ valid: false, paid: false });
    }
  });

  it('M4: a forged PhonePe body cannot claim the dedupe id of a genuine later event', async () => {
    let state = 'PENDING';
    const fetch: FetchLike = async (url) => {
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('oauth')) return json({ access_token: 'tok', expires_in: 3600 });
      return json({ orderId: 'OMO1', state, amount: 100, paymentDetails: state === 'COMPLETED' ? [{ state: 'COMPLETED', transactionId: 'T1', timestamp: 1 }] : [] });
    };
    const c = client('phonepe', { clientId: 'id', clientSecret: 's', clientVersion: '1', webhookUsername: 'u', webhookPassword: 'p' }, fetch);
    const seen: Array<{ type: string; status?: string }> = [];
    const handle = createWebhookHandler({ client: c, provider: 'phonepe', onEvent: async (e) => void seen.push(e) });
    const rawBody = JSON.stringify({ event: 'checkout.order.completed', payload: { merchantOrderId: 'ORD_1', orderId: 'OMO1', state: 'COMPLETED', amount: 100 } });
    const headers = { authorization: phonepeWebhookAuthorization('u', 'p') };
    // Forged early delivery: the gateway still says PENDING.
    expect((await handle({ headers, rawBody })).status).toBe(200);
    // The genuine event, with the same body, after the payment completes, must be processed.
    state = 'COMPLETED';
    const genuine = await handle({ headers, rawBody });
    expect(genuine.body).not.toMatchObject({ duplicate: true });
    expect(seen.map((e) => e.status)).toEqual(['created', 'captured']);
    expect(seen[1]).toMatchObject({ type: 'payment.succeeded' });
    // A true retry of the confirmed event is still a duplicate.
    expect((await handle({ headers, rawBody })).body).toMatchObject({ duplicate: true });
  });

  it('M4: a confirmed fully refunded payment is not passed on as payment.succeeded', async () => {
    const seen: Array<{ type: string; status?: string; id: string }> = [];
    const fakeClient = {
      logger: silentLogger,
      parseWebhook: async () => ({ provider: 'phonepe', id: 'body-claimed-id', type: 'payment.succeeded', providerEventType: 'x', orderRef: 'ORD_R', status: 'captured', bodyAuthenticated: false, raw: {} }),
      getPaymentStatus: async () => ({ provider: 'phonepe', orderRef: 'ORD_R', status: 'refunded', amount: 100, providerPaymentId: 'T9', raw: {} }),
    } as unknown as PaymentsClient;
    const handle = createWebhookHandler({ client: fakeClient, provider: 'phonepe', onEvent: async (e) => void seen.push(e) });
    await handle({ headers: {}, rawBody: '{}' });
    expect(seen[0]).toMatchObject({ type: 'unknown', status: 'refunded', id: 'confirmed:ORD_R:refunded:T9' });
  });

  it('M5: createPayment results are cached for 10 minutes, not 24 hours', async () => {
    const ttls: number[] = [];
    const store = { get: async () => undefined, set: async (_k: string, _r: unknown, ttl: number) => void ttls.push(ttl) };
    const c = new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' }, logger: silentLogger, idempotencyStore: store });
    await c.createPayment('razorpay', { orderRef: 'ttl_1', amount: 100 });
    expect(ttls).toEqual([600]);
  });

  it('L6: the mock-in-production guard reads NODE_ENV from the env passed to the client', async () => {
    const prod = new PaymentsClient({ env: { PAYMENTS_MODE: 'mock', NODE_ENV: 'production' }, logger: silentLogger });
    expect(() => prod.gateway('razorpay')).toThrow(/production/);
    const allowed = new PaymentsClient({ env: { PAYMENTS_MODE: 'mock', NODE_ENV: 'production', PAYMENTS_ALLOW_MOCK_IN_PRODUCTION: 'true' }, logger: silentLogger });
    expect(() => allowed.gateway('razorpay')).not.toThrow();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' }, logger: silentLogger }).gateway('razorpay')).not.toThrow();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('L7: PayU unmappedstatus never upgrades a status', () => {
    expect(mapPayuStatus('failure', 'captured')).toBe('failed');
    expect(mapPayuStatus('pending', 'captured')).toBe('pending');
    expect(mapPayuStatus('success', 'auth')).toBe('authorized');
    expect(mapPayuStatus('success', 'userCancelled')).toBe('cancelled');
    expect(mapPayuStatus('success', 'captured')).toBe('captured');
  });
});

describe('Skydo mutations are gated in sandbox too (Skydo has no sandbox)', () => {
  it('recording a receipt through a guarded sandbox client needs PAYMENTS_ALLOW_LIVE_MUTATIONS and confirm', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const accounts = JSON.stringify([{ currency: 'USD', details: { 'Account number': '1234567890' } }]);
    const env = { PAYMENTS_MODE: 'sandbox', SKYDO_RECEIVING_ACCOUNTS: accounts, SKYDO_LEDGER_FILE: join(mkdtempSync(join(tmpdir(), 'skydo-r3-')), 'ledger.json') };
    const guarded = new PaymentsClient({ env, logger: silentLogger, guardLiveMutations: true });
    const input = { orderRef: 'ord_sk_1', receiptId: 'SKY-1', amountReceived: 10000 };
    const err = await guarded.skydoRecordPayment(input).catch((e) => e);
    expect(err).toMatchObject({ code: 'LIVE_MUTATION_BLOCKED' });
    expect(err.message).toContain('Skydo has no sandbox');
    // confirm alone is not enough without the server-side switch.
    await expect(guarded.skydoRecordPayment(input, { confirm: true })).rejects.toMatchObject({ code: 'LIVE_MUTATION_BLOCKED' });
  });

  it('other gateways in sandbox are not gated', async () => {
    const c = new PaymentsClient({ env: {}, logger: silentLogger, guardLiveMutations: true, fetch: fakeFetch([{ match: '/payments/pay_1/refund', body: { id: 'rfnd_1', payment_id: 'pay_1', amount: 100, status: 'processed', notes: {} } }]).fetch, config: { mode: 'sandbox', maxRetries: 0, credentials: { razorpay: { keyId: 'rzp_test_x', keySecret: 'sek' } } as never } });
    expect(await c.refund('razorpay', { orderRef: 'o', providerPaymentId: 'pay_1', refundRef: 'rf_1', amount: 100 })).toMatchObject({ status: 'processed' });
  });
});
