import { appendFile } from 'node:fs/promises';
import { redact } from './logger.js';

export interface AuditEntry {
  ts: string;
  action: string;
  provider: string;
  mode: string;
  outcome: 'success' | 'error' | 'blocked';
  orderRef?: string;
  refundRef?: string;
  amount?: number;
  currency?: string;
  errorCode?: string;
  actor?: string;
  detail?: Record<string, unknown>;
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

/** Append-only JSON Lines file. Point PAYMENTS_AUDIT_LOG at a path your log shipper collects. */
export class FileAuditSink implements AuditSink {
  constructor(private readonly path: string) {}
  async record(entry: AuditEntry) {
    await appendFile(this.path, JSON.stringify(redact(entry)) + '\n', { encoding: 'utf8', mode: 0o600 });
  }
}

export class MemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  async record(entry: AuditEntry) {
    this.entries.push(entry);
  }
}

export const noopAuditSink: AuditSink = { record: async () => {} };
