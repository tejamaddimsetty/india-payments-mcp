/**
 * Sandbox smoke test: calls the REAL sandbox APIs of each configured gateway and checks that our
 * request shapes, auth, response parsing and error mapping hold up. Never runs in live mode.
 *
 *   cp .env.example .env    # fill in TEST keys for the gateways you want to check
 *   npm run sandbox:smoke                   # every gateway that has credentials
 *   npm run sandbox:smoke -- razorpay       # just one
 *
 * It creates small (Rs 1) unpaid orders. It cannot complete a payment: that needs a human in the
 * gateway's checkout page (see examples/express-checkout). Order refs are printed so you can pay
 * one and re-run with SMOKE_PAID_ORDER=<provider>:<orderRef>[:<providerOrderId>] to check the paid path.
 */
import { existsSync } from 'node:fs';
import { PaymentsClient } from '../src/client.js';
import { PaymentError } from '../src/core/errors.js';
import { createLogger } from '../src/core/logger.js';
import { PROVIDER_IDS, type ProviderId } from '../src/core/types.js';

if (existsSync('.env')) process.loadEnvFile('.env');
if ((process.env.PAYMENTS_MODE ?? 'sandbox') !== 'sandbox') {
  console.error(`Refusing to run: PAYMENTS_MODE must be sandbox (got ${process.env.PAYMENTS_MODE}).`);
  process.exit(2);
}

type Outcome = 'PASS' | 'FAIL' | 'SKIP';
const results: Array<{ provider: string; check: string; outcome: Outcome; detail: string }> = [];

const client = new PaymentsClient({
  env: { ...process.env, PAYMENTS_MODE: 'sandbox' },
  logger: createLogger((process.env.PAYMENTS_LOG_LEVEL as 'debug') ?? 'warn'),
  actor: 'sandbox-smoke',
});

function describeErr(err: unknown): string {
  if (err instanceof PaymentError) {
    return `${err.code}${err.httpStatus ? ` HTTP ${err.httpStatus}` : ''}${err.providerCode ? ` ${err.providerCode}` : ''}: ${err.providerMessage ?? err.message}`;
  }
  return String(err);
}

