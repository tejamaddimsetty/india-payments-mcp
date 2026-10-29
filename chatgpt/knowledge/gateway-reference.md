# Indian payment gateways: combined reference

Generated from skills/india-payments/references/*.md. Do not edit here.

---

## Razorpay

Docs: https://razorpay.com/docs/api/ · Server integration: https://razorpay.com/docs/payments/server-integration/nodejs/integration-steps/
Status labels: VERIFIED = read on the official page; PARTIAL = partly confirmed; UNVERIFIED = not confirmed from an official source, test in sandbox.

### Auth and environments

- Base URL `https://api.razorpay.com/v1` for both test and live. Mode is decided by the key pair: `rzp_test_…` vs `rzp_live_…`. VERIFIED
- HTTP Basic `key_id:key_secret`. Partner (platform) calls add `X-Razorpay-Account: <merchant account id>`. VERIFIED
- Secrets: `key_secret` (API + payment signature) and a **separate** per-webhook secret you type in Dashboard > Webhooks. They are not the same value. VERIFIED
- Env (this project): `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_MERCHANT_NAME` (optional: the Checkout option `name`, which Razorpay marks mandatory; falls back to "Payment").

### Amounts

Integer paise (smallest subunit): Rs 299 = `29900`. Min 100 paise. Zero-decimal (JPY) and 3-decimal (KWD) currencies differ if international is enabled. VERIFIED

### Endpoints

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

### Checkout flow (Standard Checkout)

1. Server: compute amount, `POST /v1/orders` with `receipt = attemptRef`. Store `order_id` on the attempt.
2. Client: load `https://checkout.razorpay.com/v1/checkout.js`, `new Razorpay({ key: KEY_ID, order_id, amount, currency, name, prefill, handler }).open()`. `name` (your business name) is mandatory. VERIFIED
3. `handler` receives `{razorpay_payment_id, razorpay_order_id, razorpay_signature}`. POST them to your server.
4. Server verifies the signature using the **order_id from your DB**, not from the payload ("Do not use the `razorpay_order_id` returned by Checkout"), then marks paid (idempotently). With this SDK/MCP pass `providerOrderId` (MCP: `provider_order_id`) = the stored `order_…` / `sub_…` id, plus `orderRef` and `expectedAmount`. Without `providerOrderId` or `orderRef` the callback is rejected.
5. Webhook `payment.captured` / `order.paid` also marks paid. Whichever arrives first wins; the other is a no-op.

### Signatures

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

### Status mapping

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

### Gotchas

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

### Sandbox test data (UNVERIFIED in this research: re-check the official pages)

- Test UPI ids: `success@razorpay` (succeeds), `failure@razorpay` (fails). https://razorpay.com/docs/payments/payments/test-upi-details/
- Test cards (any future expiry, any CVV): see https://razorpay.com/docs/payments/payments/test-card-details/ (Indian domestic test cards are listed there; old `4111 1111 1111 1111` may be treated as international).
- Netbanking in test mode shows a bank simulator page with Success/Failure buttons.
- Dashboard webhook "Test" sends sample events; you can also point webhooks at a tunnel.

### Platforms

- Shopify: official app "All-in-one Razorpay Payment Gateway". Install from the App Store, connect as account owner, no API keys. Stores integrated before 28 Apr 2022 must migrate. VERIFIED https://razorpay.com/docs/payments/payment-gateway/ecommerce-plugins/shopify/
- WooCommerce: https://wordpress.org/plugins/woo-razorpay/
- Mobile SDKs: Android/iOS (razorpay.com docs), `react-native-razorpay`, `razorpay_flutter`. The app still gets `order_id` from your server and posts the result back for verification.

---

## PayU India

Docs: https://docs.payu.in · Hash: https://docs.payu.in/docs/generate-hash-payu-hosted · Environments: https://docs.payu.in/docs/payu-india-api-environment
Status labels: VERIFIED / PARTIAL / UNVERIFIED (test in sandbox).

### Auth and environments

- No API auth header. You hold a merchant `key` and a `salt`; every request carries a SHA-512 `hash` that includes the salt. The salt never leaves the server.
- Hosted checkout (form POST): test `https://test.payu.in/_payment`, prod `https://secure.payu.in/_payment`. PARTIAL
- Server APIs ("postservice"): test `https://test.payu.in/merchant/postservice.php?form=2`, prod `https://info.payu.in/merchant/postservice.php?form=2`. Some samples omit `.php`. `application/x-www-form-urlencoded` with `key, command, var1..varN, hash`. VERIFIED https://docs.payu.in/reference/verify_payment_api

### Amounts

Rupee decimal **string**, e.g. `"499.00"`. The exact same string must appear in the form and in the hash. Format from paise with integer math; never `String(4.99*100)`. PARTIAL

### Checkout flow (hosted, form POST)

1. Server: create attempt, `txnid = attemptRef` (unique per attempt, **max 25 chars**). Build fields `key, txnid, amount, productinfo, firstname, email, phone, surl, furl, udf1..udf5, hash`. Limits (enforced by this project): productinfo 100, firstname 60, email 50, udf1..udf5 255. The docs also list 50 for surl/furl; that looks stale, so this project only logs a warning. VERIFIED https://docs.payu.in (additional parameters)
2. Client: render an auto-submitting `<form method="POST" action="https://…/_payment">` with those fields. Nothing secret is in the form; the hash is.
3. PayU POSTs back (form-urlencoded) to `surl` or `furl`. That route is a server POST endpoint, not a SPA page. Exempt it from CSRF.
4. Server: verify the reverse hash, check `txnid` and `amount` match the stored attempt, then call `verify_payment` before fulfilling (PayU recommends this).
5. Webhook (dashboard-configured) also carries the reverse hash; process idempotently.

### Hashes

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
const sha512 = (s: string) => createHash('sha512').update(s).digest('hex'); // lowercase hex
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Request: key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT   VERIFIED
// Always keep all 5 udf slots (empty allowed), then 5 more empty fields, then SALT.
export function requestHash(f: Record<string, string>, salt: string) {
  const u = (k: string) => f[k] ?? '';
  return sha512([f.key, f.txnid, f.amount, f.productinfo, f.firstname, f.email,
    u('udf1'), u('udf2'), u('udf3'), u('udf4'), u('udf5'), '', '', '', '', '', salt].join('|'));
}

// Response (reverse): SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key   VERIFIED
// If the response has additional_charges, PREFIX "additional_charges|" before SALT.            VERIFIED
// The webhook field table spells it additionalCharges: accept both.
export function verifyResponse(r: Record<string, string>, salt: string) {
  const u = (k: string) => r[k] ?? '';
  let s = [salt, r.status, '', '', '', '', '', u('udf5'), u('udf4'), u('udf3'), u('udf2'), u('udf1'),
    r.email, r.firstname, r.productinfo, r.amount, r.txnid, r.key].join('|');
  const addl = r.additional_charges ?? r.additionalCharges;
  if (addl) s = `${addl}|${s}`;
  return eq(sha512(s), (r.hash ?? '').toLowerCase());
}

// Postservice: sha512(key|command|var1|SALT). ONLY var1 is hashed, even for refunds.   VERIFIED
export const postserviceHash = (key: string, command: string, var1: string, salt: string) =>
  sha512(`${key}|${command}|${var1}|${salt}`);
```

With split payments the response hash uses `status|splitInfo||||||` instead of `status||||||`. VERIFIED. With `api_version=19` the request hash adds udf6–10 and more fields; see the hash page. VERIFIED

### Server APIs

| Purpose | command | vars | Status |
|---|---|---|---|
| Verify / status | `verify_payment` | `var1=txnid` (pipe-separate several) → `{status:1\|0, msg, transaction_details:{<txnid>:{mihpayid, status, bank_ref_num, amt, mode, …}}}`; missing → `"Not Found"` | VERIFIED |
| Refund | `cancel_refund_transaction` | `var1=mihpayid` (PayU id, **not** txnid), `var2=token_id` (your unique refund id, **max 23 chars**), `var3=amount`. Cancels if `auth` (the id then comes back as `txn_update_id`), refunds if `captured` (`request_id`). Omitting the amount refunds the ORIGINAL amount: after a partial refund always pass the remaining amount | VERIFIED https://docs.payu.in/docs/refund-transaction-api |
| Refund status | `check_action_status`, `var1=request_id`. Two documented response shapes: nested `transaction_details.{request_id}.{request_id}.{status, amt}` and flat `{refund_status, refund_amount}`. `QUEUED` / `REQUESTED` / `IN PROGRESS` / `processing` / `od_hit` = pending. The sample curl says `check_action_status_txnid`; confirm in sandbox | VERIFIED (docs + official PHP SDK `checkRefundStatus`) |

### Status mapping

| PayU `status` | Unified |
|---|---|
| `success` (and `unmappedstatus: captured`) | `captured` |
| `pending` | `pending` |
| `failure` | `failed` |
| `auth` (unmappedstatus) | `authorized` |
| `userCancelled`/`dropped`/`bounced` (unmappedstatus) | `failed` or `cancelled` UNVERIFIED |

### Gotchas

- `token_id` for refunds is max 23 chars. A 40-char refundRef will be rejected: derive a shorter id (and store the mapping).
- Amount string mismatch (`"499"` vs `"499.00"`) breaks the hash silently.
- Reverse-hash field order is the reverse of the request and the 5 empties sit right after `status`, not after `udf5`.
- surl/furl receive a cross-site POST: SameSite=Lax session cookies are not sent. Look the attempt up by `txnid`, not by session.
- Webhook body format: docs disagree (JSON vs form-urlencoded). Accept both and verify the same reverse hash. PARTIAL. This project parses payment webhooks only; poll refund status instead of relying on refund webhooks.
- `txnid` max 25 chars; nothing in the key tells test from live, so make sure `PAYMENTS_MODE` matches the key.
- PayU rejects a reused refund token (error 106 "Token already exists") instead of returning the earlier refund, and has no lookup by token: the earlier refund most likely exists. This project reports error 106 as `OUTCOME_UNKNOWN`. After `OUTCOME_UNKNOWN`, find the earlier refund's `request_id` (dashboard or logs) and check it with refund status; never retry with a new refundRef until you know the first one failed. error_code 102 (queued) counts as accepted.
- `unmappedstatus` is not covered by the response hash: this project lets it only downgrade the hashed `status` (to `authorized` / `cancelled`). On auth-and-capture accounts, confirm with `verify_payment` before fulfilling. `authorized` is never `paid` here.
- Test-mode webhooks fire only for test transactions.
- Subscriptions: Standing Instructions (`si=1`, `si_details`) and mandate APIs exist. UNVERIFIED

### Sandbox test data (UNVERIFIED in this research)

- Test credentials (key/salt) come from the PayU dashboard in test mode. https://docs.payu.in/docs/test-cards-upi-id-and-wallets
- Test cards, test UPI ids and wallets are listed at the URL above; check it rather than trusting remembered numbers.

### Platforms

- Shopify: official apps "1PayU (Cards, UPI, NB, Wallet)" https://apps.shopify.com/payu-india and "Onsite Card Payments by PayU India"; configured with merchant key and salt. VERIFIED https://docs.payu.in/docs/install-payu-plugin
- WooCommerce: PayU publishes a WooCommerce plugin (search "PayU India" on wordpress.org). UNVERIFIED listing name.

---

## Cashfree Payments (PG)

Docs: https://www.cashfree.com/docs/api-reference/payments/latest/orders/create
Status labels: VERIFIED / PARTIAL / UNVERIFIED (test in sandbox).

### Auth and environments

- Base: sandbox `https://sandbox.cashfree.com/pg`, prod `https://api.cashfree.com/pg`. VERIFIED
- Headers on every call: `x-client-id`, `x-client-secret`, `x-api-version`. Latest version is `2026-01-01`; `2023-08-01` and `2025-01-01` are still documented. **Pin one** because response shapes change by version. Optional `x-request-id`, `x-idempotency-key` (UUID). Partners: `x-partner-apikey` + `x-partner-merchantid`. VERIFIED
- The client secret is used for the API **and** for webhook signatures. Rotating it changes both.
- Env (this project): `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`.

### Amounts

**Rupees as a JSON number**, up to 2 decimals (`10.15`). Min 1. **Not paise.** Convert at the adapter edge: `Number((paise / 100).toFixed(2))` on an integer paise value. VERIFIED

### Endpoints

| Purpose | Call | Status |
|---|---|---|
| Create order | `POST /pg/orders` `{order_id (3–45, [A-Za-z0-9_-]), order_amount, order_currency, customer_details:{customer_id, customer_phone, customer_email?, customer_name?}, order_meta?:{return_url, notify_url, payment_methods}, order_expiry_time?, order_note?, order_tags?}` → `{cf_order_id, order_id, order_status, payment_session_id}` | VERIFIED |
| Order | `GET /pg/orders/{order_id}` | UNVERIFIED (standard) |
| Order payments | `GET /pg/orders/{order_id}/payments` | UNVERIFIED (standard) |
| Refund | `POST /pg/orders/{order_id}/refunds` `{refund_amount, refund_id (3–40 chars of letters, digits, `_` and `-`, as in Cashfree's examples), refund_speed?: STANDARD\|INSTANT, refund_note?}`, header `x-idempotency-key` (UUID). Only within **6 months** of payment | VERIFIED |
| Refund status | `GET /pg/orders/{order_id}/refunds/{refund_id}` | UNVERIFIED (standard) |
| Subscriptions | `POST /pg/plans`, `POST /pg/subscriptions` (+ mandate APIs). Body differs across versions | PARTIAL |
| Settlements | "Get All Settlements" and "Get Settlements by Order ID" (path assumed `GET /pg/orders/{order_id}/settlements`) | UNVERIFIED path |
| Payouts | Separate product: base `/payout` confirmed; separate credentials likely but not confirmed | PARTIAL |

`customer_details.customer_phone` is mandatory. `customer_details.customer_id` is 3-50 **alphanumeric** characters (this project derives one from a hash of the phone if you pass none). `x-idempotency-key` must be a UUID: this project maps any other key deterministically to a UUID.

### Checkout flow

1. Server: `POST /pg/orders` with `order_id = attemptRef`, `order_meta.return_url = https://yoursite/pay/return?order_id={order_id}` (this project appends `order_id={order_id}` when the URL lacks it; the placeholder is documented only in Cashfree's migration guide). Return `payment_session_id` to the client.
2. Client: `<script src="https://sdk.cashfree.com/js/v3/cashfree.js">` or npm `@cashfreepayments/cashfree-js`, then `Cashfree({ mode: "sandbox" | "production" }).checkout({ paymentSessionId, redirectTarget: "_self" | "_blank" | "_top" | "_modal" })`. PARTIAL https://www.cashfree.com/docs/open-checkoutx
3. Return URL carries only `order_id`, **no signature**. Server calls `GET /pg/orders/{order_id}` (and `/payments`), checks `order_status == "PAID"` and `order_amount` matches, then fulfils.
4. Webhook also drives fulfilment.

Your domain must be whitelisted in the Cashfree dashboard or checkout will not open.

### Webhook signature

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

### Status mapping

| Cashfree | Unified |
|---|---|
| order `ACTIVE` | `created` (or `pending` if a payment is in flight) |
| order `PAID` | `captured`; this project reads Get All Refunds for the order (`GET /pg/orders/{order_id}/refunds`) and reports `refunded` / `partially_refunded` when successful refunds cover all / part of it (a refunded order stays `PAID` on Cashfree) |
| order `EXPIRED` | `expired` |
| order `TERMINATED` / `TERMINATION_REQUESTED` | `cancelled` UNVERIFIED |
| payment `SUCCESS` / `FAILED` / `PENDING` / `USER_DROPPED` / `CANCELLED` / `NOT_ATTEMPTED` | `captured` / `failed` / `pending` / `failed` / `cancelled` / `created` UNVERIFIED |
| refund `SUCCESS` / `PENDING`, `ONHOLD`, `PENDING_APPROVAL` / `CANCELLED`, `REJECTED` | `processed` / `pending` / `failed` VERIFIED (documented enum) |
| payment_group `upi*` / `cardless_emi` / `*card*` | `upi` / `cardless_emi` / `card` |

### Gotchas

- Sending paise (`49900`) charges Rs 49,900. The most expensive bug possible with this gateway.
- No signed return: always re-fetch.
- Domain whitelist for JS checkout, separate for sandbox and production.
- Refund window 6 months. `refund_id` (our refundRef) is 3-40 chars of letters, digits, `_` and `-`, validated before the call.
- Key-prefix checks (`TEST...`, `_test_`, `_prod_`) used by this project are a heuristic; Cashfree does not document key prefixes.
- Pin `x-api-version`; don't copy samples written for another version.
- This project refuses `order_meta` (return/notify URLs) and `order_splits` in `providerOptions`: set URLs through `returnUrl` / `notifyUrl`.

### Sandbox test data (UNVERIFIED in this research)

- Test UPI ids `testsuccess@gocash` / `testfailure@gocash`, plus test cards and netbanking: https://www.cashfree.com/docs/payments/online/resources/sandbox-environment (path may have moved; search "Cashfree test data").
- Sandbox keys: Merchant dashboard in Test mode > Developers > API Keys.

### Platforms

- Shopify: Cashfree advertises a no-code Shopify integration; only "Cashfree BNPL Plus" was seen in App Store results. PARTIAL https://www.cashfree.com/docs/help/payments/integrations/integrations
- WooCommerce: Cashfree publishes a WooCommerce plugin. UNVERIFIED listing.
- Mobile: Android/iOS/React Native/Flutter SDKs exist (cashfree.com docs). UNVERIFIED package names; the server still creates the order.

---

## CCAvenue

There are **no public official API docs.** CCAvenue ships the integration kit and API PDFs inside the merchant dashboard (M.A.R.S.). Most facts below are UNVERIFIED: they match the PHP/Node/Java kits in circulation and third-party copies of the API PDF. Get the kit for **your** account from the dashboard and diff it against this file before shipping.

### Credentials and environment

- `merchant_id`, `access_code`, `working_key` (the AES secret). Dashboard > Settings > API Keys. UNVERIFIED path
- Env (this project): `CCAVENUE_MERCHANT_ID`, `CCAVENUE_ACCESS_CODE`, `CCAVENUE_WORKING_KEY`, `CCAVENUE_ENCRYPTION` (optional: `cbc` default, or `gcm`; see Encryption).
- Test and live use different hosts AND different credentials.
- **IP whitelisting:** the server's public egress IP must be registered with CCAvenue before server API calls work. Serverless/auto-scaling hosts with changing IPs need a NAT gateway / static egress. Source: merchant setup guides, not CCAvenue itself. PARTIAL. Error codes such as `enc_error_code` are passed through unmapped.
- The `access_code` is tied to the registered domain/URL; a mismatch fails checkout. UNVERIFIED

### Amounts

Rupee decimal, Numeric(12,2): `"499.00"`. PARTIAL

### Checkout flow (form POST, encrypted)

1. Server builds a plaintext query string: `merchant_id, order_id, currency=INR, amount, redirect_url, cancel_url, language=EN, billing_name, billing_email, billing_tel, …, merchant_param1..5`. UNVERIFIED
2. Encrypt it → `encRequest` (hex). Render an auto-submitting form with fields `encRequest`, `access_code` to:
   - cbc kit: test `https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction`, prod `https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction`
   - gcm kit: prod `https://secure.ccavenue.com/gTransaction.do?command=initiateTransaction` (from the official NodeJS kit, via mirrors), test `https://test.ccavenue.com/gTransaction.do?command=initiateTransaction` (third-party source)
   UNVERIFIED against an official public page.
   `billing_country` is a country name (`India`, as in the kit sample); this project maps ISO alpha-2 codes to names.
3. CCAvenue POSTs `encResp` (+ `orderNo`) to `redirect_url`. Decrypt → query string with `order_id, tracking_id, bank_ref_no, order_status (Success|Failure|Aborted|Invalid), amount, currency, payment_mode, …`. UNVERIFIED
4. With the cbc kit, decryption succeeding is the only integrity check and it is NOT authentication (AES-CBC has no MAC; blocks can be spliced or bit-flipped). The gcm kit's auth tag does authenticate. Either way **confirm with `orderStatusTracker` before fulfilling** and check amount + order_id. `PaymentsClient.verifyPayment` does this automatically.

### Encryption: two kits

CCAvenue's current NodeJS kit ships both an AES-128 and an AES-256 folder. Set `CCAVENUE_ENCRYPTION` to the kit CCAvenue assigned your account; how accounts are assigned is not documented, so ask CCAvenue before going live.

- **cbc** (default, classic kit): AES-128-CBC, key = raw 16-byte `md5(working_key)`, IV = bytes `0x00..0x0f`, PKCS#7, ciphertext hex. UNVERIFIED officially (kits agree).
- **gcm** (AES-256 kit): AES-256-GCM, key = the 32-character working key used directly (no MD5), random 12-byte IV, output `hex(iv) + hex(ciphertext || 16-byte tag)`. From the kit's `ccavutil.js` (third-party mirrors of the official download). Whether the DoWebTrans server API also uses GCM for these accounts is UNVERIFIED (one third-party implementation does; this project does too).

cbc snippet:

```ts
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
const IV = Buffer.from([...Array(16).keys()]); // 0x00..0x0f
const key = (workingKey: string) => createHash('md5').update(workingKey).digest(); // 16 raw bytes

export function ccavEncrypt(plain: string, workingKey: string) {
  const c = createCipheriv('aes-128-cbc', key(workingKey), IV);
  return Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('hex');
}
export function ccavDecrypt(hex: string, workingKey: string) {
  const d = createDecipheriv('aes-128-cbc', key(workingKey), IV);
  return Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8'); // throws on wrong key/tamper (padding)
}
// const resp = Object.fromEntries(new URLSearchParams(ccavDecrypt(body.encResp, WORKING_KEY)));
```

### Server API

- POST form to prod `https://api.ccavenue.com/apis/servlet/DoWebTrans`, staging `https://apitest.ccavenue.com/apis/servlet/DoWebTrans`. Params `enc_request, access_code, command, request_type (JSON|XML|STRING), response_type, version`. PARTIAL
- `version`: this project sends `1.2` for `orderStatusTracker` (third-party implementations use 1.2 and 1.1) and `1.1` for `refundOrder` (every implementation found uses 1.1). UNVERIFIED
- Response: `status=0` + `enc_response` (decrypt with the same scheme); `status=1` = failure with message. UNVERIFIED

| Purpose | command | encrypted JSON | Status |
|---|---|---|---|
| Status | `orderStatusTracker` | `{order_no, reference_no}` (Meta guide shows `orderNo`/`referenceNo`) | UNVERIFIED |
| Refund | `refundOrder` | `{reference_no, refund_amount, refund_ref_no}` (`reference_no` = CCAvenue `tracking_id`). A repeated `refund_ref_no` is rejected, not de-duplicated; staging reportedly accepts one refund per order. No lookup by `refund_ref_no` exists, so after a timeout or a duplicate rejection check the order in the dashboard before retrying with a new ref | UNVERIFIED |
| Refund details | `getRefundDetails` | `{reference_no}` → `refund_list[]` with `refund_status` `TS-REFA`/`TS-REFC`/`TS-REFF`/`TS-REFD` (Odoo). Not implemented in this project | UNVERIFIED |

### Status mapping

| CCAvenue `order_status` | Unified |
|---|---|
| `Success` / `Shipped` | `captured` |
| `Failure` / `Unsuccessful` | `failed` |
| `Aborted` | `cancelled` |
| `Invalid` | `failed` |
| `Initiated` / `Awaited` | `pending` |
| `Refunded` / `Partially Refunded` (status API) | `refunded` / `partially_refunded` UNVERIFIED |

### Webhooks

Dashboard-configured "Dynamic Event Notification" (DEN, HTTP POST). Events: Order Status, Order Refund Status, Order Risk Status (official DEN page). Payload format and any signature are **not documented publicly**. This project parses only Order Status events sent as an `encResp` form body, marks them `bodyAuthenticated: false`, and `createWebhookHandler` re-confirms them with `orderStatusTracker`. Do the same: treat a DEN only as a trigger. UNVERIFIED

### Gotchas

- IP whitelist is the number-one go-live blocker (Vercel/Netlify/Lambda egress is not static).
- `redirect_url` receives a cross-site POST: SameSite cookies are missing; look up by `order_id`.
- Never use the decrypted `amount` alone to fulfil; compare to your stored amount and re-check via status API.
- Subscriptions (SI), settlements and payouts are reportedly in the API PDF. Not verifiable publicly.

### Sandbox test data

Test cards/netbanking are provided in the CCAvenue dashboard and kit docs. No public official URL found. UNVERIFIED

### Platforms

- Shopify: long listed as a provider in Shopify admin; no current App Store listing confirmed. UNVERIFIED
- WooCommerce/Magento/OpenCart: CCAvenue distributes plugins from the dashboard/its site. UNVERIFIED

---

## Paytm Payment Gateway

Docs moved to **https://paytmpayments.com/docs** and the hosts were rebranded. Status labels: VERIFIED / PARTIAL / UNVERIFIED.

### Hosts (keep configurable)

| Use | Staging | Production | Status |
|---|---|---|---|
| Initiate + JS checkout | `https://securestage.paytmpayments.com` | `https://secure.paytmpayments.com` | VERIFIED |
| Order status (`/v3/order/status`) | `https://securestage.paytmpayments.com` | `https://secure.paytmpayments.com` | VERIFIED (the `.in` staging host returned 503 for this route) |
| Refund apply + refund status | `https://securegw-stage.paytmpayments.in` | `https://securegw.paytmpayments.in` | VERIFIED in docs; production not exercised, confirm in sandbox |
| Legacy | `securegw-stage.paytm.in` | `securegw.paytm.in` | appears only in legacy docs |

Do not hard-code the legacy hosts. Test both staging hosts if one fails.

### Credentials

`MID`, merchant key (exactly **16 bytes**, used as the AES key), `websiteName` (`WEBSTAGING` in staging, `DEFAULT` in prod, or what the dashboard shows). VERIFIED
Env (this project): `PAYTM_MID`, `PAYTM_MERCHANT_KEY`, `PAYTM_WEBSITE` (optional; defaults WEBSTAGING / DEFAULT), `PAYTM_VERIFY_RESPONSE_SIGNATURE` (optional, default `true`; `false` skips the `head.signature` check on API responses only, never on webhooks: use it only if valid responses are rejected).

### Amounts

Rupee **string**, max 2 decimals, in `txnAmount.value` (`"499.00"`). VERIFIED

### Checkout flow (JS Checkout)

1. Server: `POST {host}/theia/api/v1/initiateTransaction?mid={MID}&orderId={ORDER}` with
   `{head:{signature, channelId?:"WEB"|"WAP"}, body:{requestType:"Payment", mid, websiteName, orderId (≤50; letters, digits and `@ - _ .` only), callbackUrl?, txnAmount:{value:"499.00", currency:"INR"}, userInfo:{custId, mobile?}}}`. `custId` allows only letters, digits and `@ ! = _ $ .` (this project replaces other characters with `_`).
   `head.signature` = checksum of `JSON.stringify(body)`. Response: `body.resultInfo.resultStatus` `S|F|U` and `body.txnToken` (**valid 15 minutes**). Verify the response `head.signature`. VERIFIED https://paytmpayments.com/docs/api/initiate-transaction-api
2. Client: `<script src="{host}/merchantpgpui/checkoutjs/merchants/{MID}.js">`, then
   `window.Paytm.CheckoutJS.init({root:"", flow:"DEFAULT", data:{orderId, token, tokenType:"TXN_TOKEN", amount}, handler:{notifyMerchant}}).then(() => window.Paytm.CheckoutJS.invoke())`. VERIFIED https://paytmpayments.com/docs/jscheckout-invoke-payment
3. Paytm POSTs **form key-value pairs** to `callbackUrl`: `ORDERID, MID, TXNID, TXNAMOUNT, STATUS (TXN_SUCCESS|TXN_FAILURE|PENDING), RESPCODE, RESPMSG, BANKTXNID, CHECKSUMHASH, …`. Verify CHECKSUMHASH, check ORDERID/TXNAMOUNT, then confirm with the status API. VERIFIED https://paytmpayments.com/docs/payment-status
4. The dashboard webhook URL receives the same form payload for payments. Same verification.
5. Refund notifications (Accept Refund / Success Refund) are JSON `{head:{signature}, body:{orderId, txnId, refId, refundId, refundAmount, totalRefundAmount, status:"SUCCESS"|"FAILED"}}`, signature over the `body` JSON. This project always verifies them. Success Refund (credit to the customer initiated) → `refund.processed`; Accept Refund SUCCESS → type `unknown` (accepted, not yet initiated); Accept Refund FAILED (signed) → `refund.failed`. The unsigned Success Refund FAILED sample is rejected: poll refund status for those failures. VERIFIED (shape); signed-string convention PARTIAL

### Checksum algorithm

From the vendor's `paytm/Paytm_Node_Checksum` source. VERIFIED https://github.com/paytm/Paytm_Node_Checksum/blob/master/PaytmChecksum.js

- AES-128-CBC, IV = literal `"@@@@&&&&####$$$$"`, key = merchant key as-is (16 bytes).
- salt = base64 of 3 random bytes (4 chars). `hash = sha256hex(params + "|" + salt) + salt`; `signature = base64(AES(hash))`.
- params string: for JSON APIs, `JSON.stringify(body)`; for form callbacks, values sorted by key, joined with `|`, null → `""`, after removing `CHECKSUMHASH`.

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
const IV = Buffer.from('@@@@&&&&####$$$$');
const enc = (s: string, k: string) => { const c = createCipheriv('aes-128-cbc', Buffer.from(k), IV); return c.update(s, 'utf8', 'base64') + c.final('base64'); };
const dec = (s: string, k: string) => { const d = createDecipheriv('aes-128-cbc', Buffer.from(k), IV); return d.update(s, 'base64', 'utf8') + d.final('utf8'); };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export const paramsString = (p: Record<string, string | null | undefined>) =>
  Object.keys(p).sort().map((k) => (p[k] == null || p[k] === 'null' ? '' : String(p[k]))).join('|');

export function generateSignature(params: string, merchantKey: string) {
  const salt = randomBytes(3).toString('base64'); // 4 chars
  return enc(sha(`${params}|${salt}`) + salt, merchantKey);
}
export function verifySignature(params: string, merchantKey: string, checksum: string) {
  let plain: string;
  try { plain = dec(checksum, merchantKey); } catch { return false; }
  const salt = plain.slice(-4);
  const expected = sha(`${params}|${salt}`) + salt;
  return expected.length === plain.length && timingSafeEqual(Buffer.from(expected), Buffer.from(plain));
}
// JSON API:  head.signature = generateSignature(JSON.stringify(body), KEY)
// Callback:  const { CHECKSUMHASH, ...rest } = form; verifySignature(paramsString(rest), KEY, CHECKSUMHASH)
```

Note: the vendor library's object form skips the `CHECKSUMHASH` key and treats the literal string `"null"` as empty; mirror that exactly.

### Server APIs

| Purpose | Call | Status |
|---|---|---|
| Status | `POST https://secure(stage).paytmpayments.com/v3/order/status` `{head:{signature}, body:{mid, orderId, txnType?}}` → `resultStatus` ∈ `TXN_SUCCESS\|TXN_FAILURE\|PENDING\|NO_RECORD_FOUND`. resultCode 501 = server down (retry), 334 = invalid order id, 335 = invalid MID: these are errors, not a failed payment | VERIFIED https://paytmpayments.com/docs/api/v3/transaction-status-api |
| Refund | `POST https://securegw(-stage).paytmpayments.in/refund/apply` `{mid, orderId, refId (unique, ≤50), txnId (Paytm TXNID), txnType:"REFUND", refundAmount, preferredDestination?:"TO_INSTANT", comments?}`. A duplicate refId is rejected (617 / 671 / 626 / 629), not replayed: this project then returns the existing refund via refund status | VERIFIED https://paytmpayments.com/docs/refund-api/ |
| Refund status | `POST https://securegw(-stage).paytmpayments.in/v2/refund/status` `{mid, orderId, refId}`. 631 = record not found, 335 / 600 / 330 = request errors (not a failed refund) | VERIFIED |

JSON API responses carry `head.signature` over the raw `body` bytes: verify it when present (this project does; unsigned error responses are accepted on TLS alone). Business errors come back as HTTP 200 with `resultInfo.resultStatus` `F` / `TXN_FAILURE`: check `resultInfo`, not the HTTP status.

### Status mapping

| Paytm | Unified |
|---|---|
| `TXN_SUCCESS` | `captured` |
| `TXN_FAILURE` | `failed` |
| `PENDING` | `pending` |
| `NO_RECORD_FOUND` | `created` (or `unknown` if you expected a txn) |
| refund `TXN_SUCCESS` / `PENDING` / `TXN_FAILURE` | `processed` / `pending` / `failed` UNVERIFIED |
| `PAYMENTMODE` `CC`/`DC` / `NB` / `PPI` / `PAYTMCC` / `UPI` | `card` / `netbanking` / `wallet` / `paylater` / `upi` |

### Gotchas

- `txnToken` expires in 15 minutes: create it when the user clicks Pay, not on page load.
- `orderId` must be unique per attempt; ≤50 chars.
- Merchant key must be exactly 16 bytes or AES throws.
- `callbackUrl` gets a cross-site form POST; no session cookies. Exempt from CSRF; look up by ORDERID.
- `clientId` appears in callbacks if you have multiple keys.
- Subscriptions and settlement APIs exist in the docs nav; not verified here. Payouts are a separate product.

### Sandbox test data (UNVERIFIED in this research)

- Staging credentials and test wallet/cards: https://paytmpayments.com/docs/test-instruments (path may differ; find "Test Instruments" in the docs nav).

### Platforms

- Shopify: no official Paytm Shopify app found; Paytm wallet is reachable through other gateways (Razorpay, Cashfree). UNVERIFIED (absence)
- WooCommerce: Paytm publishes a WooCommerce plugin. UNVERIFIED listing.
- Mobile: Paytm "All-in-One SDK" for Android/iOS (invokes the Paytm app). UNVERIFIED details.

---

## PhonePe Payment Gateway (Standard Checkout v2)

Docs: https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/
Status labels: VERIFIED / PARTIAL / UNVERIFIED.

### Auth and environments

- OAuth `client_credentials`:
  - sandbox `POST https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token`
  - prod `POST https://api.phonepe.com/apis/identity-manager/v1/oauth/token` (different host path from payments)
  - `application/x-www-form-urlencoded`: `client_id, client_version, client_secret, grant_type=client_credentials` → `{access_token, issued_at, expires_at (epoch s), token_type:"O-Bearer"}`. VERIFIED
- API calls: `Authorization: O-Bearer <access_token>`. Partners add `X-MERCHANT-ID`. VERIFIED
- API base: sandbox `https://api-preprod.phonepe.com/apis/pg-sandbox`, prod `https://api.phonepe.com/apis/pg`. VERIFIED
- Cache the token until `expires_at` minus a margin; refresh on 401. Use the `client_version` shown in your dashboard (or shared by PhonePe for sandbox); the docs do not fix a value.
- Webhook auth is separate: a username/password you set in the Business Dashboard (in sandbox, ask the PhonePe integration team).
- Env (this project): `PHONEPE_CLIENT_ID`, `PHONEPE_CLIENT_SECRET`, `PHONEPE_CLIENT_VERSION`, `PHONEPE_WEBHOOK_USERNAME`, `PHONEPE_WEBHOOK_PASSWORD`.

### Amounts

Integer paise, **min 100** (payments and refunds). VERIFIED

### Endpoints

| Purpose | Call | Status |
|---|---|---|
| Create payment | `POST /checkout/v2/pay` `{merchantOrderId (≤63, letters/digits/_/-), amount, expireAfter? (300–3600 s), paymentFlow:{type:"PG_CHECKOUT", merchantUrls:{redirectUrl}}, metaInfo?:{udf1..udf15}, prefillUserLoginDetails?:{phoneNumber}, disablePaymentRetry?}` → `{orderId, state:"PENDING", expireAt, redirectUrl}`. `metaInfo`: udf1..udf10 max 256 chars; udf11..udf15 max 50 chars of letters, digits and `_-+@.` (validated by this project; free-form metadata fills udf1..udf10, udf11..udf15 only by explicit key) | VERIFIED |
| Order status | `GET /checkout/v2/order/{merchantOrderId}/status?details=false&errorContext=true` → `state` ∈ `PENDING\|COMPLETED\|FAILED`, `paymentDetails[]` | VERIFIED |
| Refund | `POST /payments/v2/refund` `{merchantRefundId (≤63), originalMerchantOrderId, amount}` → `state: PENDING`. That `merchantRefundId` de-duplicates retries is assumed, not documented | VERIFIED (call) / UNVERIFIED (de-dupe) |
| Refund status | `GET /payments/v2/refund/{merchantRefundId}/status` → `PENDING\|COMPLETED\|FAILED` (custom-checkout docs also list `CONFIRMED`) | VERIFIED |
| Autopay (UPI mandate, eNACH) | `/payment-gateway/autopay/` docs | PARTIAL |
| Payment links, settlements | doc sections exist | PARTIAL |

Use one `merchantOrderId` per attempt. Reuse behaviour is not documented; assume it is rejected. UNVERIFIED

### Checkout flow

1. Server: get token, `POST /checkout/v2/pay` with `merchantOrderId = attemptRef`, `redirectUrl = https://yoursite/pay/return?ref=<attemptRef>` (put the ref in the URL yourself: the redirect does not say which order it was).
2. Client: redirect to `redirectUrl`, or iframe: load the PhonePe checkout bundle from `mercury.phonepe.com` (staging `mercury-stg.phonepe.com`) and call `window.PhonePeCheckout.transact({ tokenUrl: redirectUrl, type: "IFRAME", callback })`. Exact script path not confirmed. PARTIAL
3. On return: the redirect is **unsigned**. Call Order Status, require `state == "COMPLETED"` and amount match, then fulfil.
4. Webhook drives fulfilment too, but see below: it is not a body signature.

### Webhook verification

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

### Status mapping

| PhonePe `state` | Unified |
|---|---|
| `PENDING` | `pending` (this includes "created, customer has not paid") |
| `COMPLETED` | `captured` |
| `FAILED` | `failed` |
| order past `expireAt` while PENDING | treat as `expired` after a final status check |
| refund `PENDING`/`CONFIRMED` / `COMPLETED` / `FAILED` | `pending` / `processed` / `failed` |

### Gotchas

- Legacy v1 (`X-VERIFY = sha256hex(base64Payload + "/pg/v1/pay" + saltKey) + "###" + saltIndex`, merchant id + salt key) is deprecated. New code must use v2 OAuth. Many blog posts and StackOverflow answers still show v1.
- Token host differs from API host in production.
- `redirectUrl` landing with no params: carry your own ref in the URL.
- UPI-first: expect many `PENDING` results; poll status with backoff (e.g. 3s, 5s, 10s, 30s, then reconciliation job), never mark failed on a timeout.

### Sandbox test data (UNVERIFIED in this research)

- Sandbox credentials come from the PhonePe integration team / Business Dashboard test mode.
- PhonePe provides a test app / simulator flow for UPI and test cards in its "Test" section: https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/test-integration (path may differ).

### Platforms

- Shopify: official app "PhonePe Payment Gateway" https://apps.shopify.com/phonepe-payment-gateway (launched 2023-02-24); Settings → Payments → "PhonePe PG", link the MID. VERIFIED https://developer.phonepe.com/payment-gateway/e-commerce-plugins/shopify
- WooCommerce: https://wordpress.org/plugins/phonepe-payment-solutions/
- Mobile: Standard Checkout Android/iOS SDKs (developer.phonepe.com mobile-app-integration). Server still creates the order and confirms status.

---

## Stripe (India)

Status labels: VERIFIED / PARTIAL / UNVERIFIED.

### Availability: read this first

- **"Stripe services are invite only in India."** Indian businesses must request an invite and cannot self-sign-up. Stripe supports "a select number of businesses, with a focus on international expansion". Third-party sources date this to May 2024; still in force late 2026. Existing accounts continue to work. VERIFIED https://support.stripe.com/questions/india-faq
- Registered Indian business only (sole prop / LLP / company); no individuals. PARTIAL https://stripe.com/docs/india-exports
- Treat Stripe as an **international / exports** gateway, not the domestic-India default. If the user has no existing Stripe India account, recommend a domestic gateway and say why.
- Shopify Payments (built on Stripe) is not available to India-based stores.
- **Payment methods on an Indian Stripe account: cards.** UPI is not offered to India-domiciled accounts (IN is absent from the UPI "Business locations" list); it is for Stripe accounts outside India charging Indian customers. VERIFIED https://docs.stripe.com/payments/upi

### Auth, amounts

- `https://api.stripe.com/v1`, `Authorization: Bearer sk_test_…|sk_live_…`, form-encoded bodies. Test vs live by key prefix. VERIFIED
- Integer minor units (paise for INR). VERIFIED
- Use the `Idempotency-Key` header on every POST (Stripe-native idempotency; max 255 chars, expires after 24 h). Stripe replays the saved response for a reused key, including a 500: after a 5xx, check status before re-submitting with a new key. `client_reference_id` max 200 chars.
- Pin `Stripe-Version`. From API `2026-09-30.endive`, failed India mandates come back as `inactive` with `inactive_reason`. VERIFIED

### Exports

135+ presentment currencies on Visa/Mastercard; INR/USD on Amex. Non-INR needs extra onboarding info and transactions must be declared as exports (purpose codes, FIRC). PARTIAL. Each export charge needs a description of the goods/services and the customer's name and billing address: this project sends `payment_intent_data.description` and sets `billing_address_collection=required` on Checkout; for the PaymentIntent flow pass billing details into `stripe.confirmPayment`.

### Checkout flow

Option A, Checkout Session (simplest):
1. Server: `POST /v1/checkout/sessions` `{mode:"payment", line_items or price_data with server-computed unit_amount, success_url, cancel_url, client_reference_id: attemptRef, metadata:{attemptRef}}`. Redirect to `session.url`.
2. Never fulfil on `success_url`. Fulfil on webhook `checkout.session.completed` with `payment_status == "paid"` (and `checkout.session.async_payment_succeeded` for delayed methods).

Option B, PaymentIntent + Payment Element:
1. Server: `POST /v1/payment_intents` `{amount, currency, automatic_payment_methods[enabled]=true, metadata[attemptRef]}` → return `client_secret` only.
2. Client: Stripe.js `confirmPayment`. Fulfil on `payment_intent.succeeded` webhook.

### Webhook signature

`Stripe-Signature: t=<ts>,v1=<hex>[,v1=…][,v0=…]`. `expected = hex(HMAC_SHA256(t + "." + rawBody, whsec_secret))`. Compare against **every** `v1` (several during secret rolling), ignore other schemes, enforce a tolerance (libraries default 300 s; never disable). VERIFIED https://docs.stripe.com/webhooks?verify=verify-manually

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
export function verifyStripeWebhook(rawBody: string, header: string, whsec: string, toleranceSec = 300) {
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = parts.find(([k]) => k === 't')?.[1];
  const v1s = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || v1s.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = Buffer.from(createHmac('sha256', whsec).update(`${t}.${rawBody}`).digest('hex'));
  return v1s.some((v) => v.length === expected.length && timingSafeEqual(Buffer.from(v), expected));
}
```

Prefer the official `stripe` library's `stripe.webhooks.constructEvent(rawBody, sig, whsec)` when available. Dedupe on `event.id`.

Refund events: `charge.refunded` fires when a refund is created (it may still be pending, and `amount_refunded` is cumulative), so this project reports it as type `unknown`. Subscribe to `refund.created`, `refund.updated` and `refund.failed` (a refund can be created already `succeeded`, with no later `refund.updated`). `refund.updated` counts only when its status changed. Refund events dedupe on `refund:<re_id>:<status>`.

Refunding an uncaptured PaymentIntent (`requires_capture`) cancels it instead (full amount only, no `re_` id). Physical-goods exports also need a shipping address: pass `providerOptions.shipping_address_collection` on Checkout.

### Status mapping (PaymentIntent)

| Stripe | Unified |
|---|---|
| `requires_payment_method` / `requires_confirmation` / `requires_action` | `created` |
| `processing` | `pending` (India recurring card debits sit here ~26h) |
| `requires_capture` | `authorized` (NOT paid in this project; the authorisation lapses after about 7 days unless captured) |
| `succeeded` | `captured` |
| `canceled` | `cancelled` |
| charge `refunded` / `amount_refunded > 0` | `refunded` / `partially_refunded` |

Refunds: `POST /v1/refunds {payment_intent, amount?}`; status `pending|succeeded|failed|canceled|requires_action`.

This project: a fully refunded payment is `refunded` and never `paid`, so replaying a `success_url` after a refund does not re-fulfil. `providerOptions` may not set `capture_method`, `transfer_data`, `on_behalf_of`, `application_fee_amount`, `transfer_group`, `metadata`, `confirm`, `customer`, `payment_method`, `off_session`, `discounts` or the Checkout URLs/line items (subscriptions: also `subscription_data`); pass metadata through `metadata`, where `order_ref` cannot be overridden.

### RBI e-mandate rules for recurring (VERIFIED https://docs.stripe.com/india-recurring-payments)

- Off-session Indian card (and UPI, on non-India accounts) payments need an e-mandate registered with AFA (3DS / UPI PIN).
- Pre-debit notification ≥24h before each debit; Stripe delays card charges 26h (PaymentIntent in `processing`).
- Each charge **> Rs 15,000 needs AFA**; UPI recurring > Rs 15,000 unsupported.
- Mandates cannot be updated or cancelled via the API.

### Sandbox test data (UNVERIFIED in this research)

- Test cards at https://docs.stripe.com/testing (`4242 4242 4242 4242` generic; India-specific cards and 3DS cards listed there). Use `stripe listen --forward-to localhost:3000/webhooks/stripe` (Stripe CLI) for local webhooks.

### Platforms

- Shopify (India store): not usable. WooCommerce: official "WooCommerce Stripe Payment Gateway" plugin, subject to the same invite-only account restriction.

---

## Dodo Payments

Full setup guide: `docs/dodo.md` in the india-payments-mcp repo; sourced facts in `docs/research/dodo-api-facts.md`. Status labels: VERIFIED / PARTIAL / UNVERIFIED. Nothing in this project has yet been run against Dodo's real test mode: the adapter is checked against Dodo's docs, fixtures and the official `standardwebhooks` library only.

### What Dodo is: read this first

- **Merchant of Record (MoR) for digital products.** Dodo is the legal seller: it calculates, collects and remits VAT/GST/sales tax worldwide and pays you out net. VERIFIED https://docs.dodopayments.com/features/mor-introduction
- **Digital only**: SaaS, AI products, digital goods, templates, plugins, apps, e-books, edtech. **Physical goods and manual or human-delivered services (consulting, freelancing, coaching) are not allowed**, nor professional or financial services. If the user sells those, Dodo is the wrong gateway: say so before writing code. VERIFIED https://docs.dodopayments.com/miscellaneous/merchant-acceptance
- India: Indian individuals (PAN) and entities (PAN or GSTIN) can sign up. Buyers in India pay by UPI (QR/intent), RuPay and Indian cards, in INR. Net banking and Indian wallets are not listed. VERIFIED https://docs.dodopayments.com/features/payment-methods/india
- **Payouts are in USD, GBP or EUR only; INR payouts were discontinued.** Dodo's docs do not mention FIRA/FIRC at all: ask Dodo how inward-remittance certificates work for your account before relying on Dodo for export documentation. VERIFIED (payouts), UNVERIFIED (FIRA)
- Dodo ships its **own official MCP server** (npm `dodopayments-mcp`, remote `https://mcp.dodopayments.com/mcp`): two "Code Mode" tools, `search_docs` and `execute` (agent-written TypeScript against the Dodo SDK). Use it for Dodo-only work this adapter does not wrap (products, discounts, licence keys). This project is the cross-gateway interface, with Dodo next to the Indian gateways; **it is not affiliated with Dodo** and is not "the Dodo MCP". VERIFIED https://docs.dodopayments.com/developer-resources/mcp-server

### Auth, hosts, amounts

- Test mode `https://test.dodopayments.com`, live `https://live.dodopayments.com`, paths at the root (no `/v1`). `Authorization: Bearer <key>`, JSON bodies. VERIFIED
- Keys are mode-specific: `dodo_test_…` / `dodo_live_…` (older keys have no prefix and still work). This project: `PAYMENTS_MODE=sandbox` uses test mode and refuses a `dodo_live_` key; `live` refuses `dodo_test_` (`CONFIG_INVALID`). Unprefixed keys cannot be cross-checked. A webhook key that decodes to fewer than 24 bytes is also `CONFIG_INVALID`. Test and live have **separate keys, products and webhooks**. VERIFIED
- Integer smallest currency unit (paise, cents; the currency's own decimals): same as ours. The API has 145 ISO currency codes (Adaptive Currency: 80+ local currencies). INR minimum: the higher of Rs 5 and the equivalent of US$0.50 (US$1.00 for subscriptions). VERIFIED
- **No idempotency header** is documented. This project never retries a Dodo POST: a create or refund that times out or gets a 5xx is `OUTCOME_UNKNOWN`. GETs and the cancel PATCH are retried. PARTIAL (absence)
- Env: `DODO_PAYMENTS_API_KEY` (required), `DODO_PAYMENTS_WEBHOOK_KEY` (`whsec_…`, needed to verify webhooks), `DODO_PAYMENTS_DEFAULT_PRODUCT_ID` (optional).

### Products first (no ad-hoc prices)

Every checkout is for a product created in the Dodo dashboard (Products) or API; `product_cart[].product_id` is required. VERIFIED https://docs.dodopayments.com/api-reference/checkout-sessions/create

- This project charges one product: `providerOptions.productId`, else `DODO_PAYMENTS_DEFAULT_PRODUCT_ID`; with neither, `VALIDATION` (in mock mode too).
- It reads the product (`GET /products/{id}`) before creating the session and refuses (`VALIDATION`, no POST): a recurring or usage-based price, a currency other than `currency`, a product discount (`discount_bps` or the deprecated percent `discount`), purchasing power parity, localized prices (`pricing_mode`), or a fixed price that is not exactly `amount`.
- To charge arbitrary amounts, create one **pay-what-you-want** product: `amount` is sent as `product_cart[].amount` and must be at least its minimum. Dodo requires a PWYW base currency of **USD, GBP or EUR**, so pass `currency` explicitly (the default is INR). INR amounts need a fixed-price INR product per price.
- MoR tax: Dodo may add tax on top of a tax-exclusive price. A payment matches when `total_amount = amount` (tax-inclusive) or `total_amount - tax = amount` (tax-exclusive), in the order currency.
- Discount codes and currency selection default to on in Dodo's checkout; **this project's sessions turn both off** (`feature_flags: {allow_discount_code: false, allow_currency_selection: false}`; `feature_flags` stays refused in `provider_options`). If Adaptive Currency still charges another currency, the payment is a currency mismatch, never paid.

### Checkout flow

1. Server: `POST /checkouts` `{product_cart:[{product_id, quantity:1, amount? (PWYW only)}], customer?, billing_address?, return_url?, feature_flags, metadata:{order_ref, expected_amount, expected_currency}}`. The adapter sets the three binding keys last, so `metadata` cannot override them. Metadata limits (checked locally): 50 keys, keys ≤ 40 chars, string values ≤ 500, values string/number/boolean only. Returns `session_id` (`cks_…`) and `checkout_url`; redirect to it. The `checkout_url` expires after 24 h (`expiresAt`). VERIFIED
2. Unified result: `checkout: {type: "redirect", url, method: "GET"}`, `providerOrderId` = the `cks_` session id. **Store `providerOrderId` next to your orderRef**: verify needs it, and Dodo cannot search by metadata.
3. Dodo redirects to `return_url` with plain query params `payment_id`, `status` (and `email`, `license_key` when present). **Not signed.** VERIFIED https://docs.dodopayments.com/developer-resources/checkout-session
4. Verify server-side: `payments_verify_payment` with `payload` = the query params, `order_ref`, `expected_amount` and **`provider_order_id` (required)**. Without it the result is `valid: false` (mock mode too): anyone can create a Dodo payment carrying your `order_ref`, because static payment links take `metadata_<key>`. The adapter calls `GET /checkouts/{id}` and `GET /payments/{payment_id}` (`verifiedVia: "status_api"`) and ignores the `status` query param. The payment must be that session's own (`checkout_session_id`); then `metadata.order_ref`, the amount (rules above) and the currency (`metadata.expected_currency`) must match. A session with no payment yet is `valid: true`, `status: "created"`.
5. Fulfil on `paid: true` or on a `payment.succeeded` webhook matched to your stored session (below), never on the redirect alone.

Status lookup needs `provider_order_id` (`cks_…`) or `provider_payment_id` (`pay_…`); with only `order_ref` it fails with `VALIDATION` (mock mode enforces the same). It refuses a payment whose `metadata.order_ref` is missing or another order's ("not created by this library"), and reports `unknown` when the currency differs from the order's. A lookup by `provider_payment_id` alone is bound by metadata only: do not fulfil on it.

Not wrapped: static payment links (`checkout.dodopayments.com/buy/{product_id}`, no API needed; `not_implemented`), `confirm: true` sessions and saved payment methods, overlay/inline checkout SDKs.

### Status mapping (IntentStatus)

Dodo documents the names, not the per-value meanings, so unclear values are never `captured`.

| Dodo | Unified |
|---|---|
| no payment on the session yet | `created` |
| `processing`, `requires_customer_action`, `requires_merchant_action`, `requires_payment_method`, `requires_confirmation` | `pending` |
| `requires_capture`, `partially_captured_and_capturable` | `authorized` (NOT paid) |
| `succeeded` | `captured`; `refund_status` `partial` / `full` → `partially_refunded` / `refunded` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |
| `partially_captured`, anything new; any status in another currency than the order's (status lookup, webhooks) | `unknown` |

### Refunds

`POST /refunds {payment_id, items?, currency?, reason?, metadata:{refund_ref, order_ref}}`. VERIFIED https://docs.dodopayments.com/features/transactions/refunds

- Needs `provider_payment_id`. Only payments created through this library are refunded: a missing or different `metadata.order_ref` is `VALIDATION` (refund those from the Dodo dashboard).
- **Full refund**: omit `amount`, or pass the total, or the price Dodo added tax on top of. No items and no `currency` are sent.
- **Partial refund**: one item `{item_id: product_id, amount}` with `currency` = the payment currency (Dodo otherwise reads item amounts in the settlement currency, usually USD). Dodo has no top-level amount, so only one-item carts (what this adapter creates). **Partial refunds of payments where Dodo added tax on top are refused** (`VALIDATION`): refund in full or use the dashboard.
- Refund amounts are reported on the price scale: a full refund of a taxed payment reports the price you charged, so retries and lookups compare like with like.
- **No idempotency key.** Before every POST the adapter looks for a refund on that payment with the same `metadata.refund_ref` and returns it (a different amount = `IDEMPOTENCY_CONFLICT`). Listed refunds carry no metadata, so it fetches each one (at most 25; more is `PROVIDER_ERROR`). After `OUTCOME_UNKNOWN` the client looks it up again by `refund_ref`. The check is per call: two processes refunding the same `refundRef` at the same moment can both reach Dodo (Dodo then allows only one in flight per payment). Run refunds from one place.
- Dodo rules: within **30 days** of payment, the payment must be `succeeded`, **one refund in `pending`/`review` per payment at a time**, cumulative ≤ paid, **your Dodo balance must cover it**, payment fees are not returned. `speed` is ignored.
- Status: `succeeded` → `processed`, `pending`/`review` → `pending`, `failed` → `failed`. Look up with `provider_refund_id`, or `provider_payment_id` + `refund_ref`.

### Webhook signature (Standard Webhooks)

Headers `webhook-id`, `webhook-timestamp` (Unix seconds), `webhook-signature` (space-separated `v1,<base64>` entries; any match is valid, which covers secret rotation). Key = base64-decode of the secret without `whsec_`. Signature = base64 HMAC-SHA256(key, `{id}.{timestamp}.{rawBody}`). 5-minute tolerance. VERIFIED https://docs.dodopayments.com/developer-resources/webhooks. This project's tests check the implementation against the Standard Webhooks reference vector and against the official `standardwebhooks` library (which Dodo's SDK uses) in both directions.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
export function verifyDodoWebhook(rawBody: string, h: Record<string, string | undefined>, secret: string, toleranceSec = 300) {
  const id = h['webhook-id'], ts = h['webhook-timestamp'], sig = h['webhook-signature'];
  if (!id || !ts || !/^\d+$/.test(ts) || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) return false;
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = Buffer.from(createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64'));
  return sig.split(' ').some((e) => e.startsWith('v1,') && Buffer.from(e.slice(3)).length === expected.length && timingSafeEqual(Buffer.from(e.slice(3)), expected));
}
```

Dedupe on `webhook-id`. Dodo makes up to 8 delivery attempts over about a day, and events can arrive **out of order**: order by the body `timestamp`.

Events mapped: `payment.succeeded`, `payment.failed`, `payment.cancelled` (→ `payment.failed`), `payment.processing` (→ `payment.pending`), `refund.succeeded` / `refund.failed`, `subscription.active` / `renewed` / `on_hold` / `past_due` / `failed` / `cancelled` / `expired`, `dispute.opened`, `payout.success`; anything else is `unknown`. There is no `refund.pending` event. Payment events report the matched price as `amount`, and `status: "unknown"` when `data.currency` differs from `metadata.expected_currency`. The signature proves Dodo sent the event, not that the payment is yours: **ignore payment events whose `providerOrderId` (the `checkout_session_id`) or `currency` differ from your stored attempt.** The generated integration does this for Dodo.

### Subscriptions

- Checkout Session for a product with a **recurring price**: `providerPlanId` = that product id, required in every mode (mock too). Plans cannot be created from `plan`; a one-time product is refused. Discount codes and currency selection are off on these sessions too. VERIFIED https://docs.dodopayments.com/developer-resources/subscription-integration-guide
- `providerSubscriptionId` is the `cks_` session id until the customer subscribes; the real `sub_…` id arrives as `subscription_id` on the return URL and in the `subscription.active` webhook. Store it: cancelling a `cks_` id is refused.
- Cancel: `PATCH /subscriptions/{id}` with `status: cancelled` (now) or `cancel_at_next_billing_date: true` (`at_cycle_end`).
- India (RBI e-mandate): UPI, RuPay and Indian cards. UPI shows only for billing country IN, currency INR and `upi_intent` allowed. Every renewal has a 48-hour pre-debit delay: `payment.succeeded` arrives about **48-51 h after the renewal date**, so grant access on the webhook. For Indian-card e-mandates the default mandate ceiling is **Rs 15,000** (`mandate_min_amount_inr_paise`, refused in `provider_options` here; not UPI AutoPay); an upgrade above it needs re-authorisation. A mandate cancelled in the bank app puts the subscription `on_hold`. VERIFIED https://docs.dodopayments.com/features/payment-methods/india

### Customers, settlements

- Customers: `POST /customers` (name and email required).
- Settlements: mapped to `GET /payouts` with `page_size` = `count` (max 100) and `page_number=0` (USD/GBP/EUR payouts of your Dodo balance, net of fees; `settledAt` only when `success`). A bad `from`/`to` date is `VALIDATION`. Default cycle twice a month; a minimum payout threshold applies. Payouts to third parties: `unsupported`.

`provider_options` may not set `product_cart`, `customer`, `billing_currency`, `billing_address`, `confirm`, `payment_method_id`, `discount_codes`, `discount_code`, `subscription_data`, `feature_flags`, `return_url`, `cancel_url`, `custom_fields`, `customization`, `product_collection_id` or `tax_id` (subscriptions also `mandate_min_amount_inr_paise`). Pass `productId` and harmless fields such as `allowed_payment_method_types` there; pass `return_url` and the billing address through the normal arguments.

### Test mode data (VERIFIED on the India page, 2026-10-29; re-check before use)

- UPI `success@upi` / `failure@upi`. Indian cards: Visa `4576238912771450` (success), `4706131211212123` (decline); Mastercard `5409162669381034` (success), `5105105105105100` (decline); expiry 06/32, CVV 123.
- Create the product and the webhook endpoint in Test Mode; recreate both in Live Mode before go-live.

### Platforms

- Shopify: no Dodo Shopify payments app found; the code generator emits no Shopify reconcile server for Dodo. WooCommerce/WordPress plugins were not researched.

---

## Skydo

Full setup guide: `docs/skydo.md` in the india-payments-mcp repo. Status labels: VERIFIED / PARTIAL / UNVERIFIED.

### The short version

- **Skydo has no public developer API, SDK or webhooks** (checked 2026-10-29). No developer portal, API reference, sandbox or API keys exist. `developer.skydo.com` is an empty placeholder; `api.skydo.com` is the dashboard's private backend (403 everywhere). VERIFIED-ABSENT
- An API is on Skydo's roadmap since its Series A post of 10 Dec 2025 (developer APIs and webhooks promised, no date). Nothing has launched since.
- Skydo's own FAQ: website checkout is not available. VERIFIED
- Skydo's Terms of Use (version of 09 Apr 2026) prohibit scrapers, bots and other automated access: clause 13(iv)(f) bans "deep-links, page-scrape, robot, spider or other automatic device"; clause 11 ("Third-party applications") covers only connections Skydo itself approves. **Never automate the Skydo dashboard and never call `api.skydo.com`.** Do not invent endpoints.

### What Skydo is for

Indian exporters, freelancers and agencies receiving **foreign-currency** payments from abroad: standing local receiving accounts in USD, GBP, EUR, CAD, AUD, AED and SGD, plus a SWIFT account (32 currencies). Settled to INR with a FIRA. Not domestic INR checkout, no cards or UPI from Indian customers.

Limits (Skydo FAQ): minimum USD 50 per payment (or the equivalent); InstaLinks do not support recurring payments and Skydo has no subscription product (raise one invoice per period); Skydo's FAQ says it cannot initiate a refund directly for settled InstaLink payments (for anything else ask Skydo support), and there is no refund API. Every incoming transfer must be matched to an invoice in Skydo, so the client must quote a reference. Fees change; see Skydo's site. This project does not compute Skydo fees.

### What can be automated: Skydo's own two paths

This project's `skydo` adapter never contacts Skydo. It automates the two paths Skydo itself supports. Configure at least one.

#### 1. Zoho Books bridge (automatic once Skydo imports your invoices; confirm during setup)

Skydo has a native Zoho Books integration: Skydo documents that it syncs new Zoho invoices about every 10 minutes, and when the money arrives it marks the Zoho invoice paid and attaches the FIRA PDF. Zoho Books has a public API, so:

- `createPayment` creates a Zoho Books invoice (`reference_number` = orderRef, one line using `ZOHO_ITEM_ID`), marks it sent, and returns `checkout.type: "manual"` with the invoice link. It first looks the reference up (exact match, all pages), so a repeat call returns the same (full) invoice; a different amount or currency for the same orderRef is rejected, and so is an orderRef whose only invoice was voided. If concurrent processes both create an invoice, the oldest `invoice_id` wins and only the loser is voided; a draft left by a failed attempt is marked sent on retry.
- Skydo documents that Zoho invoices sync, but not API-created invoices specifically: during setup, confirm the first invoice appears in the Skydo dashboard within ~10 minutes. UNVERIFIED until you do.
- The customer must already exist in Zoho Books with the invoice currency, picked by `customer.email` (exact match on the primary contact's email; two active matches or only an inactive one is rejected) or `providerOptions.zohoCustomerId` (must be an active contact of type customer). A currency mismatch is rejected. Indian Zoho organisations should set GST treatment "Overseas" for foreign clients. Turn off Zoho online payment gateways on these invoices, or clients can pay outside Skydo (no FIRA).
- Optional `providerOptions`: `sendEmail` (true = Zoho emails the invoice), `dueDate`, `exchangeRate` (pass it if Zoho rejects an invoice in a currency other than the organisation's base currency).
- `getPaymentStatus` / `verifyPayment` read the full Zoho invoice (`verifiedVia: "status_api"`); an invoice whose `reference_number` is not the orderRef is rejected. `raw.firaAttached` says whether Skydo attached the FIRA. Poll it (for example every 15 minutes) with the stored `providerOrderId`, which makes each check one Zoho call: there is no webhook. Zoho Books allows 1,000 (Free) to 10,000 (Premium+) calls per day per organisation, and a 15-minute poll costs 96 calls a day per open invoice.
- One-time human steps: Skydo profile > **Connect Skydo to Zoho** (only invoices created AFTER connecting are imported; choose all currencies or international only); create a service item in Zoho; create a Zoho API Console Self Client and a refresh token with scopes `ZohoBooks.invoices.ALL,ZohoBooks.contacts.READ`.
- Env: `ZOHO_DATA_CENTER` (com, eu, in, com.au, jp, ca, com.cn, sa, ae, uk, sg), `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ORGANIZATION_ID`, `ZOHO_ITEM_ID`; optional `ZOHO_ACCOUNTS_URL`. Set all six required ones or none: a partial set fails with `CONFIG_MISSING`.

Zoho invoice status → unified:

| Zoho | Unified |
|---|---|
| `paid`, payments cover the total | `captured` |
| `paid`, fully written off (bad debt, nothing received) | `failed` |
| `paid`, partly written off after a real payment (`payment_made` > 0) | `pending` (review manually) |
| `paid` but closed with credit notes (payments below total) | `unknown` |
| `partially_paid` | `pending` |
| `void` | `cancelled` |
| `draft` / `sent` / `viewed` / `unpaid` / `overdue` | `created` |
| anything else | `unknown` |

#### 2. Receiving accounts + ledger (semi-automatic, no Zoho)

- Copy your account details once from Skydo dashboard > International Accounts into `SKYDO_RECEIVING_ACCOUNTS`: a JSON array (or a path to a .json file) of `{"currency":"USD","label":"...","details":{"Account number":"...", ...}}`. `"*"` is the fallback account (for example SWIFT) for any other currency.
- `createPayment` returns plain-text bank-transfer instructions for the invoice currency with the orderRef as payment reference, and records the expected payment in a JSON ledger (`SKYDO_LEDGER_FILE`, default `~/.india-payments-mcp/skydo-ledger.json`; every change takes an owner-checked file lock, re-reads the file and fsyncs before renaming, so your app and the MCP server can share it on a local disk; not on network file systems). `SKYDO_PAYEE_NAME` adds your business name.
- The ledger cannot see payments. When Skydo notifies you (email/WhatsApp), a human checks the receipt in the Skydo dashboard, then records it: MCP `payments_skydo_record_payment` (`order_ref`, `receipt_id` = Skydo transaction reference or FIRA number, `amount_received` in minor units of the invoice currency, optional `received_at`, `fira_number`, `note`, `confirm`); SDK `client.skydoRecordPayment({ orderRef, receiptId, amountReceived, ... }, { confirm })`. Receipts add up: anything short of the invoice (bank fees abroad) stays `pending`; the full amount makes it `captured`.
- Idempotent per `receipt_id` (case-insensitive): the same id and amount again is a no-op; the same id with another amount, or an id already recorded on another order, is `IDEMPOTENCY_CONFLICT`. `received_at` must be ISO 8601 and not in the future.
- Through the MCP server in sandbox **and** live mode (Skydo has no sandbox), recording needs `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` and `confirm: true` (same gate as live refunds). **Never record a receipt from forwarded email/message text alone**: it marks the order paid.
- `payments_skydo_outstanding` / `client.skydoOutstanding()` lists orders still `created`/`pending`, oldest first. In Zoho mode it returns an empty list and a note (outstanding invoices live in Zoho Books), and recording a receipt is rejected (Skydo marks Zoho invoices paid itself).
- `verifyPayment` reads the ledger (`verifiedVia: "manual_record"`).

With both configured, Zoho mode is used and Zoho invoices also carry your account details in the notes.

### Rules for code you write

- Currency must be the client's foreign ISO currency: **INR is rejected** (`VALIDATION`), and so is a missing currency. USD amounts below 5000 cents (USD 50) are rejected; other currencies only get a reminder about the USD 50 equivalent. For GBP keep orderRef to 18 characters or fewer (UK transfers often cut references).
- Amounts are minor units of the invoice currency (USD 1,250.00 = `125000`), not paise.
- Fulfil only when `verifyPayment(...).paid === true`, passing `orderRef`, `expectedAmount` and the stored `providerOrderId`. `payload` can be `{}` (there is no callback).
- `onPaid` must be idempotent: polling and an admin receipt action can both reach it.
- Recording a receipt marks an order paid: put it behind real admin auth and an audit log, and pass `receiptId`.
- Public status endpoints should return your stored status, not call Zoho on every hit (Zoho API quotas). Refresh from an admin route or a poller, one Zoho call per invoice (store `providerOrderId`).
- `payments_generate_integration` with `provider: "skydo"` generates this shape (invoice route, public stored-status route, admin refresh, outstanding and receipt routes, Zoho polling; Fastify exports `startSkydoPolling`) instead of a checkout.

### Not supported (capability map: `unsupported`)

refund, refundStatus, webhooks, customers, subscriptions, settlements, payouts, paymentLinks. createPayment / verifyPayment / paymentStatus are `partial` (they work through Zoho or the ledger, never through Skydo). Checkout type is always `manual`.

- InstaLinks (Skydo payment links) can only be created by hand in the dashboard and each link is single-use. No URL pattern or prefill exists. VERIFIED
- Refunds: no API. Skydo's FAQ says it cannot initiate a refund directly for settled InstaLink payments; for anything else ask Skydo support.
- INR settlements and FIRAs: Skydo dashboard (Analytics & Reports > Reports tab exports).

### Mock mode

`PAYMENTS_MODE=mock` applies the same INR / USD 50 rules. Simulate the client paying with `payments_mock_complete_payment` (provider `skydo`), then `payments_verify_payment` with `payload: {}` (the mock looks the order up, as the real adapter does). `payments_skydo_record_payment` and `payments_skydo_outstanding` fail with `VALIDATION` in mock mode.

### Alternatives if they need a real checkout for foreign customers

Razorpay (international cards, if enabled), Stripe (invite-only in India, exports focus), PayU / CCAvenue (multi-currency on request). Each needs international payments enabled and export documentation.

### Platforms

Shopify / WooCommerce: no Skydo app. VERIFIED-ABSENT. Zoho Books: native integration (above).

---

## Infinity

Full setup guide: `docs/infinity.md` in the india-payments-mcp repo. Status labels: VERIFIED / PARTIAL / UNVERIFIED.

### The short version

- **Infinity (infinityapp.in, Scalifi Wealth Pvt Ltd) publishes no developer API docs, SDK or webhooks** (checked 2026-10-29). Its Terms mention an API, but no documentation is public; ask support@infinityapp.in for access.
- Its Terms forbid reverse engineering and incorporating the Services into other systems without consent. **Never automate the Infinity dashboard and never call Infinity hosts.** Do not invent endpoints.
- This project's `infinity` adapter never contacts Infinity. Checkout type is always `manual`.

### What Infinity is for

Indian freelancers, agencies, exporters and startups receiving **foreign-currency** payments from abroad: local receiving accounts in USD, EUR, GBP, AUD and CAD, plus SWIFT for other currencies; QuickLink payment links (card or bank transfer). Settled to INR, most payments within 24 hours of arriving in Infinity (next working day on weekends/holidays). FIRA: download it from any settled payment in the dashboard.

Limits: INR is not supported. Infinity documents no minimum amount (none is enforced here). Fee: flat 0.5% per incoming payment (Infinity pricing page); this project does not compute fees. Card availability depends on currency, country and Infinity account review. Card payments can be disputed by the payer after you record them.

### Three ways to use it

Configure at least one: all `INFINITY_ZOHO_*` variables, `INFINITY_RECEIVING_ACCOUNTS`, or `INFINITY_QUICKLINK_ONLY=true`. With none, the adapter fails with `CONFIG_MISSING`.

#### 1. Zoho Books bridge (UNVERIFIED until you confirm it during setup)

The Infinity dashboard has a **Connect > Zoho Books** integration (seen in a merchant dashboard). **What it syncs (import of API-created invoices, recording payments, attaching FIRAs) is not publicly documented.** Zoho Books has a public API, so the adapter uses the same shared Zoho code as Skydo's bridge:

- `createPayment` creates a Zoho Books invoice (`reference_number` = orderRef, one line using `INFINITY_ZOHO_ITEM_ID`), marks it sent and returns the invoice link. Same rules as Skydo: an existing invoice for the orderRef is returned (a different amount/currency, or a voided invoice, is rejected); the customer must already exist in Zoho with the invoice currency (`customer.email` or `providerOptions.zohoCustomerId`); optional `providerOptions` `sendEmail`, `dueDate`, `exchangeRate`. Your account details are printed in the invoice notes. `providerOptions.quickLinkUrl` is **refused** in this mode (`VALIDATION`): the Zoho invoice is the payment document, so add a QuickLink to it in Zoho yourself if you want one.
- `getPaymentStatus` / `verifyPayment` read the full Zoho invoice (`verifiedVia: "status_api"`). **Paid only when Zoho records payments covering the total**: write-offs and credit notes never count (status mapping as in `references/skydo.md`). `raw.firaAttached` reports a Zoho attachment; whether Infinity attaches FIRAs is unconfirmed. No webhook: poll (for example every 15 minutes) with the stored `providerOrderId`.
- **During setup, pay one small real invoice and confirm Infinity marks it paid in Zoho.** If it does not, use mode 2 or 3. Until Zoho shows payments covering the total, the order is never reported paid.
- Env: `INFINITY_ZOHO_DATA_CENTER` (com, eu, in, com.au, jp, ca, com.cn, sa, ae, uk, sg), `INFINITY_ZOHO_CLIENT_ID`, `INFINITY_ZOHO_CLIENT_SECRET`, `INFINITY_ZOHO_REFRESH_TOKEN` (scopes `ZohoBooks.invoices.ALL,ZohoBooks.contacts.READ`), `INFINITY_ZOHO_ORGANIZATION_ID`, `INFINITY_ZOHO_ITEM_ID`; optional `INFINITY_ZOHO_ACCOUNTS_URL`. All six or none: a partial set fails with `CONFIG_MISSING`.
- The prefix is separate on purpose: Skydo's `ZOHO_*` never switches Infinity onto Zoho. **Do not connect Skydo and Infinity to the same Zoho organisation**: both could pick up the same invoice.
- Turn off Zoho online payment gateways on these invoices so clients pay through Infinity (and you get a FIRA). Indian organisations: GST treatment "Overseas" for foreign clients.
- Recording a receipt is refused in this mode (Zoho is the record), and `outstanding` returns an empty list with a note (outstanding invoices are in Zoho Books).

#### 2. Bank transfer + ledger

- Copy your receiving-account details from the Infinity dashboard into `INFINITY_RECEIVING_ACCOUNTS`: same JSON format as `SKYDO_RECEIVING_ACCOUNTS` (array, or a path to a .json file, of `{"currency":"USD","label":"...","details":{...}}`; `"*"` = fallback, for example SWIFT).
- `createPayment` returns bank-transfer instructions with the orderRef as payment reference and tracks the expected payment in `INFINITY_LEDGER_FILE` (default `~/.india-payments-mcp/infinity-ledger.json`; same locked, fsynced ledger code as Skydo; local disk only). `INFINITY_PAYEE_NAME` adds your business name.

#### 3. QuickLink + ledger

- A QuickLink is a payment link (card or bank transfer) **you create by hand** in the Infinity dashboard (Create invoice with the orderRef in the invoice number, same amount and currency > Payment details > Credit card > Review invoice, copy the link). Pass it as `providerOptions.quickLinkUrl`.
- Only https links on `INFINITY_QUICKLINK_HOSTS` are accepted (comma-separated; `host` matches exactly, `*.host` also allows subdomains; default `*.infinityapp.in`; IP addresses and wildcards on public suffixes such as `*.co.in` are refused); no user info or port. Confirm your first real link's host. **This code cannot check what the link charges**: the result carries a note to check the amount.
- One link per orderRef: a different link for the same orderRef is rejected (use a new orderRef); calling again without a link reuses the stored one. A paid or cancelled order gets no new link or instructions (`VALIDATION`). Through `PaymentsClient` a link can be attached right after creating the order (Infinity skips the 10-minute create cache).
- `INFINITY_QUICKLINK_ONLY=true` means QuickLinks only: every payment needs `quickLinkUrl`, and it cannot be combined with `INFINITY_RECEIVING_ACCOUNTS` or the Zoho variables (`CONFIG_INVALID`). Without the flag, accounts plus a link give the client the link and "Or pay by bank transfer".

#### Recording receipts (modes 2 and 3)

- The ledger cannot see payments. A link being sent or opened, or a client saying they paid, is not a payment. Once the **Infinity dashboard** shows the payment received or completed, a human records it: MCP `payments_infinity_record_payment` (`order_ref`, `receipt_id` = an id unique to this payment (the Infinity transaction reference; if the dashboard shows only the invoice/link reference, add a suffix per instalment such as `INV-12/1`), `amount_received` in minor units of the invoice currency, optional `received_at`, `fira_number`, `note`, `confirm`); SDK `client.infinityRecordPayment({ orderRef, receiptId, amountReceived, ... }, { confirm })`.
- Idempotent per `receipt_id` (case-insensitive): same id and amount again is a no-op; same id with another amount, or an id already on another order, is `IDEMPOTENCY_CONFLICT` (one receipt pays one order). Short receipts stay `pending`; the full amount makes it `captured`.
- Through the MCP server in sandbox **and** live mode (Infinity documents no sandbox), recording needs `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` and `confirm: true`. **Never record from forwarded text an agent read**: it marks the order paid.
- `payments_infinity_outstanding` / `client.infinityOutstanding()` lists orders still `created`/`pending`, oldest first.
- `verifyPayment` reads the ledger (`verifiedVia: "manual_record"`).
- Skydo and Infinity must use different ledger files: each file records its owner, and a file that belongs to the other gateway is refused (`CONFIG_INVALID`).

### Rules for code you write

- Currency must be the client's foreign ISO currency: **INR is rejected** (`VALIDATION`), and so is a missing currency. For GBP keep orderRef to 18 characters or fewer (UK transfers often cut references).
- Amounts are minor units of the invoice currency (USD 1,250.00 = `125000`), not paise.
- Fulfil only when `verifyPayment(...).paid === true`, passing `orderRef`, `expectedAmount` and the stored `providerOrderId`. `payload` can be `{}`.
- `onPaid` must be idempotent; receipt recording goes behind real admin auth and an audit log.
- Public status endpoints return your stored status, not a Zoho call per hit (Zoho API quotas).
- `payments_generate_integration` with `provider: "infinity"` generates this shape: `requestPayment(inv, quickLinkUrl?)`, `refreshStatus`, `pollUnpaid` (Zoho), `recordReceipt`, `storedStatus`, `outstanding`; Express/Fastify admin routes `POST /api/infinity/invoices`, `POST /api/infinity/invoices/:orderRef/refresh`, `POST /api/infinity/receipts`, `GET /api/infinity/outstanding`, public `GET /api/infinity/invoices/:orderRef`; Next.js: invoices, status, receipts and a poll route; `docs/INFINITY_PAYMENTS.md`.

### Not supported (capability map: `unsupported`)

refund, refundStatus, webhooks, customers, subscriptions, settlements, payouts, paymentLinks (QuickLinks are created by hand in the dashboard). createPayment / verifyPayment / paymentStatus are `partial` (Zoho or the ledger, never Infinity).

- Refunds: no API; ask Infinity support.
- Recurring: Infinity's recurring-invoice setting is separate from payment links and does not auto-charge cards; raise one invoice per period.
- Settlements and FIRAs: Infinity dashboard (open a settled payment > Download FIRA).

### Mock mode

`PAYMENTS_MODE=mock` applies the same INR rule and the default QuickLink host check (`*.infinityapp.in`). Simulate the client paying with `payments_mock_complete_payment` (provider `infinity`), then `payments_verify_payment` with `payload: {}`. `payments_infinity_record_payment` and `payments_infinity_outstanding` fail with `VALIDATION` in mock mode.

### Platforms

Shopify: no Infinity payments app. Zoho Books: dashboard integration (above; behaviour not publicly documented).

---

## Platform notes

### Shopify (be honest with the user)

- **Shopify Payments is not available to India-based stores.** Indian merchants use third-party providers added under Settings → Payments; Shopify charges an extra transaction fee for third-party providers that varies by plan.
- **You cannot build a Shopify checkout gateway for a merchant.** "Only approved Partners can build payments extensions on Shopify's Payments Platform." Custom payment extensions are "limited to eligible Shopify Plus Merchants only". VERIFIED https://shopify.dev/docs/apps/build/payments
- So for "add Razorpay/PayU/PhonePe to my Shopify store" the correct answer is **install the gateway's official app, no code**:

| Gateway | Shopify | |
|---|---|---|
| Razorpay | Official app "All-in-one Razorpay Payment Gateway". Connect as account owner, no API keys. Pre-28-Apr-2022 integrations must migrate | VERIFIED |
| PayU | "1PayU (Cards, UPI, NB, Wallet)" https://apps.shopify.com/payu-india + "Onsite Card Payments by PayU India"; merchant key + salt | VERIFIED |
| PhonePe | "PhonePe Payment Gateway" https://apps.shopify.com/phonepe-payment-gateway; Settings → Payments → "PhonePe PG" | VERIFIED |
| Cashfree | Advertises a no-code Shopify plugin | PARTIAL |
| CCAvenue | Historically listed in admin; current listing unconfirmed | UNVERIFIED |
| Paytm | No official app found | UNVERIFIED |
| Stripe | Not usable for India stores | PARTIAL |
| Dodo Payments | None found (no Dodo Shopify payments app) | UNVERIFIED |
| Skydo | None | VERIFIED-ABSENT |
| Infinity | None found (no Infinity Shopify payments app) | UNVERIFIED |

What code *can* do alongside Shopify: a custom app or backend that reads orders (Admin API) and the gateway's API for reconciliation, refund reporting, or sending payment links for draft/B2B orders. Refunds should normally be issued **from Shopify admin** so Shopify's order state stays correct; refunding directly in the gateway desynchronises Shopify.

### WooCommerce / WordPress

- Prefer the official plugin: Razorpay `woo-razorpay`, PhonePe `phonepe-payment-solutions`, PayU, Cashfree, Paytm, CCAvenue all publish plugins (listing names for the last four UNVERIFIED). Stripe: "WooCommerce Stripe Payment Gateway" (invite-only account problem still applies).
- Custom gateway only if no plugin fits: extend `WC_Payment_Gateway`, implement `process_payment()` (create gateway order server-side, return redirect), register a callback via `woocommerce_api_<id>` (`/?wc-api=<id>`), and call `$order->payment_complete($transaction_id)` only after signature/status verification. Read the raw webhook body with `file_get_contents('php://input')`.
- Use `$order->get_total()` server-side for the amount; convert to paise with `(int) round($total * 100)` only once, or better `wc_format_decimal` + string math.
- Store secrets in plugin settings (DB) or `wp-config.php` constants, never in theme JS. HPOS (custom order tables) is the default in recent WooCommerce: use `wc_get_order()` / order meta APIs, not `postmeta` directly.
- Plain WordPress (no Woo): payment forms plugins (WPForms, Gravity Forms) have Razorpay/PayU add-ons; or a small custom plugin with a REST route following the same rules.

### Next.js (App Router)

- Create-order and verify in Route Handlers (`app/api/payments/.../route.ts`) or Server Actions. Secrets in server env only; never `NEXT_PUBLIC_*` for a secret. The publishable key (Razorpay key_id) may be `NEXT_PUBLIC_`.
- Webhook raw body: `const raw = await req.text();` before any `req.json()`. Set `export const runtime = 'nodejs'` (node:crypto) and `export const dynamic = 'force-dynamic'`.
- Pages Router: `export const config = { api: { bodyParser: false } }` and read the stream.
- Middleware/auth must not block the webhook and the gateway POST-back routes (PayU surl/furl, CCAvenue redirect, Paytm callback); they also need CSRF exemption.
- Vercel/serverless: CCAvenue needs a static egress IP (not available by default). Webhook handlers must finish within the function timeout; push work to a queue.

### Express / Fastify / NestJS

- Express: mount `express.raw({ type: '*/*' })` on the webhook route **before** `express.json()` is applied globally, or use `express.json({ verify: (req, _res, buf) => { req.rawBody = buf } })`.
- Fastify: `addContentTypeParser('application/json', { parseAs: 'string' }, ...)` scoped to the webhook route, or `fastify-raw-body`.
- NestJS: `NestFactory.create(AppModule, { rawBody: true })` then `req.rawBody`.
- Form-POST gateways: `express.urlencoded({ extended: false })` on surl/furl/callback routes.

