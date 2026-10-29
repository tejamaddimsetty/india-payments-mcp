import { createHmac, randomUUID } from 'node:crypto';
import { getHeader, safeEqual } from '../../core/crypto.js';
import { PaymentError } from '../../core/errors.js';
import type { AdapterContext, PaymentGateway, ProviderModule } from '../../core/gateway.js';
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
import { dodoCapabilities } from './capabilities.js';

/**
 * Dodo Payments (Merchant of Record). Every path, field and enum here is from the per-endpoint
 * OpenAPI blocks on docs.dodopayments.com (spec 1.120.26); see docs/research/dodo-api-facts.md.
 *
 * Shape of an integration:
 *  - createPayment = POST /checkouts for ONE product (Dodo has no ad-hoc prices), redirect to checkout_url.
 *  - The return_url redirect is unsigned: verifyPayment re-reads GET /payments/{id}.
 *  - Webhooks follow Standard Webhooks.
 *  - There is no idempotency header, so POSTs are never retried by the HTTP client.
 */
export interface DodoCredentials {
  apiKey?: string;
  webhookKey?: string;
  defaultProductId?: string;
}

export const DODO_BASE_URLS = { sandbox: 'https://test.dodopayments.com', live: 'https://live.dodopayments.com' } as const;
/** "The Standard Webhooks libraries allow 5 minutes." */
export const DODO_WEBHOOK_TOLERANCE_SECONDS = 300;
/** Metadata limits (api-reference/metadata): keys <= 40 chars, string values <= 500, at most 50 pairs. */
const METADATA_MAX_KEYS = 50;
const METADATA_MAX_KEY = 40;
const METADATA_MAX_VALUE = 500;
const REFUND_REASON_MAX = 3000;
/** Standard Webhooks secrets are 24-64 bytes; a shorter key is a misconfiguration (and guessable). */
const MIN_WEBHOOK_KEY_BYTES = 24;
/** Discount codes and currency switching both default to on and change the total: off on our sessions. */
const SESSION_FLAGS = { allow_discount_code: false, allow_currency_selection: false };
/** Refund records fetched per payment when looking for a refundRef (Dodo lists refunds without metadata). */
const MAX_REFUND_LOOKUPS = 25;

interface DodoPrice {
  type?: 'one_time_price' | 'recurring_price' | 'usage_based_price';
  price?: number;
  currency?: string;
  discount_bps?: number | null;
  /** Deprecated whole-percent discount, still returned. */
  discount?: number | null;
  pay_what_you_want?: boolean | null;
  purchasing_power_parity?: boolean | null;
  tax_inclusive?: boolean | null;
}

interface DodoProduct {
  product_id: string;
  name?: string;
  is_recurring?: boolean;
  price?: DodoPrice;
  /** by_currency / by_country localized prices change what the buyer is charged. */
  pricing_mode?: string | null;
}

interface DodoCheckoutSession {
  session_id: string;
  checkout_url?: string | null;
}

interface DodoCheckoutStatus {
  id: string;
  payment_id?: string | null;
  payment_status?: string | null;
}

/** Refunds as listed on a payment: no metadata, so each is fetched to read its refund_ref. */
interface DodoRefundRef {
  refund_id: string;
  status?: string;
  amount?: number | null;
}

interface DodoPayment {
  payment_id: string;
  status?: string | null;
  total_amount: number;
  currency: string;
  tax?: number | null;
  metadata?: Record<string, unknown> | null;
  checkout_session_id?: string | null;
  payment_method?: string | null;
  payment_method_type?: string | null;
  error_message?: string | null;
  refund_status?: 'partial' | 'full' | null;
  refunds?: DodoRefundRef[] | null;
  product_cart?: Array<{ product_id: string; quantity?: number }> | null;
  subscription_id?: string | null;
}

