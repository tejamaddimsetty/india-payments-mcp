import { randomUUID } from 'node:crypto';
import type { AdapterContext, PaymentGateway, ProviderModule } from '../../core/gateway.js';
import { PaymentError } from '../../core/errors.js';
import { getHeader, safeEqual, sha256Hex } from '../../core/crypto.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../../core/http.js';
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
import { phonepeCapabilities } from './capabilities.js';

export interface PhonepeCredentials {
  clientId?: string;
  clientSecret?: string;
  clientVersion?: string;
  webhookUsername?: string;
  webhookPassword?: string;
}

/**
 * Standard Checkout v2. Sandbox serves OAuth and payments from one prefix; production splits
 * OAuth (identity-manager) from payments (pg). Legacy v1 (api.phonepe.com/apis/hermes, X-VERIFY
 * checksum = sha256hex(base64Payload + apiPath + saltKey) + "###" + saltIndex) is deprecated and
 * deliberately not supported.
 */
export const PHONEPE_HOSTS = {
  sandbox: {
    token: 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token',
    api: 'https://api-preprod.phonepe.com/apis/pg-sandbox',
  },
  live: {
    token: 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token',
    api: 'https://api.phonepe.com/apis/pg',
  },
} as const;

const MIN_AMOUNT = 100;
/** Refresh this long before expires_at so a token never dies mid-request. */
const TOKEN_REFRESH_MARGIN_S = 120;
/** Used only if the token response carries neither expires_at nor expires_in. */
const TOKEN_FALLBACK_TTL_S = 300;
const ORDER_REF_RE = /^[A-Za-z0-9_-]{1,63}$/;

/**
 * Webhook Authorization header value: lowercase hex SHA-256 of "username:password".
 * It is a static shared secret, not a signature over the body.
 */
export function phonepeWebhookAuthorization(username: string, password: string): string {
  return sha256Hex(`${username}:${password}`);
}

interface PpTokenResponse {
  access_token: string;
  token_type?: string;
  issued_at?: number;
  /** Epoch seconds. */
  expires_at?: number;
  expires_in?: number;
}

interface PpCreateResponse {
  orderId: string;
  state: string;
  /** Epoch milliseconds. */
  expireAt?: number;
  redirectUrl: string;
}

interface PpPaymentDetail {
  paymentMode?: string;
  transactionId?: string;
  /** Epoch milliseconds. */
  timestamp?: number;
  amount?: number;
  state?: string;
  errorCode?: string;
  detailedErrorCode?: string;
}

interface PpOrderStatus {
  orderId?: string;
  merchantOrderId?: string;
  state: string;
  amount?: number;
  expireAt?: number;
  errorCode?: string;
  detailedErrorCode?: string;
  metaInfo?: Record<string, string>;
  paymentDetails?: PpPaymentDetail[];
}

interface PpRefund {
  refundId?: string;
  merchantRefundId?: string;
  originalMerchantOrderId?: string;
  amount?: number;
  state: string;
  errorCode?: string;
  detailedErrorCode?: string;
}

/** COMPLETED / FAILED / PENDING. A PENDING order with no payment attempt yet is just "created". */
export function mapPhonepeOrderState(state: string | undefined, attempts = 0): PaymentStatus {
  switch (state) {
    case 'COMPLETED':
      return 'captured';
    case 'FAILED':
      return 'failed';
    case 'PENDING':
      return attempts > 0 ? 'pending' : 'created';
    default:
      return 'unknown';
  }
}

function mapRefundState(s: string | undefined): RefundStatus {
  // CONFIRMED appears in custom-checkout docs: accepted by PhonePe, not yet credited.
  if (s === 'COMPLETED') return 'processed';
  if (s === 'PENDING' || s === 'CONFIRMED') return 'pending';
  if (s === 'FAILED') return 'failed';
  return 'unknown';
}

