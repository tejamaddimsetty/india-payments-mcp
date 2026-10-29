import { homedir } from 'node:os';
import { join } from 'node:path';
import { PaymentError, unsupported } from '../../core/errors.js';
import type { AdapterContext, PaymentGateway, ProviderModule } from '../../core/gateway.js';
import { toMajorString } from '../../core/money.js';
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentStatusInput,
  PaymentStatusResult,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from '../../core/types.js';
import { accountFor, parseReceivingAccounts, paymentInstructions, type ReceivingAccount } from '../shared/accounts.js';
import { PaymentLedger, type LedgerEntry } from '../shared/ledger.js';
import { ManualCollections, type RecordPaymentInput } from '../shared/manual-collections.js';
import { ZohoBooks } from '../shared/zoho.js';
import { ZohoInvoiceBridge } from '../shared/zoho-bridge.js';
import { infinityCapabilities } from './capabilities.js';

/**
 * Infinity (infinityapp.in) publishes no developer API docs or webhooks (checked 2026-10-29, see
 * docs/research/verification/infinity-api-search.md), and its Terms forbid reverse engineering and
 * incorporating the Services into other systems. This adapter therefore never talks to Infinity.
 * It automates the paths Infinity offers merchants:
 *
 *  - Zoho Books bridge (INFINITY_ZOHO_* set): Infinity's dashboard has a Zoho Books integration
 *    (Connect tab). We create the invoice through Zoho's public API and read its status back, with the
 *    same shared, reviewed code as Skydo's bridge. What exactly Infinity syncs is not publicly
 *    documented: an invoice is paid only when Zoho records payments covering its total.
 *  - Bank transfer: your standing Infinity receiving-account details, with the orderRef as reference.
 *  - QuickLink: a payment link (card or bank transfer) you create in the Infinity dashboard and pass in
 *    as providerOptions.quickLinkUrl. We only accept https links on Infinity hosts.
 *
 * Without Zoho the expected payment is tracked in a local ledger, and an admin records the receipt once
 * the Infinity dashboard shows it, exactly like Skydo's ledger mode (same shared, reviewed code).
 */
export interface InfinityCredentials {
  receivingAccounts?: string;
  quickLinkOnly?: string;
  quickLinkHosts?: string;
  payeeName?: string;
  ledgerFile?: string;
  zohoDataCenter?: string;
  zohoClientId?: string;
  zohoClientSecret?: string;
  zohoRefreshToken?: string;
  zohoOrganizationId?: string;
  zohoItemId?: string;
  zohoAccountsUrl?: string;
}

/** Infinity-prefixed, so setting Skydo's ZOHO_* never silently moves Infinity onto Zoho (or vice versa). */
const ZOHO_KEYS = {
  zohoDataCenter: 'INFINITY_ZOHO_DATA_CENTER',
  zohoClientId: 'INFINITY_ZOHO_CLIENT_ID',
  zohoClientSecret: 'INFINITY_ZOHO_CLIENT_SECRET',
  zohoRefreshToken: 'INFINITY_ZOHO_REFRESH_TOKEN',
  zohoOrganizationId: 'INFINITY_ZOHO_ORGANIZATION_ID',
  zohoItemId: 'INFINITY_ZOHO_ITEM_ID',
} as const;

const ZOHO_SYNC =
  'Infinity\'s Zoho Books integration (Infinity dashboard > Connect > Zoho Books) works from your Zoho invoices. This invoice counts as paid only when Zoho records payments covering its total.';

export type { RecordPaymentInput };

/** "*.host" allows the host and its subdomains; a bare host matches exactly. */
const DEFAULT_QUICKLINK_HOSTS = ['*.infinityapp.in'];
const FOOTER = 'Payments are received through Infinity (infinityapp.in) and settled to India with a FIRA.';
/** UK Faster Payments references are commonly capped at 18 characters. */
const UK_REFERENCE_MAX = 18;
const MAX_URL = 2048;

function parseBool(value: string | undefined, env: string): boolean {
  if (value === undefined || value === '') return false;
  if (/^(true|1|yes)$/i.test(value)) return true;
  if (/^(false|0|no)$/i.test(value)) return false;
  throw new PaymentError('CONFIG_INVALID', `${env} must be true or false (got "${value}").`, { provider: 'infinity' });
}

