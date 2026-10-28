import { randomUUID } from 'node:crypto';
import type { AdapterContext, PaymentGateway, ProviderModule } from '../../core/gateway.js';
import { PaymentError } from '../../core/errors.js';
import { getHeader, hmacSha256Hex, safeEqual } from '../../core/crypto.js';
import type { HttpClient } from '../../core/http.js';
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
  RefundInput,
  RefundResult,
  RefundStatus,
  RefundStatusInput,
  SimulatedWebhook,
  SimulateWebhookInput,
  SubscriptionResult,
  VerifyPaymentInput,
  VerifyPaymentResult,
  WebhookEventType,
  WebhookInput,
} from '../../core/types.js';
import { razorpayCapabilities } from './capabilities.js';

export interface RazorpayCredentials {
  keyId?: string;
  keySecret?: string;
  webhookSecret?: string;
}

const BASE_URL = 'https://api.razorpay.com/v1';
const CHECKOUT_JS = 'https://checkout.razorpay.com/v1/checkout.js';

/** Razorpay uses one host for test and live; the key prefix decides the environment. */
export function razorpayPaymentSignature(orderId: string, paymentId: string, keySecret: string): string {
  return hmacSha256Hex(keySecret, `${orderId}|${paymentId}`);
}

export function razorpaySubscriptionSignature(paymentId: string, subscriptionId: string, keySecret: string): string {
  return hmacSha256Hex(keySecret, `${paymentId}|${subscriptionId}`);
}

export function razorpayWebhookSignature(rawBody: string, webhookSecret: string): string {
  return hmacSha256Hex(webhookSecret, rawBody);
}

interface RzpOrder {
  id: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string | null;
  status: 'created' | 'attempted' | 'paid';
  notes: Record<string, string>;
}

interface RzpPayment {
  id: string;
  order_id: string | null;
  amount: number;
  amount_refunded: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  method: string;
  refund_status: 'null' | 'partial' | 'full' | null;
  error_description?: string | null;
  created_at: number;
}

interface RzpRefund {
  id: string;
  payment_id: string;
  amount: number;
  status: 'pending' | 'processed' | 'failed';
  notes: Record<string, string> | [];
  receipt?: string | null;
}

export function mapRazorpayPaymentStatus(p: Pick<RzpPayment, 'status' | 'amount' | 'amount_refunded'>): PaymentStatus {
  switch (p.status) {
    case 'captured':
      // Razorpay keeps status=captured after a partial refund; refund_status/amount_refunded tell the truth.
      return p.amount_refunded > 0 ? (p.amount_refunded < p.amount ? 'partially_refunded' : 'refunded') : 'captured';
    case 'authorized':
      return 'authorized';
    case 'failed':
      return 'failed';
    case 'refunded':
      return p.amount_refunded > 0 && p.amount_refunded < p.amount ? 'partially_refunded' : 'refunded';
    case 'created':
      return 'pending';
    default:
      return 'unknown';
  }
}

function mapRefundStatus(s: string | undefined): RefundStatus {
  if (s === 'processed') return 'processed';
  if (s === 'pending') return 'pending';
  if (s === 'failed') return 'failed';
  return 'unknown';
}

class RazorpayGateway implements PaymentGateway {
  readonly id = 'razorpay' as const;
  readonly environment;
  private readonly http: HttpClient;
  private readonly auth: string;

  constructor(
    private readonly creds: Required<Pick<RazorpayCredentials, 'keyId' | 'keySecret'>> & RazorpayCredentials,
    private readonly ctx: AdapterContext,
  ) {
    this.environment = ctx.environment;
    this.auth = 'Basic ' + Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64');
    this.http = ctx.http;
  }

  capabilities() {
    return razorpayCapabilities;
  }

