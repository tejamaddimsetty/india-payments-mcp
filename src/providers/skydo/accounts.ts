import { parseReceivingAccounts as parse, type ReceivingAccount } from '../shared/accounts.js';

// Moved to ../shared/accounts.ts (shared with Infinity). Kept so existing deep imports keep working.
export { accountFor, paymentInstructions, type ReceivingAccount } from '../shared/accounts.js';

export function parseReceivingAccounts(value: string | undefined): ReceivingAccount[] {
  return parse(value, 'skydo', 'SKYDO_RECEIVING_ACCOUNTS');
}
