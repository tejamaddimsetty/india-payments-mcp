import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AdapterContext, PaymentGateway, ProviderModule } from '../../core/gateway.js';
import { PaymentError, unsupported } from '../../core/errors.js';
import { getHeader, md5 } from '../../core/crypto.js';
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
  SimulatedWebhook,
  SimulateWebhookInput,
  VerifyPaymentInput,
  VerifyPaymentResult,
  WebhookEventType,
  WebhookInput,
} from '../../core/types.js';
import { ccavenueCapabilities } from './capabilities.js';

export interface CcavenueCredentials {
  merchantId?: string;
  accessCode?: string;
  workingKey?: string;
  /** CCAVENUE_ENCRYPTION: 'cbc' (classic AES-128 kit, default) or 'gcm' (AES-256 kit). */
  encryption?: string;
}

export type CcavenueEncryption = 'cbc' | 'gcm';

/**
 * Checkout and API hosts differ, and both differ between test and live.
 * Sources (docs/research/verification/round1-ccavenue.md): live checkout URLs come from mirrors of
 * CCAvenue's own integration kits (AES-128 and AES-256 folders of the NodeJS kit); the test checkout
 * URLs and the API hosts come from third-party integrations. The GCM *test* checkout URL is
 * third-party-sourced only (Think-To-Share CcAvenueGateway.php).
 */
export const CCAVENUE_URLS = {
  sandbox: {
    checkout: 'https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction',
    // Third-party-sourced (not in any official kit).
    checkoutGcm: 'https://test.ccavenue.com/gTransaction.do?command=initiateTransaction',
    api: 'https://apitest.ccavenue.com/apis/servlet/DoWebTrans',
  },
  live: {
    checkout: 'https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction',
    // NodeJS kit AES-256/ccavRequestHandler.js (official kit, mirror).
    checkoutGcm: 'https://secure.ccavenue.com/gTransaction.do?command=initiateTransaction',
    api: 'https://api.ccavenue.com/apis/servlet/DoWebTrans',
  },
} as const;

/**
 * DoWebTrans `version` per command (round1-ccavenue.md items 29-31). The API PDF copy says "current
 * possible values is 1.1". Every refundOrder implementation found sends 1.1; orderStatusTracker is
 * sent as 1.2 by the Go client and ERPNext (Perfex uses 1.1), so both work in the wild.
 * Unlisted commands default to 1.1.
 */
const API_VERSION: Readonly<Record<string, string>> = { orderStatusTracker: '1.2', refundOrder: '1.1' };

const MERCHANT_PARAMS = ['merchant_param1', 'merchant_param2', 'merchant_param3', 'merchant_param4', 'merchant_param5'] as const;

// Classic kit scheme: AES-128-CBC, key = md5(working key) as 16 raw bytes, IV = 0x00..0x0f, hex.
const IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

export function ccavenueEncrypt(plainText: string, workingKey: string): string {
  const cipher = createCipheriv('aes-128-cbc', md5(workingKey), IV);
  return Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]).toString('hex');
}

/** Throws on a wrong key or tampered ciphertext (bad padding). */
export function ccavenueDecrypt(encHex: string, workingKey: string): string {
  if (!/^(?:[0-9a-fA-F]{32})+$/.test(encHex.trim())) throw new Error('ciphertext is not hex in whole AES blocks');
  const decipher = createDecipheriv('aes-128-cbc', md5(workingKey), IV);
  return Buffer.concat([decipher.update(Buffer.from(encHex.trim(), 'hex')), decipher.final()]).toString('utf8');
}

// AES-256 kit scheme (NodeJS kit AES-256/ccavutil.js, official kit mirror): aes-256-gcm, key = the
// working key used directly as 32 UTF-8 bytes (no MD5), random 12-byte IV,
// output = hex(iv) + hex(ciphertext || 16-byte auth tag).
const GCM_TAG_BYTES = 16;

/** The working key as the 32-byte AES-256 key; CONFIG_INVALID if it is not exactly 32 bytes. */
export function ccavenueGcmKey(workingKey: string): Buffer {
  const key = Buffer.from(workingKey, 'utf8');
  if (key.length !== 32) {
    throw new PaymentError('CONFIG_INVALID', `CCAVENUE_ENCRYPTION=gcm needs a 32-character working key (got ${key.length} bytes).`, {
      provider: 'ccavenue',
      hint: 'The AES-256 kit uses CCAVENUE_WORKING_KEY directly as the key. Check the key, or set CCAVENUE_ENCRYPTION=cbc for the classic AES-128 kit.',
    });
  }
  return key;
}