  private call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, operation: string, body?: unknown, retrySafe = false) {
    return this.http.request<T>({
      method,
      url: `${BASE_URL}${path}`,
      headers: { Authorization: this.auth },
      body,
      operation,
      retrySafe,
    });
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const currency = input.currency ?? 'INR';
    const body = {
      amount: input.amount,
      currency,
      receipt: input.orderRef,
      notes: { order_ref: input.orderRef, ...(input.metadata ?? {}) },
      ...(input.providerOptions ?? {}),
    };
    // Order creation is not idempotent on Razorpay, so it is never auto-retried.
    const { data: order } = await this.call<RzpOrder>('POST', '/orders', 'create_order', body);

    const options: Record<string, unknown> = {
      key: this.creds.keyId,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      description: input.description,
      prefill: {
        name: input.customer?.name,
        email: input.customer?.email,
        contact: input.customer?.phone,
      },
      // No `notes` here: browser-side checkout options are attacker-controlled, so nothing we later
      // trust (like order_ref) may travel through them. The order's own notes/receipt stay server-side.
    };
    if (input.returnUrl) {
      // Redirect mode: Razorpay POSTs razorpay_payment_id/order_id/signature to callback_url.
      options.callback_url = input.returnUrl;
      options.redirect = true;
    }

    return {
      provider: 'razorpay',
      environment: this.environment,
      orderRef: input.orderRef,
      providerOrderId: order.id,
      status: 'created',
      amount: order.amount,
      currency: order.currency,
      checkout: { type: 'js_sdk', sdk: 'razorpay', scriptUrl: CHECKOUT_JS, options },
      raw: order,
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const p = input.payload;
    const paymentId = p.razorpay_payment_id;
    const signature = p.razorpay_signature;
    // Strict id prefixes: the order and subscription signatures use the same key with fields in a
    // different order, so without these an order callback can be replayed as a subscription one.
    const bad = (reason: string): VerifyPaymentResult => ({ valid: false, status: 'unknown', verifiedVia: 'signature', reason, raw: p });
    if (paymentId !== undefined && !paymentId.startsWith('pay_')) return bad('razorpay_payment_id must start with pay_');

    // Subscription authorisation callback: razorpay_subscription_id instead of an order id.
    if (p.razorpay_subscription_id !== undefined) {
      const subId = p.razorpay_subscription_id;
      if (!subId.startsWith('sub_') || p.razorpay_order_id !== undefined) return bad('Malformed subscription callback.');
      if (!paymentId || !signature) return bad('Payload must contain razorpay_payment_id, razorpay_subscription_id and razorpay_signature.');
      if (!safeEqual(razorpaySubscriptionSignature(paymentId, subId, this.creds.keySecret), signature)) return bad('Signature mismatch');
      // Bind to the caller's subscription and amount using Razorpay's own records.
      const [{ data: sub }, { data: payment }] = await Promise.all([
        this.call<{ id: string; notes?: Record<string, string> }>('GET', `/subscriptions/${encodeURIComponent(subId)}`, 'fetch_subscription', undefined, true),
        this.call<RzpPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`, 'fetch_payment', undefined, true),
      ]);
      const subRef = sub.notes?.subscription_ref;
      if (input.orderRef && subRef !== input.orderRef) return bad(`Subscription ${subId} belongs to ${subRef ?? '(none)'}, not ${input.orderRef}`);
      if (input.expectedAmount !== undefined && payment.amount !== input.expectedAmount) return bad(`Amount mismatch: payment is ${payment.amount}, expected ${input.expectedAmount}`);
      return {
        valid: true,
        status: mapRazorpayPaymentStatus(payment),
        orderRef: subRef,
        providerOrderId: subId,
        providerPaymentId: paymentId,
        amount: payment.amount,
        verifiedVia: 'signature',
        raw: p,
      };
    }

    const orderId = p.razorpay_order_id;
    if (orderId !== undefined && !orderId.startsWith('order_')) return bad('razorpay_order_id must start with order_');
    if (!paymentId || !orderId || !signature) {
      return {
        valid: false,
        status: 'unknown',
        verifiedVia: 'signature',
        reason: 'Payload must contain razorpay_payment_id, razorpay_order_id and razorpay_signature.',
        raw: p,
      };
    }
    const expected = razorpayPaymentSignature(orderId, paymentId, this.creds.keySecret);
    if (!safeEqual(expected, signature)) {
      return { valid: false, status: 'unknown', verifiedVia: 'signature', reason: 'Signature mismatch', raw: p };
    }

    // The signature proves the payment belongs to the order. To bind it to the caller's orderRef
    // and amount we must look the order up (the browser payload carries neither).
    if (input.orderRef || input.expectedAmount !== undefined) {
      const { data: order } = await this.call<RzpOrder>('GET', `/orders/${encodeURIComponent(orderId)}`, 'fetch_order', undefined, true);
      if (input.orderRef && order.receipt !== input.orderRef) {
        return { valid: false, status: 'unknown', verifiedVia: 'signature', reason: `Order ${orderId} belongs to receipt ${order.receipt}, not ${input.orderRef}`, raw: order };
      }
      if (input.expectedAmount !== undefined && order.amount !== input.expectedAmount) {
        return { valid: false, status: 'unknown', verifiedVia: 'signature', reason: `Amount mismatch: order is ${order.amount}, expected ${input.expectedAmount}`, raw: order };
      }
    }

    return {
      valid: true,
      // A valid signature means the payment was authorised; it is captured once auto-capture runs.
      status: 'authorized',
      orderRef: input.orderRef,
      providerOrderId: orderId,
      providerPaymentId: paymentId,
      verifiedVia: 'signature',
      raw: p,
    };
  }

  async getPaymentStatus(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    if (!input.providerOrderId) {
      throw new PaymentError('VALIDATION', 'Razorpay status lookup needs providerOrderId (order_xxx) returned by createPayment.', {
        provider: 'razorpay',
        hint: 'Store providerOrderId next to your orderRef when you create the payment.',
      });
    }
    const id = encodeURIComponent(input.providerOrderId);
    const [{ data: order }, { data: payments }] = await Promise.all([
      this.call<RzpOrder>('GET', `/orders/${id}`, 'fetch_order', undefined, true),
      this.call<{ items: RzpPayment[] }>('GET', `/orders/${id}/payments`, 'fetch_order_payments', undefined, true),
    ]);

    // Pick the most meaningful attempt: captured > authorized > latest.
    const items = [...(payments.items ?? [])].sort((a, b) => b.created_at - a.created_at);
    const best =
      items.find((x) => x.status === 'captured' || x.status === 'refunded') ??
      items.find((x) => x.status === 'authorized') ??
      items[0];

    let status: PaymentStatus;
    if (best) status = mapRazorpayPaymentStatus(best);
    else status = order.status === 'paid' ? 'captured' : 'created';

    return {
      provider: 'razorpay',
      orderRef: order.receipt ?? input.orderRef,
      providerOrderId: order.id,
      providerPaymentId: best?.id,
      status,
      amount: order.amount,
      amountRefunded: best?.amount_refunded,
      currency: order.currency,
      method: best?.method,
      failureReason: best?.status === 'failed' ? best.error_description ?? undefined : undefined,
      raw: { order, payments: items },
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    if (!input.providerPaymentId) {
      throw new PaymentError('VALIDATION', 'Razorpay refunds need providerPaymentId (pay_xxx).', {
        provider: 'razorpay',
        hint: 'Get it from getPaymentStatus(...).providerPaymentId or the payment.captured webhook.',
      });
    }
    const body: Record<string, unknown> = {
      speed: input.speed === 'instant' ? 'optimum' : 'normal',
      receipt: input.refundRef,
      notes: { refund_ref: input.refundRef, ...(input.reason ? { reason: input.reason } : {}) },
    };
    if (input.amount !== undefined) body.amount = input.amount;
    const { data } = await this.call<RzpRefund>(
      'POST',
      `/payments/${encodeURIComponent(input.providerPaymentId)}/refund`,
      'create_refund',
      body,
    );
    return {
      provider: 'razorpay',
      refundRef: input.refundRef,
      providerRefundId: data.id,
      status: mapRefundStatus(data.status),
      amount: data.amount,
      raw: data,
    };
  }

  async getRefundStatus(input: RefundStatusInput): Promise<RefundResult> {
    if (!input.providerRefundId) {
      throw new PaymentError('VALIDATION', 'Razorpay refund status needs providerRefundId (rfnd_xxx).', { provider: 'razorpay' });
    }
    const { data } = await this.call<RzpRefund>('GET', `/refunds/${encodeURIComponent(input.providerRefundId)}`, 'fetch_refund', undefined, true);
    return {
      provider: 'razorpay',
      refundRef: input.refundRef,
      providerRefundId: data.id,
      status: mapRefundStatus(data.status),
      amount: data.amount,
      raw: data,
    };
  }

  async parseWebhook(input: WebhookInput): Promise<NormalizedWebhookEvent> {
    if (!this.creds.webhookSecret) {
      throw new PaymentError('CONFIG_MISSING', 'RAZORPAY_WEBHOOK_SECRET is not set; cannot verify webhooks.', { provider: 'razorpay' });
    }
    const signature = getHeader(input.headers, 'x-razorpay-signature');
    const expected = razorpayWebhookSignature(input.rawBody, this.creds.webhookSecret);
    if (!safeEqual(expected, signature)) {
      throw new PaymentError('SIGNATURE_INVALID', 'Razorpay webhook signature mismatch.', {
        provider: 'razorpay',
        hint: 'Verify against the raw request body bytes, and use the webhook secret (not the API key secret).',
      });
    }
    const body = JSON.parse(input.rawBody) as {
      event: string;
      created_at?: number;
      payload: {
        payment?: { entity: RzpPayment & { notes?: Record<string, string> } };
        order?: { entity: RzpOrder };
        refund?: { entity: RzpRefund };
        subscription?: { entity: { id: string; notes?: Record<string, string> } };
      };
    };
    const payment = body.payload.payment?.entity;
    const order = body.payload.order?.entity;
    const refund = body.payload.refund?.entity;
    const eventId = getHeader(input.headers, 'x-razorpay-event-id');

    const typeMap: Record<string, WebhookEventType> = {
      'payment.captured': 'payment.succeeded',
      'order.paid': 'payment.succeeded',
      'payment.failed': 'payment.failed',
      'payment.authorized': 'payment.authorized',
      'refund.processed': 'refund.processed',
      'refund.failed': 'refund.failed',
      'subscription.activated': 'subscription.activated',
      'subscription.charged': 'subscription.charged',
      'subscription.halted': 'subscription.halted',
      'subscription.cancelled': 'subscription.cancelled',
      'payment.dispute.created': 'dispute.created',
      'settlement.processed': 'settlement.processed',
    };
    const type = typeMap[body.event] ?? 'unknown';
    // orderRef comes only from the order (created server-side). payment.notes can be set by whoever
    // opens Checkout, so it is not trusted. Subscribe to `order.paid` to get the order entity; for
    // `payment.*` events map providerOrderId -> your order yourself.
    const refundNotes = refund && !Array.isArray(refund.notes) ? refund.notes : {};

    return {
      provider: 'razorpay',
      id: eventId ?? `${body.event}:${refund?.id ?? payment?.id ?? order?.id ?? body.created_at}`,
      type,
      providerEventType: body.event,
      orderRef: order?.receipt ?? undefined,
      providerOrderId: payment?.order_id ?? order?.id,
      providerPaymentId: payment?.id ?? refund?.payment_id,
      providerRefundId: refund?.id,
      refundRef: refundNotes.refund_ref ?? refund?.receipt ?? undefined,
      status: payment ? mapRazorpayPaymentStatus(payment) : undefined,
      amount: refund?.amount ?? payment?.amount ?? order?.amount,
      currency: payment?.currency ?? order?.currency,
      occurredAt: body.created_at ? new Date(body.created_at * 1000).toISOString() : undefined,
      raw: body,
    };
  }

  async simulateWebhook(input: SimulateWebhookInput): Promise<SimulatedWebhook> {
    if (!this.creds.webhookSecret) {
      throw new PaymentError('CONFIG_MISSING', 'Set RAZORPAY_WEBHOOK_SECRET to simulate signed webhooks.', { provider: 'razorpay' });
    }
    const paymentId = input.providerPaymentId ?? `pay_sim${randomUUID().replace(/-/g, '').slice(0, 11)}`;
    const now = Math.floor(this.ctx.now().getTime() / 1000);
    const currency = input.currency ?? 'INR';
    const payment = {
      id: paymentId,
      entity: 'payment',
      amount: input.amount,
      currency,
      status: input.type === 'payment.failed' ? 'failed' : 'captured',
      order_id: `order_sim${input.orderRef.slice(0, 10)}`,
      method: 'upi',
      amount_refunded: input.type === 'refund.processed' ? input.amount : 0,
      refund_status: input.type === 'refund.processed' ? 'full' : null,
      notes: { order_ref: input.orderRef },
      error_description: input.type === 'payment.failed' ? 'Payment was declined by the bank (simulated).' : null,
      created_at: now,
    };
    // order.paid carries the order entity (with our receipt), which is where orderRef is read from.
    const event = input.type === 'payment.succeeded' ? 'order.paid' : input.type;
    const order = { id: payment.order_id, entity: 'order', amount: input.amount, amount_paid: input.type === 'payment.failed' ? 0 : input.amount, currency, receipt: input.orderRef, status: input.type === 'payment.failed' ? 'attempted' : 'paid', notes: { order_ref: input.orderRef } };
    const payload: Record<string, unknown> = { payment: { entity: payment }, order: { entity: order } };
    if (input.type === 'refund.processed') {
      payload.refund = {
        entity: {
          id: `rfnd_sim${now}`,
          entity: 'refund',
          payment_id: paymentId,
          amount: input.amount,
          currency,
          status: 'processed',
          receipt: input.refundRef ?? null,
          notes: { refund_ref: input.refundRef ?? '' },
        },
      };
    }
    const rawBody = JSON.stringify({ entity: 'event', account_id: 'acc_simulated', event, contains: Object.keys(payload), payload, created_at: now });
    return {
      provider: 'razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-event-id': `evt_sim_${randomUUID()}`,
        'x-razorpay-signature': razorpayWebhookSignature(rawBody, this.creds.webhookSecret),
      },
      rawBody,
      description: `Razorpay ${event} webhook signed with RAZORPAY_WEBHOOK_SECRET.`,
    };
  }

  async createCustomer(input: CreateCustomerInput): Promise<CustomerResult> {
    const { data } = await this.call<{ id: string }>('POST', '/customers', 'create_customer', {
      name: input.name,
      email: input.email,
      contact: input.phone,
      notes: input.metadata,
      // Return the existing customer instead of erroring when the same email/contact exists.
      fail_existing: '0',
    }, true);
    return { provider: 'razorpay', providerCustomerId: data.id, raw: data };
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionResult> {
    let planId = input.providerPlanId;
    if (!planId) {
      if (!input.plan) {
        throw new PaymentError('VALIDATION', 'Pass providerPlanId or plan to create a Razorpay subscription.', { provider: 'razorpay' });
      }
      const period = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[input.plan.interval];
      const { data: plan } = await this.call<{ id: string }>('POST', '/plans', 'create_plan', {
        period,
        interval: input.plan.intervalCount ?? 1,
        item: { name: input.plan.name, amount: input.plan.amount, currency: input.plan.currency ?? 'INR' },
      });
      planId = plan.id;
    }
    if (!input.totalCount) {
      throw new PaymentError('VALIDATION', 'Razorpay subscriptions require totalCount (number of billing cycles).', {
        provider: 'razorpay',
        hint: 'For "until cancelled" use a large count such as 120 monthly cycles.',
      });
    }
    const { data } = await this.call<{ id: string; status: string; short_url?: string }>('POST', '/subscriptions', 'create_subscription', {
      plan_id: planId,
      total_count: input.totalCount,
      customer_notify: 1,
      notes: { subscription_ref: input.subscriptionRef, ...(input.metadata ?? {}) },
      ...(input.providerCustomerId ? { customer_id: input.providerCustomerId } : {}),
      ...(input.providerOptions ?? {}),
    });
    return {
      provider: 'razorpay',
      subscriptionRef: input.subscriptionRef,
      providerSubscriptionId: data.id,
      status: data.status === 'active' ? 'active' : 'pending_authorization',
      checkout: {
        type: 'js_sdk',
        sdk: 'razorpay',
        scriptUrl: CHECKOUT_JS,
        options: {
          key: this.creds.keyId,
          subscription_id: data.id,
          prefill: { name: input.customer?.name, email: input.customer?.email, contact: input.customer?.phone },
          ...(input.returnUrl ? { callback_url: input.returnUrl, redirect: true } : {}),
        },
      },
      raw: data,
    };
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<SubscriptionResult> {
    const { data } = await this.call<{ id: string; status: string; notes?: Record<string, string> }>(
      'POST',
      `/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}/cancel`,
      'cancel_subscription',
      { cancel_at_cycle_end: input.atCycleEnd ? 1 : 0 },
      true,
    );
    return {
      provider: 'razorpay',
      subscriptionRef: data.notes?.subscription_ref ?? '',
      providerSubscriptionId: data.id,
      status: data.status === 'cancelled' ? 'cancelled' : 'active',
      raw: data,
    };
  }

  async listSettlements(input: ListSettlementsInput): Promise<ListSettlementsResult> {
    const q = new URLSearchParams();
    if (input.from) q.set('from', String(Math.floor(Date.parse(input.from) / 1000)));
    if (input.to) q.set('to', String(Math.floor(Date.parse(input.to) / 1000) + 86399));
    q.set('count', String(Math.min(input.count ?? 25, 100)));
    const { data } = await this.call<{ items: Array<{ id: string; amount: number; status: string; utr?: string; created_at: number; fees?: number; tax?: number }> }>(
      'GET',
      `/settlements?${q}`,
      'list_settlements',
      undefined,
      true,
    );
    return {
      provider: 'razorpay',
      items: data.items.map((s) => ({
        id: s.id,
        amount: s.amount,
        currency: 'INR',
        status: s.status,
        utr: s.utr,
        settledAt: new Date(s.created_at * 1000).toISOString(),
        fees: s.fees,
        tax: s.tax,
      })),
      raw: data,
    };
  }
}

export const razorpay: ProviderModule<RazorpayCredentials> = {
  id: 'razorpay',
  capabilities: razorpayCapabilities,
  create(creds, ctx) {
    if (!creds.keyId || !creds.keySecret) {
      throw new PaymentError('CONFIG_MISSING', 'Razorpay needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.', {
        provider: 'razorpay',
        hint: 'Dashboard > Account & Settings > API Keys. Use rzp_test_ keys in sandbox.',
      });
    }
    const isTestKey = creds.keyId.startsWith('rzp_test_');
    if (ctx.environment === 'live' && isTestKey) {
      throw new PaymentError('CONFIG_INVALID', 'PAYMENTS_MODE=live but RAZORPAY_KEY_ID is a test key (rzp_test_).', { provider: 'razorpay' });
    }
    if (ctx.environment === 'sandbox' && creds.keyId.startsWith('rzp_live_')) {
      throw new PaymentError('CONFIG_INVALID', 'PAYMENTS_MODE=sandbox but RAZORPAY_KEY_ID is a live key (rzp_live_). Refusing to move real money in sandbox mode.', { provider: 'razorpay' });
    }
    return new RazorpayGateway(creds as Required<Pick<RazorpayCredentials, 'keyId' | 'keySecret'>>, ctx);
  },
  extractError(data) {
    const e = (data as { error?: { code?: string; description?: string } })?.error;
    return { code: e?.code, message: e?.description };
  },
};
