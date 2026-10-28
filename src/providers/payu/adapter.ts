import { randomUUID } from 'node:crypto';
import type { AdapterContext, PaymentGateway, ProviderModule } from '../../core/gateway.js';
import { notImplemented, PaymentError } from '../../core/errors.js';
import { getHeader, safeEqual, sha512Hex } from '../../core/crypto.js';
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
import { payuCapabilities } from './capabilities.js';

export interface PayuCredentials {
  key?: string;
  salt?: string;
}

/** PayU uses different hosts for checkout and for the server-to-server "postservice" API. */
export const PAYU_URLS = {
  sandbox: {
    checkout: 'https://test.payu.in/_payment',
    postservice: 'https://test.payu.in/merchant/postservice.php?form=2',
  },
  live: {
    checkout: 'https://secure.payu.in/_payment',
    postservice: 'https://info.payu.in/merchant/postservice.php?form=2',
  },
} as const;

const UDF_KEYS = ['udf1', 'udf2', 'udf3', 'udf4', 'udf5'] as const;
const MAX_REFUND_REF = 23;

/**
 * Field length limits from the PayU "Additional Info for Payment APIs" table
 * (docs.payu.in/reference/addl_info-payment-apis) and the official Node SDK (payu-india/payu-sdk-node),
 * which throws for txnid > 25. Enforced as VALIDATION errors before the form is built.
 */
export const PAYU_FIELD_LIMITS = {
  txnid: 25,
  productinfo: 100,
  firstname: 60,
  /** The same table lists firstname as 20 characters in the TEST environment. */
  firstnameSandbox: 20,
  email: 50,
  udf: 255,
  phone: 50,
  lastname: 20,
  address1: 100,
  address2: 100,
  city: 50,
  state: 50,
  country: 50,
  zipcode: 20,
} as const;
/** The addl table lists 50 chars for surl/furl. That looks stale (real callback URLs are often longer), so we only warn. */
export const PAYU_URL_SOFT_LIMIT = 50;

/** Fields that go into the request hash. Missing values hash as empty strings. */
export interface PayuHashFields {
  key: string;
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
}

/** sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT), lowercase hex. */
export function payuRequestHash(f: PayuHashFields, salt: string): string {
  const parts = [
    f.key,
    f.txnid,
    f.amount,
    f.productinfo,
    f.firstname,
    f.email,
    ...UDF_KEYS.map((k) => f[k] ?? ''),
    // Five reserved empty slots after udf5.
    '', '', '', '', '',
    salt,
  ];
  return sha512Hex(parts.join('|'));
}

/**
 * Reverse hash on the surl/furl callback and on payment webhooks:
 * sha512([additional_charges|]SALT|status[|splitInfo]||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key).
 * `key` is our configured key, never the one in the payload.
 */
export function payuResponseHash(p: Record<string, string | undefined>, key: string, salt: string): string {
  const parts: string[] = [];
  // The hash doc names it additional_charges; the webhook field table names it additionalCharges.
  const addl = p.additional_charges ?? p.additionalCharges;
  if (addl) parts.push(addl);
  parts.push(salt, p.status ?? '');
  if (p.splitInfo) parts.push(p.splitInfo);
  parts.push(
    '', '', '', '', '',
    ...[...UDF_KEYS].reverse().map((k) => p[k] ?? ''),
    p.email ?? '',
    p.firstname ?? '',
    p.productinfo ?? '',
    p.amount ?? '',
    p.txnid ?? '',
    key,
  );
  return sha512Hex(parts.join('|'));
}

/** Postservice hash: sha512(key|command|var1|SALT). Only var1 is hashed, even for refunds. */
export function payuApiHash(key: string, command: string, var1: string, salt: string): string {
  return sha512Hex(`${key}|${command}|${var1}|${salt}`);
}

interface PayuTxnDetails {
  mihpayid?: string;
  txnid?: string;
  status?: string;
  unmappedstatus?: string;
  amt?: string;
  transaction_amount?: string;
  mode?: string;
  bank_ref_num?: string;
  error_Message?: string;
  field9?: string;
}

interface PayuVerifyResponse {
  status: number;
  msg?: string;
  transaction_details?: Record<string, PayuTxnDetails>;
}

