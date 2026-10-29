import { FileAuditSink, noopAuditSink, type AuditEntry, type AuditSink } from './core/audit.js';
import type { FeatureKey } from './core/capabilities.js';
import { credentialReport, loadConfigFromEnv, type Env, type PaymentsConfig } from './core/config.js';
import { notImplemented, PaymentError, toPaymentError, unsupported } from './core/errors.js';
import type { PaymentGateway } from './core/gateway.js';
import { createHttpClient, type FetchLike } from './core/http.js';
import { MemoryIdempotencyStore, withIdempotency, type IdempotencyStore } from './core/idempotency.js';
import { createLogger, type Logger } from './core/logger.js';
import { assertMinorUnits } from './core/money.js';
import type {
  CancelSubscriptionInput,
  CreateCustomerInput,
  CreatePaymentInput,
  CreatePaymentResult,
  CreateSubscriptionInput,
  ListSettlementsInput,
  NormalizedWebhookEvent,
  PaymentStatus,
  PaymentStatusInput,
  ProviderId,
  RefundInput,
  RefundResult,
  RefundStatusInput,
  SimulateWebhookInput,
  VerifyPaymentInput,
  VerifyPaymentResult,
  WebhookInput,
} from './core/types.js';
import { MockGateway, MockLedger } from './mock/mock-gateway.js';
import { allCapabilities, PROVIDERS } from './providers/index.js';
import { InfinityGateway, validateQuickLink } from './providers/infinity/adapter.js';
import type { RecordPaymentInput } from './providers/shared/manual-collections.js';
import { SKYDO_MIN_USD_CENTS, SkydoGateway } from './providers/skydo/adapter.js';

/** Collection services with no sandbox: "sandbox" mode is the merchant's real ledger / books. */
const NO_SANDBOX: Partial<Record<ProviderId, string>> = { skydo: 'Skydo has no sandbox', infinity: 'Infinity documents no sandbox' };

export interface PaymentsClientOptions {
  config?: Partial<PaymentsConfig>;
  /** Read config from these env vars (defaults to process.env). Explicit `config` wins. */
  env?: Env;
  fetch?: FetchLike;
  logger?: Logger;
  idempotencyStore?: IdempotencyStore;
  auditSink?: AuditSink;
  now?: () => Date;
  /** Who is acting, recorded in the audit log (e.g. "mcp", "api:user_42"). */
  actor?: string;
  /**
   * Require PAYMENTS_ALLOW_LIVE_MUTATIONS=true AND confirm=true for live refunds/cancellations.
   * The MCP server turns this on, because an AI agent is the caller. Your own app code, which has its
   * own authorisation, leaves it off. Default: false.
   */
  guardLiveMutations?: boolean;
}

const ORDER_REF = /^[A-Za-z0-9_-]{3,40}$/;

/**
 * Baseline: request fields that carry the amount, order id, credentials or redirect targets on some
 * gateway. providerOptions may add fields but never override these: the amount we validated must be
 * the amount the gateway sees, and an agent must not be able to redirect the money or the callback.
 * Each provider module adds its own keys (ProviderModule.protectedOptionKeys) for money routing
 * (splits, transfers, connected accounts), manual capture and nested binding keys.
 */
const BASELINE_PROTECTED_OPTIONS: readonly string[] = [
  'amount', 'currency', 'key', 'hash', 'salt', 'txnid', 'surl', 'furl', 'productinfo',
  'order_id', 'order_amount', 'order_currency', 'merchant_id', 'access_code', 'redirect_url', 'cancel_url',
  'orderId', 'mid', 'txnAmount', 'callbackUrl', 'websiteName',
  'merchantOrderId', 'merchantUrls', 'paymentFlow', 'receipt',
  'success_url', 'line_items', 'client_reference_id', 'mode', 'payment_intent_data',
];

