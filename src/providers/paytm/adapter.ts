import type { AdapterContext, PaymentGateway, ProviderModule } from '../../core/gateway.js';
import { PaymentError, type PaymentErrorCode } from '../../core/errors.js';
import type { HttpClient, HttpResponse } from '../../core/http.js';
import { assertMinorUnits, fromMajor, toMajorString } from '../../core/money.js';
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
import { paytmCapabilities } from './capabilities.js';
import { extractRawJsonMember, generateSignature, verifySignature } from './checksum.js';

export interface PaytmCredentials {
  mid?: string;
  merchantKey?: string;
  website?: string;
  /**
   * 'true' (default) or 'false'. 'false' skips the head.signature check on JSON API responses
   * (status, refund, refund status) ONLY. Refund webhooks are always verified. Escape hatch while the
   * signed-string format is confirmed in sandbox (verification round 2, P1).
   */
  verifyResponseSignature?: string;
}

/**
 * Paytm rebranded its hosts to paytmpayments.com. The legacy hosts (securegw-stage.paytm.in /
 * securegw.paytm.in) only appear in old docs. Initiate Transaction, JS Checkout, showPaymentPage and
 * /v3/order/status use these hosts (T-INIT, T-JSINV, T-JSVER; an unauthenticated probe showed
 * /v3/order/status answers on securestage.paytmpayments.com but returns 503 "no healthy upstream" on
 * securegw-stage.paytmpayments.in, so status stays here).
 */
export const PAYTM_STAGING_HOST = 'https://securestage.paytmpayments.com';
export const PAYTM_LIVE_HOST = 'https://secure.paytmpayments.com';

/**
 * Refund Apply (/refund/apply) and Refund Status (/v2/refund/status) are documented ONLY on the
 * securegw hosts: paytmpayments.com/docs/api/refund-api and /docs/api/refund-status-api list
 * https://securegw-stage.paytmpayments.in (staging) and https://securegw.paytmpayments.in (production).
 * The staging probe showed both staging hosts route these paths; we follow the docs. Confirm in a
 * sandbox run (verification round 1, M10).
 */
export const PAYTM_REFUND_STAGING_HOST = 'https://securegw-stage.paytmpayments.in';
export const PAYTM_REFUND_LIVE_HOST = 'https://securegw.paytmpayments.in';

/** custId: "Special characters allowed in CustId are @, ! ,=,_ ,$, ." (Initiate Transaction API). */
export function sanitizePaytmCustId(id: string): string {
  return id.replace(/[^A-Za-z0-9@!=_$.]/g, '_');
}

/**
 * Paytm orderId charset. The Initiate Transaction page says "alphanumeric", and its result-code
 * table has 1008 "Pipe character is not allowed". Paytm's long-standing integration guidance allows
 * the special characters @ - _ . in order ids, so those are accepted too; anything else (including
 * '|') is rejected before calling Paytm.
 */
const PAYTM_ORDER_ID_RE = /^[A-Za-z0-9@\-_.]+$/;

/**
 * userInfo.mobile is a "10-digit mobile number of user" (Initiate Transaction). Our Customer.phone may be
 * E.164 (+91...) or have a trunk 0. Digits only; a leading 91 (12 digits) or 0 (11 digits) is dropped.
 * Anything that is not then exactly 10 digits is not sent (the field is optional).
 */
export function normalizePaytmMobile(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  let d = phone.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^\d{10}$/.test(d) ? d : undefined;
}

/** Split a full name into Paytm's separate userInfo.firstName / lastName. */
export function splitPaytmName(name: string | undefined): { firstName?: string; lastName?: string } {
  const [firstName, ...rest] = (name ?? '').trim().split(/\s+/);
  return { firstName: firstName || undefined, lastName: rest.join(' ') || undefined };
}

/**
 * Refund Apply codes meaning "this refund request / refId was already sent" (T-REF): 617 "Refund Already
 * Raised", 671 "Refund retry is not supported with same refund id". The first attempt registered the
 * refund, so we report its state via refund status.
 * NOT here: 626 "Another Refund on same order is already in Progress, please retry after few minutes"
 * (retryable, see REFUND_IN_PROGRESS_CODE) and 629 "Refund is already Successful" (see
 * REFUND_ALREADY_SUCCESSFUL_CODE).
 */
const DUPLICATE_REFUND_CODES = new Set(['617', '671']);
const REFUND_IN_PROGRESS_CODE = '626';
const REFUND_ALREADY_SUCCESSFUL_CODE = '629';
/** v3 order status lookup errors (not a payment outcome): 334 invalid order id, 335 invalid MID, 330 checksum. */
const STATUS_LOOKUP_ERROR_CODES = new Set(['330', '334', '335']);
/** v2 refund status lookup errors: 631 record not found, 335 invalid MID, 600 invalid refund request, 330 checksum. */
const REFUND_STATUS_LOOKUP_ERROR_CODES = new Set(['330', '335', '600', '631']);
const MAX_REFUND_REF = 50;
const MAX_REFUND_COMMENTS = 500;