interface PayuRefundResponse {
  status: number;
  msg?: string;
  request_id?: string;
  /** Cancel of an authorised (uncaptured) payment returns the request id here instead of request_id. */
  txn_update_id?: string;
  mihpayid?: string;
  error_code?: string | number;
}

/**
 * PayU's top-level `status` is success/failure/pending. `unmappedstatus` is finer grained
 * (captured, auth, userCancelled, dropped, bounced...) and is used where it adds information.
 */
export function mapPayuStatus(status: string | undefined, unmapped?: string): PaymentStatus {
  const s = (status ?? '').toLowerCase();
  const u = (unmapped ?? '').toLowerCase();
  if (u === 'usercancelled') return 'cancelled';
  if (s === 'success') return u === 'auth' ? 'authorized' : 'captured';
  if (s === 'failure' || s === 'failed') return 'failed';
  if (s === 'pending' || s === 'in progress') return 'pending';
  // verify_payment answers "Not Found" until the customer has actually submitted the checkout form.
  if (s === 'not found') return 'created';
  return 'unknown';
}

export function mapPayuRefundStatus(s: string | undefined): RefundStatus {
  const v = (s ?? '').toLowerCase();
  if (v === 'success' || v === 'processed' || v === 'refunded') return 'processed';
  if (v === 'failure' || v === 'failed' || v === 'cancelled') return 'failed';
  // od_hit (prose refund states), processing (OpenAPI refund_status enum), in_progress (UAT table).
  if (['queued', 'pending', 'requested', 'in progress', 'in_progress', 'processing', 'od_hit'].includes(v)) return 'pending';
  return 'unknown';
}

/** PayU `mode`: CC, DC, NB, UPI, CASH (wallets), EMI, ... */
function mapMode(mode: string | undefined): string | undefined {
  if (!mode) return undefined;
  const m = mode.toUpperCase();
  if (m === 'CC' || m === 'DC' || m === 'CARD') return 'card';
  if (m === 'NB') return 'netbanking';
  if (m === 'UPI') return 'upi';
  if (m === 'CASH' || m === 'WALLET') return 'wallet';
  if (m === 'EMI') return 'emi';
  if (m === 'BNPL') return 'paylater';
  return mode.toLowerCase();
}

