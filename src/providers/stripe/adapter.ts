import { randomUUID } from 'node:crypto';
import type { AdapterContext, PaymentGateway, ProviderModule } from '../../core/gateway.js';
import { PaymentError } from '../../core/errors.js';
import { getHeader, hmacSha256Hex, safeEqual } from '../../core/crypto.js';
import type { HttpClient } from '../../core/http.js';
import { assertMinorUnits } from '../../core/money.js';
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
import { stripeCapabilities } from './capabilities.js';
import { encodeStripeForm } from './form.js';

export interface StripeCredentials {
  secretKey?: string;
  publishableKey?: string;
  webhookSecret?: string;
}

const BASE_URL = 'https://api.stripe.com/v1';
const STRIPE_JS = 'https://js.stripe.com/v3/';
/**
 * Pinned so response shapes don't drift with the account's default version. "basil" moved
 * invoice.subscription to invoice.parent.subscription_details.subscription; the code below reads both.
 * Webhook payloads are NOT affected by this header: they use the endpoint's configured version.
 * Deliberately kept on basil (verified valid 2026-10-29) although newer versions exist (e.g.
 * 2026-09-30.endive): later versions rename Checkout `ui_mode` values and may change other shapes
 * read here. Re-check invoice/Checkout/ui_mode field usage before bumping.
 */
export const STRIPE_API_VERSION = '2025-03-31.basil';
/** "Idempotency keys are up to 255 characters long." (docs.stripe.com/api/idempotent_requests) */
export const STRIPE_MAX_IDEMPOTENCY_KEY = 255;
/** Checkout Session client_reference_id: "The maximum length is 200 characters." */
export const STRIPE_MAX_CLIENT_REFERENCE_ID = 200;

function assertClientReferenceId(ref: string, field: string): void {
  if (ref.length > STRIPE_MAX_CLIENT_REFERENCE_ID) {
    throw new PaymentError('VALIDATION', `${field} is ${ref.length} characters; Stripe client_reference_id allows at most ${STRIPE_MAX_CLIENT_REFERENCE_ID}.`, { provider: 'stripe' });
  }
}
/** Stripe's own libraries default to 300 s. Never 0. */
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;
/** The only values Stripe accepts for refund `reason`. */
const REFUND_REASONS = new Set(['duplicate', 'fraudulent', 'requested_by_customer']);

/** HMAC-SHA256(`${timestamp}.${rawBody}`, whsec_...) as hex: the v1 scheme. */
export function stripeWebhookSignature(timestamp: number | string, rawBody: string, webhookSecret: string): string {
  return hmacSha256Hex(webhookSecret, `${timestamp}.${rawBody}`);
}

/** Parse `t=1700000000,v1=abc,v1=def,v0=xyz`. Several v1 entries appear while a secret is being rolled. */
export function parseStripeSignatureHeader(header: string | undefined): { timestamp?: number; v1: string[] } {
  const v1: string[] = [];
  let timestamp: number | undefined;
  for (const part of (header ?? '').split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 't' && /^\d+$/.test(v)) timestamp = Number(v);
    else if (k === 'v1' && v) v1.push(v);
    // v0 and any other scheme are ignored on purpose (v0 is a test-mode-only legacy scheme).
  }
  return { timestamp, v1 };
}

interface StripeCharge {
  id: string;
  amount: number;
  amount_refunded: number;
  refunded?: boolean;
  payment_intent?: string | null;
  metadata?: Record<string, string>;
  payment_method_details?: { type?: string } | null;
  failure_message?: string | null;
  currency?: string;
}

interface StripePaymentIntent {
  id: string;
  object: 'payment_intent';
  amount: number;
  amount_received?: number;
  currency: string;
  status:
    | 'requires_payment_method'
    | 'requires_confirmation'
    | 'requires_action'
    | 'processing'
    | 'requires_capture'
    | 'succeeded'
    | 'canceled';
  client_secret?: string;
  metadata?: Record<string, string>;
  /** An id unless expanded (expand[]=latest_charge). */
  latest_charge?: string | StripeCharge | null;
  last_payment_error?: { message?: string; code?: string } | null;
  payment_method_types?: string[];
}

interface StripeCheckoutSession {
  id: string;
  object: 'checkout.session';
  url?: string | null;
  mode: 'payment' | 'subscription' | 'setup';
  status: 'open' | 'complete' | 'expired' | null;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  amount_total: number | null;
  currency: string | null;
  client_reference_id: string | null;
  metadata?: Record<string, string>;
  /** An id unless expanded (expand[]=payment_intent). */
  payment_intent?: string | StripePaymentIntent | null;
  subscription?: string | { id: string } | null;
  customer?: string | null;
  expires_at?: number;
}

interface StripeRefund {
  id: string;
  amount: number;
  currency?: string;
  status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled' | null;
  payment_intent?: string | null;
  charge?: string | null;
  metadata?: Record<string, string>;
  failure_reason?: string | null;
}

interface StripeSubscription {
  id: string;
  status: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string>;
}