/** txnToken lifetime per the Initiate Transaction docs. */
const TXN_TOKEN_TTL_MS = 15 * 60 * 1000;

interface PaytmResultInfo {
  resultStatus?: string;
  resultCode?: string;
  resultMsg?: string;
}

interface PaytmEnvelope<B> {
  head?: { signature?: string; responseTimestamp?: string; version?: string };
  body: B;
}

interface PaytmInitiateBody {
  resultInfo: PaytmResultInfo;
  txnToken?: string;
}

interface PaytmStatusBody {
  resultInfo: PaytmResultInfo;
  txnId?: string;
  bankTxnId?: string;
  orderId?: string;
  txnAmount?: string;
  txnType?: string;
  gatewayName?: string;
  paymentMode?: string;
  refundAmt?: string;
  txnDate?: string;
}

interface PaytmRefundBody {
  resultInfo: PaytmResultInfo;
  orderId?: string;
  refId?: string;
  refundId?: string;
  txnId?: string;
  refundAmount?: string;
  totalRefundAmount?: string;
}

/** STATUS (callback/webhook) and resultStatus (v3 status API) share these values. */
export function mapPaytmTxnStatus(status: string | undefined, txnAmount?: number, refundedAmount?: number): PaymentStatus {
  switch (status) {
    case 'TXN_SUCCESS':
      if (refundedAmount && refundedAmount > 0) {
        return txnAmount !== undefined && refundedAmount < txnAmount ? 'partially_refunded' : 'refunded';
      }
      return 'captured';
    case 'TXN_FAILURE':
      return 'failed';
    case 'PENDING':
      return 'pending';
    // Status API returns this for an orderId Paytm has never seen a payment attempt for. (UNVERIFIED
    // whether an initiated-but-unpaid txnToken also lands here.)
    case 'NO_RECORD_FOUND':
      return 'created';
    default:
      return 'unknown';
  }
}

/** Status API paymentMode: CC, DC, NB, UPI, PPI (wallet), "Paytm Postpaid" / PAYTMCC (postpaid), EMI... */
export function mapPaytmPaymentMode(mode: string | undefined): string | undefined {
  if (!mode) return undefined;
  const m = mode.toUpperCase();
  if (m === 'CC' || m === 'DC') return 'card';
  if (m === 'NB') return 'netbanking';
  if (m === 'UPI') return 'upi';
  if (m === 'PPI') return 'wallet';
  // PAYTMCC is the GATEWAYNAME for Paytm Postpaid; the documented PAYMENTMODE sample is "Paytm Postpaid".
  if (m === 'PAYTMCC' || m === 'PAYTM POSTPAID' || m === 'POSTPAID') return 'paylater';
  if (m === 'EMI') return 'emi';
  return mode.toLowerCase();
}

/** Paytm timestamps ("yyyy-MM-dd HH:mm:ss.S") are IST wall-clock without an offset. */
function paytmTimeToIso(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = Date.parse(s.trim().replace(' ', 'T') + '+05:30');
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

interface PaytmRefundWebhookBody {
  mid?: string;
  orderId?: string;
  txnId?: string;
  txnAmount?: string;
  refId?: string;
  refundId?: string;
  refundAmount?: string;
  totalRefundAmount?: string;
  status?: string;
  txnTimestamp?: string;
  merchantRefundRequestTimestamp?: string;
  acceptRefundTimestamp?: string;
  userCreditInitiateTimestamp?: string;
  rejectRefundReasonCode?: string;
  rejectRefundReasonMessage?: string;
}

function mapRefundStatus(s: string | undefined): RefundStatus {
  if (s === 'TXN_SUCCESS') return 'processed';
  if (s === 'PENDING') return 'pending';
  if (s === 'TXN_FAILURE') return 'failed';
  return 'unknown';
}

/** Parse the S2S notification body: form-encoded (documented) or flat JSON (accepted too). */
function parseNotificationBody(rawBody: string): Record<string, string> {
  const trimmed = rawBody.trim();
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) out[k] = '';
      else if (typeof v === 'object') {
        throw new PaymentError('VALIDATION', `Paytm notification field ${k} is nested; expected flat key-value pairs.`, {
          provider: 'paytm',
          hint: 'Flat payment notifications (ORDERID, TXNID, STATUS, CHECKSUMHASH, ...) and {head, body} refund notifications are supported.',
        });
      } else out[k] = String(v);
    }
    return out;
  }
  return Object.fromEntries(new URLSearchParams(rawBody));
}

class PaytmGateway implements PaymentGateway {
  readonly id = 'paytm' as const;
  readonly environment;
  private readonly http: HttpClient;
  private readonly host: string;
  private readonly refundHost: string;
  private readonly website: string;
  /** false only when PAYTM_VERIFY_RESPONSE_SIGNATURE=false; never affects webhooks. */
  private readonly verifyResponses: boolean;

