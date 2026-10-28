import { featureRow, type ProviderCapabilities } from '../../core/capabilities.js';

const NO_API = 'Skydo publishes no developer API or webhooks (checked 2026-10-28). Use the Skydo dashboard.';

export const skydoCapabilities: ProviderCapabilities = {
  provider: 'skydo',
  displayName: 'Skydo',
  website: 'https://www.skydo.com',
  docsUrl: 'https://www.skydo.com/faqs',
  dashboardUrl: 'https://dashboard.skydo.com',
  summary:
    'Cross-border collections for Indian exporters, freelancers and agencies: local receiving accounts abroad, payment links (InstaLinks), GST invoicing and FIRA. No public API, so this project offers guidance only.',
  features: {
    createPayment: featureRow('unsupported', `${NO_API} Create an InstaLink payment link or share your Global Bank Account details from the dashboard.`),
    verifyPayment: featureRow('unsupported', NO_API),
    paymentStatus: featureRow('unsupported', `${NO_API} Status is visible in the dashboard; Zoho Books sync can mark invoices paid.`),
    refund: featureRow('unsupported', NO_API),
    refundStatus: featureRow('unsupported', NO_API),
    webhooks: featureRow('unsupported', NO_API),
    customers: featureRow('unsupported', NO_API),
    subscriptions: featureRow('unsupported', NO_API),
    settlements: featureRow('unsupported', `${NO_API} Payouts to your Indian bank account and FIRA documents are in the dashboard.`),
    payouts: featureRow('unsupported', NO_API),
    paymentLinks: featureRow('unsupported', 'InstaLinks exist but can only be created in the dashboard.'),
  },
  paymentMethods: ['international_bank_transfer', 'international_card', 'payment_link'],
  currencies: 'USD, GBP, EUR, CAD, AUD and more (international collections, settled to INR).',
  checkoutTypes: ['manual'],
  providerAmountFormat: 'Not applicable (no API).',
  credentials: [],
  constraints: [
    'No public developer API, SDK or webhooks. Do not build code against Skydo; any "Skydo API" claim should be confirmed with Skydo directly.',
    'Only for receiving money FROM abroad (exports of goods/services). Not a domestic Indian payment gateway; it cannot take UPI or Indian cards.',
    'Integration options: dashboard InstaLinks, local receiving account details, Zoho Books invoice sync.',
    'For an automated international checkout, pair Skydo-for-invoices with Razorpay International, PayU, CCAvenue or Stripe (invite-only in India).',
  ],
  officialSdks: {},
  platformPlugins: {
    zohoBooks: 'Native Zoho Books integration: invoice sync and automatic mark-as-paid.',
    shopify: 'No official Shopify payments app.',
  },
  lastVerified: '2026-10-28',
};