/** `addedon` is IST wall-clock time without an offset ("2026-10-28 15:30:00"). */
function istToIso(s: string | undefined): string | undefined {
  if (!s || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s.replace(' ', 'T')}+05:30`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Webhook bodies arrive form-encoded or as JSON depending on the account; flatten both to strings. */
function parseBody(rawBody: string, contentType: string | undefined): Record<string, string> {
  const trimmed = rawBody.trim();
  if (/json/i.test(contentType ?? '') || trimmed.startsWith('{')) {
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      throw new PaymentError('VALIDATION', 'PayU webhook body is not valid JSON.', { provider: 'payu' });
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === null || v === undefined) out[k] = '';
      else out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return out;
  }
  return Object.fromEntries(new URLSearchParams(trimmed));
}

class PayuGateway implements PaymentGateway {
  readonly id = 'payu' as const;
  readonly environment;
  private readonly http: HttpClient;
  private readonly urls: (typeof PAYU_URLS)[keyof typeof PAYU_URLS];

  constructor(
    private readonly creds: Required<PayuCredentials>,
    private readonly ctx: AdapterContext,
  ) {
    this.environment = ctx.environment;
    this.http = ctx.http;
    this.urls = PAYU_URLS[ctx.environment];
  }

  capabilities() {
    return payuCapabilities;
  }

  private postservice<T>(command: string, vars: string[], operation: string, retrySafe = false) {
    const body = new URLSearchParams({ key: this.creds.key, command });
    vars.forEach((v, i) => body.set(`var${i + 1}`, v));
    body.set('hash', payuApiHash(this.creds.key, command, vars[0] ?? '', this.creds.salt));
    return this.http.request<T>({ method: 'POST', url: this.urls.postservice, body, operation, retrySafe });
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    assertMinorUnits(input.amount);
    const currency = (input.currency ?? 'INR').toUpperCase();
    if (currency !== 'INR') {
      throw new PaymentError('VALIDATION', `PayU hosted checkout takes INR only (got ${currency}).`, {
        provider: 'payu',
        hint: 'International currencies need a separately enabled PayU account; pass the converted INR amount.',
      });
    }
    if (!input.returnUrl) {
      throw new PaymentError('VALIDATION', 'PayU needs returnUrl: it is used as surl and furl, where PayU POSTs the result.', {
        provider: 'payu',
        hint: 'Pass an https URL on your server that accepts POST and calls verifyPayment.',
      });
    }
    const c = input.customer ?? {};
    if (!c.name || !c.email || !c.phone) {
      throw new PaymentError('VALIDATION', 'PayU hosted checkout requires customer.name (firstname), customer.email and customer.phone.', {
        provider: 'payu',
      });
    }
    const meta = Object.values(input.metadata ?? {});
    if (meta.length > UDF_KEYS.length) {
      throw new PaymentError('VALIDATION', `PayU has only 5 user-defined fields (udf1..udf5); got ${meta.length} metadata values.`, {
        provider: 'payu',
        hint: 'Keep the rest in your own database keyed by orderRef.',
      });
    }

    const fields: Record<string, string> = {
      key: this.creds.key,
      txnid: input.orderRef,
      amount: toMajorString(input.amount, currency),
      productinfo: input.description ?? input.orderRef,
      firstname: c.name,
      email: c.email,
      phone: c.phone,
      surl: input.returnUrl,
      furl: input.returnUrl,
    };
    UDF_KEYS.forEach((k, i) => (fields[k] = meta[i] ?? ''));
    if (input.billingAddress) {
      const a = input.billingAddress;
      if (a.line1) fields.address1 = a.line1;
      if (a.line2) fields.address2 = a.line2;
      if (a.city) fields.city = a.city;
      if (a.state) fields.state = a.state;
      if (a.postalCode) fields.zipcode = a.postalCode;
      if (a.country) fields.country = a.country;
    }
    for (const [k, v] of Object.entries(input.providerOptions ?? {})) {
      if (k !== 'hash' && v !== undefined && v !== null) fields[k] = String(v);
    }
    this.validateFieldLengths(fields);
    // Hash last, over the final field values, so providerOptions overrides stay consistent.
    fields.hash = payuRequestHash(fields as unknown as PayuHashFields, this.creds.salt);

    return {
      provider: 'payu',
      environment: this.environment,
      orderRef: input.orderRef,
      // PayU has no order object: the txnid is the only id until the customer pays (then mihpayid).
      providerOrderId: input.orderRef,
      status: 'created',
      amount: input.amount,
      currency,
      checkout: { type: 'form_post', url: this.urls.checkout, fields },
      // The hash is not secret (it travels through the browser), so the full field set is returned.
      raw: { ...fields },
    };
  }

  /** Checked on the final field values, so providerOptions overrides are covered too. */
  private validateFieldLengths(fields: Record<string, string>): void {
    const tooLong = (name: string, max: number) => {
      const v = fields[name] ?? '';
      if (v.length > max) {
        throw new PaymentError('VALIDATION', `PayU ${name}${name === 'txnid' ? ' (orderRef)' : ''} must be at most ${max} characters; got ${v.length}.`, {
          provider: 'payu',
        });
      }
    };
    tooLong('txnid', PAYU_FIELD_LIMITS.txnid);
    tooLong('productinfo', PAYU_FIELD_LIMITS.productinfo);
    tooLong('firstname', this.environment === 'sandbox' ? PAYU_FIELD_LIMITS.firstnameSandbox : PAYU_FIELD_LIMITS.firstname);
    tooLong('email', PAYU_FIELD_LIMITS.email);
    for (const k of ['phone', 'lastname', 'address1', 'address2', 'city', 'state', 'country', 'zipcode'] as const) tooLong(k, PAYU_FIELD_LIMITS[k]);
    UDF_KEYS.forEach((k) => tooLong(k, PAYU_FIELD_LIMITS.udf));
    for (const k of ['surl', 'furl'] as const) {
      const len = fields[k]?.length ?? 0;
      if (len > PAYU_URL_SOFT_LIMIT) {
        this.ctx.logger.warn(`PayU docs list a ${PAYU_URL_SOFT_LIMIT}-character limit for ${k}; this one is ${len}. Sent anyway: the limit looks stale, but shorten it if PayU rejects the form.`, {
          provider: 'payu',
        });
      }
    }
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const p = input.payload;
    if (!p.hash || !p.txnid || !p.status) {
      return { valid: false, status: 'unknown', verifiedVia: 'signature', reason: 'Payload must contain hash, txnid and status.', raw: p };
    }
    const expected = payuResponseHash(p, this.creds.key, this.creds.salt);
    if (!safeEqual(expected, p.hash.toLowerCase())) {
      return { valid: false, status: 'unknown', verifiedVia: 'signature', reason: 'Hash mismatch', raw: p };
    }
    // The hash binds the fields together; now bind them to what the caller expects.
    if (input.orderRef && p.txnid !== input.orderRef) {
      return { valid: false, status: 'unknown', verifiedVia: 'signature', reason: `txnid ${p.txnid} does not match orderRef ${input.orderRef}`, raw: p };
    }
    const amount = p.amount ? fromMajor(p.amount) : undefined;
    if (input.expectedAmount !== undefined && amount !== input.expectedAmount) {
      return { valid: false, status: 'unknown', verifiedVia: 'signature', reason: `Amount mismatch: callback says ${amount}, expected ${input.expectedAmount}`, raw: p };
    }
    return {
      valid: true,
      status: mapPayuStatus(p.status, p.unmappedstatus),
      orderRef: p.txnid,
      providerOrderId: p.txnid,
      providerPaymentId: p.mihpayid,
      amount,
      reason: p.status === 'success' ? undefined : p.error_Message || p.field9 || undefined,
      verifiedVia: 'signature',
      raw: p,
    };
  }

  async getPaymentStatus(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    const txnid = input.orderRef;
    const { data } = await this.postservice<PayuVerifyResponse | string>('verify_payment', [txnid], 'verify_payment', true);
    const txn = typeof data === 'object' ? data.transaction_details?.[txnid] : undefined;
    if (!txn) {
      const msg = typeof data === 'object' ? data.msg : String(data).slice(0, 200);
      throw new PaymentError('PROVIDER_ERROR', `PayU verify_payment returned no details for ${txnid}${msg ? `: ${msg}` : ''}`, {
        provider: 'payu',
        providerMessage: msg,
        raw: data,
        hint: 'Check PAYU_MERCHANT_KEY / PAYU_MERCHANT_SALT and that PAYMENTS_MODE matches the key (test vs live).',
      });
    }
    const status = mapPayuStatus(txn.status, txn.unmappedstatus);
    const amt = txn.amt ?? txn.transaction_amount;
    return {
      provider: 'payu',
      orderRef: txnid,
      providerOrderId: txnid,
      providerPaymentId: txn.mihpayid && txn.mihpayid !== 'Not Found' ? txn.mihpayid : undefined,
      status,
      amount: amt ? fromMajor(amt) : undefined,
      currency: 'INR',
      method: mapMode(txn.mode),
      failureReason: status === 'failed' ? txn.error_Message || txn.field9 || undefined : undefined,
      raw: data,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    if (!input.providerPaymentId) {
      throw new PaymentError('VALIDATION', 'PayU refunds need providerPaymentId (the PayU mihpayid, not the txnid).', {
        provider: 'payu',
        hint: 'Get it from verifyPayment / getPaymentStatus(...).providerPaymentId or the payment webhook.',
      });
    }
    if (!input.refundRef || input.refundRef.length > MAX_REFUND_REF) {
      throw new PaymentError('VALIDATION', `PayU refundRef (token_id) must be 1-${MAX_REFUND_REF} characters; got ${input.refundRef?.length ?? 0}.`, {
        provider: 'payu',
      });
    }
    let amount = input.amount;
    if (amount === undefined) {
      // PayU requires an explicit amount; a "full refund" means the captured amount.
      const s = await this.getPaymentStatus({ orderRef: input.orderRef });
      if (s.amount === undefined) {
        throw new PaymentError('VALIDATION', 'Could not determine the payment amount for a full refund; pass amount explicitly.', { provider: 'payu' });
      }
      amount = s.amount;
    }
    assertMinorUnits(amount);
    // Not auto-retried: PayU rejects a reused token ("Token already exists", error 106) rather than
    // returning the earlier refund, so a blind retry cannot tell success from duplicate.
    const { data } = await this.postservice<PayuRefundResponse | string>(
      'cancel_refund_transaction',
      [input.providerPaymentId, input.refundRef, toMajorString(amount)],
      'cancel_refund_transaction',
    );
    // Refund docs: "error_code value 102 should be treated as success" (102 = queued).
    const accepted = typeof data === 'object' && (data.status === 1 || String(data.error_code ?? '') === '102');
    if (!accepted) {
      const msg = typeof data === 'object' ? data.msg : String(data).slice(0, 200);
      throw new PaymentError('PROVIDER_ERROR', `PayU refund rejected${msg ? `: ${msg}` : ''}`, {
        provider: 'payu',
        providerCode: typeof data === 'object' && data.error_code !== undefined ? String(data.error_code) : undefined,
        providerMessage: msg,
        raw: data,
      });
    }
    return {
      provider: 'payu',
      refundRef: input.refundRef,
      providerRefundId: data.request_id ?? data.txn_update_id,
      // "Refund Request Queued": PayU processes refunds asynchronously.
      status: 'pending',
      amount,
      raw: data,
    };
  }

  async getRefundStatus(input: RefundStatusInput): Promise<RefundResult> {
    if (!input.providerRefundId) {
      throw new PaymentError('VALIDATION', 'PayU refund status needs providerRefundId (the request_id returned by refund).', { provider: 'payu' });
    }
    // check_action_status + var1=request_id, as in the docs prose (check_action_status_api_with_request_id)
    // and the official PHP SDK (payu-intrepos/web-sdk-php checkRefundStatus). The docs show two response
    // shapes: nested transaction_details.{request_id}.{request_id}.{status, amt, ...} (prose sample) and a
    // flat {status: 1, request_id, refund_status, refund_amount} (OpenAPI sample). Both are handled.
    const { data } = await this.postservice<{ status?: number; msg?: string; transaction_details?: unknown } | string>(
      'check_action_status',
      [input.providerRefundId],
      'check_action_status',
      true,
    );
    const detail = typeof data === 'object' ? (flatRefundDetail(data as Record<string, unknown>) ?? findRefundDetail(data.transaction_details)) : undefined;
    if (!detail) {
      const msg = typeof data === 'object' ? data.msg : String(data).slice(0, 200);
      throw new PaymentError('PROVIDER_ERROR', `PayU check_action_status returned no refund details${msg ? `: ${msg}` : ''}`, {
        provider: 'payu',
        providerMessage: msg,
        raw: data,
      });
    }
    const amount = detail.amount ?? detail.amt;
    return {
      provider: 'payu',
      refundRef: input.refundRef,
      providerRefundId: input.providerRefundId,
      status: mapPayuRefundStatus(detail.status),
      amount: amount ? fromMajor(amount) : undefined,
      raw: data,
    };
  }

  async parseWebhook(input: WebhookInput): Promise<NormalizedWebhookEvent> {
    const p = parseBody(input.rawBody, getHeader(input.headers, 'content-type'));
    if (!p.hash || !safeEqual(payuResponseHash(p, this.creds.key, this.creds.salt), p.hash.toLowerCase())) {
      throw new PaymentError('SIGNATURE_INVALID', 'PayU webhook hash mismatch.', {
        provider: 'payu',
        hint: 'PayU webhooks use the reverse hash with your merchant salt. Refund webhooks are not supported by this parser.',
      });
    }
    const status = mapPayuStatus(p.status, p.unmappedstatus);
    const typeMap: Partial<Record<PaymentStatus, WebhookEventType>> = {
      captured: 'payment.succeeded',
      authorized: 'payment.authorized',
      failed: 'payment.failed',
      cancelled: 'payment.failed',
      pending: 'payment.pending',
    };
    return {
      provider: 'payu',
      // PayU sends no event id; mihpayid + status is stable across retries of the same event.
      id: `${p.mihpayid ?? p.txnid}:${p.status}`,
      type: typeMap[status] ?? 'unknown',
      providerEventType: p.status ?? 'unknown',
      orderRef: p.txnid,
      providerOrderId: p.txnid,
      providerPaymentId: p.mihpayid,
      status,
      amount: p.amount ? fromMajor(p.amount) : undefined,
      currency: 'INR',
      occurredAt: istToIso(p.addedon),
      raw: p,
    };
  }

  async simulateWebhook(input: SimulateWebhookInput): Promise<SimulatedWebhook> {
    if (input.type === 'refund.processed') {
      throw notImplemented('payu', 'refund webhook simulation (refund webhooks are not parsed by this adapter)');
    }
    const ok = input.type === 'payment.succeeded';
    const fields: Record<string, string> = {
      mihpayid: input.providerPaymentId ?? `sim${randomUUID().replace(/-/g, '').slice(0, 15)}`,
      mode: 'UPI',
      status: ok ? 'success' : 'failure',
      unmappedstatus: ok ? 'captured' : 'failed',
      key: this.creds.key,
      txnid: input.orderRef,
      amount: toMajorString(input.amount, input.currency ?? 'INR'),
      productinfo: input.orderRef,
      firstname: 'Simulated',
      email: 'simulated@example.com',
      phone: '9999999999',
      udf1: '',
      udf2: '',
      udf3: '',
      udf4: '',
      udf5: '',
      field9: ok ? 'Transaction Completed Successfully' : 'Transaction declined by bank (simulated)',
      error: ok ? 'E000' : 'E308',
      error_Message: ok ? 'No Error' : 'Transaction declined by bank (simulated)',
      addedon: this.ctx
        .now()
        .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
        .replace('T', ' '),
    };
    fields.hash = payuResponseHash(fields, this.creds.key, this.creds.salt);
    return {
      provider: 'payu',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      rawBody: new URLSearchParams(fields).toString(),
      description: `PayU ${fields.status} payment webhook (form-encoded) with a reverse hash computed from PAYU_MERCHANT_SALT.`,
    };
  }
}

interface PayuRefundDetail {
  status?: string;
  amount?: string;
  amt?: string;
}

/** OpenAPI sample shape: {status: 1, msg, request_id, mihpayid, refund_status, refund_amount, ...}. */
function flatRefundDetail(data: Record<string, unknown>): PayuRefundDetail | undefined {
  if (typeof data.refund_status !== 'string') return undefined;
  const amt = data.refund_amount;
  return { status: data.refund_status, amount: amt === undefined || amt === null ? undefined : String(amt) };
}

/** Walk the nested check_action_status payload and return the first object that has a status. */
function findRefundDetail(node: unknown, depth = 0): PayuRefundDetail | undefined {
  if (!node || typeof node !== 'object' || depth > 3) return undefined;
  const obj = node as Record<string, unknown>;
  if (typeof obj.status === 'string' && ('amount' in obj || 'amt' in obj || 'action' in obj || 'request_id' in obj)) {
    return obj as PayuRefundDetail;
  }
  for (const v of Object.values(obj)) {
    const found = findRefundDetail(v, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export const payu: ProviderModule<PayuCredentials> = {
  id: 'payu',
  capabilities: payuCapabilities,
  create(creds, ctx) {
    if (!creds.key || !creds.salt) {
      throw new PaymentError('CONFIG_MISSING', 'PayU needs PAYU_MERCHANT_KEY and PAYU_MERCHANT_SALT.', {
        provider: 'payu',
        hint: 'Dashboard > Developers > API Keys. Test and live keys differ: use the test key with PAYMENTS_MODE=sandbox.',
      });
    }
    return new PayuGateway({ key: creds.key, salt: creds.salt }, ctx);
  },
  extractError(data) {
    if (data && typeof data === 'object') {
      const d = data as { msg?: string; message?: string; error_code?: string | number; error?: string };
      const code = d.error_code ?? d.error;
      return { code: code !== undefined ? String(code) : undefined, message: d.msg ?? d.message };
    }
    return { message: typeof data === 'string' && data ? data.slice(0, 200) : undefined };
  },
};