/** createPayment results carry short-lived checkout data (Paytm txnToken: 15 min; PhonePe redirectUrl). */
const CREATE_PAYMENT_IDEMPOTENCY_TTL_SECONDS = 10 * 60;

/** Statuses where the money is collected and still (at least partly) with the merchant. */
const PAID_STATUSES: ReadonlySet<PaymentStatus> = new Set(['captured', 'partially_refunded']);

/** A refund POST error that may mean "a refund with this refundRef already exists". */
function mayAlreadyExist(err: unknown): boolean {
  if (!(err instanceof PaymentError)) return false;
  if (err.code === 'OUTCOME_UNKNOWN') return true;
  if (err.code !== 'PROVIDER_ERROR' && err.code !== 'VALIDATION') return false;
  const text = `${err.message} ${err.providerMessage ?? ''} ${err.providerCode ?? ''}`;
  return /duplicate|already (exists|raised|been|processed)|already_exists/i.test(text);
}

/**
 * Gateways whose webhook authentication does not protect the body. PhonePe signs nothing (a static
 * SHA256(user:pass) header); CCAvenue's AES-CBC has no MAC, so ciphertext can be bit-flipped.
 */
const WEBHOOK_BODY_UNAUTHENTICATED: ReadonlySet<ProviderId> = new Set(['phonepe', 'ccavenue']);

/**
 * The orchestration layer. One object, every gateway:
 *  - validates input once, the same way for all providers
 *  - refuses features a gateway does not have, with a clear error, before any network call
 *  - applies idempotency, audit logging and live-mode safety rails
 *  - swaps every adapter for a network-free mock when mode = "mock"
 */
export class PaymentsClient {
  readonly config: PaymentsConfig;
  readonly logger: Logger;
  private readonly gateways = new Map<ProviderId, PaymentGateway>();
  private readonly idem: IdempotencyStore;
  private readonly audit: AuditSink;
  private readonly ledger = new MockLedger();
  private readonly now: () => Date;
  private readonly fetchImpl?: FetchLike;
  private readonly actor: string;
  private readonly guardLiveMutations: boolean;
  private readonly env: Env;

  constructor(opts: PaymentsClientOptions = {}) {
    this.env = opts.env ?? process.env;
    const base = loadConfigFromEnv(this.env, allCapabilities());
    this.config = { ...base, ...(opts.config ?? {}), credentials: { ...base.credentials, ...(opts.config?.credentials ?? {}) } };
    this.logger = opts.logger ?? createLogger(this.config.logLevel, { svc: 'india-payments-mcp' });
    this.idem = opts.idempotencyStore ?? new MemoryIdempotencyStore();
    this.audit = opts.auditSink ?? (this.config.auditLogPath ? new FileAuditSink(this.config.auditLogPath) : noopAuditSink);
    this.now = opts.now ?? (() => new Date());
    this.fetchImpl = opts.fetch;
    this.actor = opts.actor ?? 'sdk';
    this.guardLiveMutations = opts.guardLiveMutations ?? false;
  }

  get mode() {
    return this.config.mode;
  }

  providers(): ProviderId[] {
    return this.config.enabledProviders;
  }

  capabilities(provider: ProviderId) {
    return this.module(provider).capabilities;
  }

  configReport(provider: ProviderId) {
    return credentialReport(this.module(provider).capabilities, this.config.credentials[provider]);
  }

  private module(provider: ProviderId) {
    if (!this.config.enabledProviders.includes(provider)) {
      throw new PaymentError('VALIDATION', `Provider "${provider}" is not enabled. Enabled: ${this.config.enabledProviders.join(', ')}.`, {
        hint: 'Check the provider name or the PAYMENTS_PROVIDERS env var.',
      });
    }
    const mod = PROVIDERS[provider];
    if (!mod) throw new PaymentError('VALIDATION', `Unknown provider "${provider}".`);
    return mod;
  }

