import type { AdapterContext } from '../src/core/gateway.js';
import { createHttpClient, type FetchLike } from '../src/core/http.js';
import { silentLogger } from '../src/core/logger.js';
import type { Environment, ProviderId } from '../src/core/types.js';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface FakeRoute {
  /** Matched against `${METHOD} ${url}` with String.includes, or a RegExp. */
  match: string | RegExp;
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * Fake fetch: routes are matched in order; every request is recorded so tests can assert on
 * exactly what would have been sent to the gateway.
 */
export function fakeFetch(routes: FakeRoute[]) {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    requests.push({ url, method, headers, body: init?.body as string | undefined });
    const key = `${method} ${url}`;
    const route = routes.find((r) => (typeof r.match === 'string' ? key.includes(r.match) : r.match.test(key)));
    if (!route) return new Response(JSON.stringify({ error: `no fake route for ${key}` }), { status: 404, headers: { 'content-type': 'application/json' } });
    const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
    return new Response(text, { status: route.status ?? 200, headers: { 'content-type': 'application/json', ...(route.headers ?? {}) } });
  };
  return { fetch, requests };
}

export function testContext(
  provider: ProviderId,
  fetch: FetchLike,
  opts: { environment?: Environment; extractError?: (d: unknown, s: number) => { code?: string; message?: string } } = {},
): AdapterContext {
  return {
    environment: opts.environment ?? 'sandbox',
    logger: silentLogger,
    now: () => new Date('2026-10-28T10:00:00.000Z'),
    http: createHttpClient({ provider, logger: silentLogger, fetch, maxRetries: 0, extractError: opts.extractError, sleep: async () => {} }),
  };
}