  constructor(
    private readonly creds: Required<Pick<PaytmCredentials, 'mid' | 'merchantKey'>> & PaytmCredentials,
    private readonly ctx: AdapterContext,
  ) {
    this.environment = ctx.environment;
    this.http = ctx.http;
    this.host = ctx.environment === 'live' ? PAYTM_LIVE_HOST : PAYTM_STAGING_HOST;
    this.refundHost = ctx.environment === 'live' ? PAYTM_REFUND_LIVE_HOST : PAYTM_REFUND_STAGING_HOST;
    this.website = creds.website || (ctx.environment === 'live' ? 'DEFAULT' : 'WEBSTAGING');
    this.verifyResponses = (creds.verifyResponseSignature ?? 'true').toLowerCase() !== 'false';
  }

  capabilities() {
    return paytmCapabilities;
  }

  /**
   * Every Paytm JSON API is `{body, head: {signature}}` where signature = checksum over
   * JSON.stringify(body). We serialise once and splice that exact string into the request so the
   * signed bytes and the sent bytes cannot drift.
   */
  private async signedPost<B>(path: string, body: Record<string, unknown>, operation: string, retrySafe: boolean, host = this.host) {
    const bodyJson = JSON.stringify(body);
    const signature = generateSignature(bodyJson, this.creds.merchantKey);
    const res = await this.http.request<PaytmEnvelope<B>>({
      method: 'POST',
      url: `${host}${path}`,
      headers: { 'Content-Type': 'application/json' },
      body: `{"body":${bodyJson},"head":${JSON.stringify({ signature })}}`,
      operation,
      retrySafe,
    });
    this.verifyResponseSignature(operation, res);
    return res;
  }

  /**
   * Paytm signs JSON responses with head.signature ("verify with the Paytm checksum library": status
   * and refund API docs), but no page names the signed string. We accept either candidate (see
   * paytmBodySignatureMatches). Some error responses carry no signature, so a missing one is tolerated
   * (TLS only); a present but non-matching one is rejected unless PAYTM_VERIFY_RESPONSE_SIGNATURE=false.
   */
  private verifyResponseSignature(operation: string, res: HttpResponse<PaytmEnvelope<unknown>>): void {
    if (!this.verifyResponses) return;
    const signature = typeof res.data === 'object' && res.data ? res.data.head?.signature : undefined;
    if (!signature) return;
    if (!paytmBodySignatureMatches(res.text, this.creds.merchantKey, signature)) {
      throw new PaymentError('SIGNATURE_INVALID', `paytm ${operation}: response head.signature does not match the body.`, {
        provider: 'paytm',
        raw: res.data,
        hint: 'The response may have been altered in transit, or PAYTM_MERCHANT_KEY does not belong to PAYTM_MID. If every signed response fails in sandbox, set PAYTM_VERIFY_RESPONSE_SIGNATURE=false temporarily and report it.',
      });
    }
  }

