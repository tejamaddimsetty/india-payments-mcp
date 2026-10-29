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
import { skydoCapabilities } from './capabilities.js';
import { ZohoBooks } from '../shared/zoho.js';
import { ZohoInvoiceBridge } from '../shared/zoho-bridge.js';

/**
 * Skydo has no developer API (checked 2026-10-29, see docs/research/verification/skydo-api-search.md),
 * and its Terms forbid automated access to the platform. This adapter therefore never talks to Skydo.
 * It automates the two paths Skydo itself supports:
 *
 * 1. Zoho Books bridge. Skydo's native integration imports new Zoho Books invoices (about every
 *    10 minutes) and, when the money arrives, marks the Zoho invoice paid and attaches the FIRA.
 *    We create the invoice through Zoho's public API and read its status back.
 * 2. Receiving accounts + ledger. We hand the customer your standing Skydo account details with a
 *    unique reference and track the expected payment in a local ledger. You record each receipt
 *    (from Skydo's email/WhatsApp notification or dashboard) with recordPayment().
 */
export interface SkydoCredentials {
  receivingAccounts?: string;
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

/** Skydo FAQ: the minimum payment is USD 50 (other currencies: the USD 50 equivalent). */
export const SKYDO_MIN_USD_CENTS = 5000;
/** UK Faster Payments references are commonly capped at 18 characters. */
const UK_REFERENCE_MAX = 18;

const ZOHO_KEYS = {
  zohoDataCenter: 'ZOHO_DATA_CENTER',
  zohoClientId: 'ZOHO_CLIENT_ID',
  zohoClientSecret: 'ZOHO_CLIENT_SECRET',
  zohoRefreshToken: 'ZOHO_REFRESH_TOKEN',
  zohoOrganizationId: 'ZOHO_ORGANIZATION_ID',
  zohoItemId: 'ZOHO_ITEM_ID',
} as const;

export { mapZohoInvoiceStatus, zohoInvoiceOutcome } from '../shared/zoho-bridge.js';

export type { RecordPaymentInput };

const SKYDO_ZOHO_SYNC =
  'Skydo imports Zoho invoices about every 10 minutes (Skydo profile > Connect Skydo to Zoho, done once), marks the invoice paid when the money arrives, and attaches the FIRA.';
const SKYDO_FOOTER = 'Payments are received through Skydo (skydo.com) and settled to India with a FIRA.';

export class SkydoGateway implements PaymentGateway {
  readonly id = 'skydo' as const;
  readonly environment;
  private readonly accounts: ReceivingAccount[];
  private readonly zoho?: ZohoInvoiceBridge;
  private ledgerInstance?: ManualCollections;

  constructor(
    private readonly creds: SkydoCredentials,
    private readonly ctx: AdapterContext,
  ) {
    this.environment = ctx.environment;
    this.accounts = parseReceivingAccounts(creds.receivingAccounts, 'skydo', 'SKYDO_RECEIVING_ACCOUNTS');
    const keys = Object.keys(ZOHO_KEYS) as Array<keyof typeof ZOHO_KEYS>;
    const set = keys.filter((k) => creds[k]);
    if (set.length > 0 && set.length < keys.length) {
      const missing = keys.filter((k) => !creds[k]).map((k) => ZOHO_KEYS[k]);
      throw new PaymentError('CONFIG_MISSING', `Skydo's Zoho Books bridge is half-configured. Missing: ${missing.join(', ')}.`, { provider: 'skydo' });
    }
    if (set.length === keys.length) {
      const books = new ZohoBooks(
        {
          provider: 'skydo',
          envPrefix: 'ZOHO_',
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
        provider: 'skydo',
        environment: this.environment,
        itemId: creds.zohoItemId!,
        syncNote: SKYDO_ZOHO_SYNC,
        method: 'international_bank_transfer',
      });
    }
    if (!this.zoho && this.accounts.length === 0) {
      throw new PaymentError('CONFIG_MISSING', 'Skydo needs SKYDO_RECEIVING_ACCOUNTS (your account details from the Skydo dashboard) and/or the ZOHO_* variables for the Zoho Books bridge.', {
        provider: 'skydo',
        hint: 'Skydo has no API key. See docs/skydo.md for the two setups.',
      });
    }
    // The ledger only exists in ledger mode, so a broken ledger file can never block the Zoho bridge.
    if (!this.zoho) this.ledger();
  }

