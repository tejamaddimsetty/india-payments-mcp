import { randomBytes, randomUUID } from 'node:crypto';
import type { ProviderCapabilities } from '../core/capabilities.js';
import { getHeader, hmacSha256Hex, safeEqual } from '../core/crypto.js';
import { notImplemented, PaymentError, unsupported } from '../core/errors.js';
import type { AdapterContext, PaymentGateway } from '../core/gateway.js';
import type {
  CancelSubscriptionInput,
  CreateCustomerInput,
  CreatePaymentInput,
  CreatePaymentResult,
  CreateSubscriptionInput,
  CustomerResult,
  ListSettlementsInput,
  ListSettlementsResult,
  NormalizedWebhookEvent,
  PaymentStatus,
  PaymentStatusInput,
  PaymentStatusResult,
  ProviderId,
  RefundInput,
  RefundResult,
  RefundStatusInput,
  SimulatedWebhook,
  SimulateWebhookInput,
  SubscriptionResult,
  VerifyPaymentInput,
  VerifyPaymentResult,
  WebhookInput,
} from '../core/types.js';

/**
 * A network-free stand-in for any provider. It keeps the real provider's capability map, so a
 * feature that is unsupported on PayU is still unsupported in mock mode: you discover gaps on day one,
 * not in production.
 *
 * Callback payloads and webhooks are HMAC-signed with MOCK_SECRET so the verify/parse code paths
 * still reject tampered data. The secret is random per process (mock state is per process anyway),
 * so nobody can forge mock callbacks from the published source.
 */
export const MOCK_SECRET = randomBytes(32).toString('hex');

interface MockPayment {
  orderRef: string;
  providerOrderId: string;
  providerPaymentId?: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  refunded: number;
  method?: string;
  failureReason?: string;
  createdAt: string;
}

interface MockRefund {
  refundRef: string;
  providerRefundId: string;
  orderRef: string;
  amount: number;
  status: 'processed';
}

/**
 * Where the mock mirrors a real adapter's input rules, so code that passes in mock mode does not fail in
 * sandbox. Kept next to the mock (the real checks live inside each adapter).
 */
/** Real adapters that accept INR only (PayU hosted checkout, Paytm, PhonePe). */
const INR_ONLY: ReadonlySet<ProviderId> = new Set(['payu', 'paytm', 'phonepe']);
/** Real status lookup needs providerOrderId (Razorpay order_..., Stripe cs_/pi_...). */
const STATUS_NEEDS_PROVIDER_ORDER_ID: ReadonlySet<ProviderId> = new Set(['razorpay', 'stripe']);
/** Real refund needs providerPaymentId. */
const REFUND_NEEDS_PROVIDER_PAYMENT_ID: ReadonlySet<ProviderId> = new Set(['razorpay', 'stripe', 'payu', 'paytm', 'ccavenue']);
/** Real gateway rejects a reused refund reference instead of returning the earlier refund. */
const REFUND_DUPLICATE_REJECTED: ReadonlySet<ProviderId> = new Set(['razorpay', 'payu', 'ccavenue']);
/** Real verifyPayment is a server-side status lookup (unsigned redirect), not a signed callback. */
const VERIFY_BY_STATUS_LOOKUP: ReadonlySet<ProviderId> = new Set(['skydo', 'infinity', 'cashfree', 'phonepe', 'stripe']);

/** Shared across all mock gateways in a process so the MCP server keeps state between tool calls. */
export class MockLedger {
  readonly payments = new Map<string, MockPayment>();
  readonly refunds = new Map<string, MockRefund>();
}

export function mockSignature(fields: Record<string, string>): string {
  const canonical = Object.keys(fields)
    .filter((k) => k !== 'mock_signature')
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('&');
  return hmacSha256Hex(MOCK_SECRET, canonical);
}

export class MockGateway implements PaymentGateway {
  readonly environment = 'sandbox' as const;

  constructor(
    readonly id: ProviderId,
    private readonly caps: ProviderCapabilities,
    private readonly ledger: MockLedger,
    private readonly ctx: Pick<AdapterContext, 'now'>,
  ) {}

  capabilities() {
    return this.caps;
  }

  private key(orderRef: string) {
    return `${this.id}:${orderRef}`;
  }

