import type { ProviderCapabilities } from './capabilities.js';
import type { HttpClient } from './http.js';
import type { Logger } from './logger.js';
import type {
  CancelSubscriptionInput,
  CreateCustomerInput,
  CreatePaymentInput,
  CreatePaymentResult,
  CreateSubscriptionInput,
  CustomerResult,
  Environment,
  ListSettlementsInput,
  ListSettlementsResult,
  NormalizedWebhookEvent,
  PaymentStatusInput,
  PaymentStatusResult,
  ProviderId,
  RefundInput,
  RefundResult,
  RefundStatusInput,
  SimulatedWebhook,
  SimulateWebhookInput,
  SubscriptionResult,
  VerifyPaymentInput,
  VerifyPaymentResult,
  WebhookInput,
} from './types.js';

/** Everything an adapter needs from the outside world. Injected so tests can fake it. */
export interface AdapterContext {
  environment: Environment;
  http: HttpClient;
  logger: Logger;
  /** Clock, injectable for tests. */
  now: () => Date;
}

/**
 * The contract every provider adapter implements.
 *
 * Optional methods are optional because not every gateway has the feature. The orchestrator
 * (PaymentsClient) checks `capabilities().features` first and throws a clear UNSUPPORTED /
 * NOT_IMPLEMENTED error, so adapters only implement what is real.
 */
export interface PaymentGateway {
  readonly id: ProviderId;
  readonly environment: Environment;
  capabilities(): ProviderCapabilities;

  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  /** Verify the browser callback / redirect / JS SDK handler payload. */
  verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>;
  getPaymentStatus(input: PaymentStatusInput): Promise<PaymentStatusResult>;
  /** Verify signature and normalise. Throws PaymentError('SIGNATURE_INVALID') on a bad signature. */
  parseWebhook(input: WebhookInput): Promise<NormalizedWebhookEvent>;

  refund?(input: RefundInput): Promise<RefundResult>;
  getRefundStatus?(input: RefundStatusInput): Promise<RefundResult>;
  createCustomer?(input: CreateCustomerInput): Promise<CustomerResult>;
  createSubscription?(input: CreateSubscriptionInput): Promise<SubscriptionResult>;
  cancelSubscription?(input: CancelSubscriptionInput): Promise<SubscriptionResult>;
  listSettlements?(input: ListSettlementsInput): Promise<ListSettlementsResult>;

  /**
   * Build a correctly signed webhook for tests and local development. Uses the adapter's own
   * webhook secret, so `parseWebhook(simulateWebhook(x))` must round-trip.
   */
  simulateWebhook?(input: SimulateWebhookInput): Promise<SimulatedWebhook>;
}

/** Each provider module exports one of these. */
export interface ProviderModule<C = Record<string, string | undefined>> {
  id: ProviderId;
  capabilities: ProviderCapabilities;
  /** Validates credentials (throw CONFIG_MISSING / CONFIG_INVALID) and returns a gateway. */
  create(credentials: C, ctx: AdapterContext): PaymentGateway;
  /** Pull the provider's error code/message out of a non-2xx response body. Used by the shared HTTP client. */
  extractError?(data: unknown, status: number): { code?: string; message?: string };
  /**
   * Top-level `providerOptions` keys this gateway refuses, per operation: fields that carry the
   * amount, the binding keys (order/subscription refs), redirect/notification URLs, or that route
   * money elsewhere (splits, transfers, connected accounts, manual capture). PaymentsClient checks
   * them, on top of a baseline list shared by every gateway, before any network call.
   */
  protectedOptionKeys?: {
    payment?: readonly string[];
    subscription?: readonly string[];
  };
}
