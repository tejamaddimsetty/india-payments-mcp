import { PaymentError } from './errors.js';

/** Currencies with no minor unit. Everything else we treat as 2 decimals. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'PYG', 'UGX', 'XAF', 'XOF']);

export function minorUnitDigits(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

export function assertMinorUnits(amount: number, field = 'amount'): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new PaymentError(
      'VALIDATION',
      `${field} must be a positive integer in minor units (paise). Got ${amount}.`,
      { hint: 'Rs 499.00 is 49900. Never pass rupees with decimals.' },
    );
  }
}

/** 49900, INR -> "499.00". For gateways that want a decimal string. */
export function toMajorString(amount: number, currency = 'INR'): string {
  const digits = minorUnitDigits(currency);
  if (digits === 0) return String(amount);
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${major}.${minor}`;
}

/** "499.00" | 499 | "499" -> 49900. Rounds to the nearest paisa to absorb float noise. */
export function fromMajor(value: string | number, currency = 'INR'): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) {
    throw new PaymentError('VALIDATION', `Cannot parse amount "${value}"`);
  }
  return Math.round(n * 10 ** minorUnitDigits(currency));
}
