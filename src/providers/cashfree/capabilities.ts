import { featureRow, type ProviderCapabilities } from '../../core/capabilities.js';

export const cashfreeCapabilities: ProviderCapabilities = {
  provider: 'cashfree',
  displayName: 'Cashfree Payments',
  website: 'https://www.cashfree.com',
  docsUrl: 'https://www.cashfree.com/docs/api-reference/payments/latest/orders/create',
  dashboardUrl: 'https://merchant.cashfree.com',
  summary:
    'Orders API + cashfree.js checkout covering UPI, cards, netbanking, wallets, EMI and pay later, with fast refunds, subscriptions, settlements and a separate Payouts product.',
  features: {
    createPayment: featureRow('supported', 'POST /pg/orders, then cashfree.js v3 checkout with payment_session_id. Needs customer phone.'),
    verifyPayment: featureRow('supported', 'The return URL carries only order_id and no signature, so verification re-fetches the order and its payments (verifiedVia: status_api).'),
    paymentStatus: featureRow('supported', 'GET /pg/orders/{order_id} + /payments. Keyed by orderRef (Cashfree order_id); no providerOrderId needed.'),
    refund: featureRow('supported', 'STANDARD or INSTANT speed, partial allowed. refund_id = refundRef de-duplicates. Full refund looks up the order amount first. Omitting amount refunds the ORIGINAL amount; after a partial refund always pass the remaining amount explicitly.'),
    refundStatus: featureRow('supported', 'GET /pg/orders/{order_id}/refunds/{refund_id}. Needs orderRef.'),
    webhooks: featureRow('supported', 'x-webhook-signature = base64(HMAC-SHA256(x-webhook-timestamp + raw body, client secret)). Timestamps older than 5 minutes are rejected.'),
    customers: featureRow('not_implemented', 'Customer details are sent inline with each order (customer_details); no separate customer object is used here.'),
    subscriptions: featureRow('not_implemented', 'Cashfree Subscriptions API: POST /pg/plans then POST /pg/subscriptions with mandate authorisation. Request body changed across x-api-version values, so it is not wrapped yet.'),
    settlements: featureRow('not_implemented', 'Cashfree offers "Get All Settlements" and GET /pg/orders/{order_id}/settlements; the list endpoint shape is not pinned down yet.'),
    payouts: featureRow('not_implemented', 'Payouts are a separate Cashfree product (base /payout, separate credentials and fund account).'),
    paymentLinks: featureRow('not_implemented', 'Cashfree Payment Links API exists; use it directly for now.'),
  },
  paymentMethods: ['upi', 'card', 'netbanking', 'wallet', 'emi', 'cardless_emi', 'paylater'],
  currencies: 'INR; international currencies only if enabled on the account.',
  checkoutTypes: ['js_sdk'],
  providerAmountFormat: 'Rupees as a JSON number with up to 2 decimals (10.15 = Rs 10.15). We convert from paise.',
  credentials: [
    { env: 'CASHFREE_CLIENT_ID', key: 'clientId', required: true, secret: false, description: 'App ID (x-client-id). Dashboard > Developers > API Keys. Sandbox and production keys differ.' },
    { env: 'CASHFREE_CLIENT_SECRET', key: 'clientSecret', required: true, secret: true, description: 'Secret key (x-client-secret). Also used to verify webhook signatures.' },
  ],
  constraints: [
    'Amounts are rupees with up to 2 decimals, minimum Rs 1. Never send paise.',
    'order_id (our orderRef) is 3-45 characters of [A-Za-z0-9_-] and must be unique per order.',
    'customer_details.customer_phone is mandatory on every order.',
    'The browser return carries no signature: always confirm through the status API or a webhook before fulfilling.',
    'cashfree.js only opens checkout on domains whitelisted in the Cashfree dashboard.',
    'Refunds are allowed only within 6 months of the payment.',
    'x-api-version is pinned to 2026-01-01; response shapes change between versions.',
    'The client secret doubles as the webhook signing key: rotating it changes webhook verification too.',
  ],
  officialSdks: {
    web: 'https://www.npmjs.com/package/@cashfreepayments/cashfree-js',
    node: 'https://www.npmjs.com/package/cashfree-pg',
  },
  platformPlugins: {
    shopify: 'Cashfree advertises a no-code Shopify integration: https://www.cashfree.com/docs/help/payments/integrations/integrations',
  },
  lastVerified: '2026-10-28',
};