function parseHosts(value: string | undefined): string[] {
  if (!value) return DEFAULT_QUICKLINK_HOSTS;
  const hosts = value
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const h of hosts) {
    const name = h.startsWith('*.') ? h.slice(2) : h;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name) || /^[\d.]+$/.test(name)) {
      throw new PaymentError('CONFIG_INVALID', `INFINITY_QUICKLINK_HOSTS entry "${h}" is not a host name (no scheme, path, port or IP address).`, { provider: 'infinity' });
    }
    // A wildcard on a bare suffix (*.co.in, *.com) would allow anyone's site.
    if (h.startsWith('*.') && (name.split('.').length < 2 || /^(com|net|org|co|in|io|app|dev)(\.[a-z]{2})?$/.test(name))) {
      throw new PaymentError('CONFIG_INVALID', `INFINITY_QUICKLINK_HOSTS entry "${h}" is too broad: use a wildcard only on a domain Infinity owns.`, { provider: 'infinity' });
    }
  }
  if (hosts.length === 0) throw new PaymentError('CONFIG_INVALID', 'INFINITY_QUICKLINK_HOSTS is empty.', { provider: 'infinity' });
  return hosts;
}

/**
 * A QuickLink is sent to a paying client, so a wrong link sends their money (or card details) to
 * someone else. Accept only a plain https URL on an allowed host (or its subdomain).
 */
export function validateQuickLink(value: unknown, hosts: readonly string[]): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_URL) {
    throw new PaymentError('VALIDATION', 'providerOptions.quickLinkUrl must be the QuickLink URL copied from the Infinity dashboard.', { provider: 'infinity' });
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PaymentError('VALIDATION', `quickLinkUrl "${value}" is not a URL.`, { provider: 'infinity' });
  }
  const host = url.hostname.toLowerCase();
  const allowed = hosts.some((h) => (h.startsWith('*.') ? host === h.slice(2) || host.endsWith(h.slice(1)) : host === h));
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed) {
    throw new PaymentError('VALIDATION', `quickLinkUrl must be an https link on ${hosts.map((h) => h.replace(/^\*\./, '')).join(', ')} (got host "${host}", scheme "${url.protocol}").`, {
      provider: 'infinity',
      hint: 'Copy the link from the Infinity dashboard. If your real QuickLinks use a different Infinity host, add it to INFINITY_QUICKLINK_HOSTS.',
    });
  }
  return url.toString();
}

export class InfinityGateway implements PaymentGateway {
  readonly id = 'infinity' as const;
  readonly environment;
  private readonly accounts: ReceivingAccount[];
  private readonly quickLinkOnly: boolean;
  private readonly quickLinkHosts: string[];
  private readonly zoho?: ZohoInvoiceBridge;
  private collectionsInstance?: ManualCollections;

