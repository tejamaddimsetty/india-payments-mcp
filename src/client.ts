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
 * Gateways whose webhook authentication does not protect the body. PhonePe signs nothing (a static
 * SHA256(user:pass) header); CCAvenue's AES-CBC has no MAC, so ciphertext can be bit-flipped.
 */
/**
 * Request fields that carry the amount, order id, credentials or redirect targets on some gateway.
 * providerOptions may add fields but never override these: the amount we validated must be the
 * amount the gateway sees, and an agent must not be able to redirect the money or the callback.
 */
const PROTECTED_PROVIDER_OPTIONS = new Set([
  'amount', 'currency', 'key', 'hash', 'salt', 'txnid', 'surl', 'furl', 'productinfo',
  'order_id', 'order_amount', 'order_currency', 'merchant_id', 'access_code', 'redirect_url', 'cancel_url',
  'orderId', 'mid', 'txnAmount', 'callbackUrl', 'websiteName',
  'merchantOrderId', 'merchantUrls', 'paymentFlow', 'receipt',
  'success_url', 'line_items', 'client_reference_id', 'mode', 'payment_intent_data',
]);

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

  constructor(opts: PaymentsClientOptions = {}) {
    const base = loadConfigFromEnv(opts.env ?? process.env, allCapabilities());
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
    if (this.config.mode === 'mock' && process.env.NODE_ENV === 'production' && !/^(1|true)$/i.test(process.env.PAYMENTS_ALLOW_MOCK_IN_PRODUCTION ?? '')) {
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
    if (this.config.mode !== 'live' || !this.guardLiveMutations) return;
    if (!this.config.allowLiveMutations || !confirmed) {
      throw new PaymentError(
        'LIVE_MUTATION_BLOCKED',
        `${action} on ${provider} in LIVE mode is blocked.`,
        { provider, hint: 'Set PAYMENTS_ALLOW_LIVE_MUTATIONS=true on the server AND pass confirm=true on the call after a human has approved it.' },
      );
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
    const currency = (input.currency ?? 'INR').toUpperCase();
    const overridden = Object.keys(input.providerOptions ?? {}).filter((k) => PROTECTED_PROVIDER_OPTIONS.has(k));
    if (overridden.length) {
      throw new PaymentError('VALIDATION', `providerOptions may not override core fields: ${overridden.join(', ')}.`, {
        hint: 'Set amount, orderRef, currency and URLs through the normal inputs.',
      });
    }
    const gw = this.requireFeature(provider, 'createPayment', 'createPayment');
    return this.audited({ action: 'create_payment', provider, orderRef: input.orderRef, amount: input.amount, currency }, () =>
      withIdempotency(this.idem, `${provider}:create_payment`, input.idempotencyKey ?? input.orderRef, { ...input, currency }, () =>
        gw.createPayment({ ...input, currency }),
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

    const settled = result.status === 'captured' || result.status === 'authorized' || result.status === 'refunded' || result.status === 'partially_refunded';
    // `paid` requires the caller to have bound the callback to THEIR order and amount; otherwise a
    // genuine callback for some other (cheap) order would count as payment for this one.
    const bound = input.orderRef !== undefined && input.expectedAmount !== undefined;
    return {
      ...result,
      paid: result.valid && settled && bound,
      ...(result.valid && settled && !bound ? { reason: 'Pass orderRef and expectedAmount to get paid=true: an unbound callback could belong to a different order.' } : {}),
    };
  }

  getPaymentStatus(provider: ProviderId, input: PaymentStatusInput) {
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
      return withIdempotency(this.idem, `${provider}:refund`, input.refundRef, input, () => gw.refund(input));
    });
  }

  getRefundStatus(provider: ProviderId, input: RefundStatusInput) {
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

  simulateWebhook(provider: ProviderId, input: SimulateWebhookInput) {
    const gw = this.gateway(provider);
    if (!gw.simulateWebhook) throw notImplemented(provider, 'webhook simulation');
    if (this.config.mode === 'live') {
      throw new PaymentError('LIVE_MUTATION_BLOCKED', 'Webhook simulation is disabled in live mode.', { provider });
    }
    return gw.simulateWebhook(input);
  }

  createCustomer(provider: ProviderId, input: CreateCustomerInput) {
    return this.requireFeature(provider, 'customers', 'createCustomer').createCustomer(input);
  }

  createSubscription(provider: ProviderId, input: CreateSubscriptionInput) {
    const gw = this.requireFeature(provider, 'subscriptions', 'createSubscription');
    return this.audited({ action: 'create_subscription', provider, orderRef: input.subscriptionRef }, () => gw.createSubscription(input));
  }

  cancelSubscription(provider: ProviderId, input: CancelSubscriptionInput, opts: { confirm?: boolean } = {}) {
    const gw = this.requireFeature(provider, 'subscriptions', 'cancelSubscription');
    return this.audited({ action: 'cancel_subscription', provider, detail: { providerSubscriptionId: input.providerSubscriptionId } }, async () => {
      this.assertLiveMutationAllowed('Subscription cancellation', provider, opts.confirm === true);
      return gw.cancelSubscription(input);
    });
  }

  listSettlements(provider: ProviderId, input: ListSettlementsInput) {
    return this.requireFeature(provider, 'settlements', 'listSettlements').listSettlements(input);
  }
}

export function createPaymentsClient(opts?: PaymentsClientOptions) {
  return new PaymentsClient(opts);
}