  /** Get the adapter (or its mock). Built lazily so one missing credential never breaks other providers. */
  gateway(provider: ProviderId): PaymentGateway {
    const cached = this.gateways.get(provider);
    if (cached) return cached;
    const mod = this.module(provider);
    let gw: PaymentGateway;
    // Read from the env the client was built with (opts.env), so injected env objects behave consistently.
    if (this.config.mode === 'mock' && this.env.NODE_ENV === 'production' && !/^(1|true)$/i.test(this.env.PAYMENTS_ALLOW_MOCK_IN_PRODUCTION ?? '')) {
      throw new PaymentError('CONFIG_INVALID', 'PAYMENTS_MODE=mock with NODE_ENV=production. Mock mode accepts simulated payments; refusing to run it in production.', {
        hint: 'Use sandbox or live, or set PAYMENTS_ALLOW_MOCK_IN_PRODUCTION=true for a demo deployment.',
      });
    }
    if (this.config.mode === 'mock') {
      gw = new MockGateway(provider, mod.capabilities, this.ledger, { now: this.now });
    } else {
      const logger = this.logger.child({ provider });
      gw = mod.create(this.config.credentials[provider] ?? {}, {
        environment: this.config.mode,
        logger,
        now: this.now,
        http: createHttpClient({
          provider,
          logger,
          fetch: this.fetchImpl,
          maxRetries: this.config.maxRetries,
          defaultTimeoutMs: this.config.httpTimeoutMs,
          extractError: mod.extractError?.bind(mod),
        }),
      });
    }
    this.gateways.set(provider, gw);
    return gw;
  }

  /** Skydo rules, enforced here so mock mode behaves exactly like the real adapter. */
  private assertSkydoCurrency(currency: string | undefined, amount: number) {
    const c = currency?.toUpperCase();
    if (!c || c === 'INR') {
      throw new PaymentError('VALIDATION', 'Skydo receives foreign currency from abroad: pass the client\'s currency (USD, GBP, EUR, CAD, AUD, AED, SGD, ...). INR is not supported.', { provider: 'skydo' });
    }
    if (c === 'USD' && amount < SKYDO_MIN_USD_CENTS) {
      throw new PaymentError('VALIDATION', `Skydo's minimum payment is USD 50.00 (amount is in cents: 5000).`, { provider: 'skydo' });
    }
  }

  private skydo(): SkydoGateway {
    if (this.config.mode === 'mock') {
      throw new PaymentError('VALIDATION', 'Mock mode simulates Skydo receipts with payments_mock_complete_payment.', { provider: 'skydo' });
    }
    const gw = this.gateway('skydo');
    if (!(gw instanceof SkydoGateway)) throw new PaymentError('VALIDATION', 'Skydo gateway unavailable.', { provider: 'skydo' });
    return gw;
  }

  /**
   * Skydo ledger mode: record money Skydo told you arrived (email/WhatsApp/dashboard/FIRA).
   * Recording a receipt can mark an order paid, so through the MCP server it is gated like a refund.
   */
  async skydoRecordPayment(input: RecordPaymentInput, opts: { confirm?: boolean } = {}) {
    const gw = this.skydo();
    return this.audited({ action: 'skydo_record_payment', provider: 'skydo', orderRef: input.orderRef, amount: input.amountReceived, detail: { receiptId: input.receiptId } }, async () => {
      this.assertLiveMutationAllowed('Recording a Skydo receipt', 'skydo', opts.confirm === true);
      return gw.recordPayment(input);
    });
  }

  /** Infinity rules, enforced here so mock mode behaves exactly like the real adapter. */
  private assertInfinityCurrency(currency: string | undefined) {
    const c = currency?.toUpperCase();
    if (!c || !/^[A-Z]{3}$/.test(c) || c === 'INR') {
      throw new PaymentError('VALIDATION', 'Infinity receives foreign currency from abroad: pass the client\'s currency (USD, EUR, GBP, AUD, CAD, ...). INR is not supported.', {
        provider: 'infinity',
        hint: 'For domestic INR payments use razorpay, cashfree, payu, phonepe, paytm or ccavenue.',
      });
    }
  }

