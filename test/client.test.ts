import { describe, expect, it } from 'vitest';
import { PaymentsClient } from '../src/client.js';
import { MemoryAuditSink } from '../src/core/audit.js';
import { silentLogger } from '../src/core/logger.js';
import { createWebhookHandler } from '../src/webhooks/handler.js';
import { fakeFetch } from './helpers.js';

const mockClient = (audit = new MemoryAuditSink()) => new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' }, auditSink: audit, logger: silentLogger });

describe('PaymentsClient (mock mode)', () => {
  it('runs a full create -> pay -> verify -> refund flow with no network', async () => {
    const audit = new MemoryAuditSink();
    const c = mockClient(audit);
    const created = await c.createPayment('cashfree', { orderRef: 'ord_100', amount: 49900, customer: { phone: '9999999999' } });
    expect(created.checkout.type).toBe('manual');
    const { callbackPayload } = c.mockGateway('cashfree').complete('ord_100', 'success');
    const verified = await c.verifyPayment('cashfree', { orderRef: 'ord_100', expectedAmount: 49900, payload: callbackPayload });
    expect(verified).toMatchObject({ valid: true, paid: true, status: 'captured' });
    const tampered = await c.verifyPayment('cashfree', { payload: { ...callbackPayload, amount: '1' } });
    expect(tampered.valid).toBe(false);
    const r1 = await c.refund('cashfree', { orderRef: 'ord_100', refundRef: 'rf_1', amount: 10000 });
    const r2 = await c.refund('cashfree', { orderRef: 'ord_100', refundRef: 'rf_1', amount: 10000 });
    expect(r2.providerRefundId).toBe(r1.providerRefundId);
    expect((await c.getPaymentStatus('cashfree', { orderRef: 'ord_100' })).status).toBe('partially_refunded');
    expect(audit.entries.map((e) => e.action)).toEqual(['create_payment', 'refund', 'refund']);
  });

  it('is idempotent on orderRef for create', async () => {
    const c = mockClient();
    const a = await c.createPayment('razorpay', { orderRef: 'ord_200', amount: 100 });
    const b = await c.createPayment('razorpay', { orderRef: 'ord_200', amount: 100 });
    expect(b.providerOrderId).toBe(a.providerOrderId);
    await expect(c.createPayment('razorpay', { orderRef: 'ord_200', amount: 200 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects unsupported features before any call, even in mock mode', async () => {
    const c = mockClient();
    await expect(c.createCustomer('phonepe', { name: 'x' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(c.refund('skydo', { orderRef: 'ord_300', refundRef: 'rf_300' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('validates amounts and order refs uniformly', async () => {
    const c = mockClient();
    await expect(c.createPayment('razorpay', { orderRef: 'ord 1', amount: 100 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(c.createPayment('razorpay', { orderRef: 'ord_1', amount: 4.99 })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('webhook handler verifies, dedupes and retries on handler failure', async () => {
    const c = mockClient();
    const seen: string[] = [];
    let failNext = true;
    const handle = createWebhookHandler({
      client: c,
      provider: 'razorpay',
      onEvent: async (e) => {
        if (failNext) { failNext = false; throw new Error('db down'); }
        seen.push(e.id);
      },
    });
    const hook = await c.simulateWebhook('razorpay', { type: 'payment.succeeded', orderRef: 'ord_400', amount: 100 });
    expect((await handle(hook)).status).toBe(500);
    expect((await handle(hook)).status).toBe(200);
    expect((await handle(hook)).body.duplicate).toBe(true);
    expect(seen).toHaveLength(1);
    expect((await handle({ headers: hook.headers, rawBody: hook.rawBody + ' ' })).status).toBe(400);
  });
});

describe('PaymentsClient (live safety rails)', () => {
  const env = { PAYMENTS_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 's' };

  it('blocks live refunds unless the server flag AND confirm are both set', async () => {
    const f = fakeFetch([{ match: '/refund', body: { id: 'rfnd_1', payment_id: 'pay_1', amount: 100, status: 'processed', notes: {} } }]);
    const audit = new MemoryAuditSink();
    const blocked = new PaymentsClient({ env, fetch: f.fetch, auditSink: audit, guardLiveMutations: true });
    await expect(blocked.refund('razorpay', { orderRef: 'ord_1', refundRef: 'rf_1', providerPaymentId: 'pay_1' }, { confirm: true })).rejects.toMatchObject({ code: 'LIVE_MUTATION_BLOCKED' });
    expect(audit.entries[0]!.outcome).toBe('blocked');

    const allowed = new PaymentsClient({ env: { ...env, PAYMENTS_ALLOW_LIVE_MUTATIONS: 'true' }, fetch: f.fetch, guardLiveMutations: true });
    await expect(allowed.refund('razorpay', { orderRef: 'ord_1', refundRef: 'rf_1', providerPaymentId: 'pay_1' })).rejects.toMatchObject({ code: 'LIVE_MUTATION_BLOCKED' });
    const ok = await allowed.refund('razorpay', { orderRef: 'ord_1', refundRef: 'rf_1', providerPaymentId: 'pay_1' }, { confirm: true });
    expect(ok.status).toBe('processed');
    expect(f.requests).toHaveLength(1);
  });

  it('does not gate app code (guard off by default)', async () => {
    const f = fakeFetch([{ match: '/refund', body: { id: 'rfnd_2', payment_id: 'pay_2', amount: 100, status: 'processed', notes: {} } }]);
    const app = new PaymentsClient({ env, fetch: f.fetch });
    expect((await app.refund('razorpay', { orderRef: 'ord_2', refundRef: 'rf_2', providerPaymentId: 'pay_2' })).status).toBe('processed');
  });

  it('disables webhook simulation in live mode', async () => {
    const c = new PaymentsClient({ env });
    await expect(c.simulateWebhook('razorpay', { type: 'payment.succeeded', orderRef: 'ord_1', amount: 1 })).rejects.toThrow(/live/);
  });

  it('reports missing credentials without leaking values', () => {
    const c = new PaymentsClient({ env: { PAYMENTS_MODE: 'sandbox', RAZORPAY_KEY_ID: 'rzp_test_1' } });
    const r = c.configReport('razorpay');
    expect(r).toMatchObject({ ready: false, missing: ['RAZORPAY_KEY_SECRET'], present: ['RAZORPAY_KEY_ID'] });
    expect(JSON.stringify(r)).not.toContain('rzp_test_1');
  });
});
