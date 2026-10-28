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
    createPayment: featureRow('supported', 'Form POST of encRequest (the encrypted urlencoded order) + access_code. cbc kit: AES-128-CBC to transaction/transaction.do?command=initiateTransaction; gcm kit: AES-256-GCM to gTransaction.do?command=initiateTransaction. No API call is made.'),
    verifyPayment: featureRow('supported', 'Decrypts encResp with the working key. With cbc, AES-CBC without a MAC is NOT authentication (blocks of two genuine responses can be spliced); with gcm the auth tag does authenticate it. Either way PaymentsClient confirms the result with the status API before setting paid.'),
    paymentStatus: featureRow('partial', 'DoWebTrans command=orderStatusTracker, version 1.2 (third-party implementations use 1.2 and 1.1). Request/response fields come from the official PHP kit sample and third-party clients; UNVERIFIED against an official API reference. With CCAVENUE_ENCRYPTION=gcm the API enc_request/enc_response also use AES-256-GCM: UNVERIFIED (only one third-party implementation does this).'),
    refund: featureRow('partial', 'DoWebTrans command=refundOrder, version 1.1, with reference_no (tracking_id), refund_amount, refund_ref_no (third-party implementations agree; UNVERIFIED officially). A repeated refund_ref_no is rejected, not de-duplicated. Omitting amount refunds the ORIGINAL amount; after a partial refund always pass the remaining amount explicitly. Odoo reports that staging accepts only one refund per order.'),
    refundStatus: featureRow('not_implemented', 'Not implemented. A DoWebTrans command=getRefundDetails exists per third-party code (Odoo): request {reference_no}, returns refund_list[] with refund_status TS-REFA / TS-REFC / TS-REFF / TS-REFD (UNVERIFIED). orderStatusTracker also shows Refunded orders.'),
    webhooks: featureRow('partial', 'CCAvenue has no publicly documented signed webhook. parseWebhook decrypts an encResp form body (the redirect POST, or a Dynamic Event Notification configured to send it); with cbc, decryption alone is NOT authentication (no MAC; gcm is authenticated by its tag), so events arrive with bodyAuthenticated=false and createWebhookHandler re-confirms them with the status API. Only Order Status events are parsed; CCAvenue also offers Order Refund Status and Order Risk Status events (payload undocumented, not parsed).'),
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
    {
      env: 'CCAVENUE_ENCRYPTION',
      key: 'encryption',
      required: false,
      secret: false,
      description: 'Which CCAvenue integration kit the account uses: "cbc" (classic AES-128 kit, default) or "gcm" (AES-256 kit; working key must be 32 characters).',
    },
  ],
  constraints: [
    'Server IP must be whitelisted with CCAvenue for API calls (status, refund) to work (per merchant setup guides). Error codes such as enc_error_code are passed through unmapped.',
    'Two integration kits exist (CCAvenue NodeJS kit ships AES-128 and AES-256 folders). cbc (default): AES-128-CBC, key = md5(working key) as 16 raw bytes, fixed IV 0x00..0x0f, PKCS#7, hex; checkout at transaction/transaction.do. gcm: AES-256-GCM, key = the 32-character working key used directly (no MD5), random 12-byte IV, output hex(iv) + hex(ciphertext || 16-byte tag); checkout at gTransaction.do. Set CCAVENUE_ENCRYPTION to match the kit CCAvenue assigned your account; it is not clear how accounts are assigned, so ask CCAvenue before going live.',
    'UNVERIFIED API details: CCAvenue publishes no public API reference. The kits come from third-party mirrors of the official downloads; orderStatusTracker / refundOrder field names and versions come from third-party implementations. The gcm sandbox checkout URL and the use of GCM for DoWebTrans are third-party-sourced. Test everything in sandbox.',
    'billing_country is sent as a country name (e.g. "India", as in the kit sample); ISO alpha-2 codes are mapped to names.',
    'Access code and working key are issued per registered domain; the redirect_url domain must match the one registered.',
    'Test and live use different hosts AND different credentials.',
    'createPayment needs returnUrl (used as redirect_url and cancel_url); CCAvenue POSTs encResp there.',
    'Only 5 merchant_param slots: metadata is capped at 5 values, mapped in insertion order.',
    'With cbc the encrypted redirect is not a signature: AES-CBC without a MAC is malleable (bit-flipping can alter known fields without the key). Always confirm with getPaymentStatus before fulfilling (gcm is authenticated, but the same confirmation is applied).',
  ],
  officialSdks: {
    mobile: 'Android / iOS in-app SDKs and server integration kits are downloadable from the CCAvenue merchant dashboard (not publicly linked).',
  },
  platformPlugins: {
    woocommerce: 'CCAvenue distributes a WooCommerce plugin through its merchant dashboard downloads.',
  },
  lastVerified: '2026-10-29',
};
