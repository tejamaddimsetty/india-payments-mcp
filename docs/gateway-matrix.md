# Gateway matrix (deliverable C)

This is the per-gateway detail behind the README summary. The authoritative, machine-readable source is each adapter's `src/providers/<id>/capabilities.ts`, exposed through `payments_get_capabilities` and `payments://matrix`. The underlying facts, with sources and VERIFIED / PARTIAL / UNVERIFIED tags, are in [research/gateway-api-facts.md](research/gateway-api-facts.md), and the line-by-line checks of each adapter against the official docs are in [research/verification/](research/verification/). Capability maps were last verified on **2026-10-28 or 2026-10-29** (`lastVerified` per gateway). No adapter has been run against a live sandbox yet.

Support levels: **Yes** = supported, **Partial** = implemented with caveats, **Planned** = `not_implemented` (the gateway has it, we don't yet), **No** = `unsupported` (the gateway doesn't offer it).

---

## 1. At a glance

| | Razorpay | PayU | Cashfree | CCAvenue | Paytm | PhonePe | Stripe | Skydo |
|---|---|---|---|---|---|---|---|---|
| Checkout type | `js_sdk` (Checkout.js), redirect via `callback_url` | `form_post` | `js_sdk` (cashfree.js v3) | `form_post` (encrypted) | `js_sdk` (merchant JS), `form_post` fallback | `redirect` | `redirect` (Checkout Session) or `js_sdk` (Payment Element) | `manual` (Zoho invoice link or bank-transfer instructions) |
| Gateway amount unit | paise int | rupee string `"499.00"` | rupee number `499.00` | rupee string | rupee string | paise int | paise int | minor units of the invoice currency; Zoho invoices take decimal major units |
| API auth | Basic `key_id:key_secret` | none (SHA-512 hash with salt) | `x-client-id` / `x-client-secret` / `x-api-version` | AES-encrypted `enc_request` + `access_code`, IP whitelist | Paytm checksum in `head.signature` | OAuth `client_credentials` → `O-Bearer` | Bearer secret key | no Skydo API. Zoho bridge: Zoho OAuth refresh token |
| Callback verification | HMAC-SHA256 (`order_id\|payment_id`, with the order id you stored) | SHA-512 reverse hash | status API (unsigned return) | decrypt `encResp` (+ status API) | `CHECKSUMHASH` | status API (unsigned redirect) | status API (unsigned redirect) | no callback: reads the Zoho invoice or the ledger |
| `verifiedVia` | `signature` | `signature` | `status_api` | `decryption`, upgraded to `status_api` by `PaymentsClient` | `signature` | `status_api` | `status_api` | `status_api` (Zoho) / `manual_record` (ledger) |
| Webhook auth | `X-Razorpay-Signature` HMAC(raw body) | reverse hash in body | `x-webhook-signature` HMAC(ts + raw body); accepts timestamps up to 24 h old | decrypts `encResp` (cbc: no MAC; gcm: auth tag) | `CHECKSUMHASH` in form (payments); `head.signature` (refunds) | `Authorization: sha256(user:pass)` (body **not** signed) | `Stripe-Signature` t/v1 HMAC, 300 s tolerance | none (no webhooks) |
| Refunds | Yes (normal / optimum) | Yes | Yes (STANDARD / INSTANT) | Partial | Yes | Yes | Yes (no instant) | No |
| Refund status | Yes | Yes | Yes | Planned | Yes | Yes | Yes | No |
| Customers | Yes | No | Planned | No | No | No | Yes | No |
| Subscriptions | Yes | Planned | Planned | Planned | Planned | Planned | Partial | No |
| Settlements | Yes | Planned | Planned | Planned | Planned | Planned | Partial (payouts) | No |
| Payouts | Planned (RazorpayX) | Planned | Planned | Planned | Planned | No | Planned (Connect) | No |
| Payment links | Planned | Planned | Planned | Planned | Planned | Planned | Planned | No (dashboard only) |
| Currencies | INR + international (if enabled) | INR (intl. on a separate account) | INR (+ intl. if enabled) | INR + many | INR only | INR only | 135+ presentment | USD, GBP, EUR, CAD, AUD, AED, SGD local + SWIFT; **not INR** |
| Shopify | Official payment provider | Listed payment provider | No-code integration advertised (PARTIAL) | Historically listed (UNVERIFIED) | None found | Official app | Not for India stores | None |
| WooCommerce | Official plugin | Plugin | n/a in map | Plugin via dashboard | n/a in map | Official plugin | Official plugin | n/a |

