import { featureRow, type ProviderCapabilities } from '../../core/capabilities.js';

export const stripeCapabilities: ProviderCapabilities = {
  provider: 'stripe',
  displayName: 'Stripe (India)',
  website: 'https://stripe.com/in',
  docsUrl: 'https://docs.stripe.com/api',
  dashboardUrl: 'https://dashboard.stripe.com',
  summary:
    "Stripe India onboarding is invite-only; best for exporters/international customers; Indian merchants generally can't start fresh with it. Existing accounts get Checkout Sessions, PaymentIntents, Billing and payouts to an Indian bank account.",
  features: {
    createPayment: featureRow(
      'supported',
      "Checkout Session (hosted page, redirect) by default. providerOptions.flow = 'payment_intent' returns a PaymentIntent client_secret for Stripe.js / Payment Element instead (needs STRIPE_PUBLISHABLE_KEY).",
    ),
    verifyPayment: featureRow(
      'supported',
      'Stripe does not sign the browser redirect (it only appends session_id / payment_intent). The adapter re-fetches the Session or PaymentIntent from the API and checks orderRef + amount (verifiedVia = status_api).',
    ),
    paymentStatus: featureRow('supported', 'GET /v1/checkout/sessions/{cs_...} or /v1/payment_intents/{pi_...}. Needs providerOrderId.'),
    refund: featureRow(
      'supported',
      'POST /v1/refunds with Idempotency-Key = refundRef. Partial refunds allowed. reason only accepts duplicate | fraudulent | requested_by_customer; anything else goes to metadata. No "instant" speed. For a pi_ the PaymentIntent is fetched first: an uncaptured one (requires_capture) cannot be refunded, so it is cancelled (POST /v1/payment_intents/{id}/cancel, same Idempotency-Key) and reported as processed with a note in raw (full amount only; no re_ id).',
    ),
    refundStatus: featureRow('supported', 'GET /v1/refunds/{re_...}, or by refundRef via the payment\'s refund list when providerPaymentId is given.'),
    webhooks: featureRow(
      'supported',
      'Stripe-Signature: t=<unix>,v1=<hex>. HMAC-SHA256(`${t}.${rawBody}`, whsec_...) compared against every v1; 300 s tolerance. Dedupe on the normalised id: evt_... for most events, refund:<re_id>:<status> for refund events. charge.dispute.created: orderRef is read from the charge / PaymentIntent metadata only when expanded, else undefined; map providerPaymentId (pi_..., else ch_...) to your order.',
    ),
    customers: featureRow('supported', 'POST /v1/customers.'),
    subscriptions: featureRow(
      'partial',
      'Checkout Session mode=subscription (inline price_data or providerPlanId = price_...). The returned providerSubscriptionId is the cs_ Session id until the customer completes Checkout; the real sub_ id arrives in checkout.session.completed / customer.subscription.created. Indian cards (and UPI, on non-India accounts) are bound by RBI e-mandate rules (see constraints).',
    ),
    settlements: featureRow(
      'partial',
      'Mapped to Stripe payouts (GET /v1/payouts): transfers of your Stripe balance to your bank. Amounts are net of fees; use balance_transactions?payout=po_... for per-payment fee breakdown.',
    ),
    payouts: featureRow('not_implemented', 'Paying third parties needs Stripe Connect (connected accounts + transfers), which this adapter does not implement.'),
    paymentLinks: featureRow('not_implemented', 'Available via POST /v1/payment_links; pass through with your own call for now.'),
  },
  // Indian Stripe accounts: cards. UPI is NOT available to India-domiciled accounts (IN is absent from
  // the UPI "Business locations" list, https://docs.stripe.com/payments/upi); it is for non-India
  // Stripe accounts charging Indian customers.
  paymentMethods: ['card'],
  currencies:
    '135+ presentment currencies on Visa/Mastercard, INR/USD on Amex. Non-INR (export) charges need extra onboarding info and must be declared as exports (purpose codes, FIRC/eFIRA).',
  checkoutTypes: ['redirect', 'js_sdk'],
  providerAmountFormat: 'Integer minor units (paise for INR), same as ours. Currency codes are sent lowercase.',
  credentials: [
    {
      env: 'STRIPE_SECRET_KEY',
      key: 'secretKey',
      required: true,
      secret: true,
      description: 'sk_test_... / sk_live_... (or a restricted key rk_test_... / rk_live_...). Dashboard > Developers > API keys.',
    },
    {
      env: 'STRIPE_PUBLISHABLE_KEY',
      key: 'publishableKey',
      required: false,
      secret: false,
      description: "pk_test_... / pk_live_.... Only needed for providerOptions.flow = 'payment_intent' (Stripe.js on your page).",
    },
    {
      env: 'STRIPE_WEBHOOK_SECRET',
      key: 'webhookSecret',
      required: false,
      secret: true,
      description: 'whsec_... signing secret of the webhook endpoint (Dashboard > Developers > Webhooks). NOT the API key. Required to verify webhooks.',
    },
  ],
  constraints: [
    'Stripe services are invite-only in India (since ~May 2024): Indian businesses must request an invite, focus is on international expansion. Only registered businesses (sole prop / LLP / company), no individuals.',
    'Treat Stripe as an exports / international-customer adapter, not a domestic-India default. Shopify Payments (Stripe) is not available to India stores.',
    'Indian export rules: each export charge needs a description of the goods/services and the customer\'s name and billing address. This adapter sends payment_intent_data.description and sets billing_address_collection=required on Checkout; for the PaymentIntent flow pass options.billingDetails into stripe.confirmPayment.',
    'Exports of physical goods also need the shipping address with a valid 2-letter ISO-3166 country code. The adapter does not collect it by default: pass providerOptions.shipping_address_collection = { allowed_countries: [...] } on Checkout (or shipping on the PaymentIntent).',
    'RBI e-mandate (recurring / off-session India cards and UPI): an e-mandate registered with AFA (3DS / UPI PIN) is required; a pre-debit notification must reach the customer >= 24 h before each debit, so Stripe holds card charges ~26 h (PaymentIntent sits in `processing`).',
    'RBI e-mandate: each recurring charge above Rs 15,000 needs fresh AFA from the customer, and UPI recurring above Rs 15,000 is not supported. Mandates cannot be updated or cancelled via the API.',
    'Payment methods: Indian Stripe accounts accept cards. UPI is only offered to Stripe accounts outside India charging Indian customers (docs.stripe.com/payments/upi lists no IN business location).',
    'Refunds: subscribe to refund.created, refund.updated and refund.failed (Stripe: listen to refund.created at a minimum; a refund can be created already `succeeded`, with no later refund.updated). refund.updated counts only when previous_attributes.status is present (a status change); metadata / ARN updates are type "unknown". charge.refunded fires on refund creation (possibly still pending; amount_refunded is cumulative) and is reported as type "unknown".',
    'Idempotency-Key max 255 chars and Checkout client_reference_id (orderRef / subscriptionRef) max 200 chars; longer values are rejected with VALIDATION before calling Stripe.',
    'Retries: Stripe replays the saved response for a reused Idempotency-Key, including a 500. The client retries POSTs with the same key, which helps for network errors/timeouts and 409/429, but a 5xx will come back as the same 500: check status (getPaymentStatus / getRefundStatus) before re-submitting with a new key.',
    'Idempotency keys expire after 24 h. createPayment derives one from orderRef: re-calling with the same orderRef and different parameters fails with an idempotency error, so use a fresh orderRef per attempt.',
    'metadata: max 50 keys, key <= 40 chars, value <= 500 chars.',
    'Checkout Sessions expire (default 24 h). The success redirect carries only session_id and is unsigned: never mark an order paid from the redirect alone, call verifyPayment or rely on webhooks.',
    'Webhooks are configured per endpoint in the Dashboard (notifyUrl is ignored), and payloads use the endpoint\'s API version.',
  ],
  officialSdks: {
    stripeJs: 'https://docs.stripe.com/js',
    android: 'https://github.com/stripe/stripe-android',
    ios: 'https://github.com/stripe/stripe-ios',
    reactNative: 'https://github.com/stripe/stripe-react-native',
    flutter: 'https://pub.dev/packages/flutter_stripe',
    node: 'https://www.npmjs.com/package/stripe',
  },
  platformPlugins: {
    shopify: 'Not usable for India-based stores (Shopify Payments, which runs on Stripe, is unavailable in India).',
    woocommerce: 'https://wordpress.org/plugins/woocommerce-gateway-stripe/',
  },
  lastVerified: '2026-10-29',
};