  constructor(
    private readonly creds: InfinityCredentials,
    private readonly ctx: AdapterContext,
  ) {
    this.environment = ctx.environment;
    this.accounts = parseReceivingAccounts(creds.receivingAccounts, 'infinity', 'INFINITY_RECEIVING_ACCOUNTS');
    this.quickLinkOnly = parseBool(creds.quickLinkOnly, 'INFINITY_QUICKLINK_ONLY');
    this.quickLinkHosts = parseHosts(creds.quickLinkHosts);
    const keys = Object.keys(ZOHO_KEYS) as Array<keyof typeof ZOHO_KEYS>;
    const set = keys.filter((k) => creds[k]);
    if (set.length > 0 && set.length < keys.length) {
      const missing = keys.filter((k) => !creds[k]).map((k) => ZOHO_KEYS[k]);
      throw new PaymentError('CONFIG_MISSING', `Infinity's Zoho Books bridge is half-configured. Missing: ${missing.join(', ')}.`, { provider: 'infinity' });
    }
    if (set.length === keys.length) {
      const books = new ZohoBooks(
        {
          provider: 'infinity',
          envPrefix: 'INFINITY_ZOHO_',
          dataCenter: creds.zohoDataCenter!,
          clientId: creds.zohoClientId!,
          clientSecret: creds.zohoClientSecret!,
          refreshToken: creds.zohoRefreshToken!,
          organizationId: creds.zohoOrganizationId!,
          accountsUrl: creds.zohoAccountsUrl,
        },
        ctx.http,
        ctx.now,
      );
      this.zoho = new ZohoInvoiceBridge(books, {
        provider: 'infinity',
        environment: this.environment,
        itemId: creds.zohoItemId!,
        syncNote: ZOHO_SYNC,
        // Whatever Infinity offers on the Zoho invoice; the gateway does not know which method the client used.
        method: 'infinity_zoho_invoice',
      });
    }
    if (this.quickLinkOnly && (this.accounts.length > 0 || this.zoho)) {
      throw new PaymentError('CONFIG_INVALID', 'INFINITY_QUICKLINK_ONLY=true means QuickLinks only: unset INFINITY_RECEIVING_ACCOUNTS and the INFINITY_ZOHO_* variables, or unset INFINITY_QUICKLINK_ONLY.', { provider: 'infinity' });
    }
    if (!this.zoho && this.accounts.length === 0 && !this.quickLinkOnly) {
      throw new PaymentError(
        'CONFIG_MISSING',
        'Infinity needs INFINITY_RECEIVING_ACCOUNTS (your account details from the Infinity dashboard), INFINITY_QUICKLINK_ONLY=true to use QuickLinks only, or the INFINITY_ZOHO_* variables for the Zoho Books bridge.',
        { provider: 'infinity', hint: 'Infinity has no API key. See docs/infinity.md.' },
      );
    }
    // The ledger only exists without Zoho, so a broken ledger file can never block the Zoho bridge.
    if (!this.zoho) this.collections();
  }

  private collections(): ManualCollections {
    this.collectionsInstance ??= new ManualCollections(
      new PaymentLedger(this.creds.ledgerFile ?? join(homedir(), '.india-payments-mcp', 'infinity-ledger.json'), 'infinity', 'Infinity'),
      {
        provider: 'infinity',
        label: 'Infinity',
        environment: this.environment,
        now: this.ctx.now,
        receiptIdHint: 'the Infinity transaction reference shown in the dashboard',
        method: (e) => (e.paymentUrl ? 'quicklink_or_bank_transfer' : 'international_bank_transfer'),
      },
    );
    return this.collectionsInstance;
  }

  /** "zoho": invoices through Zoho Books, status from Zoho. "ledger": account details / QuickLink + local ledger. */
  get mode(): 'zoho' | 'ledger' {
    return this.zoho ? 'zoho' : 'ledger';
  }