/** `iv` is for tests only; production calls always use a fresh random 12-byte IV. */
export function ccavenueEncryptGcm(plainText: string, workingKey: string, iv: Buffer = randomBytes(12)): string {
  const cipher = createCipheriv('aes-256-gcm', ccavenueGcmKey(workingKey), iv);
  const ct = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return iv.toString('hex') + Buffer.concat([ct, cipher.getAuthTag()]).toString('hex');
}

/**
 * Throws on a wrong key or any tampering (GCM authentication failure). The official kit uses a 12-byte
 * IV; several third-party GCM integrations use 16, and the length cannot be read from the data, so a
 * 12-byte IV is tried first and 16 second. Only one can authenticate.
 */
export function ccavenueDecryptGcm(encHex: string, workingKey: string): string {
  const hex = encHex.trim();
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error('ciphertext is not hex');
  const key = ccavenueGcmKey(workingKey);
  const buf = Buffer.from(hex, 'hex');
  let lastError: unknown = new Error('ciphertext too short for AES-GCM');
  for (const ivLen of [12, 16]) {
    if (buf.length < ivLen + GCM_TAG_BYTES) continue;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, ivLen));
      decipher.setAuthTag(buf.subarray(buf.length - GCM_TAG_BYTES));
      return Buffer.concat([decipher.update(buf.subarray(ivLen, buf.length - GCM_TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/** The kit sample sends billing_country as a country NAME ("India"); map ISO 3166 alpha-2 codes to names. */
function countryName(country: string): string {
  const c = country.trim();
  if (!/^[A-Za-z]{2}$/.test(c)) return c;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(c.toUpperCase()) ?? c;
  } catch {
    return c;
  }
}

/** Redirect/notification `order_status` values plus the richer orderStatusTracker ones. */
export function mapCcavenueStatus(s: string | undefined): PaymentStatus {
  switch ((s ?? '').trim().toLowerCase()) {
    case 'success':
    case 'successful':
    case 'shipped':
      return 'captured';
    case 'failure':
    case 'unsuccessful':
    case 'invalid':
    case 'fraud':
    case 'timeout':
      return 'failed';
    case 'aborted':
    case 'cancelled':
    case 'auto-cancelled':
      return 'cancelled';
    case 'awaited':
    case 'initiated':
      return 'pending';
    case 'refunded':
    case 'system refund':
    case 'auto-reversed':
      return 'refunded';
    case 'partially refunded': // UNVERIFIED: no source lists this value; kept for safety
      return 'partially_refunded';
    // 'Chargeback' appears in a third-party CCAvenue-derived enum; it is not a refund, so it stays 'unknown'.
    default:
      return 'unknown';
  }
}

/** CCAvenue payment_mode / order_option_type to our method names. */
function mapMethod(mode: string | undefined): string | undefined {
  if (!mode) return undefined;
  const m = mode.toLowerCase();
  if (m.includes('upi')) return 'upi';
  if (m.includes('net') || m === 'optnbk') return 'netbanking';
  if (m.includes('wallet') || m === 'optwlt' || m === 'optcashc') return 'wallet';
  if (m.includes('emi')) return 'emi';
  if (m.includes('card') || m === 'optcrdc' || m === 'optdbcrd') return 'card';
  return m;
}

/** Bodies arrive form-encoded; JSON is accepted too in case a notification is configured that way. */
function parseBody(rawBody: string): Record<string, string> {
  const trimmed = rawBody.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v == null ? '' : String(v)]));
    } catch {
      // fall through to form parsing
    }
  }
  return Object.fromEntries(new URLSearchParams(trimmed));
}

interface CcaOrderStatus {
  status?: number | string;
  error_desc?: string;
  error_code?: string;
  order_no?: string;
  reference_no?: string | number;
  order_status?: string;
  order_amt?: number | string;
  order_gross_amt?: number | string;
  order_currncy?: string;
  order_currency?: string;
  order_option_type?: string;
  order_card_name?: string;
  order_bank_response?: string;
}

