import type { ProviderCapabilities } from '../core/capabilities.js';
import type { ProviderModule } from '../core/gateway.js';
import type { ProviderId } from '../core/types.js';
import { cashfree } from './cashfree/adapter.js';
import { infinity } from './infinity/adapter.js';
import { ccavenue } from './ccavenue/adapter.js';
import { payu } from './payu/adapter.js';
import { paytm } from './paytm/adapter.js';
import { phonepe } from './phonepe/adapter.js';
import { razorpay } from './razorpay/adapter.js';
import { skydo } from './skydo/adapter.js';
import { stripe } from './stripe/adapter.js';

// Each module is typed with its own credential shape; the registry treats them uniformly.
export const PROVIDERS: Record<ProviderId, ProviderModule<any>> = {
  razorpay,
  payu,
  cashfree,
  ccavenue,
  paytm,
  phonepe,
  stripe,
  skydo,
  infinity,
};

export function allCapabilities(): ProviderCapabilities[] {
  return Object.values(PROVIDERS).map((p) => p.capabilities);
}

export function capabilitiesFor(id: ProviderId): ProviderCapabilities {
  return PROVIDERS[id].capabilities;
}