  capabilities() {
    return infinityCapabilities;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const currency = (input.currency ?? '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency) || currency === 'INR') {
      throw new PaymentError('VALIDATION', 'Infinity receives foreign currency from abroad: pass the client\'s ISO currency (USD, EUR, GBP, AUD, CAD, ...). INR is not supported.', {
        provider: 'infinity',
        hint: 'For domestic INR payments use razorpay, cashfree, payu, phonepe, paytm or ccavenue.',
      });
    }
    const rawLink = input.providerOptions?.quickLinkUrl;
    if (rawLink !== undefined && this.zoho) {
      // The Zoho invoice is the payment document; a link passed later could never be checked against it.
      throw new PaymentError('VALIDATION', 'With the Zoho Books bridge the client pays from the Zoho invoice: providerOptions.quickLinkUrl is not accepted.', {
        provider: 'infinity',
        hint: 'Add a QuickLink to the Zoho invoice yourself if you want one, or use ledger mode (INFINITY_RECEIVING_ACCOUNTS / INFINITY_QUICKLINK_ONLY).',
      });
    }
    // Asking again without a link (e.g. to resend the instructions) reuses the link already on the order.
    const link = rawLink !== undefined ? validateQuickLink(rawLink, this.quickLinkHosts) : this.zoho ? undefined : this.collections().find(input.orderRef)?.paymentUrl;
    if (link && !this.zoho) {
      const existing = this.collections().find(input.orderRef);
      if (existing && existing.status !== 'created' && existing.status !== 'pending') {
        throw new PaymentError('VALIDATION', `orderRef ${input.orderRef} is ${existing.status}: payment instructions are not sent again.`, { provider: 'infinity' });
      }
    }
    const account = accountFor(this.accounts, currency);
    if (!link && !account && !this.zoho) {
      throw new PaymentError(
        'CONFIG_MISSING',
        this.accounts.length === 0
          ? 'INFINITY_QUICKLINK_ONLY is set: pass providerOptions.quickLinkUrl (create the QuickLink in the Infinity dashboard first).'
          : `No Infinity receiving account for ${currency} and no "*" fallback in INFINITY_RECEIVING_ACCOUNTS. Add one, or pass providerOptions.quickLinkUrl.`,
        { provider: 'infinity' },
      );
    }
    const amount = `${currency} ${toMajorString(input.amount, currency)}`;
    const parts: string[] = [];
    if (link) {
      parts.push(`Pay ${amount}${this.creds.payeeName ? ` to ${this.creds.payeeName}` : ''} online (card or bank transfer): ${link}`);
      parts.push(`Reference: ${input.orderRef}`);
    }
    if (account) {
      if (link) parts.push('', 'Or pay by bank transfer:');
      parts.push(paymentInstructions(account, { reference: input.orderRef, amount: input.amount, currency, payee: this.creds.payeeName, footer: FOOTER }));
    } else if (link) {
      parts.push('', FOOTER);
    }
    const notes = [
      this.zoho
        ? 'During setup, confirm with your first real invoice that Infinity records the payment on the Zoho invoice; until Zoho shows it paid in full, this order is not paid.'
        : 'When the Infinity dashboard shows the payment received, record it (MCP: payments_infinity_record_payment; SDK: client.infinityRecordPayment) with the Infinity transaction reference as receiptId.',
      ...(link ? [`Check that the QuickLink is for exactly ${amount}: this code cannot read what the link charges.`] : []),
      ...(!this.zoho
        ? ['Use a receiptId unique to each payment (if Infinity shows only the invoice reference, add a suffix per instalment, e.g. INV-12/1), or a second equal instalment is treated as the same receipt.']
        : []),
      ...(currency === 'GBP' && input.orderRef.length > UK_REFERENCE_MAX
        ? [`UK bank transfers often cut references to ${UK_REFERENCE_MAX} characters; "${input.orderRef}" is ${input.orderRef.length}. Prefer a shorter orderRef for GBP.`]
        : []),
    ];
    if (this.zoho) return this.zoho.createInvoice(input, currency, parts.length ? parts.join('\n') : undefined, notes);
    return this.collections().createEntry(input, currency, [...parts, '', ...notes].join('\n'), link);
  }

  async getPaymentStatus(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    return this.zoho ? this.zoho.status(input) : this.collections().status(input.orderRef);
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    return this.zoho ? this.zoho.verify(input) : this.collections().verify(input);
  }

  /** Record money the Infinity dashboard shows as received. Idempotent per receiptId; partial receipts stay pending. */
  async recordPayment(input: RecordPaymentInput): Promise<PaymentStatusResult> {
    if (this.zoho) {
      throw new PaymentError('VALIDATION', 'With the Zoho Books bridge, Zoho is the record: the payment must be recorded on the Zoho invoice (by Infinity\'s integration or in Zoho Books), not here.', { provider: 'infinity' });
    }
    return this.collections().record(input);
  }

  /** Every order still waiting for money, oldest first. */
  outstanding(): LedgerEntry[] {
    return this.zoho ? [] : this.collections().outstanding();
  }

  async parseWebhook(): Promise<never> {
    throw unsupported('infinity', 'webhooks', infinityCapabilities.features.webhooks.notes ?? '');
  }
}

export const infinity: ProviderModule<InfinityCredentials> = {
  id: 'infinity',
  capabilities: infinityCapabilities,
  create(creds, ctx) {
    return new InfinityGateway(creds, ctx);
  },
  extractError(data) {
    const d = data as { code?: number; message?: string; error?: string };
    return { code: d?.code !== undefined ? String(d.code) : d?.error, message: d?.message ?? d?.error };
  },
};