  private resultError(operation: string, info: PaytmResultInfo | undefined, raw: unknown, code?: PaymentErrorCode): PaymentError {
    // Checksum invalid: 330 on the status/refund APIs, 2005 on Initiate Transaction (T-INIT code table).
    const auth = info?.resultCode === '330' || info?.resultCode === '2005';
    return new PaymentError(code ?? (auth ? 'AUTH' : 'PROVIDER_ERROR'), `paytm ${operation} failed: ${info?.resultMsg ?? 'unknown error'}`, {
      provider: 'paytm',
      providerCode: info?.resultCode,
      providerMessage: info?.resultMsg,
      raw,
      hint: auth ? 'Check PAYTM_MERCHANT_KEY and that the MID matches the environment (staging vs production).' : undefined,
    });
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    assertMinorUnits(input.amount);
    const currency = (input.currency ?? 'INR').toUpperCase();
    if (currency !== 'INR') {
      throw new PaymentError('VALIDATION', `Paytm only accepts INR, got ${currency}.`, { provider: 'paytm' });
    }
    if (input.orderRef.length > 50) {
      throw new PaymentError('VALIDATION', 'Paytm orderId (orderRef) must be at most 50 characters.', { provider: 'paytm' });
    }
    if (!PAYTM_ORDER_ID_RE.test(input.orderRef)) {
      throw new PaymentError(
        'VALIDATION',
        input.orderRef.includes('|')
          ? 'Paytm orderId (orderRef) must not contain "|" (Paytm result code 1008: "Pipe character is not allowed").'
          : 'Paytm orderId (orderRef) may only contain letters, digits and @ - _ .',
        { provider: 'paytm', hint: 'Use an orderRef made of A-Z, a-z, 0-9 and @ - _ . only.' },
      );
    }
    if (!input.returnUrl) {
      throw new PaymentError('VALIDATION', 'Paytm needs returnUrl: it becomes callbackUrl, where Paytm POSTs the signed result.', {
        provider: 'paytm',
        hint: 'Pass returnUrl pointing at a server route that calls payments_verify_payment with the POSTed fields.',
      });
    }
    const amount = toMajorString(input.amount, currency);
    const c = input.customer;
    const body: Record<string, unknown> = {
      requestType: 'Payment',
      mid: this.creds.mid,
      websiteName: this.website,
      orderId: input.orderRef,
      callbackUrl: input.returnUrl,
      txnAmount: { value: amount, currency },
      // custId is mandatory; derive a stable one so a retried order maps to the same customer.
      // Sanitised to the documented custId charset (a '-' in orderRef or customer.id would be rejected).
      // mobile: 10 digits only (P3); firstName/lastName are separate Paytm fields (P7).
      userInfo: {
        custId: sanitizePaytmCustId(c?.id ?? `CUST_${input.orderRef}`),
        mobile: normalizePaytmMobile(c?.phone),
        email: c?.email,
        ...splitPaytmName(c?.name),
      },
      ...(input.providerOptions ?? {}),
    };
    // Initiate is documented as idempotent (T-INIT): a repeat with the same parameters returns
    // 0002 "Success Idempotent" (resultStatus S), while a repeat with different parameters returns
    // 2023 "Repeat Request Inconsistent". So an automatic retry of this exact request is safe.
    const { data } = await this.signedPost<PaytmInitiateBody>(
      `/theia/api/v1/initiateTransaction?mid=${encodeURIComponent(this.creds.mid)}&orderId=${encodeURIComponent(input.orderRef)}`,
      body,
      'initiate_transaction',
      true,
    );
    const info = data?.body?.resultInfo;
    const ok = info?.resultStatus === 'S' || info?.resultCode === '0000' || info?.resultCode === '0002';
    if (!ok || !data.body.txnToken) throw this.resultError('initiate_transaction', info, data);
    const txnToken = data.body.txnToken;

    // Primary path is JS Checkout (Paytm's recommended web integration). Some integrations cannot
    // run the merchant JS (server-rendered pages, mobile webviews, no-JS checkouts), so we also hand
    // back the documented showPaymentPage form post using the same txnToken. Both end at
    // callbackUrl with the same CHECKSUMHASH-signed fields, so verifyPayment is identical.
    //
    // `options.fallbackRedirect` is OUR field, not a Paytm JS Checkout config key (the documented
    // config is root, flow, data, handler, merchant, ...). It stays inside `options` for backward
    // compatibility; strip it before passing options to window.Paytm.CheckoutJS.init(), or use it to
    // render the showPaymentPage form post when JS Checkout cannot run.
    const options: Record<string, unknown> = {
      root: '',
      flow: 'DEFAULT',
      data: { orderId: input.orderRef, token: txnToken, tokenType: 'TXN_TOKEN', amount },
      fallbackRedirect: {
        type: 'form_post',
        url: `${this.host}/theia/api/v1/showPaymentPage?mid=${encodeURIComponent(this.creds.mid)}&orderId=${encodeURIComponent(input.orderRef)}`,
        fields: { mid: this.creds.mid, orderId: input.orderRef, txnToken },
      },
    };

    return {
      provider: 'paytm',
      environment: this.environment,
      orderRef: input.orderRef,
      // Paytm keys everything on the merchant orderId; there is no separate provider order id.
      providerOrderId: input.orderRef,
      status: 'created',
      amount: input.amount,
      currency,
      checkout: {
        type: 'js_sdk',
        sdk: 'paytm',
        scriptUrl: `${this.host}/merchantpgpui/checkoutjs/merchants/${encodeURIComponent(this.creds.mid)}.js`,
        options,
      },
      expiresAt: new Date(this.ctx.now().getTime() + TXN_TOKEN_TTL_MS).toISOString(),
      raw: data,
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const p = input.payload;
    const fail = (reason: string): VerifyPaymentResult => ({ valid: false, status: 'unknown', verifiedVia: 'signature', reason, raw: p });
    if (!p.CHECKSUMHASH) return fail('Payload must contain CHECKSUMHASH (the form fields Paytm POSTed to callbackUrl).');
    if (!verifySignature(p, this.creds.merchantKey, p.CHECKSUMHASH)) return fail('Checksum mismatch');
    if (p.MID && p.MID !== this.creds.mid) return fail(`MID ${p.MID} does not match PAYTM_MID`);
    if (input.orderRef && p.ORDERID !== input.orderRef) return fail(`ORDERID ${p.ORDERID} does not match ${input.orderRef}`);

    let amount: number | undefined;
    if (p.TXNAMOUNT) amount = fromMajor(p.TXNAMOUNT);
    if (input.expectedAmount !== undefined && amount !== input.expectedAmount) {
      return fail(`Amount mismatch: TXNAMOUNT is ${amount}, expected ${input.expectedAmount}`);
    }

    return {
      valid: true,
      status: mapPaytmTxnStatus(p.STATUS),
      orderRef: p.ORDERID,
      providerOrderId: p.ORDERID,
      providerPaymentId: p.TXNID || undefined,
      amount,
      reason: p.STATUS === 'TXN_SUCCESS' ? undefined : p.RESPMSG,
      verifiedVia: 'signature',
      raw: p,
    };
  }

  async getPaymentStatus(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    const orderId = input.providerOrderId ?? input.orderRef;
    const { data } = await this.signedPost<PaytmStatusBody>('/v3/order/status', { mid: this.creds.mid, orderId }, 'order_status', true);
    const b = data?.body;
    if (!b?.resultInfo) throw this.resultError('order_status', undefined, data);
    const code = b.resultInfo.resultCode ?? '';
    // 501 "Server Down" comes back as TXN_FAILURE but says nothing about the payment: retryable.
    if (code === '501') throw this.resultError('order_status', b.resultInfo, data, 'PROVIDER_UNAVAILABLE');
    // Bad order id / MID / checksum are lookup errors, not a failed payment.
    if (STATUS_LOOKUP_ERROR_CODES.has(code)) throw this.resultError('order_status', b.resultInfo, data);
    // head.signature was verified against the raw body in signedPost.
    const amount = b.txnAmount ? fromMajor(b.txnAmount) : undefined;
    const refunded = b.refundAmt ? fromMajor(b.refundAmt) : undefined;
    const status = mapPaytmTxnStatus(b.resultInfo.resultStatus, amount, refunded);
    return {
      provider: 'paytm',
      orderRef: b.orderId ?? input.orderRef,
      providerOrderId: b.orderId ?? orderId,
      providerPaymentId: b.txnId || undefined,
      status,
      amount,
      amountRefunded: refunded,
      currency: 'INR',
      method: mapPaytmPaymentMode(b.paymentMode),
      failureReason: status === 'failed' ? b.resultInfo.resultMsg : undefined,
      raw: data,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    if (!input.providerPaymentId) {
      throw new PaymentError('VALIDATION', 'Paytm refunds need providerPaymentId (the Paytm TXNID).', {
        provider: 'paytm',
        hint: 'Get it from getPaymentStatus(...).providerPaymentId or the TXNID field of the callback/webhook.',
      });
    }
    if (!input.refundRef || input.refundRef.length > MAX_REFUND_REF) {
      throw new PaymentError('VALIDATION', `Paytm refundRef (refId) must be 1-${MAX_REFUND_REF} characters; got ${input.refundRef?.length ?? 0}.`, {
        provider: 'paytm',
      });
    }
    if (input.reason && input.reason.length > MAX_REFUND_COMMENTS) {
      throw new PaymentError('VALIDATION', `Paytm refund comments (reason) must be at most ${MAX_REFUND_COMMENTS} characters.`, { provider: 'paytm' });
    }
    let amount = input.amount;
    if (amount === undefined) {
      // Paytm requires refundAmount; for a "full" refund, refund whatever has not been refunded yet.
      const st = await this.getPaymentStatus({ orderRef: input.orderRef });
      if (st.amount === undefined) {
        throw new PaymentError('VALIDATION', 'Could not determine the transaction amount for a full Paytm refund; pass amount.', { provider: 'paytm', raw: st.raw });
      }
      amount = st.amount - (st.amountRefunded ?? 0);
    }
    assertMinorUnits(amount);
    const body: Record<string, unknown> = {
      mid: this.creds.mid,
      txnType: 'REFUND',
      orderId: input.orderRef,
      txnId: input.providerPaymentId,
      refId: input.refundRef,
      refundAmount: toMajorString(amount),
      ...(input.speed === 'instant' ? { preferredDestination: 'TO_INSTANT' } : {}),
      ...(input.reason ? { comments: input.reason } : {}),
    };
    // refId is unique per merchant, so Paytm rejects a duplicate instead of refunding twice: retry-safe.
    // A retry after a lost response gets a duplicate-refId code; that is handled below.
    const { data } = await this.signedPost<PaytmRefundBody>('/refund/apply', body, 'create_refund', true, this.refundHost);
    const b = data?.body;
    const code = b?.resultInfo?.resultCode ?? '';
    if (DUPLICATE_REFUND_CODES.has(code)) {
      // 617 "Refund Already Raised", 671 "Refund retry is not supported with same refund id": a
      // refund with this refId already exists (typically our own earlier attempt), so report its
      // current state instead of "refund failed". Compare `amount` if refIds may be reused.
      return this.getRefundStatus({ orderRef: input.orderRef, refundRef: input.refundRef });
    }
    if (code === REFUND_IN_PROGRESS_CODE) {
      // 626: another refund on this order is in progress; retry later with the same refundRef.
      throw this.resultError('create_refund', b?.resultInfo, data, 'PROVIDER_UNAVAILABLE');
    }
    if (code === REFUND_ALREADY_SUCCESSFUL_CODE) {
      // 629 "Refund is already Successful": if this refId is that refund, report it; if Paytm has no
      // refund under this refId (631 / NOT_FOUND), surface the original 629 rather than "Record not found".
      try {
        return await this.getRefundStatus({ orderRef: input.orderRef, refundRef: input.refundRef });
      } catch (err) {
        if (err instanceof PaymentError && err.code === 'NOT_FOUND') throw this.resultError('create_refund', b?.resultInfo, data, 'PROVIDER_ERROR');
        throw err;
      }
    }
    if (!b?.resultInfo || b.resultInfo.resultStatus === 'TXN_FAILURE') throw this.resultError('create_refund', b?.resultInfo, data);
    return {
      provider: 'paytm',
      refundRef: input.refundRef,
      providerRefundId: b.refundId || undefined,
      status: mapRefundStatus(b.resultInfo.resultStatus),
      amount: b.refundAmount ? fromMajor(b.refundAmount) : amount,
      raw: data,
    };
  }

  async getRefundStatus(input: RefundStatusInput): Promise<RefundResult> {
    if (!input.orderRef) {
      throw new PaymentError('VALIDATION', 'Paytm refund status needs orderRef as well as refundRef.', { provider: 'paytm' });
    }
    const { data } = await this.signedPost<PaytmRefundBody>(
      '/v2/refund/status',
      { mid: this.creds.mid, orderId: input.orderRef, refId: input.refundRef },
      'refund_status',
      true,
      this.refundHost,
    );
    const b = data?.body;
    if (!b?.resultInfo) throw this.resultError('refund_status', undefined, data);
    const code = b.resultInfo.resultCode ?? '';
    // Lookup errors (record not found, bad MID, invalid request, checksum) are not a failed refund.
    if (REFUND_STATUS_LOOKUP_ERROR_CODES.has(code)) {
      throw this.resultError('refund_status', b.resultInfo, data, code === '631' ? 'NOT_FOUND' : undefined);
    }
    return {
      provider: 'paytm',
      refundRef: b.refId ?? input.refundRef,
      providerRefundId: b.refundId || input.providerRefundId,
      // 501 "System Error" is listed as PENDING: the outcome is not known yet.
      status: code === '501' ? 'pending' : mapRefundStatus(b.resultInfo.resultStatus),
      amount: b.refundAmount ? fromMajor(b.refundAmount) : undefined,
      raw: data,
    };
  }

  async parseWebhook(input: WebhookInput): Promise<NormalizedWebhookEvent> {
    const trimmed = input.rawBody.trim();
    if (trimmed.startsWith('{')) {
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch (err) {
        throw new PaymentError('VALIDATION', 'Paytm notification body is neither form-encoded nor valid JSON.', { provider: 'paytm', cause: err });
      }
      const body = (obj as { body?: unknown }).body;
      if (body && typeof body === 'object' && !Array.isArray(body)) return this.parseRefundWebhook(trimmed, obj as PaytmEnvelope<PaytmRefundWebhookBody>);
    }
    let fields: Record<string, string>;
    try {
      fields = parseNotificationBody(input.rawBody);
    } catch (err) {
      if (err instanceof PaymentError) throw err;
      throw new PaymentError('VALIDATION', 'Paytm notification body is neither form-encoded nor valid JSON.', { provider: 'paytm', cause: err });
    }
    if (!verifySignature(fields, this.creds.merchantKey, fields.CHECKSUMHASH)) {
      throw new PaymentError('SIGNATURE_INVALID', 'Paytm notification CHECKSUMHASH mismatch.', {
        provider: 'paytm',
        hint: 'Verify the decoded form fields (minus CHECKSUMHASH) with the merchant key of the MID that received the payment.',
      });
    }
    if (fields.MID && fields.MID !== this.creds.mid) {
      throw new PaymentError('SIGNATURE_INVALID', `Paytm notification is for MID ${fields.MID}, not PAYTM_MID.`, { provider: 'paytm' });
    }

    // Form/flat notifications are payment status webhooks; refund webhooks are nested JSON (above).
    const status = fields.STATUS ?? '';
    const type: WebhookEventType =
      status === 'TXN_SUCCESS' ? 'payment.succeeded' : status === 'TXN_FAILURE' ? 'payment.failed' : status === 'PENDING' ? 'payment.pending' : 'unknown';
    return {
      provider: 'paytm',
      // Paytm sends no event id; TXNID + STATUS is stable across its retries of the same notification.
      id: `${fields.TXNID ?? fields.ORDERID}:${status}`,
      type,
      providerEventType: status,
      orderRef: fields.ORDERID,
      providerOrderId: fields.ORDERID,
      providerPaymentId: fields.TXNID || undefined,
      status: mapPaytmTxnStatus(status),
      amount: fields.TXNAMOUNT ? fromMajor(fields.TXNAMOUNT) : undefined,
      currency: fields.CURRENCY || 'INR',
      occurredAt: paytmTimeToIso(fields.TXNDATE),
      raw: fields,
    };
  }

  /**
   * Accept Refund and Success Refund webhooks (paytmpayments.com/docs/accept-refund-webhook,
   * /docs/success-refund-webhook): JSON `{head:{signature, version}, body:{...}}`. head.signature is
   * verified like the JSON API responses (raw body bytes, then the re-serialised body; see
   * paytmBodySignatureMatches), ALWAYS, regardless of PAYTM_VERIFY_RESPONSE_SIGNATURE. An unsigned
   * notification (the documented Success Refund FAILED sample) cannot be authenticated and is rejected.
   *
   * Accept Refund (no userCreditInitiateTimestamp): status SUCCESS means Paytm accepted the refund, but
   * "at this stage the refund to the user has not been initiated", so it is normalised to type
   * 'unknown' (informational, providerEventType REFUND_SUCCESS). Its refundAmount is the "Total
   * cumulative refund amount" and it has no totalRefundAmount, so neither amount nor status is
   * reported. Accept Refund FAILED is signed and becomes refund.failed.
   * Success Refund (userCreditInitiateTimestamp present, no status): refund.processed, with
   * refundAmount = this refund and totalRefundAmount = cumulative.
   */
  private parseRefundWebhook(raw: string, env: PaytmEnvelope<PaytmRefundWebhookBody>): NormalizedWebhookEvent {
    const signature = env.head?.signature;
    if (!signature) {
      throw new PaymentError('SIGNATURE_INVALID', 'Paytm refund notification has no head.signature, so it cannot be verified.', {
        provider: 'paytm',
        hint: 'Confirm the refund with getRefundStatus instead of trusting an unsigned notification.',
      });
    }
    if (!paytmBodySignatureMatches(raw, this.creds.merchantKey, signature)) {
      throw new PaymentError('SIGNATURE_INVALID', 'Paytm refund notification head.signature does not match the body.', {
        provider: 'paytm',
        hint: 'Verify the raw body JSON (exact bytes) with the merchant key of the MID that issued the refund.',
      });
    }
    const b = env.body;
    if (b.mid && b.mid !== this.creds.mid) {
      throw new PaymentError('SIGNATURE_INVALID', `Paytm refund notification is for MID ${b.mid}, not PAYTM_MID.`, { provider: 'paytm' });
    }
    const st = (b.status ?? '').toUpperCase();
    const creditInitiated = Boolean(b.userCreditInitiateTimestamp);
    // Only the Success Refund webhook (credit to the customer initiated) is refund.processed.
    const type: WebhookEventType = st === 'FAILED' ? 'refund.failed' : creditInitiated && (st === '' || st === 'SUCCESS') ? 'refund.processed' : 'unknown';
    const stage = creditInitiated ? 'CREDIT_INITIATED' : st || 'UNKNOWN';
    const txnAmount = b.txnAmount ? fromMajor(b.txnAmount) : undefined;
    // Accept Refund has no totalRefundAmount and its refundAmount is cumulative: report neither.
    const total = creditInitiated && b.totalRefundAmount ? fromMajor(b.totalRefundAmount) : undefined;
    const thisRefund = creditInitiated && b.refundAmount ? fromMajor(b.refundAmount) : undefined;
    let status: PaymentStatus | undefined;
    if (type === 'refund.processed' && total !== undefined && txnAmount !== undefined) {
      status = total >= txnAmount ? 'refunded' : 'partially_refunded';
    }
    return {
      provider: 'paytm',
      // Accept and Success webhooks for one refund get different ids; Paytm retries keep the same one.
      id: `refund:${b.refId ?? b.refundId}:${stage}`,
      type,
      providerEventType: `REFUND_${stage}`,
      orderRef: b.orderId,
      providerOrderId: b.orderId,
      providerPaymentId: b.txnId || undefined,
      providerRefundId: b.refundId || undefined,
      refundRef: b.refId || undefined,
      status,
      amount: thisRefund,
      currency: 'INR',
      occurredAt: paytmTimeToIso(b.userCreditInitiateTimestamp ?? b.acceptRefundTimestamp ?? b.merchantRefundRequestTimestamp),
      raw: env,
    };
  }

  async simulateWebhook(input: SimulateWebhookInput): Promise<SimulatedWebhook> {
    const txnId = input.providerPaymentId ?? `SIM${this.ctx.now().getTime()}`;
    const amount = toMajorString(input.amount);
    // Paytm sends timestamps in IST as "YYYY-MM-DD HH:mm:ss.S".
    const istNow = new Date(this.ctx.now().getTime() + 330 * 60_000).toISOString().replace('T', ' ').slice(0, 21);
    if (input.type === 'refund.processed') {
      // Mirrors the documented Success Refund webhook: nested JSON, head.signature over the body bytes.
      const body = {
        source: 'MERCHANT',
        txnId,
        orderId: input.orderRef,
        mid: this.creds.mid,
        txnAmount: amount,
        refundAmount: amount,
        totalRefundAmount: amount,
        refId: input.refundRef ?? `REF_${input.orderRef}`,
        refundId: `SIMRFND${txnId}`,
        txnTimestamp: istNow,
        merchantRefundRequestTimestamp: istNow,
        acceptRefundTimestamp: istNow,
        userCreditInitiateTimestamp: istNow,
        refundDetailInfoList: [{ refundType: 'TO_SOURCE', payMethod: 'UPI', refundAmount: amount }],
      };
      const bodyJson = JSON.stringify(body);
      const signature = generateSignature(bodyJson, this.creds.merchantKey);
      return {
        provider: 'paytm',
        headers: { 'content-type': 'application/json' },
        rawBody: `{"head":${JSON.stringify({ signature, version: 'v1' })},"body":${bodyJson}}`,
        description: 'Paytm Success Refund webhook (JSON head/body) with head.signature over the raw body, signed by PAYTM_MERCHANT_KEY.',
      };
    }
    const fields: Record<string, string> = {
      MID: this.creds.mid,
      ORDERID: input.orderRef,
      TXNID: txnId,
      TXNAMOUNT: amount,
      CURRENCY: input.currency ?? 'INR',
      BANKTXNID: `SIMBANK${txnId}`,
      PAYMENTMODE: 'UPI',
      TXNDATE: istNow,
    };
    if (input.type === 'payment.failed') {
      fields.STATUS = 'TXN_FAILURE';
      fields.RESPCODE = '227';
      fields.RESPMSG = 'Your payment has been declined by your bank (simulated).';
    } else {
      fields.STATUS = 'TXN_SUCCESS';
      fields.RESPCODE = '01';
      fields.RESPMSG = 'Txn Success';
    }
    fields.CHECKSUMHASH = generateSignature(fields, this.creds.merchantKey);
    return {
      provider: 'paytm',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      rawBody: new URLSearchParams(fields).toString(),
      description: `Paytm ${input.type} S2S notification (form-encoded) with CHECKSUMHASH signed by PAYTM_MERCHANT_KEY.`,
    };
  }
}

/**
 * Paytm documents head.signature as "verify with the checksum library" without naming the signed
 * string (verification round 2, P1). Try the exact raw `"body"` member bytes first (what our requests
 * sign), then JSON.stringify of the parsed body (what Paytm's own SDKs produce when they re-serialise).
 * The signature must match one of them; neither match means SIGNATURE_INVALID.
 */
export function paytmBodySignatureMatches(rawText: string, merchantKey: string, signature: string): boolean {
  const rawBody = extractRawJsonMember(rawText, 'body');
  if (rawBody && verifySignature(rawBody, merchantKey, signature)) return true;
  let reserialised: string | undefined;
  try {
    const parsed = JSON.parse(rawText) as { body?: unknown };
    if (parsed && typeof parsed === 'object' && parsed.body !== undefined) reserialised = JSON.stringify(parsed.body);
  } catch {
    return false;
  }
  return reserialised !== undefined && reserialised !== rawBody && verifySignature(reserialised, merchantKey, signature);
}

export const paytm: ProviderModule<PaytmCredentials> = {
  id: 'paytm',
  capabilities: paytmCapabilities,
  create(creds, ctx) {
    if (!creds.mid || !creds.merchantKey) {
      throw new PaymentError('CONFIG_MISSING', 'Paytm needs PAYTM_MID and PAYTM_MERCHANT_KEY.', {
        provider: 'paytm',
        hint: 'Paytm Dashboard > Developer Settings > API Keys. Test and production have different MID/key pairs.',
      });
    }
    if (Buffer.byteLength(creds.merchantKey, 'utf8') !== 16) {
      throw new PaymentError('CONFIG_INVALID', 'PAYTM_MERCHANT_KEY must be exactly 16 characters (it is the AES-128 key).', { provider: 'paytm' });
    }
    // Paytm MIDs/keys carry no test/live marker, so the websiteName is the only thing we can sanity-check.
    if (ctx.environment === 'live' && creds.website === 'WEBSTAGING') {
      throw new PaymentError('CONFIG_INVALID', 'PAYMENTS_MODE=live but PAYTM_WEBSITE=WEBSTAGING (the staging website name).', { provider: 'paytm' });
    }
    if (creds.verifyResponseSignature !== undefined && !/^(true|false)$/i.test(creds.verifyResponseSignature)) {
      throw new PaymentError('CONFIG_INVALID', `PAYTM_VERIFY_RESPONSE_SIGNATURE must be "true" or "false" (got "${creds.verifyResponseSignature}").`, { provider: 'paytm' });
    }
    return new PaytmGateway(creds as Required<Pick<PaytmCredentials, 'mid' | 'merchantKey'>> & PaytmCredentials, ctx);
  },
  extractError(data) {
    const d = data as { body?: { resultInfo?: PaytmResultInfo }; resultInfo?: PaytmResultInfo; errorCode?: string; errorMessage?: string };
    const info = d?.body?.resultInfo ?? d?.resultInfo;
    return { code: info?.resultCode ?? d?.errorCode, message: info?.resultMsg ?? d?.errorMessage };
  },
};