  private infinity(): InfinityGateway {
    if (this.config.mode === 'mock') {
      throw new PaymentError('VALIDATION', 'Mock mode simulates Infinity receipts with payments_mock_complete_payment.', { provider: 'infinity' });
    }
    const gw = this.gateway('infinity');
    if (!(gw instanceof InfinityGateway)) throw new PaymentError('VALIDATION', 'Infinity gateway unavailable.', { provider: 'infinity' });
    return gw;
  }

  /**
   * Infinity: record money the Infinity dashboard shows as received (bank transfer or QuickLink).
   * Recording a receipt can mark an order paid, so through the MCP server it is gated like a refund.
   */
  async infinityRecordPayment(input: RecordPaymentInput, opts: { confirm?: boolean } = {}) {
    const gw = this.infinity();
    return this.audited({ action: 'infinity_record_payment', provider: 'infinity', orderRef: input.orderRef, amount: input.amountReceived, detail: { receiptId: input.receiptId } }, async () => {
      this.assertLiveMutationAllowed('Recording an Infinity receipt', 'infinity', opts.confirm === true);
      return gw.recordPayment(input);
    });
  }

  /** Infinity: orders still waiting for money, oldest first. */
  async infinityOutstanding() {
    const gw = this.infinity();
    return { mode: gw.mode, outstanding: gw.outstanding(), note: gw.mode === 'zoho' ? 'Zoho bridge: outstanding invoices are in Zoho Books (status sent/overdue/partially_paid).' : undefined };
  }

  /** Skydo ledger mode: orders still waiting for money. */
  async skydoOutstanding() {
    const gw = this.skydo();
    return { mode: gw.mode, outstanding: gw.mode === 'ledger' ? gw.outstanding() : [], note: gw.mode === 'zoho' ? 'Zoho bridge: outstanding invoices are in Zoho Books (status sent/overdue/partially_paid).' : undefined };
  }

  /** The mock gateway, for tests and the payments_mock_complete_payment tool. */
  mockGateway(provider: ProviderId): MockGateway {
    const gw = this.gateway(provider);
    if (!(gw instanceof MockGateway)) {
      throw new PaymentError('VALIDATION', 'Mock helpers only work when PAYMENTS_MODE=mock.');
    }
    return gw;
  }

  private requireFeature<K extends keyof PaymentGateway>(provider: ProviderId, feature: FeatureKey, method: K) {
    const gw = this.gateway(provider);
    const support = gw.capabilities().features[feature];
    if (support.support === 'unsupported') throw unsupported(provider, feature, support.notes ?? '');
    if (support.support === 'not_implemented' || typeof gw[method] !== 'function') throw notImplemented(provider, feature);
    return gw as PaymentGateway & Required<Pick<PaymentGateway, K>>;
  }

  private assertLiveMutationAllowed(action: string, provider: ProviderId, confirmed: boolean) {
    if (!this.guardLiveMutations || this.config.mode === 'mock') return;
    // Skydo and Infinity have no sandbox: "sandbox" is the merchant's real ledger / Zoho Books, so the
    // gate applies in every non-mock mode.
    const noSandbox = NO_SANDBOX[provider];
    const realData = this.config.mode === 'live' || noSandbox !== undefined;
    if (!realData) return;
    if (!this.config.allowLiveMutations || !confirmed) {
      throw new PaymentError(
        'LIVE_MUTATION_BLOCKED',
        this.config.mode === 'live'
          ? `${action} on ${provider} in LIVE mode is blocked.`
          : `${action} on ${provider} is blocked: ${noSandbox}, so ${this.config.mode} mode works on real data.`,
        { provider, hint: 'Set PAYMENTS_ALLOW_LIVE_MUTATIONS=true on the server AND pass confirm=true on the call after a human has approved it.' },
      );
    }
  }

