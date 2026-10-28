# Cashfree Payments (PG)

Docs: https://www.cashfree.com/docs/api-reference/payments/latest/orders/create
Status labels: VERIFIED / PARTIAL / UNVERIFIED (test in sandbox).

## Auth and environments

- Base: sandbox `https://sandbox.cashfree.com/pg`, prod `https://api.cashfree.com/pg`. VERIFIED
- Headers on every call: `x-client-id`, `x-client-secret`, `x-api-version`. Latest version is `2026-01-01`; `2023-08-01` and `2025-01-01` are still documented. **Pin one** because response shapes change by version. Optional `x-request-id`, `x-idempotency-key` (UUID). Partners: `x-partner-apikey` + `x-partner-merchantid`. VERIFIED
- The client secret is used for the API **and** for webhook signatures. Rotating it changes both.
- Env (this project): `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`.

## Amounts

**Rupees as a JSON number**, up to 2 decimals (`10.15`). Min 1. **Not paise.** Convert at the adapter edge: `Number((paise / 100).toFixed(2))` on an integer paise value. VERIFIED

## Endpoints

| Purpose | Call | Status |
|---|---|---|
| Create order | `POST /pg/orders` `{order_id (3–45, [A-Za-z0-9_-]), order_amount, order_currency, customer_details:{customer_id, customer_phone, customer_email?, customer_name?}, order_meta?:{return_url, notify_url, payment_methods}, order_expiry_time?, order_note?, order_tags?}` → `{cf_order_id, order_id, order_status, payment_session_id}` | VERIFIED |
| Order | `GET /pg/orders/{order_id}` | UNVERIFIED (standard) |
| Order payments | `GET /pg/orders/{order_id}/payments` | UNVERIFIED (standard) |
| Refund | `POST /pg/orders/{order_id}/refunds` `{refund_amount, refund_id (3–40), refund_speed?: STANDARD\|INSTANT, refund_note?}`. Only within **6 months** of payment | VERIFIED |
| Refund status | `GET /pg/orders/{order_id}/refunds/{refund_id}` | UNVERIFIED (standard) |
| Subscriptions | `POST /pg/plans`, `POST /pg/subscriptions` (+ mandate APIs). Body differs across versions | PARTIAL |
| Settlements | "Get All Settlements"; `GET /pg/orders/{order_id}/settlements` | PARTIAL |
| Payouts | Separate product: `https://{sandbox\|api}.cashfree.com/payout` v2 | VERIFIED |

`customer_details.customer_phone` is mandatory.

## Checkout flow

1. Server: `POST /pg/orders` with `order_id = attemptRef`, `order_meta.return_url = https://yoursite/pay/return?order_id={order_id}`. Return `payment_session_id` to the client.
2. Client: `<script src="https://sdk.cashfree.com/js/v3/cashfree.js">` or npm `@cashfreepayments/cashfree-js`, then `Cashfree({ mode: "sandbox" | "production" }).checkout({ paymentSessionId, redirectTarget: "_self" | "_blank" | "_top" | "_modal" })`. PARTIAL https://www.cashfree.com/docs/open-checkoutx
3. Return URL carries only `order_id`, **no signature**. Server calls `GET /pg/orders/{order_id}` (and `/payments`), checks `order_status == "PAID"` and `order_amount` matches, then fulfils.
4. Webhook also drives fulfilment.

Your domain must be whitelisted in the Cashfree dashboard or checkout will not open.

## Webhook signature

`x-webhook-signature = base64(HMAC_SHA256(x-webhook-timestamp + rawBody, client_secret))`, **no separator**. The doc's pseudocode shows a `.` but its code samples do not; trust the code. VERIFIED https://www.cashfree.com/docs/payments/online/webhooks/signature-verification

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
export function verifyCashfreeWebhook(rawBody: string, timestamp: string, signature: string, clientSecret: string, maxAgeSec = 300) {
  const expected = createHmac('sha256', clientSecret).update(timestamp + rawBody).digest('base64');
  const ok = expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  // Replay window. Timestamp is ms in current docs; UNVERIFIED, so accept seconds too.
  const ts = Number(timestamp); const ms = ts > 1e12 ? ts : ts * 1000;
  return ok && Math.abs(Date.now() - ms) <= maxAgeSec * 1000;
}
```

Webhook events seen in Cashfree docs: `PAYMENT_SUCCESS_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK`, `PAYMENT_USER_DROPPED_WEBHOOK`, refund webhooks. UNVERIFIED names; check your dashboard. Dedupe on `cf_payment_id` + event type if no event id is provided.

## Status mapping

| Cashfree | Unified |
|---|---|
| order `ACTIVE` | `created` (or `pending` if a payment is in flight) |
| order `PAID` | `captured` |
| order `EXPIRED` | `expired` |
| order `TERMINATED` / `TERMINATION_REQUESTED` | `cancelled` UNVERIFIED |
| payment `SUCCESS` / `FAILED` / `PENDING` / `USER_DROPPED` / `CANCELLED` / `NOT_ATTEMPTED` | `captured` / `failed` / `pending` / `failed` / `cancelled` / `created` UNVERIFIED |
| refund `SUCCESS` / `PENDING` / `CANCELLED` / `ONHOLD` | `processed` / `pending` / `failed` / `pending` UNVERIFIED |

## Gotchas

- Sending paise (`49900`) charges Rs 49,900. The most expensive bug possible with this gateway.
- No signed return: always re-fetch.
- Domain whitelist for JS checkout, separate for sandbox and production.
- Refund window 6 months.
- Pin `x-api-version`; don't copy samples written for another version.

## Sandbox test data (UNVERIFIED in this research)

- Test UPI ids `testsuccess@gocash` / `testfailure@gocash`, plus test cards and netbanking: https://www.cashfree.com/docs/payments/online/resources/sandbox-environment (path may have moved; search "Cashfree test data").
- Sandbox keys: Merchant dashboard in Test mode > Developers > API Keys.

## Platforms

- Shopify: Cashfree advertises a no-code Shopify integration; only "Cashfree BNPL Plus" was seen in App Store results. PARTIAL https://www.cashfree.com/docs/help/payments/integrations/integrations
- WooCommerce: Cashfree publishes a WooCommerce plugin. UNVERIFIED listing.
- Mobile: Android/iOS/React Native/Flutter SDKs exist (cashfree.com docs). UNVERIFIED package names; the server still creates the order.