---

## 2. Razorpay

- **Checkout**: `POST /v1/orders` (`receipt` = orderRef, `notes.order_ref`), then `js_sdk` with `scriptUrl: https://checkout.razorpay.com/v1/checkout.js` and options `{ key, order_id, amount, currency, name, description, prefill, notes }`. `name` is mandatory in Razorpay's docs: it comes from `RAZORPAY_MERCHANT_NAME` (default "Payment"). If you pass `returnUrl`, the options also get `callback_url` + `redirect: true` and Razorpay POSTs the result to your URL.
- **Amounts**: integer paise, minimum 100.
- **Callback signature**: `hex(HMAC_SHA256(order_id + "|" + razorpay_payment_id, key_secret))`. Subscription authorisation reverses the order: `payment_id|subscription_id`. Razorpay's docs say to use the order id **you stored**, not the one Checkout returns, so pass it as `providerOrderId` (MCP: `provider_order_id`). Without `providerOrderId` or `orderRef` the callback is rejected. A valid signature yields `status: "authorized"`, and the payment becomes `captured` once auto-capture runs. If `orderRef` / `expectedAmount` are given, the adapter fetches the order and checks `receipt` and `amount`.
- **Status**: needs `providerOrderId` (`order_…`). It reads the order and its payments, preferring captured, then authorised, then latest.
- **Refunds**: `POST /v1/payments/{pay_id}/refund`. `speed: instant` maps to Razorpay's `optimum`. Needs `providerPaymentId`. Refund status needs `providerRefundId`.
- **Webhooks**: `X-Razorpay-Signature` = HMAC-SHA256 of the **raw body** with the **webhook secret**, which is not the key secret. Dedupe on `x-razorpay-event-id`. Events mapped: `payment.captured`/`order.paid` → `payment.succeeded`, `payment.failed`, `payment.authorized`, `refund.processed`/`failed`, `subscription.*`, `payment.dispute.created`, `settlement.processed`.
- **Subscriptions**: plans + subscriptions; the customer authorises the mandate through Checkout with `subscription_id`. Needs `totalCount` or `providerOptions.end_at`. Daily plans need `interval >= 7`. `customer_id` is not a create-subscription parameter (Razorpay fills it after authorisation), so the adapter keeps your customer id in `notes.customer_id`.
- **Payment methods** (`method` on the payment entity): `upi`, `card`, `netbanking`, `wallet`, `emi`, `paylater`.
- **Constraints**: `receipt` ≤ 40 chars; a second order with the same receipt is rejected as a duplicate, and the adapter then returns the existing order if amount and currency match. `notes` ≤ 15 pairs. Enable auto-capture, or authorised payments auto-refund. One API host serves test and live; the key prefix decides which, and the adapter rejects mismatched prefixes.
- **Plugins**: official Shopify app ("All-in-one Razorpay Payment Gateway"), WooCommerce `woo-razorpay`.
- **Onboarding**: self-serve with KYC. Test keys are available immediately. Live activation needs business documents. Payouts (RazorpayX) is a separate activation with a current account, separate keys and IP allowlisting.

## 3. PayU India

