import { homedir } from 'node:os';
import { join } from 'node:path';
import { PaymentError, unsupported } from '../../core/errors.js';
import type { AdapterContext, PaymentGateway, ProviderModule } from '../../core/gateway.js';
import { fromMajor, toMajorString } from '../../core/money.js';
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentStatus,
  PaymentStatusInput,
  PaymentStatusResult,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from '../../core/types.js';
import { accountFor, parseReceivingAccounts, paymentInstructions, type ReceivingAccount } from './accounts.js';
import { skydoCapabilities } from './capabilities.js';
import { SkydoLedger, type LedgerEntry } from './ledger.js';
import { ZohoBooks, type ZohoInvoice } from './zoho.js';

/**
 * Skydo has no developer API (checked 2026-10-29, see docs/research/verification/skydo-api-search.md),
 * and its Terms forbid automating the dashboard. This adapter therefore never talks to Skydo.
 * It automates the two paths Skydo itself supports:
 *
 * 1. Zoho Books bridge (fully automatic). Skydo's native integration imports new Zoho Books invoices
 *    every ~10 minutes, and when the money arrives it marks the Zoho invoice paid and attaches the
 *    FIRA. We create the invoice through Zoho's public API and read its status back.
 * 2. Receiving accounts + ledger (semi-automatic). We hand the customer your standing Skydo account
 *    details with a unique reference, and track the expected payment in a local ledger. You confirm
 *    receipt (from Skydo's email/WhatsApp notification or dashboard) with recordPayment().
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

/** Skydo FAQ: the minimum payment into a local receiving account is USD 50. */
export const SKYDO_MIN_USD_CENTS = 5000;

const ZOHO_KEYS = {
  zohoDataCenter: 'ZOHO_DATA_CENTER',
  zohoClientId: 'ZOHO_CLIENT_ID',
  zohoClientSecret: 'ZOHO_CLIENT_SECRET',
  zohoRefreshToken: 'ZOHO_REFRESH_TOKEN',
  zohoOrganizationId: 'ZOHO_ORGANIZATION_ID',
  zohoItemId: 'ZOHO_ITEM_ID',
} as const;

/** Zoho Books invoice status (sent, draft, overdue, paid, void, unpaid, partially_paid, viewed) -> ours. */
export function mapZohoInvoiceStatus(status: string): PaymentStatus {
  switch (status) {
    case 'paid':
      return 'captured';
    case 'partially_paid':
      return 'pending';
    case 'void':
      return 'cancelled';
    case 'draft':
    case 'sent':
    case 'viewed':
    case 'unpaid':
    case 'overdue':
      return 'created';
    default:
      return 'unknown';
  }
}

export interface RecordPaymentInput {
  orderRef: string;
  /** Amount that reached you, in minor units of the INVOICE currency (not the INR settlement). */
  amountReceived: number;
  receivedAt?: string;
  firaNumber?: string;
  note?: string;
}

export class SkydoGateway implements PaymentGateway {
  readonly id = 'skydo' as const;
  readonly environment;
  private readonly accounts: ReceivingAccount[];
  private readonly zoho?: ZohoBooks;
  private readonly ledger: SkydoLedger;