  /** providerOptions may add fields but never override the baseline or the gateway's own protected keys. */
  private assertProviderOptions(provider: ProviderId, op: 'payment' | 'subscription', options: Record<string, unknown> | undefined) {
    if (!options) return;
    const own = PROVIDERS[provider]?.protectedOptionKeys?.[op] ?? [];
    const blocked = new Set<string>([...BASELINE_PROTECTED_OPTIONS, ...own]);
    const overridden = Object.keys(options).filter((k) => blocked.has(k));
    if (overridden.length) {
      throw new PaymentError('VALIDATION', `providerOptions may not set protected ${provider} fields: ${overridden.join(', ')}.`, {
        provider,
        hint:
          'Amount, orderRef, currency, URLs and metadata go through the normal inputs (metadata via input.metadata). ' +
          'Fields that route money elsewhere (splits, transfers, connected accounts) or change capture are not allowed through providerOptions.',
      });
    }
  }

  private async audited<T>(entry: Omit<AuditEntry, 'ts' | 'outcome' | 'mode' | 'actor'>, fn: () => Promise<T>): Promise<T> {
    const base = { ...entry, ts: this.now().toISOString(), mode: this.config.mode, actor: this.actor };
    try {
      const result = await fn();
      await this.audit.record({ ...base, outcome: 'success' }).catch((e) => this.logger.error('audit.write_failed', { err: String(e) }));
      return result;
    } catch (err) {
      const pe = toPaymentError(err, entry.provider as ProviderId);
      await this.audit
        .record({ ...base, outcome: pe.code === 'LIVE_MUTATION_BLOCKED' ? 'blocked' : 'error', errorCode: pe.code })
        .catch((e) => this.logger.error('audit.write_failed', { err: String(e) }));
      throw pe;
    }
  }

  async createPayment(provider: ProviderId, input: CreatePaymentInput): Promise<CreatePaymentResult> {
    assertMinorUnits(input.amount);
    if (!ORDER_REF.test(input.orderRef)) {
      throw new PaymentError('VALIDATION', `orderRef "${input.orderRef}" must be 3-40 chars of letters, digits, "_" or "-".`, {
        hint: 'This is the safe common denominator across gateways (Razorpay receipt max 40; Paytm, PhonePe and Cashfree reject other characters). PayU refund ids are further capped at 23.',
      });
    }
    if (provider === 'skydo') this.assertSkydoCurrency(input.currency, input.amount);
    if (provider === 'infinity') {
      this.assertInfinityCurrency(input.currency);
      // Mock mode has no adapter to check the link: apply the default host rule here too.
      if (this.config.mode === 'mock' && input.providerOptions?.quickLinkUrl !== undefined) validateQuickLink(input.providerOptions.quickLinkUrl, ['*.infinityapp.in']);
    }
    const currency = (input.currency ?? 'INR').toUpperCase();
    this.assertProviderOptions(provider, 'payment', input.providerOptions);
    const gw = this.requireFeature(provider, 'createPayment', 'createPayment');
    if (provider === 'infinity' && this.config.mode !== 'mock') {
      // Infinity creates nothing remotely in ledger mode, and its ledger / Zoho lookup is already idempotent
      // per orderRef; the cache would refuse the supported "attach a QuickLink later" call.
      return this.audited({ action: 'create_payment', provider, orderRef: input.orderRef, amount: input.amount, currency }, () => gw.createPayment({ ...input, currency }));
    }
    // Short TTL: the cached result holds checkout tokens/URLs that expire (Paytm txnToken 15 min).
    return this.audited({ action: 'create_payment', provider, orderRef: input.orderRef, amount: input.amount, currency }, () =>
      withIdempotency(
        this.idem,
        `${provider}:create_payment`,
        input.idempotencyKey ?? input.orderRef,
        { ...input, currency },
        () => gw.createPayment({ ...input, currency }),
        CREATE_PAYMENT_IDEMPOTENCY_TTL_SECONDS,
      ),
    );
  }

