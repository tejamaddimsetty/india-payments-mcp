import { randomUUID } from 'node:crypto';
import { codeForHttpStatus, PaymentError } from './errors.js';
import type { Logger } from './logger.js';
import type { ProviderId } from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** Object => JSON. URLSearchParams => form-encoded. string => sent as-is. */
  body?: unknown;
  timeoutMs?: number;
  /**
   * Retrying a POST that creates money movement is only safe when the provider de-duplicates it
   * (idempotency key header, or a merchant-supplied unique id such as refund_id). Set this to true
   * only in those cases. GETs are always retry-safe.
   */
  retrySafe?: boolean;
  /** Short label for logs, e.g. "create_order". */
  operation: string;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
  text: string;
  requestId: string;
}

export interface HttpClientOptions {
  provider: ProviderId;
  logger: Logger;
  fetch?: FetchLike;
  maxRetries?: number;
  baseDelayMs?: number;
  defaultTimeoutMs?: number;
  /** Turn a non-2xx body into a provider code/message. */
  extractError?: (data: unknown, status: number) => { code?: string; message?: string };
  sleep?: (ms: number) => Promise<void>;
}

export interface HttpClient {
  request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Small fetch wrapper with: timeouts, retries with exponential backoff + full jitter (only when
 * safe), Retry-After support, structured logs, and provider errors mapped to PaymentError.
 */
export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const doFetch: FetchLike = opts.fetch ?? ((i, init) => fetch(i, init));
  const maxRetries = opts.maxRetries ?? 2;
  const baseDelay = opts.baseDelayMs ?? 300;
  const sleep = opts.sleep ?? defaultSleep;

  return {
    async request<T>(req: HttpRequest): Promise<HttpResponse<T>> {
      const requestId = randomUUID();
      const retrySafe = req.method === 'GET' || req.retrySafe === true;
      const headers: Record<string, string> = { Accept: 'application/json', ...(req.headers ?? {}) };
      let body: string | undefined;
      if (req.body instanceof URLSearchParams) {
        body = req.body.toString();
        headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
      } else if (typeof req.body === 'string') {
        body = req.body;
      } else if (req.body !== undefined) {
        body = JSON.stringify(req.body);
        headers['Content-Type'] ??= 'application/json';
      }

      let attempt = 0;
      for (;;) {
        attempt++;
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? opts.defaultTimeoutMs ?? 30_000);
        let res: Response;
        try {
          res = await doFetch(req.url, { method: req.method, headers, body, signal: controller.signal });
        } catch (err) {
          clearTimeout(timer);
          const timedOut = (err as Error)?.name === 'AbortError';
          const pe = new PaymentError(
            retrySafe ? (timedOut ? 'TIMEOUT' : 'NETWORK') : 'OUTCOME_UNKNOWN',
            `${opts.provider} ${req.operation}: ${timedOut ? 'request timed out' : 'network error'}`,
            {
              provider: opts.provider,
              cause: err,
              hint: retrySafe
                ? undefined
                : 'The request may or may not have been processed by the gateway. Look the payment/refund up with the status APIs before retrying.',
            },
          );
          opts.logger.warn('http.error', { provider: opts.provider, op: req.operation, attempt, requestId, code: pe.code });
          if (retrySafe && attempt <= maxRetries) {
            await sleep(backoff(attempt, baseDelay));
            continue;
          }
          throw pe;
        }
        // The timer stays armed while the body streams in: a stalled body is a timeout too.
        let text: string;
        try {
          text = await res.text();
        } catch (err) {
          clearTimeout(timer);
          throw new PaymentError(retrySafe ? 'TIMEOUT' : 'OUTCOME_UNKNOWN', `${opts.provider} ${req.operation}: response body did not arrive in time`, { provider: opts.provider, cause: err });
        }
        clearTimeout(timer);
        let data: unknown = text;
        if (text && /json/i.test(res.headers.get('content-type') ?? '') ) {
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
        } else if (text && (text.startsWith('{') || text.startsWith('['))) {
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
        }

        opts.logger.debug('http.response', {
          provider: opts.provider,
          op: req.operation,
          status: res.status,
          ms: Date.now() - started,
          attempt,
          requestId,
        });

        if (res.ok) return { status: res.status, headers: res.headers, data: data as T, text, requestId };

        let code = codeForHttpStatus(res.status);
        // A 5xx/gateway timeout on a non-idempotent POST may still have been processed upstream.
        if (code === 'PROVIDER_UNAVAILABLE' && !retrySafe) code = 'OUTCOME_UNKNOWN';
        const extracted = opts.extractError?.(data, res.status) ?? {};
        const canRetry = (code === 'RATE_LIMITED' || code === 'PROVIDER_UNAVAILABLE') && retrySafe && attempt <= maxRetries;
        opts.logger.warn('http.non_2xx', {
          provider: opts.provider,
          op: req.operation,
          status: res.status,
          providerCode: extracted.code,
          attempt,
          willRetry: canRetry,
          requestId,
        });
        if (canRetry) {
          const retryAfter = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : backoff(attempt, baseDelay));
          continue;
        }
        throw new PaymentError(
          code,
          `${opts.provider} ${req.operation} failed (HTTP ${res.status})${extracted.message ? `: ${extracted.message}` : ''}`,
          {
            provider: opts.provider,
            httpStatus: res.status,
            providerCode: extracted.code,
            providerMessage: extracted.message,
            raw: data,
            hint: code === 'AUTH' ? 'Check the API credentials and that sandbox/live keys match PAYMENTS_MODE.' : undefined,
          },
        );
      }
    },
  };
}

function backoff(attempt: number, base: number): number {
  const cap = base * 2 ** (attempt - 1);
  return Math.round(cap / 2 + Math.random() * (cap / 2));
}