- **Checkout**: no API call. The adapter builds a `form_post` to `https://test.payu.in/_payment` or `https://secure.payu.in/_payment` with `key, txnid (=orderRef), amount, productinfo, firstname, email, phone, surl, furl, udf1..udf5, hash` and optional address fields. `providerOrderId` is the txnid.
- **Amounts**: rupee string. The exact string in the form is the one hashed.
- **Request hash**: `sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)`.
- **Response hash**: `sha512([additional_charges|]SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)`.
- **Status**: postservice `verify_payment` with `var1 = txnid`. Postservice hash: `sha512(key|command|var1|SALT)`.
- **Refunds**: `cancel_refund_transaction`, `var1 = mihpayid` (providerPaymentId), `var2 = refundRef` (**≤ 23 chars**), `var3 = amount`. It cancels if the payment is only authorised and refunds if captured. Not auto-retried: PayU rejects a reused `token_id` (error 106) instead of returning the earlier refund, so on `OUTCOME_UNKNOWN` check refund status and retry with a new refundRef.
- **Refund status**: `check_action_status` with `var1 = request_id` (`providerRefundId`), as in the PayU docs and the official PHP SDK. Both documented response shapes are parsed (nested `transaction_details.{request_id}.{request_id}` and flat `{refund_status, refund_amount}`); `QUEUED` / `REQUESTED` / `IN PROGRESS` / `processing` / `od_hit` map to pending.
- **Webhooks**: the payment webhook carries the same reverse hash. Form-encoded and JSON bodies are both accepted. Dedupe id `mihpayid:status`. **Refund webhooks are not parsed**, so poll refund status.
- **Constraints**: `txnid` (orderRef) ≤ 25 chars and unique per attempt. Field limits are enforced before the form is built (productinfo 100, firstname 60, email 50, udf1..udf5 255; see the capability constraints for the full list). `customer.name`, `email` and `phone` are required. `returnUrl` is required and must accept POST. Metadata is capped at 5 values (udf1-5). Test and live keys look identical, so make sure `PAYMENTS_MODE` matches the key. Omitting a refund amount refunds the original amount: after a partial refund, always pass the remaining amount.
- **Plugins**: official Shopify app (1PayU), WooCommerce plugin.
- **Onboarding**: self-serve with KYC. Test credentials come from the dashboard. Test-mode webhooks fire only for test transactions.

## 4. Cashfree PG

- **Checkout**: `POST /pg/orders` (`order_id` = orderRef, `customer_details`, `order_meta.return_url/notify_url`), then `js_sdk` with `scriptUrl: https://sdk.cashfree.com/js/v3/cashfree.js` and options `{ mode: "sandbox"|"production", paymentSessionId }`. `providerOrderId` is `cf_order_id`.
- **Amounts**: **rupees as a JSON number** (`499.00`), not paise. The adapter converts both ways. Minimum ₹1.
- **API version**: pinned `x-api-version: 2026-01-01`. Order creation is retried only when you pass `idempotencyKey`, which is sent as `x-idempotency-key`.
- **Callback**: the return URL carries only `order_id` and is unsigned. `verifyPayment` fetches the order and returns `valid: true` **only if it is paid**, and checks the amount.
- **Refunds**: `POST /pg/orders/{order_id}/refunds` with `refund_id` = refundRef (3-40 chars, validated before the call). Retries send `x-idempotency-key`, a UUID derived from orderRef + refundRef. STANDARD or INSTANT. Allowed only within **6 months** of the payment.
- **Webhooks**: `base64(HMAC_SHA256(x-webhook-timestamp + rawBody, client_secret))`, with **no separator**. Cashfree documents no replay window and retries at 2, 10 and 30 minutes, so timestamps up to 24 h old (and up to 5 minutes in the future) are accepted and duplicates are dropped by event-id dedupe. Payment, refund, auto-refund (`data.auto_refund`) and `DISPUTE_CREATED` events are normalised; `DISPUTE_UPDATED` / `DISPUTE_CLOSED` arrive as type `unknown`.
- **Constraints**: `customer_phone` is mandatory. `order_id` is 3-45 chars. `customer_id` is 3-50 alphanumeric characters (derived from a hash of the phone if you pass none). `x-idempotency-key` must be a UUID, so other keys are mapped to one deterministically. Your checkout domain must be **whitelisted** in the Cashfree dashboard. The client secret is also the webhook key, so rotating it changes webhook verification. The key-prefix guard is a heuristic: Cashfree does not document key prefixes.
- **Plugins**: no-code Shopify integration advertised (PARTIAL).
- **Onboarding**: self-serve sandbox. Production keys are separate and need KYC plus domain whitelisting.

