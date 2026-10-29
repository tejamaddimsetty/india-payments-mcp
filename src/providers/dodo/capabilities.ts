import { featureRow, type ProviderCapabilities } from '../../core/capabilities.js';

/** Facts: docs/research/dodo-api-facts.md (official docs + per-endpoint OpenAPI blocks, spec 1.120.26). */
export const dodoCapabilities: ProviderCapabilities = {
  provider: 'dodo',
  displayName: 'Dodo Payments',
  website: 'https://dodopayments.com',
  docsUrl: 'https://docs.dodopayments.com',
  dashboardUrl: 'https://app.dodopayments.com',
  summary:
    'Merchant of Record for digital products (SaaS, AI, digital goods): Dodo is the legal seller and handles VAT/GST/sales tax worldwide. Hosted checkout with cards, UPI and RuPay for Indian buyers; 145 ISO currency codes in the API. Payouts in USD, GBP or EUR only (INR payouts discontinued). Physical goods and manual, human-delivered services are not allowed.',
  features: {
    createPayment: featureRow(
      'supported',
      'Checkout Session (POST /checkouts) for a product you created in Dodo: providerOptions.productId or DODO_PAYMENTS_DEFAULT_PRODUCT_ID. Dodo has no ad-hoc prices: the adapter reads the product first and refuses a fixed price that differs from `amount`; a pay-what-you-want product takes `amount` (Dodo: PWYW base currency USD, GBP or EUR).',
    ),
    verifyPayment: featureRow('supported', 'The return_url redirect is unsigned (payment_id, status): verified server-side with GET /checkouts/{id} + GET /payments/{id} (verifiedVia status_api). Needs providerOrderId: the payment must belong to the checkout session we created, then order_ref, amount and currency must match.'),
    paymentStatus: featureRow('supported', 'GET /checkouts/{session_id} (providerOrderId, cks_...) then GET /payments/{payment_id}; or providerPaymentId directly. Dodo cannot search by metadata, so store providerOrderId.'),
    refund: featureRow(
      'partial',
      'POST /refunds. Full, or partial (one-item carts, as created here; not when Dodo added tax on top), in the payment currency. No idempotency header: the adapter first looks for an existing refund with the same refundRef. Dodo rules: within 30 days, one refund in flight per payment, your Dodo balance must cover it.',
    ),
    refundStatus: featureRow('supported', 'GET /refunds/{refund_id}, or by refundRef among the payment\'s refunds.'),
    webhooks: featureRow('supported', 'Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature v1 HMAC-SHA256, 5-minute tolerance). Payment, refund, subscription, dispute and payout events.'),
    customers: featureRow('supported', 'POST /customers (name and email required).'),
    subscriptions: featureRow(
      'partial',
      'Checkout Session for a recurring-price product you created in Dodo (providerPlanId = product id; plans cannot be created from `plan`). providerSubscriptionId is the cks_ session id until the subscription webhook. Cancel: PATCH /subscriptions/{id}.',
    ),
    settlements: featureRow('partial', 'Mapped to GET /payouts (USD/GBP/EUR payouts of your Dodo balance, net of fees).'),
    payouts: featureRow('unsupported', 'Dodo pays you out on its own cycle; the API cannot send money to third parties.'),
    paymentLinks: featureRow('not_implemented', 'Static links (checkout.dodopayments.com/buy/{product_id}) need no API; use createPayment for per-order sessions.'),
  },
  paymentMethods: ['card', 'upi', 'rupay', 'apple_pay', 'google_pay', 'klarna', 'afterpay', 'ach', 'sepa', 'others_by_country'],
  currencies: '145 ISO currency codes in the API (Adaptive Currency: 80+ local currencies), including INR. INR minimum: the higher of Rs 5 and the equivalent of US$0.50 (US$1.00 for subscriptions). Payouts in USD, GBP or EUR only.',
  checkoutTypes: ['redirect'],
  providerAmountFormat: 'integer smallest currency unit (paise, cents): same as ours',
  credentials: [
    { env: 'DODO_PAYMENTS_API_KEY', key: 'apiKey', required: true, secret: true, description: 'Dashboard > Developer > API Keys. dodo_test_... (test mode) or dodo_live_...; keys only work in their own mode.' },
    { env: 'DODO_PAYMENTS_WEBHOOK_KEY', key: 'webhookKey', required: false, secret: true, description: 'Webhook endpoint secret (whsec_...), from the endpoint\'s Overview tab. Needed to verify webhooks.' },
    { env: 'DODO_PAYMENTS_DEFAULT_PRODUCT_ID', key: 'defaultProductId', required: false, secret: false, description: 'Product charged when createPayment has no providerOptions.productId. Use a pay-what-you-want product (USD/GBP/EUR) to charge any amount.' },
  ],
  constraints: [
    'Merchant of Record for digital products only: SaaS, AI, digital goods, templates, plugins, apps, e-books, edtech. Physical goods and manual or human-delivered services (consulting, freelancing, coaching) are not allowed (Dodo merchant acceptance policy).',
    'Products first: every payment is for a product created in the Dodo dashboard or API. A fixed-price product must cost exactly `amount` in `currency`, with no product discount, purchasing power parity or localized (per-currency/per-country) prices (checked before the session is created). To charge arbitrary amounts, create one pay-what-you-want product; Dodo requires its base currency to be USD, GBP or EUR, so INR amounts need a fixed-price INR product per price.',
    'Binding: anyone can create a Dodo payment carrying your order_ref (static payment links take metadata_<key>). verifyPayment therefore requires providerOrderId (the cks_ session id from createPayment) and only accepts that session\'s payment; match webhooks to your stored session id too (the generated code does). getPaymentStatus by providerPaymentId alone is bound by metadata only: do not fulfil on it.',
    'As Merchant of Record Dodo may add tax on top of a tax-exclusive price. verifyPayment accepts total_amount = amount (tax-inclusive) or total_amount - tax = amount (tax-exclusive), in the order currency. Our sessions turn off discount codes and currency selection (both default to on in Dodo); if Adaptive Currency still charges another currency, the payment is reported as a currency mismatch and never as paid.',
    'The return_url redirect is unsigned. Fulfil on the payment.succeeded webhook or after verifyPayment, never on the query string.',
    'No API idempotency key: a create or refund that times out is reported as OUTCOME_UNKNOWN, never retried blindly. Refunds look for an existing refund with the same refundRef (metadata.refund_ref) first; that check is per call, so two processes refunding the same refundRef at the same moment can still both reach Dodo (Dodo then allows only one in flight per payment). Run refunds from one place.',
    'Refunds: within 30 days of payment, one refund in pending/review per payment at a time, your Dodo balance must cover it, and payment fees are not returned. Only payments created through this library (with our order_ref) are refunded here. Partial amounts are sent in the payment currency; partial refunds of payments where Dodo added tax on top are refused (refund in full or use the dashboard).',
    'Payouts are in USD, GBP or EUR to a local or SWIFT account; INR payouts were discontinued. Dodo\'s docs do not mention FIRA/FIRC: ask Dodo how inward-remittance certificates work for your account.',
    'India: UPI shows only for billing country IN in INR with upi_intent allowed; RBI e-mandate renewals charge 48-51 hours after the renewal date. For Indian-card e-mandates the default mandate ceiling is Rs 15,000 (mandate_min_amount_inr_paise; not UPI AutoPay).',
    'Test mode and live mode have separate keys, products and webhooks (test: test.dodopayments.com, live: live.dodopayments.com). PAYMENTS_MODE=sandbox uses test mode and refuses dodo_live_ keys; live refuses dodo_test_ keys.',
    'Dodo ships its own MCP server (npm dodopayments-mcp: search_docs + execute). This adapter is the cross-gateway interface; it is not affiliated with Dodo.',
  ],
  officialSdks: {
    node: 'npm dodopayments',
    python: 'pip dodopayments',
    go: 'github.com/dodopayments/dodopayments-go',
    php: 'dodopayments/client',
    mcp: 'npm dodopayments-mcp (official Dodo MCP server)',
  },
  platformPlugins: {
    shopify: 'No Dodo Shopify payments app found.',
  },
  lastVerified: '2026-10-29',
};