interface DodoRefund {
  refund_id: string;
  payment_id: string;
  status: string;
  amount?: number | null;
  currency?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface DodoPayout {
  payout_id: string;
  amount: number;
  currency: string;
  status: string;
  fee?: number;
  tax?: number;
  updated_at?: string;
  created_at?: string;
}

interface DodoWebhookEnvelope {
  business_id?: string;
  type?: string;
  timestamp?: string;
  data?: Record<string, unknown> & { payload_type?: string };
}

/** IntentStatus -> ours. Dodo documents the names, not per-value meanings, so unclear ones are never "paid". */
export function mapDodoPaymentStatus(status: string | null | undefined, refundStatus?: string | null): PaymentStatus {
  switch (status) {
    case 'succeeded':
      return refundStatus === 'full' ? 'refunded' : refundStatus === 'partial' ? 'partially_refunded' : 'captured';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'processing':
    case 'requires_customer_action':
    case 'requires_merchant_action':
    case 'requires_payment_method':
    case 'requires_confirmation':
      return 'pending';
    case 'requires_capture':
    case 'partially_captured_and_capturable':
      return 'authorized';
    case null:
    case undefined:
      return 'created';
    default:
      // partially_captured and anything new: not provably fully paid.
      return 'unknown';
  }
}

export function mapDodoRefundStatus(status: string | null | undefined): RefundStatus {
  switch (status) {
    case 'succeeded':
      return 'processed';
    case 'failed':
      return 'failed';
    case 'pending':
    case 'review':
      return 'pending';
    default:
      return 'unknown';
  }
}

/** Standard Webhooks signing key: the secret without "whsec_", base64-decoded. */
export function dodoSigningKey(secret: string): Buffer {
  return Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
}

/** base64(HMAC-SHA256(key, `${id}.${timestamp}.${rawBody}`)), as in the webhook-signature `v1,` entry. */
export function dodoWebhookSignature(secret: string, id: string, timestamp: number | string, rawBody: string): string {
  return createHmac('sha256', dodoSigningKey(secret)).update(`${id}.${timestamp}.${rawBody}`, 'utf8').digest('base64');
}

const WEBHOOK_TYPES: Record<string, WebhookEventType> = {
  'payment.succeeded': 'payment.succeeded',
  'payment.failed': 'payment.failed',
  'payment.cancelled': 'payment.failed',
  'payment.processing': 'payment.pending',
  'refund.succeeded': 'refund.processed',
  'refund.failed': 'refund.failed',
  'subscription.active': 'subscription.activated',
  'subscription.renewed': 'subscription.charged',
  'subscription.on_hold': 'subscription.halted',
  'subscription.past_due': 'subscription.halted',
  'subscription.failed': 'subscription.halted',
  'subscription.cancelled': 'subscription.cancelled',
  'subscription.expired': 'subscription.cancelled',
  'dispute.opened': 'dispute.created',
  'payout.success': 'settlement.processed',
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/**
 * expected_amount / expected_currency we stored in the session metadata. Only meaningful once the payment
 * is bound to a session WE created: anyone can put any metadata on a payment of their own (static
 * payment links take metadata_<key>).
 */
const metaCurrency = (md: Record<string, unknown> | null | undefined): string | undefined => str(md?.expected_currency)?.toUpperCase();
const metaAmount = (md: Record<string, unknown> | null | undefined): number | undefined => {
  const v = md?.expected_amount;
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : num(v);
  return n !== undefined && Number.isSafeInteger(n) ? n : undefined;
};

function assertMetadata(md: Record<string, unknown>): void {
  const entries = Object.entries(md);
  if (entries.length > METADATA_MAX_KEYS) {
    throw new PaymentError('VALIDATION', `Dodo metadata allows at most ${METADATA_MAX_KEYS} keys (got ${entries.length}).`, { provider: 'dodo' });
  }
  for (const [k, v] of entries) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new PaymentError('VALIDATION', `Dodo metadata values must be strings, numbers or booleans ("${k}" is ${v === null ? 'null' : typeof v}).`, { provider: 'dodo' });
    }
    if (k.length > METADATA_MAX_KEY) throw new PaymentError('VALIDATION', `Dodo metadata key "${k.slice(0, 50)}" is longer than ${METADATA_MAX_KEY} characters.`, { provider: 'dodo' });
    if (typeof v === 'string' && v.length > METADATA_MAX_VALUE) {
      throw new PaymentError('VALIDATION', `Dodo metadata value for "${k}" is longer than ${METADATA_MAX_VALUE} characters.`, { provider: 'dodo' });
    }
  }
}

/**
 * The amount we bind to. As Merchant of Record Dodo may add tax on top of a tax-exclusive price, so the
 * charge matches when total_amount == expected (tax-inclusive) or total_amount - tax == expected.
 */
export function dodoMatchedAmount(p: Pick<DodoPayment, 'total_amount' | 'tax'>, expected: number | undefined): number {
  if (expected === undefined) return p.total_amount;
  if (p.total_amount === expected) return expected;
  const tax = num(p.tax) ?? 0;
  if (tax > 0 && p.total_amount - tax === expected) return expected;
  return p.total_amount;
}

class DodoGateway implements PaymentGateway {
  readonly id = 'dodo' as const;
  readonly environment;
  private readonly http: HttpClient;
  private readonly base: string;

  constructor(
    private readonly creds: Required<Pick<DodoCredentials, 'apiKey'>> & DodoCredentials,
    private readonly ctx: AdapterContext,
  ) {
    this.environment = ctx.environment;
    this.http = ctx.http;
    this.base = DODO_BASE_URLS[ctx.environment];
  }

  capabilities() {
    return dodoCapabilities;
  }