/** UPI_INTENT / UPI_COLLECT / UPI_QR / CARD / TOKEN / NET_BANKING -> our method vocabulary. */
function mapPaymentMode(mode: string | undefined): string | undefined {
  if (!mode) return undefined;
  const m = mode.toUpperCase();
  if (m.startsWith('UPI')) return 'upi';
  if (m === 'CARD' || m === 'TOKEN') return 'card';
  if (m === 'NET_BANKING' || m === 'NETBANKING') return 'netbanking';
  return mode.toLowerCase();
}

function latestAttempt(details: PpPaymentDetail[] | undefined): PpPaymentDetail | undefined {
  if (!details?.length) return undefined;
  return [...details].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0];
}

/** metadata -> metaInfo. Keys already named udf1..udf15 pass through; others fill free udf1..udf5 slots. */
function toMetaInfo(metadata: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!metadata || Object.keys(metadata).length === 0) return undefined;
  const out: Record<string, string> = {};
  const rest: string[] = [];
  for (const [k, v] of Object.entries(metadata)) {
    if (/^udf([1-9]|1[0-5])$/.test(k)) out[k] = v;
    else rest.push(v);
  }
  for (let i = 1; i <= 5 && rest.length > 0; i++) {
    if (!(`udf${i}` in out)) out[`udf${i}`] = rest.shift()!;
  }
  if (rest.length > 0) {
    throw new PaymentError('VALIDATION', 'PhonePe metaInfo holds at most 5 free-form values (udf1..udf5).', {
      provider: 'phonepe',
      hint: 'Name keys udf1..udf5 explicitly, or pack several values into one.',
    });
  }
  // Initiate Payment reference: udf1-10 max 256 chars, no charset rule; udf11-15 max 50 chars of
  // alphanumerics plus _-+@.
  for (const [k, v] of Object.entries(out)) {
    const n = Number(k.slice(3));
    const ok = n <= 10 ? v.length <= 256 : /^[A-Za-z0-9_\-+@.]{0,50}$/.test(v);
    if (!ok) {
      throw new PaymentError('VALIDATION', `PhonePe metaInfo.${k} is invalid: ${n <= 10 ? 'max 256 characters' : 'max 50 characters of letters, digits and _-+@.'}.`, {
        provider: 'phonepe',
        hint: n <= 10 ? 'Shorten the value.' : 'udf11..udf15 are restricted; put free text in udf1..udf10 instead.',
      });
    }
  }
  return out;
}

function assertAmount(amount: number, field: string): void {
  if (!Number.isInteger(amount) || amount < MIN_AMOUNT) {
    throw new PaymentError('VALIDATION', `PhonePe ${field} must be an integer number of paise, at least ${MIN_AMOUNT}. Got ${amount}.`, {
      provider: 'phonepe',
      hint: 'Rs 499.00 is 49900. PhonePe rejects anything below Rs 1.',
    });
  }
}

function assertRef(ref: string, field: string): void {
  if (!ORDER_REF_RE.test(ref)) {
    throw new PaymentError('VALIDATION', `PhonePe ${field} must be 1-63 characters of letters, digits, "_" or "-". Got "${ref}".`, { provider: 'phonepe' });
  }
}

class PhonepeGateway implements PaymentGateway {
  readonly id = 'phonepe' as const;
  readonly environment;
  private readonly http: HttpClient;
  private readonly hosts: (typeof PHONEPE_HOSTS)['sandbox' | 'live'];
  private token?: { value: string; expiresAt: number };
  /** Single-flight: concurrent callers share one in-progress token request. */
  private tokenInFlight?: Promise<string>;

  constructor(
    private readonly creds: Required<Pick<PhonepeCredentials, 'clientId' | 'clientSecret' | 'clientVersion'>> & PhonepeCredentials,
    private readonly ctx: AdapterContext,
  ) {
    this.environment = ctx.environment;
    this.http = ctx.http;
    this.hosts = PHONEPE_HOSTS[ctx.environment];
  }

  capabilities() {
    return phonepeCapabilities;
  }

  private nowS(): number {
    return Math.floor(this.ctx.now().getTime() / 1000);
  }

