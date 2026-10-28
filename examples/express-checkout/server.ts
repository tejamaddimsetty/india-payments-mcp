/**
 * Runnable Express checkout for any india-payments-mcp gateway.
 *
 *   PAYMENTS_MODE=mock npx tsx server.ts              # no keys, no network
 *   PAYMENTS_MODE=sandbox PAYMENTS_PROVIDER=razorpay  # real sandbox (see README)
 *
 * This is the code `payments_generate_integration` produces for Express, collapsed into one file and
 * made gateway-agnostic (PAYMENTS_PROVIDER picks the gateway). In your app, generate the
 * per-gateway version instead: it splits service/routes and documents each gateway's quirks.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  createPaymentsClient,
  createWebhookHandler,
  PaymentError,
  PROVIDER_IDS,
  type NormalizedWebhookEvent,
  type PaymentStatus,
  type ProviderId,
} from 'india-payments-mcp';

const PROVIDER = (process.env.PAYMENTS_PROVIDER ?? 'razorpay') as ProviderId;
if (!PROVIDER_IDS.includes(PROVIDER)) throw new Error(`PAYMENTS_PROVIDER must be one of ${PROVIDER_IDS.join(', ')}`);
const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');

const payments = createPaymentsClient({ actor: 'express-example' });

// ---------------------------------------------------------------------------------------------
// Data layer (in memory for the demo; use a database in real life)
// ---------------------------------------------------------------------------------------------

/** The server's price list. The browser only ever sends an order id. */
const ORDERS: Record<string, { amount: number; description: string }> = {
  'demo-order-1': { amount: 49900, description: 'Demo T-shirt' },
};

interface Attempt {
  orderRef: string;
  orderId: string;
  amount: number;
  providerOrderId?: string;
  providerPaymentId?: string;
  status: PaymentStatus;
}
const attempts = new Map<string, Attempt>();

async function getOrderAmount(orderId: string) {
  const order = ORDERS[orderId];
  if (!order) throw new HttpError(404, `Unknown order ${orderId}`);
  return order;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Single state transition point: idempotent, never fulfils twice or on an amount mismatch. */
function applyStatus(a: Attempt, status: PaymentStatus, amount?: number, providerPaymentId?: string): PaymentStatus {
  if (status === 'captured' && amount !== undefined && amount !== a.amount) {
    console.error(`[${a.orderRef}] amount mismatch: expected ${a.amount}, got ${amount}. NOT fulfilling.`);
    return 'unknown';
  }
  if (a.status === 'captured' && status !== 'captured') return a.status; // never downgrade a capture
  const first = status === 'captured' && a.status !== 'captured';
  a.status = status;
  a.providerPaymentId = providerPaymentId ?? a.providerPaymentId;
  if (first) console.log(`[${a.orderRef}] PAID ${a.amount} paise for ${a.orderId}: fulfil the order here.`);
  return status;
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

const app = express();
app.set('trust proxy', 1);

const route = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, _next: NextFunction) =>
  fn(req, res).catch((err) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof PaymentError) {
      console.error(err.toJSON());
      return void res.status(err.code === 'VALIDATION' ? 400 : 502).json({ error: err.code, message: err.message, hint: err.hint });
    }
    console.error(err);
    res.status(500).json({ error: 'INTERNAL' });
  });

const flatten = (input: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries((input ?? {}) as Record<string, unknown>)
      .map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
      .map(([k, v]) => [k, String(v)]),
  );

// Webhook FIRST, with the raw body. A JSON parser running before this would destroy the bytes
// the signature was computed over.
const handleWebhook = createWebhookHandler({
  client: payments,
  provider: PROVIDER,
  onEvent: async (event: NormalizedWebhookEvent) => {
    const a = event.orderRef ? attempts.get(event.orderRef) : undefined;
    if (!a) return; // not ours: acknowledge and move on
    if (event.type === 'payment.succeeded') applyStatus(a, 'captured', event.amount, event.providerPaymentId);
    else if (event.type === 'payment.failed') applyStatus(a, 'failed');
    else if (event.type === 'refund.processed') applyStatus(a, 'refunded');
    console.log(`[webhook] ${event.type} for ${event.orderRef}`);
  },
});
app.post(
  '/api/payments/webhook',
  express.raw({ type: '*/*', limit: '1mb' }),
  route(async (req, res) => {
    const result = await handleWebhook({ headers: req.headers, rawBody: (req.body as Buffer).toString('utf8') });
    res.status(result.status).json(result.body);
  }),
);

