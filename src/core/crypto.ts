import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function hmacSha256Hex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

export function hmacSha256Base64(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('base64');
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export function sha512Hex(data: string): string {
  return createHash('sha512').update(data, 'utf8').digest('hex');
}

export function md5(data: string): Buffer {
  return createHash('md5').update(data, 'utf8').digest();
}

/** Constant-time string comparison. Returns false (never throws) on length mismatch. */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Case-insensitive header lookup that also flattens array values. */
export function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}
