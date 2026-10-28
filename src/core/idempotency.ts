import { createHash } from 'node:crypto';
import { PaymentError } from './errors.js';

export interface IdempotencyRecord {
  fingerprint: string;
  result: unknown;
  createdAt: number;
}

/** Pluggable so production deployments can back it with Redis/Postgres. */
export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | undefined>;
  set(key: string, record: IdempotencyRecord, ttlSeconds: number): Promise<void>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, { rec: IdempotencyRecord; expires: number }>();
  constructor(private readonly maxEntries = 10_000) {}

  async get(key: string) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.rec;
  }

  async set(key: string, rec: IdempotencyRecord, ttlSeconds: number) {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { rec, expires: Date.now() + ttlSeconds * 1000 });
  }
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/** In-flight calls per store, so two concurrent identical requests in one process share one execution. */
const inFlight = new WeakMap<IdempotencyStore, Map<string, { fp: string; promise: Promise<unknown> }>>();

/**
 * Run `fn` at most once per (scope, key). A replay with the same request returns the stored result;
 * a replay with a DIFFERENT request under the same key is rejected, because that is almost always a bug.
 * Failures are not stored, so a failed call can be retried with the same key.
 *
 * Concurrent duplicates are collapsed in-process. Across processes, the store must provide the
 * guarantee (e.g. Redis SET NX); MemoryIdempotencyStore is single-process only.
 */
export async function withIdempotency<T>(
  store: IdempotencyStore,
  scope: string,
  key: string | undefined,
  request: unknown,
  fn: () => Promise<T>,
  ttlSeconds = 24 * 3600,
): Promise<T> {
  if (!key) return fn();
  const fullKey = `${scope}:${key}`;
  const fp = fingerprint(request);
  const existing = await store.get(fullKey);
  if (existing) {
    if (existing.fingerprint !== fp) {
      throw new PaymentError(
        'IDEMPOTENCY_CONFLICT',
        `Idempotency key "${key}" was already used for a different ${scope} request.`,
        { hint: 'Use a new idempotency key for a new request.' },
      );
    }
    return existing.result as T;
  }
  let pending = inFlight.get(store);
  if (!pending) inFlight.set(store, (pending = new Map()));
  const running = pending.get(fullKey);
  if (running) {
    if (running.fp !== fp) {
      throw new PaymentError('IDEMPOTENCY_CONFLICT', `Idempotency key "${key}" is in use by a different in-flight ${scope} request.`);
    }
    return running.promise as Promise<T>;
  }
  const promise = (async () => {
    const result = await fn();
    await store.set(fullKey, { fingerprint: fp, result, createdAt: Date.now() }, ttlSeconds);
    return result;
  })();
  pending.set(fullKey, { fp, promise });
  try {
    return await promise;
  } finally {
    pending.delete(fullKey);
  }
}
