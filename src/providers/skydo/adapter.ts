import { unsupported } from '../../core/errors.js';
import type { PaymentGateway, ProviderModule } from '../../core/gateway.js';
import { skydoCapabilities } from './capabilities.js';

/**
 * Skydo has no public API, so this adapter exists only to carry the capability map and to fail
 * loudly with guidance. The orchestrator rejects every call before reaching these methods; they
 * throw as a second line of defence for direct adapter use.
 */
function fail(feature: string): never {
  throw unsupported('skydo', feature, skydoCapabilities.features.createPayment.notes ?? '');
}

class SkydoGateway implements PaymentGateway {
  readonly id = 'skydo' as const;
  constructor(readonly environment: 'sandbox' | 'live') {}
  capabilities() {
    return skydoCapabilities;
  }
  async createPayment(): Promise<never> {
    fail('createPayment');
  }
  async verifyPayment(): Promise<never> {
    fail('verifyPayment');
  }
  async getPaymentStatus(): Promise<never> {
    fail('paymentStatus');
  }
  async parseWebhook(): Promise<never> {
    fail('webhooks');
  }
}

export const skydo: ProviderModule<Record<string, never>> = {
  id: 'skydo',
  capabilities: skydoCapabilities,
  create(_creds, ctx) {
    return new SkydoGateway(ctx.environment);
  },
};