interface StripePayout {
  id: string;
  amount: number;
  currency: string;
  status: 'paid' | 'pending' | 'in_transit' | 'canceled' | 'failed';
  arrival_date: number;
  /** Bank trace reference (UTR-like) when the bank supplies one. */
  trace_id?: { status?: string; value?: string | null } | null;
}

interface StripeEvent {
  id: string;
  type: string;
  created?: number;
  data: { object: Record<string, unknown>; previous_attributes?: Record<string, unknown> };
}

function upper(c: string | null | undefined): string | undefined {
  return c ? c.toUpperCase() : undefined;
}

function chargeOf(pi: StripePaymentIntent | undefined): StripeCharge | undefined {
  return pi && pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : undefined;
}

/** Apply refund state on top of a "money collected" status. */
function withRefunds(status: PaymentStatus, charge: Pick<StripeCharge, 'amount' | 'amount_refunded'> | undefined): PaymentStatus {
  if (status !== 'captured' || !charge || !charge.amount_refunded) return status;
  return charge.amount_refunded >= charge.amount ? 'refunded' : 'partially_refunded';
}

export function mapStripePaymentIntentStatus(
  pi: Pick<StripePaymentIntent, 'status'> & { last_payment_error?: unknown },
  charge?: Pick<StripeCharge, 'amount' | 'amount_refunded'>,
): PaymentStatus {
  switch (pi.status) {
    case 'requires_payment_method':
      // Fresh intents and intents whose last attempt failed both land here.
      return pi.last_payment_error ? 'failed' : 'created';
    case 'requires_confirmation':
    case 'requires_action':
    case 'processing':
      return 'pending';
    case 'requires_capture':
      return 'authorized';
    case 'succeeded':
      return withRefunds('captured', charge);
    case 'canceled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

export function mapStripeSessionStatus(s: Pick<StripeCheckoutSession, 'status' | 'payment_status' | 'payment_intent'>): PaymentStatus {
  const pi = s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent : undefined;
  if (s.status === 'expired') return 'expired';
  // Once the customer has paid, the PaymentIntent is the source of truth (capture, refunds).
  if (pi && s.status === 'complete') return mapStripePaymentIntentStatus(pi, chargeOf(pi));
  if (s.status === 'complete') {
    if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') return 'captured';
    return 'pending'; // async methods (bank debits) complete the Session before the money lands
  }
  if (s.status === 'open') return 'created';
  return 'unknown';
}

function mapRefundStatus(s: string | null | undefined): RefundStatus {
  switch (s) {
    case 'pending':
    case 'requires_action':
      return 'pending';
    case 'succeeded':
      return 'processed';
    case 'failed':
    case 'canceled':
      return 'failed';
    default:
      return 'unknown';
  }
}

function mapSubscriptionStatus(s: string | undefined): SubscriptionResult['status'] {
  switch (s) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'incomplete':
      return 'pending_authorization';
    case 'past_due':
    case 'unpaid':
    case 'paused':
      return 'halted';
    case 'canceled':
    case 'incomplete_expired':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** providerOptions are merged last, deeply, so `{ metadata: { x } }` adds to our metadata instead of replacing it. */
function deepMerge(base: Record<string, unknown>, extra: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!extra) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out;
}

/** Stripe's success_url must contain the literal {CHECKOUT_SESSION_ID} template, unescaped. */
function withSessionIdParam(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`;
}

function toStripeAddress(a: CreatePaymentInput['billingAddress']) {
  if (!a) return undefined;
  return {
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    state: a.state,
    postal_code: a.postalCode,
    country: a.country,
  };
}

function strOrId(v: string | { id: string } | null | undefined): string | undefined {
  if (!v) return undefined;
  return typeof v === 'string' ? v : v.id;
}

class StripeGateway implements PaymentGateway {
  readonly id = 'stripe' as const;
  readonly environment;
  private readonly http: HttpClient;
  private readonly auth: string;

  constructor(
    private readonly creds: Required<Pick<StripeCredentials, 'secretKey'>> & StripeCredentials,
    private readonly ctx: AdapterContext,
  ) {
    this.environment = ctx.environment;
    this.auth = `Bearer ${creds.secretKey}`;
    this.http = ctx.http;
  }

  capabilities() {
    return stripeCapabilities;
  }

  /**
   * Every POST carries an Idempotency-Key (Stripe de-duplicates on it for 24 h), so POSTs are
   * always retry-safe here. Callers pass a natural key (orderRef / refundRef) when there is one;
   * otherwise a random key still makes the HTTP client's own retries of *this* call safe.
   * Note: Stripe replays the saved response for a reused key, including a 500, so a retry after a
   * 5xx returns the same 500; the retries that actually help are network errors/timeouts and 409/429.
   */
  private call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    operation: string,
    opts: { body?: Record<string, unknown>; query?: URLSearchParams; idempotencyKey?: string } = {},
  ) {
    const headers: Record<string, string> = { Authorization: this.auth, 'Stripe-Version': STRIPE_API_VERSION };
    if (method === 'POST') {
      const key = opts.idempotencyKey ?? randomUUID();
      if (key.length > STRIPE_MAX_IDEMPOTENCY_KEY) {
        throw new PaymentError('VALIDATION', `Stripe Idempotency-Key for ${operation} is ${key.length} characters; Stripe allows at most ${STRIPE_MAX_IDEMPOTENCY_KEY}.`, {
          provider: 'stripe',
          hint: 'Shorten orderRef / refundRef / subscriptionRef or pass a shorter idempotencyKey.',
        });
      }
      headers['Idempotency-Key'] = key;
    }
    const qs = opts.query && [...opts.query].length ? `?${opts.query}` : '';
    return this.http.request<T>({
      method,
      url: `${BASE_URL}${path}${qs}`,
      headers,
      body: opts.body ? encodeStripeForm(opts.body) : undefined,
      operation,
      // POST: idempotency key above. DELETE (cancel subscription) is naturally idempotent.
      retrySafe: true,
    });
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    assertMinorUnits(input.amount);
    const currency = (input.currency ?? 'INR').toLowerCase();
    const { flow, ...providerOptions } = input.providerOptions ?? {};
    const metadata = { order_ref: input.orderRef, ...(input.metadata ?? {}) };
    // Indian export rules want a description of what is being sold on every charge.
    const description = input.description ?? input.orderRef;

    if (flow === 'payment_intent') return this.createPaymentIntent(input, currency, metadata, description, providerOptions);
    if (flow !== undefined && flow !== 'checkout_session') {
      throw new PaymentError('VALIDATION', `Unknown providerOptions.flow "${String(flow)}". Use 'checkout_session' (default) or 'payment_intent'.`, { provider: 'stripe' });
    }

    assertClientReferenceId(input.orderRef, 'orderRef');
    if (!input.returnUrl) {
      throw new PaymentError('VALIDATION', 'Stripe Checkout needs returnUrl (used for success_url and cancel_url).', {
        provider: 'stripe',
        hint: "Pass returnUrl, or use providerOptions.flow = 'payment_intent' to confirm on your own page with Stripe.js.",
      });
    }

    const body = deepMerge(
      {
        mode: 'payment',
        line_items: [
          {
            price_data: { currency, unit_amount: input.amount, product_data: { name: description } },
            quantity: 1,
          },
        ],
        success_url: withSessionIdParam(input.returnUrl),
        cancel_url: input.returnUrl,
        client_reference_id: input.orderRef,
        customer_email: input.customer?.email,
        // Name + billing address are mandatory for Indian export charges; Checkout collects them.
        billing_address_collection: 'required',
        metadata,
        payment_intent_data: { description, metadata: { order_ref: input.orderRef } },
      },
      providerOptions,
    );
    const { data: session } = await this.call<StripeCheckoutSession>('POST', '/checkout/sessions', 'create_checkout_session', {
      body,
      idempotencyKey: input.idempotencyKey ?? `checkout_session:${input.orderRef}`,
    });
    if (!session.url) {
      throw new PaymentError('PROVIDER_ERROR', 'Stripe returned a Checkout Session without a url.', {
        provider: 'stripe',
        raw: session,
        hint: "ui_mode 'embedded'/'custom' Sessions have no url; drop that providerOption or use flow 'payment_intent'.",
      });
    }
    return {
      provider: 'stripe',
      environment: this.environment,
      orderRef: input.orderRef,
      providerOrderId: session.id,
      status: 'created',
      amount: session.amount_total ?? input.amount,
      currency: upper(session.currency) ?? currency.toUpperCase(),
      checkout: { type: 'redirect', url: session.url, method: 'GET' },
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : undefined,
      raw: session,
    };
  }

  private async createPaymentIntent(
    input: CreatePaymentInput,
    currency: string,
    metadata: Record<string, string>,
    description: string,
    providerOptions: Record<string, unknown>,
  ): Promise<CreatePaymentResult> {
    if (!this.creds.publishableKey) {
      throw new PaymentError('CONFIG_MISSING', "providerOptions.flow = 'payment_intent' needs STRIPE_PUBLISHABLE_KEY for Stripe.js.", {
        provider: 'stripe',
        hint: 'Dashboard > Developers > API keys: pk_test_... in sandbox.',
      });
    }
    const body = deepMerge(
      {
        amount: input.amount,
        currency,
        automatic_payment_methods: { enabled: true },
        description,
        metadata,
        receipt_email: input.customer?.email,
      },
      providerOptions,
    );
    const { data: pi } = await this.call<StripePaymentIntent>('POST', '/payment_intents', 'create_payment_intent', {
      body,
      idempotencyKey: input.idempotencyKey ?? `payment_intent:${input.orderRef}`,
    });

    // A PaymentIntent cannot carry billing details itself; they belong on the payment method at
    // confirm time. Hand them to the browser so it can pass them to stripe.confirmPayment().
    const billingDetails =
      input.customer || input.billingAddress
        ? {
            name: input.customer?.name,
            email: input.customer?.email,
            phone: input.customer?.phone,
            address: toStripeAddress(input.billingAddress),
          }
        : undefined;

    return {
      provider: 'stripe',
      environment: this.environment,
      orderRef: input.orderRef,
      providerOrderId: pi.id,
      status: mapStripePaymentIntentStatus(pi),
      amount: pi.amount,
      currency: pi.currency.toUpperCase(),
      checkout: {
        type: 'js_sdk',
        sdk: 'stripe',
        scriptUrl: STRIPE_JS,
        options: {
          publishableKey: this.creds.publishableKey,
          clientSecret: pi.client_secret,
          ...(billingDetails ? { billingDetails } : {}),
          ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
        },
      },
      raw: pi,
    };
  }

  private fetchSession(id: string) {
    const q = new URLSearchParams();
    q.append('expand[]', 'payment_intent');
    q.append('expand[]', 'payment_intent.latest_charge');
    return this.call<StripeCheckoutSession>('GET', `/checkout/sessions/${encodeURIComponent(id)}`, 'fetch_checkout_session', { query: q });
  }

  private fetchPaymentIntent(id: string) {
    const q = new URLSearchParams();
    q.append('expand[]', 'latest_charge');
    return this.call<StripePaymentIntent>('GET', `/payment_intents/${encodeURIComponent(id)}`, 'fetch_payment_intent', { query: q });
  }

  /**
   * Stripe's redirects are unsigned: Checkout appends ?session_id=cs_..., Stripe.js appends
   * ?payment_intent=pi_...&redirect_status=... So we re-fetch the object from the API. `valid` is
   * true when the object matches orderRef/amount; whether money moved is in `status`.
   */
  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const p = input.payload;
    const sessionId = p.session_id;
    const piId = p.payment_intent;
    if (!sessionId && !piId) {
      return { valid: false, status: 'unknown', verifiedVia: 'status_api', reason: 'Payload must contain session_id (Checkout) or payment_intent (Stripe.js).', raw: p };
    }

    let orderRef: string | undefined;
    let amount: number | undefined;
    let status: PaymentStatus;
    let providerOrderId: string;
    let providerPaymentId: string | undefined;
    let raw: unknown;
    if (sessionId) {
      const { data: s } = await this.fetchSession(sessionId);
      orderRef = s.client_reference_id ?? s.metadata?.order_ref;
      amount = s.amount_total ?? undefined;
      status = mapStripeSessionStatus(s);
      providerOrderId = s.id;
      providerPaymentId = strOrId(s.payment_intent as string | { id: string } | null);
      raw = s;
    } else {
      const { data: pi } = await this.fetchPaymentIntent(piId!);
      orderRef = pi.metadata?.order_ref;
      amount = pi.amount;
      status = mapStripePaymentIntentStatus(pi, chargeOf(pi));
      providerOrderId = pi.id;
      providerPaymentId = pi.id;
      raw = pi;
    }

    const base = { status, orderRef, providerOrderId, providerPaymentId, amount, verifiedVia: 'status_api' as const, raw };
    if (input.orderRef && orderRef !== input.orderRef) {
      return { ...base, valid: false, reason: `${providerOrderId} belongs to order ${orderRef ?? '(none)'}, not ${input.orderRef}` };
    }
    if (input.expectedAmount !== undefined && amount !== input.expectedAmount) {
      return { ...base, valid: false, reason: `Amount mismatch: Stripe has ${amount}, expected ${input.expectedAmount}` };
    }
    if (status !== 'captured' && status !== 'authorized') {
      return { ...base, valid: true, reason: `Payment is not complete (status ${status}). Wait for the webhook or poll getPaymentStatus.` };
    }
    return { ...base, valid: true };
  }

  async getPaymentStatus(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    const id = input.providerOrderId;
    if (!id || !(id.startsWith('cs_') || id.startsWith('pi_'))) {
      throw new PaymentError('VALIDATION', 'Stripe status lookup needs providerOrderId: the Checkout Session (cs_...) or PaymentIntent (pi_...) id from createPayment.', {
        provider: 'stripe',
        hint: 'Store providerOrderId next to your orderRef when you create the payment.',
      });
    }

    let session: StripeCheckoutSession | undefined;
    let pi: StripePaymentIntent | undefined;
    if (id.startsWith('cs_')) {
      session = (await this.fetchSession(id)).data;
      pi = session.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : undefined;
    } else {
      pi = (await this.fetchPaymentIntent(id)).data;
    }
    const charge = chargeOf(pi);
    const status = session ? mapStripeSessionStatus(session) : mapStripePaymentIntentStatus(pi!, charge);

    return {
      provider: 'stripe',
      orderRef: session?.client_reference_id ?? session?.metadata?.order_ref ?? pi?.metadata?.order_ref ?? input.orderRef,
      providerOrderId: id,
      providerPaymentId: pi?.id ?? strOrId(session?.payment_intent as string | null | undefined),
      status,
      amount: session?.amount_total ?? pi?.amount,
      amountRefunded: charge?.amount_refunded,
      currency: upper(session?.currency ?? pi?.currency),
      method: charge?.payment_method_details?.type,
      failureReason: pi?.last_payment_error?.message ?? charge?.failure_message ?? undefined,
      raw: session ?? pi,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const target = input.providerPaymentId;
    if (!target || !(target.startsWith('pi_') || target.startsWith('ch_'))) {
      throw new PaymentError('VALIDATION', 'Stripe refunds need providerPaymentId: the PaymentIntent id (pi_...) or a charge id (ch_...).', {
        provider: 'stripe',
        hint: 'Get it from getPaymentStatus(...).providerPaymentId or the payment webhook.',
      });
    }
    if (input.amount !== undefined) assertMinorUnits(input.amount);
    const reason = input.reason?.trim().toLowerCase();
    const body: Record<string, unknown> = {
      ...(target.startsWith('pi_') ? { payment_intent: target } : { charge: target }),
      amount: input.amount,
      // Stripe rejects any reason outside its enum; free text is kept in metadata instead.
      reason: reason && REFUND_REASONS.has(reason) ? reason : undefined,
      metadata: {
        refund_ref: input.refundRef,
        order_ref: input.orderRef,
        ...(input.reason && !(reason && REFUND_REASONS.has(reason)) ? { reason: input.reason.slice(0, 500) } : {}),
      },
    };
    // input.speed is ignored: Stripe has no per-refund speed option.
    const { data } = await this.call<StripeRefund>('POST', '/refunds', 'create_refund', { body, idempotencyKey: input.refundRef });
    return {
      provider: 'stripe',
      refundRef: input.refundRef,
      providerRefundId: data.id,
      status: mapRefundStatus(data.status),
      amount: data.amount,
      raw: data,
    };
  }

  async getRefundStatus(input: RefundStatusInput): Promise<RefundResult> {
    let refund: StripeRefund | undefined;
    if (input.providerRefundId) {
      refund = (await this.call<StripeRefund>('GET', `/refunds/${encodeURIComponent(input.providerRefundId)}`, 'fetch_refund')).data;
    } else if (input.providerPaymentId?.startsWith('pi_') || input.providerPaymentId?.startsWith('ch_')) {
      // No refund search by metadata, so list the payment's refunds and match refund_ref.
      const q = new URLSearchParams({ [input.providerPaymentId.startsWith('pi_') ? 'payment_intent' : 'charge']: input.providerPaymentId, limit: '100' });
      const { data } = await this.call<{ data: StripeRefund[] }>('GET', '/refunds', 'list_refunds', { query: q });
      refund = data.data.find((r) => r.metadata?.refund_ref === input.refundRef);
      if (!refund) {
        throw new PaymentError('NOT_FOUND', `No Stripe refund with metadata.refund_ref = ${input.refundRef} on ${input.providerPaymentId}.`, { provider: 'stripe' });
      }
    } else {
      throw new PaymentError('VALIDATION', 'Stripe refund status needs providerRefundId (re_...) or providerPaymentId (pi_...).', { provider: 'stripe' });
    }
    return {
      provider: 'stripe',
      refundRef: refund.metadata?.refund_ref ?? input.refundRef,
      providerRefundId: refund.id,
      status: mapRefundStatus(refund.status),
      amount: refund.amount,
      raw: refund,
    };
  }

  async parseWebhook(input: WebhookInput): Promise<NormalizedWebhookEvent> {
    if (!this.creds.webhookSecret) {
      throw new PaymentError('CONFIG_MISSING', 'STRIPE_WEBHOOK_SECRET is not set; cannot verify webhooks.', { provider: 'stripe' });
    }
    const { timestamp, v1 } = parseStripeSignatureHeader(getHeader(input.headers, 'stripe-signature'));
    if (timestamp === undefined || v1.length === 0) {
      throw new PaymentError('SIGNATURE_INVALID', 'Stripe-Signature header missing or has no t= / v1= entries.', { provider: 'stripe' });
    }
    const expected = stripeWebhookSignature(timestamp, input.rawBody, this.creds.webhookSecret);
    // Check every v1 (no early exit) so timing doesn't reveal which one matched.
    let matched = false;
    for (const sig of v1) matched = safeEqual(expected, sig) || matched;
    if (!matched) {
      throw new PaymentError('SIGNATURE_INVALID', 'Stripe webhook signature mismatch.', {
        provider: 'stripe',
        hint: "Verify against the raw request body bytes, and use the endpoint's whsec_ signing secret (not the API key).",
      });
    }
    const age = Math.floor(this.ctx.now().getTime() / 1000) - timestamp;
    if (Math.abs(age) > STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
      throw new PaymentError('SIGNATURE_INVALID', `Stripe webhook timestamp is outside the ${STRIPE_WEBHOOK_TOLERANCE_SECONDS}s tolerance (${age}s old). Possible replay.`, {
        provider: 'stripe',
        hint: 'Check the server clock (NTP). Stripe retries deliver a fresh timestamp, so a legitimate retry will pass.',
      });
    }

    const event = JSON.parse(input.rawBody) as StripeEvent;
    const obj = event.data?.object ?? {};
    const md = (obj.metadata ?? {}) as Record<string, string>;
    const base: NormalizedWebhookEvent = {
      provider: 'stripe',
      id: event.id,
      type: 'unknown',
      providerEventType: event.type,
      occurredAt: event.created ? new Date(event.created * 1000).toISOString() : undefined,
      raw: event,
    };

    const t = event.type;
    if (t.startsWith('checkout.session.')) {
      const s = obj as unknown as StripeCheckoutSession;
      let type: WebhookEventType = 'unknown';
      // Subscription-mode Sessions are covered by customer.subscription.* / invoice.paid; mapping
      // them here as well would double-count.
      if (s.mode === 'payment') {
        if (t === 'checkout.session.completed') type = s.payment_status === 'unpaid' ? 'payment.pending' : 'payment.succeeded';
        else if (t === 'checkout.session.async_payment_succeeded') type = 'payment.succeeded';
        else if (t === 'checkout.session.async_payment_failed') type = 'payment.failed';
      }
      let status = mapStripeSessionStatus({ ...s, payment_intent: null });
      if (t === 'checkout.session.async_payment_failed') status = 'failed';
      return {
        ...base,
        type,
        orderRef: s.client_reference_id ?? md.order_ref ?? md.subscription_ref,
        providerOrderId: s.id,
        providerPaymentId: strOrId(s.payment_intent as string | { id: string } | null),
        status,
        amount: s.amount_total ?? undefined,
        currency: upper(s.currency),
      };
    }

    if (t.startsWith('payment_intent.')) {
      const pi = obj as unknown as StripePaymentIntent;
      const map: Record<string, WebhookEventType> = {
        'payment_intent.succeeded': 'payment.succeeded',
        'payment_intent.payment_failed': 'payment.failed',
        'payment_intent.processing': 'payment.pending',
        'payment_intent.amount_capturable_updated': 'payment.authorized',
        'payment_intent.canceled': 'payment.failed',
      };
      return {
        ...base,
        type: map[t] ?? 'unknown',
        orderRef: md.order_ref,
        providerOrderId: pi.id,
        providerPaymentId: pi.id,
        status: mapStripePaymentIntentStatus(pi),
        amount: pi.amount,
        currency: upper(pi.currency),
      };
    }

    if (t === 'refund.created' || t === 'refund.updated' || t === 'refund.failed' || t === 'charge.refund.updated') {
      const r = obj as unknown as StripeRefund;
      const rs = mapRefundStatus(r.status);
      return {
        ...base,
        type: rs === 'processed' ? 'refund.processed' : rs === 'failed' ? 'refund.failed' : 'unknown',
        orderRef: md.order_ref,
        providerPaymentId: r.payment_intent ?? r.charge ?? undefined,
        providerRefundId: r.id,
        refundRef: md.refund_ref,
        amount: r.amount,
        currency: upper(r.currency),
      };
    }

    if (t === 'charge.refunded') {
      // Fires whenever a refund is created (including partial ones), often while the refund is still
      // `pending` (UPI refunds settle asynchronously), and amount_refunded is cumulative, not this
      // refund's amount. So it is NOT a refund.processed signal: subscribe to refund.updated /
      // refund.failed, which carry the final status and our refund_ref. Informational only here.
      const c = obj as unknown as StripeCharge;
      return {
        ...base,
        type: 'unknown',
        orderRef: md.order_ref,
        providerPaymentId: c.payment_intent ?? c.id,
        currency: upper(c.currency),
      };
    }

    if (t === 'charge.dispute.created') {
      const d = obj as { id: string; amount?: number; currency?: string; charge?: string; payment_intent?: string | null };
      return {
        ...base,
        type: 'dispute.created',
        orderRef: md.order_ref,
        providerPaymentId: d.payment_intent ?? d.charge,
        amount: d.amount,
        currency: upper(d.currency),
      };
    }

    if (t.startsWith('customer.subscription.')) {
      const sub = obj as unknown as StripeSubscription;
      const prevStatus = event.data.previous_attributes?.status;
      let type: WebhookEventType = 'unknown';
      if (t === 'customer.subscription.deleted') type = 'subscription.cancelled';
      else if (t === 'customer.subscription.paused') type = 'subscription.halted';
      else if (t === 'customer.subscription.resumed') type = 'subscription.activated';
      else if (t === 'customer.subscription.created') type = sub.status === 'active' || sub.status === 'trialing' ? 'subscription.activated' : 'unknown';
      else if (t === 'customer.subscription.updated' && prevStatus !== undefined && prevStatus !== sub.status) {
        // Only status transitions are meaningful; updated also fires for metadata/price edits.
        const ms = mapSubscriptionStatus(sub.status);
        type = ms === 'active' ? 'subscription.activated' : ms === 'halted' ? 'subscription.halted' : ms === 'cancelled' ? 'subscription.cancelled' : 'unknown';
      }
      return { ...base, type, orderRef: md.subscription_ref ?? md.order_ref, providerOrderId: sub.id };
    }

    if (t === 'invoice.paid') {
      const inv = obj as {
        id: string;
        amount_paid?: number;
        currency?: string;
        subscription?: string | null;
        parent?: { subscription_details?: { subscription?: string; metadata?: Record<string, string> } } | null;
        subscription_details?: { metadata?: Record<string, string> } | null;
      };
      // Pre-basil versions have invoice.subscription; basil+ moved it under parent.subscription_details.
      const subId = inv.parent?.subscription_details?.subscription ?? inv.subscription ?? undefined;
      const subMd = inv.parent?.subscription_details?.metadata ?? inv.subscription_details?.metadata ?? {};
      return {
        ...base,
        type: subId ? 'subscription.charged' : 'payment.succeeded',
        orderRef: subMd.subscription_ref ?? md.order_ref,
        providerOrderId: subId ?? inv.id,
        status: 'captured',
        amount: inv.amount_paid,
        currency: upper(inv.currency),
      };
    }

    if (t === 'payout.paid') {
      const po = obj as unknown as StripePayout;
      return { ...base, type: 'settlement.processed', amount: po.amount, currency: upper(po.currency) };
    }

    return base;
  }

  async simulateWebhook(input: SimulateWebhookInput): Promise<SimulatedWebhook> {
    if (!this.creds.webhookSecret) {
      throw new PaymentError('CONFIG_MISSING', 'Set STRIPE_WEBHOOK_SECRET to simulate signed webhooks.', { provider: 'stripe' });
    }
    const now = Math.floor(this.ctx.now().getTime() / 1000);
    const currency = (input.currency ?? 'INR').toLowerCase();
    const sim = () => randomUUID().replace(/-/g, '').slice(0, 24);
    const piId = input.providerPaymentId ?? `pi_sim${sim()}`;

    let type: string;
    let object: Record<string, unknown>;
    if (input.type === 'payment.succeeded') {
      type = 'checkout.session.completed';
      object = {
        id: `cs_test_sim${sim()}`,
        object: 'checkout.session',
        mode: 'payment',
        status: 'complete',
        payment_status: 'paid',
        amount_total: input.amount,
        currency,
        client_reference_id: input.orderRef,
        metadata: { order_ref: input.orderRef },
        payment_intent: piId,
        livemode: false,
      };
    } else if (input.type === 'payment.failed') {
      type = 'payment_intent.payment_failed';
      object = {
        id: piId,
        object: 'payment_intent',
        amount: input.amount,
        currency,
        status: 'requires_payment_method',
        metadata: { order_ref: input.orderRef },
        last_payment_error: { code: 'card_declined', message: 'Your card was declined. (simulated)' },
        livemode: false,
      };
    } else {
      type = 'refund.updated';
      object = {
        id: `re_sim${sim()}`,
        object: 'refund',
        amount: input.amount,
        currency,
        status: 'succeeded',
        payment_intent: piId,
        metadata: { order_ref: input.orderRef, refund_ref: input.refundRef ?? '' },
      };
    }
    const rawBody = JSON.stringify({
      id: `evt_sim${sim()}`,
      object: 'event',
      api_version: STRIPE_API_VERSION,
      created: now,
      livemode: false,
      type,
      data: { object },
    });
    return {
      provider: 'stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${now},v1=${stripeWebhookSignature(now, rawBody, this.creds.webhookSecret)}`,
      },
      rawBody,
      description: `Stripe ${type} webhook signed with STRIPE_WEBHOOK_SECRET.`,
    };
  }

  async createCustomer(input: CreateCustomerInput): Promise<CustomerResult> {
    const { data } = await this.call<{ id: string }>('POST', '/customers', 'create_customer', {
      body: { name: input.name, email: input.email, phone: input.phone, metadata: input.metadata },
    });
    return { provider: 'stripe', providerCustomerId: data.id, raw: data };
  }

  /**
   * Checkout Session in subscription mode: Stripe collects the payment method (and, for Indian
   * cards/UPI, registers the RBI e-mandate with AFA) and creates the subscription on completion.
   */
  async createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionResult> {
    assertClientReferenceId(input.subscriptionRef, 'subscriptionRef');
    if (!input.returnUrl) {
      throw new PaymentError('VALIDATION', 'Stripe subscriptions via Checkout need returnUrl.', { provider: 'stripe' });
    }
    let lineItem: Record<string, unknown>;
    if (input.providerPlanId) {
      lineItem = { price: input.providerPlanId, quantity: 1 };
    } else if (input.plan) {
      assertMinorUnits(input.plan.amount, 'plan.amount');
      lineItem = {
        price_data: {
          currency: (input.plan.currency ?? 'INR').toLowerCase(),
          unit_amount: input.plan.amount,
          recurring: { interval: input.plan.interval, interval_count: input.plan.intervalCount ?? 1 },
          product_data: { name: input.plan.name },
        },
        quantity: 1,
      };
    } else {
      throw new PaymentError('VALIDATION', 'Pass providerPlanId (a Stripe price_... id) or plan to create a Stripe subscription.', { provider: 'stripe' });
    }
    const metadata = { subscription_ref: input.subscriptionRef, ...(input.metadata ?? {}) };
    // totalCount is ignored: Stripe subscriptions run until cancelled (use cancel_at via providerOptions.subscription_data).
    const body = deepMerge(
      {
        mode: 'subscription',
        line_items: [lineItem],
        success_url: withSessionIdParam(input.returnUrl),
        cancel_url: input.returnUrl,
        client_reference_id: input.subscriptionRef,
        customer: input.providerCustomerId,
        customer_email: input.providerCustomerId ? undefined : input.customer?.email,
        billing_address_collection: 'required',
        metadata,
        subscription_data: { metadata },
      },
      input.providerOptions,
    );
    const { data: session } = await this.call<StripeCheckoutSession>('POST', '/checkout/sessions', 'create_subscription_checkout', {
      body,
      idempotencyKey: `subscription_session:${input.subscriptionRef}`,
    });
    return {
      provider: 'stripe',
      subscriptionRef: input.subscriptionRef,
      // The sub_ id only exists after the customer completes Checkout (see capabilities notes).
      providerSubscriptionId: strOrId(session.subscription) ?? session.id,
      status: 'pending_authorization',
      checkout: session.url ? { type: 'redirect', url: session.url, method: 'GET' } : undefined,
      raw: session,
    };
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<SubscriptionResult> {
    const id = input.providerSubscriptionId;
    if (id.startsWith('cs_')) {
      // Customer never finished Checkout: expire the Session so it can't be completed later.
      const { data: s } = await this.call<StripeCheckoutSession>('POST', `/checkout/sessions/${encodeURIComponent(id)}/expire`, 'expire_checkout_session', {
        idempotencyKey: `expire:${id}`,
      });
      return { provider: 'stripe', subscriptionRef: s.client_reference_id ?? s.metadata?.subscription_ref ?? '', providerSubscriptionId: s.id, status: 'cancelled', raw: s };
    }
    const { data } = input.atCycleEnd
      ? await this.call<StripeSubscription>('POST', `/subscriptions/${encodeURIComponent(id)}`, 'cancel_subscription_at_period_end', {
          body: { cancel_at_period_end: true },
          idempotencyKey: `cancel_at_period_end:${id}`,
        })
      : await this.call<StripeSubscription>('DELETE', `/subscriptions/${encodeURIComponent(id)}`, 'cancel_subscription');
    return {
      provider: 'stripe',
      subscriptionRef: data.metadata?.subscription_ref ?? '',
      providerSubscriptionId: data.id,
      status: mapSubscriptionStatus(data.status),
      raw: data,
    };
  }

  /** Stripe "settlements" are payouts of the Stripe balance to the merchant's bank account. */
  async listSettlements(input: ListSettlementsInput): Promise<ListSettlementsResult> {
    const q = new URLSearchParams();
    if (input.from) q.set('arrival_date[gte]', String(Math.floor(Date.parse(input.from) / 1000)));
    if (input.to) q.set('arrival_date[lte]', String(Math.floor(Date.parse(input.to) / 1000) + 86399));
    q.set('limit', String(Math.min(input.count ?? 25, 100)));
    const { data } = await this.call<{ data: StripePayout[] }>('GET', '/payouts', 'list_payouts', { query: q });
    return {
      provider: 'stripe',
      items: data.data.map((p) => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency.toUpperCase(),
        status: p.status,
        utr: p.trace_id?.value ?? undefined,
        settledAt: new Date(p.arrival_date * 1000).toISOString(),
      })),
      raw: data,
    };
  }
}