interface CcaRefundResult {
  refund_status?: number | string;
  reason?: string;
  error_code?: string;
}

class CcavenueGateway implements PaymentGateway {
  readonly id = 'ccavenue' as const;
  readonly environment;
  private readonly http: HttpClient;
  private readonly urls: (typeof CCAVENUE_URLS)[keyof typeof CCAVENUE_URLS];

  constructor(
    private readonly creds: Required<Omit<CcavenueCredentials, 'encryption'>> & { encryption: CcavenueEncryption },
    private readonly ctx: AdapterContext,
  ) {
    this.environment = ctx.environment;
    this.http = ctx.http;
    this.urls = CCAVENUE_URLS[ctx.environment];
  }

  /** Same scheme for checkout, redirect/notification and (UNVERIFIED for gcm) DoWebTrans. */
  private encrypt(plain: string): string {
    return this.creds.encryption === 'gcm' ? ccavenueEncryptGcm(plain, this.creds.workingKey) : ccavenueEncrypt(plain, this.creds.workingKey);
  }

  private decrypt(encHex: string): string {
    return this.creds.encryption === 'gcm' ? ccavenueDecryptGcm(encHex, this.creds.workingKey) : ccavenueDecrypt(encHex, this.creds.workingKey);
  }

  capabilities() {
    return ccavenueCapabilities;
  }

  private decryptFields(encResp: string | undefined): Record<string, string> | undefined {
    if (!encResp) return undefined;
    try {
      return Object.fromEntries(new URLSearchParams(this.decrypt(encResp)));
    } catch {
      return undefined;
    }
  }

