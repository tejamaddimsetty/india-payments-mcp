import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { PaymentError } from '../../core/errors.js';
import type { PaymentStatus, ProviderId } from '../../core/types.js';

/**
 * Expected-payments ledger for collection services without an API (Skydo ledger mode, Infinity).
 * There is no API to ask "was this paid?", so the ledger records what you invoiced and the receipts
 * you confirmed (from the service's email or WhatsApp notification, its dashboard, or a FIRA).
 *
 * The file is shared by every process that uses it (typically your app creates orders and the MCP
 * server records receipts), so every read-modify-write holds an exclusive lock file and re-reads the
 * ledger inside the lock. Lock waits are asynchronous (the event loop keeps running), a lock is only
 * ever removed by its owner or as provably stale, and writes are fsynced then atomically renamed.
 * Use a local disk: lock files are not reliable on network file systems.
 */
export interface LedgerReceipt {
  /** Transaction reference from the service, FIRA number, or any id unique to this receipt. Used to dedupe. */
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
  /** Payment page the client was sent (Infinity QuickLink), if any. */
  paymentUrl?: string;
  receipts: LedgerReceipt[];
}

interface LedgerFile {
  version: 1;
  /** Which gateway owns the file. Files written before 0.3.0 have none and are Skydo's. */
  provider?: ProviderId;
  entries: LedgerEntry[];
}

/** How long a writer waits for the lock. Longer than STALE_LOCK_MS so a crashed holder never strands it. */
const LOCK_TIMEOUT_MS = 15_000;
/** Critical sections take milliseconds; a lock this old was left by a crashed process. */
const STALE_LOCK_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Receipt ids compare case- and whitespace-insensitively ("sky-1 " == "SKY-1"). */
export function normalizeReceiptId(id: string): string {
  return id.trim().toUpperCase();
}

export class PaymentLedger {
  /** Used only when no file is configured (tests, embedded use). */
  private readonly memory = new Map<string, LedgerEntry>();

  constructor(
    private readonly file: string | undefined,
    private readonly provider: ProviderId,
    private readonly label: string,
  ) {
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
      throw new PaymentError('CONFIG_INVALID', `${this.label} ledger file ${this.file} is not valid JSON: ${(err as Error).message}`, {
        provider: this.provider,
        hint: 'Fix or move the file; it is never overwritten while unreadable.',
      });
    }
    // Two gateways must never share a ledger: a receipt for one would pay the other's order.
    const owner = data.provider ?? ((data.entries ?? []).length > 0 ? 'skydo' : undefined);
    if (owner && owner !== this.provider) {
      throw new PaymentError('CONFIG_INVALID', `${this.label} ledger file ${this.file} belongs to ${owner}.`, {
        provider: this.provider,
        hint: 'Give each gateway its own ledger file (SKYDO_LEDGER_FILE, INFINITY_LEDGER_FILE).',
      });
    }
    for (const e of data.entries ?? []) map.set(e.orderRef, e);
    return map;
  }

  private write(map: Map<string, LedgerEntry>) {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify({ version: 1, provider: this.provider, entries: [...map.values()] } satisfies LedgerFile, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, this.file);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
      throw err;
    }
  }

  private async withLock<T>(fn: () => T): Promise<T> {
    if (!this.file) return fn();
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = `${this.file}.lock`;
    const token = `${process.pid}:${randomUUID()}`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(lock, 'wx', 0o600);
        writeSync(fd, token);
        closeSync(fd);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      this.breakIfStale(lock);
      if (Date.now() > deadline) {
        throw new PaymentError('PROVIDER_UNAVAILABLE', `${this.label} ledger ${this.file} is locked by another process.`, { provider: this.provider, hint: 'Retry in a moment.' });
      }
      await sleep(25);
    }
    try {
      return fn();
    } finally {
      // Only remove the lock if it is still ours (it could have been broken as stale and re-taken).
      try {
        if (readFileSync(lock, 'utf8') === token) unlinkSync(lock);
      } catch {
        // already gone
      }
    }
  }

  /** Claim a stale lock by renaming it to a unique name first: only one process can win that rename. */
  private breakIfStale(lock: string) {
    try {
      if (Date.now() - statSync(lock).mtimeMs <= STALE_LOCK_MS) return;
      const grave = `${lock}.stale.${process.pid}.${randomUUID().slice(0, 8)}`;
      renameSync(lock, grave);
      unlinkSync(grave);
    } catch {
      // someone else released or broke it first
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
   * Atomic read-modify-write of one entry. `fn` receives the current entry (or undefined) and the whole
   * ledger (read-only, for cross-order checks) and returns the new entry, or undefined for no change.
   */
  update(
    orderRef: string,
    fn: (current: LedgerEntry | undefined, all: ReadonlyMap<string, LedgerEntry>) => LedgerEntry | undefined,
  ): Promise<LedgerEntry | undefined> {
    return this.withLock(() => {
      const map = this.read();
      const current = map.get(orderRef);
      const next = fn(current ? structuredClone(current) : undefined, map);
      if (!next) return current ? structuredClone(current) : undefined;
      map.set(orderRef, structuredClone(next));
      this.write(map);
      return structuredClone(next);
    });
  }
}
