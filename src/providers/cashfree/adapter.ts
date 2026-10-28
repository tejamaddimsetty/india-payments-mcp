import type { AdapterContext, PaymentGateway, ProviderModule } from '../../core/gateway.js';
import { PaymentError } from '../../core/errors.js';
import { getHeader, hmacSha256Base64, safeEqual, sha256Hex } from '../../core/crypto.js';
import type { HttpClient } from '../../core/http.js';
import { fromMajor, toMajorString } from '../../core/money.js';
import type {
  CreatePaymentInput,
  CreatePaymentResult,
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
  VerifyPaymentInput,
  VerifyPaymentResult,
  WebhookEventType,
  WebhookInput,
} from '../../core/types.js';
import { cashfreeCapabilities } from './capabilities.js';

export interface CashfreeCredentials {
  clientId?: string;
  clientSecret?: string;
}

const BASE_URLS = {
  sandbox: 'https://sandbox.cashfree.com/pg',
  live: 'https://api.cashfree.com/pg',
} as const;
/** Pinned: Cashfree response shapes change between versions. */
export const CASHFREE_API_VERSION = '2026-01-01';
const CHECKOUT_JS = 'https://sdk.cashfree.com/js/v3/cashfree.js';
/**
 * Replay guard on x-webhook-timestamp. Cashfree documents no replay window, and its default retry
 * policy re-sends at 2, 10 and 30 minutes (custom policies go further) without saying whether the
 * original timestamp is kept. A tight window would reject legitimate retries, so we only reject
 * timestamps older than 24 h or more than 5 min in the future. Duplicate delivery is handled by
 * dedupe on the event id (createWebhookHandler), not by this window.
 */
const WEBHOOK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_MAX_FUTURE_MS = 5 * 60 * 1000;
const ORDER_ID_RE = /^[A-Za-z0-9_-]{3,45}$/;
/** customer_details.customer_id: 3-50 chars, "Use alphanumeric values only" (Create Order reference). */
const CUSTOMER_ID_RE = /^[A-Za-z0-9]{3,50}$/;
// The reference text says "alphanumeric", but Cashfree's own examples use _ and - (REF-123, refund_00912).
export function normalizeIndianPhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const compact = raw.replace(/[\s\-().]/g, '');
  const m = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(compact);
  return m ? m[1] : compact;
}

