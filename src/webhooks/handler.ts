import type { PaymentsClient } from '../client.js';
import { PaymentError } from '../core/errors.js';
import type { NormalizedWebhookEvent, PaymentStatus, ProviderId, WebhookEventType, WebhookInput } from '../core/types.js';

/**
 * Remembers which webhook ids were processed. Back it with Redis/Postgres in production
 * (an INSERT with a unique key and a status column, or Redis SET NX + a "done" marker).
 */
export interface WebhookDedupeStore {
  /**
   * Atomically claim an id. `claimed`: you own it now. `in_progress`: another delivery is processing
   * it right now. `done`: it was processed before.
   */
  claim(id: string, ttlSeconds: number): Promise<'claimed' | 'in_progress' | 'done'>;
  /** Processing succeeded: later deliveries are duplicates. */
  complete(id: string, ttlSeconds: number): Promise<void>;
  /** Processing failed: the provider's retry must be processed again. */
  release(id: string): Promise<void>;
}

export class MemoryWebhookDedupeStore implements WebhookDedupeStore {
  /** A crashed handler must not hold a claim forever. */
  private static readonly PROCESSING_TTL_MS = 5 * 60_000;
  private readonly entries = new Map<string, { state: 'processing' | 'done'; expires: number }>();

  async claim(id: string) {
    const now = Date.now();
    const e = this.entries.get(id);
    if (e && e.expires > now) return e.state === 'done' ? 'done' : 'in_progress';
    this.entries.set(id, { state: 'processing', expires: now + MemoryWebhookDedupeStore.PROCESSING_TTL_MS });
    return 'claimed';
  }
  async complete(id: string, ttlSeconds: number) {
    this.entries.set(id, { state: 'done', expires: Date.now() + ttlSeconds * 1000 });
  }
  async release(id: string) {
    this.entries.delete(id);
  }
}

function typeForStatus(status: PaymentStatus): WebhookEventType {
  if (status === 'captured' || status === 'refunded' || status === 'partially_refunded') return 'payment.succeeded';
  if (status === 'authorized') return 'payment.authorized';
  if (status === 'failed' || status === 'cancelled' || status === 'expired') return 'payment.failed';
  return 'payment.pending';
}

export interface WebhookHandlerOptions {
  client: PaymentsClient;
  provider: ProviderId;
  onEvent: (event: NormalizedWebhookEvent) => Promise<void>;
  dedupe?: WebhookDedupeStore;
  dedupeTtlSeconds?: number;
}

export interface WebhookHandlerResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Framework-agnostic webhook endpoint logic:
 *   verify signature -> dedupe by event id -> run your handler -> 200.
 *
 * Status codes follow what gateways expect: 2xx = "delivered, stop retrying"; 4xx for a bad
 * signature (a retry will not fix it); 5xx when YOUR handler failed, so the gateway retries.
 */
export function createWebhookHandler(opts: WebhookHandlerOptions) {
  const dedupe = opts.dedupe ?? new MemoryWebhookDedupeStore();
  const ttl = opts.dedupeTtlSeconds ?? 7 * 24 * 3600;

  return async function handle(input: WebhookInput): Promise<WebhookHandlerResult> {
    let event: NormalizedWebhookEvent;
    try {
      event = await opts.client.parseWebhook(opts.provider, input);
    } catch (err) {
      if (err instanceof PaymentError && (err.code === 'SIGNATURE_INVALID' || err.code === 'VALIDATION')) {
        return { status: 400, body: { ok: false, error: err.code } };
      }
      return { status: 500, body: { ok: false, error: err instanceof PaymentError ? err.code : 'INTERNAL' } };
    }

    // For gateways whose webhook auth does not cover the body, replace what the body claims with what
    // the gateway's status API says, including the event type. Events we cannot confirm are passed
    // on with bodyAuthenticated=false: do not act on their amount/status without your own check.
    if (event.bodyAuthenticated === false && event.orderRef && event.type.startsWith('payment.')) {
      try {
        const confirmed = await opts.client.getPaymentStatus(opts.provider, { orderRef: event.orderRef, providerOrderId: event.providerOrderId });
        event = {
          ...event,
          type: typeForStatus(confirmed.status),
          status: confirmed.status,
          amount: confirmed.amount,
          providerPaymentId: confirmed.providerPaymentId ?? event.providerPaymentId,
          bodyAuthenticated: true,
        };
      } catch {
        return { status: 500, body: { ok: false, error: 'STATUS_CONFIRMATION_FAILED' } };
      }
    }

    const key = `${opts.provider}:${event.id}`;
    const claim = await dedupe.claim(key, ttl);
    if (claim === 'done') return { status: 200, body: { ok: true, duplicate: true } };
    // Another delivery is mid-flight. If it fails we need the gateway to try again, so don't 200.
    if (claim === 'in_progress') return { status: 409, body: { ok: false, error: 'IN_PROGRESS' } };
    try {
      await opts.onEvent(event);
    } catch (err) {
      await dedupe.release(key);
      opts.client.logger.error('webhook.handler_failed', { provider: opts.provider, eventId: event.id, err: String(err) });
      return { status: 500, body: { ok: false, error: 'HANDLER_FAILED' } };
    }
    await dedupe.complete(key, ttl);
    return { status: 200, body: { ok: true } };
  };
}
