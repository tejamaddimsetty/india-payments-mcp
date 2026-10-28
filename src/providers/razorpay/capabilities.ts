import { featureRow, type ProviderCapabilities } from '../../core/capabilities.js';

export const razorpayCapabilities: ProviderCapabilities = {
  provider: 'razorpay',
  displayName: 'Razorpay',
  website: 'https://razorpay.com',
  docsUrl: 'https://razorpay.com/docs/api/',
  dashboardUrl: 'https://dashboard.razorpay.com',
  summary:
    'Most complete developer API in India: orders, UPI, cards, netbanking, wallets, EMI, subscriptions, payment links, settlements, plus RazorpayX for payouts.',
  features: {
    createPayment: featureRow('supported', 'Orders API + Checkout.js (Standard Checkout).'),
    verifyPayment: featureRow('supported', 'HMAC-SHA256(order_id|payment_id, key_secret).'),
    paymentStatus: featureRow('supported', 'GET /v1/orders/{id}/payments. Needs providerOrderId (order_xxx).'),
    refund: featureRow('supported', 'Normal or instant (optimum) speed. Partial refunds allowed.'),
    refundStatus: featureRow('supported'),
    webhooks: featureRow('supported', 'X-Razorpay-Signature = HMAC-SHA256(raw body, webhook secret). Use x-razorpay-event-id to dedupe.'),
    customers: featureRow('supported'),
    subscriptions: featureRow('supported', 'Plans + Subscriptions API. Customer authorises the mandate via Checkout with subscription_id.'),
    settlements: featureRow('supported', 'GET /v1/settlements.'),
    payouts: featureRow('not_implemented', 'Payouts are a separate product (RazorpayX) with separate keys and a current account.'),
    paymentLinks: featureRow('not_implemented', 'Available via POST /v1/payment_links; pass through with your own call for now.'),
  },
  paymentMethods: ['upi', 'card', 'netbanking', 'wallet', 'emi', 'cardless_emi', 'paylater'],
  currencies: 'INR plus 100+ currencies for international cards (must be enabled on the account).',
  checkoutTypes: ['js_sdk', 'redirect'],
  providerAmountFormat: 'Integer paise (same as ours).',
  credentials: [
    { env: 'RAZORPAY_KEY_ID', key: 'keyId', required: true, secret: false, description: 'rzp_test_... or rzp_live_... (Dashboard > Account & Settings > API Keys)' },
    { env: 'RAZORPAY_KEY_SECRET', key: 'keySecret', required: true, secret: true, description: 'Key secret shown once when the key is generated.' },
    { env: 'RAZORPAY_WEBHOOK_SECRET', key: 'webhookSecret', required: false, secret: true, description: 'Secret you typed when creating the webhook. Required to verify webhooks.' },
  ],
  constraints: [
    'Minimum amount is 100 paise (Rs 1).',
    'receipt (our orderRef) max 40 characters.',
    'Order is "paid" only after capture. Enable auto-capture in Dashboard > Payment Capture, or capture via API, or payments auto-refund after the capture window.',
    'notes: max 15 key/value pairs, 256 chars each.',
    'Webhook secret is set per webhook in the dashboard; it is NOT the API key secret.',
  ],
  officialSdks: {
    android: 'https://razorpay.com/docs/payments/payment-gateway/android-integration/',
    ios: 'https://razorpay.com/docs/payments/payment-gateway/ios-integration/',
    reactNative: 'https://www.npmjs.com/package/react-native-razorpay',
    flutter: 'https://pub.dev/packages/razorpay_flutter',
    node: 'https://www.npmjs.com/package/razorpay',
  },
  platformPlugins: {
    shopify: 'Razorpay is an official Shopify payment provider in India: Shopify Admin > Settings > Payments.',
    woocommerce: 'https://wordpress.org/plugins/woo-razorpay/',
  },
  lastVerified: '2026-10-28',
};
