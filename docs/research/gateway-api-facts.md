# Indian payment gateways: verified API facts

Researched 2026-10-28 from official docs, plus vendor source code where noted. Every fact below falls into one of these categories:

- **VERIFIED**: read on the official doc page cited, or in the vendor's own open-source library.
- **PARTIAL**: the official page confirms part of the fact, and the rest comes from search snippets or a second official page.
- **UNVERIFIED**: no official source was found. This covers widely repeated community knowledge. Test it in sandbox before relying on it.

Unless noted, every integration below uses plain `fetch`, JSON bodies, and server-side secrets. Compare HMACs and hashes with `crypto.timingSafeEqual`.

---

## 0. Cross-gateway summary

| Gateway | Auth | Amount unit | Client checkout | Callback signature | Webhook signature |
|---|---|---|---|---|---|
| Razorpay | HTTP Basic `key_id:key_secret` | integer **paise** | `checkout.js` modal | HMAC-SHA256 hex, key_secret | `X-Razorpay-Signature` = HMAC-SHA256 hex (raw body, webhook secret) |
| PayU India | none (key + SHA-512 hash in form) | **rupees string** (`"10.00"`) | HTML **form POST** to `/_payment` | SHA-512 reverse hash | Webhook carries the same reverse `hash` field (PARTIAL) |
| Cashfree PG | `x-client-id`, `x-client-secret`, `x-api-version: 2026-01-01` | **rupees decimal** (`10.15`) | `cashfree.js` v3 using `payment_session_id` | none (re-fetch order) | `x-webhook-signature` = base64(HMAC-SHA256(timestamp + rawBody, client_secret)) |
| CCAvenue | `access_code` + AES-encrypted payload, plus IP whitelisting | **rupees decimal** | HTML **form POST** (`encRequest`, `access_code`) | decrypt `encResp` (encryption is the integrity check) | UNVERIFIED |
| Paytm PG | `head.signature` (Paytm checksum, AES-128-CBC) | **rupees string** in `txnAmount.value` | Merchant-specific JS: `/merchantpgpui/checkoutjs/merchants/{MID}.js` | `CHECKSUMHASH` checked with the checksum library | same `CHECKSUMHASH` scheme (form key-value S2S) |
| PhonePe PG v2 | OAuth `client_credentials` → `Authorization: O-Bearer <token>` | integer **paise** | redirect to `redirectUrl`, or iframe via `PhonePeCheckout.transact` | none (call Order Status) | `Authorization` = SHA256(`username:password`). Newer pages also describe HMAC headers (see 6) |
| Stripe (IN) | Bearer secret key | integer minor units (paise) | Checkout Sessions / Payment Element | n/a | `Stripe-Signature: t=..,v1=..` HMAC-SHA256(t + "." + body) |
| Skydo | **No public developer API found** | n/a | Dashboard "InstaLinks" payment links | n/a | n/a |

---

## 1. Razorpay

Docs: https://razorpay.com/docs/api/ · Integration steps: https://razorpay.com/docs/payments/server-integration/nodejs/integration-steps/

