import type { ProviderCapabilities } from '../core/capabilities.js';
import type { ProviderId } from '../core/types.js';

export type Need =
  | 'subscriptions'
  | 'international'
  | 'upi'
  | 'refunds'
  | 'settlements'
  | 'shopify'
  | 'woocommerce'
  | 'mobile_sdk'
  | 'webhooks'
  | 'exporter_collections'
  | 'fast_integration';

/** Hand-tuned priors for things the capability map cannot express. Kept small and explained. */
const PRIORS: Partial<Record<ProviderId, Partial<Record<Need, number>>>> = {
  razorpay: { fast_integration: 3, international: 1 },
  cashfree: { fast_integration: 2 },
  stripe: { international: 3, fast_integration: 2 },
  skydo: { exporter_collections: 5 },
  // Same use case as Skydo; its Zoho integration is undocumented, so Skydo stays first.
  infinity: { exporter_collections: 3 },
  phonepe: { upi: 2 },
  paytm: { upi: 1 },
  ccavenue: { international: 1 },
};

export function recommendGateways(needs: Need[], caps: ProviderCapabilities[]) {
  const scored = caps.map((cap) => {
    let score = 0;
    const reasons: string[] = [];
    const blockers: string[] = [];
    needs.forEach((need, i) => {
      const weight = needs.length - i; // earlier needs matter more
      const s = scoreNeed(cap, need);
      const prior = PRIORS[cap.provider]?.[need] ?? 0;
      if (s < 0) blockers.push(need);
      else if (s > 0 || prior > 0) reasons.push(need);
      score += (s + prior) * weight;
    });
    return { provider: cap.provider, name: cap.displayName, score, matches: reasons, blockers, summary: cap.summary, constraints: cap.constraints.slice(0, 3) };
  });
  scored.sort((a, b) => b.score - a.score || a.blockers.length - b.blockers.length);
  return {
    ranking: scored,
    note: 'Heuristic ranking from the capability map. Pricing, settlement time and KYC approval vary by business; confirm with the gateway before committing.',
  };
}

function scoreNeed(cap: ProviderCapabilities, need: Need): number {
  const f = cap.features;
  const level = (k: keyof typeof f) => (f[k].support === 'supported' ? 2 : f[k].support === 'partial' ? 1 : f[k].support === 'not_implemented' ? 0 : -3);
  switch (need) {
    case 'subscriptions':
      return level('subscriptions');
    case 'refunds':
      return level('refund');
    case 'settlements':
      return level('settlements');
    case 'webhooks':
      return level('webhooks');
    case 'upi':
      return cap.paymentMethods.includes('upi') ? 2 : -3;
    case 'international':
      return /usd|international|multi|135|100\+/i.test(cap.currencies) ? 2 : 0;
    case 'shopify':
      return cap.platformPlugins.shopify ? (/not|no official/i.test(cap.platformPlugins.shopify) ? -1 : 2) : -1;
    case 'woocommerce':
      return cap.platformPlugins.woocommerce ? 2 : 0;
    case 'mobile_sdk':
      return Object.keys(cap.officialSdks).some((k) => /android|ios|react|flutter/i.test(k)) ? 2 : 0;
    case 'exporter_collections':
      return cap.provider === 'skydo' || cap.provider === 'infinity' ? 2 : 0;
    case 'fast_integration':
      return cap.checkoutTypes.includes('js_sdk') ? 2 : cap.checkoutTypes.includes('redirect') ? 1 : 0;
  }
}