  private find(orderRef: string): MockPayment {
    const p = this.ledger.payments.get(this.key(orderRef));
    if (!p) throw new PaymentError('NOT_FOUND', `Mock ${this.id}: no payment with orderRef "${orderRef}".`, { provider: this.id });
    return p;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const currency = (input.currency ?? 'INR').toUpperCase();
    if (INR_ONLY.has(this.id) && currency !== 'INR') {
      throw new PaymentError('VALIDATION', `Mock ${this.id}: the real ${this.id} adapter accepts INR only (got ${currency}).`, { provider: this.id });
    }
    if (this.ledger.payments.has(this.key(input.orderRef))) {
      throw new PaymentError('PROVIDER_ERROR', `Mock ${this.id}: orderRef "${input.orderRef}" already used. Gateways require a unique order id per attempt.`, { provider: this.id });
    }
    const p: MockPayment = {
      orderRef: input.orderRef,
      providerOrderId: `mock_${this.id}_order_${randomUUID().slice(0, 8)}`,
      amount: input.amount,
      currency,
      status: 'created',
      refunded: 0,
      createdAt: this.ctx.now().toISOString(),
    };
    this.ledger.payments.set(this.key(input.orderRef), p);
    return {
      provider: this.id,
      environment: 'sandbox',
      orderRef: p.orderRef,
      providerOrderId: p.providerOrderId,
      status: 'created',
      amount: p.amount,
      currency: p.currency,
      checkout: {
        type: 'manual',
        instructions:
          `MOCK MODE: no real checkout exists. Call payments_mock_complete_payment with provider "${this.id}" and order_ref "${p.orderRef}" ` +
          'and outcome "success" or "failure" to simulate the customer paying. It returns a signed callback payload and webhook.',
      },
      raw: { mock: true, ...p },
    };
  }

  /** Test-only: move a payment to its final state, as if the customer completed checkout. */
  complete(orderRef: string, outcome: 'success' | 'failure', method = 'upi') {
    const p = this.find(orderRef);
    if (p.status !== 'created' && p.status !== 'pending') {
      throw new PaymentError('VALIDATION', `Mock payment ${orderRef} is already ${p.status}.`, { provider: this.id });
    }
    p.providerPaymentId = `mock_${this.id}_pay_${randomUUID().slice(0, 8)}`;
    p.method = method;
    p.status = outcome === 'success' ? 'captured' : 'failed';
    p.failureReason = outcome === 'failure' ? 'Simulated decline' : undefined;
    const callback: Record<string, string> = {
      provider: this.id,
      order_ref: p.orderRef,
      provider_order_id: p.providerOrderId,
      provider_payment_id: p.providerPaymentId,
      amount: String(p.amount),
      status: p.status,
    };
    callback.mock_signature = mockSignature(callback);
    return { payment: { ...p }, callbackPayload: callback };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const payload = input.payload;
    if (payload.mock_signature === undefined && VERIFY_BY_STATUS_LOOKUP.has(this.id)) return this.verifyByLookup(input);
    if (!safeEqual(mockSignature(payload), payload.mock_signature)) {
      return { valid: false, status: 'unknown', reason: 'Mock signature mismatch', verifiedVia: 'signature', raw: payload };
    }
    if (input.orderRef && payload.order_ref !== input.orderRef) {
      return { valid: false, status: 'unknown', reason: 'orderRef mismatch', verifiedVia: 'signature', raw: payload };
    }
    if (input.expectedAmount !== undefined && Number(payload.amount) !== input.expectedAmount) {
      return { valid: false, status: 'unknown', reason: 'Amount mismatch', verifiedVia: 'signature', raw: payload };
    }
    return {
      valid: true,
      status: (payload.status as PaymentStatus) ?? 'unknown',
      orderRef: payload.order_ref,
      providerOrderId: payload.provider_order_id,
      providerPaymentId: payload.provider_payment_id,
      amount: Number(payload.amount),
      verifiedVia: 'signature',
      raw: payload,
    };
  }

