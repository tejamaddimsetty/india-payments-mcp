import { featureRow, type ProviderCapabilities } from '../../core/capabilities.js';

export const payuCapabilities: ProviderCapabilities = {
  provider: 'payu',
  displayName: 'PayU India',
  website: 'https://payu.in',
  docsUrl: 'https://docs.payu.in',
  dashboardUrl: 'https://onboarding.payu.in/app/account',
  summary:
    'Large Indian gateway with a hosted checkout reached by HTML form POST, SHA-512 hashes instead of API auth, and a single "postservice" endpoint for status and refunds.',
  features: {
    createPayment: featureRow('supported', 'Hosted checkout: form POST to /_payment with sha512(key|txnid|amount|productinfo|firstname|email|udf1..udf5||||||SALT). No API call is made.'),
    verifyPayment: featureRow('supported', 'Reverse hash sha512([additional_charges|]SALT|status||||||udf5..udf1|email|firstname|productinfo|amount|txnid|key). PayU still recommends a verify_payment call before fulfilling. additional_charges is also read as additionalCharges (the webhook field table spells it that way).'),
    paymentStatus: featureRow('supported', 'postservice command=verify_payment, var1=txnid (our orderRef).'),
    refund: featureRow('supported', 'postservice command=cancel_refund_transaction, var1=mihpayid (providerPaymentId), var2=refundRef (max 23 chars). Cancels if only authorised (the id then comes back as txn_update_id), refunds if captured. Omitting amount refunds the ORIGINAL amount; after a partial refund always pass the remaining amount explicitly. PayU rejects a reused refund token (error 106 "Token already exists") instead of returning the earlier refund: on OUTCOME_UNKNOWN check refund status before retrying with a NEW refundRef. error_code 102 (queued) is treated as accepted.'),
    refundStatus: featureRow('supported', 'postservice command=check_action_status, var1=request_id (providerRefundId), as in the PayU docs and the official PHP SDK (checkRefundStatus). Both documented response shapes are parsed: nested transaction_details.{request_id}.{request_id}.{status, amt} and flat {refund_status, refund_amount}. QUEUED / REQUESTED / IN PROGRESS / processing / od_hit map to pending.'),
    webhooks: featureRow('partial', 'Payment webhooks carry the same reverse hash as the surl/furl callback; form-encoded and JSON bodies are both accepted. Refund webhooks are not parsed: poll getRefundStatus instead.'),
    customers: featureRow('unsupported', 'PayU has no standalone customer object; saved cards hang off a merchant-supplied user_credentials string.'),
    subscriptions: featureRow('not_implemented', 'PayU offers recurring payments via Standing Instructions (si=1, si_details) and mandate APIs (UNVERIFIED).'),
    settlements: featureRow('not_implemented', 'Settlement-details postservice commands exist (UNVERIFIED).'),
    payouts: featureRow('not_implemented', 'PayU Payouts is a separate product with separate credentials.'),
    paymentLinks: featureRow('not_implemented', 'PayU offers invoices / payment links via the dashboard and postservice (UNVERIFIED).'),
  },
  paymentMethods: ['upi', 'card', 'netbanking', 'wallet', 'emi', 'cardless_emi', 'paylater'],
  currencies: 'INR. International currencies need a separately enabled PayU account.',
  checkoutTypes: ['form_post'],
  providerAmountFormat: 'Rupee decimal string, e.g. "499.00". The exact same string must be used in the form and in the hash.',
  credentials: [
    { env: 'PAYU_MERCHANT_KEY', key: 'key', required: true, secret: false, description: 'Merchant key (Dashboard > Developers > API Keys). Sent in the checkout form, so it is not secret.' },
    { env: 'PAYU_MERCHANT_SALT', key: 'salt', required: true, secret: true, description: 'Merchant salt (v1). Used for every hash. Never send it to the browser.' },
  ],
  constraints: [
    'Test and live keys are different, but nothing in the key tells them apart: make sure PAYMENTS_MODE matches the key you configured.',
    'txnid (our orderRef) must be unique per payment attempt and at most 25 characters; PayU rejects a reused txnid.',
    'Field limits (enforced): productinfo 100, firstname 60 (20 in the test environment), email 50, phone 50, lastname 20, address1/2 100, city/state/country 50, zipcode 20, udf1..udf5 255 characters. The docs also list 50 for surl/furl; that is only logged as a warning because it looks stale.',
    'firstname, email and phone are required by the hosted checkout; pass them in customer.',
    'surl/furl are required: createPayment needs returnUrl. PayU POSTs the result there, so the URL must accept POST.',
    'Only 5 user-defined fields (udf1..udf5): metadata is capped at 5 values, mapped in insertion order. Keys are not sent.',
    'Refund ids (var2 token_id) are max 23 characters.',
    'Refunds and status lookups need the PayU id (mihpayid) for refunds, but the txnid for verify_payment.',
    'Test-mode webhooks only fire for test transactions; configure webhooks in the dashboard.',
    'The surl/furl callback is a browser redirect: confirm with getPaymentStatus before fulfilling.',
  ],
  officialSdks: {
    mobile: 'Android, iOS, React Native and Flutter SDKs are listed under Mobile SDK Integration at https://docs.payu.in (URLs not pinned here: UNVERIFIED).',
  },
  platformPlugins: {
    shopify: 'PayU India is listed as a Shopify payment provider in India: Shopify Admin > Settings > Payments.',
    woocommerce: 'PayU publishes a WooCommerce plugin (search "PayU India" in the WordPress plugin directory).',
  },
  lastVerified: '2026-10-28',
};
