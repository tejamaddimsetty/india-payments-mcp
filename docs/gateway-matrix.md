# Gateway matrix (deliverable C)

This is the per-gateway detail behind the README summary. The authoritative, machine-readable source is each adapter's `src/providers/<id>/capabilities.ts`, exposed through `payments_get_capabilities` and `payments://matrix`. The underlying facts, with sources and VERIFIED / PARTIAL / UNVERIFIED tags, are in [research/gateway-api-facts.md](research/gateway-api-facts.md). Facts were last verified on **2026-10-28**.

Support levels: **Yes** = supported, **Partial** = implemented with caveats, **Planned** = `not_implemented` (the gateway has it, we don't yet), **No** = `unsupported` (the gateway doesn't offer it).

---

## 1. At a glance

| | Razorpay | PayU | Cashfree | CCAvenue | Paytm | PhonePe | Stripe | Skydo |
|---|---|---|---|---|---|---|---|---|
| Checkout type | `js_sdk` (Checkout.js), redirect via `callback_url` | `form_post` | `js_sdk` (cashfree.js v3) | `form_post` (encrypted) | `js_sdk` (merchant JS), `form_post` fallback | `redirect` | `redirect` (Checkout Session) or `js_sdk` (Payment Element) | `manual` |
| Gateway amount unit | paise int | rupee string `"499.00"` | rupee number `499.00` | rupee string | rupee string | paise int | paise int | n/a |
| API auth | Basic `key_id:key_secret` | none (SHA-512 hash with salt) | `x-client-id` / `x-client-secret` / `x-api-version` | AES-encrypted `enc_request` + `access_code`, IP whitelist | Paytm checksum in `head.signature` | OAuth `client_credentials` → `O-Bearer` | Bearer secret key | none |
| Callback verification | HMAC-SHA256 (`order_id\|payment_id`) | SHA-512 reverse hash | status API (unsigned return) | decrypt `encResp` | `CHECKSUMHASH` | status API (unsigned redirect) | status API (unsigned redirect) | n/a |
| `verifiedVia` | `signature` | `signature` | `status_api` | `decryption` | `signature` | `status_api` | `status_api` | n/a |
| Webhook auth | `X-Razorpay-Signature` HMAC(raw body) | reverse hash in body | `x-webhook-signature` HMAC(ts + raw body), 5 min tolerance | decrypts `encResp` (no signature) | `CHECKSUMHASH` in form | `Authorization: sha256(user:pass)` (body **not** signed) | `Stripe-Signature` t/v1 HMAC, 300 s tolerance | n/a |
| Refunds | Yes (normal / optimum) | Yes | Yes (STANDARD / INSTANT) | Partial | Yes | Yes | Yes (no instant) | No |
| Refund status | Yes | Partial | Yes | Planned | Yes | Yes | Yes | No |
| Customers | Yes | No | Planned | No | No | No | Yes | No |
| Subscriptions | Yes | Planned | Planned | Planned | Planned | Planned | Partial | No |
| Settlements | Yes | Planned | Planned | Planned | Planned | Planned | Partial (payouts) | No |
| Payouts | Planned (RazorpayX) | Planned | Planned | Planned | Planned | No | Planned (Connect) | No |
| Payment links | Planned | Planned | Planned | Planned | Planned | Planned | Planned | No (dashboard only) |
| Currencies | INR + international (if enabled) | INR (intl. on a separate account) | INR (+ intl. if enabled) | INR + many | INR only | INR only | 135+ presentment | USD/GBP/EUR/... inbound only |
| Shopify | Official app | Official app | No-code integration advertised (PARTIAL) | Historically listed (UNVERIFIED) | None found | Official app | Not for India stores | None |
| WooCommerce | Official plugin | Plugin | n/a in map | Plugin via dashboard | n/a in map | Official plugin | Official plugin | n/a |

---

## 2. Razorpay

