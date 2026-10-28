import { featureRow, type ProviderCapabilities } from '../../core/capabilities.js';

export const paytmCapabilities: ProviderCapabilities = {
  provider: 'paytm',
  displayName: 'Paytm Payment Gateway',
  website: 'https://paytmpayments.com',
  docsUrl: 'https://paytmpayments.com/docs',
  summary:
    'Paytm PG: UPI, cards, netbanking and EMI via a merchant-specific JS Checkout. Every API call is signed with the Paytm checksum (AES-128-CBC over the request body).',
  features: {
    createPayment: featureRow('supported', 'Initiate Transaction API -> txnToken (valid 15 min) + JS Checkout. A showPaymentPage form-post fallback is included for redirect integrations.'),
    verifyPayment: featureRow('supported', 'CHECKSUMHASH on the callback POST: Paytm checksum over the sorted field values, merchant key.'),
    paymentStatus: featureRow('supported', 'POST /v3/order/status, keyed by our orderRef (Paytm uses the merchant order id).'),
    refund: featureRow('supported', 'POST /refund/apply. Needs providerPaymentId (Paytm TXNID). refId = refundRef de-duplicates.'),
    refundStatus: featureRow('supported', 'POST /v2/refund/status by orderId + refId.'),
    webhooks: featureRow('partial', 'Payment notifications (form key-values + CHECKSUMHASH) are verified and normalised. Refund notification shape is not verified against docs.'),
    customers: featureRow('unsupported', 'Paytm PG has no customer-object API; custId is just a string sent per transaction.'),
    subscriptions: featureRow('not_implemented', 'Paytm Subscription API (recurring / UPI Autopay mandates) exists in the paytmpayments.com docs.'),
    settlements: featureRow('not_implemented', 'Paytm Settlement API / settlement reports exist in the paytmpayments.com docs.'),
    payouts: featureRow('not_implemented', 'Paytm Payouts is a separate product with its own onboarding and credentials.'),
    paymentLinks: featureRow('not_implemented', 'Paytm Payment Links API exists; not wired up here.'),
  },
  paymentMethods: ['upi', 'card', 'netbanking', 'emi'],
  currencies: 'INR only.',
  checkoutTypes: ['js_sdk', 'form_post'],
  providerAmountFormat: 'Rupee string with 2 decimals in txnAmount.value / refundAmount ("499.00").',
  credentials: [
    { env: 'PAYTM_MID', key: 'mid', required: true, secret: false, description: 'Merchant ID (Dashboard > Developer Settings > API Keys). Test and production MIDs differ.' },
    { env: 'PAYTM_MERCHANT_KEY', key: 'merchantKey', required: true, secret: true, description: '16-character merchant key; signs and verifies every checksum.' },
    { env: 'PAYTM_WEBSITE', key: 'website', required: false, secret: false, description: 'websiteName. Defaults to WEBSTAGING in sandbox and DEFAULT in live.' },
  ],
  constraints: [
    'Hosts were rebranded: staging securestage.paytmpayments.com, production secure.paytmpayments.com. securegw(-stage).paytm.in only appears in legacy docs.',
    'Refund/status doc pages show staging securegw-stage.paytmpayments.in; this adapter uses the same host for every call. Confirm in sandbox.',
    'orderId (our orderRef) max 50 characters and must be unique per transaction attempt.',
    'txnToken from Initiate Transaction expires after 15 minutes; create a new payment after that.',
    'Merchant key must be exactly 16 bytes (AES-128 key).',
    'websiteName must be WEBSTAGING on staging and DEFAULT (or your configured name) in production.',
    'Business errors come back as HTTP 200 with body.resultInfo.resultStatus F / TXN_FAILURE; check resultInfo, not the HTTP status.',
    'Refunds need the Paytm TXNID (providerPaymentId), not just the orderId.',
    'Server-to-server notification URL is set in the Paytm Dashboard, not per request.',
    'INR only.',
  ],
  officialSdks: {
    nodeChecksum: 'https://github.com/paytm/Paytm_Node_Checksum',
    jsCheckout: 'https://paytmpayments.com/docs/jscheckout-invoke-payment',
  },
  platformPlugins: {
    shopify: 'No official Paytm Shopify app found (unverified absence).',
  },
  lastVerified: '2026-10-28',
};
