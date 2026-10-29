/**
 * Unified payment types shared by every provider adapter.
 *
 * Conventions (read these before writing an adapter):
 * - Amounts are ALWAYS integers in the currency's minor unit (paise for INR).
 *   Adapters convert to whatever the provider wants (e.g. "499.00" strings for PayU/CCAvenue/Paytm).
 * - `orderRef` is the merchant's own order id. It is the primary key callers use everywhere.
 *   Adapters must send it to the provider and map provider ids back to it.
 * - `raw` always carries the untouched provider response so nothing is hidden.
 */

export const PROVIDER_IDS = [
  'razorpay',
  'payu',
  'cashfree',
  'ccavenue',
  'paytm',
  'phonepe',
  'stripe',
  'skydo',
  'infinity',
  'dodo',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** `mock` never touches the network. `sandbox` and `live` call the provider's real endpoints. */
export type PaymentsMode = 'mock' | 'sandbox' | 'live';

/** The provider environment an adapter talks to. Mock mode adapters report `sandbox`. */
export type Environment = 'sandbox' | 'live';

export type PaymentStatus =
  | 'created' // order exists, customer has not paid yet
  | 'pending' // payment in flight (UPI collect pending, bank processing, etc.)
  | 'authorized' // authorised but not captured (card manual-capture flows)
  | 'captured' // money collected; this is "success"
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'refunded'
  | 'partially_refunded'
  | 'unknown';

export type RefundStatus = 'pending' | 'processed' | 'failed' | 'unknown';

export interface Customer {
  /** Merchant-side customer id. Required by Cashfree and Paytm; we generate one when absent. */
  id?: string;
  name?: string;
  email?: string;
  /** 10-digit Indian mobile number or E.164. Required by Cashfree. */
  phone?: string;
}

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface CreatePaymentInput {
  /** Merchant order id. 3-40 chars, [A-Za-z0-9_-]. Must be unique per attempt for most gateways. */
  orderRef: string;
  /** Integer minor units (paise). 49900 = Rs 499.00 */
  amount: number;
  /** ISO 4217. Defaults to INR. Many Indian gateways only accept INR. */
  currency?: string;
  customer?: Customer;
  billingAddress?: Address;
  description?: string;
  /** Where the customer's browser lands after paying (redirect/form-post gateways). */
  returnUrl?: string;
  /** Server-to-server notification URL, for gateways that take it per request. */
  notifyUrl?: string;
  /** Free-form key/values. Gateways cap these (Razorpay: 15 keys, PayU: udf1-5). */
  metadata?: Record<string, string>;
  idempotencyKey?: string;
  /** Escape hatch: passed through to the provider request body, merged last. */
  providerOptions?: Record<string, unknown>;
}

/**
 * What the caller must do next to collect the money. Every gateway falls into one of these shapes.
 */
export type CheckoutAction =
  | { type: 'redirect'; url: string; method: 'GET' }
  | { type: 'form_post'; url: string; fields: Record<string, string> }
  | {
      type: 'js_sdk';
      /** Which browser SDK to load. */
      sdk: 'razorpay' | 'cashfree' | 'stripe' | 'paytm';
      scriptUrl: string;
      /** Options object to hand to the SDK constructor/open call. Contains only publishable values. */
      options: Record<string, unknown>;
    }
  | { type: 'manual'; instructions: string; url?: string };

export interface CreatePaymentResult {
  provider: ProviderId;
  environment: Environment;
  orderRef: string;
  /** Provider-side id for the order/session/intent. Persist it next to orderRef. */
  providerOrderId: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  checkout: CheckoutAction;
  expiresAt?: string;
  raw: unknown;
}

export interface VerifyPaymentInput {
  /** The order the caller expects this callback to be for. Strongly recommended: prevents payload swapping. */
  orderRef?: string;
  /** Expected amount in minor units. When given, adapters must reject a mismatch. */
  expectedAmount?: number;
  /**
   * The provider order/subscription id YOU stored at createPayment time. Gateways whose signature
   * covers this id (Razorpay) compute it from this value, never from the browser payload.
   */
  providerOrderId?: string;
  /** Callback/redirect params exactly as received (query string or POST form fields, or JS SDK handler response). */
  payload: Record<string, string>;
}

export interface VerifyPaymentResult {
  /**
   * True if the callback is authentic (signature, decryption or status-API lookup) AND, when given,
   * orderRef/amount match. It does NOT mean the customer paid: a genuine "payment failed" callback is
   * valid. Check `paid` (or `status`) before fulfilling.
   */
  valid: boolean;
  /**
   * Set by PaymentsClient: valid && status is `captured` or `partially_refunded` && the callback was
   * bound to your orderRef and expectedAmount. The one field to check before fulfilling an order.
   * `authorized` is NOT paid (this library has no capture API, and uncaptured authorisations lapse:
   * enable auto-capture on Razorpay, and do not use manual capture on Stripe). A fully `refunded`
   * payment is NOT paid, so replaying an old success URL after a refund cannot re-fulfil an order.
   */
  paid?: boolean;
  status: PaymentStatus;
  orderRef?: string;
  providerOrderId?: string;
  providerPaymentId?: string;
  amount?: number;
  reason?: string;
  /**
   * How authenticity was established: a signature/hash (Razorpay, PayU, Paytm), decrypting the
   * AES-encrypted response (CCAvenue), or a server-side status lookup because the redirect is
   * unsigned (Cashfree, PhonePe, Stripe).
   */
  verifiedVia: 'signature' | 'status_api' | 'decryption' | 'manual_record';
  raw?: unknown;
}

export interface PaymentStatusInput {
  orderRef: string;
  /** Required by some gateways (Razorpay order id, Stripe PaymentIntent/Session id). */
  providerOrderId?: string;
  /** Optional extra key some gateways accept (CCAvenue reference_no). */
  providerPaymentId?: string;
}

export interface PaymentStatusResult {
  provider: ProviderId;
  orderRef: string;
  providerOrderId?: string;
  providerPaymentId?: string;
  status: PaymentStatus;
  amount?: number;
  amountRefunded?: number;
  currency?: string;
  /** upi | card | netbanking | wallet | emi | paylater | ... when the gateway tells us. */
  method?: string;
  failureReason?: string;
  raw: unknown;
}

export interface RefundInput {
  orderRef: string;
  /** Provider payment/transaction id. Required by Razorpay, PayU, Paytm, CCAvenue (reference_no), Stripe. */
  providerPaymentId?: string;
  /** Minor units. Omit for a full refund where the gateway supports it. */
  amount?: number;
  /** Merchant refund id. Doubles as idempotency key: re-sending the same refundRef must never refund twice. */
  refundRef: string;
  reason?: string;
  speed?: 'normal' | 'instant';
}

export interface RefundResult {
  provider: ProviderId;
  refundRef: string;
  providerRefundId?: string;
  status: RefundStatus;
  amount?: number;
  raw: unknown;
}

/**
 * Which ids each gateway needs: Razorpay: providerRefundId (rfnd_), or providerPaymentId (pay_) to find
 * it by refundRef. PayU: providerRefundId (request_id). Cashfree, Paytm, PhonePe: orderRef + refundRef
 * (PhonePe: refundRef alone). Stripe: providerRefundId (re_), or providerPaymentId (pi_/ch_).
 * CCAvenue: no refund-status lookup.
 */
export interface RefundStatusInput {
  refundRef: string;
  orderRef?: string;
  providerRefundId?: string;
  providerPaymentId?: string;
}

export interface WebhookInput {
  /** Header names are matched case-insensitively. */
  headers: Record<string, string | string[] | undefined>;
  /** The exact bytes received. NEVER re-serialise parsed JSON before verifying. */
  rawBody: string;
}

export type WebhookEventType =
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.pending'
  | 'payment.authorized'
  | 'refund.processed'
  | 'refund.failed'
  | 'subscription.activated'
  | 'subscription.charged'
  | 'subscription.halted'
  | 'subscription.cancelled'
  | 'dispute.created'
  | 'settlement.processed'
  | 'unknown';

export interface NormalizedWebhookEvent {
  provider: ProviderId;
  /** Stable dedupe key. Providers retry webhooks; store this and ignore repeats. */
  id: string;
  type: WebhookEventType;
  providerEventType: string;
  orderRef?: string;
  providerOrderId?: string;
  providerPaymentId?: string;
  providerRefundId?: string;
  refundRef?: string;
  /**
   * The PAYMENT's status as of this event. Rule for refund.* events: `status` is set only when the
   * event itself carries enough to tell a full from a partial refund (Razorpay: the payment entity;
   * Paytm: totalRefundAmount vs txnAmount), as `refunded` / `partially_refunded`; otherwise
   * (Cashfree, PhonePe, Stripe, mock) it is undefined. The refund's own outcome is `type`
   * (refund.processed / refund.failed). Call getPaymentStatus for the payment's state.
   */
  status?: PaymentStatus;
  amount?: number;
  currency?: string;
  occurredAt?: string;
  /**
   * Set by PaymentsClient. False when the gateway's webhook auth does not cover the body
   * (PhonePe's shared-secret header; CCAvenue's unauthenticated AES-CBC). For those, call
   * getPaymentStatus before fulfilling instead of trusting `status`/`amount` here.
   */
  bodyAuthenticated?: boolean;
  raw: unknown;
}

export interface CreateCustomerInput {
  name?: string;
  email?: string;
  phone?: string;
  metadata?: Record<string, string>;
}

export interface CustomerResult {
  provider: ProviderId;
  providerCustomerId: string;
  raw: unknown;
}

export interface CreateSubscriptionInput {
  /** Merchant subscription id. */
  subscriptionRef: string;
  /** Existing provider plan id. If absent, `plan` is used to create one first (where supported). */
  providerPlanId?: string;
  plan?: {
    name: string;
    amount: number;
    currency?: string;
    interval: 'day' | 'week' | 'month' | 'year';
    intervalCount?: number;
  };
  customer?: Customer;
  providerCustomerId?: string;
  /** Number of billing cycles. Razorpay requires this; Stripe ignores it (runs until cancelled). */
  totalCount?: number;
  returnUrl?: string;
  metadata?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
}

export interface SubscriptionResult {
  provider: ProviderId;
  subscriptionRef: string;
  /**
   * Stripe creates the real subscription only after checkout, so this can be a checkout session id
   * (cs_...) until the subscription webhook arrives with the sub_... id.
   */
  providerSubscriptionId: string;
  status: 'created' | 'pending_authorization' | 'active' | 'halted' | 'cancelled' | 'completed' | 'unknown';
  checkout?: CheckoutAction;
  raw: unknown;
}

export interface CancelSubscriptionInput {
  providerSubscriptionId: string;
  atCycleEnd?: boolean;
}

export interface ListSettlementsInput {
  /** ISO dates (inclusive). */
  from?: string;
  to?: string;
  count?: number;
}

export interface Settlement {
  id: string;
  amount: number;
  currency: string;
  status: string;
  utr?: string;
  settledAt?: string;
  fees?: number;
  tax?: number;
}

export interface ListSettlementsResult {
  provider: ProviderId;
  items: Settlement[];
  raw: unknown;
}

/** Test helper output: a webhook exactly as the provider would deliver it, correctly signed. */
export interface SimulatedWebhook {
  provider: ProviderId;
  headers: Record<string, string>;
  rawBody: string;
  description: string;
}

export interface SimulateWebhookInput {
  type: Extract<WebhookEventType, 'payment.succeeded' | 'payment.failed' | 'refund.processed'>;
  orderRef: string;
  amount: number;
  currency?: string;
  providerPaymentId?: string;
  refundRef?: string;
  /** The stored checkout session/order id, for gateways whose webhooks name it (Dodo: cks_...). */
  providerOrderId?: string;
}