  /** Mirrors gateways whose real verify is a status lookup keyed by the caller's orderRef. */
  private verifyByLookup(input: VerifyPaymentInput): VerifyPaymentResult {
    const payloadRef = input.payload.order_ref ?? input.payload.order_id;
    if (payloadRef && input.orderRef && payloadRef !== input.orderRef) {
      return { valid: false, status: 'unknown', reason: `Callback is for order ${payloadRef}, expected ${input.orderRef}`, verifiedVia: 'status_api', raw: input.payload };
    }
    const orderRef = input.orderRef ?? payloadRef;
    const p = orderRef ? this.ledger.payments.get(this.key(orderRef)) : undefined;
    if (!p) {
      return { valid: false, status: 'unknown', reason: orderRef ? `Mock ${this.id}: no payment with orderRef "${orderRef}".` : 'No orderRef to look up.', verifiedVia: 'status_api', raw: input.payload };
    }
    const amountOk = input.expectedAmount === undefined || p.amount === input.expectedAmount;
    return {
      valid: amountOk,
      status: p.status,
      orderRef: p.orderRef,
      providerOrderId: p.providerOrderId,
      providerPaymentId: p.providerPaymentId,
      amount: p.amount,
      ...(amountOk ? {} : { reason: `Amount mismatch: order is ${p.amount}, expected ${input.expectedAmount}` }),
      verifiedVia: 'status_api',
      raw: { mock: true, ...p },
    };
  }

