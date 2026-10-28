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

/**
 * Zoho also shows "paid" for invoices closed WITHOUT money: written off as bad debt, or settled with
 * credit notes. Only an invoice whose payments cover the total counts as captured.
 */
export function zohoInvoiceOutcome(inv: ZohoInvoice): { status: PaymentStatus; reason?: string } {
  const base = mapZohoInvoiceStatus(inv.status);
  if (inv.status !== 'paid') {
    return { status: base, reason: inv.status === 'partially_paid' ? `Partially paid: balance ${inv.currency_code} ${inv.balance}` : undefined };
  }
  const writeOff = Number(inv.write_off_amount ?? 0);
  if (writeOff > 0) return { status: 'failed', reason: `Zoho shows "paid" because ${inv.currency_code} ${writeOff} was written off as bad debt; no money was received for it.` };
  if (inv.payment_made === undefined) return { status: 'unknown', reason: 'Zoho did not return payment_made; cannot confirm money was received.' };
  if (Number(inv.payment_made) + 1e-9 < Number(inv.total)) {
    return { status: 'unknown', reason: `Zoho shows "paid" but payments cover only ${inv.payment_made} of ${inv.total} (the rest was closed with credits).` };
  }
  return { status: 'captured' };
}

export interface RecordPaymentInput {
  orderRef: string;
  /** Unique id of this receipt: Skydo transaction reference or FIRA number. Recording it twice is a no-op. */
  receiptId: string;
  /** Amount that reached you, in minor units of the INVOICE currency (cents for USD), not the INR settlement. */
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
  private ledgerInstance?: SkydoLedger;

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
    // The ledger only exists in ledger mode, so a broken ledger file can never block the Zoho bridge.
    if (!this.zoho) this.ledger();
  }

  private ledger(): SkydoLedger {
    this.ledgerInstance ??= new SkydoLedger(this.creds.ledgerFile ?? join(homedir(), '.india-payments-mcp', 'skydo-ledger.json'));
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
      ? paymentInstructions(account, { reference: input.orderRef, amount: input.amount, currency, payee: this.creds.payeeName })
      : undefined;
    return this.zoho ? this.createZohoInvoice(input, currency, instructions, notes) : this.createLedgerEntry(input, currency, instructions, notes);
  }

  private async createZohoInvoice(input: CreatePaymentInput, currency: string, instructions: string | undefined, notes: string[]): Promise<CreatePaymentResult> {
    const zoho = this.zoho!;
    // Zoho invoice creation is not idempotent, so look for our reference first.
    let invoice = await zoho.findInvoiceByReference(input.orderRef);
    if (invoice && invoice.status !== 'void') {
      if (invoice.currency_code.toUpperCase() !== currency || fromMajor(invoice.total, currency) !== input.amount) {
        throw new PaymentError('VALIDATION', `Zoho invoice ${invoice.invoice_number} already uses reference ${input.orderRef} with a different amount or currency.`, { provider: 'skydo' });
      }
    } else {
      if (invoice?.status === 'void') {
        throw new PaymentError('VALIDATION', `Zoho invoice ${invoice.invoice_number} for ${input.orderRef} was voided. Use a new orderRef for a new invoice.`, { provider: 'skydo' });
      }
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
      // Two processes can race past the lookup: keep the oldest invoice for this reference, void ours.
      const twins = (await zoho.findInvoicesByReference(input.orderRef)).filter((i) => i.status !== 'void' && i.invoice_id !== invoice!.invoice_id);
      if (twins.length > 0) {
        await zoho.markVoid(invoice.invoice_id);
        invoice = twins.sort((a, b) => (a.created_time ?? a.invoice_id).localeCompare(b.created_time ?? b.invoice_id))[0]!;
      }
    }
    // Skydo imports invoices as outstanding receivables; a draft is not one yet. Also repairs a
    // previous attempt that created the invoice but failed before marking it sent.
    if (invoice.status === 'draft') {
      await zoho.markSent(invoice.invoice_id);
      invoice = { ...invoice, status: 'sent' };
    }
    return {
      provider: 'skydo',
      environment: this.environment,
      orderRef: input.orderRef,
      providerOrderId: invoice.invoice_id,
      status: zohoInvoiceOutcome(invoice).status,
      amount: input.amount,
      currency,
      checkout: {
        type: 'manual',
        url: invoice.invoice_url,
        instructions: [
          `Zoho Books invoice ${invoice.invoice_number} is ready for ${currency} ${toMajorString(input.amount, currency)}.`,
          'Skydo imports Zoho invoices about every 10 minutes (Skydo profile > Connect Skydo to Zoho, done once), marks the invoice paid when the money arrives, and attaches the FIRA.',
          invoice.invoice_url ? `Invoice link for your client: ${invoice.invoice_url}` : 'Send the invoice from Zoho Books, or pass providerOptions.sendEmail=true.',
          ...(instructions ? ['', instructions] : []),
          ...(notes.length ? ['', ...notes] : []),
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

  private async createLedgerEntry(input: CreatePaymentInput, currency: string, instructions: string | undefined, notes: string[]): Promise<CreatePaymentResult> {
    if (!instructions) {
      throw new PaymentError('CONFIG_MISSING', `No Skydo receiving account for ${currency} and no "*" fallback in SKYDO_RECEIVING_ACCOUNTS.`, { provider: 'skydo' });
    }
    const now = this.ctx.now().toISOString();
    const entry = this.ledger().update(input.orderRef, (existing) => {
      if (existing) {
        if (existing.amount !== input.amount || existing.currency !== currency) {
          throw new PaymentError('VALIDATION', `orderRef ${input.orderRef} is already tracked with a different amount or currency.`, { provider: 'skydo' });
        }
        return undefined; // idempotent: leave it as it is
      }
      return {
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
    })!;
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
        instructions: [
          instructions,
          '',
          'When Skydo notifies you that the money arrived, record it (MCP: payments_skydo_record_payment; SDK: client.skydoRecordPayment) with the Skydo transaction reference as receiptId.',
          ...(notes.length ? ['', ...notes] : []),
        ].join('\n'),
      },
      raw: { ledger: this.ledger().persistent ? 'file' : 'memory', entry },
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
      const id = input.providerOrderId && !input.providerOrderId.startsWith('skydo:') ? input.providerOrderId : (await this.zoho.findInvoiceByReference(input.orderRef))?.invoice_id;
      if (!id) throw new PaymentError('NOT_FOUND', `No Zoho Books invoice with reference ${input.orderRef}.`, { provider: 'skydo' });
      // Always read the full invoice: list results lack payment_made / write_off_amount.
      const invoice = await this.zoho.getInvoice(id);
      // A providerOrderId must never answer for a different order.
      if (invoice.reference_number !== input.orderRef) {
        throw new PaymentError('VALIDATION', `Zoho invoice ${invoice.invoice_number} has reference ${invoice.reference_number ?? '(none)'}, not ${input.orderRef}.`, { provider: 'skydo' });
      }
      const outcome = zohoInvoiceOutcome(invoice);
      return {
        provider: 'skydo',
        orderRef: input.orderRef,
        providerOrderId: invoice.invoice_id,
        status: outcome.status,
        amount: fromMajor(invoice.total, invoice.currency_code),
        currency: invoice.currency_code,
        method: 'international_bank_transfer',
        failureReason: outcome.reason,
        // Skydo uploads the FIRA as an invoice attachment when it marks the invoice paid.
        raw: { invoice, firaAttached: invoice.has_attachment === true },
      };
    }
    const entry = this.ledger().get(input.orderRef);
    if (!entry) throw new PaymentError('NOT_FOUND', `Skydo ledger has no order ${input.orderRef}.`, { provider: 'skydo' });
    return this.ledgerStatus(entry);
  }

  /**
   * There is no Skydo callback to verify. "Verification" reads the authoritative record: the Zoho
   * invoice that Skydo marks paid, or the ledger entry built from receipts you recorded.
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
      reason: !amountOk ? `Amount mismatch: ${s.amount} vs expected ${input.expectedAmount}` : s.failureReason,
      raw: s.raw,
    };
  }

  /** Ledger mode: record money Skydo told you arrived. Idempotent per receiptId; partial receipts stay pending. */
  async recordPayment(input: RecordPaymentInput): Promise<PaymentStatusResult> {
    if (this.zoho) {
      throw new PaymentError('VALIDATION', 'With the Zoho Books bridge, Skydo marks invoices paid itself; nothing to record.', { provider: 'skydo' });
    }
    if (!Number.isInteger(input.amountReceived) || input.amountReceived <= 0) {
      throw new PaymentError('VALIDATION', 'amountReceived must be a positive integer in minor units (cents).', { provider: 'skydo' });
    }
    const receiptId = input.receiptId?.trim();
    if (!receiptId || receiptId.length > 100) {
      throw new PaymentError('VALIDATION', 'receiptId is required (the Skydo transaction reference or FIRA number, max 100 chars) so a receipt is never counted twice.', { provider: 'skydo' });
    }
    if (input.receivedAt !== undefined && Number.isNaN(Date.parse(input.receivedAt))) {
      throw new PaymentError('VALIDATION', `receivedAt "${input.receivedAt}" is not a date (use ISO 8601, e.g. 2026-10-29 or 2026-10-29T10:00:00Z).`, { provider: 'skydo' });
    }
    const now = this.ctx.now().toISOString();
    const entry = this.ledger().update(input.orderRef, (e) => {
      if (!e) throw new PaymentError('NOT_FOUND', `Skydo ledger has no order ${input.orderRef}.`, { provider: 'skydo' });
      if (e.status === 'cancelled') throw new PaymentError('VALIDATION', `Order ${input.orderRef} is cancelled.`, { provider: 'skydo' });
      const dup = e.receipts.find((r) => r.receiptId === receiptId);
      if (dup) {
        if (dup.amount !== input.amountReceived) {
          throw new PaymentError('IDEMPOTENCY_CONFLICT', `Receipt ${receiptId} was already recorded with amount ${dup.amount}.`, { provider: 'skydo' });
        }
        return undefined; // same receipt again: no change
      }
      e.receipts.push({
        receiptId,
        amount: input.amountReceived,
        receivedAt: input.receivedAt ? new Date(input.receivedAt).toISOString() : now,
        firaNumber: input.firaNumber,
        note: input.note,
      });
      e.amountReceived += input.amountReceived;
      // Intermediary banks abroad sometimes deduct fees: anything short of the invoice stays pending.
      e.status = e.amountReceived >= e.amount ? 'captured' : 'pending';
      e.updatedAt = now;
      return e;
    })!;
    return this.ledgerStatus(entry);
  }

  /** Ledger mode: every order still waiting for money, oldest first. */
  outstanding(): LedgerEntry[] {
    return this.ledger()
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
