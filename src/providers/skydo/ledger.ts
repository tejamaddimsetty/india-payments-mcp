import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PaymentError } from '../../core/errors.js';
import type { PaymentStatus } from '../../core/types.js';

/**
 * Expected-payments ledger for Skydo without Zoho. Skydo has no API to ask "was this paid?",
 * so the ledger records what you invoiced and what you confirmed (from Skydo's email/WhatsApp
 * notification, the dashboard, or a FIRA). It is a JSON file so state survives restarts of the
 * MCP server; writes are atomic (write temp file, then rename).
 */
export interface LedgerEntry {
  orderRef: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  amountReceived: number;
  createdAt: string;
  updatedAt: string;
  customer?: { name?: string; email?: string };
  description?: string;
  receipts: Array<{ amount: number; receivedAt: string; firaNumber?: string; note?: string }>;
}

export class SkydoLedger {
  private entries = new Map<string, LedgerEntry>();

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as { entries?: LedgerEntry[] };
        for (const e of data.entries ?? []) this.entries.set(e.orderRef, e);
      } catch (err) {
        throw new PaymentError('CONFIG_INVALID', `Skydo ledger file ${file} is not valid JSON: ${(err as Error).message}`, {
          provider: 'skydo',
          hint: 'Fix or move the file; it is never overwritten while unreadable.',
        });
      }
    }
  }

  get persistent() {
    return this.file !== undefined;
  }

  get(orderRef: string): LedgerEntry | undefined {
    const e = this.entries.get(orderRef);
    return e ? structuredClone(e) : undefined;
  }

  list(): LedgerEntry[] {
    return [...this.entries.values()].map((e) => structuredClone(e));
  }

  put(entry: LedgerEntry) {
    this.entries.set(entry.orderRef, structuredClone(entry));
    this.flush();
  }

  private flush() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...this.entries.values()] }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
