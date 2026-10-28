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
| Refund | `POST /pg/orders/{order_id}/refunds` `{refund_amount, refund_id (3–40 **alphanumeric only**: `_` and `-` are rejected), refund_speed?: STANDARD\|INSTANT, refund_note?}`, header `x-idempotency-key` (UUID). Only within **6 months** of payment | VERIFIED |
| Refund status | `GET /pg/orders/{order_id}/refunds/{refund_id}` | UNVERIFIED (standard) |
| Subscriptions | `POST /pg/plans`, `POST /pg/subscriptions` (+ mandate APIs). Body differs across versions | PARTIAL |
| Settlements | "Get All Settlements" and "Get Settlements by Order ID" (path assumed `GET /pg/orders/{order_id}/settlements`) | UNVERIFIED path |
| Payouts | Separate product: base `/payout` confirmed; separate credentials likely but not confirmed | PARTIAL |

`customer_details.customer_phone` is mandatory. `customer_details.customer_id` is 3-50 **alphanumeric** characters (this project derives one from a hash of the phone if you pass none). `x-idempotency-key` must be a UUID: this project maps any other key deterministically to a UUID.

## Checkout flow

1. Server: `POST /pg/orders` with `order_id = attemptRef`, `order_meta.return_url = https://yoursite/pay/return?order_id={order_id}` (this project appends `order_id={order_id}` when the URL lacks it; the placeholder is documented only in Cashfree's migration guide). Return `payment_session_id` to the client.
2. Client: `<script src="https://sdk.cashfree.com/js/v3/cashfree.js">` or npm `@cashfreepayments/cashfree-js`, then `Cashfree({ mode: "sandbox" | "production" }).checkout({ paymentSessionId, redirectTarget: "_self" | "_blank" | "_top" | "_modal" })`. PARTIAL https://www.cashfree.com/docs/open-checkoutx
3. Return URL carries only `order_id`, **no signature**. Server calls `GET /pg/orders/{order_id}` (and `/payments`), checks `order_status == "PAID"` and `order_amount` matches, then fulfils.
4. Webhook also drives fulfilment.

Your domain must be whitelisted in the Cashfree dashboard or checkout will not open.

## Webhook signature

`x-webhook-signature = base64(HMAC_SHA256(x-webhook-timestamp + rawBody, client_secret))`, **no separator**. The doc's pseudocode shows a `.` but its code samples do not; trust the code. VERIFIED https://www.cashfree.com/docs/payments/online/webhooks/signature-verification

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
export function verifyCashfreeWebhook(rawBody: string, timestamp: string, signature: string, clientSecret: string) {
  const expected = createHmac('sha256', clientSecret).update(timestamp + rawBody).digest('base64');
  const ok = expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  // Cashfree documents no replay window and retries at 2/10/30 min, so a short window would reject
  // genuine retries. This project accepts up to 24 h old / 5 min in the future and dedupes on the event id.
  const ts = Number(timestamp); const ms = ts > 1e12 ? ts : ts * 1000;
  const age = Date.now() - ms;
  return ok && age <= 24 * 3600_000 && age >= -5 * 60_000;
}
```

Webhook events normalised by this project: `PAYMENT_SUCCESS_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK`, `PAYMENT_USER_DROPPED_WEBHOOK`, `REFUND_STATUS_WEBHOOK`, `AUTO_REFUND_STATUS_WEBHOOK` (refund object under `data.auto_refund`, not `data.refund`), `DISPUTE_CREATED` (dispute under `data.dispute`, order under `data.order_details`). `DISPUTE_UPDATED` / `DISPUTE_CLOSED` come through as type `unknown`. Dedupe on the `x-idempotency-header` value (webhook version 2025-01-01+); without it, on `cf_payment_id` + event type.

## Status mapping

| Cashfree | Unified |
|---|---|
| order `ACTIVE` | `created` (or `pending` if a payment is in flight) |
| order `PAID` | `captured` |
| order `EXPIRED` | `expired` |
| order `TERMINATED` / `TERMINATION_REQUESTED` | `cancelled` UNVERIFIED |
| payment `SUCCESS` / `FAILED` / `PENDING` / `USER_DROPPED` / `CANCELLED` / `NOT_ATTEMPTED` | `captured` / `failed` / `pending` / `failed` / `cancelled` / `created` UNVERIFIED |
| refund `SUCCESS` / `PENDING`, `ONHOLD`, `PENDING_APPROVAL` / `CANCELLED`, `REJECTED` | `processed` / `pending` / `failed` VERIFIED (documented enum) |
| payment_group `upi*` / `cardless_emi` / `*card*` | `upi` / `cardless_emi` / `card` |

## Gotchas

- Sending paise (`49900`) charges Rs 49,900. The most expensive bug possible with this gateway.
- No signed return: always re-fetch.
- Domain whitelist for JS checkout, separate for sandbox and production.
- Refund window 6 months. `refund_id` is alphanumeric only: a refundRef with `_` or `-` is rejected.
- Key-prefix checks (`TEST...`, `_test_`, `_prod_`) used by this project are a heuristic; Cashfree does not document key prefixes.
- Pin `x-api-version`; don't copy samples written for another version.

## Sandbox test data (UNVERIFIED in this research)

- Test UPI ids `testsuccess@gocash` / `testfailure@gocash`, plus test cards and netbanking: https://www.cashfree.com/docs/payments/online/resources/sandbox-environment (path may have moved; search "Cashfree test data").
- Sandbox keys: Merchant dashboard in Test mode > Developers > API Keys.

## Platforms

- Shopify: Cashfree advertises a no-code Shopify integration; only "Cashfree BNPL Plus" was seen in App Store results. PARTIAL https://www.cashfree.com/docs/help/payments/integrations/integrations
- WooCommerce: Cashfree publishes a WooCommerce plugin. UNVERIFIED listing.
- Mobile: Android/iOS/React Native/Flutter SDKs exist (cashfree.com docs). UNVERIFIED package names; the server still creates the order.
