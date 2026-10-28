# Razorpay

Docs: https://razorpay.com/docs/api/ · Server integration: https://razorpay.com/docs/payments/server-integration/nodejs/integration-steps/
Status labels: VERIFIED = read on the official page; PARTIAL = partly confirmed; UNVERIFIED = not confirmed from an official source, test in sandbox.

## Auth and environments

- Base URL `https://api.razorpay.com/v1` for both test and live. Mode is decided by the key pair: `rzp_test_…` vs `rzp_live_…`. VERIFIED
- HTTP Basic `key_id:key_secret`. Partner (platform) calls add `X-Razorpay-Account: <merchant account id>`. VERIFIED
- Secrets: `key_secret` (API + payment signature) and a **separate** per-webhook secret you type in Dashboard > Webhooks. They are not the same value. VERIFIED
- Env (this project): `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_MERCHANT_NAME` (optional: the Checkout option `name`, which Razorpay marks mandatory; falls back to "Payment").

## Amounts

Integer paise (smallest subunit): Rs 299 = `29900`. Min 100 paise. Zero-decimal (JPY) and 3-decimal (KWD) currencies differ if international is enabled. VERIFIED

## Endpoints

| Purpose | Call | Status |
|---|---|---|
| Create order | `POST /v1/orders` `{amount, currency, receipt?, notes?, partial_payment?}` → `{id:"order_…", status:"created", amount, amount_due}` | VERIFIED |
| Payment by id | `GET /v1/payments/{id}` | UNVERIFIED (standard) |
| Payments of an order | `GET /v1/orders/{id}/payments` | UNVERIFIED (standard) |
| Capture | `POST /v1/payments/{id}/capture` `{amount, currency}` (only if auto-capture is off) | UNVERIFIED |
| Refund | `POST /v1/payments/{payment_id}/refund` `{amount?, speed?: "normal"\|"optimum", notes?, receipt?}`. Omit amount = full | VERIFIED https://razorpay.com/docs/api/refunds/create-normal/ |
| Refund status | `GET /v1/payments/{payment_id}/refunds/{refund_id}` → `status` pending/processed/failed, `speed_processed`, `acquirer_data` (RRN/ARN/UTR) | VERIFIED |
| Customers | `POST /v1/customers` `{name, contact, email, fail_existing:"0"\|"1", gstin?, notes?}` → `cust_…` | VERIFIED |
| Plans / subscriptions | `POST/GET /v1/plans`, `POST/GET /v1/subscriptions`, `POST /v1/subscriptions/:id/cancel`, `/pause`, `/resume` | VERIFIED https://razorpay.com/docs/api/payments/subscriptions/ |
| Settlements | `GET /v1/settlements`, `GET /v1/settlements/:id`, `GET /v1/settlements/recon/combined?year=YYYY&month=MM` | VERIFIED |
| Payouts (RazorpayX) | `POST /v1/payouts`, header `X-Payout-Idempotency` required, IP allowlist required, separate product activation | VERIFIED |

`receipt` max 40 chars (put your attempt ref here). `notes` max 15 pairs. A second order with the same receipt is rejected as a duplicate; this project then returns the existing order if amount and currency match.

## Checkout flow (Standard Checkout)

1. Server: compute amount, `POST /v1/orders` with `receipt = attemptRef`. Store `order_id` on the attempt.
2. Client: load `https://checkout.razorpay.com/v1/checkout.js`, `new Razorpay({ key: KEY_ID, order_id, amount, currency, name, prefill, handler }).open()`. `name` (your business name) is mandatory. VERIFIED
3. `handler` receives `{razorpay_payment_id, razorpay_order_id, razorpay_signature}`. POST them to your server.
4. Server verifies the signature using the **order_id from your DB**, not from the payload ("Do not use the `razorpay_order_id` returned by Checkout"), then marks paid (idempotently). With this SDK/MCP pass `providerOrderId` (MCP: `provider_order_id`) = the stored `order_…` / `sub_…` id, plus `orderRef` and `expectedAmount`. Without `providerOrderId` or `orderRef` the callback is rejected.
5. Webhook `payment.captured` / `order.paid` also marks paid. Whichever arrives first wins; the other is a no-op.

## Signatures

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Checkout callback (orders): hex(HMAC_SHA256(order_id + "|" + payment_id, key_secret))   VERIFIED
export function verifyOrderPayment(storedOrderId: string, paymentId: string, signature: string, keySecret: string) {
  const expected = createHmac('sha256', keySecret).update(`${storedOrderId}|${paymentId}`).digest('hex');
  return eq(expected, signature);
}