  async verifyPayment(provider: ProviderId, input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    let result = await this.requireFeature(provider, 'verifyPayment', 'verifyPayment').verifyPayment(input);

    // Decryption is not authentication (CCAvenue's AES-CBC has no MAC: ciphertext blocks can be
    // spliced between responses). Confirm the outcome with the gateway before calling it paid.
    if (result.valid && result.verifiedVia === 'decryption' && input.orderRef) {
      const confirmed = await this.getPaymentStatus(provider, { orderRef: input.orderRef, providerPaymentId: result.providerPaymentId });
      result = {
        ...result,
        status: confirmed.status,
        amount: confirmed.amount ?? result.amount,
        verifiedVia: 'status_api',
        valid: input.expectedAmount === undefined || confirmed.amount === input.expectedAmount,
        reason: input.expectedAmount !== undefined && confirmed.amount !== input.expectedAmount ? 'Amount mismatch on status confirmation' : result.reason,
      };
    }

    // Money collected and still with the merchant. `authorized` is NOT paid: this library has no
    // capture API, and uncaptured authorisations lapse (Razorpay auto-refunds, Stripe after ~7 days).
    // A fully `refunded` payment is not paid either: replaying an old success URL must not re-fulfil.
    const settled = PAID_STATUSES.has(result.status);
    // `paid` requires the caller to have bound the callback to THEIR order and amount; otherwise a
    // genuine callback for some other (cheap) order would count as payment for this one.
    const bound = input.orderRef !== undefined && input.expectedAmount !== undefined;
    let reason = result.reason;
    if (result.valid && settled && !bound) reason = 'Pass orderRef and expectedAmount to get paid=true: an unbound callback could belong to a different order.';
    else if (result.valid && result.status === 'authorized') reason = result.reason ?? 'Payment is authorised but not captured; capture it or enable auto-capture. paid=false until it is captured.';
    else if (result.valid && result.status === 'refunded') reason = 'Payment was fully refunded; it no longer counts as paid.';
    return {
      ...result,
      paid: result.valid && settled && bound,
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  async getPaymentStatus(provider: ProviderId, input: PaymentStatusInput) {
    return this.requireFeature(provider, 'paymentStatus', 'getPaymentStatus').getPaymentStatus(input);
  }

  async refund(provider: ProviderId, input: RefundInput, opts: { confirm?: boolean } = {}): Promise<RefundResult> {
    if (input.amount !== undefined) assertMinorUnits(input.amount, 'refund amount');
    if (!ORDER_REF.test(input.refundRef)) {
      throw new PaymentError('VALIDATION', `refundRef "${input.refundRef}" must be 3-40 chars of letters, digits, "_" or "-".`);
    }
    const gw = this.requireFeature(provider, 'refund', 'refund');
    return this.audited({ action: 'refund', provider, orderRef: input.orderRef, refundRef: input.refundRef, amount: input.amount }, async () => {
      this.assertLiveMutationAllowed('Refund', provider, opts.confirm === true);
      // refundRef is the idempotency key: the same refundRef can never trigger two refunds through this client.
      return withIdempotency(this.idem, `${provider}:refund`, input.refundRef, input, () => this.refundOrFindExisting(provider, gw, input));
    });
  }

  /**
   * gw.refund, but when the outcome is unknown (lost response) or the gateway rejects the refundRef as a
   * duplicate, look the refund up by refundRef first: if it exists, return it instead of an error that
   * reads like "no refund happened". Gateways without a refundRef lookup (PayU, CCAvenue) rethrow.
   */
  private async refundOrFindExisting(provider: ProviderId, gw: PaymentGateway & Required<Pick<PaymentGateway, 'refund'>>, input: RefundInput): Promise<RefundResult> {
    try {
      return await gw.refund(input);
    } catch (err) {
      if (!mayAlreadyExist(err) || !gw.getRefundStatus || gw.capabilities().features.refundStatus.support === 'unsupported') throw err;
      let found: RefundResult;
      try {
        found = await gw.getRefundStatus({ refundRef: input.refundRef, orderRef: input.orderRef, providerPaymentId: input.providerPaymentId });
      } catch (lookupErr) {
        this.logger.warn('refund.lookup_after_error_failed', { provider, refundRef: input.refundRef, err: String(lookupErr) });
        throw err;
      }
      if (input.amount !== undefined && found.amount !== undefined && found.amount !== input.amount) {
        throw new PaymentError('IDEMPOTENCY_CONFLICT', `A ${provider} refund with refundRef "${input.refundRef}" already exists for ${found.amount}, not ${input.amount}.`, {
          provider,
          hint: 'Use a new refundRef for a different refund.',
          raw: found.raw,
        });
      }
      this.logger.info('refund.found_existing', { provider, refundRef: input.refundRef, cause: (err as PaymentError).code });
      return found;
    }
  }

  async getRefundStatus(provider: ProviderId, input: RefundStatusInput) {
    return this.requireFeature(provider, 'refundStatus', 'getRefundStatus').getRefundStatus(input);
  }

  async parseWebhook(provider: ProviderId, input: WebhookInput): Promise<NormalizedWebhookEvent> {
    const gw = this.requireFeature(provider, 'webhooks', 'parseWebhook');
    try {
      const event = await gw.parseWebhook(input);
      return { ...event, bodyAuthenticated: this.config.mode === 'mock' || !WEBHOOK_BODY_UNAUTHENTICATED.has(provider) };
    } catch (err) {
      const pe = toPaymentError(err, provider);
      this.logger.warn('webhook.rejected', { provider, code: pe.code });
      await this.audit.record({ ts: this.now().toISOString(), action: 'webhook', provider, mode: this.config.mode, outcome: 'error', errorCode: pe.code, actor: this.actor }).catch(() => {});
      throw pe;
    }
  }

  async simulateWebhook(provider: ProviderId, input: SimulateWebhookInput) {
    const gw = this.requireFeature(provider, 'webhooks', 'parseWebhook');
    if (!gw.simulateWebhook) throw notImplemented(provider, 'webhook simulation');
    if (this.config.mode === 'live') {
      throw new PaymentError('LIVE_MUTATION_BLOCKED', 'Webhook simulation is disabled in live mode.', { provider });
    }
    return gw.simulateWebhook(input);
  }

  async createCustomer(provider: ProviderId, input: CreateCustomerInput) {
    return this.requireFeature(provider, 'customers', 'createCustomer').createCustomer(input);
  }

  async createSubscription(provider: ProviderId, input: CreateSubscriptionInput) {
    this.assertProviderOptions(provider, 'subscription', input.providerOptions);
    const gw = this.requireFeature(provider, 'subscriptions', 'createSubscription');
    return this.audited({ action: 'create_subscription', provider, orderRef: input.subscriptionRef }, () => gw.createSubscription(input));
  }

  async cancelSubscription(provider: ProviderId, input: CancelSubscriptionInput, opts: { confirm?: boolean } = {}) {
    const gw = this.requireFeature(provider, 'subscriptions', 'cancelSubscription');
    return this.audited({ action: 'cancel_subscription', provider, detail: { providerSubscriptionId: input.providerSubscriptionId } }, async () => {
      this.assertLiveMutationAllowed('Subscription cancellation', provider, opts.confirm === true);
      return gw.cancelSubscription(input);
    });
  }

  async listSettlements(provider: ProviderId, input: ListSettlementsInput) {
    return this.requireFeature(provider, 'settlements', 'listSettlements').listSettlements(input);
  }
}

export function createPaymentsClient(opts?: PaymentsClientOptions) {
  return new PaymentsClient(opts);
}
