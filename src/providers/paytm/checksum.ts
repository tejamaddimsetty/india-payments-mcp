import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { safeEqual } from '../../core/crypto.js';

/**
 * Port of Paytm's official checksum library (github.com/paytm/Paytm_Node_Checksum, PaytmChecksum.js).
 *
 *   salt      = base64(3 random bytes)                      -> 4 chars
 *   hash      = sha256hex(params + "|" + salt) + salt
 *   signature = base64(AES-128-CBC(hash, key = merchant key as-is, iv = "@@@@&&&&####$$$$"))
 *
 * `params` is either a string (JSON APIs sign the exact `JSON.stringify(body)` that is sent) or a
 * flat object (form callbacks/webhooks: values sorted by key, joined with "|", null/"null" -> "").
 *
 * Differences from the official lib, all deliberate:
 * - Synchronous (the official generateSignature returns a Promise for no real reason).
 * - verifySignature never throws: a malformed checksum or wrong key returns false.
 * - verifySignature does not mutate the caller's object when stripping CHECKSUMHASH.
 * - Non-string object values are String()-ed and undefined is treated like null (the official lib
 *   would crash on `.toLowerCase()` of a number/undefined).
 */

const IV = '@@@@&&&&####$$$$';

export type PaytmParams = string | Record<string, string | number | boolean | null | undefined>;

function encrypt(input: string, key: string): string {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(IV, 'utf8'));
  return cipher.update(input, 'binary', 'base64') + cipher.final('base64');
}

function decrypt(encrypted: string, key: string): string {
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(IV, 'utf8'));
  return decipher.update(encrypted, 'base64', 'binary') + decipher.final('binary');
}

/** Official getStringByParams: values ordered by sorted key, joined with "|". */
export function paytmStringByParams(params: Record<string, unknown>): string {
  return Object.keys(params)
    .sort()
    .map((k) => {
      const v = params[k];
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.toLowerCase() === 'null' ? '' : s;
    })
    .join('|');
}

function toParamString(params: PaytmParams, stripChecksum: boolean): string {
  if (typeof params === 'string') return params;
  if (stripChecksum && 'CHECKSUMHASH' in params) {
    const { CHECKSUMHASH: _ignored, ...rest } = params;
    return paytmStringByParams(rest);
  }
  return paytmStringByParams(params);
}

function calculateHash(params: string, salt: string): string {
  return createHash('sha256').update(`${params}|${salt}`, 'utf8').digest('hex') + salt;
}

/** Deterministic core, exported for tests. Use generateSignature in real code. */
export function calculateChecksum(params: string, key: string, salt: string): string {
  return encrypt(calculateHash(params, salt), key);
}

export function generateSignature(params: PaytmParams, key: string): string {
  // Official generateRandomString(4): randomBytes(4 * 3 / 4).toString('base64').
  const salt = randomBytes(3).toString('base64');
  return calculateChecksum(toParamString(params, false), key, salt);
}

export function verifySignature(params: PaytmParams, key: string, checksum: string | undefined | null): boolean {
  if (typeof checksum !== 'string' || checksum.length === 0) return false;
  let paytmHash: string;
  try {
    paytmHash = decrypt(checksum, key);
  } catch {
    return false; // bad padding / wrong key / not base64
  }
  if (paytmHash.length < 5) return false;
  const salt = paytmHash.slice(-4);
  return safeEqual(paytmHash, calculateHash(toParamString(params, true), salt));
}