## 5. CCAvenue

> CCAvenue publishes **no public API reference**. Most API details below are **UNVERIFIED** and come from integration kits and third-party copies of the dashboard-only PDF. Test everything in sandbox.

- **Encryption kits** (`CCAVENUE_ENCRYPTION`): CCAvenue's NodeJS kit ships two. `cbc` (default): AES-128-CBC, key `md5(working_key)` as 16 raw bytes, fixed IV `0x00..0x0f`, PKCS#7, hex. `gcm`: AES-256-GCM, the 32-character working key used directly, random 12-byte IV, output `hex(iv) + hex(ciphertext || tag)`. Use the kit CCAvenue assigned your account; ask them before going live.
- **Checkout**: a `form_post` with fields `encRequest` (the encrypted urlencoded order) and `access_code`, to `https://{test|secure}.ccavenue.com/transaction/transaction.do?command=initiateTransaction` (cbc) or `.../gTransaction.do?command=initiateTransaction` (gcm). `returnUrl` is used as `redirect_url` and `cancel_url`. `billing_country` is sent as a country name; ISO alpha-2 codes are mapped.
- **Amounts**: rupee string, Numeric(12,2).
- **Callback**: CCAvenue POSTs `encResp`. With the cbc kit, decryption is not authentication (AES-CBC has no MAC, so blocks can be spliced or bit-flipped); the gcm tag does authenticate. Either way `PaymentsClient.verifyPayment` confirms the result with the status API before setting `paid` (`verifiedVia` becomes `status_api`).
- **Status**: `DoWebTrans` `command=orderStatusTracker`, version 1.2 (third-party implementations use 1.2 and 1.1). Fields come from the official PHP kit sample and third-party clients → Partial, UNVERIFIED. Whether the API also uses GCM for gcm-kit accounts is UNVERIFIED.
- **Refunds**: `command=refundOrder`, version 1.1, with `reference_no` (tracking_id, providerPaymentId), `refund_amount`, `refund_ref_no`. A repeated `refund_ref_no` is rejected, not de-duplicated, so it is not auto-retried → Partial. Refund status: Planned (`getRefundDetails` exists per third-party code).
- **Webhooks**: no documented signed webhook. `parseWebhook` decrypts an `encResp` form body (the redirect POST, or a Dynamic Event Notification configured to send it). These events carry `bodyAuthenticated: false`, and `createWebhookHandler` re-confirms them with the status API. Only Order Status events are parsed (Order Refund Status and Order Risk Status payloads are undocumented).
- **Constraints**: the server egress IP must be whitelisted for API calls (per merchant setup guides). Error codes such as `enc_error_code` are passed through unmapped. The access code and working key are issued per registered domain. Test and live use different hosts **and** credentials. Metadata is capped at 5 `merchant_param` slots.
- **Plugins**: WooCommerce plugin via dashboard downloads. Shopify listing UNVERIFIED.
- **Onboarding**: sales-assisted. Credentials and the API PDF live in the M.A.R.S. dashboard. Sandbox access may need a request to CCAvenue support (UNVERIFIED).

## 6. Paytm Payment Gateway

