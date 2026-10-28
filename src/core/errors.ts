import type { ProviderId } from './types.js';

export type PaymentErrorCode =
  | 'CONFIG_MISSING' // credentials or settings absent
  | 'CONFIG_INVALID' // e.g. live mode with a test key
  | 'VALIDATION' // bad input from the caller
  | 'UNSUPPORTED' // the provider itself does not offer this feature
  | 'NOT_IMPLEMENTED' // the provider offers it, this project does not yet
  | 'AUTH' // provider rejected our credentials
  | 'PROVIDER_ERROR' // provider returned a 4xx business error
  | 'PROVIDER_UNAVAILABLE' // provider 5xx
  | 'NETWORK'
  | 'TIMEOUT'
  /** A non-idempotent mutation timed out or lost its connection: it may or may not have happened. Do NOT blindly retry. */
  | 'OUTCOME_UNKNOWN'
  | 'RATE_LIMITED'
  | 'SIGNATURE_INVALID'
  | 'LIVE_MUTATION_BLOCKED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_FOUND';

const RETRYABLE: ReadonlySet<PaymentErrorCode> = new Set([
  'PROVIDER_UNAVAILABLE',
  'NETWORK',
  'TIMEOUT',
  'RATE_LIMITED',
]);

export interface PaymentErrorDetails {
  provider?: ProviderId;
  httpStatus?: number;
  providerCode?: string;
  providerMessage?: string;
  /** One actionable sentence telling the developer what to do next. */
  hint?: string;
  raw?: unknown;
  cause?: unknown;
}

export class PaymentError extends Error {
  readonly code: PaymentErrorCode;
  readonly retryable: boolean;
  readonly provider?: ProviderId;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly providerMessage?: string;
  readonly hint?: string;
  readonly raw?: unknown;

  constructor(code: PaymentErrorCode, message: string, details: PaymentErrorDetails = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'PaymentError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.provider = details.provider;
    this.httpStatus = details.httpStatus;
    this.providerCode = details.providerCode;
    this.providerMessage = details.providerMessage;
    this.hint = details.hint;
    this.raw = details.raw;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      retryable: this.retryable,
      provider: this.provider,
      httpStatus: this.httpStatus,
      providerCode: this.providerCode,
      providerMessage: this.providerMessage,
      hint: this.hint,
    };
  }
}

export function unsupported(provider: ProviderId, feature: string, why: string): PaymentError {
  return new PaymentError('UNSUPPORTED', `${provider} does not support ${feature}. ${why}`, {
    provider,
    hint: 'Call payments_get_capabilities to see what this gateway supports, or choose another gateway.',
  });
}

export function notImplemented(provider: ProviderId, feature: string): PaymentError {
  return new PaymentError(
    'NOT_IMPLEMENTED',
    `${provider} offers ${feature}, but this adapter does not implement it yet.`,
    {
      provider,
      hint: 'Use providerOptions / the provider dashboard for now, or contribute it: see CONTRIBUTING.md.',
    },
  );
}

/** Map an HTTP status from a provider to our error code. */
export function codeForHttpStatus(status: number): PaymentErrorCode {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_ERROR';
}

export function toPaymentError(err: unknown, provider?: ProviderId): PaymentError {
  if (err instanceof PaymentError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new PaymentError('PROVIDER_ERROR', message, { provider, cause: err });
}
