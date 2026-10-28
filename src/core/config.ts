import type { ProviderCapabilities } from './capabilities.js';
import { PaymentError } from './errors.js';
import type { LogLevel } from './logger.js';
import { PROVIDER_IDS, type PaymentsMode, type ProviderId } from './types.js';

export interface PaymentsConfig {
  mode: PaymentsMode;
  /** Providers the caller may use. Defaults to all. */
  enabledProviders: ProviderId[];
  /** Raw credentials per provider, keyed by CredentialSpec.key. */
  credentials: Partial<Record<ProviderId, Record<string, string | undefined>>>;
  /** Must be true before refunds / cancellations run in live mode through the MCP server. */
  allowLiveMutations: boolean;
  auditLogPath?: string;
  logLevel: LogLevel;
  httpTimeoutMs: number;
  maxRetries: number;
}

export type Env = Record<string, string | undefined>;

const PLACEHOLDER = /replace-me|x{8,}|<[^>]+>/i;

export function parseMode(value: string | undefined): PaymentsMode {
  const v = (value ?? 'sandbox').trim().toLowerCase();
  if (v === 'mock' || v === 'sandbox' || v === 'live') return v;
  if (v === 'test') return 'sandbox';
  if (v === 'production' || v === 'prod') return 'live';
  throw new PaymentError('CONFIG_INVALID', `PAYMENTS_MODE must be mock, sandbox or live (got "${value}").`);
}

/**
 * Build config from environment variables. Each provider's CredentialSpec lists the variables it reads,
 * so adding a provider never requires touching this file.
 */
export function loadConfigFromEnv(env: Env, catalog: ProviderCapabilities[]): PaymentsConfig {
  const credentials: PaymentsConfig['credentials'] = {};
  for (const cap of catalog) {
    const creds: Record<string, string | undefined> = {};
    for (const spec of cap.credentials) {
      const v = env[spec.env];
      // Treat template placeholders as unset so `doctor` does not report them as configured.
      creds[spec.key] = v && v.trim() !== '' && !PLACEHOLDER.test(v) ? v.trim() : undefined;
    }
    credentials[cap.provider] = creds;
  }

  const enabled = env.PAYMENTS_PROVIDERS
    ? env.PAYMENTS_PROVIDERS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [...PROVIDER_IDS];
  for (const p of enabled) {
    if (!(PROVIDER_IDS as readonly string[]).includes(p)) {
      throw new PaymentError('CONFIG_INVALID', `Unknown provider "${p}" in PAYMENTS_PROVIDERS. Valid: ${PROVIDER_IDS.join(', ')}`);
    }
  }

  const level = (env.PAYMENTS_LOG_LEVEL ?? 'info') as LogLevel;
  const num = (name: string, fallback: number, min: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new PaymentError('CONFIG_INVALID', `${name} must be an integer >= ${min} (got "${raw}").`);
    return n;
  };
  return {
    mode: parseMode(env.PAYMENTS_MODE),
    enabledProviders: enabled as ProviderId[],
    credentials,
    allowLiveMutations: /^(1|true|yes)$/i.test(env.PAYMENTS_ALLOW_LIVE_MUTATIONS ?? ''),
    auditLogPath: env.PAYMENTS_AUDIT_LOG || undefined,
    logLevel: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
    httpTimeoutMs: num('PAYMENTS_HTTP_TIMEOUT_MS', 30_000, 1000),
    maxRetries: num('PAYMENTS_MAX_RETRIES', 2, 0),
  };
}

export interface CredentialReport {
  provider: ProviderId;
  ready: boolean;
  missing: string[];
  present: string[];
  optionalMissing: string[];
}

/** Which env vars are set/missing for a provider. Never returns values. */
export function credentialReport(cap: ProviderCapabilities, creds: Record<string, string | undefined> | undefined): CredentialReport {
  const missing: string[] = [];
  const present: string[] = [];
  const optionalMissing: string[] = [];
  for (const spec of cap.credentials) {
    if (creds?.[spec.key]) present.push(spec.env);
    else if (spec.required) missing.push(spec.env);
    else optionalMissing.push(spec.env);
  }
  return { provider: cap.provider, ready: missing.length === 0, missing, present, optionalMissing };
}