  /**
   * One DoWebTrans call: JSON request encrypted into enc_request, outer response is form-encoded
   * `status=0&enc_response=<hex>` on success, `status=1&enc_response=<plain error>` on failure.
   */
  private async api<T>(command: string, request: Record<string, unknown>, operation: string, retrySafe = false): Promise<T> {
    const body = new URLSearchParams({
      enc_request: this.encrypt(JSON.stringify(request)),
      access_code: this.creds.accessCode,
      command,
      request_type: 'JSON',
      response_type: 'JSON',
      version: API_VERSION[command] ?? '1.1',
    });
    const { data } = await this.http.request<unknown>({ method: 'POST', url: this.urls.api, body, operation, retrySafe });
    const outer: Record<string, string> =
      typeof data === 'string'
        ? Object.fromEntries(new URLSearchParams(data.trim()))
        : Object.fromEntries(Object.entries((data ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    if (outer.status !== '0' || !outer.enc_response) {
      throw new PaymentError('PROVIDER_ERROR', `CCAvenue ${command} failed${outer.enc_response ? `: ${outer.enc_response.slice(0, 200)}` : ''}`, {
        provider: 'ccavenue',
        providerCode: outer.enc_error_code || undefined,
        providerMessage: outer.enc_response,
        raw: outer,
        hint: 'Check that this server\'s public IP is whitelisted with CCAvenue and that the access code / working key match PAYMENTS_MODE.',
      });
    }
    let plain: string;
    try {
      plain = this.decrypt(outer.enc_response);
    } catch (cause) {
      throw new PaymentError('PROVIDER_ERROR', `CCAvenue ${command}: could not decrypt enc_response with the working key.`, { provider: 'ccavenue', cause, raw: outer });
    }
    try {
      return JSON.parse(plain) as T;
    } catch (cause) {
      throw new PaymentError('PROVIDER_ERROR', `CCAvenue ${command}: decrypted response is not JSON.`, { provider: 'ccavenue', cause, raw: plain });
    }
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    assertMinorUnits(input.amount);
    const currency = (input.currency ?? 'INR').toUpperCase();
    if (!input.returnUrl) {
      throw new PaymentError('VALIDATION', 'CCAvenue needs returnUrl: it is used as redirect_url and cancel_url, where CCAvenue POSTs encResp.', {
        provider: 'ccavenue',
        hint: 'Pass an https URL on the domain registered with CCAvenue that accepts POST and calls verifyPayment.',
      });
    }
    const meta = Object.values(input.metadata ?? {});
    if (meta.length > MERCHANT_PARAMS.length) {
      throw new PaymentError('VALIDATION', `CCAvenue has only 5 merchant_param fields; got ${meta.length} metadata values.`, { provider: 'ccavenue' });
    }

    const order: Record<string, string> = {
      merchant_id: this.creds.merchantId,
      order_id: input.orderRef,
      amount: toMajorString(input.amount, currency),
      currency,
      redirect_url: input.returnUrl,
      cancel_url: input.returnUrl,
      language: 'EN',
    };
    const c = input.customer ?? {};
    if (c.name) order.billing_name = c.name;
    if (c.email) order.billing_email = c.email;
    if (c.phone) order.billing_tel = c.phone;
    const a = input.billingAddress;
    if (a) {
      const street = [a.line1, a.line2].filter(Boolean).join(', ');
      if (street) order.billing_address = street;
      if (a.city) order.billing_city = a.city;
      if (a.state) order.billing_state = a.state;
      if (a.postalCode) order.billing_zip = a.postalCode;
      if (a.country) order.billing_country = countryName(a.country);
    }
    MERCHANT_PARAMS.forEach((k, i) => {
      if (meta[i] !== undefined) order[k] = meta[i] as string;
    });
    for (const [k, v] of Object.entries(input.providerOptions ?? {})) {
      if (v !== undefined && v !== null) order[k] = String(v);
    }

    const encRequest = this.encrypt(new URLSearchParams(order).toString());
    return {
      provider: 'ccavenue',
      environment: this.environment,
      orderRef: input.orderRef,
      // CCAvenue assigns its tracking_id only after payment; until then order_id is the only id.
      providerOrderId: input.orderRef,
      status: 'created',
      amount: input.amount,
      currency,
      checkout: { type: 'form_post', url: this.creds.encryption === 'gcm' ? this.urls.checkoutGcm : this.urls.checkout, fields: { encRequest, access_code: this.creds.accessCode } },
      // Plaintext order (no secrets in it) so callers can see what was encrypted.
      raw: order,
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const fields = this.decryptFields(input.payload.encResp);
    if (!fields || !fields.order_id) {
      return {
        valid: false,
        status: 'unknown',
        verifiedVia: 'decryption',
        reason: input.payload.encResp ? 'encResp could not be decrypted with the working key' : 'Payload must contain encResp.',
        raw: input.payload,
      };
    }
    if (input.orderRef && fields.order_id !== input.orderRef) {
      return { valid: false, status: 'unknown', verifiedVia: 'decryption', reason: `order_id ${fields.order_id} does not match orderRef ${input.orderRef}`, raw: fields };
    }
    const amount = fields.amount ? fromMajor(fields.amount, fields.currency || 'INR') : undefined;
    if (input.expectedAmount !== undefined && amount !== input.expectedAmount) {
      return { valid: false, status: 'unknown', verifiedVia: 'decryption', reason: `Amount mismatch: response says ${amount}, expected ${input.expectedAmount}`, raw: fields };
    }
    const status = mapCcavenueStatus(fields.order_status);
    return {
      valid: true,
      status,
      orderRef: fields.order_id,
      providerOrderId: fields.order_id,
      providerPaymentId: fields.tracking_id || undefined,
      amount,
      reason: status === 'captured' ? undefined : fields.failure_message || fields.status_message || undefined,
      verifiedVia: 'decryption',
      raw: fields,
    };
  }

  async getPaymentStatus(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    // Field names per third-party copies of the API PDF (UNVERIFIED); Meta's guide shows orderNo/referenceNo.
    const res = await this.api<CcaOrderStatus & { Order_Status_Result?: CcaOrderStatus }>(
      'orderStatusTracker',
      { order_no: input.orderRef },
      'order_status_tracker',
      true,
    );
    const o = res.Order_Status_Result ?? res;
    if (String(o.status ?? '0') !== '0' || o.error_desc) {
      throw new PaymentError(/not\s*found|no record/i.test(o.error_desc ?? '') ? 'NOT_FOUND' : 'PROVIDER_ERROR', `CCAvenue orderStatusTracker: ${o.error_desc || 'request failed'}`, {
        provider: 'ccavenue',
        providerCode: o.error_code,
        providerMessage: o.error_desc,
        raw: res,
      });
    }
    const status = mapCcavenueStatus(o.order_status);
    const currency = o.order_currncy ?? o.order_currency ?? 'INR';
    const amt = o.order_amt ?? o.order_gross_amt;
    return {
      provider: 'ccavenue',
      orderRef: o.order_no ?? input.orderRef,
      providerOrderId: o.order_no ?? input.orderRef,
      providerPaymentId: o.reference_no !== undefined ? String(o.reference_no) : undefined,
      status,
      amount: amt !== undefined && amt !== '' ? fromMajor(amt, currency) : undefined,
      currency,
      method: mapMethod(o.order_option_type ?? o.order_card_name),
      failureReason: status === 'failed' ? o.order_bank_response : undefined,
      raw: res,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    if (!input.providerPaymentId) {
      throw new PaymentError('VALIDATION', 'CCAvenue refunds need providerPaymentId (the tracking_id / reference_no).', {
        provider: 'ccavenue',
        hint: 'Get it from verifyPayment(...).providerPaymentId or getPaymentStatus(...).providerPaymentId.',
      });
    }
    // Look the order up even for a partial refund: refund_amount must be formatted in the order's currency.
    const s = await this.getPaymentStatus({ orderRef: input.orderRef, providerPaymentId: input.providerPaymentId });
    const currency = s.currency ?? 'INR';
    // CCAvenue needs an explicit refund_amount; a "full refund" means the order amount.
    const amount = input.amount ?? s.amount;
    if (amount === undefined) {
      throw new PaymentError('VALIDATION', 'Could not determine the order amount for a full refund; pass amount explicitly.', { provider: 'ccavenue' });
    }
    assertMinorUnits(amount);
    // Not auto-retried: de-duplication on refund_ref_no is not documented.
    const res = await this.api<CcaRefundResult & { Refund_Order_Result?: CcaRefundResult }>(
      'refundOrder',
      { reference_no: input.providerPaymentId, refund_amount: toMajorString(amount, currency), refund_ref_no: input.refundRef },
      'refund_order',
    );
    const r = res.Refund_Order_Result ?? res;
    if (String(r.refund_status ?? '') !== '0') {
      throw new PaymentError('PROVIDER_ERROR', `CCAvenue refund rejected${r.reason ? `: ${r.reason}` : ''}`, {
        provider: 'ccavenue',
        providerCode: r.error_code,
        providerMessage: r.reason,
        raw: res,
      });
    }
    return {
      provider: 'ccavenue',
      refundRef: input.refundRef,
      // CCAvenue returns no refund id; refund_ref_no (our refundRef) is the handle.
      providerRefundId: undefined,
      // refund_status 0 means accepted; the bank credit happens later.
      status: 'pending',
      amount,
      raw: res,
    };
  }

  async parseWebhook(input: WebhookInput): Promise<NormalizedWebhookEvent> {
    // No documented signature: the body is the same encResp POST as the redirect. With cbc, decryption
    // is not authentication (no MAC); with gcm the auth tag does authenticate it. Either way the
    // result is reported as verifiedVia 'decryption' and the client re-confirms via the status API.
    const body = parseBody(input.rawBody);
    const f = this.decryptFields(body.encResp ?? body.enc_response);
    if (!f || !f.order_id) {
      throw new PaymentError('SIGNATURE_INVALID', 'CCAvenue notification could not be decrypted with the working key.', {
        provider: 'ccavenue',
        hint: getHeader(input.headers, 'content-type')?.includes('json')
          ? 'Expected a body with an encResp field.'
          : 'Expected a form-encoded body with encResp. Check CCAVENUE_WORKING_KEY matches the access code / environment.',
      });
    }
    const status = mapCcavenueStatus(f.order_status);
    const typeMap: Partial<Record<PaymentStatus, WebhookEventType>> = {
      captured: 'payment.succeeded',
      failed: 'payment.failed',
      cancelled: 'payment.failed',
      pending: 'payment.pending',
    };
    const currency = f.currency || 'INR';
    return {
      provider: 'ccavenue',
      // No event id is sent; tracking_id + status is stable across re-deliveries.
      id: `${f.tracking_id || f.order_id}:${f.order_status ?? ''}`,
      type: typeMap[status] ?? 'unknown',
      providerEventType: f.order_status ?? 'unknown',
      orderRef: f.order_id,
      providerOrderId: f.order_id,
      providerPaymentId: f.tracking_id || undefined,
      status,
      amount: f.amount ? fromMajor(f.amount, currency) : undefined,
      currency,
      occurredAt: ddmmyyyyIstToIso(f.trans_date),
      raw: f,
    };
  }

  async simulateWebhook(input: SimulateWebhookInput): Promise<SimulatedWebhook> {
    if (input.type === 'refund.processed') {
      throw unsupported(
        'ccavenue',
        'refund notifications',
        'CCAvenue offers an "Order Refund Status" Dynamic Event Notification, but its payload is not publicly documented and this adapter does not parse it; poll getPaymentStatus for refunds.',
      );
    }
    const ok = input.type === 'payment.succeeded';
    const currency = input.currency ?? 'INR';
    const now = this.ctx.now();
    const ist = new Date(now.getTime() + 5.5 * 3600_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const transDate = `${pad(ist.getUTCDate())}/${pad(ist.getUTCMonth() + 1)}/${ist.getUTCFullYear()} ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`;
    const fields = new URLSearchParams({
      order_id: input.orderRef,
      tracking_id: input.providerPaymentId ?? String(100000000000 + (now.getTime() % 899999999999)),
      bank_ref_no: ok ? `SIM${now.getTime()}` : 'null',
      order_status: ok ? 'Success' : 'Failure',
      failure_message: ok ? '' : 'Transaction declined (simulated)',
      payment_mode: 'Unified Payments',
      card_name: 'UPI',
      status_code: ok ? '0' : '1',
      status_message: ok ? 'Approved' : 'Declined (simulated)',
      currency,
      amount: toMajorString(input.amount, currency),
      billing_name: 'Simulated',
      merchant_param1: '',
      trans_date: transDate,
    });
    const rawBody = new URLSearchParams({
      encResp: this.encrypt(fields.toString()),
      orderNo: input.orderRef,
    }).toString();
    return {
      provider: 'ccavenue',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      rawBody,
      description: `CCAvenue ${ok ? 'Success' : 'Failure'} encResp POST encrypted with CCAVENUE_WORKING_KEY.`,
    };
  }
}

/** trans_date is "dd/mm/yyyy hh:mm:ss" in IST. */
function ddmmyyyyIstToIso(s: string | undefined): string | undefined {
  const m = s?.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return undefined;
  const d = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export const ccavenue: ProviderModule<CcavenueCredentials> = {
  id: 'ccavenue',
  capabilities: ccavenueCapabilities,
  create(creds, ctx) {
    if (!creds.merchantId || !creds.accessCode || !creds.workingKey) {
      throw new PaymentError('CONFIG_MISSING', 'CCAvenue needs CCAVENUE_MERCHANT_ID, CCAVENUE_ACCESS_CODE and CCAVENUE_WORKING_KEY.', {
        provider: 'ccavenue',
        hint: 'Dashboard > Settings > API Keys. Test and live credentials differ; they are tied to the registered domain.',
      });
    }
    const encryption = (creds.encryption ?? 'cbc').trim().toLowerCase() || 'cbc';
    if (encryption !== 'cbc' && encryption !== 'gcm') {
      throw new PaymentError('CONFIG_INVALID', `CCAVENUE_ENCRYPTION must be cbc or gcm (got "${creds.encryption}").`, {
        provider: 'ccavenue',
        hint: 'cbc = classic AES-128 integration kit (default); gcm = AES-256 kit. Ask CCAvenue which kit your account uses.',
      });
    }
    if (encryption === 'gcm') ccavenueGcmKey(creds.workingKey);
    return new CcavenueGateway({ merchantId: creds.merchantId, accessCode: creds.accessCode, workingKey: creds.workingKey, encryption }, ctx);
  },
  extractError(data) {
    if (typeof data === 'string') {
      const f = new URLSearchParams(data.trim());
      const msg = f.get('enc_response') ?? data;
      return { code: f.get('enc_error_code') ?? undefined, message: msg ? msg.slice(0, 200) : undefined };
    }
    const d = data as { error_desc?: string; error_code?: string; reason?: string } | undefined;
    return { code: d?.error_code, message: d?.error_desc ?? d?.reason };
  },
};
