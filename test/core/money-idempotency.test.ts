import { describe, expect, it } from 'vitest';
import { MemoryIdempotencyStore, withIdempotency } from '../../src/core/idempotency.js';
import { redact } from '../../src/core/logger.js';
import { assertMinorUnits, fromMajor, toMajorString } from '../../src/core/money.js';

describe('money', () => {
  it('converts paise to rupee strings and back without float drift', () => {
    expect(toMajorString(49900)).toBe('499.00');
    expect(toMajorString(5)).toBe('0.05');
    expect(fromMajor('499.00')).toBe(49900);
    expect(fromMajor(10.15)).toBe(1015);
    expect(fromMajor('0.29')).toBe(29);
  });
  it('rejects non-integer or non-positive amounts', () => {
    expect(() => assertMinorUnits(499.5)).toThrow(/minor units/);
    expect(() => assertMinorUnits(0)).toThrow();
  });
});

describe('idempotency', () => {
  it('returns the stored result for a replay and rejects a different body', async () => {
    const store = new MemoryIdempotencyStore();
    let calls = 0;
    const run = (body: unknown) => withIdempotency(store, 'refund', 'k1', body, async () => ++calls);
    expect(await run({ a: 1, b: 2 })).toBe(1);
    expect(await run({ b: 2, a: 1 })).toBe(1);
    expect(calls).toBe(1);
    await expect(run({ a: 2 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('collapses concurrent duplicates into one execution', async () => {
    const store = new MemoryIdempotencyStore();
    let calls = 0;
    const slow = () => withIdempotency(store, 'refund', 'k2', { a: 1 }, async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return calls; });
    const [x, y] = await Promise.all([slow(), slow()]);
    expect([x, y, calls]).toEqual([1, 1, 1]);
  });

  it('does not store failures', async () => {
    const store = new MemoryIdempotencyStore();
    await expect(withIdempotency(store, 's', 'k', {}, async () => { throw new Error('boom'); })).rejects.toThrow();
    expect(await withIdempotency(store, 's', 'k', {}, async () => 'ok')).toBe('ok');
  });
});

describe('redaction', () => {
  it('redacts secret-looking keys at any depth', () => {
    const out = redact({ keySecret: 'x', nested: { webhook_secret: 'y', amount: 5 }, headers: { Authorization: 'Basic z' } }) as any;
    expect(out.keySecret).toBe('[redacted]');
    expect(out.nested.webhook_secret).toBe('[redacted]');
    expect(out.nested.amount).toBe(5);
    expect(out.headers.Authorization).toBe('[redacted]');
  });
});