async function check(provider: string, name: string, fn: () => Promise<string | { skip: string }>) {
  try {
    const out = await fn();
    if (typeof out === 'object') results.push({ provider, check: name, outcome: 'SKIP', detail: out.skip });
    else results.push({ provider, check: name, outcome: 'PASS', detail: out });
  } catch (err) {
    results.push({ provider, check: name, outcome: 'FAIL', detail: describeErr(err) });
    if (process.env.SMOKE_VERBOSE && err instanceof PaymentError) console.error(name, JSON.stringify(err.raw, null, 2));
  }
}

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function smoke(provider: ProviderId) {
  const report = client.configReport(provider);
  if (!report.ready) {
    results.push({ provider, check: 'credentials', outcome: 'SKIP', detail: `missing ${report.missing.join(', ')}` });
    return;
  }
  const caps = client.capabilities(provider);
  const orderRef = `smk_${provider.slice(0, 4)}_${Date.now().toString(36)}`;
  let providerOrderId: string | undefined;

  await check(provider, 'credentials accepted', async () => {
    client.gateway(provider);
    return 'adapter initialised';
  });

  await check(provider, 'create payment', async () => {
    if (provider === 'dodo' && !process.env.DODO_PAYMENTS_DEFAULT_PRODUCT_ID) return { skip: 'set DODO_PAYMENTS_DEFAULT_PRODUCT_ID (Dodo has no ad-hoc prices)' };
    const r = await client.createPayment(provider, {
      orderRef,
      ...smokeAmount(provider),
      description: 'india-payments-mcp sandbox smoke test',
      customer: { name: 'Smoke Test', email: 'smoke@example.com', phone: '9999999999' },
      returnUrl: 'https://example.com/payments/return',
    });
    providerOrderId = r.providerOrderId;
    expect(r.amount === smokeAmount(provider).amount, `amount came back as ${r.amount}`);
    return `${orderRef} -> ${r.providerOrderId}, checkout=${r.checkout.type}`;
  });

  await check(provider, 'idempotent re-create', async () => {
    if (!providerOrderId) return { skip: 'create failed' };
    const again = await client.createPayment(provider, {
      orderRef,
      ...smokeAmount(provider),
      description: 'india-payments-mcp sandbox smoke test',
      customer: { name: 'Smoke Test', email: 'smoke@example.com', phone: '9999999999' },
      returnUrl: 'https://example.com/payments/return',
    });
    expect(again.providerOrderId === providerOrderId, 'second create returned a different order');
    return 'same order returned, no second API call';
  });

  await check(provider, 'status of unpaid order', async () => {
    if (!providerOrderId) return { skip: 'create failed' };
    const s = await client.getPaymentStatus(provider, { orderRef, providerOrderId });
    expect(s.status === 'created' || s.status === 'pending', `expected created/pending, got ${s.status}`);
    expect(s.amount === undefined || s.amount === 100, `amount ${s.amount}`);
    return `status=${s.status} amount=${s.amount}`;
  });

  await check(provider, 'forged callback rejected', async () => {
    if (!providerOrderId) return { skip: 'create failed' };
    const forged: Record<string, string> = {
      razorpay_order_id: providerOrderId,
      razorpay_payment_id: 'pay_FORGED0000000',
      razorpay_signature: 'f'.repeat(64),
      order_id: orderRef,
    };
    const v = await client.verifyPayment(provider, { payload: forged, orderRef, expectedAmount: 100 });
    expect(!v.paid, 'forged callback was accepted as paid');
    return `paid=false (valid=${v.valid}, status=${v.status}${v.reason ? `, ${v.reason}` : ''})`;
  });

  await check(provider, 'refund of unpaid order is refused', async () => {
    if (!providerOrderId || caps.features.refund.support === 'unsupported') return { skip: 'n/a' };
    try {
      await client.refund(provider, { orderRef, refundRef: `rf_${orderRef}`.slice(0, 23), providerPaymentId: provider === 'razorpay' ? 'pay_NONEXISTENT00001' : undefined, amount: 100 });
    } catch (err) {
      expect(err instanceof PaymentError && !err.retryable, `unexpected error ${describeErr(err)}`);
      return `refused: ${describeErr(err)}`;
    }
    throw new Error('refund of an unpaid order succeeded');
  });

  await check(provider, 'webhook sign/verify round trip', async () => {
    try {
      const hook = await client.simulateWebhook(provider, { type: 'payment.succeeded', orderRef, amount: 100 });
      const evt = await client.parseWebhook(provider, hook);
      expect(evt.type === 'payment.succeeded', `type ${evt.type}`);
      return `${evt.providerEventType} -> ${evt.type}`;
    } catch (err) {
      if (err instanceof PaymentError && err.code === 'CONFIG_MISSING') return { skip: err.message };
      throw err;
    }
  });

  if (caps.features.customers.support === 'supported') {
    await check(provider, 'create customer', async () => {
      const c = await client.createCustomer(provider, { name: 'Smoke Test', email: `smoke+${Date.now()}@example.com`, phone: '9999999999' });
      return c.providerCustomerId;
    });
  }
  if (caps.features.settlements.support === 'supported') {
    await check(provider, 'list settlements', async () => {
      const s = await client.listSettlements(provider, { count: 5 });
      return `${s.items.length} settlement(s)`;
    });
  }

  console.log(`  ${provider}: unpaid test order ${orderRef}${providerOrderId ? ` (${providerOrderId})` : ''}`);
}

/**
 * Rs 1.00 everywhere, except Dodo: it charges a product, so use that product's price
 * (SMOKE_DODO_AMOUNT in minor units, SMOKE_DODO_CURRENCY; defaults fit a USD pay-what-you-want product).
 */
function smokeAmount(provider: ProviderId): { amount: number; currency?: string } {
  if (provider !== 'dodo') return { amount: 100 };
  return { amount: Number(process.env.SMOKE_DODO_AMOUNT ?? 100), currency: process.env.SMOKE_DODO_CURRENCY ?? 'USD' };
}

async function smokePaid(spec: string) {
  const [provider, orderRef, providerOrderId] = spec.split(':') as [ProviderId, string, string | undefined];
  await check(provider, `paid order ${orderRef}`, async () => {
    const s = await client.getPaymentStatus(provider, { orderRef, providerOrderId });
    expect(s.status === 'captured' || s.status === 'authorized', `status ${s.status}`);
    return `status=${s.status} method=${s.method} paymentId=${s.providerPaymentId}`;
  });
}

const wanted = process.argv.slice(2).filter((a) => (PROVIDER_IDS as readonly string[]).includes(a)) as ProviderId[];
const providers = wanted.length ? wanted : PROVIDER_IDS.filter((p) => p !== 'skydo' && p !== 'infinity');

console.log(`Sandbox smoke test (${providers.join(', ')})\n`);
for (const p of providers) await smoke(p);
if (process.env.SMOKE_PAID_ORDER) await smokePaid(process.env.SMOKE_PAID_ORDER);

console.log('');
const w = Math.max(...results.map((r) => r.check.length));
for (const r of results) {
  console.log(`${r.outcome.padEnd(4)}  ${r.provider.padEnd(9)} ${r.check.padEnd(w)}  ${r.detail}`);
}
const failed = results.filter((r) => r.outcome === 'FAIL').length;
console.log(`\n${results.filter((r) => r.outcome === 'PASS').length} passed, ${failed} failed, ${results.filter((r) => r.outcome === 'SKIP').length} skipped`);
process.exit(failed ? 1 : 0);