  constructor(
    private readonly creds: SkydoCredentials,
    private readonly ctx: AdapterContext,
  ) {
    this.environment = ctx.environment;
    this.accounts = parseReceivingAccounts(creds.receivingAccounts);
    const keys = Object.keys(ZOHO_KEYS) as Array<keyof typeof ZOHO_KEYS>;
    const set = keys.filter((k) => creds[k]);
    if (set.length > 0 && set.length < keys.length) {
      const missing = keys.filter((k) => !creds[k]).map((k) => ZOHO_KEYS[k]);
      throw new PaymentError('CONFIG_MISSING', `Skydo's Zoho Books bridge is half-configured. Missing: ${missing.join(', ')}.`, { provider: 'skydo' });
    }
    if (set.length === keys.length) {
      this.zoho = new ZohoBooks(
        {
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
    }
    if (!this.zoho && this.accounts.length === 0) {
      throw new PaymentError('CONFIG_MISSING', 'Skydo needs SKYDO_RECEIVING_ACCOUNTS (your account details from the Skydo dashboard) and/or the ZOHO_* variables for the Zoho Books bridge.', {
        provider: 'skydo',
        hint: 'Skydo has no API key. See docs/skydo.md for the two setups.',
      });
    }
    this.ledger = new SkydoLedger(creds.ledgerFile ?? join(homedir(), '.india-payments-mcp', 'skydo-ledger.json'));
  }

  /** "zoho": invoices through Zoho Books, status from Zoho. "ledger": account details + local ledger. */
  get mode(): 'zoho' | 'ledger' {
    return this.zoho ? 'zoho' : 'ledger';
  }

  capabilities() {
    return skydoCapabilities;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const currency = (input.currency ?? 'USD').toUpperCase();
    if (currency === 'INR') {
      throw new PaymentError('VALIDATION', 'Skydo receives money from abroad in foreign currency; INR is not supported.', {
        provider: 'skydo',
        hint: 'Pass the client\'s currency (USD, GBP, EUR, ...). For domestic INR payments use razorpay, cashfree, payu, phonepe, paytm or ccavenue.',
      });
    }
    if (currency === 'USD' && input.amount < SKYDO_MIN_USD_CENTS) {
      throw new PaymentError('VALIDATION', `Skydo's minimum payment is USD 50.00 (got USD ${toMajorString(input.amount, currency)}).`, { provider: 'skydo' });
    }
    const account = accountFor(this.accounts, currency);
    const instructions = account
      ? paymentInstructions(account, { reference: input.orderRef, amount: input.amount, currency, payee: this.creds.payeeName })
      : undefined;
    return this.zoho ? this.createZohoInvoice(input, currency, instructions) : this.createLedgerEntry(input, currency, instructions);
  }

  private async createZohoInvoice(input: CreatePaymentInput, currency: string, instructions: string | undefined): Promise<CreatePaymentResult> {
    const zoho = this.zoho!;
    // Zoho invoice creation is not idempotent, so look for our reference first.
    let invoice = await zoho.findInvoiceByReference(input.orderRef);
    if (invoice) {
      if (invoice.currency_code.toUpperCase() !== currency || fromMajor(invoice.total, currency) !== input.amount) {
        throw new PaymentError('VALIDATION', `Zoho invoice ${invoice.invoice_number} already uses reference ${input.orderRef} with a different amount or currency.`, { provider: 'skydo' });
      }
    } else {
      const customerId = await this.resolveCustomer(input, currency);
      const opts = input.providerOptions ?? {};
      const body: Record<string, unknown> = {
        customer_id: customerId,
        reference_number: input.orderRef,
        line_items: [
          {
            item_id: this.creds.zohoItemId,
            name: (input.description ?? 'Services').slice(0, 100),
            rate: Number(toMajorString(input.amount, currency)),
            quantity: 1,
          },
        ],
        ...(instructions ? { notes: instructions } : {}),
        ...(typeof opts.exchangeRate === 'number' ? { exchange_rate: opts.exchangeRate } : {}),
        ...(typeof opts.dueDate === 'string' ? { due_date: opts.dueDate } : {}),
      };
      invoice = await zoho.createInvoice(body, opts.sendEmail === true);
      // Skydo imports invoices as outstanding receivables; a draft is not one yet.
      if (invoice.status === 'draft') {
        await zoho.markSent(invoice.invoice_id);
        invoice = { ...invoice, status: 'sent' };
      }
    }
    return {
      provider: 'skydo',
      environment: this.environment,
      orderRef: input.orderRef,
      providerOrderId: invoice.invoice_id,
      status: mapZohoInvoiceStatus(invoice.status),
      amount: input.amount,
      currency,
      checkout: {
        type: 'manual',
        url: invoice.invoice_url,
        instructions: [
          `Zoho Books invoice ${invoice.invoice_number} is ready for ${currency} ${toMajorString(input.amount, currency)}.`,
          'Skydo imports it within about 10 minutes (Skydo dashboard > Connect Skydo to Zoho must be done once), then marks it paid in Zoho and attaches the FIRA when the money arrives.',
          invoice.invoice_url ? `Share the invoice link with your client: ${invoice.invoice_url}` : 'Send the invoice from Zoho Books, or pass providerOptions.sendEmail=true.',
          ...(instructions ? ['', instructions] : []),
        ].join('\n'),
      },
      raw: invoice,
    };
  }

  private async resolveCustomer(input: CreatePaymentInput, currency: string): Promise<string> {
    const zoho = this.zoho!;
    const explicit = input.providerOptions?.zohoCustomerId;
    const contact =
      typeof explicit === 'string'
        ? await zoho.getContact(explicit)
        : input.customer?.email
          ? await zoho.findCustomerByEmail(input.customer.email)
          : undefined;
    if (!contact) {
      throw new PaymentError(
        'VALIDATION',
        input.customer?.email ? `No Zoho Books customer with email ${input.customer.email}.` : 'Pass customer.email (or providerOptions.zohoCustomerId) to pick the Zoho Books customer.',
        { provider: 'skydo', hint: 'Create the client once in Zoho Books with their billing currency (GST treatment "Overseas" for Indian organisations), then retry.' },
      );
    }
    // Zoho raises invoices in the customer's currency; refusing a mismatch beats a wrong invoice.
    if (contact.currency_code && contact.currency_code.toUpperCase() !== currency) {
      throw new PaymentError('VALIDATION', `Zoho customer ${contact.contact_name} is billed in ${contact.currency_code}, not ${currency}.`, {
        provider: 'skydo',
        hint: 'Use the customer\'s currency, or change it in Zoho Books.',
      });
    }
    return contact.contact_id;
  }

  private async createLedgerEntry(input: CreatePaymentInput, currency: string, instructions: string | undefined): Promise<CreatePaymentResult> {
    if (!instructions) {
      throw new PaymentError('CONFIG_MISSING', `No Skydo receiving account for ${currency} and no "*" fallback in SKYDO_RECEIVING_ACCOUNTS.`, { provider: 'skydo' });
    }
    const existing = this.ledger.get(input.orderRef);
    if (existing && (existing.amount !== input.amount || existing.currency !== currency)) {
      throw new PaymentError('VALIDATION', `orderRef ${input.orderRef} is already tracked with a different amount or currency.`, { provider: 'skydo' });
    }
    const now = this.ctx.now().toISOString();
    const entry: LedgerEntry = existing ?? {
      orderRef: input.orderRef,
      amount: input.amount,
      currency,
      status: 'created',
      amountReceived: 0,
      createdAt: now,
      updatedAt: now,
      customer: input.customer ? { name: input.customer.name, email: input.customer.email } : undefined,
      description: input.description,
      receipts: [],
    };
    if (!existing) this.ledger.put(entry);
    return {
      provider: 'skydo',
      environment: this.environment,
      orderRef: input.orderRef,
      providerOrderId: `skydo:${input.orderRef}`,
      status: entry.status,
      amount: input.amount,
      currency,
      checkout: {
        type: 'manual',
        instructions: `${instructions}\n\nWhen Skydo notifies you that the money arrived, record it (MCP: payments_skydo_record_payment; SDK: client.skydoRecordPayment).`,
      },
      raw: { ledger: this.ledger.persistent ? 'file' : 'memory', entry },
    };
  }

  private ledgerStatus(entry: LedgerEntry): PaymentStatusResult {
    return {
      provider: 'skydo',
      orderRef: entry.orderRef,
      providerOrderId: `skydo:${entry.orderRef}`,
      status: entry.status,
      amount: entry.amount,
      currency: entry.currency,
      method: 'international_bank_transfer',
      failureReason:
        entry.status === 'pending'
          ? `Received ${entry.currency} ${toMajorString(entry.amountReceived, entry.currency)} of ${toMajorString(entry.amount, entry.currency)}.`
          : undefined,
      raw: entry,
    };
  }

  async getPaymentStatus(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    if (this.zoho) {
      let invoice: ZohoInvoice | undefined;
      if (input.providerOrderId && !input.providerOrderId.startsWith('skydo:')) invoice = await this.zoho.getInvoice(input.providerOrderId);
      else invoice = await this.zoho.findInvoiceByReference(input.orderRef);
      if (!invoice) throw new PaymentError('NOT_FOUND', `No Zoho Books invoice with reference ${input.orderRef}.`, { provider: 'skydo' });
      return {
        provider: 'skydo',
        orderRef: invoice.reference_number ?? input.orderRef,
        providerOrderId: invoice.invoice_id,
        status: mapZohoInvoiceStatus(invoice.status),
        amount: fromMajor(invoice.total, invoice.currency_code),
        currency: invoice.currency_code,
        method: 'international_bank_transfer',
        failureReason: invoice.status === 'partially_paid' ? `Partially paid: balance ${invoice.currency_code} ${invoice.balance}` : undefined,
        // Skydo uploads the FIRA as an invoice attachment when it marks the invoice paid.
        raw: { invoice, firaAttached: invoice.has_attachment === true },
      };
    }
    const entry = this.ledger.get(input.orderRef);
    if (!entry) throw new PaymentError('NOT_FOUND', `Skydo ledger has no order ${input.orderRef}.`, { provider: 'skydo' });
    return this.ledgerStatus(entry);
  }

  /**
   * There is no Skydo callback to verify. "Verification" reads the authoritative record: the Zoho
   * invoice that Skydo marks paid, or the ledger entry you confirmed from Skydo's notification.
   */
  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const orderRef = input.orderRef ?? input.payload.order_ref ?? input.payload.reference;
    if (!orderRef) return { valid: false, status: 'unknown', verifiedVia: 'status_api', reason: 'Pass orderRef.' };
    const s = await this.getPaymentStatus({ orderRef, providerOrderId: input.providerOrderId });
    const amountOk = input.expectedAmount === undefined || s.amount === input.expectedAmount;
    return {
      valid: amountOk,
      status: s.status,
      orderRef: s.orderRef,
      providerOrderId: s.providerOrderId,
      amount: s.amount,
      verifiedVia: this.zoho ? 'status_api' : 'manual_record',
      reason: amountOk ? undefined : `Amount mismatch: ${s.amount} vs expected ${input.expectedAmount}`,
      raw: s.raw,
    };
  }

  /** Ledger mode: record money that Skydo told you arrived. Supports partial and repeated receipts. */
  async recordPayment(input: RecordPaymentInput): Promise<PaymentStatusResult> {
    if (this.zoho) {
      throw new PaymentError('VALIDATION', 'With the Zoho Books bridge, Skydo marks invoices paid itself; nothing to record.', { provider: 'skydo' });
    }
    if (!Number.isInteger(input.amountReceived) || input.amountReceived <= 0) {
      throw new PaymentError('VALIDATION', 'amountReceived must be a positive integer in minor units (cents).', { provider: 'skydo' });
    }
    const entry = this.ledger.get(input.orderRef);
    if (!entry) throw new PaymentError('NOT_FOUND', `Skydo ledger has no order ${input.orderRef}.`, { provider: 'skydo' });
    if (entry.status === 'cancelled') throw new PaymentError('VALIDATION', `Order ${input.orderRef} is cancelled.`, { provider: 'skydo' });
    entry.receipts.push({ amount: input.amountReceived, receivedAt: input.receivedAt ?? this.ctx.now().toISOString(), firaNumber: input.firaNumber, note: input.note });
    entry.amountReceived += input.amountReceived;
    // Intermediary banks abroad sometimes deduct fees: anything short of the invoice stays pending.
    entry.status = entry.amountReceived >= entry.amount ? 'captured' : 'pending';
    entry.updatedAt = this.ctx.now().toISOString();
    this.ledger.put(entry);
    return this.ledgerStatus(entry);
  }

  /** Ledger mode: every order still waiting for money, oldest first. */
  outstanding(): LedgerEntry[] {
    return this.ledger
      .list()
      .filter((e) => e.status === 'created' || e.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
