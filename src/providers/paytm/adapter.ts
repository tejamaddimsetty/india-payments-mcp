import type { AdapterContext, PaymentGateway, ProviderModule } from '../../core/gateway.js';
import { PaymentError } from '../../core/errors.js';
import type { HttpClient } from '../../core/http.js';
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
import { generateSignature, verifySignature } from './checksum.js';

export interface PaytmCredentials {
  mid?: string;
  merchantKey?: string;
  website?: string;
}

/**
 * Paytm rebranded its hosts to paytmpayments.com. The legacy hosts (securegw-stage.paytm.in /
 * securegw.paytm.in) only appear in old docs. Refund and status doc pages show staging
 * securegw-stage.paytmpayments.in; we use one host per environment for every call until a sandbox
 * run proves otherwise.
 */
export const PAYTM_STAGING_HOST = 'https://securestage.paytmpayments.com';
export const PAYTM_LIVE_HOST = 'https://secure.paytmpayments.com';

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
          hint: 'Only the flat payment notification (ORDERID, TXNID, STATUS, CHECKSUMHASH, ...) is supported.',
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
  private readonly website: string;

  constructor(
    private readonly creds: Required<Pick<PaytmCredentials, 'mid' | 'merchantKey'>> & PaytmCredentials,
    private readonly ctx: AdapterContext,
  ) {
    this.environment = ctx.environment;
    this.http = ctx.http;
    this.host = ctx.environment === 'live' ? PAYTM_LIVE_HOST : PAYTM_STAGING_HOST;
    this.website = creds.website || (ctx.environment === 'live' ? 'DEFAULT' : 'WEBSTAGING');
  }

  capabilities() {
    return paytmCapabilities;
  }

  /**
   * Every Paytm JSON API is `{body, head: {signature}}` where signature = checksum over
   * JSON.stringify(body). We serialise once and splice that exact string into the request so the
   * signed bytes and the sent bytes cannot drift.
   */
  private signedPost<B>(path: string, body: Record<string, unknown>, operation: string, retrySafe: boolean) {
    const bodyJson = JSON.stringify(body);
    const signature = generateSignature(bodyJson, this.creds.merchantKey);
    return this.http.request<PaytmEnvelope<B>>({
      method: 'POST',
      url: `${this.host}${path}`,
      headers: { 'Content-Type': 'application/json' },
      body: `{"body":${bodyJson},"head":${JSON.stringify({ signature })}}`,
      operation,
      retrySafe,
    });
  }

  private resultError(operation: string, info: PaytmResultInfo | undefined, raw: unknown): PaymentError {
    // 330 = "Paytm checksum is invalid" in Paytm's response-code list (UNVERIFIED against current docs).
    const auth = info?.resultCode === '330';
    return new PaymentError(auth ? 'AUTH' : 'PROVIDER_ERROR', `paytm ${operation} failed: ${info?.resultMsg ?? 'unknown error'}`, {
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
      userInfo: { custId: c?.id ?? `CUST_${input.orderRef}`, mobile: c?.phone, email: c?.email, firstName: c?.name },
      ...(input.providerOptions ?? {}),
    };
    // Re-initiating the same orderId is not documented as idempotent, so never auto-retry.
    const { data } = await this.signedPost<PaytmInitiateBody>(
      `/theia/api/v1/initiateTransaction?mid=${encodeURIComponent(this.creds.mid)}&orderId=${encodeURIComponent(input.orderRef)}`,
      body,
      'initiate_transaction',
      false,
    );
    const info = data?.body?.resultInfo;
    if (info?.resultStatus !== 'S' || !data.body.txnToken) throw this.resultError('initiate_transaction', info, data);
    const txnToken = data.body.txnToken;

    // Primary path is JS Checkout (Paytm's recommended web integration). Some integrations cannot
    // run the merchant JS (server-rendered pages, mobile webviews, no-JS checkouts), so we also hand
    // back the documented showPaymentPage form post using the same txnToken. Both end at
    // callbackUrl with the same CHECKSUMHASH-signed fields, so verifyPayment is identical.
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
    if (b.resultInfo.resultCode === '330') throw this.resultError('order_status', b.resultInfo, data);
    // The response carries head.signature over the body; we rely on TLS and do not re-verify it
    // because the shared HTTP client hands us parsed JSON, not the exact signed body bytes.
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
      method: b.paymentMode ? b.paymentMode.toLowerCase() : undefined,
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
    const { data } = await this.signedPost<PaytmRefundBody>('/refund/apply', body, 'create_refund', true);
    const b = data?.body;
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
    );
    const b = data?.body;
    if (!b?.resultInfo) throw this.resultError('refund_status', undefined, data);
    if (b.resultInfo.resultCode === '330') throw this.resultError('refund_status', b.resultInfo, data);
    return {
      provider: 'paytm',
      refundRef: b.refId ?? input.refundRef,
      providerRefundId: b.refundId || input.providerRefundId,
      status: mapRefundStatus(b.resultInfo.resultStatus),
      amount: b.refundAmount ? fromMajor(b.refundAmount) : undefined,
      raw: data,
    };
  }

  async parseWebhook(input: WebhookInput): Promise<NormalizedWebhookEvent> {
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

    const status = fields.STATUS ?? '';
    // Refund notifications carry REFID/REFUNDID (shape UNVERIFIED); everything else is a payment.
    const isRefund = Boolean(fields.REFID || fields.REFUNDID);
    let type: WebhookEventType;
    if (isRefund) type = status === 'TXN_SUCCESS' ? 'refund.processed' : status === 'TXN_FAILURE' ? 'refund.failed' : 'unknown';
    else type = status === 'TXN_SUCCESS' ? 'payment.succeeded' : status === 'TXN_FAILURE' ? 'payment.failed' : status === 'PENDING' ? 'payment.pending' : 'unknown';

    const amountField = isRefund ? fields.REFUNDAMOUNT ?? fields.TXNAMOUNT : fields.TXNAMOUNT;
    const occurred = fields.TXNDATE ? Date.parse(fields.TXNDATE.replace(' ', 'T') + '+05:30') : NaN;
    return {
      provider: 'paytm',
      // Paytm sends no event id; TXNID + STATUS is stable across its retries of the same notification.
      id: isRefund ? `refund:${fields.REFID ?? fields.REFUNDID}:${status}` : `${fields.TXNID ?? fields.ORDERID}:${status}`,
      type,
      providerEventType: isRefund ? `REFUND_${status}` : status,
      orderRef: fields.ORDERID,
      providerOrderId: fields.ORDERID,
      providerPaymentId: fields.TXNID || undefined,
      providerRefundId: fields.REFUNDID || undefined,
      refundRef: fields.REFID || undefined,
      status: isRefund ? (status === 'TXN_SUCCESS' ? 'refunded' : undefined) : mapPaytmTxnStatus(status),
      amount: amountField ? fromMajor(amountField) : undefined,
      currency: fields.CURRENCY || 'INR',
      occurredAt: Number.isFinite(occurred) ? new Date(occurred).toISOString() : undefined,
      raw: fields,
    };
  }

  async simulateWebhook(input: SimulateWebhookInput): Promise<SimulatedWebhook> {
    const txnId = input.providerPaymentId ?? `SIM${this.ctx.now().getTime()}`;
    const amount = toMajorString(input.amount);
    const fields: Record<string, string> = {
      MID: this.creds.mid,
      ORDERID: input.orderRef,
      TXNID: txnId,
      TXNAMOUNT: amount,
      CURRENCY: input.currency ?? 'INR',
      BANKTXNID: `SIMBANK${txnId}`,
      PAYMENTMODE: 'UPI',
      // Paytm sends TXNDATE in IST as "YYYY-MM-DD HH:mm:ss.S".
      TXNDATE: new Date(this.ctx.now().getTime() + 330 * 60_000).toISOString().replace('T', ' ').slice(0, 21),
    };
    if (input.type === 'refund.processed') {
      // Paytm's refund notification format is not verified; this mirrors the payment notification.
      fields.REFID = input.refundRef ?? `REF_${input.orderRef}`;
      fields.REFUNDID = `SIMRFND${txnId}`;
      fields.REFUNDAMOUNT = amount;
      fields.STATUS = 'TXN_SUCCESS';
      fields.RESPCODE = '10';
      fields.RESPMSG = 'Refund Successful (simulated).';
    } else if (input.type === 'payment.failed') {
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
    return new PaytmGateway(creds as Required<Pick<PaytmCredentials, 'mid' | 'merchantKey'>> & PaytmCredentials, ctx);
  },
  extractError(data) {
    const d = data as { body?: { resultInfo?: PaytmResultInfo }; resultInfo?: PaytmResultInfo; errorCode?: string; errorMessage?: string };
    const info = d?.body?.resultInfo ?? d?.resultInfo;
    return { code: info?.resultCode ?? d?.errorCode, message: info?.resultMsg ?? d?.errorMessage };
  },
};