app.use(express.json(), express.urlencoded({ extended: false }));
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

app.get('/api/payments/config', (_req, res) => {
  res.json({ provider: PROVIDER, mode: payments.mode });
});

app.post(
  '/api/payments/create',
  route(async (req, res) => {
    const orderId = String(req.body?.orderId ?? '');
    const { amount, description } = await getOrderAmount(orderId); // NOT req.body.amount
    const orderRef = `${orderId}_${randomBytes(6).toString('hex')}`;
    const created = await payments.createPayment(PROVIDER, {
      orderRef,
      amount,
      description,
      // Cashfree, PayU and Paytm need customer contact details; take them from your user record.
      customer: { id: 'cust_demo_1', name: 'Test Customer', email: 'test@example.com', phone: '9999999999' },
      returnUrl: `${BASE_URL}/api/payments/callback?orderRef=${orderRef}`,
      notifyUrl: `${BASE_URL}/api/payments/webhook`,
    });
    attempts.set(orderRef, { orderRef, orderId, amount: created.amount, providerOrderId: created.providerOrderId, status: created.status });
    res.status(201).json({ orderRef, provider: PROVIDER, mode: payments.mode, amount: created.amount, currency: created.currency, checkout: created.checkout });
  }),
);

/** Verify a gateway return against the attempt WE stored, then confirm with the status API. */
async function confirm(query: Record<string, string>, body: Record<string, string>) {
  const { orderRef: ours, ...rest } = query;
  const payload = { ...rest, ...body };
  const orderRef = ours ?? payload.order_ref ?? payload.txnid ?? payload.ORDERID ?? payload.order_id;
  const a = orderRef ? attempts.get(orderRef) : undefined;
  if (!a) return { ok: false, orderRef, status: 'unknown' as PaymentStatus, reason: 'Unknown order' };
  if (a.status === 'captured') return { ok: true, orderRef, status: a.status };

  const v = await payments.verifyPayment(PROVIDER, { payload, orderRef: a.orderRef, expectedAmount: a.amount });
  if (!v.valid) return { ok: false, orderRef, status: 'unknown' as PaymentStatus, reason: v.reason };
  const s =
    v.verifiedVia === 'status_api' ? v : await payments.getPaymentStatus(PROVIDER, { orderRef: a.orderRef, providerOrderId: a.providerOrderId });
  const status = applyStatus(a, s.status, s.amount, s.providerPaymentId ?? v.providerPaymentId);
  return { ok: status === 'captured', orderRef, status };
}

const callback = route(async (req, res) => {
  const result = await confirm(flatten(req.query), req.method === 'POST' ? flatten(req.body) : {});
  if (req.is('application/json')) return void res.json(result);
  res.redirect(303, `/?${new URLSearchParams({ orderRef: result.orderRef ?? '', status: result.status })}`);
});
app.post('/api/payments/callback', callback);
app.get('/api/payments/callback', callback);

// Mock mode only: simulate the customer finishing checkout, then run the normal verification path.
app.post(
  '/api/payments/mock-complete',
  route(async (req, res) => {
    if (payments.mode !== 'mock') throw new HttpError(404, 'Not found');
    const { orderRef, outcome } = req.body as { orderRef: string; outcome?: string };
    const { callbackPayload } = payments.mockGateway(PROVIDER).complete(orderRef, outcome === 'failure' ? 'failure' : 'success');
    res.json(await confirm({ orderRef }, callbackPayload));
  }),
);

app.listen(PORT, () => {
  console.log(`india-payments-mcp example: ${PROVIDER} in ${payments.mode} mode`);
  console.log(`Open http://localhost:${PORT}/`);
  if (payments.mode !== 'mock') {
    const report = payments.configReport(PROVIDER);
    if (!report.ready) console.warn(`Missing env vars for ${PROVIDER}: ${report.missing.join(', ')}`);
  }
});