- **Hosts**: checkout and order status on staging `securestage.paytmpayments.com` / production `secure.paytmpayments.com`. Refund apply and refund status on `securegw-stage.paytmpayments.in` / `securegw.paytmpayments.in`. The old `securegw(-stage).paytm.in` hosts appear only in legacy docs.
- **Checkout**: `POST /theia/api/v1/initiateTransaction` → `txnToken` (**15 minutes**). It returns `js_sdk` with `scriptUrl: {host}/merchantpgpui/checkoutjs/merchants/{MID}.js` and options `{ root, flow: "DEFAULT", data: { orderId, token, tokenType: "TXN_TOKEN", amount }, fallbackRedirect }`. `fallbackRedirect` is a `showPaymentPage` form post for no-JS pages. Not auto-retried.
- **Amounts**: rupee string, 2 dp.
- **Checksum**: AES-128-CBC, IV `@@@@&&&&####$$$$`, the 16-byte merchant key, a 4-char salt. `sha256(params|salt)+salt`, then base64. JSON APIs sign `JSON.stringify(body)`. Callbacks sign the sorted values.
- **Callback**: an S2S/browser POST of form fields with `CHECKSUMHASH`. Verified with the merchant key. The MID must match.
- **Status**: `POST /v3/order/status`. **Business errors return HTTP 200** with `resultInfo.resultStatus` set to `F` / `TXN_FAILURE`, so check `resultInfo`. Lookup errors (330 / 334 / 335) throw instead of reporting a failed payment; 501 throws `PROVIDER_UNAVAILABLE`. `head.signature` on API responses is verified when present.
- **Refunds**: `POST /refund/apply` with `txnId` (providerPaymentId) and `refId` = refundRef (≤ 50 chars). A retry that hits a duplicate-refId error (617/671) returns the existing refund via refund status; 626 (another refund in progress) is `PROVIDER_UNAVAILABLE`, so retry later with the same refundRef. Refund status: `POST /v2/refund/status`.
- **Webhooks**: payment notifications are form key-values + `CHECKSUMHASH`; refund notifications are JSON `{head:{signature}, body}`. Both are always verified and normalised: Success Refund → `refund.processed`, Accept Refund SUCCESS → `unknown` (accepted, not yet initiated), Accept Refund FAILED → `refund.failed`. Partial, because the unsigned Success Refund FAILED sample is rejected: poll refund status for those failures. The URL is set in the dashboard.
- **Constraints**: orderId ≤ 50 chars of letters, digits and `@ - _ .`. `userInfo.mobile` is sent only as 10 digits. API-response signature checks can be turned off with `PAYTM_VERIFY_RESPONSE_SIGNATURE=false` (never for webhooks). `custId` is sanitised to Paytm's allowed characters. Payment modes are normalised (`CC`/`DC` → card, `NB` → netbanking, `PPI` → wallet, `PAYTMCC` → paylater). The merchant key must be exactly 16 bytes. `PAYTM_WEBSITE` is `WEBSTAGING` / `DEFAULT`. INR only.
- **Plugins**: no official Shopify app found.
- **Onboarding**: self-serve on paytmpayments.com. Staging MID and key come from the dashboard.

## 7. PhonePe PG (Standard Checkout v2)