- **Checkout**: `POST /v1/orders` (`receipt` = orderRef, `notes.order_ref`), then `js_sdk` with `scriptUrl: https://checkout.razorpay.com/v1/checkout.js` and options `{ key, order_id, amount, currency, description, prefill, notes }`. If you pass `returnUrl`, the options also get `callback_url` + `redirect: true` and Razorpay POSTs the result to your URL.
- **Amounts**: integer paise, minimum 100.
- **Callback signature**: `hex(HMAC_SHA256(order_id + "|" + razorpay_payment_id, key_secret))`. Subscription authorisation reverses the order: `payment_id|subscription_id`. A valid signature yields `status: "authorized"`, and the payment becomes `captured` once auto-capture runs. If `orderRef` / `expectedAmount` are given, the adapter fetches the order and checks `receipt` and `amount`.
- **Status**: needs `providerOrderId` (`order_…`). It reads the order and its payments, preferring captured, then authorised, then latest.
- **Refunds**: `POST /v1/payments/{pay_id}/refund`. `speed: instant` maps to Razorpay's `optimum`. Needs `providerPaymentId`. Refund status needs `providerRefundId`.
- **Webhooks**: `X-Razorpay-Signature` = HMAC-SHA256 of the **raw body** with the **webhook secret**, which is not the key secret. Dedupe on `x-razorpay-event-id`. Events mapped: `payment.captured`/`order.paid` → `payment.succeeded`, `payment.failed`, `payment.authorized`, `refund.processed`/`failed`, `subscription.*`, `payment.dispute.created`, `settlement.processed`.
- **Constraints**: `receipt` ≤ 40 chars. `notes` ≤ 15 pairs. Enable auto-capture, or authorised payments auto-refund. One API host serves test and live; the key prefix decides which, and the adapter rejects mismatched prefixes.
- **Plugins**: official Shopify app ("All-in-one Razorpay Payment Gateway"), WooCommerce `woo-razorpay`.
- **Onboarding**: self-serve with KYC. Test keys are available immediately. Live activation needs business documents. Payouts (RazorpayX) is a separate activation with a current account, separate keys and IP allowlisting.

## 3. PayU India

- **Checkout**: no API call. The adapter builds a `form_post` to `https://test.payu.in/_payment` or `https://secure.payu.in/_payment` with `key, txnid (=orderRef), amount, productinfo, firstname, email, phone, surl, furl, udf1..udf5, hash` and optional address fields. `providerOrderId` is the txnid.
- **Amounts**: rupee string. The exact string in the form is the one hashed.
- **Request hash**: `sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)`.
- **Response hash**: `sha512([additional_charges|]SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)`.
- **Status**: postservice `verify_payment` with `var1 = txnid`. Postservice hash: `sha512(key|command|var1|SALT)`.
- **Refunds**: `cancel_refund_transaction`, `var1 = mihpayid` (providerPaymentId), `var2 = refundRef` (**≤ 23 chars**), `var3 = amount`. It cancels if the payment is only authorised and refunds if captured. Not auto-retried, because PayU's de-duplication on `token_id` isn't documented.
- **Refund status**: `check_action_status` with `providerRefundId`. PARTIAL: the command name comes from community SDKs, so parsing is defensive.
- **Webhooks**: the payment webhook carries the same reverse hash. Form-encoded and JSON bodies are both accepted. Dedupe id `mihpayid:status`. **Refund webhooks are not parsed**, so poll refund status.
- **Constraints**: `customer.name`, `email` and `phone` are required. `returnUrl` is required and must accept POST. Metadata is capped at 5 values (udf1-5). Test and live keys look identical, so make sure `PAYMENTS_MODE` matches the key.
- **Plugins**: official Shopify app (1PayU), WooCommerce plugin.
- **Onboarding**: self-serve with KYC. Test credentials come from the dashboard. Test-mode webhooks fire only for test transactions.

## 4. Cashfree PG

- **Checkout**: `POST /pg/orders` (`order_id` = orderRef, `customer_details`, `order_meta.return_url/notify_url`), then `js_sdk` with `scriptUrl: https://sdk.cashfree.com/js/v3/cashfree.js` and options `{ mode: "sandbox"|"production", paymentSessionId }`. `providerOrderId` is `cf_order_id`.
- **Amounts**: **rupees as a JSON number** (`499.00`), not paise. The adapter converts both ways. Minimum ₹1.
- **API version**: pinned `x-api-version: 2026-01-01`. Order creation is retried only when you pass `idempotencyKey`, which is sent as `x-idempotency-key`.
- **Callback**: the return URL carries only `order_id` and is unsigned. `verifyPayment` fetches the order and returns `valid: true` **only if it is paid**, and checks the amount.
- **Refunds**: `POST /pg/orders/{order_id}/refunds` with `refund_id` = refundRef, which de-duplicates, so it's retry-safe. STANDARD or INSTANT. Allowed only within **6 months** of the payment.
- **Webhooks**: `base64(HMAC_SHA256(x-webhook-timestamp + rawBody, client_secret))`, with **no separator**. Timestamps older than 5 minutes are rejected. Dedupe ids include refund status, because refund webhooks repeat per status change.
- **Constraints**: `customer_phone` is mandatory. `order_id` is 3-45 chars. Your checkout domain must be **whitelisted** in the Cashfree dashboard. The client secret is also the webhook key, so rotating it changes webhook verification.
- **Plugins**: no-code Shopify integration advertised (PARTIAL).
- **Onboarding**: self-serve sandbox. Production keys are separate and need KYC plus domain whitelisting.

