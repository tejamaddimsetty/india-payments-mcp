import { existsSync, readFileSync } from 'node:fs';
import { PaymentError } from '../../core/errors.js';
import { toMajorString } from '../../core/money.js';
import type { ProviderId } from '../../core/types.js';

/**
 * Your standing receiving account details, copied once from the collection service's dashboard
 * (Skydo: International Accounts; Infinity: global accounts). These services give each merchant
 * local accounts abroad plus a SWIFT account. The details never change per invoice, so printing them
 * with a unique reference is how they are meant to be used.
 *
 * <PREFIX>_RECEIVING_ACCOUNTS (SKYDO_ or INFINITY_) is either inline JSON or a path to a .json file:
 * [
 *   { "currency": "USD", "label": "US account (ACH / Fedwire)",
 *     "details": { "Account holder": "Acme Exports", "Bank": "...", "Account number": "...", "ACH routing": "..." } },
 *   { "currency": "*", "label": "SWIFT (any other currency)", "details": { "SWIFT/BIC": "...", "IBAN / Account": "..." } }
 * ]
 * "*" is the fallback account used when no account matches the invoice currency.
 */
export interface ReceivingAccount {
  currency: string;
  label?: string;
  details: Record<string, string>;
}

export function parseReceivingAccounts(value: string | undefined, provider: ProviderId, env: string): ReceivingAccount[] {
  if (!value) return [];
  const raw = value.trim().startsWith('[') ? value : existsSync(value) ? readFileSync(value, 'utf8') : undefined;
  if (raw === undefined) {
    throw new PaymentError('CONFIG_INVALID', `${env} is neither JSON nor an existing file: ${value}`, { provider });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PaymentError('CONFIG_INVALID', `${env} is not valid JSON: ${(err as Error).message}`, { provider });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new PaymentError('CONFIG_INVALID', `${env} must be a non-empty JSON array.`, { provider });
  }
  return parsed.map((a, i) => {
    const acc = a as Partial<ReceivingAccount>;
    if (typeof acc.currency !== 'string' || !/^([A-Za-z]{3}|\*)$/.test(acc.currency)) {
      throw new PaymentError('CONFIG_INVALID', `${env}[${i}].currency must be an ISO code like "USD" or "*".`, { provider });
    }
    if (!acc.details || typeof acc.details !== 'object' || Object.keys(acc.details).length === 0 || Object.values(acc.details).some((v) => typeof v !== 'string')) {
      throw new PaymentError('CONFIG_INVALID', `${env}[${i}].details must be an object of label -> text.`, { provider });
    }
    return { currency: acc.currency.toUpperCase(), label: acc.label, details: acc.details as Record<string, string> };
  });
}

export function accountFor(accounts: ReceivingAccount[], currency: string): ReceivingAccount | undefined {
  const c = currency.toUpperCase();
  return accounts.find((a) => a.currency === c) ?? accounts.find((a) => a.currency === '*');
}

/** Plain-text payment instructions: safe for an email, a PDF, an invoice note or a checkout page. */
export function paymentInstructions(account: ReceivingAccount, input: { reference: string; amount: number; currency: string; payee?: string; footer: string }): string {
  const lines = [
    `Please pay ${input.currency.toUpperCase()} ${toMajorString(input.amount, input.currency)} by bank transfer${input.payee ? ` to ${input.payee}` : ''}.`,
    `Payment reference (include it in the transfer note): ${input.reference}`,
    '',
    account.label ?? `${account.currency === '*' ? 'International' : account.currency} account`,
    ...Object.entries(account.details).map(([k, v]) => `${k}: ${v}`),
    '',
    input.footer,
  ];
  return lines.join('\n');
}