- **Auth**: OAuth `client_credentials` (`client_id`, `client_secret`, `client_version`) → `Authorization: O-Bearer <token>`. The token is cached per gateway instance and refreshed before `expires_at` or after a 401. In production, OAuth (`/apis/identity-manager`) and payments (`/apis/pg`) are different hosts.
- **Checkout**: `POST /checkout/v2/pay` with `merchantOrderId` = orderRef and `paymentFlow.merchantUrls.redirectUrl` = returnUrl, giving `redirect` to the hosted PayPage. Not auto-retried: reuse of a `merchantOrderId` is not documented and is assumed to be rejected, so use a fresh orderRef per attempt. `providerOptions.expireAfter` must be 300-3600 s. `metaInfo` limits (udf1..udf10 ≤ 256 chars; udf11..udf15 ≤ 50 chars of a restricted charset) are validated before the call; free-form metadata fills udf1..udf10.
- **Amounts**: paise, minimum 100 (payments and refunds).
- **Callback**: the redirect is **unsigned and carries no order id**. Pass `orderRef` to `verifyPayment`, which calls Order Status (`verifiedVia: "status_api"`). Here `valid: true` means the lookup succeeded and matched. **Check `status === "captured"` before fulfilling.**
- **Refunds**: `POST /payments/v2/refund` with `merchantRefundId` = refundRef. Retries are treated as safe on the assumption that `merchantRefundId` de-duplicates; PhonePe does not document this. Status: `GET /payments/v2/refund/{merchantRefundId}/status`.
- **Webhooks**: `Authorization` must equal `hex(sha256(username + ":" + password))`, configured in the dashboard. This is a **static shared secret that doesn't cover the body**, so always confirm with `payments_get_status`. The newer `x-phonepe-checksum-*` HMAC headers aren't implemented (undocumented algorithm). Events: `checkout.order.completed/failed`, `pg.refund.completed/failed`. Some documented refund samples are flat (no `event`/`payload` wrapper); those are read from the top-level body.
- **Constraints**: `merchantOrderId` ≤ 63 chars. `PHONEPE_CLIENT_VERSION` is the value shown with your credentials (or shared by PhonePe for sandbox). Legacy v1 (X-VERIFY + salt key) is **not supported**. INR only.
- **Plugins**: official Shopify app, WooCommerce plugin.
- **Onboarding**: the Business Dashboard provides production credentials. **Sandbox credentials and webhook setup come from the PhonePe integration team.**

## 8. Stripe (India)

