import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../../src/core/http.js';
import { silentLogger } from '../../src/core/logger.js';

function seq(statuses: number[]) {
  let i = 0;
  const calls: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${url}`);
    const status = statuses[Math.min(i++, statuses.length - 1)]!;
    return new Response(JSON.stringify({ status }), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const base = { provider: 'razorpay' as const, logger: silentLogger, sleep: async () => {}, maxRetries: 2 };

describe('http client', () => {
  it('retries GET on 5xx then succeeds', async () => {
    const s = seq([503, 502, 200]);
    const http = createHttpClient({ ...base, fetch: s.fetch });
    const res = await http.request({ method: 'GET', url: 'https://x/y', operation: 't' });
    expect(res.status).toBe(200);
    expect(s.calls).toHaveLength(3);
  });

  it('never retries a POST that is not marked retry-safe', async () => {
    const s = seq([503, 200]);
    const http = createHttpClient({ ...base, fetch: s.fetch });
    await expect(http.request({ method: 'POST', url: 'https://x/y', body: {}, operation: 't' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false });
    expect(s.calls).toHaveLength(1);
  });

  it('retries a retry-safe POST on 429', async () => {
    const s = seq([429, 200]);
    const http = createHttpClient({ ...base, fetch: s.fetch });
    await http.request({ method: 'POST', url: 'https://x/y', body: {}, operation: 't', retrySafe: true });
    expect(s.calls).toHaveLength(2);
  });

  it('maps 401 to AUTH with a hint', async () => {
    const http = createHttpClient({ ...base, fetch: seq([401]).fetch });
    await expect(http.request({ method: 'GET', url: 'https://x', operation: 't' })).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('turns network failures into NETWORK errors', async () => {
    const http = createHttpClient({ ...base, maxRetries: 0, fetch: async () => { throw new TypeError('fetch failed'); } });
    await expect(http.request({ method: 'GET', url: 'https://x', operation: 't' })).rejects.toMatchObject({ code: 'NETWORK', retryable: true });
    // A POST that may have reached the gateway is reported as unknown, never as safe to retry.
    await expect(http.request({ method: 'POST', url: 'https://x', operation: 't' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryable: false });
  });

  it('times out while the response body is stalled', async () => {
    const http = createHttpClient({
      ...base,
      maxRetries: 0,
      defaultTimeoutMs: 30,
      fetch: async (_u, init) =>
        new Response(new ReadableStream({ start(c) { init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))); } }), { status: 200 }),
    });
    await expect(http.request({ method: 'GET', url: 'https://x', operation: 't' })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('form-encodes URLSearchParams bodies', async () => {
    let seen: RequestInit | undefined;
    const http = createHttpClient({ ...base, fetch: async (_u, init) => { seen = init; return new Response('{}', { status: 200 }); } });
    await http.request({ method: 'POST', url: 'https://x', operation: 't', body: new URLSearchParams({ a: '1' }) });
    expect(seen?.body).toBe('a=1');
    expect((seen?.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
  });
});