### Django / DRF

- Raw body: `request.body` (bytes) before touching `request.data`. Decorate gateway POST-back views and webhooks with `@csrf_exempt` (only those). Use `hmac.compare_digest`.
- Amounts: `DecimalField` is acceptable for display, but store `amount_paise = models.BigIntegerField()` for payment logic.
- Status transitions: `PaymentAttempt.objects.filter(attempt_ref=ref, status__in=[...]).update(status='captured')` returns the row count: fulfil only when it's 1. Wrap in `transaction.atomic()`; use `transaction.on_commit` to enqueue fulfilment (Celery).

### Laravel

- Raw body: `$request->getContent()`. Exclude webhook and POST-back routes from `VerifyCsrfToken` (`$except`, or `validateCsrfTokens(except: [...])` in Laravel 11+ bootstrap). Use `hash_equals`.
- Conditional update: `PaymentAttempt::where('attempt_ref', $ref)->whereIn('status', [...])->update([...])` returns affected rows. Queue fulfilment with `afterCommit()`.
- Official PHP SDKs exist for Razorpay (`razorpay/razorpay`) and Cashfree; verify package names on Packagist.

### React Native / Expo

- The app never holds a secret. Flow: app → your API (create attempt, returns order id/session) → gateway SDK in app → SDK result → your API verifies → app shows status from your API.
- Razorpay: `react-native-razorpay` (native module: needs a dev build / prebuild with Expo, not Expo Go). Cashfree, PhonePe, Paytm have RN SDKs or can use a WebView/redirect; check each gateway's docs (UNVERIFIED package names except Razorpay).
- UPI intent returns are unreliable on Android (app killed, user switches back manually). Always resolve via your server status endpoint and webhook, not the SDK callback alone.
- `EXPO_PUBLIC_*` env vars are embedded in the bundle: publishable values only.

### Flutter

- `razorpay_flutter` for Razorpay; Cashfree/PhonePe/Paytm publish Flutter plugins (verify on pub.dev). Same server-first flow as React Native.
- Do not use `--dart-define` for secrets; they are recoverable from the binary.

### Native Android / iOS

- Use the gateway's official SDK (Razorpay, PhonePe Standard Checkout, Cashfree, Paytm All-in-One). The server creates the order and verifies.
- Android 11+: declaring UPI app intents needs `<queries>` entries for `upi://pay` in the manifest so the SDK can find UPI apps.
- iOS: add UPI app URL schemes (`phonepe`, `tez`, `paytmmp`, `bhim`, …) to `LSApplicationQueriesSchemes` if the SDK asks for them.
- App Store / Play rules: physical goods and services can use these gateways; **digital goods consumed in-app must use Apple IAP / Google Play Billing** (with regional alternative-billing exceptions). Check before building.

### Mobile app backends generally

Treat the mobile client like an untrusted browser: amount from server, verification on server, webhook as truth, idempotent create (the user will double-tap).