- **Availability**: **invite-only for Indian businesses** (since about May 2024), for registered entities only. Treat it as the exports / international adapter.
- **Payment methods**: Indian Stripe accounts accept **cards**. UPI is not offered to India-domiciled accounts (India is not in Stripe's UPI business locations); it is for Stripe accounts outside India charging Indian customers.
- **Export rules**: each export charge needs a description and the customer's name and billing address. The adapter sends `payment_intent_data.description` and sets `billing_address_collection: required` on Checkout; for the PaymentIntent flow, pass billing details into `stripe.confirmPayment`.
- **Checkout**: by default `POST /v1/checkout/sessions` (`client_reference_id` = orderRef, `billing_address_collection: required`) → `redirect` to `session.url`. `returnUrl` is required. With `providerOptions.flow = "payment_intent"` it creates a PaymentIntent instead and returns `js_sdk` with `{ publishableKey, clientSecret }` for the Payment Element (this needs `STRIPE_PUBLISHABLE_KEY`). Every POST carries an `Idempotency-Key`, so POSTs are retry-safe. The default key is `checkout_session:<orderRef>`.
- **Amounts**: minor units. Currency is sent lowercase. API version pinned `2025-03-31.basil`.
- **Callback**: the redirect carries `session_id` / `payment_intent`, unsigned. `verifyPayment` re-fetches it and checks orderRef and amount. It returns `valid: true` only when the payment is complete.
- **Idempotency**: `Idempotency-Key` ≤ 255 chars and `client_reference_id` ≤ 200 chars (longer values fail with `VALIDATION`). Keys expire after 24 h. Stripe replays the saved response for a reused key, including a 500, so after a 5xx check status before re-submitting with a new key.
- **Refunds**: `POST /v1/refunds` with `Idempotency-Key` = refundRef. `reason` only accepts `duplicate | fraudulent | requested_by_customer`, and other reasons go to metadata. There's no instant speed.
- **Webhooks**: `Stripe-Signature: t=..,v1=..`. HMAC-SHA256 of `t + "." + rawBody` with `whsec_…`, compared against every `v1`, with a 300 s tolerance. Dedupe on `evt_…` (refund events on `refund:<re_id>:<status>`). Subscribe to `refund.created`, `refund.updated` and `refund.failed`: a refund can be created already `succeeded`. `charge.refunded` fires when a refund is created (it may still be pending, and `amount_refunded` is cumulative), so it is reported as type `unknown`.
- **Uncaptured payments**: a PaymentIntent in `requires_capture` cannot be refunded, so a refund cancels it instead (same Idempotency-Key) and reports `processed` (full amount only, no `re_` id).
- **Physical-goods exports** also need a shipping address: pass `providerOptions.shipping_address_collection` on Checkout (or `shipping` on the PaymentIntent).
- **Subscriptions (Partial)**: Checkout `mode=subscription`. `providerSubscriptionId` is the `cs_…` Session id until the customer completes Checkout. The `sub_…` id arrives by webhook.
- **Settlements (Partial)**: mapped to `GET /v1/payouts` (net of fees).
- **RBI e-mandate**: a pre-debit notification ≥ 24 h before each debit (Stripe holds card charges about 26 h). Each charge above ₹15,000 needs fresh AFA. UPI recurring above ₹15,000 isn't supported.
- **Plugins**: not usable for India Shopify stores. WooCommerce official plugin.

## 9. Skydo

Full guide: [skydo.md](skydo.md).

- **No public developer API, SDK or webhooks** (checked 2026-10-29). An API has been on Skydo's roadmap since December 2025. Skydo's Terms of Use prohibit automated access to the platform, so the adapter never contacts Skydo.
- **What it is**: cross-border collections for exporters and freelancers: local receiving accounts abroad (USD, GBP, EUR, CAD, AUD, AED, SGD; 32 currencies via the SWIFT account), settled to INR with a FIRA. It does not accept INR, UPI or cards.
- **Zoho Books bridge** (all six `ZOHO_*` variables): `createPayment` creates a Zoho Books invoice with `reference_number` = orderRef (idempotent on that reference) and marks it sent. Skydo's native integration imports it within ~10 minutes, and when the money arrives marks it paid and attaches the FIRA. Status comes from the full Zoho invoice: `paid` → `captured` only when payments cover the total (a write-off gives `failed`, a credit-note closure `unknown`), `partially_paid` → `pending`, `void` → `cancelled`, `draft`/`sent`/`viewed`/`unpaid`/`overdue` → `created`. An invoice whose reference is not the orderRef is refused. Skydo does not document importing API-created invoices specifically: confirm with one real invoice. Data centers: com, eu, in, com.au, jp, ca, com.cn, sa, ae, uk, sg.
- **Receiving accounts + ledger** (`SKYDO_RECEIVING_ACCOUNTS`): `createPayment` returns bank-transfer instructions for the account matching the currency (or the `"*"` fallback), with the orderRef as payment reference, and adds an entry to a JSON ledger (`SKYDO_LEDGER_FILE`). Receipts are recorded with `payments_skydo_record_payment` after a human checks them (idempotent per `receipt_id`; live mode needs the double gate); short receipts stay `pending`. The ledger file is locked per change, so your app and the MCP server can share it.
- **Rules**: `currency` is required and INR is rejected; USD payments must be at least USD 50 (`5000`), other currencies the equivalent (not enforced). No refunds, webhooks, customers, subscriptions, settlements, payouts or API payment links (InstaLinks are dashboard-only and single-use). No Skydo sandbox: `sandbox` mode with `ZOHO_*` set creates real Zoho invoices.
- **Recommendation**: Skydo for bank-transfer invoices; for card payments from international customers, a gateway that offers them (Razorpay International, PayU, CCAvenue, or Stripe, which is invite-only in India). `payments_recommend_gateway` with `exporter_collections` surfaces this.

---

## 10. Shopify, in one paragraph

Shopify Payments isn't available to India-based stores, and only approved Shopify partners can build payment extensions (custom ones are limited to eligible Plus merchants). **This project can't be a Shopify checkout gateway.** Install the gateway's own Shopify app (Razorpay, PayU and PhonePe have official ones). Use this server alongside it for status, refunds and reconciliation through the gateway's API, provided the orders were created through that gateway account.