  /**
   * GETs are retried by the HTTP client. POSTs are not: Dodo documents no idempotency key, so a POST
   * that times out or gets a 5xx surfaces as OUTCOME_UNKNOWN. PATCH (set status) is idempotent.
   */
  private call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, operation: string, opts: { body?: unknown; query?: URLSearchParams } = {}) {
    const qs = opts.query && [...opts.query].length ? `?${opts.query}` : '';
    return this.http.request<T>({
      method,
      url: `${this.base}${path}${qs}`,
      headers: { Authorization: `Bearer ${this.creds.apiKey}` },
      body: opts.body,
      operation,
      retrySafe: method !== 'POST',
    });
  }

  private productId(options: Record<string, unknown> | undefined, field = 'providerOptions.productId'): string {
    const id = str(options?.productId) ?? this.creds.defaultProductId;
    if (!id) {
      throw new PaymentError('VALIDATION', `Dodo charges for a product you created in Dodo: pass ${field} or set DODO_PAYMENTS_DEFAULT_PRODUCT_ID.`, {
        provider: 'dodo',
        hint: 'Create the product in the Dodo dashboard (Products). For arbitrary amounts, create one pay-what-you-want product (USD/GBP/EUR).',
      });
    }
    return id;
  }

  private async fetchProduct(productId: string): Promise<DodoProduct> {
    return (await this.call<DodoProduct>('GET', `/products/${encodeURIComponent(productId)}`, 'fetch_product')).data;
  }

  /** The product must charge exactly `amount` in `currency`, or take `amount` as pay-what-you-want. */
  private checkPrice(product: DodoProduct, amount: number, currency: string): { pwyw: boolean } {
    const price = product.price ?? {};
    if (price.type !== 'one_time_price') {
      throw new PaymentError('VALIDATION', `Dodo product ${product.product_id} has a ${price.type ?? 'unknown'} price; createPayment needs a one-time price (use createSubscription for recurring products).`, { provider: 'dodo' });
    }
    if ((price.currency ?? '').toUpperCase() !== currency) {
      throw new PaymentError('VALIDATION', `Dodo product ${product.product_id} is priced in ${price.currency ?? '(none)'}, not ${currency}.`, {
        provider: 'dodo',
        hint: 'Use a product priced in the order currency.',
      });
    }
    if (price.pay_what_you_want) {
      if (price.price !== undefined && amount < price.price) {
        throw new PaymentError('VALIDATION', `Amount ${amount} is below the pay-what-you-want minimum ${price.price} of Dodo product ${product.product_id}.`, { provider: 'dodo' });
      }
      return { pwyw: true };
    }
    if (price.discount_bps || price.discount) {
      const pct = price.discount_bps ? price.discount_bps / 100 : price.discount;
      throw new PaymentError('VALIDATION', `Dodo product ${product.product_id} has a ${pct}% discount, so it would not charge exactly ${amount}.`, { provider: 'dodo', hint: 'Remove the product discount or pass the discounted amount.' });
    }
    if (price.purchasing_power_parity || product.pricing_mode) {
      throw new PaymentError('VALIDATION', `Dodo product ${product.product_id} uses ${price.purchasing_power_parity ? 'purchasing power parity' : `localized prices (${product.pricing_mode})`}, so buyers would not all pay exactly ${amount} ${currency}.`, {
        provider: 'dodo',
        hint: 'Use a product with one fixed price and no per-country pricing.',
      });
    }
    if (price.price !== amount) {
      throw new PaymentError('VALIDATION', `Dodo product ${product.product_id} costs ${price.price} ${currency} (minor units), not ${amount}. Dodo has no ad-hoc prices.`, {
        provider: 'dodo',
        hint: 'Pass the productId whose price is this amount, or use a pay-what-you-want product.',
      });
    }
    return { pwyw: false };
  }

  private customerBody(input: { customer?: CreatePaymentInput['customer']; providerCustomerId?: string }) {
    if (input.providerCustomerId) return { customer_id: input.providerCustomerId };
    const c = input.customer;
    if (!c?.email) return undefined;
    return { email: c.email, ...(c.name ? { name: c.name } : {}), ...(c.phone ? { phone_number: c.phone } : {}) };
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    assertMinorUnits(input.amount);
    const currency = (input.currency ?? 'INR').toUpperCase();
    const { productId: _p, ...extra } = input.providerOptions ?? {};
    const productId = this.productId(input.providerOptions);
    const product = await this.fetchProduct(productId);
    const { pwyw } = this.checkPrice(product, input.amount, currency);
    // order_ref is the binding key verifyPayment reads, expected_amount lets status lookups and webhooks
    // report the matched price when Dodo adds tax on top. Set last so input.metadata cannot override them.
    const metadata = { ...(input.metadata ?? {}), order_ref: input.orderRef, expected_amount: String(input.amount), expected_currency: currency };
    assertMetadata(metadata);
    const a = input.billingAddress;
    const body: Record<string, unknown> = {
      ...extra,
      product_cart: [{ product_id: productId, quantity: 1, ...(pwyw ? { amount: input.amount } : {}) }],
      ...(this.customerBody(input) ? { customer: this.customerBody(input) } : {}),
      ...(a?.country
        ? { billing_address: { country: a.country, ...(a.city ? { city: a.city } : {}), ...(a.state ? { state: a.state } : {}), ...(a.line1 ? { street: [a.line1, a.line2].filter(Boolean).join(', ') } : {}), ...(a.postalCode ? { zipcode: a.postalCode } : {}) } }
        : {}),
      ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
      feature_flags: SESSION_FLAGS,
      metadata,
    };
    const { data: session } = await this.call<DodoCheckoutSession>('POST', '/checkouts', 'create_checkout_session', { body });
    if (!session.checkout_url) {
      throw new PaymentError('PROVIDER_ERROR', 'Dodo returned a checkout session without checkout_url.', {
        provider: 'dodo',
        raw: session,
        hint: 'confirm / payment_method_id sessions have no checkout_url; those options are not supported here.',
      });
    }
    return {
      provider: 'dodo',
      environment: this.environment,
      orderRef: input.orderRef,
      providerOrderId: session.session_id,
      status: 'created',
      amount: input.amount,
      currency,
      checkout: { type: 'redirect', url: session.checkout_url, method: 'GET' },
      // Dodo: a checkout_url expires after 24 hours.
      expiresAt: new Date(this.ctx.now().getTime() + 24 * 3600_000).toISOString(),
      raw: session,
    };
  }

  private async fetchPayment(paymentId: string): Promise<DodoPayment> {
    return (await this.call<DodoPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`, 'fetch_payment')).data;
  }

  private async fetchCheckout(sessionId: string): Promise<DodoCheckoutStatus> {
    return (await this.call<DodoCheckoutStatus>('GET', `/checkouts/${encodeURIComponent(sessionId)}`, 'fetch_checkout_session')).data;
  }

  /**
   * Resolve the payment for an order. The session id we stored wins over a payment_id from the
   * browser: a payment_id that is not the session's own is refused.
   */
  private async resolvePayment(sessionId: string | undefined, paymentId: string | undefined): Promise<{ payment?: DodoPayment; session?: DodoCheckoutStatus }> {
    if (sessionId) {
      const session = await this.fetchCheckout(sessionId);
      const pid = str(session.payment_id);
      if (paymentId && pid && pid !== paymentId) {
        throw new PaymentError('VALIDATION', `Payment ${paymentId} does not belong to checkout session ${sessionId} (its payment is ${pid}).`, { provider: 'dodo' });
      }
      return { session, payment: pid ? await this.fetchPayment(pid) : undefined };
    }
    if (paymentId) return { payment: await this.fetchPayment(paymentId) };
    return {};
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const p = input.payload;
    const paymentId = str(p.payment_id);
    const sessionId = input.providerOrderId;
    // Anyone can create a Dodo payment carrying our order_ref (static payment links take metadata_<key>),
    // so the only binding we trust is the checkout session we created and stored.
    if (!sessionId) {
      return { valid: false, status: 'unknown', verifiedVia: 'status_api', reason: 'Pass providerOrderId: the cks_ checkout session id createPayment returned. Dodo payments are bound to that session, not to metadata.', raw: p };
    }
    let resolved;
    try {
      resolved = await this.resolvePayment(sessionId, paymentId);
    } catch (err) {
      if (err instanceof PaymentError && err.code === 'VALIDATION') return { valid: false, status: 'unknown', verifiedVia: 'status_api', reason: err.message, raw: p };
      throw err;
    }
    const pay = resolved.payment;
    if (!pay) {
      return { valid: true, status: 'created', providerOrderId: sessionId, verifiedVia: 'status_api', reason: 'The customer has not paid yet (no payment on the checkout session).', raw: resolved.session };
    }
    const orderRef = str(pay.metadata?.order_ref);
    const status = mapDodoPaymentStatus(pay.status, pay.refund_status);
    const amount = dodoMatchedAmount(pay, input.expectedAmount ?? metaAmount(pay.metadata));
    const base = { status, orderRef, providerOrderId: sessionId, providerPaymentId: pay.payment_id, amount, verifiedVia: 'status_api' as const, raw: pay };
    if (pay.checkout_session_id !== sessionId) {
      return { ...base, valid: false, reason: `Payment ${pay.payment_id} belongs to session ${pay.checkout_session_id ?? '(none)'}, not ${sessionId}` };
    }
    if (input.orderRef && orderRef !== input.orderRef) {
      return { ...base, valid: false, reason: `Payment ${pay.payment_id} belongs to order ${orderRef ?? '(none)'}, not ${input.orderRef}` };
    }
    const wantCurrency = metaCurrency(pay.metadata);
    if (wantCurrency && pay.currency.toUpperCase() !== wantCurrency) {
      return { ...base, valid: false, reason: `Currency mismatch: Dodo charged ${pay.currency}, the order is in ${wantCurrency} (Adaptive Currency?).` };
    }
    if (input.expectedAmount !== undefined && amount !== input.expectedAmount) {
      return { ...base, valid: false, reason: `Amount mismatch: Dodo charged ${pay.total_amount} ${pay.currency} (tax ${pay.tax ?? 0}), expected ${input.expectedAmount}. Discounts or Adaptive Currency change the total.` };
    }
    if (status !== 'captured') {
      return { ...base, valid: true, reason: `Payment is not complete (Dodo status ${pay.status ?? 'none'}). Wait for the webhook or poll getPaymentStatus.` };
    }
    return { ...base, valid: true };
  }

  async getPaymentStatus(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    if (!input.providerOrderId && !input.providerPaymentId) {
      throw new PaymentError('VALIDATION', 'Dodo status lookup needs providerOrderId (the cks_ checkout session id from createPayment) or providerPaymentId (pay_...). Dodo cannot search by orderRef.', {
        provider: 'dodo',
        hint: 'Store providerOrderId next to your orderRef when you create the payment.',
      });
    }
    const { payment: pay, session } = await this.resolvePayment(input.providerOrderId, input.providerPaymentId);
    if (!pay) {
      return { provider: 'dodo', orderRef: input.orderRef, providerOrderId: input.providerOrderId, status: 'created', raw: session };
    }
    const owner = str(pay.metadata?.order_ref);
    if (owner !== input.orderRef) {
      throw new PaymentError('VALIDATION', `Dodo payment ${pay.payment_id} belongs to order ${owner ?? '(none: not created by this library)'}, not ${input.orderRef}.`, { provider: 'dodo' });
    }
    const wantCurrency = metaCurrency(pay.metadata);
    const currencyOk = !wantCurrency || pay.currency.toUpperCase() === wantCurrency;
    const status = mapDodoPaymentStatus(pay.status, pay.refund_status);
    return {
      provider: 'dodo',
      orderRef: owner,
      providerOrderId: str(pay.checkout_session_id) ?? input.providerOrderId,
      providerPaymentId: pay.payment_id,
      // Without providerOrderId this is bound by metadata only: use verifyPayment (session-bound) before fulfilling.
      status: currencyOk ? status : 'unknown',
      amount: dodoMatchedAmount(pay, metaAmount(pay.metadata)),
      currency: pay.currency,
      method: str(pay.payment_method_type) ?? str(pay.payment_method),
      failureReason: currencyOk ? str(pay.error_message) : `Currency mismatch: Dodo charged ${pay.currency}, the order is in ${wantCurrency}.`,
      raw: pay,
    };
  }

  /** Our refunds carry metadata.refund_ref; payments list refunds without metadata, so each is fetched. */
  private async findRefund(pay: DodoPayment, refundRef: string): Promise<DodoRefund | undefined> {
    const listed = pay.refunds ?? [];
    if (listed.length > MAX_REFUND_LOOKUPS) {
      throw new PaymentError('PROVIDER_ERROR', `Dodo payment ${pay.payment_id} has ${listed.length} refunds; refusing to scan them all for refundRef ${refundRef}.`, { provider: 'dodo', hint: 'Check refunds in the Dodo dashboard.' });
    }
    for (const r of listed) {
      const full = (await this.call<DodoRefund>('GET', `/refunds/${encodeURIComponent(r.refund_id)}`, 'fetch_refund')).data;
      if (str(full.metadata?.refund_ref) === refundRef) return full;
    }
    return undefined;
  }

  /**
   * Amounts on the same scale verifyPayment uses: when Dodo added tax on top, refunding the whole charge
   * is reported as the price (what you passed), so retries and lookups compare like with like.
   */
  private refundResult(refundRef: string, r: DodoRefund, pay?: DodoPayment): RefundResult {
    let amount = num(r.amount);
    if (pay && amount === pay.total_amount) amount = dodoMatchedAmount(pay, metaAmount(pay.metadata));
    return { provider: 'dodo', refundRef, providerRefundId: r.refund_id, status: mapDodoRefundStatus(r.status), amount, raw: r };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const paymentId = input.providerPaymentId;
    if (!paymentId) {
      throw new PaymentError('VALIDATION', 'Dodo refunds need providerPaymentId (the payment_id from verifyPayment, getPaymentStatus or the payment webhook).', { provider: 'dodo' });
    }
    if (input.amount !== undefined) assertMinorUnits(input.amount);
    if (input.reason && input.reason.length > REFUND_REASON_MAX) {
      throw new PaymentError('VALIDATION', `Dodo refund reason is limited to ${REFUND_REASON_MAX} characters.`, { provider: 'dodo' });
    }
    const pay = await this.fetchPayment(paymentId);
    const owner = str(pay.metadata?.order_ref);
    if (owner !== input.orderRef) {
      throw new PaymentError('VALIDATION', `Dodo payment ${paymentId} belongs to order ${owner ?? '(none: not created by this library)'}, not ${input.orderRef}.`, {
        provider: 'dodo',
        hint: 'Refund payments not made through this library from the Dodo dashboard.',
      });
    }
    const price = dodoMatchedAmount(pay, metaAmount(pay.metadata));
    const taxOnTop = price !== pay.total_amount;
    // The total, or the price before the tax Dodo added on top (what verifyPayment reports), is a full refund.
    const full = input.amount === undefined || input.amount === pay.total_amount || input.amount === price;
    // No idempotency key on POST /refunds: a refund we already made for this refundRef is returned as is.
    const existing = await this.findRefund(pay, input.refundRef);
    if (existing) {
      const same = input.amount === undefined || existing.amount === input.amount || (full && existing.amount === pay.total_amount);
      if (num(existing.amount) !== undefined && !same) {
        throw new PaymentError('IDEMPOTENCY_CONFLICT', `Dodo refund ${existing.refund_id} for refundRef ${input.refundRef} is for ${existing.amount}, not ${input.amount}.`, { provider: 'dodo' });
      }
      return this.refundResult(input.refundRef, existing, pay);
    }
    let items: Array<{ item_id: string; amount: number }> | undefined;
    if (!full && taxOnTop) {
      // Partial item amounts are tax-inclusive by default, while our amounts are the price before tax:
      // the two scales would disagree, so only full refunds are allowed here.
      throw new PaymentError('VALIDATION', `Dodo added tax on top of payment ${paymentId} (total ${pay.total_amount}, price ${price}); partial refunds of such payments are not supported here.`, {
        provider: 'dodo',
        hint: 'Refund in full (omit amount), or make the partial refund in the Dodo dashboard.',
      });
    }
    if (!full) {
      const cart = pay.product_cart ?? [];
      if (cart.length !== 1) {
        throw new PaymentError('VALIDATION', `Dodo partial refunds are per item; payment ${paymentId} has ${cart.length} cart items, so only a full refund is supported here.`, { provider: 'dodo' });
      }
      items = [{ item_id: cart[0]!.product_id, amount: input.amount! }];
    }
    const body: Record<string, unknown> = {
      payment_id: paymentId,
      // Item amounts default to the settlement currency (usually USD); ours are in the payment currency.
      // Full refunds carry no amount, so no currency (Dodo can reject it, e.g. after credit line items).
      ...(items ? { items, currency: pay.currency } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      metadata: { refund_ref: input.refundRef, order_ref: input.orderRef },
    };
    // input.speed is ignored: Dodo has no refund speed option.
    const { data } = await this.call<DodoRefund>('POST', '/refunds', 'create_refund', { body });
    return this.refundResult(input.refundRef, data, pay);
  }

  async getRefundStatus(input: RefundStatusInput): Promise<RefundResult> {
    if (input.providerRefundId) {
      const r = (await this.call<DodoRefund>('GET', `/refunds/${encodeURIComponent(input.providerRefundId)}`, 'fetch_refund')).data;
      return this.refundResult(str(r.metadata?.refund_ref) ?? input.refundRef, r, await this.fetchPayment(r.payment_id));
    }
    if (input.providerPaymentId) {
      const pay = await this.fetchPayment(input.providerPaymentId);
      const r = await this.findRefund(pay, input.refundRef);
      if (!r) throw new PaymentError('NOT_FOUND', `No Dodo refund with metadata.refund_ref = ${input.refundRef} on ${input.providerPaymentId}.`, { provider: 'dodo' });
      return this.refundResult(input.refundRef, r, pay);
    }
    throw new PaymentError('VALIDATION', 'Dodo refund status needs providerRefundId, or providerPaymentId to find the refund by refundRef.', { provider: 'dodo' });
  }

  async parseWebhook(input: WebhookInput): Promise<NormalizedWebhookEvent> {
    if (!this.creds.webhookKey) {
      throw new PaymentError('CONFIG_MISSING', 'DODO_PAYMENTS_WEBHOOK_KEY is not set; cannot verify webhooks.', { provider: 'dodo' });
    }
    const id = getHeader(input.headers, 'webhook-id');
    const ts = getHeader(input.headers, 'webhook-timestamp');
    const sigHeader = getHeader(input.headers, 'webhook-signature');
    if (!id || !ts || !/^\d+$/.test(ts) || !sigHeader) {
      throw new PaymentError('SIGNATURE_INVALID', 'Dodo webhook is missing webhook-id, webhook-timestamp or webhook-signature.', { provider: 'dodo' });
    }
    const age = Math.abs(this.ctx.now().getTime() / 1000 - Number(ts));
    if (age > DODO_WEBHOOK_TOLERANCE_SECONDS) {
      throw new PaymentError('SIGNATURE_INVALID', `Dodo webhook timestamp is ${Math.round(age)} s from now (tolerance ${DODO_WEBHOOK_TOLERANCE_SECONDS} s).`, { provider: 'dodo' });
    }
    const expected = dodoWebhookSignature(this.creds.webhookKey, id, ts, input.rawBody);
    let matched = false;
    // Space-separated "v1,<base64>" entries; any match is valid (secret rotation). No early exit.
    for (const entry of sigHeader.split(' ')) {
      const comma = entry.indexOf(',');
      if (comma < 0 || entry.slice(0, comma) !== 'v1') continue;
      matched = safeEqual(expected, entry.slice(comma + 1)) || matched;
    }
    if (!matched) throw new PaymentError('SIGNATURE_INVALID', 'Dodo webhook signature mismatch.', { provider: 'dodo' });

    let env: DodoWebhookEnvelope;
    try {
      env = JSON.parse(input.rawBody) as DodoWebhookEnvelope;
    } catch {
      throw new PaymentError('VALIDATION', 'Dodo webhook body is not JSON.', { provider: 'dodo' });
    }
    const providerEventType = str(env.type) ?? 'unknown';
    const d = env.data ?? {};
    const md = (d.metadata ?? {}) as Record<string, unknown>;
    const type = WEBHOOK_TYPES[providerEventType] ?? 'unknown';
    const isPayment = providerEventType.startsWith('payment.');
    const isRefund = providerEventType.startsWith('refund.');
    return {
      provider: 'dodo',
      id,
      type,
      providerEventType,
      orderRef: str(md.order_ref),
      providerOrderId: str(d.checkout_session_id),
      providerPaymentId: str(d.payment_id),
      providerRefundId: isRefund ? str(d.refund_id) : undefined,
      refundRef: isRefund ? str(md.refund_ref) : undefined,
      // Refund events do not say whether the payment is now fully refunded: leave status unset.
      // A charge in another currency than the order's is never reported as captured.
      status: isPayment ? (metaCurrency(md) && str(d.currency)?.toUpperCase() !== metaCurrency(md) ? 'unknown' : mapDodoPaymentStatus(str(d.status), str(d.refund_status))) : undefined,
      amount: isPayment && num(d.total_amount) !== undefined ? dodoMatchedAmount({ total_amount: num(d.total_amount)!, tax: num(d.tax) }, metaAmount(md)) : isRefund ? num(d.amount) : undefined,
      currency: str(d.currency),
      occurredAt: str(env.timestamp),
      raw: env,
    };
  }

  async simulateWebhook(input: SimulateWebhookInput): Promise<SimulatedWebhook> {
    if (!this.creds.webhookKey) {
      throw new PaymentError('CONFIG_MISSING', 'DODO_PAYMENTS_WEBHOOK_KEY is not set; cannot sign a simulated webhook.', { provider: 'dodo' });
    }
    const currency = (input.currency ?? 'INR').toUpperCase();
    const paymentId = input.providerPaymentId ?? `pay_sim_${randomUUID().slice(0, 12)}`;
    const now = this.ctx.now();
    const envelope =
      input.type === 'refund.processed'
        ? {
            type: 'refund.succeeded',
            data: { payload_type: 'Refund', refund_id: `rfn_sim_${randomUUID().slice(0, 12)}`, payment_id: paymentId, status: 'succeeded', amount: input.amount, currency, metadata: { refund_ref: input.refundRef ?? `rf_${input.orderRef}`, order_ref: input.orderRef } },
          }
        : {
            type: input.type === 'payment.succeeded' ? 'payment.succeeded' : 'payment.failed',
            data: {
              payload_type: 'Payment',
              payment_id: paymentId,
              // Same shape as a payment from our own session, so generated handlers match it to the stored order.
              ...(input.providerOrderId ? { checkout_session_id: input.providerOrderId } : {}),
              status: input.type === 'payment.succeeded' ? 'succeeded' : 'failed',
              total_amount: input.amount,
              tax: 0,
              currency,
              metadata: { order_ref: input.orderRef, expected_amount: String(input.amount), expected_currency: currency },
            },
          };
    const rawBody = JSON.stringify({ business_id: 'bus_simulated', timestamp: now.toISOString(), ...envelope });
    const id = `msg_sim_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const ts = String(Math.floor(now.getTime() / 1000));
    return {
      provider: 'dodo',
      headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${dodoWebhookSignature(this.creds.webhookKey, id, ts, rawBody)}` },
      rawBody,
      description: `Dodo ${envelope.type} for ${input.orderRef}, signed with DODO_PAYMENTS_WEBHOOK_KEY (Standard Webhooks).`,
    };
  }

  async createCustomer(input: CreateCustomerInput): Promise<CustomerResult> {
    if (!input.name || !input.email) {
      throw new PaymentError('VALIDATION', 'Dodo customers need name and email.', { provider: 'dodo' });
    }
    const { data } = await this.call<{ customer_id: string }>('POST', '/customers', 'create_customer', {
      body: { name: input.name, email: input.email, ...(input.phone ? { phone_number: input.phone } : {}), ...(input.metadata ? { metadata: input.metadata } : {}) },
    });
    return { provider: 'dodo', providerCustomerId: data.customer_id, raw: data };
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionResult> {
    const productId = input.providerPlanId;
    if (!productId) {
      throw new PaymentError('VALIDATION', 'Dodo subscriptions need providerPlanId: the id of a recurring-price product created in Dodo. Plans cannot be created from `plan`.', { provider: 'dodo' });
    }
    const product = await this.fetchProduct(productId);
    if (product.price?.type !== 'recurring_price') {
      throw new PaymentError('VALIDATION', `Dodo product ${productId} has a ${product.price?.type ?? 'unknown'} price, not a recurring one.`, { provider: 'dodo' });
    }
    const { productId: _p, ...extra } = input.providerOptions ?? {};
    const metadata = { ...(input.metadata ?? {}), subscription_ref: input.subscriptionRef };
    assertMetadata(metadata);
    const customer = this.customerBody({ customer: input.customer, providerCustomerId: input.providerCustomerId });
    const { data: session } = await this.call<DodoCheckoutSession>('POST', '/checkouts', 'create_subscription_session', {
      body: {
        ...extra,
        product_cart: [{ product_id: productId, quantity: 1 }],
        ...(customer ? { customer } : {}),
        ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
        feature_flags: SESSION_FLAGS,
        metadata,
      },
    });
    return {
      provider: 'dodo',
      subscriptionRef: input.subscriptionRef,
      // The subscription id arrives on the return URL and the subscription.active webhook.
      providerSubscriptionId: session.session_id,
      status: 'pending_authorization',
      checkout: session.checkout_url ? { type: 'redirect', url: session.checkout_url, method: 'GET' } : undefined,
      raw: session,
    };
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<SubscriptionResult> {
    const id = input.providerSubscriptionId;
    if (id.startsWith('cks_')) {
      throw new PaymentError('VALIDATION', `${id} is a checkout session, not a subscription yet: nothing to cancel. The checkout link expires after 24 hours.`, {
        provider: 'dodo',
        hint: 'Use the subscription id from the return URL (subscription_id) or the subscription.active webhook.',
      });
    }
    const body = input.atCycleEnd ? { cancel_at_next_billing_date: true } : { status: 'cancelled', cancel_reason: 'cancelled_by_merchant' };
    const { data } = await this.call<{ subscription_id?: string; status?: string; metadata?: Record<string, unknown> }>('PATCH', `/subscriptions/${encodeURIComponent(id)}`, 'cancel_subscription', { body });
    const status = data.status === 'cancelled' ? 'cancelled' : data.status === 'active' ? 'active' : 'unknown';
    return { provider: 'dodo', subscriptionRef: str(data.metadata?.subscription_ref) ?? id, providerSubscriptionId: id, status, raw: data };
  }

  async listSettlements(input: ListSettlementsInput): Promise<ListSettlementsResult> {
    const iso = (v: string, endOfDay: boolean) => {
      const d = new Date(endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59.999Z` : v);
      if (Number.isNaN(d.getTime())) throw new PaymentError('VALIDATION', `"${v}" is not a date (use YYYY-MM-DD or ISO 8601).`, { provider: 'dodo' });
      return d.toISOString();
    };
    // Dodo pages GET /payouts (page_size default 10, max 100).
    const q = new URLSearchParams({ page_size: String(Math.min(Math.max(input.count ?? 100, 1), 100)), page_number: '0' });
    if (input.from) q.set('created_at_gte', iso(input.from, false));
    if (input.to) q.set('created_at_lte', iso(input.to, true));
    const { data } = await this.call<{ items: DodoPayout[] }>('GET', '/payouts', 'list_payouts', { query: q });
    const items = (data.items ?? []).slice(0, input.count ?? 100).map((p) => ({
      id: p.payout_id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      settledAt: p.status === 'success' ? p.updated_at : undefined,
      fees: p.fee,
      tax: p.tax,
    }));
    return { provider: 'dodo', items, raw: data };
  }
}