## 5. CCAvenue

> CCAvenue publishes **no public API reference**. Most API details below are **UNVERIFIED** and come from integration kits and third-party copies of the dashboard-only PDF. Test everything in sandbox.

- **Checkout**: a `form_post` to `https://test.ccavenue.com/...` or `https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction` with fields `encRequest` (AES-128-CBC of the urlencoded order: key `md5(working_key)`, IV `0x00..0x0f`, hex output) and `access_code`. `returnUrl` is used as `redirect_url` and `cancel_url`.
- **Amounts**: rupee string, Numeric(12,2).
- **Callback**: CCAvenue POSTs `encResp`. Successful decryption with the working key is the only integrity check (`verifiedVia: "decryption"`). The adapter then checks `order_id` and the amount. **Always confirm with status before fulfilling.**
- **Status**: `DoWebTrans` `command=orderStatusTracker`, API version 1.2 (it may need 1.1) → Partial.
- **Refunds**: `command=refundOrder` with `reference_no` (tracking_id, providerPaymentId), `refund_amount`, `refund_ref_no`. Not auto-retried → Partial. Refund status: Planned.
- **Webhooks**: no documented signed webhook. `parseWebhook` decrypts an `encResp` form body (the redirect POST, or a Dynamic Event Notification configured to send it). Decryption alone is not authentication (AES-CBC has no MAC), so these events carry `bodyAuthenticated: false` and `createWebhookHandler` re-confirms them with the status API. Payment events only.
- **Constraints**: the server egress IP **must be whitelisted** (error 51407 = invalid access_code). The access code and working key are issued per registered domain. Test and live use different hosts **and** credentials. Some newer accounts may use an AES-256-GCM kit, so ask CCAvenue. Metadata is capped at 5 `merchant_param` slots.
- **Plugins**: WooCommerce plugin via dashboard downloads. Shopify listing UNVERIFIED.
- **Onboarding**: sales-assisted. Credentials and the API PDF live in the M.A.R.S. dashboard. Sandbox access may need a request to CCAvenue support (UNVERIFIED).

## 6. Paytm Payment Gateway

- **Hosts**: staging `securestage.paytmpayments.com`, production `secure.paytmpayments.com`. The old `securegw(-stage).paytm.in` hosts appear only in legacy docs.
- **Checkout**: `POST /theia/api/v1/initiateTransaction` → `txnToken` (**15 minutes**). It returns `js_sdk` with `scriptUrl: {host}/merchantpgpui/checkoutjs/merchants/{MID}.js` and options `{ root, flow: "DEFAULT", data: { orderId, token, tokenType: "TXN_TOKEN", amount }, fallbackRedirect }`. `fallbackRedirect` is a `showPaymentPage` form post for no-JS pages. Not auto-retried.
- **Amounts**: rupee string, 2 dp.
- **Checksum**: AES-128-CBC, IV `@@@@&&&&####$$$$`, the 16-byte merchant key, a 4-char salt. `sha256(params|salt)+salt`, then base64. JSON APIs sign `JSON.stringify(body)`. Callbacks sign the sorted values.
- **Callback**: an S2S/browser POST of form fields with `CHECKSUMHASH`. Verified with the merchant key. The MID must match.
- **Status**: `POST /v3/order/status`. **Business errors return HTTP 200** with `resultInfo.resultStatus` set to `F` / `TXN_FAILURE`, so check `resultInfo`.
- **Refunds**: `POST /refund/apply` with `txnId` (providerPaymentId) and `refId` = refundRef (de-duplicated, retry-safe). Refund status: `POST /v2/refund/status`.
- **Webhooks**: form key-values + `CHECKSUMHASH`. The URL is set in the dashboard. Payment events are verified. The refund notification shape isn't verified against docs → Partial.
- **Constraints**: orderId ≤ 50 chars. The merchant key must be exactly 16 bytes. `PAYTM_WEBSITE` is `WEBSTAGING` / `DEFAULT`. INR only.
- **Plugins**: no official Shopify app found.
- **Onboarding**: self-serve on paytmpayments.com. Staging MID and key come from the dashboard.

## 7. PhonePe PG (Standard Checkout v2)

