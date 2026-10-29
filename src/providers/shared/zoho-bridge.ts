import { PaymentError } from '../../core/errors.js';
import { fromMajor, toMajorString } from '../../core/money.js';
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  Environment,
  PaymentStatus,
  PaymentStatusInput,
  PaymentStatusResult,
  ProviderId,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from '../../core/types.js';
import type { ZohoBooks, ZohoInvoice } from './zoho.js';

/**
 * Zoho Books bridge shared by collection services with a native Zoho integration (Skydo; Infinity).
 * We create the invoice through Zoho's public API and read its status back. Zoho is the source of
 * truth: an invoice counts as paid only when its recorded payments cover the total, so a write-off or
 * credit note never does.
 */
export interface ZohoBridgeOptions {
  provider: ProviderId;
  environment: Environment;
  /** item_id of the service item used on invoice lines (Zoho requires one per line). */
  itemId: string;
  /** One line telling the merchant what the gateway does with the invoice. */
  syncNote: string;
  /** Status `method`. */
  method: string;
}

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
  const paidAmount = Number(inv.payment_made ?? 0);
  if (writeOff > 0) {
    // Written off entirely: no money. Partly written off (e.g. bank fees abroad deducted, remainder
    // written off): money arrived but less than invoiced, so a human decides; same as a short receipt.
    return paidAmount > 0
      ? { status: 'pending', reason: `Received ${inv.currency_code} ${paidAmount} of ${inv.total}; ${writeOff} was written off. Review and fulfil manually if acceptable.` }
      : { status: 'failed', reason: `Zoho shows "paid" because ${inv.currency_code} ${writeOff} was written off as bad debt; no money was received for it.` };
  }
  if (inv.payment_made === undefined) return { status: 'unknown', reason: 'Zoho did not return payment_made; cannot confirm money was received.' };
  if (Number(inv.payment_made) + 1e-9 < Number(inv.total)) {
    return { status: 'unknown', reason: `Zoho shows "paid" but payments cover only ${inv.payment_made} of ${inv.total} (the rest was closed with credits).` };
  }
  return { status: 'captured' };
}

/** Deterministic: oldest invoice wins. Zoho ids are numeric strings, so compare them as numbers. */
function pickWinner(invoices: ZohoInvoice[]): ZohoInvoice {
  const key = (i: ZohoInvoice) => i.invoice_id.padStart(32, '0');
  return [...invoices].sort((a, b) => key(a).localeCompare(key(b)))[0]!;
}

export class ZohoInvoiceBridge {
  constructor(
    private readonly zoho: ZohoBooks,
    private readonly o: ZohoBridgeOptions,
  ) {}

