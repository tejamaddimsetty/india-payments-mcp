# PhonePe Payment Gateway (Standard Checkout v2)

Docs: https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/
Status labels: VERIFIED / PARTIAL / UNVERIFIED.

## Auth and environments

- OAuth `client_credentials`:
  - sandbox `POST https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token`
  - prod `POST https://api.phonepe.com/apis/identity-manager/v1/oauth/token` (different host path from payments)
  - `application/x-www-form-urlencoded`: `client_id, client_version, client_secret, grant_type=client_credentials` → `{access_token, issued_at, expires_at (epoch s), token_type:"O-Bearer"}`. VERIFIED
- API calls: `Authorization: O-Bearer <access_token>`. Partners add `X-MERCHANT-ID`. VERIFIED
- API base: sandbox `https://api-preprod.phonepe.com/apis/pg-sandbox`, prod `https://api.phonepe.com/apis/pg`. VERIFIED
- Cache the token until `expires_at` minus a margin; refresh on 401. Use the `client_version` shown in your dashboard (or shared by PhonePe for sandbox); the docs do not fix a value.
- Webhook auth is separate: a username/password you set in the Business Dashboard (in sandbox, ask the PhonePe integration team).
- Env (this project): `PHONEPE_CLIENT_ID`, `PHONEPE_CLIENT_SECRET`, `PHONEPE_CLIENT_VERSION`, `PHONEPE_WEBHOOK_USERNAME`, `PHONEPE_WEBHOOK_PASSWORD`.

## Amounts

Integer paise, **min 100** (payments and refunds). VERIFIED

## Endpoints

| Purpose | Call | Status |
|---|---|---|
| Create payment | `POST /checkout/v2/pay` `{merchantOrderId (≤63, letters/digits/_/-), amount, expireAfter? (300–3600 s), paymentFlow:{type:"PG_CHECKOUT", merchantUrls:{redirectUrl}}, metaInfo?:{udf1..udf15}, prefillUserLoginDetails?:{phoneNumber}, disablePaymentRetry?}` → `{orderId, state:"PENDING", expireAt, redirectUrl}`. `metaInfo`: udf1..udf10 max 256 chars; udf11..udf15 max 50 chars of letters, digits and `_-+@.` (validated by this project) | VERIFIED |
| Order status | `GET /checkout/v2/order/{merchantOrderId}/status?details=false&errorContext=true` → `state` ∈ `PENDING\|COMPLETED\|FAILED`, `paymentDetails[]` | VERIFIED |
| Refund | `POST /payments/v2/refund` `{merchantRefundId (≤63), originalMerchantOrderId, amount}` → `state: PENDING`. That `merchantRefundId` de-duplicates retries is assumed, not documented | VERIFIED (call) / UNVERIFIED (de-dupe) |
| Refund status | `GET /payments/v2/refund/{merchantRefundId}/status` → `PENDING\|COMPLETED\|FAILED` (custom-checkout docs also list `CONFIRMED`) | VERIFIED |
| Autopay (UPI mandate, eNACH) | `/payment-gateway/autopay/` docs | PARTIAL |
| Payment links, settlements | doc sections exist | PARTIAL |

Use one `merchantOrderId` per attempt. Reuse behaviour is not documented; assume it is rejected. UNVERIFIED

## Checkout flow

1. Server: get token, `POST /checkout/v2/pay` with `merchantOrderId = attemptRef`, `redirectUrl = https://yoursite/pay/return?ref=<attemptRef>` (put the ref in the URL yourself: the redirect does not say which order it was).
2. Client: redirect to `redirectUrl`, or iframe: load the PhonePe checkout bundle from `mercury.phonepe.com` (staging `mercury-stg.phonepe.com`) and call `window.PhonePeCheckout.transact({ tokenUrl: redirectUrl, type: "IFRAME", callback })`. Exact script path not confirmed. PARTIAL
3. On return: the redirect is **unsigned**. Call Order Status, require `state == "COMPLETED"` and amount match, then fulfil.
4. Webhook drives fulfilment too, but see below: it is not a body signature.

## Webhook verification

SHA method (documented formula): header `Authorization` = `hex(sha256(username + ":" + password))`, 64-char hex, no prefix observed. PARTIAL (hex inferred from sample)

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
export function verifyPhonePeWebhookAuth(authHeader: string | undefined, username: string, password: string) {
  const expected = createHash('sha256').update(`${username}:${password}`).digest('hex');
  const got = (authHeader ?? '').trim().replace(/^SHA256\s+/i, '').toLowerCase();
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
// This only proves the sender knows a static shared secret. It does NOT authenticate the body.
// ALWAYS re-fetch GET /checkout/v2/order/{merchantOrderId}/status and act on that, never on the body.
```

HMAC method: the current webhook page also describes `x-phonepe-checksum-key-id` and `x-phonepe-checksum-signature`, but **algorithm and encoding are not stated**. Do not guess; use the SHA method + status re-fetch. PARTIAL/UNVERIFIED

Events: `checkout.order.completed`, `checkout.order.failed`, `pg.refund.completed`, `pg.refund.failed`. Body `{event, payload:{state, orderId, merchantOrderId | originalMerchantOrderId, amount, paymentDetails}}`. Use `event` (old `type` field is deprecated) and `payload.state`. VERIFIED. Some documented refund samples are flat (no `event`/`payload` wrapper, no merchantRefundId): read the top-level body and infer the event from `state`. Dedupe key: `event + merchantOrderId (+ merchantRefundId)`; no event id documented.

## Status mapping

| PhonePe `state` | Unified |
|---|---|
| `PENDING` | `pending` (this includes "created, customer has not paid") |
| `COMPLETED` | `captured` |
| `FAILED` | `failed` |
| order past `expireAt` while PENDING | treat as `expired` after a final status check |
| refund `PENDING`/`CONFIRMED` / `COMPLETED` / `FAILED` | `pending` / `processed` / `failed` |

## Gotchas

- Legacy v1 (`X-VERIFY = sha256hex(base64Payload + "/pg/v1/pay" + saltKey) + "###" + saltIndex`, merchant id + salt key) is deprecated. New code must use v2 OAuth. Many blog posts and StackOverflow answers still show v1.
- Token host differs from API host in production.
- `redirectUrl` landing with no params: carry your own ref in the URL.
- UPI-first: expect many `PENDING` results; poll status with backoff (e.g. 3s, 5s, 10s, 30s, then reconciliation job), never mark failed on a timeout.

## Sandbox test data (UNVERIFIED in this research)

- Sandbox credentials come from the PhonePe integration team / Business Dashboard test mode.
- PhonePe provides a test app / simulator flow for UPI and test cards in its "Test" section: https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/test-integration (path may differ).

## Platforms

- Shopify: official app "PhonePe Payment Gateway" https://apps.shopify.com/phonepe-payment-gateway (launched 2023-02-24); Settings → Payments → "PhonePe PG", link the MID. VERIFIED https://developer.phonepe.com/payment-gateway/e-commerce-plugins/shopify
- WooCommerce: https://wordpress.org/plugins/phonepe-payment-solutions/
- Mobile: Standard Checkout Android/iOS SDKs (developer.phonepe.com mobile-app-integration). Server still creates the order and confirms status.