- **Auth**: OAuth `client_credentials` (`client_id`, `client_secret`, `client_version`) → `Authorization: O-Bearer <token>`. The token is cached per gateway instance and refreshed before `expires_at` or after a 401. In production, OAuth (`/apis/identity-manager`) and payments (`/apis/pg`) are different hosts.
- **Checkout**: `POST /checkout/v2/pay` with `merchantOrderId` = orderRef and `paymentFlow.merchantUrls.redirectUrl` = returnUrl, giving `redirect` to the hosted PayPage. Not auto-retried, because re-using a progressed `merchantOrderId` is a BAD_REQUEST. `providerOptions.expireAfter` must be 300-3600 s.
- **Amounts**: paise, minimum 100 (payments and refunds).
- **Callback**: the redirect is **unsigned and carries no order id**. Pass `orderRef` to `verifyPayment`, which calls Order Status (`verifiedVia: "status_api"`). Here `valid: true` means the lookup succeeded and matched. **Check `status === "captured"` before fulfilling.**
- **Refunds**: `POST /payments/v2/refund` with `merchantRefundId` = refundRef (de-duplicated, retry-safe). Status: `GET /payments/v2/refund/{merchantRefundId}/status`.
- **Webhooks**: `Authorization` must equal `hex(sha256(username + ":" + password))`, configured in the dashboard. This is a **static shared secret that doesn't cover the body**, so always confirm with `payments_get_status`. The newer `x-phonepe-checksum-*` HMAC headers aren't implemented (undocumented algorithm). Events: `checkout.order.completed/failed`, `pg.refund.completed/failed`.
- **Constraints**: `merchantOrderId` ≤ 63 chars. Legacy v1 (X-VERIFY + salt key) is **not supported**. INR only.
- **Plugins**: official Shopify app, WooCommerce plugin.
- **Onboarding**: the Business Dashboard provides production credentials. **Sandbox credentials and webhook setup come from the PhonePe integration team.**

## 8. Stripe (India)

- **Availability**: **invite-only for Indian businesses** (since about May 2024), for registered entities only. Treat it as the exports / international adapter.
- **Checkout**: by default `POST /v1/checkout/sessions` (`client_reference_id` = orderRef, `billing_address_collection: required`) → `redirect` to `session.url`. `returnUrl` is required. With `providerOptions.flow = "payment_intent"` it creates a PaymentIntent instead and returns `js_sdk` with `{ publishableKey, clientSecret }` for the Payment Element (this needs `STRIPE_PUBLISHABLE_KEY`). Every POST carries an `Idempotency-Key`, so POSTs are retry-safe. The default key is `checkout_session:<orderRef>`.
- **Amounts**: minor units. Currency is sent lowercase. API version pinned `2025-03-31.basil`.
- **Callback**: the redirect carries `session_id` / `payment_intent`, unsigned. `verifyPayment` re-fetches it and checks orderRef and amount. It returns `valid: true` only when the payment is complete.
- **Refunds**: `POST /v1/refunds` with `Idempotency-Key` = refundRef. `reason` only accepts `duplicate | fraudulent | requested_by_customer`, and other reasons go to metadata. There's no instant speed.
- **Webhooks**: `Stripe-Signature: t=..,v1=..`. HMAC-SHA256 of `t + "." + rawBody` with `whsec_…`, compared against every `v1`, with a 300 s tolerance. Dedupe on `evt_…`.
- **Subscriptions (Partial)**: Checkout `mode=subscription`. `providerSubscriptionId` is the `cs_…` Session id until the customer completes Checkout. The `sub_…` id arrives by webhook.
- **Settlements (Partial)**: mapped to `GET /v1/payouts` (net of fees).
- **RBI e-mandate**: a pre-debit notification ≥ 24 h before each debit (Stripe holds card charges about 26 h). Each charge above ₹15,000 needs fresh AFA. UPI recurring above ₹15,000 isn't supported.
- **Plugins**: not usable for India Shopify stores. WooCommerce official plugin.

## 9. Skydo

- **No public developer API, SDK or webhooks** (checked 2026-10-28). Every feature is `unsupported`, so calls fail with `UNSUPPORTED` before any network activity and the error includes guidance.
- **What it is**: cross-border collections for exporters and freelancers (local receiving accounts abroad, InstaLinks payment links, FIRA, GST invoicing). It doesn't accept domestic UPI or cards.
- **Integration options**: dashboard InstaLinks, receiving-account details on invoices, native Zoho Books sync.
- **Recommendation**: Skydo for invoices plus Razorpay International, PayU, CCAvenue or Stripe for automated international checkout. `payments_recommend_gateway` with `exporter_collections` surfaces this.

---

## 10. Shopify, in one paragraph

Shopify Payments isn't available to India-based stores, and only approved Shopify partners can build payment extensions (custom ones are limited to eligible Plus merchants). **This project can't be a Shopify checkout gateway.** Install the gateway's own Shopify app (Razorpay, PayU and PhonePe have official ones). Use this server alongside it for status, refunds and reconciliation through the gateway's API, provided the orders were created through that gateway account.
