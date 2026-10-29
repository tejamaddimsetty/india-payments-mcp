import { PaymentError } from '../../core/errors.js';
import { toMajorString } from '../../core/money.js';
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  Environment,
  PaymentStatusResult,
  ProviderId,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from '../../core/types.js';
import { normalizeReceiptId, type LedgerEntry, type PaymentLedger } from './ledger.js';

/**
 * Ledger-backed collections for services with no API (Skydo ledger mode, Infinity). The merchant's
 * client is told how to pay; an admin records each receipt once the service's dashboard shows it.
 * Shared so every such provider gets the same, already-reviewed rules:
 *  - one order per orderRef, never silently re-priced;
 *  - receipts dedupe on receiptId (case/space-insensitive) across the whole ledger;
 *  - anything short of the invoice stays "pending"; only full receipts are "captured".
 */
export interface RecordPaymentInput {
  orderRef: string;
  /** Unique id of this receipt (the service's transaction reference or FIRA number). Recording it twice is a no-op. */
  receiptId: string;
  /** Amount that reached you, in minor units of the INVOICE currency (cents for USD), not the INR settlement. */
  amountReceived: number;
  receivedAt?: string;
  firaNumber?: string;
  note?: string;
}

export interface ManualCollectionsOptions {
  provider: ProviderId;
  /** "Skydo", "Infinity": used in messages. */
  label: string;
  environment: Environment;
  now: () => Date;
  /** What a receiptId is for this service, for error messages. */
  receiptIdHint: string;
  /** Status `method` reported for an entry. */
  method: (entry: LedgerEntry) => string;
  /** verifiedVia when verify() gets no orderRef (always valid: false). Skydo keeps its 0.2.0 value. */
  missingRefVerifiedVia?: VerifyPaymentResult['verifiedVia'];
}

export class ManualCollections {
  constructor(
    private readonly ledger: PaymentLedger,
    private readonly o: ManualCollectionsOptions,
  ) {}

  get persistent() {
    return this.ledger.persistent;
  }

  private err(code: ConstructorParameters<typeof PaymentError>[0], message: string, hint?: string) {
    return new PaymentError(code, message, { provider: this.o.provider, ...(hint ? { hint } : {}) });
  }

  /** Track the expected payment (idempotent per orderRef) and return the client-facing instructions. */
  async createEntry(input: CreatePaymentInput, currency: string, instructions: string, paymentUrl?: string): Promise<CreatePaymentResult> {
    const now = this.o.now().toISOString();
    const entry = (await this.ledger.update(input.orderRef, (existing) => {
      if (existing) {
        if (existing.amount !== input.amount || existing.currency !== currency) {
          throw this.err('VALIDATION', `orderRef ${input.orderRef} is already tracked with a different amount or currency.`);
        }
        if (paymentUrl && existing.paymentUrl && existing.paymentUrl !== paymentUrl) {
          throw this.err('VALIDATION', `orderRef ${input.orderRef} already has a different payment link.`, 'Use a new orderRef for a new link, so a payment can only ever match one order.');
        }
        // Idempotent; the only change allowed is attaching a link to an open order that had none.
        if (paymentUrl && !existing.paymentUrl) {
          if (existing.status !== 'created' && existing.status !== 'pending') {
            throw this.err('VALIDATION', `orderRef ${input.orderRef} is ${existing.status}: no payment link can be added.`);
          }
          return { ...existing, paymentUrl, updatedAt: now };
        }
        return undefined;
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
        ...(paymentUrl ? { paymentUrl } : {}),
        receipts: [],
      };
    }))!;
    return {
      provider: this.o.provider,
      environment: this.o.environment,
      orderRef: input.orderRef,
      providerOrderId: `${this.o.provider}:${input.orderRef}`,
      status: entry.status,
      amount: input.amount,
      currency,
      checkout: { type: 'manual', instructions, ...(entry.paymentUrl ? { url: entry.paymentUrl } : {}) },
      raw: { ledger: this.ledger.persistent ? 'file' : 'memory', entry },
    };
  }

  /** The tracked order, if any. */
  find(orderRef: string): LedgerEntry | undefined {
    return this.ledger.get(orderRef);
  }