// Subscriptions: ORDER IS REVERSED: payment_id + "|" + subscription_id   VERIFIED
export function verifySubscriptionPayment(paymentId: string, storedSubId: string, signature: string, keySecret: string) {
  return eq(createHmac('sha256', keySecret).update(`${paymentId}|${storedSubId}`).digest('hex'), signature);
}

// Webhook: X-Razorpay-Signature = hex(HMAC_SHA256(RAW body, webhook_secret))   VERIFIED
export function verifyWebhook(rawBody: string | Buffer, header: string, webhookSecret: string) {
  return eq(createHmac('sha256', webhookSecret).update(rawBody).digest('hex'), header);
}
```

Dedupe webhooks on header `x-razorpay-event-id`. VERIFIED (https://razorpay.com/docs/webhooks/validate-test/)

## Status mapping

| Razorpay | Unified |
|---|---|
| order `created` / `attempted` | `created` / `pending` |
| order `paid` (and `amount_paid >= amount`) | `captured` |
| payment `created` | `pending` |
| payment `authorized` | `authorized` (NOT paid; capture or it auto-refunds after the capture window) |
| payment `captured` | `captured` |
| payment `failed` | `failed` |
| payment `refunded` (full) / `amount_refunded > 0` | `refunded` / `partially_refunded` |

Common webhook events: `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.created`, `refund.processed`, `refund.failed`, `subscription.activated`, `subscription.charged`, `subscription.halted`, `subscription.cancelled`. UNVERIFIED as a complete list; check Dashboard > Webhooks.

## Gotchas

- `authorized` is not money. Turn on auto-capture (Dashboard > Account & Settings > Payment Capture) or call capture; uncaptured payments are auto-refunded. This project has no capture API: its `verifyPayment` reports `captured` (and `paid: true`) only when the order is fully paid (`status: paid`, `amount_paid >= amount`), otherwise `authorized` with `paid: false`. A captured instalment of a partly paid order is `pending` in `getPaymentStatus`.
- This project refuses `transfers`, `partial_payment` and `first_payment_min_amount` in `providerOptions` (and `plan_id`, `total_count`, `customer_notify`, `notes`, `offer_id`, `addons`, `quantity` for subscriptions).
- A reused refund `receipt` is rejected as a duplicate. After `OUTCOME_UNKNOWN` or that rejection, this project lists the payment's refunds (`GET /v1/payments/{id}/refunds`), matches the receipt and returns the existing refund; refund status accepts `providerPaymentId` + refundRef for the same lookup.
- Build the signature string from your stored `order_id`. Using `razorpay_order_id` from the client lets an attacker replay a valid signature from a cheaper order.
- Webhook secret != key secret. Most "signature invalid" bugs are this, or verifying `JSON.stringify(req.body)` instead of raw bytes.
- Same host for test and live: a live key in a dev env charges real cards.
- Instant refunds are `speed: "optimum"` (the unified API calls it `instant`); they can fall back to normal; read `speed_processed`.
- Subscriptions need `total_count` or `end_at` (this project: `totalCount`, or `providerOptions.end_at`). The first payment is the mandate authorisation via Checkout with `subscription_id`.
- Daily plans need `interval >= 7` (enforced before the call).
- `customer_id` is not a create-subscription parameter; Razorpay fills it after authorisation. This project keeps your customer id in `notes.customer_id`.
- Payment `method` values on the payment entity: `upi`, `card`, `netbanking`, `wallet`, `emi`, `paylater`. `cardless_emi` is not in the documented enum.

## Sandbox test data (UNVERIFIED in this research: re-check the official pages)

- Test UPI ids: `success@razorpay` (succeeds), `failure@razorpay` (fails). https://razorpay.com/docs/payments/payments/test-upi-details/
- Test cards (any future expiry, any CVV): see https://razorpay.com/docs/payments/payments/test-card-details/ (Indian domestic test cards are listed there; old `4111 1111 1111 1111` may be treated as international).
- Netbanking in test mode shows a bank simulator page with Success/Failure buttons.
- Dashboard webhook "Test" sends sample events; you can also point webhooks at a tunnel.

## Platforms

- Shopify: official app "All-in-one Razorpay Payment Gateway". Install from the App Store, connect as account owner, no API keys. Stores integrated before 28 Apr 2022 must migrate. VERIFIED https://razorpay.com/docs/payments/payment-gateway/ecommerce-plugins/shopify/
- WooCommerce: https://wordpress.org/plugins/woo-razorpay/
- Mobile SDKs: Android/iOS (razorpay.com docs), `react-native-razorpay`, `razorpay_flutter`. The app still gets `order_id` from your server and posts the result back for verification.