export const stripe: ProviderModule<StripeCredentials> = {
  id: 'stripe',
  capabilities: stripeCapabilities,
  create(creds, ctx) {
    if (!creds.secretKey) {
      throw new PaymentError('CONFIG_MISSING', 'Stripe needs STRIPE_SECRET_KEY.', {
        provider: 'stripe',
        hint: 'Dashboard > Developers > API keys. Use sk_test_ keys in sandbox.',
      });
    }
    const key = creds.secretKey;
    const isTest = /^(sk|rk)_test_/.test(key);
    const isLive = /^(sk|rk)_live_/.test(key);
    if (!isTest && !isLive) {
      throw new PaymentError('CONFIG_INVALID', 'STRIPE_SECRET_KEY must start with sk_test_, sk_live_, rk_test_ or rk_live_.', {
        provider: 'stripe',
        hint: 'pk_... is the publishable key; put it in STRIPE_PUBLISHABLE_KEY instead.',
      });
    }
    if (ctx.environment === 'live' && isTest) {
      throw new PaymentError('CONFIG_INVALID', 'PAYMENTS_MODE=live but STRIPE_SECRET_KEY is a test key.', { provider: 'stripe' });
    }
    if (ctx.environment === 'sandbox' && isLive) {
      throw new PaymentError('CONFIG_INVALID', 'PAYMENTS_MODE=sandbox but STRIPE_SECRET_KEY is a live key. Refusing to move real money in sandbox mode.', { provider: 'stripe' });
    }
    const pk = creds.publishableKey;
    if (pk && ((ctx.environment === 'live' && pk.startsWith('pk_test_')) || (ctx.environment === 'sandbox' && pk.startsWith('pk_live_')))) {
      throw new PaymentError('CONFIG_INVALID', `STRIPE_PUBLISHABLE_KEY does not match PAYMENTS_MODE (${ctx.environment}).`, { provider: 'stripe' });
    }
    return new StripeGateway(creds as Required<Pick<StripeCredentials, 'secretKey'>> & StripeCredentials, ctx);
  },
  extractError(data) {
    const e = (data as { error?: { code?: string; type?: string; message?: string; decline_code?: string } })?.error;
    return { code: e?.code ?? e?.decline_code ?? e?.type, message: e?.message };
  },
};