  private ledger(): ManualCollections {
    this.ledgerInstance ??= new ManualCollections(
      new PaymentLedger(this.creds.ledgerFile ?? join(homedir(), '.india-payments-mcp', 'skydo-ledger.json'), 'skydo', 'Skydo'),
      {
        provider: 'skydo',
        label: 'Skydo',
        environment: this.environment,
        now: this.ctx.now,
        receiptIdHint: 'the Skydo transaction reference or FIRA number',
        method: () => 'international_bank_transfer',
        missingRefVerifiedVia: 'status_api',
      },
    );
    return this.ledgerInstance;
  }

  /** "zoho": invoices through Zoho Books, status from Zoho. "ledger": account details + local ledger. */
  get mode(): 'zoho' | 'ledger' {
    return this.zoho ? 'zoho' : 'ledger';
  }

  capabilities() {
    return skydoCapabilities;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const currency = (input.currency ?? '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency) || currency === 'INR') {
      throw new PaymentError('VALIDATION', 'Skydo receives foreign currency from abroad: pass the client\'s ISO currency (USD, GBP, EUR, CAD, AUD, AED, SGD, ...). INR is not supported.', {
        provider: 'skydo',
        hint: 'For domestic INR payments use razorpay, cashfree, payu, phonepe, paytm or ccavenue.',
      });
    }
    if (currency === 'USD' && input.amount < SKYDO_MIN_USD_CENTS) {
      throw new PaymentError('VALIDATION', `Skydo's minimum payment is USD 50.00 (got USD ${toMajorString(input.amount, currency)}).`, { provider: 'skydo' });
    }
    const notes: string[] = [];
    if (currency !== 'USD') notes.push(`Skydo's minimum is the equivalent of USD 50; make sure ${currency} ${toMajorString(input.amount, currency)} is above it.`);
    if (currency === 'GBP' && input.orderRef.length > UK_REFERENCE_MAX) {
      notes.push(`UK bank transfers often cut references to ${UK_REFERENCE_MAX} characters; "${input.orderRef}" is ${input.orderRef.length}. Prefer a shorter orderRef for GBP.`);
    }
    const account = accountFor(this.accounts, currency);
    const instructions = account
      ? paymentInstructions(account, { reference: input.orderRef, amount: input.amount, currency, payee: this.creds.payeeName, footer: SKYDO_FOOTER })
      : undefined;
    return this.zoho ? this.zoho.createInvoice(input, currency, instructions, notes) : this.createLedgerEntry(input, currency, instructions, notes);
  }

  private async createLedgerEntry(input: CreatePaymentInput, currency: string, instructions: string | undefined, notes: string[]): Promise<CreatePaymentResult> {
    if (!instructions) {
      throw new PaymentError('CONFIG_MISSING', `No Skydo receiving account for ${currency} and no "*" fallback in SKYDO_RECEIVING_ACCOUNTS.`, { provider: 'skydo' });
    }
    const text = [
      instructions,
      '',
      'When Skydo notifies you that the money arrived, record it (MCP: payments_skydo_record_payment; SDK: client.skydoRecordPayment) with the Skydo transaction reference as receiptId.',
      ...(notes.length ? ['', ...notes] : []),
    ].join('\n');
    return this.ledger().createEntry(input, currency, text);
  }

  async getPaymentStatus(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    if (this.zoho) return this.zoho.status(input);
    return this.ledger().status(input.orderRef);
  }

  /**
   * There is no Skydo callback to verify. "Verification" reads the authoritative record: the Zoho
   * invoice that Skydo marks paid, or the ledger entry built from receipts you recorded.
   */
  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    return this.zoho ? this.zoho.verify(input) : this.ledger().verify(input);
  }

  /** Ledger mode: record money Skydo told you arrived. Idempotent per receiptId; partial receipts stay pending. */
  async recordPayment(input: RecordPaymentInput): Promise<PaymentStatusResult> {
    if (this.zoho) {
      throw new PaymentError('VALIDATION', 'With the Zoho Books bridge, Skydo marks invoices paid itself; nothing to record.', { provider: 'skydo' });
    }
    return this.ledger().record(input);
  }

  /** Ledger mode: every order still waiting for money, oldest first. */
  outstanding(): LedgerEntry[] {
    return this.ledger().outstanding();
  }

  async parseWebhook(): Promise<never> {
    throw unsupported('skydo', 'webhooks', skydoCapabilities.features.webhooks.notes ?? '');
  }
}

export const skydo: ProviderModule<SkydoCredentials> = {
  id: 'skydo',
  capabilities: skydoCapabilities,
  create(creds, ctx) {
    return new SkydoGateway(creds, ctx);
  },
  extractError(data) {
    const d = data as { code?: number; message?: string; error?: string };
    return { code: d?.code !== undefined ? String(d.code) : d?.error, message: d?.message ?? d?.error };
  },
};