  /** Create (or find) the Zoho invoice for orderRef and return the client-facing instructions. */
  async createInvoice(input: CreatePaymentInput, currency: string, instructions: string | undefined, notes: string[]): Promise<CreatePaymentResult> {
    const zoho = this.zoho;
    // Zoho invoice creation is not idempotent, so look for our reference first.
    const found = await zoho.findInvoiceByReference(input.orderRef);
    // The list endpoint omits invoice_url, payment_made and write_off_amount: read the full record.
    let invoice = found && found.status !== 'void' ? await zoho.getInvoice(found.invoice_id) : found;
    if (invoice && invoice.status !== 'void') {
      if (invoice.currency_code.toUpperCase() !== currency || fromMajor(invoice.total, currency) !== input.amount) {
        throw new PaymentError('VALIDATION', `Zoho invoice ${invoice.invoice_number} already uses reference ${input.orderRef} with a different amount or currency.`, { provider: this.o.provider });
      }
    } else {
      if (invoice?.status === 'void') {
        throw new PaymentError('VALIDATION', `Zoho invoice ${invoice.invoice_number} for ${input.orderRef} was voided. Use a new orderRef for a new invoice.`, { provider: this.o.provider });
      }
      const customerId = await this.resolveCustomer(input, currency);
      const opts = input.providerOptions ?? {};
      const body: Record<string, unknown> = {
        customer_id: customerId,
        reference_number: input.orderRef,
        line_items: [
          {
            item_id: this.o.itemId,
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
      // Two processes can race past the lookup and both create an invoice. Every racer computes the
      // SAME winner (oldest by Zoho's numeric invoice_id, which increases with creation), so exactly
      // one survives: each process voids only its own invoice, and only if it is not the winner.
      const live = (await zoho.findInvoicesByReference(input.orderRef)).filter((i) => i.status !== 'void');
      if (!live.some((i) => i.invoice_id === invoice!.invoice_id)) live.push(invoice);
      const winner = pickWinner(live);
      if (winner.invoice_id !== invoice.invoice_id) {
        await zoho.markVoid(invoice.invoice_id);
        invoice = await zoho.getInvoice(winner.invoice_id);
      }
    }
    // The gateway imports invoices as outstanding receivables; a draft is not one yet. Also repairs a
    // previous attempt that created the invoice but failed before marking it sent.
    if (invoice.status === 'draft') {
      await zoho.markSent(invoice.invoice_id);
      invoice = { ...invoice, status: 'sent' };
    }
    return {
      provider: this.o.provider,
      environment: this.o.environment,
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
          this.o.syncNote,
          invoice.invoice_url ? `Invoice link for your client: ${invoice.invoice_url}` : 'Send the invoice from Zoho Books, or pass providerOptions.sendEmail=true.',
          ...(instructions ? ['', instructions] : []),
          ...(notes.length ? ['', ...notes] : []),
        ].join('\n'),
      },
      raw: invoice,
    };
  }

  private async resolveCustomer(input: CreatePaymentInput, currency: string): Promise<string> {
    const zoho = this.zoho;
    const explicit = input.providerOptions?.zohoCustomerId;
    let contact;
    if (typeof explicit === 'string') {
      contact = await zoho.getContact(explicit);
      if (contact.contact_type && contact.contact_type !== 'customer') {
        throw new PaymentError('VALIDATION', `Zoho contact ${explicit} is a ${contact.contact_type}, not a customer.`, { provider: this.o.provider });
      }
      if (contact.status === 'inactive') {
        throw new PaymentError('VALIDATION', `Zoho customer ${contact.contact_name} is inactive.`, { provider: this.o.provider, hint: 'Mark the customer active in Zoho Books.' });
      }
    } else if (input.customer?.email) {
      contact = await zoho.findCustomerByEmail(input.customer.email);
    }
    if (!contact) {
      throw new PaymentError(
        'VALIDATION',
        input.customer?.email ? `No Zoho Books customer with email ${input.customer.email}.` : 'Pass customer.email (or providerOptions.zohoCustomerId) to pick the Zoho Books customer.',
        { provider: this.o.provider, hint: 'Create the client once in Zoho Books with their billing currency (GST treatment "Overseas" for Indian organisations), then retry.' },
      );
    }
    // Zoho raises invoices in the customer's currency; refusing a mismatch beats a wrong invoice.
    if (contact.currency_code && contact.currency_code.toUpperCase() !== currency) {
      throw new PaymentError('VALIDATION', `Zoho customer ${contact.contact_name} is billed in ${contact.currency_code}, not ${currency}.`, {
        provider: this.o.provider,
        hint: 'Use the customer\'s currency, or change it in Zoho Books.',
      });
    }
    return contact.contact_id;
  }

  /** Status from the full Zoho invoice; "paid" only when payments cover the total. */
  async status(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    const id = input.providerOrderId && !input.providerOrderId.startsWith(`${this.o.provider}:`) ? input.providerOrderId : (await this.zoho.findInvoiceByReference(input.orderRef))?.invoice_id;
    if (!id) throw new PaymentError('NOT_FOUND', `No Zoho Books invoice with reference ${input.orderRef}.`, { provider: this.o.provider });
    // Always read the full invoice: list results lack payment_made / write_off_amount.
    const invoice = await this.zoho.getInvoice(id);
    // A providerOrderId must never answer for a different order.
    if (invoice.reference_number !== input.orderRef) {
      throw new PaymentError('VALIDATION', `Zoho invoice ${invoice.invoice_number} has reference ${invoice.reference_number ?? '(none)'}, not ${input.orderRef}.`, { provider: this.o.provider });
    }
    const outcome = zohoInvoiceOutcome(invoice);
    return {
      provider: this.o.provider,
      orderRef: input.orderRef,
      providerOrderId: invoice.invoice_id,
      status: outcome.status,
      amount: fromMajor(invoice.total, invoice.currency_code),
      currency: invoice.currency_code,
      method: this.o.method,
      failureReason: outcome.reason,
      // Skydo uploads the FIRA as an invoice attachment when it marks the invoice paid (Infinity: unconfirmed).
      raw: { invoice, firaAttached: invoice.has_attachment === true },
    };
  }

  /** No callback exists: "verification" reads the Zoho invoice. */
  async verify(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const orderRef = input.orderRef ?? input.payload.order_ref ?? input.payload.reference;
    if (!orderRef) return { valid: false, status: 'unknown', verifiedVia: 'status_api', reason: 'Pass orderRef.' };
    const s = await this.status({ orderRef, providerOrderId: input.providerOrderId });
    const amountOk = input.expectedAmount === undefined || s.amount === input.expectedAmount;
    return {
      valid: amountOk,
      status: s.status,
      orderRef: s.orderRef,
      providerOrderId: s.providerOrderId,
      amount: s.amount,
      verifiedVia: 'status_api',
      reason: !amountOk ? `Amount mismatch: ${s.amount} vs expected ${input.expectedAmount}` : s.failureReason,
      raw: s.raw,
    };
  }
}