const REFUND_ID_RE = /^[A-Za-z0-9_-]{3,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cashfree documents x-idempotency-key as a "UUID-formatted key". A caller key that is already a
 * UUID is passed through; anything else is hashed (sha256, name-based like UUID v5) into a UUID,
 * so the same key always maps to the same UUID and retries stay idempotent.
 */
export function cashfreeIdempotencyUuid(key: string): string {
  if (UUID_RE.test(key)) return key.toLowerCase();
  const h = sha256Hex(`india-payments-mcp:cashfree:${key}`).slice(0, 32).split('');
  h[12] = '5'; // version nibble
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16); // RFC 4122 variant
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** base64(HMAC-SHA256(timestamp + rawBody, clientSecret)). No separator between the two. */
export function cashfreeWebhookSignature(timestamp: string, rawBody: string, clientSecret: string): string {
  return hmacSha256Base64(clientSecret, `${timestamp}${rawBody}`);
}

/** Cashfree wants rupees as a JSON number with <= 2 decimals. 49900 -> 499. */
function toRupees(paise: number, currency: string): number {
  return Number(toMajorString(paise, currency));
}

interface CfOrder {
  cf_order_id: string | number;
  order_id: string;
  order_amount: number;
  order_currency: string;
  order_status: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED' | 'TERMINATION_REQUESTED' | string;
  payment_session_id?: string;
  order_expiry_time?: string;
  order_tags?: Record<string, string> | null;
}

interface CfPayment {
  cf_payment_id: string | number;
  order_id?: string;
  payment_status: string;
  payment_amount?: number;
  payment_currency?: string;
  payment_message?: string | null;
  payment_time?: string;
  payment_group?: string;
  error_details?: { error_description?: string | null; error_reason?: string | null } | null;
}

interface CfRefund {
  cf_refund_id?: string | number;
  cf_payment_id?: string | number;
  refund_id: string;
  order_id?: string;
  refund_amount: number;
  refund_currency?: string;
  refund_status: string;
  status_description?: string;
}

/** One payment attempt -> our status. */
export function mapCashfreePaymentStatus(s: string | undefined): PaymentStatus {
  switch (s) {
    case 'SUCCESS':
      return 'captured';
    case 'FAILED':
      return 'failed';
    case 'PENDING':
    case 'FLAGGED': // held for risk review; may still succeed
      return 'pending';
    case 'USER_DROPPED':
    case 'CANCELLED':
    case 'VOID':
      return 'cancelled';
    case 'NOT_ATTEMPTED':
      return 'created';
    default:
      return 'unknown';
  }
}

/** Order-level status, used when no payment attempt says more. */
export function mapCashfreeOrderStatus(s: string | undefined): PaymentStatus {
  switch (s) {
    case 'PAID':
      return 'captured';
    case 'ACTIVE':
      return 'created';
    case 'EXPIRED':
      return 'expired';
    case 'TERMINATED':
    case 'TERMINATION_REQUESTED':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

/** Documented refund_status: SUCCESS, PENDING, PENDING_APPROVAL, CANCELLED, ONHOLD, REJECTED. */
export function mapCashfreeRefundStatus(s: string | undefined): RefundStatus {
  if (s === 'SUCCESS') return 'processed';
  if (s === 'PENDING' || s === 'ONHOLD' || s === 'PENDING_APPROVAL') return 'pending';
  // FAILED is not a documented value; kept defensively.
  if (s === 'CANCELLED' || s === 'REJECTED' || s === 'FAILED') return 'failed';
  return 'unknown';
}
const mapRefundStatus = mapCashfreeRefundStatus;

/** payment_group -> our method vocabulary. Order matters: cardless_emi and upi_credit_card contain "card". */
export function mapCashfreeMethod(group: string | undefined): string | undefined {
  if (!group) return undefined;
  if (group === 'cardless_emi') return 'cardless_emi';
  // upi, upi_credit_card, upi_ppi, upi_ppi_offline are all UPI rails.
  if (group.startsWith('upi')) return 'upi';
  if (/emi/.test(group)) return 'emi';
  if (/card/.test(group)) return 'card';
  if (group === 'net_banking') return 'netbanking';
  if (group === 'pay_later') return 'paylater';
  return group;
}
const mapMethod = mapCashfreeMethod;

/** Cashfree sends ms; accept seconds too. Returns epoch ms or NaN. */
function timestampMs(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Number.NaN;
  return n < 1e12 ? n * 1000 : n;
}

class CashfreeGateway implements PaymentGateway {
  readonly id = 'cashfree' as const;
  readonly environment;
  private readonly http: HttpClient;
  private readonly baseUrl: string;

  constructor(
    private readonly creds: Required<CashfreeCredentials>,
    private readonly ctx: AdapterContext,
  ) {
    this.environment = ctx.environment;
    this.baseUrl = BASE_URLS[ctx.environment];
    this.http = ctx.http;
  }

  capabilities() {
    return cashfreeCapabilities;
  }

  private call<T>(
    method: 'GET' | 'POST',
    path: string,
    operation: string,
    opts: { body?: unknown; retrySafe?: boolean; headers?: Record<string, string> } = {},
  ) {
    return this.http.request<T>({
      method,
      url: `${this.baseUrl}${path}`,
      headers: {
        'x-client-id': this.creds.clientId,
        'x-client-secret': this.creds.clientSecret,
        'x-api-version': CASHFREE_API_VERSION,
        ...(opts.headers ?? {}),
      },
      body: opts.body,
      operation,
      retrySafe: opts.retrySafe ?? false,
    });
  }

  private orderPath(orderRef: string) {
    return `/orders/${encodeURIComponent(orderRef)}`;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const currency = input.currency ?? 'INR';
    if (!ORDER_ID_RE.test(input.orderRef)) {
      throw new PaymentError('VALIDATION', `Cashfree order_id (orderRef) must be 3-45 chars of [A-Za-z0-9_-]. Got "${input.orderRef}".`, {
        provider: 'cashfree',
      });
    }
    // Normalise Indian numbers to the 10-digit form (Cashfree rejects 91XXXXXXXXXX without a +).
    const phone = normalizeIndianPhone(input.customer?.phone);
    if (!phone) {
      throw new PaymentError('VALIDATION', 'Cashfree requires customer.phone on every order.', {
        provider: 'cashfree',
        hint: 'Pass customer: { phone: "9999999999" } (10-digit Indian mobile). Cashfree uses it for UPI/OTP flows.',
      });
    }
    // customer_id is mandatory, 3-50 alphanumeric. Derive a stable, non-PII id from the phone so
    // the same buyer maps to the same Cashfree customer across orders.
    if (input.customer?.id !== undefined && !CUSTOMER_ID_RE.test(input.customer.id)) {
      throw new PaymentError('VALIDATION', `Cashfree customer_id (customer.id) must be 3-50 alphanumeric characters. Got "${input.customer.id}".`, {
        provider: 'cashfree',
        hint: 'Use letters and digits only (no "_", "-" or spaces), or omit customer.id and a stable id is derived from the phone.',
      });
    }
    const customerId = input.customer?.id ?? `cust${sha256Hex(phone).slice(0, 24)}`;

    let returnUrl = input.returnUrl;
    if (returnUrl && !returnUrl.includes('{order_id}')) {
      // Cashfree substitutes {order_id}; without it the return page cannot tell which order came back.
      // Unverified for the latest API version: the placeholder is documented only in Cashfree's
      // migration guide, not in the 2026-01-01 Create Order reference.
      returnUrl += `${returnUrl.includes('?') ? '&' : '?'}order_id={order_id}`;
    }
    const orderMeta: Record<string, string> = {};
    if (returnUrl) orderMeta.return_url = returnUrl;
    if (input.notifyUrl) orderMeta.notify_url = input.notifyUrl;

    const body: Record<string, unknown> = {
      order_id: input.orderRef,
      order_amount: toRupees(input.amount, currency),
      order_currency: currency,
      customer_details: {
        customer_id: customerId,
        customer_phone: phone,
        customer_email: input.customer?.email,
        customer_name: input.customer?.name,
      },
      ...(Object.keys(orderMeta).length ? { order_meta: orderMeta } : {}),
      ...(input.description ? { order_note: input.description } : {}),
      ...(input.metadata && Object.keys(input.metadata).length ? { order_tags: input.metadata } : {}),
      ...(input.providerOptions ?? {}),
    };

    // With x-idempotency-key Cashfree replays the original response, so a retry cannot create a
    // second order. Without it the POST is never auto-retried. The header must be a UUID.
    const { data: order } = await this.call<CfOrder>('POST', '/orders', 'create_order', {
      body,
      headers: input.idempotencyKey ? { 'x-idempotency-key': cashfreeIdempotencyUuid(input.idempotencyKey) } : undefined,
      retrySafe: Boolean(input.idempotencyKey),
    });

    if (!order.payment_session_id) {
      throw new PaymentError('PROVIDER_ERROR', 'Cashfree created the order but returned no payment_session_id.', { provider: 'cashfree', raw: order });
    }

    return {
      provider: 'cashfree',
      environment: this.environment,
      orderRef: order.order_id,
      providerOrderId: String(order.cf_order_id),
      status: mapCashfreeOrderStatus(order.order_status),
      amount: fromMajor(order.order_amount, order.order_currency),
      currency: order.order_currency,
      checkout: {
        type: 'js_sdk',
        sdk: 'cashfree',
        scriptUrl: CHECKOUT_JS,
        // Cashfree({ mode }).checkout({ paymentSessionId }). The session id is publishable.
        options: {
          mode: this.environment === 'live' ? 'production' : 'sandbox',
          paymentSessionId: order.payment_session_id,
        },
      },
      expiresAt: order.order_expiry_time,
      raw: order,
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    // The return URL carries only ?order_id=..., unsigned. Anyone can forge it, so the only
    // trustworthy answer is a server-side status fetch.
    const payloadOrderId = input.payload.order_id;
    if (payloadOrderId && input.orderRef && payloadOrderId !== input.orderRef) {
      return {
        valid: false,
        status: 'unknown',
        verifiedVia: 'status_api',
        reason: `Callback is for order ${payloadOrderId}, expected ${input.orderRef}`,
        raw: input.payload,
      };
    }
    const orderRef = input.orderRef ?? payloadOrderId;
    if (!orderRef) {
      return { valid: false, status: 'unknown', verifiedVia: 'status_api', reason: 'Payload has no order_id and no orderRef was given.', raw: input.payload };
    }

    const s = await this.getPaymentStatus({ orderRef });
    const base = { orderRef: s.orderRef, providerOrderId: s.providerOrderId, providerPaymentId: s.providerPaymentId, amount: s.amount, verifiedVia: 'status_api' as const, raw: s.raw };
    if (input.expectedAmount !== undefined && s.amount !== input.expectedAmount) {
      return { ...base, valid: false, status: s.status, reason: `Amount mismatch: order is ${s.amount}, expected ${input.expectedAmount}` };
    }
    // `valid` means "this callback is genuinely about this order". An abandoned or failed checkout
    // also lands on return_url, so callers must read `status` (or PaymentsClient's `paid`).
    const paid = s.status === 'captured' || s.status === 'refunded' || s.status === 'partially_refunded';
    return {
      ...base,
      valid: true,
      status: s.status,
      reason: paid ? undefined : `Order is ${s.status}, not paid${s.failureReason ? `: ${s.failureReason}` : ''}`,
    };
  }

  async getPaymentStatus(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    const path = this.orderPath(input.orderRef);
    const [{ data: order }, { data: payments }] = await Promise.all([
      this.call<CfOrder>('GET', path, 'fetch_order'),
      this.call<CfPayment[]>('GET', `${path}/payments`, 'fetch_order_payments'),
    ]);

    // Pick the most meaningful attempt: SUCCESS > PENDING > latest.
    const items = [...(Array.isArray(payments) ? payments : [])].sort(
      (a, b) => (Date.parse(b.payment_time ?? '') || 0) - (Date.parse(a.payment_time ?? '') || 0),
    );
    const best =
      items.find((p) => p.payment_status === 'SUCCESS') ??
      items.find((p) => p.payment_status === 'PENDING' || p.payment_status === 'FLAGGED') ??
      items[0];

    let status: PaymentStatus;
    if (order.order_status === 'PAID') status = 'captured';
    else if (best && mapCashfreePaymentStatus(best.payment_status) === 'pending') status = 'pending';
    else if (order.order_status === 'EXPIRED' || order.order_status === 'TERMINATED') status = mapCashfreeOrderStatus(order.order_status);
    else if (best) status = mapCashfreePaymentStatus(best.payment_status);
    else status = mapCashfreeOrderStatus(order.order_status);

    const failed = best && best.payment_status !== 'SUCCESS' && status !== 'pending';
    return {
      provider: 'cashfree',
      orderRef: order.order_id ?? input.orderRef,
      providerOrderId: String(order.cf_order_id),
      providerPaymentId: best ? String(best.cf_payment_id) : undefined,
      status,
      amount: fromMajor(order.order_amount, order.order_currency),
      currency: order.order_currency,
      method: mapMethod(best?.payment_group),
      failureReason: failed ? best.error_details?.error_description ?? best.payment_message ?? undefined : undefined,
      raw: { order, payments: items },
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    if (!REFUND_ID_RE.test(input.refundRef)) {
      throw new PaymentError('VALIDATION', `Cashfree refund_id (refundRef) must be 3-40 characters of letters, digits, "_" or "-". Got "${input.refundRef}".`, {
        provider: 'cashfree',
      });
    }
    const path = this.orderPath(input.orderRef);
    let amount = input.amount;
    let currency = 'INR';
    if (amount === undefined) {
      // Cashfree has no "refund everything" flag: refund_amount is mandatory.
      const { data: order } = await this.call<CfOrder>('GET', path, 'fetch_order');
      amount = fromMajor(order.order_amount, order.order_currency);
      currency = order.order_currency;
    }
    const body: Record<string, unknown> = {
      refund_amount: toRupees(amount, currency),
      refund_id: input.refundRef,
      refund_speed: input.speed === 'instant' ? 'INSTANT' : 'STANDARD',
      ...(input.reason ? { refund_note: input.reason } : {}),
    };
    // Retry safety comes from the documented x-idempotency-key (a UUID derived deterministically
    // from order + refundRef). refund_id uniqueness per order is not documented as a de-dupe.
    const { data } = await this.call<CfRefund>('POST', `${path}/refunds`, 'create_refund', {
      body,
      headers: { 'x-idempotency-key': cashfreeIdempotencyUuid(`refund:${input.orderRef}:${input.refundRef}`) },
      retrySafe: true,
    });
    return this.toRefundResult(input.refundRef, data);
  }

  async getRefundStatus(input: RefundStatusInput): Promise<RefundResult> {
    if (!input.orderRef) {
      throw new PaymentError('VALIDATION', 'Cashfree refund status needs orderRef (the order the refund belongs to).', { provider: 'cashfree' });
    }
    const { data } = await this.call<CfRefund>('GET', `${this.orderPath(input.orderRef)}/refunds/${encodeURIComponent(input.refundRef)}`, 'fetch_refund');
    return this.toRefundResult(input.refundRef, data);
  }

  private toRefundResult(refundRef: string, r: CfRefund): RefundResult {
    return {
      provider: 'cashfree',
      refundRef: r.refund_id ?? refundRef,
      providerRefundId: r.cf_refund_id !== undefined ? String(r.cf_refund_id) : undefined,
      status: mapRefundStatus(r.refund_status),
      amount: fromMajor(r.refund_amount, r.refund_currency ?? 'INR'),
      raw: r,
    };
  }

  async parseWebhook(input: WebhookInput): Promise<NormalizedWebhookEvent> {
    const signature = getHeader(input.headers, 'x-webhook-signature');
    const timestamp = getHeader(input.headers, 'x-webhook-timestamp');
    if (!signature || !timestamp) {
      throw new PaymentError('SIGNATURE_INVALID', 'Cashfree webhook is missing x-webhook-signature or x-webhook-timestamp.', { provider: 'cashfree' });
    }
    const expected = cashfreeWebhookSignature(timestamp, input.rawBody, this.creds.clientSecret);
    if (!safeEqual(expected, signature)) {
      throw new PaymentError('SIGNATURE_INVALID', 'Cashfree webhook signature mismatch.', {
        provider: 'cashfree',
        hint: 'Verify against the raw body bytes with the client secret of the same environment (sandbox vs production).',
      });
    }
    const ts = timestampMs(timestamp);
    const age = this.ctx.now().getTime() - ts;
    if (!Number.isFinite(ts) || age > WEBHOOK_MAX_AGE_MS || age < -WEBHOOK_MAX_FUTURE_MS) {
      throw new PaymentError('SIGNATURE_INVALID', 'Cashfree webhook timestamp is outside the accepted window (older than 24 hours or more than 5 minutes in the future; possible replay).', {
        provider: 'cashfree',
        hint: 'Check the server clock (NTP). Duplicates inside the window are dropped by event-id dedupe, so store and check the event id.',
      });
    }

    const body = JSON.parse(input.rawBody) as {
      type: string;
      event_time?: string;
      data: {
        order?: { order_id?: string; order_amount?: number; order_currency?: string; order_tags?: Record<string, string> | null };
        payment?: CfPayment;
        refund?: CfRefund;
        /** AUTO_REFUND_STATUS_WEBHOOK: same refund fields but no refund_id. */
        auto_refund?: Partial<CfRefund>;
        dispute?: { dispute_id?: string | number; dispute_amount?: number; dispute_amount_currency?: string; dispute_status?: string };
        order_details?: { order_id?: string; order_amount?: number; order_currency?: string; cf_payment_id?: string | number };
      };
    };
    const order = body.data?.order;
    const payment = body.data?.payment;
    const refund = (body.data?.refund ?? body.data?.auto_refund) as CfRefund | undefined;
    const dispute = body.data?.dispute;
    const orderDetails = body.data?.order_details;
    // Documented on webhook versions 2025-01-01+: a hash unique per webhook payload, for dedupe.
    // The overview page names x-idempotency-header; the 2025-01-01/2026-01-01 webhook samples send x-idempotency-key.
    const idempotencyHeader = getHeader(input.headers, 'x-idempotency-header') ?? getHeader(input.headers, 'x-idempotency-key');

    let type: WebhookEventType;
    switch (body.type) {
      case 'PAYMENT_SUCCESS_WEBHOOK':
        type = 'payment.succeeded';
        break;
      case 'PAYMENT_FAILED_WEBHOOK':
      case 'PAYMENT_USER_DROPPED_WEBHOOK':
        type = 'payment.failed';
        break;
      case 'REFUND_STATUS_WEBHOOK':
      case 'AUTO_REFUND_STATUS_WEBHOOK': {
        const rs = mapRefundStatus(refund?.refund_status);
        type = rs === 'processed' ? 'refund.processed' : rs === 'failed' ? 'refund.failed' : 'unknown';
        break;
      }
      case 'DISPUTE_CREATED':
        type = 'dispute.created';
        break;
      case 'DISPUTE_UPDATED':
      case 'DISPUTE_CLOSED':
        // No normalized type for these yet; providerEventType keeps the original name.
        type = 'unknown';
        break;
      default:
        type = 'unknown';
    }

    // Prefer Cashfree's own x-idempotency-header. Otherwise build one: refund webhooks repeat for
    // each status change of the same refund (status is part of the key), disputes per status too.
    const id =
      idempotencyHeader ??
      (refund
        ? `${body.type}:${refund.cf_refund_id ?? refund.refund_id}:${refund.refund_status}`
        : dispute
          ? `${body.type}:${dispute.dispute_id}:${dispute.dispute_status ?? ''}`
          : `${body.type}:${payment?.cf_payment_id ?? order?.order_id ?? timestamp}`);
    const currency =
      refund?.refund_currency ?? payment?.payment_currency ?? dispute?.dispute_amount_currency ?? order?.order_currency ?? orderDetails?.order_currency ?? 'INR';
    // All Cashfree amounts, dispute_amount included, are rupees.
    const major = refund?.refund_amount ?? payment?.payment_amount ?? dispute?.dispute_amount ?? order?.order_amount;
    const cfPaymentId = payment?.cf_payment_id ?? refund?.cf_payment_id ?? orderDetails?.cf_payment_id;

    return {
      provider: 'cashfree',
      id,
      type,
      providerEventType: body.type,
      orderRef: order?.order_id ?? refund?.order_id ?? payment?.order_id ?? orderDetails?.order_id,
      providerPaymentId: cfPaymentId !== undefined ? String(cfPaymentId) : undefined,
      providerRefundId: refund?.cf_refund_id !== undefined ? String(refund.cf_refund_id) : undefined,
      refundRef: refund?.refund_id,
      status: payment ? mapCashfreePaymentStatus(payment.payment_status) : undefined,
      amount: major !== undefined ? fromMajor(major, currency) : undefined,
      currency,
      occurredAt: body.event_time ? new Date(body.event_time).toISOString() : undefined,
      raw: body,
    };
  }

  async simulateWebhook(input: SimulateWebhookInput): Promise<SimulatedWebhook> {
    const now = this.ctx.now();
    const currency = input.currency ?? 'INR';
    const rupees = toRupees(input.amount, currency);
    const cfPaymentId = input.providerPaymentId ?? String(now.getTime());
    const order = { order_id: input.orderRef, order_amount: rupees, order_currency: currency, order_tags: null };

    let type: string;
    let data: Record<string, unknown>;
    if (input.type === 'refund.processed') {
      type = 'REFUND_STATUS_WEBHOOK';
      data = {
        refund: {
          cf_refund_id: `sim${now.getTime()}`,
          cf_payment_id: cfPaymentId,
          refund_id: input.refundRef ?? `refund${input.orderRef.replace(/[^A-Za-z0-9]/g, '')}`,
          order_id: input.orderRef,
          refund_amount: rupees,
          refund_currency: currency,
          refund_status: 'SUCCESS',
          refund_type: 'MERCHANT_INITIATED',
          status_description: 'Refund processed successfully (simulated).',
        },
      };
    } else {
      const ok = input.type === 'payment.succeeded';
      type = ok ? 'PAYMENT_SUCCESS_WEBHOOK' : 'PAYMENT_FAILED_WEBHOOK';
      data = {
        order,
        payment: {
          cf_payment_id: cfPaymentId,
          payment_status: ok ? 'SUCCESS' : 'FAILED',
          payment_amount: rupees,
          payment_currency: currency,
          payment_message: ok ? 'Transaction successful (simulated).' : 'Payment was declined by the bank (simulated).',
          payment_time: now.toISOString(),
          payment_group: 'upi',
        },
        customer_details: { customer_id: 'custsimulated', customer_phone: '9999999999' },
      };
    }
    const rawBody = JSON.stringify({ data, event_time: now.toISOString(), type });
    const timestamp = String(now.getTime());
    return {
      provider: 'cashfree',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': cashfreeWebhookSignature(timestamp, rawBody, this.creds.clientSecret),
      },
      rawBody,
      description: `Cashfree ${type} signed with CASHFREE_CLIENT_SECRET.`,
    };
  }
}

export const cashfree: ProviderModule<CashfreeCredentials> = {
  id: 'cashfree',
  capabilities: cashfreeCapabilities,
  create(creds, ctx) {
    if (!creds.clientId || !creds.clientSecret) {
      throw new PaymentError('CONFIG_MISSING', 'Cashfree needs CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET.', {
        provider: 'cashfree',
        hint: 'Merchant Dashboard > Developers > API Keys. Sandbox (test) and production keys are separate.',
      });
    }
    // Key prefixes are a best-effort guard and NOT documented by Cashfree: observed sandbox app
    // ids start with TEST, and newer secrets carry _test_ / _prod_. Absent markers are not errors.
    if (ctx.environment === 'live' && (creds.clientId.startsWith('TEST') || creds.clientSecret.includes('_test_'))) {
      throw new PaymentError('CONFIG_INVALID', 'PAYMENTS_MODE=live but the Cashfree credentials look like sandbox (test) keys.', { provider: 'cashfree' });
    }
    if (ctx.environment === 'sandbox' && creds.clientSecret.includes('_prod_')) {
      throw new PaymentError('CONFIG_INVALID', 'PAYMENTS_MODE=sandbox but CASHFREE_CLIENT_SECRET is a production key. Refusing to move real money in sandbox mode.', { provider: 'cashfree' });
    }
    return new CashfreeGateway({ clientId: creds.clientId, clientSecret: creds.clientSecret }, ctx);
  },
  extractError(data) {
    // { message, code, type } e.g. { code: "order_already_exists", type: "invalid_request_error" }
    const e = data as { code?: string; type?: string; message?: string } | undefined;
    if (!e || typeof e !== 'object') return {};
    return { code: e.code ?? e.type, message: e.message };
  },
};