  statusOf(entry: LedgerEntry): PaymentStatusResult {
    return {
      provider: this.o.provider,
      orderRef: entry.orderRef,
      providerOrderId: `${this.o.provider}:${entry.orderRef}`,
      status: entry.status,
      amount: entry.amount,
      currency: entry.currency,
      method: this.o.method(entry),
      failureReason:
        entry.status === 'pending'
          ? `Received ${entry.currency} ${toMajorString(entry.amountReceived, entry.currency)} of ${toMajorString(entry.amount, entry.currency)}.`
          : undefined,
      raw: entry,
    };
  }

  status(orderRef: string): PaymentStatusResult {
    const entry = this.ledger.get(orderRef);
    if (!entry) throw this.err('NOT_FOUND', `${this.o.label} ledger has no order ${orderRef}.`);
    return this.statusOf(entry);
  }

  /** No callback exists: "verification" reads the ledger built from receipts you recorded. */
  verify(input: VerifyPaymentInput): VerifyPaymentResult {
    const orderRef = input.orderRef ?? input.payload.order_ref ?? input.payload.reference;
    if (!orderRef) return { valid: false, status: 'unknown', verifiedVia: this.o.missingRefVerifiedVia ?? 'manual_record', reason: 'Pass orderRef.' };
    const s = this.status(orderRef);
    const amountOk = input.expectedAmount === undefined || s.amount === input.expectedAmount;
    return {
      valid: amountOk,
      status: s.status,
      orderRef: s.orderRef,
      providerOrderId: s.providerOrderId,
      amount: s.amount,
      verifiedVia: 'manual_record',
      reason: !amountOk ? `Amount mismatch: ${s.amount} vs expected ${input.expectedAmount}` : s.failureReason,
      raw: s.raw,
    };
  }

  /** Record money the service says arrived. Idempotent per receiptId; partial receipts stay pending. */
  async record(input: RecordPaymentInput): Promise<PaymentStatusResult> {
    if (!Number.isInteger(input.amountReceived) || input.amountReceived <= 0) {
      throw this.err('VALIDATION', 'amountReceived must be a positive integer in minor units (cents).');
    }
    const receiptId = input.receiptId?.trim();
    if (!receiptId || receiptId.length > 100) {
      throw this.err('VALIDATION', `receiptId is required (${this.o.receiptIdHint}, max 100 chars) so a receipt is never counted twice.`);
    }
    if (input.receivedAt !== undefined) {
      const t = Date.parse(input.receivedAt);
      if (!/^\d{4}-\d{2}-\d{2}/.test(input.receivedAt) || Number.isNaN(t)) {
        throw this.err('VALIDATION', `receivedAt "${input.receivedAt}" is not an ISO 8601 date (e.g. 2026-10-29 or 2026-10-29T10:00:00Z).`);
      }
      if (t > this.o.now().getTime() + 24 * 3600_000) {
        throw this.err('VALIDATION', `receivedAt ${input.receivedAt} is in the future.`);
      }
    }
    const key = normalizeReceiptId(receiptId);
    const now = this.o.now().toISOString();
    const entry = (await this.ledger.update(input.orderRef, (e, all) => {
      if (!e) throw this.err('NOT_FOUND', `${this.o.label} ledger has no order ${input.orderRef}.`);
      if (e.status === 'cancelled') throw this.err('VALIDATION', `Order ${input.orderRef} is cancelled.`);
      // One incoming payment can only pay one order.
      for (const other of all.values()) {
        if (other.orderRef !== e.orderRef && other.receipts.some((r) => normalizeReceiptId(r.receiptId) === key)) {
          throw this.err('IDEMPOTENCY_CONFLICT', `Receipt ${receiptId} is already recorded on order ${other.orderRef}.`);
        }
      }
      const dup = e.receipts.find((r) => normalizeReceiptId(r.receiptId) === key);
      if (dup) {
        if (dup.amount !== input.amountReceived) {
          throw this.err('IDEMPOTENCY_CONFLICT', `Receipt ${receiptId} was already recorded with amount ${dup.amount}.`);
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
    }))!;
    return this.statusOf(entry);
  }

  /** Every order still waiting for money, oldest first. */
  outstanding(): LedgerEntry[] {
    return this.ledger
      .list()
      .filter((e) => e.status === 'created' || e.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