export const dodo: ProviderModule<DodoCredentials> = {
  id: 'dodo',
  capabilities: dodoCapabilities,
  create(creds, ctx) {
    if (!creds.apiKey) {
      throw new PaymentError('CONFIG_MISSING', 'DODO_PAYMENTS_API_KEY is not set.', { provider: 'dodo', hint: 'Dodo dashboard > Developer > API Keys (test mode for PAYMENTS_MODE=sandbox).' });
    }
    // Keys are mode-specific; older keys have no prefix and are accepted.
    if (ctx.environment === 'sandbox' && creds.apiKey.startsWith('dodo_live_')) {
      throw new PaymentError('CONFIG_INVALID', 'A dodo_live_ key with PAYMENTS_MODE=sandbox. Use a test-mode key (dodo_test_...).', { provider: 'dodo' });
    }
    if (ctx.environment === 'live' && creds.apiKey.startsWith('dodo_test_')) {
      throw new PaymentError('CONFIG_INVALID', 'A dodo_test_ key with PAYMENTS_MODE=live. Use a live-mode key (dodo_live_...).', { provider: 'dodo' });
    }
    if (creds.webhookKey && dodoSigningKey(creds.webhookKey).length < MIN_WEBHOOK_KEY_BYTES) {
      throw new PaymentError('CONFIG_INVALID', 'DODO_PAYMENTS_WEBHOOK_KEY is too short to be a webhook secret. Copy the whsec_... secret from the endpoint\'s Overview tab.', { provider: 'dodo' });
    }
    return new DodoGateway({ ...creds, apiKey: creds.apiKey }, ctx);
  },
  extractError(data) {
    const d = data as { code?: string; message?: string };
    return { code: d?.code, message: d?.message };
  },
  protectedOptionKeys: {
    // Change what is charged, to whom, or charge a saved method without the customer.
    // Also where the paid customer lands, and what the payment page shows or asks (phishing fields).
    payment: ['product_cart', 'customer', 'billing_currency', 'confirm', 'payment_method_id', 'discount_codes', 'discount_code', 'subscription_data', 'feature_flags', 'return_url', 'cancel_url', 'custom_fields', 'customization', 'product_collection_id', 'billing_address', 'tax_id'],
    subscription: ['product_cart', 'customer', 'billing_currency', 'confirm', 'payment_method_id', 'discount_codes', 'discount_code', 'subscription_data', 'mandate_min_amount_inr_paise', 'feature_flags', 'return_url', 'cancel_url', 'custom_fields', 'customization', 'product_collection_id', 'billing_address', 'tax_id'],
  },
};
