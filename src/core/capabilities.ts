import type { ProviderId } from './types.js';

/**
 * - supported:       the provider offers it AND this project implements it.
 * - partial:         implemented with caveats spelled out in `notes`.
 * - not_implemented: the provider offers it but this adapter does not (yet). Calls throw NOT_IMPLEMENTED.
 * - unsupported:     the provider does not offer it. Calls throw UNSUPPORTED.
 */
export type SupportLevel = 'supported' | 'partial' | 'not_implemented' | 'unsupported';

export const FEATURE_KEYS = [
  'createPayment',
  'verifyPayment',
  'paymentStatus',
  'refund',
  'refundStatus',
  'webhooks',
  'customers',
  'subscriptions',
  'settlements',
  'payouts',
  'paymentLinks',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface FeatureSupport {
  support: SupportLevel;
  notes?: string;
}

export interface CredentialSpec {
  /** Environment variable name, e.g. RAZORPAY_KEY_ID */
  env: string;
  /** Key used inside the adapter's credential object. */
  key: string;
  required: boolean;
  secret: boolean;
  description: string;
}

export interface ProviderCapabilities {
  provider: ProviderId;
  displayName: string;
  website: string;
  docsUrl: string;
  dashboardUrl?: string;
  /** One-line positioning to help pick a gateway. */
  summary: string;
  features: Record<FeatureKey, FeatureSupport>;
  /** Payment methods the gateway offers in India (not all are enabled on every account). */
  paymentMethods: string[];
  currencies: string;
  checkoutTypes: Array<'redirect' | 'form_post' | 'js_sdk' | 'manual'>;
  /** How the provider itself expects amounts. We always accept paise. */
  providerAmountFormat: string;
  credentials: CredentialSpec[];
  /** Hard constraints a developer will trip over. Be blunt. */
  constraints: string[];
  /** Official mobile / platform SDKs worth pointing developers at. */
  officialSdks: Record<string, string>;
  /** Shopify, WooCommerce, etc. */
  platformPlugins: Record<string, string>;
  /** Date the facts in this file were last checked against provider docs. */
  lastVerified: string;
}

/** platformPlugins.shopify holds a note either way; "No ... app" / "Not usable ..." means there is none. */
export function hasShopifyApp(cap: Pick<ProviderCapabilities, 'platformPlugins'>): boolean {
  const note = cap.platformPlugins.shopify?.trim();
  return !!note && !/^(no|not)\b/i.test(note);
}

export function featureRow(
  support: SupportLevel,
  notes?: string,
): FeatureSupport {
  return notes ? { support, notes } : { support };
}
