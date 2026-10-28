# Indian payment gateways: combined reference

Generated from skills/india-payments/references/*.md. Do not edit here; edit the skill references and regenerate (see chatgpt/custom-gpt-instructions.md).
Labels: VERIFIED = official source; PARTIAL = partly confirmed; UNVERIFIED = confirm in sandbox.

---

## Razorpay

Docs: https://razorpay.com/docs/api/ · Server integration: https://razorpay.com/docs/payments/server-integration/nodejs/integration-steps/
Status labels: VERIFIED = read on the official page; PARTIAL = partly confirmed; UNVERIFIED = not confirmed from an official source, test in sandbox.

### Auth and environments

- Base URL `https://api.razorpay.com/v1` for both test and live. Mode is decided by the key pair: `rzp_test_…` vs `rzp_live_…`. VERIFIED
- HTTP Basic `key_id:key_secret`. Partner (platform) calls add `X-Razorpay-Account: <merchant account id>`. VERIFIED
- Secrets: `key_secret` (API + payment signature) and a **separate** per-webhook secret you type in Dashboard > Webhooks. They are not the same value. VERIFIED
- Env (this project): `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.

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

`receipt` max 40 chars (put your attempt ref here). `notes` max 15 pairs.

### Checkout flow (Standard Checkout)

1. Server: compute amount, `POST /v1/orders` with `receipt = attemptRef`. Store `order_id` on the attempt.
2. Client: load `https://checkout.razorpay.com/v1/checkout.js`, `new Razorpay({ key: KEY_ID, order_id, amount, currency, name, prefill, handler }).open()`. VERIFIED
3. `handler` receives `{razorpay_payment_id, razorpay_order_id, razorpay_signature}`. POST them to your server.
4. Server verifies the signature using the **order_id from your DB**, not from the payload, then marks paid (idempotently).
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
| order `paid` | `captured` |
| payment `created` | `pending` |
| payment `authorized` | `authorized` (NOT paid; capture or it auto-refunds after the capture window) |
| payment `captured` | `captured` |
| payment `failed` | `failed` |
| payment `refunded` (full) / `amount_refunded > 0` | `refunded` / `partially_refunded` |

Common webhook events: `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.created`, `refund.processed`, `refund.failed`, `subscription.activated`, `subscription.charged`, `subscription.halted`, `subscription.cancelled`. UNVERIFIED as a complete list; check Dashboard > Webhooks.

### Gotchas

- `authorized` is not money. Turn on auto-capture (Dashboard > Account & Settings > Payment Capture) or call capture; uncaptured payments are auto-refunded.
- Build the signature string from your stored `order_id`. Using `razorpay_order_id` from the client lets an attacker replay a valid signature from a cheaper order.
- Webhook secret != key secret. Most "signature invalid" bugs are this, or verifying `JSON.stringify(req.body)` instead of raw bytes.
- Same host for test and live: a live key in a dev env charges real cards.
- Instant refunds are `speed: "optimum"` (the unified API calls it `instant`); they can fall back to normal; read `speed_processed`.
- Subscriptions need `total_count`. The first payment is the mandate authorisation via Checkout with `subscription_id`.

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

1. Server: create attempt, `txnid = attemptRef` (unique per attempt). Build fields `key, txnid, amount, productinfo, firstname, email, phone, surl, furl, udf1..udf5, hash`. PARTIAL
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
export function verifyResponse(r: Record<string, string>, salt: string) {
  const u = (k: string) => r[k] ?? '';
  let s = [salt, r.status, '', '', '', '', '', u('udf5'), u('udf4'), u('udf3'), u('udf2'), u('udf1'),
    r.email, r.firstname, r.productinfo, r.amount, r.txnid, r.key].join('|');
  if (r.additional_charges) s = `${r.additional_charges}|${s}`;
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
| Refund | `cancel_refund_transaction` | `var1=mihpayid` (PayU id, **not** txnid), `var2=token_id` (your unique refund id, **max 23 chars**), `var3=amount`. Cancels if `auth`, refunds if `captured` | VERIFIED https://docs.payu.in/docs/refund-transaction-api |
| Refund status | `check_action_status` (by request id), plus by-PayU-id and `getAllRefundsFromTxnIds` | command strings from community SDKs | PARTIAL https://docs.payu.in/reference/refund-apis |

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
- Webhook body format: docs disagree (JSON vs form-urlencoded). Accept both and verify the same reverse hash. PARTIAL
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
| Refund | `POST /pg/orders/{order_id}/refunds` `{refund_amount, refund_id (3–40), refund_speed?: STANDARD\|INSTANT, refund_note?}`. Only within **6 months** of payment | VERIFIED |
| Refund status | `GET /pg/orders/{order_id}/refunds/{refund_id}` | UNVERIFIED (standard) |
| Subscriptions | `POST /pg/plans`, `POST /pg/subscriptions` (+ mandate APIs). Body differs across versions | PARTIAL |
| Settlements | "Get All Settlements"; `GET /pg/orders/{order_id}/settlements` | PARTIAL |
| Payouts | Separate product: `https://{sandbox\|api}.cashfree.com/payout` v2 | VERIFIED |

`customer_details.customer_phone` is mandatory.

### Checkout flow

1. Server: `POST /pg/orders` with `order_id = attemptRef`, `order_meta.return_url = https://yoursite/pay/return?order_id={order_id}`. Return `payment_session_id` to the client.
2. Client: `<script src="https://sdk.cashfree.com/js/v3/cashfree.js">` or npm `@cashfreepayments/cashfree-js`, then `Cashfree({ mode: "sandbox" | "production" }).checkout({ paymentSessionId, redirectTarget: "_self" | "_blank" | "_top" | "_modal" })`. PARTIAL https://www.cashfree.com/docs/open-checkoutx
3. Return URL carries only `order_id`, **no signature**. Server calls `GET /pg/orders/{order_id}` (and `/payments`), checks `order_status == "PAID"` and `order_amount` matches, then fulfils.
4. Webhook also drives fulfilment.

Your domain must be whitelisted in the Cashfree dashboard or checkout will not open.

### Webhook signature

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

### Status mapping

| Cashfree | Unified |
|---|---|
| order `ACTIVE` | `created` (or `pending` if a payment is in flight) |
| order `PAID` | `captured` |
| order `EXPIRED` | `expired` |
| order `TERMINATED` / `TERMINATION_REQUESTED` | `cancelled` UNVERIFIED |
| payment `SUCCESS` / `FAILED` / `PENDING` / `USER_DROPPED` / `CANCELLED` / `NOT_ATTEMPTED` | `captured` / `failed` / `pending` / `failed` / `cancelled` / `created` UNVERIFIED |
| refund `SUCCESS` / `PENDING` / `CANCELLED` / `ONHOLD` | `processed` / `pending` / `failed` / `pending` UNVERIFIED |

### Gotchas

- Sending paise (`49900`) charges Rs 49,900. The most expensive bug possible with this gateway.
- No signed return: always re-fetch.
- Domain whitelist for JS checkout, separate for sandbox and production.
- Refund window 6 months.
- Pin `x-api-version`; don't copy samples written for another version.

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
- **IP whitelisting:** the server's public egress IP must be registered with CCAvenue before server API calls work. Serverless/auto-scaling hosts with changing IPs need a NAT gateway / static egress. Error `51407` = invalid access_code. PARTIAL
- The `access_code` is tied to the registered domain/URL; a mismatch fails checkout. UNVERIFIED

### Amounts

Rupee decimal, Numeric(12,2): `"499.00"`. PARTIAL

### Checkout flow (form POST, encrypted)

1. Server builds a plaintext query string: `merchant_id, order_id, currency=INR, amount, redirect_url, cancel_url, language=EN, billing_name, billing_email, billing_tel, …, merchant_param1..5`. UNVERIFIED
2. Encrypt it → `encRequest` (hex). Render an auto-submitting form to:
   - test `https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction`
   - prod `https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction`
   with fields `encRequest`, `access_code`. UNVERIFIED (Meta's WhatsApp CCAvenue guide shows prod `https://secure.ccavenue.com/transaction.do` for its UPI-intent flow.)
3. CCAvenue POSTs `encResp` (+ `orderNo`) to `redirect_url`. Decrypt → query string with `order_id, tracking_id, bank_ref_no, order_status (Success|Failure|Aborted|Invalid), amount, currency, payment_mode, …`. UNVERIFIED
4. Decryption succeeding is the only integrity check. **Always confirm with `orderStatusTracker` before fulfilling** and check amount + order_id.

### Encryption (classic kits)

AES-128-CBC, key = raw 16-byte `md5(working_key)`, IV = bytes `0x00..0x0f`, ciphertext hex. UNVERIFIED (no official public source; community kits agree). Some newer kits reportedly use AES-256-GCM; **no official evidence**. Default to CBC and ask CCAvenue which kit version your account uses.

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
- `version`: the old PDF says `1.1`; newer commands use `1.2`. `orderStatusTracker` with 1.2 is not confirmed: try 1.2, fall back to 1.1. UNVERIFIED
- Response: `status=0` + `enc_response` (decrypt with the same scheme); `status=1` = failure with message. UNVERIFIED

| Purpose | command | encrypted JSON | Status |
|---|---|---|---|
| Status | `orderStatusTracker` | `{order_no, reference_no}` (Meta guide shows `orderNo`/`referenceNo`) | UNVERIFIED |
| Refund | `refundOrder` | `{reference_no, refund_amount, refund_ref_no}` (`reference_no` = CCAvenue `tracking_id`) | UNVERIFIED |

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

Dashboard-configured "Dynamic Event Notification" (HTTP POST). Signature scheme **not documented publicly**. Treat it only as a trigger: on receipt, call `orderStatusTracker` and act on that result. UNVERIFIED

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
| Refund / status pages | `https://securegw-stage.paytmpayments.in` shown in staging docs | assume `https://secure.paytmpayments.com` | VERIFIED (staging) / UNVERIFIED (prod) |
| Legacy | `securegw-stage.paytm.in` | `securegw.paytm.in` | appears only in legacy docs |

Do not hard-code the legacy hosts. Test both staging hosts if one fails.

### Credentials

`MID`, merchant key (exactly **16 bytes**, used as the AES key), `websiteName` (`WEBSTAGING` in staging, `DEFAULT` in prod, or what the dashboard shows). VERIFIED

### Amounts

Rupee **string**, max 2 decimals, in `txnAmount.value` (`"499.00"`). VERIFIED

### Checkout flow (JS Checkout)

1. Server: `POST {host}/theia/api/v1/initiateTransaction?mid={MID}&orderId={ORDER}` with
   `{head:{signature, channelId?:"WEB"|"WAP"}, body:{requestType:"Payment", mid, websiteName, orderId (≤50), callbackUrl?, txnAmount:{value:"499.00", currency:"INR"}, userInfo:{custId, mobile?}}}`.
   `head.signature` = checksum of `JSON.stringify(body)`. Response: `body.resultInfo.resultStatus` `S|F|U` and `body.txnToken` (**valid 15 minutes**). Verify the response `head.signature`. VERIFIED https://paytmpayments.com/docs/api/initiate-transaction-api
2. Client: `<script src="{host}/merchantpgpui/checkoutjs/merchants/{MID}.js">`, then
   `window.Paytm.CheckoutJS.init({root:"", flow:"DEFAULT", data:{orderId, token, tokenType:"TXN_TOKEN", amount}, handler:{notifyMerchant}}).then(() => window.Paytm.CheckoutJS.invoke())`. VERIFIED https://paytmpayments.com/docs/jscheckout-invoke-payment
3. Paytm POSTs **form key-value pairs** to `callbackUrl`: `ORDERID, MID, TXNID, TXNAMOUNT, STATUS (TXN_SUCCESS|TXN_FAILURE|PENDING), RESPCODE, RESPMSG, BANKTXNID, CHECKSUMHASH, …`. Verify CHECKSUMHASH, check ORDERID/TXNAMOUNT, then confirm with the status API. VERIFIED https://paytmpayments.com/docs/payment-status
4. The dashboard webhook URL receives the same form payload. Same verification.

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
| Status | `POST {host}/v3/order/status` `{head:{signature}, body:{mid, orderId, txnType?}}` → `resultStatus` ∈ `TXN_SUCCESS\|TXN_FAILURE\|PENDING\|NO_RECORD_FOUND` | VERIFIED https://paytmpayments.com/docs/api/v3/transaction-status-api |
| Refund | `POST {host}/refund/apply` `{mid, orderId, refId (unique), txnId (Paytm TXNID), txnType:"REFUND", refundAmount, preferredDestination?:"TO_INSTANT", comments?}` | VERIFIED https://paytmpayments.com/docs/refund-api/ |
| Refund status | `POST {host}/v2/refund/status` `{mid, orderId, refId}` | UNVERIFIED |

### Status mapping

| Paytm | Unified |
|---|---|
| `TXN_SUCCESS` | `captured` |
| `TXN_FAILURE` | `failed` |
| `PENDING` | `pending` |
| `NO_RECORD_FOUND` | `created` (or `unknown` if you expected a txn) |
| refund `TXN_SUCCESS` / `PENDING` / `TXN_FAILURE` | `processed` / `pending` / `failed` UNVERIFIED |

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
- Cache the token until `expires_at` minus a margin; refresh on 401. Sandbox `client_version` is typically `1`.
- Webhook auth is separate: a username/password you set in the Business Dashboard (in sandbox, ask the PhonePe integration team).
- Env (this project): `PHONEPE_CLIENT_ID`, `PHONEPE_CLIENT_SECRET`, `PHONEPE_CLIENT_VERSION`, `PHONEPE_WEBHOOK_USERNAME`, `PHONEPE_WEBHOOK_PASSWORD`.

### Amounts

Integer paise, **min 100** (payments and refunds). VERIFIED

### Endpoints

| Purpose | Call | Status |
|---|---|---|
| Create payment | `POST /checkout/v2/pay` `{merchantOrderId (≤63, letters/digits/_/-), amount, expireAfter? (300–3600 s), paymentFlow:{type:"PG_CHECKOUT", merchantUrls:{redirectUrl}}, metaInfo?:{udf1..udf15}, prefillUserLoginDetails?:{phoneNumber}, disablePaymentRetry?}` → `{orderId, state:"PENDING", expireAt, redirectUrl}` | VERIFIED |
| Order status | `GET /checkout/v2/order/{merchantOrderId}/status?details=false&errorContext=true` → `state` ∈ `PENDING\|COMPLETED\|FAILED`, `paymentDetails[]` | VERIFIED |
| Refund | `POST /payments/v2/refund` `{merchantRefundId (≤63), originalMerchantOrderId, amount}` → `state: PENDING` | VERIFIED |
| Refund status | `GET /payments/v2/refund/{merchantRefundId}/status` → `PENDING\|COMPLETED\|FAILED` (custom-checkout docs also list `CONFIRMED`) | VERIFIED |
| Autopay (UPI mandate, eNACH) | `/payment-gateway/autopay/` docs | PARTIAL |
| Payment links, settlements | doc sections exist | PARTIAL |

Reusing a `merchantOrderId` that has moved past CREATED returns `BAD_REQUEST`: one id per attempt.

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

Events: `checkout.order.completed`, `checkout.order.failed`, `pg.refund.completed`, `pg.refund.failed`. Body `{event, payload:{state, orderId, merchantOrderId | originalMerchantOrderId, amount, paymentDetails}}`. Use `event` (old `type` field is deprecated) and `payload.state`. VERIFIED. Dedupe key: `event + merchantOrderId (+ merchantRefundId)`; no event id documented.

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

### Auth, amounts

- `https://api.stripe.com/v1`, `Authorization: Bearer sk_test_…|sk_live_…`, form-encoded bodies. Test vs live by key prefix. VERIFIED
- Integer minor units (paise for INR). VERIFIED
- Use the `Idempotency-Key` header on every POST (Stripe-native idempotency).
- Pin `Stripe-Version`. From API `2026-09-30.endive`, failed India mandates come back as `inactive` with `inactive_reason`. VERIFIED

### Exports

135+ presentment currencies on Visa/Mastercard; INR/USD on Amex. Non-INR needs extra onboarding info and transactions must be declared as exports (purpose codes, FIRC). PARTIAL. Customer name and billing address are required for export transactions (Stripe India docs). UNVERIFIED in this research.

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

### Status mapping (PaymentIntent)

| Stripe | Unified |
|---|---|
| `requires_payment_method` / `requires_confirmation` / `requires_action` | `created` |
| `processing` | `pending` (India recurring card debits sit here ~26h) |
| `requires_capture` | `authorized` |
| `succeeded` | `captured` |
| `canceled` | `cancelled` |
| charge `refunded` / `amount_refunded > 0` | `refunded` / `partially_refunded` |

Refunds: `POST /v1/refunds {payment_intent, amount?}`; status `pending|succeeded|failed|canceled|requires_action`.

### RBI e-mandate rules for recurring (VERIFIED https://docs.stripe.com/india-recurring-payments)

- Off-session India card/UPI payments need an e-mandate registered with AFA (3DS / UPI PIN).
- Pre-debit notification ≥24h before each debit; Stripe delays card charges 26h (PaymentIntent in `processing`).
- Each charge **> Rs 15,000 needs AFA**; UPI recurring > Rs 15,000 unsupported.
- Mandates cannot be updated or cancelled via the API.

### Sandbox test data (UNVERIFIED in this research)

- Test cards at https://docs.stripe.com/testing (`4242 4242 4242 4242` generic; India-specific cards and 3DS cards listed there). Use `stripe listen --forward-to localhost:3000/webhooks/stripe` (Stripe CLI) for local webhooks.

### Platforms

- Shopify (India store): not usable. WooCommerce: official "WooCommerce Stripe Payment Gateway" plugin, subject to the same invite-only account restriction.

---

## Skydo

### The short version

**Skydo has no public developer API.** No API docs, developer portal, webhooks or SDK found on skydo.com as of 2026-10-28. VERIFIED-ABSENT. Do not write code that calls a Skydo API; do not invent endpoints. If a user asks for a "Skydo integration", tell them this plainly.

Skydo's "single API integration" marketing refers to its bank-side Banking Circle partnership, not a customer API. A consultancy page claims webhooks/API reports; there is no official source. A third-party review calls Skydo a weak fit for SaaS needing developer APIs or custom checkout.

### What Skydo is for

Indian exporters, freelancers and agencies collecting **foreign** payments (USD, GBP, EUR, CAD, AUD and more) with lower FX fees, FIRA, and GST-compliant invoicing. Not domestic INR checkout.

### Integration options that exist (PARTIAL: https://www.skydo.com/ , https://skydo.com/blog/skydo-feature-update-zoho-integration , https://www.skydo.com/faqs/dashboard?q=faq-14)

- Dashboard payment links ("InstaLinks") the merchant creates by hand and sends to the client.
- "Global Bank Account" local receiving details (virtual accounts in US/UK/EU/CA/AU and more) for bank transfers.
- GST-compliant invoices with FIRA.
- Native Zoho Books integration: invoice sync, auto mark-paid.
- No Zapier, QuickBooks or Xero integration found.

### What to build in an app

1. Model a Skydo payment as `manual`: store an order with status `created`, a human-entered payment-link URL, and expected amount/currency.
2. Show the customer the link or the bank details.
3. Mark it paid **manually** (admin action with audit log) after the merchant sees the credit in the Skydo dashboard, or let Zoho Books be the source of truth if they use it.
4. No webhooks, no signature verification, no status API: there is nothing to verify programmatically. Say so in the UI ("payment confirmed manually").

In this MCP server every `skydo` feature is `unsupported` (including `createPayment`, which throws UNSUPPORTED with instructions to use InstaLinks or Global Bank Account details); its checkout type is `manual`. That is correct, not a gap.

### Alternatives if they need an API for foreign collections

Razorpay (international cards, if enabled), Stripe (invite-only in India, exports focus), PayU/CCAvenue (multi-currency on request). Each requires the merchant to enable international payments and handle export documentation.

### Platforms

Shopify / WooCommerce: none. VERIFIED-ABSENT

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
| Skydo | None | VERIFIED-ABSENT |

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
