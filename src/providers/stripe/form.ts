/**
 * Stripe's API takes `application/x-www-form-urlencoded` bodies with bracketed nesting:
 *
 *   { line_items: [{ price_data: { currency: 'inr' }, quantity: 1 }], metadata: { order_ref: 'A1' } }
 *   => line_items[0][price_data][currency]=inr&line_items[0][quantity]=1&metadata[order_ref]=A1
 *
 * Rules (match stripe-node's encoder):
 * - `undefined` and `null` are skipped entirely. To clear a field on Stripe, pass '' explicitly.
 * - Booleans become "true"/"false"; numbers are stringified (integers only; we never send floats).
 * - Arrays use numeric indexes `a[0]=`, including arrays of objects `a[0][b]=`.
 * - Empty arrays / objects produce nothing.
 */
export function encodeStripeForm(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) append(out, key, value);
  return out;
}

function append(out: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => append(out, `${key}[${i}]`, v));
    return;
  }
  if (value instanceof Date) {
    // Stripe timestamps are unix seconds.
    out.append(key, String(Math.floor(value.getTime() / 1000)));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) append(out, `${key}[${k}]`, v);
    return;
  }
  out.append(key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));
}