  private async getToken(): Promise<string> {
    if (this.token && this.nowS() < this.token.expiresAt - TOKEN_REFRESH_MARGIN_S) return this.token.value;
    this.tokenInFlight ??= this.fetchToken().finally(() => {
      this.tokenInFlight = undefined;
    });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.creds.clientId,
      client_version: this.creds.clientVersion,
      client_secret: this.creds.clientSecret,
      grant_type: 'client_credentials',
    });
    // Minting a token has no side effects, so retrying it is safe.
    const { data } = await this.http.request<PpTokenResponse>({
      method: 'POST',
      url: this.hosts.token,
      body,
      operation: 'oauth_token',
      retrySafe: true,
    });
    if (!data?.access_token) {
      throw new PaymentError('AUTH', 'PhonePe OAuth response did not contain an access_token.', { provider: 'phonepe', raw: data });
    }
    const expiresAt = data.expires_at ?? this.nowS() + (data.expires_in ?? TOKEN_FALLBACK_TTL_S);
    this.token = { value: data.access_token, expiresAt };
    return data.access_token;
  }

  /** Authenticated API call. On a 401 the cached token is dropped and the call retried once. */
  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    operation: string,
    body?: unknown,
    retrySafe = false,
  ): Promise<HttpResponse<T>> {
    const send = (token: string) => {
      const req: HttpRequest = {
        method,
        url: `${this.hosts.api}${path}`,
        headers: { Authorization: `O-Bearer ${token}` },
        body,
        operation,
        retrySafe,
      };
      return this.http.request<T>(req);
    };
    const token = await this.getToken();
    try {
      return await send(token);
    } catch (err) {
      // A 401 means the request was rejected before any processing, so even a non-idempotent
      // create is safe to resend with a fresh token.
      if (err instanceof PaymentError && err.httpStatus === 401) {
        if (this.token?.value === token) this.token = undefined;
        return send(await this.getToken());
      }
      throw err;
    }
  }

  private fetchOrderStatus(orderRef: string) {
    return this.call<PpOrderStatus>(
      'GET',
      `/checkout/v2/order/${encodeURIComponent(orderRef)}/status?details=false&errorContext=true`,
      'order_status',
      undefined,
      true,
    );
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const currency = input.currency ?? 'INR';
    if (currency !== 'INR') {
      throw new PaymentError('VALIDATION', `PhonePe only accepts INR. Got ${currency}.`, { provider: 'phonepe' });
    }
    assertRef(input.orderRef, 'orderRef (merchantOrderId)');
    assertAmount(input.amount, 'amount');
    if (!input.returnUrl) {
      throw new PaymentError('VALIDATION', 'PhonePe needs returnUrl: the customer is sent back there after the PayPage.', {
        provider: 'phonepe',
        hint: 'That redirect is unsigned; on landing, call payments_verify / payments_get_status with the orderRef.',
      });
    }
    const { expireAfter, ...extra } = input.providerOptions ?? {};
    if (expireAfter !== undefined && (typeof expireAfter !== 'number' || !Number.isInteger(expireAfter) || expireAfter < 300 || expireAfter > 3600)) {
      throw new PaymentError('VALIDATION', `PhonePe expireAfter must be an integer between 300 and 3600 seconds. Got ${String(expireAfter)}.`, { provider: 'phonepe' });
    }
    const metaInfo = toMetaInfo(input.metadata);
    const body: Record<string, unknown> = {
      merchantOrderId: input.orderRef,
      amount: input.amount,
      ...(expireAfter !== undefined ? { expireAfter } : {}),
      ...(metaInfo ? { metaInfo } : {}),
      paymentFlow: {
        type: 'PG_CHECKOUT',
        ...(input.description ? { message: input.description } : {}),
        merchantUrls: { redirectUrl: input.returnUrl },
      },
      ...(input.customer?.phone ? { prefillUserLoginDetails: { phoneNumber: input.customer.phone } } : {}),
      ...extra,
    };
    // /checkout/v2/pay is not documented as idempotent (re-using a progressed merchantOrderId is
    // assumed to be rejected, not replayed), so it is never auto-retried on network errors.
    const { data } = await this.call<PpCreateResponse>('POST', '/checkout/v2/pay', 'create_payment', body);

    return {
      provider: 'phonepe',
      environment: this.environment,
      orderRef: input.orderRef,
      providerOrderId: data.orderId,
      status: 'created',
      amount: input.amount,
      currency: 'INR',
      checkout: { type: 'redirect', url: data.redirectUrl, method: 'GET' },
      expiresAt: data.expireAt ? new Date(data.expireAt).toISOString() : undefined,
      raw: data,
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    // PhonePe's redirect to returnUrl carries no signed data. The only trustworthy answer is the
    // Order Status API, keyed by the merchant's own order id.
    const payloadRef = input.payload.merchantOrderId ?? input.payload.orderRef;
    const orderRef = input.orderRef ?? payloadRef;
    if (!orderRef) {
      return {
        valid: false,
        status: 'unknown',
        verifiedVia: 'status_api',
        reason: 'PhonePe redirects are unsigned and carry no order id. Pass orderRef (from your session or the returnUrl you built).',
        raw: input.payload,
      };
    }
    if (input.orderRef && payloadRef && payloadRef !== input.orderRef) {
      return {
        valid: false,
        status: 'unknown',
        verifiedVia: 'status_api',
        reason: `Callback is for merchantOrderId ${payloadRef}, not ${input.orderRef}.`,
        raw: input.payload,
      };
    }
    const status = await this.getPaymentStatus({ orderRef });
    if (input.expectedAmount !== undefined && status.amount !== input.expectedAmount) {
      return {
        valid: false,
        status: 'unknown',
        orderRef,
        providerOrderId: status.providerOrderId,
        verifiedVia: 'status_api',
        reason: `Amount mismatch: order is ${status.amount}, expected ${input.expectedAmount}`,
        raw: status.raw,
      };
    }
    return {
      // valid = the server-side lookup succeeded and matched. Only status 'captured' means paid.
      valid: true,
      status: status.status,
      orderRef,
      providerOrderId: status.providerOrderId,
      providerPaymentId: status.providerPaymentId,
      amount: status.amount,
      reason: status.failureReason,
      verifiedVia: 'status_api',
      raw: status.raw,
    };
  }

  async getPaymentStatus(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    const { data } = await this.fetchOrderStatus(input.orderRef);
    const latest = latestAttempt(data.paymentDetails);
    const status = mapPhonepeOrderState(data.state, data.paymentDetails?.length ?? 0);
    return {
      provider: 'phonepe',
      orderRef: input.orderRef,
      providerOrderId: data.orderId ?? input.providerOrderId,
      providerPaymentId: latest?.transactionId,
      status,
      amount: data.amount,
      currency: 'INR',
      method: mapPaymentMode(latest?.paymentMode),
      failureReason:
        status === 'failed'
          ? data.detailedErrorCode ?? data.errorCode ?? latest?.detailedErrorCode ?? latest?.errorCode
          : undefined,
      raw: data,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    assertRef(input.refundRef, 'refundRef (merchantRefundId)');
    let amount = input.amount;
    if (amount === undefined) {
      // PhonePe has no "full refund" shorthand: look up the order amount first.
      const status = await this.getPaymentStatus({ orderRef: input.orderRef });
      if (status.status !== 'captured' || status.amount === undefined) {
        throw new PaymentError('VALIDATION', `Cannot fully refund ${input.orderRef}: order is ${status.status}.`, {
          provider: 'phonepe',
          hint: 'Only COMPLETED orders can be refunded. Pass amount explicitly for a partial refund.',
        });
      }
      amount = status.amount;
    }
    assertAmount(amount, 'refund amount');
    // merchantRefundId de-duplicates on PhonePe's side, so a retry cannot refund twice.
    const { data } = await this.call<PpRefund>(
      'POST',
      '/payments/v2/refund',
      'create_refund',
      { merchantRefundId: input.refundRef, originalMerchantOrderId: input.orderRef, amount },
      true,
    );
    return {
      provider: 'phonepe',
      refundRef: input.refundRef,
      providerRefundId: data.refundId,
      status: mapRefundState(data.state),
      amount: data.amount ?? amount,
      raw: data,
    };
  }

  async getRefundStatus(input: RefundStatusInput): Promise<RefundResult> {
    const { data } = await this.call<PpRefund>(
      'GET',
      `/payments/v2/refund/${encodeURIComponent(input.refundRef)}/status`,
      'refund_status',
      undefined,
      true,
    );
    return {
      provider: 'phonepe',
      refundRef: input.refundRef,
      providerRefundId: data.refundId ?? input.providerRefundId,
      status: mapRefundState(data.state),
      amount: data.amount,
      raw: data,
    };
  }

  async parseWebhook(input: WebhookInput): Promise<NormalizedWebhookEvent> {
    if (!this.creds.webhookUsername || !this.creds.webhookPassword) {
      throw new PaymentError('CONFIG_MISSING', 'PHONEPE_WEBHOOK_USERNAME and PHONEPE_WEBHOOK_PASSWORD must be set to verify webhooks.', {
        provider: 'phonepe',
      });
    }
    // The documented sample is a bare 64-char hex digest (no "SHA256 " prefix), so none is accepted.
    const received = getHeader(input.headers, 'authorization')?.trim().toLowerCase();
    const expected = phonepeWebhookAuthorization(this.creds.webhookUsername, this.creds.webhookPassword);
    if (!safeEqual(expected, received)) {
      throw new PaymentError('SIGNATURE_INVALID', 'PhonePe webhook Authorization header does not match sha256(username:password).', {
        provider: 'phonepe',
        hint: 'Use the webhook username/password from the Business Dashboard, not the OAuth client secret.',
      });
    }
    let body: {
      event?: string;
      type?: string;
      payload?: PpOrderStatus & PpRefund & { merchantId?: string; timestamp?: number };
    };
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      throw new PaymentError('VALIDATION', 'PhonePe webhook body is not valid JSON.', { provider: 'phonepe' });
    }
    // Some documented refund-completed samples (UPI, net banking) are flat: no event/payload
    // wrapper and no merchantRefundId. Fall back to the top-level body when payload is absent.
    type Payload = NonNullable<typeof body.payload>;
    const flat = body.payload === undefined && body !== null && typeof body === 'object' && ('state' in body || 'refundId' in body);
    const p: Payload = body.payload ?? (flat ? (body as unknown as Payload) : ({ state: '' } as Payload));
    // `event` is current; `type` is deprecated but still sent. A flat refund body carries neither,
    // so the event is inferred from its state.
    const flatRefund = flat && (p.refundId !== undefined || p.originalMerchantOrderId !== undefined);
    const event =
      body.event ??
      body.type ??
      (flatRefund && p.state === 'COMPLETED' ? 'pg.refund.completed' : flatRefund && p.state === 'FAILED' ? 'pg.refund.failed' : 'unknown');
    const typeMap: Record<string, WebhookEventType> = {
      'checkout.order.completed': 'payment.succeeded',
      'checkout.order.failed': 'payment.failed',
      'pg.refund.completed': 'refund.processed',
      'pg.refund.failed': 'refund.failed',
    };
    const type = typeMap[event] ?? 'unknown';
    const isRefund = event.startsWith('pg.refund.') || p.merchantRefundId !== undefined || flatRefund;
    const latest = latestAttempt(p.paymentDetails);

    // IMPORTANT: the Authorization header proves the sender knows the shared secret, but it does
    // not cover the body. `status` is reported as PhonePe sent it; confirm with getPaymentStatus
    // (payments_get_status) before fulfilling.
    return {
      provider: 'phonepe',
      // No event id is sent; event + PhonePe id + state is stable across PhonePe's retries.
      id: `${event}:${isRefund ? p.refundId ?? p.merchantRefundId : p.orderId ?? p.merchantOrderId}:${p.state}`,
      type,
      providerEventType: event,
      orderRef: isRefund ? p.originalMerchantOrderId : p.merchantOrderId,
      providerOrderId: isRefund ? undefined : p.orderId,
      providerPaymentId: latest?.transactionId,
      providerRefundId: isRefund ? p.refundId : undefined,
      refundRef: isRefund ? p.merchantRefundId : undefined,
      status: isRefund ? undefined : mapPhonepeOrderState(p.state, p.paymentDetails?.length ?? 0),
      amount: p.amount,
      currency: 'INR',
      occurredAt: latest?.timestamp ? new Date(latest.timestamp).toISOString() : p.timestamp ? new Date(p.timestamp).toISOString() : undefined,
      raw: body,
    };
  }

  async simulateWebhook(input: SimulateWebhookInput): Promise<SimulatedWebhook> {
    if (!this.creds.webhookUsername || !this.creds.webhookPassword) {
      throw new PaymentError('CONFIG_MISSING', 'Set PHONEPE_WEBHOOK_USERNAME and PHONEPE_WEBHOOK_PASSWORD to simulate webhooks.', { provider: 'phonepe' });
    }
    const nowMs = this.ctx.now().getTime();
    const transactionId = input.providerPaymentId ?? `OMSIM${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
    const paymentDetails = [
      {
        paymentMode: 'UPI_INTENT',
        transactionId,
        timestamp: nowMs,
        amount: input.amount,
        state: input.type === 'payment.failed' ? 'FAILED' : 'COMPLETED',
        ...(input.type === 'payment.failed' ? { errorCode: 'PAYMENT_DECLINED', detailedErrorCode: 'ZM' } : {}),
      },
    ];
    let event: string;
    let payload: Record<string, unknown>;
    if (input.type === 'refund.processed') {
      event = 'pg.refund.completed';
      payload = {
        merchantId: 'SIMULATED',
        merchantRefundId: input.refundRef ?? `RFSIM${nowMs}`,
        originalMerchantOrderId: input.orderRef,
        refundId: `OMRSIM${nowMs}`,
        state: 'COMPLETED',
        amount: input.amount,
        timestamp: nowMs,
        paymentDetails,
      };
    } else {
      event = input.type === 'payment.failed' ? 'checkout.order.failed' : 'checkout.order.completed';
      payload = {
        merchantId: 'SIMULATED',
        merchantOrderId: input.orderRef,
        orderId: `OMOSIM${nowMs}`,
        state: input.type === 'payment.failed' ? 'FAILED' : 'COMPLETED',
        amount: input.amount,
        expireAt: nowMs + 20 * 60 * 1000,
        metaInfo: {},
        paymentDetails,
      };
    }
    const rawBody = JSON.stringify({ event, payload });
    return {
      provider: 'phonepe',
      headers: {
        'content-type': 'application/json',
        authorization: phonepeWebhookAuthorization(this.creds.webhookUsername, this.creds.webhookPassword),
      },
      rawBody,
      description: `PhonePe ${event} webhook with Authorization = sha256(PHONEPE_WEBHOOK_USERNAME:PHONEPE_WEBHOOK_PASSWORD).`,
    };
  }
}

export const phonepe: ProviderModule<PhonepeCredentials> = {
  id: 'phonepe',
  capabilities: phonepeCapabilities,
  create(creds, ctx) {
    if (!creds.clientId || !creds.clientSecret || !creds.clientVersion) {
      throw new PaymentError('CONFIG_MISSING', 'PhonePe needs PHONEPE_CLIENT_ID, PHONEPE_CLIENT_SECRET and PHONEPE_CLIENT_VERSION.', {
        provider: 'phonepe',
        hint: 'Business Dashboard > Developer Settings (v2 OAuth credentials). Old merchant id + salt key (v1) credentials do not work.',
      });
    }
    // PhonePe client ids carry no reliable sandbox/live marker, so environment mismatches surface
    // as AUTH errors from the token endpoint rather than being caught here.
    return new PhonepeGateway(creds as Required<Pick<PhonepeCredentials, 'clientId' | 'clientSecret' | 'clientVersion'>>, ctx);
  },
  extractError(data) {
    // v2 errors: { code, message, context? }. OAuth errors may use { error, error_description }.
    const d = data as { code?: string; message?: string; error?: string; error_description?: string } | undefined;
    if (!d || typeof d !== 'object') return {};
    return { code: d.code ?? d.error, message: d.message ?? d.error_description };
  },
};
