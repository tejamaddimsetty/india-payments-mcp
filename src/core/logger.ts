/**
 * Structured JSON logger that writes to STDERR (stdout belongs to the MCP stdio transport).
 * Anything that looks like a secret is redacted before it is written.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY =
  /(secret|password|passwd|salt|token|authorization|api[-_]?key|working[-_]?key|merchant[-_]?key|signature|checksum|hash|card|cvv|cvc|otp|vpa|enc_?request|encresp|x-verify|access_code)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function createLogger(
  level: LogLevel = 'info',
  base: Record<string, unknown> = {},
  write: (line: string) => void = (line) => process.stderr.write(line + '\n'),
): Logger {
  const min = LEVELS[level];
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const record = { ts: new Date().toISOString(), level: lvl, msg, ...base, ...(fields ?? {}) };
    write(JSON.stringify(redact(record)));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }, write),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