| Item | Fact | Status |
|---|---|---|
| Base URL | `https://api.razorpay.com/v1`. Test and live use the **same host**; the mode is set by the key pair (`rzp_test_…` / `rzp_live_…`) | VERIFIED (host in every API page) |
| Auth | HTTP Basic `key_id:key_secret`. Partners add `X-Razorpay-Account: <merchant acc id>` | VERIFIED |
| Create order | `POST /v1/orders` with `{amount, currency, receipt?, notes?, partial_payment?}` → `{id: "order_…", status: "created", amount, amount_due, …}` | VERIFIED (via integration guide) |
| Amount | Smallest currency subunit: ₹299 → `29900`. Zero-decimal (JPY) and 3-decimal (KWD) currencies differ | VERIFIED |
| Payment fetch / status | `GET /v1/payments/{id}`, `GET /v1/orders/{id}/payments` | UNVERIFIED (standard, page not re-fetched) |
| Refund | `POST /v1/payments/{payment_id}/refund` with `{amount?, speed?: "normal" \| "optimum", notes?, receipt?}`. Omit `amount` for a full refund | VERIFIED https://razorpay.com/docs/api/refunds/create-normal/ |
| Refund status | `GET /v1/payments/{payment_id}/refunds/{refund_id}`. `status` ∈ `pending \| processed \| failed`, plus `speed_processed`. `acquirer_data` carries RRN/ARN/UTR | VERIFIED https://razorpay.com/docs/api/refunds/fetch-specific-refund-payment/ |
| Client checkout | `<script src="https://checkout.razorpay.com/v1/checkout.js">`, then `new Razorpay({key, order_id, amount, handler})` | VERIFIED |
| Payment signature | `hex(HMAC_SHA256(order_id + "|" + razorpay_payment_id, key_secret))` == `razorpay_signature`. Use the **server-stored** order_id | VERIFIED |
| Subscription signature | `hex(HMAC_SHA256(razorpay_payment_id + "|" + subscription_id, key_secret))`. **Order is reversed** compared with orders | VERIFIED https://razorpay.com/docs/payments/subscriptions/integration-guide/ |
| Webhook | Header `X-Razorpay-Signature` = hex HMAC-SHA256(**raw body**, webhook_secret). The webhook secret is set per webhook in the Dashboard and is **not** the key_secret. Dedupe on `x-razorpay-event-id` | VERIFIED https://razorpay.com/docs/webhooks/validate-test/ |
| Customers | `POST /v1/customers` `{name, contact, email, fail_existing: "0"\|"1", gstin?, notes?}` → `cust_…` | VERIFIED https://razorpay.com/docs/api/customers/create/ |
| Subscriptions | `POST/GET /v1/plans`, `GET /v1/plans/:id`; `POST/GET /v1/subscriptions`, `GET/PATCH /v1/subscriptions/:id`, `POST …/:id/cancel`, `…/pause`, `…/resume`, `GET …/:id/retrieve_scheduled_changes`, `POST …/:id/cancel_scheduled_changes` | VERIFIED https://razorpay.com/docs/api/payments/subscriptions/ |
| Settlements | `GET /v1/settlements/`, `GET /v1/settlements/:id`, `GET /v1/settlements/recon/combined?year=YYYY&month=MM` | VERIFIED https://razorpay.com/docs/api/settlements/ |
| Payouts (RazorpayX) | `POST https://api.razorpay.com/v1/payouts`, Basic auth, **required header `X-Payout-Idempotency`**. Body `{account_number (your RazorpayX acct, not the beneficiary's), fund_account_id, amount (paise, min 100), currency: "INR", mode: NEFT\|RTGS\|IMPS (uppercase), purpose: refund\|cashback\|payout\|salary\|utility bill\|vendor bill}`. IP allowlisting is required. RazorpayX is a separate product activation | VERIFIED https://razorpay.com/docs/api/x/payouts/create/bank-account/ |

Notes:

- Partner calls must send the `X-Razorpay-Account` header.
- Notes objects take at most 15 key-value pairs.

---

## 2. PayU India

Docs: https://docs.payu.in · Hash: https://docs.payu.in/docs/generate-hash-payu-hosted