  async getPaymentStatus(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    if (STATUS_NEEDS_PROVIDER_ORDER_ID.has(this.id) && !input.providerOrderId) {
      throw new PaymentError('VALIDATION', `Mock ${this.id}: status lookup needs providerOrderId (returned by createPayment), as on the real gateway.`, { provider: this.id });
    }
    const p = this.find(input.orderRef);
    if (input.providerOrderId && input.providerOrderId !== p.providerOrderId) {
      throw new PaymentError('NOT_FOUND', `Mock ${this.id}: providerOrderId ${input.providerOrderId} does not belong to orderRef "${input.orderRef}".`, { provider: this.id });
    }
    return {
      provider: this.id,
      orderRef: p.orderRef,
      providerOrderId: p.providerOrderId,
      providerPaymentId: p.providerPaymentId,
      status: p.status,
      amount: p.amount,
      amountRefunded: p.refunded,
      currency: p.currency,
      method: p.method,
      failureReason: p.failureReason,
      raw: { mock: true, ...p },
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    if (REFUND_NEEDS_PROVIDER_PAYMENT_ID.has(this.id) && !input.providerPaymentId) {
      throw new PaymentError('VALIDATION', `Mock ${this.id}: refunds need providerPaymentId (from getPaymentStatus or the callback), as on the real gateway.`, { provider: this.id });
    }
    const existing = this.ledger.refunds.get(`${this.id}:${input.refundRef}`);
    if (existing && REFUND_DUPLICATE_REJECTED.has(this.id)) {
      throw new PaymentError('PROVIDER_ERROR', `Mock ${this.id}: duplicate refund reference "${input.refundRef}".`, {
        provider: this.id,
        providerMessage: 'Duplicate refund reference: a refund with this reference already exists.',
      });
    }
    if (existing) {
      return { provider: this.id, refundRef: existing.refundRef, providerRefundId: existing.providerRefundId, status: existing.status, amount: existing.amount, raw: { mock: true, deduplicated: true } };
    }
    const p = this.find(input.orderRef);
    if (input.providerPaymentId && input.providerPaymentId !== p.providerPaymentId) {
      throw new PaymentError('NOT_FOUND', `Mock ${this.id}: providerPaymentId ${input.providerPaymentId} does not belong to orderRef "${input.orderRef}".`, { provider: this.id });
    }
    if (p.status !== 'captured' && p.status !== 'partially_refunded') {
      throw new PaymentError('PROVIDER_ERROR', `Mock ${this.id}: cannot refund a payment in status ${p.status}.`, { provider: this.id });
    }
    const amount = input.amount ?? p.amount - p.refunded;
    if (amount <= 0 || amount > p.amount - p.refunded) {
      throw new PaymentError('VALIDATION', `Refund amount ${amount} exceeds refundable balance ${p.amount - p.refunded}.`, { provider: this.id });
    }
    p.refunded += amount;
    p.status = p.refunded === p.amount ? 'refunded' : 'partially_refunded';
    const r: MockRefund = { refundRef: input.refundRef, providerRefundId: `mock_${this.id}_rfnd_${randomUUID().slice(0, 8)}`, orderRef: p.orderRef, amount, status: 'processed' };
    this.ledger.refunds.set(`${this.id}:${input.refundRef}`, r);
    return { provider: this.id, refundRef: r.refundRef, providerRefundId: r.providerRefundId, status: r.status, amount, raw: { mock: true, ...r } };
  }

  async getRefundStatus(input: RefundStatusInput): Promise<RefundResult> {
    const r = this.ledger.refunds.get(`${this.id}:${input.refundRef}`);
    if (!r) throw new PaymentError('NOT_FOUND', `Mock ${this.id}: no refund "${input.refundRef}".`, { provider: this.id });
    return { provider: this.id, refundRef: r.refundRef, providerRefundId: r.providerRefundId, status: r.status, amount: r.amount, raw: { mock: true, ...r } };
  }

  async parseWebhook(input: WebhookInput): Promise<NormalizedWebhookEvent> {
    const sig = getHeader(input.headers, 'x-mock-signature');
    if (!safeEqual(hmacSha256Hex(MOCK_SECRET, input.rawBody), sig)) {
      throw new PaymentError('SIGNATURE_INVALID', 'Mock webhook signature mismatch.', { provider: this.id });
    }
    return JSON.parse(input.rawBody) as NormalizedWebhookEvent;
  }

  async simulateWebhook(input: SimulateWebhookInput): Promise<SimulatedWebhook> {
    // Same refusals as the real adapters.
    if (input.type === 'refund.processed' && this.id === 'payu') {
      throw notImplemented('payu', 'refund webhook simulation (refund webhooks are not parsed by this adapter)');
    }
    if (input.type === 'refund.processed' && this.id === 'ccavenue') {
      throw unsupported('ccavenue', 'refund webhook simulation', 'CCAvenue sends no refund webhooks; poll the order status instead.');
    }
    const p = this.ledger.payments.get(this.key(input.orderRef));
    const event: NormalizedWebhookEvent = {
      provider: this.id,
      id: `mock_evt_${randomUUID()}`,
      type: input.type,
      providerEventType: `mock.${input.type}`,
      orderRef: input.orderRef,
      providerOrderId: p?.providerOrderId,
      providerPaymentId: input.providerPaymentId ?? p?.providerPaymentId,
      refundRef: input.refundRef,
      // Refund events leave the payment status undefined (see NormalizedWebhookEvent.status).
      status: input.type === 'payment.succeeded' ? 'captured' : input.type === 'payment.failed' ? 'failed' : undefined,
      amount: input.amount,
      currency: input.currency ?? 'INR',
      occurredAt: this.ctx.now().toISOString(),
      raw: { mock: true },
    };
    const rawBody = JSON.stringify(event);
    return {
      provider: this.id,
      headers: { 'content-type': 'application/json', 'x-mock-signature': hmacSha256Hex(MOCK_SECRET, rawBody) },
      rawBody,
      description: `Mock ${this.id} ${input.type} webhook (generic mock signature, not the provider's real scheme). Use sandbox mode with a webhook secret to exercise the real signature check.`,
    };
  }

  async createCustomer(input: CreateCustomerInput): Promise<CustomerResult> {
    return { provider: this.id, providerCustomerId: `mock_${this.id}_cust_${randomUUID().slice(0, 8)}`, raw: { mock: true, ...input } };
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionResult> {
    return {
      provider: this.id,
      subscriptionRef: input.subscriptionRef,
      providerSubscriptionId: `mock_${this.id}_sub_${randomUUID().slice(0, 8)}`,
      status: 'pending_authorization',
      checkout: { type: 'manual', instructions: 'MOCK MODE: subscription authorisation is simulated; treat it as active.' },
      raw: { mock: true },
    };
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<SubscriptionResult> {
    return { provider: this.id, subscriptionRef: '', providerSubscriptionId: input.providerSubscriptionId, status: 'cancelled', raw: { mock: true } };
  }

  async listSettlements(_input: ListSettlementsInput): Promise<ListSettlementsResult> {
    // Only this provider's captured payments, one settlement per currency (the ledger is shared).
    const prefix = `${this.id}:`;
    const gross = new Map<string, number>();
    for (const [key, p] of this.ledger.payments) {
      if (!key.startsWith(prefix) || p.status !== 'captured') continue;
      gross.set(p.currency, (gross.get(p.currency) ?? 0) + p.amount);
    }
    return {
      provider: this.id,
      items: [...gross].map(([currency, amount], i) => {
        const fees = Math.round(amount * 0.02);
        return { id: `mock_setl_${randomUUID().slice(0, 8)}`, amount: amount - fees, currency, status: 'processed', utr: `MOCKUTR${String(i + 1).padStart(6, '0')}`, settledAt: this.ctx.now().toISOString(), fees };
      }),
      raw: { mock: true },
    };
  }
}
