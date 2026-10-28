import { featureRow, type ProviderCapabilities } from '../../core/capabilities.js';

export const ccavenueCapabilities: ProviderCapabilities = {
  provider: 'ccavenue',
  displayName: 'CCAvenue',
  website: 'https://www.ccavenue.com',
  // No public API reference: the integration kit and API PDFs live inside the merchant dashboard (M.A.R.S.).
  docsUrl: 'https://www.ccavenue.com',
  dashboardUrl: 'https://dashboard.ccavenue.com',
  summary:
    'Long-standing Indian gateway with very wide method and currency coverage. Hosted checkout by form POST of an AES-encrypted request; no public API docs, IP-whitelisted server API.',
  features: {
    createPayment: featureRow('supported', 'Form POST of encRequest (AES-128-CBC of the urlencoded order) + access_code to transaction.do?command=initiateTransaction. No API call is made.'),
    verifyPayment: featureRow('supported', 'Decrypts encResp with the working key; AES-CBC without a MAC is NOT authentication (blocks of two genuine responses can be spliced), so PaymentsClient always confirms the result with the status API before setting paid.'),
    paymentStatus: featureRow('partial', 'DoWebTrans command=orderStatusTracker. Command name, request fields and API version (1.2, possibly 1.1) are UNVERIFIED.'),
    refund: featureRow('partial', 'DoWebTrans command=refundOrder with reference_no (tracking_id), refund_amount, refund_ref_no. UNVERIFIED. Omitting amount refunds the ORIGINAL amount; after a partial refund always pass the remaining amount explicitly.'),
    refundStatus: featureRow('not_implemented', 'Refund state is reportedly visible via orderStatusTracker / refund-details commands in the dashboard-only API PDF (UNVERIFIED).'),
    webhooks: featureRow('partial', 'CCAvenue has no publicly documented signed webhook. parseWebhook decrypts an encResp form body (the redirect POST, or a Dynamic Event Notification configured to send it); decryption alone is NOT authentication (no MAC), so events arrive with bodyAuthenticated=false and createWebhookHandler re-confirms them with the status API. Payment events only.'),
    customers: featureRow('unsupported', 'No customer object API; saved cards use a merchant-supplied customer_identifier on checkout.'),
    subscriptions: featureRow('not_implemented', 'Standing Instructions are reportedly in the dashboard-only API PDF (UNVERIFIED).'),
    settlements: featureRow('not_implemented', 'Settlement APIs are reportedly in the dashboard-only API PDF (UNVERIFIED).'),
    payouts: featureRow('not_implemented', 'Payout summary commands are referenced in third-party copies of the API PDF (UNVERIFIED).'),
    paymentLinks: featureRow('not_implemented', 'Invoices / payment links exist in the dashboard; API not verified.'),
  },
  paymentMethods: ['upi', 'card', 'netbanking', 'wallet', 'emi', 'paylater'],
  currencies: 'INR plus many international currencies (each must be enabled on the account).',
  checkoutTypes: ['form_post'],
  providerAmountFormat: 'Rupee decimal string, Numeric(12,2), e.g. "499.00".',
  credentials: [
    { env: 'CCAVENUE_MERCHANT_ID', key: 'merchantId', required: true, secret: false, description: 'Numeric merchant id (Dashboard > Settings > API Keys).' },
    { env: 'CCAVENUE_ACCESS_CODE', key: 'accessCode', required: true, secret: false, description: 'Access code for the registered domain/URL. Sent in the checkout form.' },
    { env: 'CCAVENUE_WORKING_KEY', key: 'workingKey', required: true, secret: true, description: 'Working (encryption) key. Encrypts requests and decrypts responses; never send it to the browser.' },
  ],
  constraints: [
    'Server IP must be whitelisted with CCAvenue for API calls (status, refund) to work. Error 51407 = invalid access_code.',
    'UNVERIFIED API details: CCAvenue publishes no public API reference. Encryption (AES-128-CBC, key=md5(working key), IV 0x00..0x0f, hex), orderStatusTracker / refundOrder field names and API version come from integration kits and third-party copies of the API PDF. Test everything in sandbox.',
    'Some newer accounts may use a different (AES-256-GCM) kit: ask CCAvenue which kit your account uses before going live.',
    'Access code and working key are issued per registered domain; the redirect_url domain must match the one registered.',
    'Test and live use different hosts AND different credentials.',
    'createPayment needs returnUrl (used as redirect_url and cancel_url); CCAvenue POSTs encResp there.',
    'Only 5 merchant_param slots: metadata is capped at 5 values, mapped in insertion order.',
    'The encrypted redirect is not a signature: AES-CBC without a MAC is malleable (bit-flipping can alter known fields without the key). Always confirm with getPaymentStatus before fulfilling.',
  ],
  officialSdks: {
    mobile: 'Android / iOS in-app SDKs and server integration kits are downloadable from the CCAvenue merchant dashboard (not publicly linked).',
  },
  platformPlugins: {
    woocommerce: 'CCAvenue distributes a WooCommerce plugin through its merchant dashboard downloads.',
  },
  lastVerified: '2026-10-28',
};
