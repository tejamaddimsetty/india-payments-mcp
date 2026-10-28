import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PaymentError } from '../../core/errors.js';
import type { PaymentStatus } from '../../core/types.js';

/**
 * Expected-payments ledger for Skydo without Zoho. Skydo has no API to ask "was this paid?",
 * so the ledger records what you invoiced and the receipts you confirmed (from Skydo's email or
 * WhatsApp notification, the dashboard, or a FIRA).
 *
 * The file is shared by every process that uses it (typically your app creates orders and the MCP
 * server records receipts), so every read-modify-write takes an exclusive lock file and re-reads the
 * ledger inside the lock. Writes are atomic (temp file + rename) and the file is private (0600).
 */
export interface LedgerReceipt {
  /** Skydo transaction reference, FIRA number, or any id unique to this receipt. Used to dedupe. */
  receiptId: string;
  amount: number;
  receivedAt: string;
  firaNumber?: string;
  note?: string;
}

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
  receipts: LedgerReceipt[];
}

interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
}

const LOCK_TIMEOUT_MS = 5_000;
/** A lock older than this was left by a crashed process. */
const STALE_LOCK_MS = 30_000;

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class SkydoLedger {
  /** Used only when no file is configured (tests, embedded use). */
  private readonly memory = new Map<string, LedgerEntry>();

  constructor(private readonly file?: string) {
    // Fail fast on an unreadable file instead of discovering it at the first payment.
    if (file) this.read();
  }

  get persistent() {
    return this.file !== undefined;
  }

  private read(): Map<string, LedgerEntry> {
    if (!this.file) return this.memory;
    const map = new Map<string, LedgerEntry>();
    if (!existsSync(this.file)) return map;
    let data: LedgerFile;
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8')) as LedgerFile;
    } catch (err) {
      throw new PaymentError('CONFIG_INVALID', `Skydo ledger file ${this.file} is not valid JSON: ${(err as Error).message}`, {
        provider: 'skydo',
        hint: 'Fix or move the file; it is never overwritten while unreadable.',
      });
    }
    for (const e of data.entries ?? []) map.set(e.orderRef, e);
    return map;
  }

  private write(map: Map<string, LedgerEntry>) {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...map.values()] } satisfies LedgerFile, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private withLock<T>(fn: () => T): T {
    if (!this.file) return fn();
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(lock, 'wx', 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
        } catch {
          // the holder released it between our checks
        }
        if (Date.now() > deadline) {
          throw new PaymentError('PROVIDER_UNAVAILABLE', `Skydo ledger ${this.file} is locked by another process.`, { provider: 'skydo' });
        }
        sleepSync(20);
      }
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lock);
      } catch {
        // already removed as stale by another process
      }
    }
  }

  get(orderRef: string): LedgerEntry | undefined {
    const e = this.read().get(orderRef);
    return e ? structuredClone(e) : undefined;
  }

  list(): LedgerEntry[] {
    return [...this.read().values()].map((e) => structuredClone(e));
  }

  /**
   * Atomic read-modify-write of one entry. `fn` receives the current entry (or undefined) and returns
   * the new one, or undefined to leave the ledger unchanged.
   */
  update(orderRef: string, fn: (current: LedgerEntry | undefined) => LedgerEntry | undefined): LedgerEntry | undefined {
    return this.withLock(() => {
      const map = this.read();
      const current = map.get(orderRef);
      const next = fn(current ? structuredClone(current) : undefined);
      if (!next) return current ? structuredClone(current) : undefined;
      map.set(orderRef, structuredClone(next));
      this.write(map);
      return structuredClone(next);
    });
  }
}