| Item | Fact | Status |
|---|---|---|
| Hosted checkout (form POST) | Test `https://test.payu.in/_payment`, prod `https://secure.payu.in/_payment` | PARTIAL (PayU docs via search snippets; https://docs.payu.in/docs/payu-india-api-environment) |
| Required form fields | `key, txnid, amount, productinfo, firstname, email, phone, surl, furl, hash` (+ `udf1..udf5`) | PARTIAL |
| Request hash | `sha512(key\|txnid\|amount\|productinfo\|firstname\|email\|udf1\|udf2\|udf3\|udf4\|udf5\|\|\|\|\|\|SALT)`. Always keep all 5 udf slots (empty strings are allowed). Output is lowercase hex. **Your belief is correct** | VERIFIED |
| Request hash (api_version=19) | `key\|txnid\|amount\|productinfo\|firstname\|email\|udf1…udf10\|user_token\|offer_key\|offer_auto_apply\|cart_details\|extra_charges\|phone` + salt | VERIFIED (same page) |
| Response (reverse) hash | `sha512(SALT\|status\|\|\|\|\|\|udf5\|udf4\|udf3\|udf2\|udf1\|email\|firstname\|productinfo\|amount\|txnid\|key)`. **Your belief is correct** | VERIFIED |
| Reverse hash variants | With `additional_charges` in the response, **prefix** `additional_charges\|` before SALT. With split: `status\|splitInfo\|\|\|\|\|\|` replaces `status\|\|\|\|\|\|` | VERIFIED |
| Amount | Rupee decimal string, e.g. `"10.00"`. The **exact same string** must be used in the hash and in the form | PARTIAL (examples, no formal rule) |
| Postservice (server APIs) | Test `https://test.payu.in/merchant/postservice.php?form=2`, prod `https://info.payu.in/merchant/postservice.php?form=2`. Samples also show the path without `.php`. POST `application/x-www-form-urlencoded`, fields `key, command, var1..varN, hash` | VERIFIED https://docs.payu.in/reference/verify_payment_api |
| Postservice hash | `sha512(key\|command\|var1\|SALT)`. **Only var1** is in the hash, even for refunds | VERIFIED (verify_payment); refund page: same formula per search snippet |
| Verify / status | `command=verify_payment`, `var1=txnid` (multiple txnids allowed, pipe-separated) → JSON `{status: 1\|0, msg, transaction_details: {<txnid>: {mihpayid, status, bank_ref_num, amt, mode, …}}}`. A missing txn returns `"Not Found"` | VERIFIED |
| Refund | `command=cancel_refund_transaction`, `var1=mihpayid` (**PayU id, not txnid**), `var2=token_id` (your unique refund id, ≤23 chars), `var3=amount`. Cancels if the txn is `auth`, refunds if `captured` | VERIFIED https://docs.payu.in/docs/refund-transaction-api |
| Refund status | Separate commands: "Check Refund Status with Request ID" (`check_action_status`), "…with PayU ID", and "Get All Refunds for a Transaction ID" (`getAllRefundsFromTxnIds`). The page lists the APIs; command strings come from community SDKs | PARTIAL https://docs.payu.in/reference/refund-apis |
| Webhooks | Configured in the Dashboard (test-mode webhooks fire only for test txns). The payload "contains an encoded Hash … created using the parameters you sent in the payment request along with your unique merchant key & salt in reverse order", which is the **same reverse-hash scheme** as the surl/furl response. Docs disagree on format: one says JSON body, the callback sample is form-urlencoded. Handle both | PARTIAL (https://docs.payu.in/docs/webhooks-consolidated returned 404 at fetch time; quoted via search) |
| Subscriptions | PayU supports recurring via Standing Instructions (`si=1`, `si_details`) on hosted checkout, plus mandate APIs | UNVERIFIED (not fetched) |
| Settlements / payouts | Settlement-details postservice commands exist. PayU Payouts is a separate product | UNVERIFIED |

Notes:

- PayU recommends always calling `verify_payment` after the surl/furl redirect before fulfilling.
- Hash comparison is lowercase hex.

---

## 3. Cashfree PG

Docs: https://www.cashfree.com/docs/api-reference/payments/latest/orders/create

| Item | Fact | Status |
|---|---|---|
| Base URLs | Sandbox `https://sandbox.cashfree.com/pg`, prod `https://api.cashfree.com/pg` | VERIFIED |
| Auth headers | `x-client-id`, `x-client-secret`, `x-api-version` (**latest = `2026-01-01`**; the format is YYYY-MM-DD, and older pinned values such as `2023-08-01` and `2025-01-01` are still documented). Optional: `x-request-id`, `x-idempotency-key` (UUID). Partners use `x-partner-apikey` + `x-partner-merchantid` | VERIFIED |
| Create order | `POST /pg/orders` `{order_id? (3–45 chars, [A-Za-z0-9_-]), order_amount, order_currency, customer_details: {customer_id, customer_phone, …}, order_meta?: {return_url, notify_url, payment_methods}, order_expiry_time?, order_note?, order_tags?, order_splits?}` → `{cf_order_id, order_id, order_status, payment_session_id, …}` | VERIFIED |
| Amount | **Rupees decimal**, ≤2 dp (`10.15` = ₹10.15). Minimum 1. **Not paise** | VERIFIED |
| Order status | `GET /pg/orders/{order_id}`; payments: `GET /pg/orders/{order_id}/payments` | UNVERIFIED (standard paths, not re-fetched) |
| Refund | `POST /pg/orders/{order_id}/refunds` `{refund_amount, refund_id (3–40), refund_speed?: STANDARD\|INSTANT, refund_note?, refund_splits?}`. Allowed only within **6 months** of payment | VERIFIED https://www.cashfree.com/docs/api-reference/payments/latest/refunds/create-refund |
| Refund status | `GET /pg/orders/{order_id}/refunds/{refund_id}` | UNVERIFIED (standard) |
| Client checkout | `<script src="https://sdk.cashfree.com/js/v3/cashfree.js">` or npm `@cashfreepayments/cashfree-js`, then `Cashfree({mode: "sandbox"\|"production"}).checkout({paymentSessionId, redirectTarget: "_self"\|"_blank"\|"_top"\|"_modal"})`. **Your domain must be whitelisted** with Cashfree | PARTIAL https://www.cashfree.com/docs/open-checkoutx |
| Return signature | No signed redirect params. Re-fetch the order (or rely on the webhook) | PARTIAL |
| Webhook | Headers `x-webhook-timestamp`, `x-webhook-signature`. `base64(HMAC_SHA256(timestamp + rawBody, client_secret))` with **no separator**. The doc's pseudocode shows a `.` but its code samples don't; trust the code (Dev Studio has a verifier). Partner webhooks use the partner API key | VERIFIED https://www.cashfree.com/docs/payments/online/webhooks/signature-verification |
| Subscriptions | Yes. `POST /pg/plans`, `POST /pg/subscriptions` (plan first), with mandate APIs. The Create Subscription body changed between versions | PARTIAL https://www.cashfree.com/docs/api-reference/payments/latest/subscription/create-subscription.md |
| Settlements | "Get All Settlements" (with `filters.settlement_status`) and "Get Settlements by Order ID" (`GET /pg/orders/{order_id}/settlements`) | PARTIAL |
| Payouts | Separate product. Payouts v2 base: sandbox `https://sandbox.cashfree.com/payout`, prod `https://api.cashfree.com/payout`. Standard Transfer (async), Get Transfer Status V2, Batch, Validate | VERIFIED https://www.cashfree.com/docs/api-reference/payouts/v2/payouts-api-v2-new |

---

## 4. CCAvenue

There are **no public official API docs**. CCAvenue serves the integration kit and API PDFs inside the merchant dashboard (M.A.R.S.). Most of this section is UNVERIFIED.

| Item | Fact | Status |
|---|---|---|
| Checkout (form POST) | Test `https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction`, prod `https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction`. Form fields `encRequest`, `access_code`. The plaintext is a query string: `merchant_id, order_id, currency, amount, redirect_url, cancel_url, language, billing_*…` | UNVERIFIED (kit knowledge). Meta's WhatsApp CCAvenue guide shows prod `https://secure.ccavenue.com/transaction.do` for the UPI-intent flow |
| Encryption (classic kits) | AES-**128**-CBC, key = `md5(working_key)` raw 16 bytes, IV = bytes `0x00..0x0f`, ciphertext **hex**. Matches your belief and the PHP/Node/Java kits in circulation | UNVERIFIED (no official public source; community tutorials confirm AES-CBC) |
| AES-256-GCM? | **No official evidence found.** One unofficial Medium/Node article uses `aes-256-gcm` (random 16-byte IV, auth tag), but it isn't from CCAvenue. **Support CBC as default; ask CCAvenue which kit version your account uses before shipping GCM** | UNVERIFIED |
| Response | `encResp` (form POST to redirect_url), decrypted to a query string with `order_id, tracking_id, bank_ref_no, order_status (Success\|Failure\|Aborted\|Invalid), amount, …`. Successful decryption with your working key is the only integrity check, so **always confirm with the status API** | UNVERIFIED |
| Amount | Rupees decimal, Numeric(12,2) | PARTIAL (Meta guide) |
| Server API | Prod `https://api.ccavenue.com/apis/servlet/DoWebTrans`, staging `https://apitest.ccavenue.com/apis/servlet/DoWebTrans`. POST form params `enc_request, access_code, command, request_type (XML\|JSON\|STRING), response_type, version` | PARTIAL (third-party copies of CCAvenue API PDF; Meta guide) |
| `version` | The old PDF says "current possible value is **1.1**". Newer calls (PayId details, payouts summary) say 1.2. **`orderStatusTracker` with 1.2 is not confirmed**. Try 1.2 and fall back to 1.1 | UNVERIFIED |
| Status | `command=orderStatusTracker`, enc JSON `{order_no, reference_no}`. Response: `status=0` + `enc_response` (decrypt with the same scheme) | UNVERIFIED (command name). Meta guide shows the body fields `orderNo` / `referenceNo` |
| Refund | `command=refundOrder`, enc JSON `{reference_no, refund_amount, refund_ref_no}` | UNVERIFIED |
| **IP whitelisting** | The merchant must register the server's public IP with CCAvenue before API calls work. Error 51407 = invalid access_code | PARTIAL |
| Webhooks | Dashboard-configured "Dynamic Event Notification" (HTTP POST). Signature scheme **not documented publicly** | UNVERIFIED |
| Subscriptions / settlements / payouts | SI and settlement APIs are reportedly in the API PDF. Not verifiable | UNVERIFIED |

---

## 5. Paytm PG (Paytm Payments)

Docs moved to **https://paytmpayments.com/docs** and the **hosts were rebranded**.

| Item | Fact | Status |
|---|---|---|
| Hosts (new) | Initiate/JS: staging `https://securestage.paytmpayments.com`, prod `https://secure.paytmpayments.com`. Refund and status pages show staging `https://securegw-stage.paytmpayments.in`. The **old `securegw(-stage).paytm.in` hosts appear only in legacy docs**. Keep the host configurable and test both | VERIFIED (each page cited below) |
| Initiate txn | `POST {host}/theia/api/v1/initiateTransaction?mid={MID}&orderId={ORDER}`. Body `{head: {signature, version?, channelId?: WEB\|WAP, requestTimestamp?}, body: {requestType: "Payment", mid, websiteName ("WEBSTAGING" staging / "DEFAULT" prod), orderId (≤50), callbackUrl?, txnAmount: {value: "1.00", currency: "INR"}, userInfo: {custId, mobile?}}}` → `body.resultInfo {resultStatus S\|F\|U, resultCode, resultMsg}` + `body.txnToken` (**valid 15 min**). Response `head.signature` should be verified | VERIFIED https://paytmpayments.com/docs/api/initiate-transaction-api |
| Amount | Rupee **string**, ≤2 dp | VERIFIED |
| JS checkout | `<script src="{host}/merchantpgpui/checkoutjs/merchants/{MID}.js">`, then `window.Paytm.CheckoutJS.init({root:"", flow:"DEFAULT", data:{orderId, token, tokenType:"TXN_TOKEN", amount}, handler:{notifyMerchant}}).then(() => window.Paytm.CheckoutJS.invoke())` | VERIFIED https://paytmpayments.com/docs/jscheckout-invoke-payment |
| Status | `POST {host}/v3/order/status` `{head:{signature}, body:{mid, orderId, txnType?}}`. `resultStatus` ∈ `TXN_SUCCESS \| TXN_FAILURE \| PENDING \| NO_RECORD_FOUND` | VERIFIED https://paytmpayments.com/docs/api/v3/transaction-status-api |
| Refund | `POST {host}/refund/apply` body `{mid, orderId, refId (unique), txnId (Paytm txn id), txnType: "REFUND", refundAmount, preferredDestination?: "TO_INSTANT", comments?}` | VERIFIED https://paytmpayments.com/docs/refund-api/ |
| Refund status | `POST {host}/v2/refund/status` `{mid, orderId, refId}` | UNVERIFIED (linked from refund page, not fetched) |
| Checksum algorithm | From `paytm/Paytm_Node_Checksum` source: AES-**128**-CBC, IV = literal `"@@@@&&&&####$$$$"`, key = merchant key used **as-is** (must be 16 bytes), salt = base64 of 3 random bytes (= **4 chars**). `hash = sha256hex(params + "\|" + salt) + salt`, then `signature = base64(AES_CBC(hash))`. For objects, the params string = values sorted by key and joined with `\|` (null → ""). **For JSON APIs, sign the string `JSON.stringify(body)`**. Verify: decrypt, take the last 4 chars as salt, recompute | VERIFIED https://github.com/paytm/Paytm_Node_Checksum/blob/master/PaytmChecksum.js |
| Callback / webhook | S2S POST of **form key-value pairs** to the callbackUrl and the Dashboard webhook URL: `ORDERID, MID, TXNID, TXNAMOUNT, STATUS (TXN_SUCCESS\|TXN_FAILURE), RESPCODE, RESPMSG, BANKTXNID, CHECKSUMHASH, …`. Verify by removing `CHECKSUMHASH` and running `verifySignature(params, merchantKey, CHECKSUMHASH)` with the object (sorted-values) form. **Your belief is correct**. `clientId` is present if you have multiple keys | VERIFIED https://paytmpayments.com/docs/payment-status |
| Subscriptions / settlements / payouts | Paytm has Subscription and Settlement APIs (paytmpayments.com docs nav). Payouts is a separate product | UNVERIFIED (not fetched) |

---

## 6. PhonePe PG (Standard Checkout v2)

Docs: https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/

| Item | Fact | Status |
|---|---|---|
| OAuth token | Sandbox `POST https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token`, prod `POST https://api.phonepe.com/apis/identity-manager/v1/oauth/token`. Content type `application/x-www-form-urlencoded` with `client_id, client_version, client_secret, grant_type=client_credentials` → `{access_token, issued_at, expires_at (epoch s), token_type: "O-Bearer"}` (plus undocumented `encrypted_access_token, expires_in, session_expires_at`). Refresh before `expires_at`. The sandbox `client_version` is typically `1` | VERIFIED …/api-reference/authorization |
| Auth header | `Authorization: O-Bearer <access_token>`. Partners also send `X-MERCHANT-ID` | VERIFIED |
| Base | Sandbox `https://api-preprod.phonepe.com/apis/pg-sandbox`, prod `https://api.phonepe.com/apis/pg` | VERIFIED |
| Create payment | `POST /checkout/v2/pay` `{merchantOrderId (≤63, only _ and - allowed), amount (paise int, **min 100**), expireAfter? (300–3600 s), paymentFlow: {type: "PG_CHECKOUT", merchantUrls: {redirectUrl}}, metaInfo?: {udf1..udf15}, prefillUserLoginDetails?: {phoneNumber}, disablePaymentRetry?}` → `{orderId, state: "PENDING", expireAt, redirectUrl}`. An existing non-CREATED merchantOrderId returns BAD_REQUEST | VERIFIED …/create-payment/initiate-payment |
| Order status | `GET /checkout/v2/order/{merchantOrderId}/status?details=false&errorContext=true`. `state` ∈ `PENDING \| COMPLETED \| FAILED`, `paymentDetails[]`. An invalid id returns `INVALID_MERCHANT_ORDER_ID` | VERIFIED …/api-reference/order-status |
| Refund | `POST /payments/v2/refund` `{merchantRefundId (≤63), originalMerchantOrderId, amount (paise, min 100)}` → `state: PENDING` | VERIFIED …/api-reference/refund |
| Refund status | `GET /payments/v2/refund/{merchantRefundId}/status`. `state` ∈ `PENDING \| COMPLETED \| FAILED` (custom-checkout docs also list `CONFIRMED`) | VERIFIED |
| Client checkout | Redirect the browser to `redirectUrl`, **or** load the PhonePe checkout bundle from `mercury.phonepe.com` (staging `mercury-stg.phonepe.com`) and call `window.PhonePeCheckout.transact({tokenUrl: redirectUrl, type: "IFRAME", callback})`. Without `type`, it redirects | PARTIAL https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/invoke-iframe-paypage (exact script path not confirmed) |
| Redirect signature | None. The redirect carries no signed data, so call Order Status | VERIFIED (implied by flow) |
| Webhook (SHA method) | Configure the URL, username and password in the Business Dashboard (in sandbox, ask the integration team). Header `Authorization: SHA256(username:password)`. The sample is a 64-char **hex** string with no prefix observed. Compare against `hex(sha256(username + ":" + password))`. **This does not authenticate the body**, so always re-fetch status | PARTIAL (formula on official page; hex inferred from sample) |
| Webhook (HMAC method) | The current webhook page **also** describes headers `x-phonepe-checksum-key-id` and `x-phonepe-checksum-signature`. Algorithm and encoding are not stated | PARTIAL / UNVERIFIED …/api-reference/webhook |
| Webhook events | `checkout.order.completed`, `checkout.order.failed`, `pg.refund.completed`, `pg.refund.failed`. Body `{event, payload: {state, orderId, merchantOrderId/originalMerchantOrderId, amount, paymentDetails, …}}`. Use `event` (the old `type` field is deprecated) and `payload.state` | VERIFIED |
| Legacy v1 (deprecated) | `X-VERIFY: sha256hex(base64Payload + "/pg/v1/pay" + saltKey) + "###" + saltIndex`. Status: `sha256hex("/pg/v1/status/{merchantId}/{merchantTransactionId}" + saltKey) + "###" + saltIndex`. The body is `{request: base64Payload}`. Callback: the X-VERIFY of `base64(response) + saltKey` | VERIFIED https://developer.phonepe.com/v1/reference/pay-api-1 (status string via third-party) |
| Subscriptions | Autopay (UPI mandate) v2 under `/payment-gateway/autopay/`, with eNACH | PARTIAL (doc sections exist) |
| Settlements | A settlement API section exists (https://developer.phonepe.com/settlement/) | PARTIAL |
| Payment links | Yes (`/payment-gateway/payment-links/`) | PARTIAL |

---

## 7. Stripe (India)

| Item | Fact | Status |
|---|---|---|
| Availability | **"Stripe services are invite only in India."** Indian businesses must request an invite and can't self-sign-up. Stripe supports "a select number of businesses, with a focus on international expansion". Third-party sources date this to **May 2024**, still in force late 2026. Existing accounts are still supported | VERIFIED https://support.stripe.com/questions/india-faq |
| Eligible entity | Registered Indian business only (sole prop / LLP / company). No individuals | PARTIAL https://stripe.com/docs/india-exports |
| Exports | 135+ presentment currencies on Visa/MC, INR/USD on Amex. Non-INR needs extra onboarding info and the txns must be declared as exports (purpose codes, FIRC) | PARTIAL |
| Regulatory | RBI PA licence (Jan 2024) and lack of PA-CB are claimed by a single secondary source | UNVERIFIED |
| RBI e-mandate | Off-session India card/UPI payments need an e-mandate registered with AFA (3DS/UPI PIN). A **pre-debit notification ≥24h** before the debit is required, and Stripe delays card charges **26h** (PaymentIntent sits in `processing`). Each charge **>₹15,000 needs AFA**, and UPI recurring >₹15,000 is unsupported. Mandates can't be updated or cancelled via the API. From API `2026-09-30.endive`, failed mandates are returned as `inactive` with `inactive_reason` | VERIFIED https://docs.stripe.com/india-recurring-payments |
| API | Standard PaymentIntents / Checkout Sessions on `https://api.stripe.com/v1`, Bearer secret key, minor units | VERIFIED (general) |
| Webhook | `Stripe-Signature: t=<ts>,v1=<hex>[,v1=…][,v0=…]`. `signed_payload = t + "." + rawBody`, `expected = hex(HMAC_SHA256(signed_payload, whsec_secret))`. Compare against **every** `v1` (several appear during secret rolling), ignore other schemes, and enforce tolerance (libraries default to 300 s; never 0) | VERIFIED https://docs.stripe.com/webhooks?verify=verify-manually |

Note: for a "plain fetch" MCP server, treat Stripe as an **international/exports adapter**, not a domestic-India default.

---

## 8. Skydo

| Item | Fact | Status |
|---|---|---|
| Public developer API | **None found.** The homepage, blog and FAQ have no API docs, developer portal or webhook docs. A third-party review calls Skydo a weak fit for SaaS needing developer APIs and custom checkout. Skydo's "single API integration" is the bank-side Banking Circle partnership, not a customer API. A consultancy page claims webhooks/API reports, but there is no official source | VERIFIED-ABSENT (as of 2026-10-28) |
| Integration options | Dashboard **payment links ("InstaLinks")**, "Global Bank Account" local receiving details (US/UK/EU/CA/AU and more, i.e. virtual accounts), GST-compliant invoicing, FIRA, and a **native Zoho Books integration** (invoice sync, auto mark-paid). No Zapier, QuickBooks or Xero integration found | PARTIAL https://www.skydo.com/ , https://skydo.com/blog/skydo-feature-update-zoho-integration , https://www.skydo.com/faqs/dashboard?q=faq-14 |
| MCP implication | No programmatic adapter is possible. At most, a "guidance" tool that deep-links to the dashboard, or a manual payment-link record | — |

---

## 9. Shopify

- **Shopify Payments is not available to India-based stores.** Indian merchants must use third-party providers, added under Settings → Payments. Third-party providers incur a Shopify transaction fee that varies by plan and location.
  - Sources: https://help.shopify.com/en/manual/payments/third-party-providers (PARTIAL); India availability per multiple sources including PayU's blog.
- **Merchants cannot plug a gateway into Shopify checkout themselves.**
  - Shopify: "Only approved Partners can build payments extensions on Shopify's Payments Platform."
  - Custom payment extensions are "limited to eligible Shopify Plus Merchants only" (eligibility through Plus Support).
  - Source: https://shopify.dev/docs/apps/build/payments (VERIFIED).
  - An open-source MCP server therefore **cannot** act as a Shopify checkout gateway. It can only operate *alongside* an installed provider app (for example reconciliation, refunds through the gateway API, or payment links in draft orders).

| Gateway | Official Shopify payments app? | Evidence |
|---|---|---|
| Razorpay | **Yes**: "All-in-one Razorpay Payment Gateway" (formerly "1 Razorpay"). Install from the App Store, connect as the account owner, no API keys. Stores integrated before 28 Apr 2022 must migrate | VERIFIED https://razorpay.com/docs/payments/payment-gateway/ecommerce-plugins/shopify/ |
| PayU India | **Yes**: "1PayU (Cards, UPI, NB, Wallet)" https://apps.shopify.com/payu-india, plus "Onsite Card Payments by PayU India". Configure with merchant key and salt | VERIFIED https://docs.payu.in/docs/install-payu-plugin |
| PhonePe | **Yes**: "PhonePe Payment Gateway" https://apps.shopify.com/phonepe-payment-gateway (launched 2023-02-24). Install via Settings → Payments → "PhonePe PG", link the MID | VERIFIED https://developer.phonepe.com/payment-gateway/e-commerce-plugins/shopify |
| Cashfree | Likely yes. Cashfree's FAQ says it offers a no-code Shopify plugin. Only "Cashfree BNPL Plus" was seen in App Store results | PARTIAL https://www.cashfree.com/docs/help/payments/integrations/integrations |
| CCAvenue | Long listed as a Shopify provider in admin. No current App Store listing confirmed | UNVERIFIED |
| Paytm | No official Paytm Shopify app found. Paytm is reachable via other gateways (Cashfree, Razorpay wallets) | UNVERIFIED (absence) |
| Stripe | Not usable as a Shopify provider for India stores (Shopify Payments, which runs on Stripe, is unavailable in IN) | PARTIAL |
| Skydo | None | VERIFIED-ABSENT |

---

## 10. Implementation gotchas for a fetch-only TS server

1. **Raw body is mandatory** for Razorpay, Cashfree and Stripe webhooks. Never verify against `JSON.stringify(parsed)`. Paytm and PayU callbacks are form-urlencoded, so verify on the decoded key-value pairs.
2. **Amount units differ**:
   - **Paise integer**: Razorpay, PhonePe, Stripe.
   - **Rupee decimal**: Cashfree (number), PayU, Paytm and CCAvenue (string). For PayU the exact string goes into the hash.
3. **Separator traps**:
   - Razorpay orders use `order|payment`, but subscriptions use `payment|subscription`.
   - Cashfree uses `timestamp+body` (no dot), while Stripe uses `t.body` (dot).
   - PayU's 5 empty fields come after udf5 in the request hash but after status in the response hash.
4. **Secrets per gateway**:

   | Gateway | Secrets |
   |---|---|
   | Razorpay | key_secret (payment signature) is different from the webhook secret |
   | PayU | salt |
   | Cashfree | client_secret serves both API and webhook |
   | Paytm | merchant key (16 bytes) |
   | PhonePe | client_id/secret/version for OAuth, plus a separate webhook username/password |
   | CCAvenue | working_key + access_code, plus a whitelisted egress IP |

5. **Redirect-only gateways have no signed return** (PhonePe v2, Cashfree). Always do a server-side status fetch before fulfilment, and do the same for PayU and CCAvenue as a best practice.
6. **PhonePe token caching**: cache `access_token` until `expires_at` minus a margin. The token endpoint host differs from the API host in production.
7. **Paytm host migration**: don't hard-code `securegw.paytm.in`. Default to `secure.paytmpayments.com` / `securestage.paytmpayments.com`, and confirm the refund and status host (`securegw-stage.paytmpayments.in` appears in staging docs).
8. **Cashfree** requires `x-api-version`. Pin it explicitly (for example `2025-01-01` or `2026-01-01`), because response shapes change by version.
