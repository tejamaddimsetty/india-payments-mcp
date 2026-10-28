# Verification round 2: Razorpay, Cashfree, PhonePe

Date: 2026-10-29. Independent re-check of `src/providers/{razorpay,cashfree,phonepe}/*` and `test/providers/{razorpay,cashfree,phonepe}.test.ts` against the official docs, fetched live this round. Round-1 conclusions were not reused; each round-1 fix was re-checked against the docs. Quotes are 15 words or fewer. No code was changed.

Abbreviations: RZ = `src/providers/razorpay/adapter.ts`, RZC = `.../razorpay/capabilities.ts`, CF = `src/providers/cashfree/adapter.ts`, CFC = `.../cashfree/capabilities.ts`, PP = `src/providers/phonepe/adapter.ts`, PPC = `.../phonepe/capabilities.ts`.

Verdicts: MATCH, MISMATCH, UNVERIFIABLE (the docs neither confirm nor contradict it, or the docs contradict themselves).

## Razorpay

| Item | Code file:line | Docs quote | URL | Verdict |
|---|---|---|---|---|
| Base URL | RZ:41 `https://api.razorpay.com/v1` | `POST https://api.razorpay.com/v1/orders` | https://razorpay.com/docs/api/orders/create/ | MATCH |
| Auth | RZ:128 Basic keyId:keySecret | curl `-u [YOUR_KEY_ID]:[YOUR_KEY_SECRET]` | same | MATCH |
| Create order | RZ:157 `POST /orders` | `POST https://api.razorpay.com/v1/orders` | same | MATCH |
| amount unit | RZ:150 integer paise passed through | "Smallest currency sub-unit"; minimum INR 1.00 (100) | same | MATCH (min not pre-validated) |
| receipt | RZ:152 `receipt: orderRef`; RZC:37 "max 40" | "maximum length of 40 characters and has to be unique" | https://razorpay.com/docs/api/orders/create.md | MATCH (length not pre-validated) |
| Order idempotency | RZ:156 never auto-retried | "`receipt` is treated as an idempotency key ... second create ... rejected" | same | MATCH (no retry is correct; a manual retry after a timeout gets 400 "Duplicate request", see notes) |
| notes limits | RZC:39 15 pairs, 256 chars | "Maximum 15 key-value pairs, up to 256 characters each" | orders/create | MATCH |
| Order status enum | RZ:66 created/attempted/paid | created, attempted, paid | orders/create | MATCH |
| Fetch order payments | RZ:288 `GET /orders/{id}/payments`, reads `items` | `GET .../orders/{order_id}/payments`; `entity: collection`, `items` | https://razorpay.com/docs/api/orders/fetch-payments/ | MATCH |
| Payment status enum | RZ:76, 92-108 | "created", "authorized", "captured", "refunded", "failed" | https://razorpay.com/docs/api/payments/fetch-with-id/ | MATCH (partial-refund handling via amount_refunded is UNVERIFIABLE, docs silent) |
| Payment method enum | RZC:25 upi, card, netbanking, wallet, emi, paylater | "card", "netbanking", "wallet", "emi", "upi", "paylater" | payments/fetch-with-id | MATCH |
| Checkout script | RZ:42 | `https://checkout.razorpay.com/v1/checkout.js` | https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/build-integration/ | MATCH |
| Checkout mandatory options | RZ:159-173 key, name, order_id, amount, currency | mandatory: `key`, `amount`, `currency`, `name`, `order_id` | same | MATCH (round-1 fix correct) |
| callback_url / redirect | RZ:174-178 | `callback_url`, `redirect` optional | same | MATCH |
| Payment signature | RZ:47-49 HMAC-SHA256 hex of `order_id|payment_id` | `hmac_sha256(order_id + "|" + razorpay_payment_id, secret)` | same | MATCH (test vector at razorpay.test.ts:17 recomputed, correct) |
| Signed order id source | RZ:199, 242-252 stored providerOrderId preferred; payload id only when bound by orderRef lookup | "Do not use the razorpay_order_id returned by Checkout." | same | MATCH (round-1 fix correct; orderRef-only path is bound by the receipt lookup at RZ:256-260) |
| Subscription signature | RZ:51-53 `payment_id|subscription_id` | `hmac_sha256(razorpay_payment_id + "|" + subscription_id, secret)` | https://razorpay.com/docs/payments/subscriptions/integration-guide/ | MATCH |
| Signed subscription id source | RZ:212-221 | "Do not use the razorpay_subscription_id returned by Checkout." | same | MATCH |
| Subscription checkout options | RZ:547-553 key, name, subscription_id | sample options `key`, `subscription_id`, `name` ... | same | MATCH |
| Refund create | RZ:330-335 `POST /payments/{id}/refund` | `POST /v1/payments/{id}/refund` | https://razorpay.com/docs/api/refunds/create-normal/ | MATCH |
| Refund amount optional | RZ:329 | "If the amount parameter is not passed, the entire payment amount" refunded | same | MATCH |
| Refund speed | RZ:325 normal / optimum | "Use one of the supported values: normal or optimum." | same | MATCH |
| Refund receipt / idempotency | RZ:326, not retry-safe | receipt reuse returns "Duplicate receipt found for this refund request." | same | MATCH (no auto-retry is correct) |
| Refund status enum | RZ:87, 110-115 | `pending`, `processed`, `failed` | same | MATCH |
| Fetch refund | RZ:350 `GET /refunds/{id}` | Fetch refund by id | refunds API | MATCH |
| Webhook signature | RZ:55-57, 365-372 | "X-Razorpay-Signature"; "HMAC with SHA256"; key is webhook secret | https://razorpay.com/docs/webhooks/validate-test/ | MATCH |
| Raw body | RZ:366 hashes `rawBody` | "Do not parse or cast the webhook request body." | same | MATCH |
| Event id dedupe | RZ:392, 418 `x-razorpay-event-id` | "Check the value of x-razorpay-event-id" | same | MATCH |
| Webhook envelope | RZ:373-384 event, created_at, payload.X.entity | keys entity, account_id, event, contains, payload, created_at | https://razorpay.com/docs/webhooks/payments/ | MATCH |
| created_at units | RZ:429 seconds | 10-digit sample `1567674599` | same | MATCH (inferred) |
| Payment events | RZ:395-398 payment.captured/failed/authorized | payment.authorized, payment.captured, payment.failed, payment.pending | same | MATCH (pending -> unknown) |
| order.paid payload | RZ:396, 421 order.receipt | payload has `payment.entity` and `order.entity` | https://razorpay.com/docs/webhooks/orders/ | MATCH |
| Refund events | RZ:399-400 | refund.created, refund.processed, refund.failed, refund.speed_changed | https://razorpay.com/docs/webhooks/refunds/ | MATCH (created/speed_changed -> unknown) |
| Refund payload | RZ:387, 423-425 | `payload.refund.entity` with id, payment_id, amount, receipt, notes | same | MATCH |
| Subscription events | RZ:401-404 | authenticated, activated, charged, completed, updated, pending, halted, cancelled, paused, resumed | https://razorpay.com/docs/webhooks/subscriptions/ | MATCH (others -> unknown) |
| Subscription payload | RZ:388, 421-422 `payload.subscription.entity`, notes may be `[]` | notes "as an empty array ([]) in others" | same | MATCH (array notes yield undefined, safe; round-1 fix correct) |
| Dispute events / payload | RZ:405, 389, 427-428 | `payment.dispute.created` ...; dispute entity id, amount, currency, payment_id | https://razorpay.com/docs/webhooks/disputes/ | MATCH (round-1 fix correct) |
| Settlement event / payload | RZ:406, 390, 427-428 | `settlement.processed`; entity id, amount, status, fees, tax, utr; no currency | https://razorpay.com/docs/webhooks/settlements/ | MATCH (currency defaulted to INR, not in payload) |
| Create customer | RZ:487-494 | `POST /v1/customers`; fail_existing `"0"` fetches existing customer | https://razorpay.com/docs/api/customers/create/ | MATCH (retry-safe is justified by fail_existing "0") |
| Create plan | RZ:504-516 period/interval/item | period daily, weekly, monthly, quarterly, yearly; item name/amount/currency required | https://razorpay.com/docs/api/payments/subscriptions/create-plan.md | MATCH |
| Daily plan minimum | RZ:506-511 | "For daily plans, the minimum value should be 7." | same | MATCH (round-1 fix correct) |
| total_count required | RZ:519-524 throws without totalCount | total_count required; error says "either this or end_at" | https://razorpay.com/docs/api/payments/subscriptions/create-subscription.md | MISMATCH (minor: end_at alternative blocked) |
| customer_notify | RZ:528 `true` | boolean, `true` default | same | MATCH (round-1 fix correct) |
| customer_id on create subscription | RZ:529-533 kept in notes only | customer_id "Not a request parameter"; populated after authorisation | same | MATCH (round-1 fix correct) |
| Subscription status enum | RZ:542 active vs pending_authorization | created, authenticated, active, pending, halted, cancelled, completed, expired | same | MATCH (coarse) |
| Cancel subscription | RZ:560-566 `POST /subscriptions/{id}/cancel`, boolean | `cancel_at_cycle_end` boolean, default false | https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription.md | MATCH (round-1 fix correct) |
| Settlements list | RZ:576-587 from/to seconds, count <=100 | `from`/`to` Unix seconds; `count` 1 to 100, default 10 | https://razorpay.com/docs/api/settlements/fetch-all/ | MATCH |
| Settlement fields | RZ:590-599 id, amount, status, utr, fees, tax, created_at | same fields; status created/processed/failed | same | MATCH (`settledAt` is really created_at) |
| Error shape | RZ:624-627 `error.code`, `error.description` | standard `error` object | Razorpay API errors | UNVERIFIABLE (not re-fetched; consistent with test razorpay.test.ts:155-160) |

## Cashfree

| Item | Code file:line | Docs quote | URL | Verdict |
|---|---|---|---|---|
| Base URLs | CF:31-34 | Sandbox `https://sandbox.cashfree.com/pg`; Production `https://api.cashfree.com/pg` | https://www.cashfree.com/docs/api-reference/payments/latest/orders/create | MATCH |
| Auth headers | CF:209-212 x-client-id, x-client-secret | x-client-id and x-client-secret API-key headers | same | MATCH |
| x-api-version | CF:36 `2026-01-01` | default `'2026-01-01'`, "Format is in YYYY-MM-DD" | same | MATCH |
| x-idempotency-key on order | CF:59-66, 278-282 UUID (derived v5-style if needed), retry-safe only with key | optional, `format: UUID` | same | MATCH (round-1 fix correct) |
| Create order | CF:278 `POST /orders` | POST /orders | same | MATCH |
| order_id | CF:47, 227-231 | 3-45; "Only alphanumeric characters, underscores (_), and hyphens (-)" | same | MATCH (code makes it mandatory; docs optional, fine) |
| order_amount | CF:73-76, 262 rupees number | number (double), minimum 1, "Provide upto two decimals" | same | MATCH (min not pre-validated) |
| order_currency | CF:263 | "INR if left empty" | same | MATCH |
| customer_id | CF:49, 241-247 `/^[A-Za-z0-9]{3,50}$/`, derived `cust<24 hex>` | 3-50, "Use alphanumeric values only." Examples `409128494`, `7112AAA812234` | same (.md) | MATCH (round-1 fix correct) |
| customer_phone | CF:232-238 required, strips spaces/dashes | min/max 10; "prefixed with a '+' to override" | same | MATCH (no length check; `91XXXXXXXXXX` without + will be rejected by API) |
| customer_email / name | CF:267-268 | 3-100 chars each | same | MATCH (not validated) |
| return_url | CF:249-257 appends `order_id={order_id}` | latest ref: "keep context of order_id in your return_url"; legacy docs: placeholder replaced | orders/create; https://docs.cashfree.com/docs/handle-return-url-and-confirm-status | UNVERIFIABLE for 2026-01-01 (code comment already says so) |
| notify_url | CF:258 | "NotifyUrl should be an https URL. Maximum length: 250." | orders/create | MATCH (not validated) |
| order_note / order_tags | CF:271-272 | order_note 3-200; tags "maximum of 10" vs schema 15 | same | MATCH (not validated) |
| Response fields | CF:284-307 cf_order_id, payment_session_id, order_status, order_expiry_time | cf_order_id string; ACTIVE, PAID, EXPIRED, TERMINATED, TERMINATION_REQUESTED | same | MATCH |
| Order status mapping | CF:134-148 | same five values | same | MATCH |
| Get order / payments | CF:346-350 | `GET /orders/{order_id}/payments`; response is array of PaymentEntity | https://www.cashfree.com/docs/api-reference/payments/latest/payments/get-payments-for-order | MATCH |
| payment_status enum | CF:113-131 | SUCCESS, NOT_ATTEMPTED, FAILED, USER_DROPPED, VOID, CANCELLED, PENDING | same | MATCH (FLAGGED extra, harmless) |
| payment_group mapping | CF:161-171 | prepaid_card, upi_ppi_offline, cash, upi_credit_card, ..., cardless_emi, credit_card_emi | same | MATCH (round-1 fix correct: cardless_emi and upi_* now right) |
| error_details | CF:98, 378 error_description | error_code, error_description, error_reason, ... | same | MATCH |
| Create refund | CF:407 `POST /orders/{order_id}/refunds` | POST /orders/{order_id}/refunds | https://www.cashfree.com/docs/api-reference/payments/latest/refunds/create | MATCH |
| refund_amount | CF:391-400 rupees, full amount looked up if omitted | required number, "Should be lesser than or equal to the transaction amount" | same | MATCH |
| refund_id charset | CF:51, 384-389 `/^[A-Za-z0-9]{3,40}$/` (round-1 fix) | text "Provie alphanumeric values"; doc examples `REF-123`, `refund_00912` | same (.md examples); refunds/webhooks sample `refund_sampleorder0413` | MISMATCH (over-strict: rejects Cashfree's own documented examples) |
| refund_speed | CF:402 | enum STANDARD, INSTANT; "default being STANDARD" | refunds/create | MATCH |
| refund_note | CF:403 | 3-100 chars; sandbox values SUCCESS/FAILED/PENDING simulate status | same | MATCH (not validated) |
| Refund idempotency | CF:405-411 x-idempotency-key derived UUID, retry-safe | optional UUID; retry with the same key | same | MATCH (round-1 fix correct) |
| refund_status mapping | CF:150-157 | SUCCESS, PENDING, PENDING_APPROVAL, CANCELLED, ONHOLD, REJECTED | same | MATCH (round-1 fix correct) |
| Get refund | CF:419 `GET /orders/{order_id}/refunds/{refund_id}` | `get /orders/{order_id}/refunds/{refund_id}` | https://www.cashfree.com/docs/api-reference/payments/latest/refunds/get | MATCH |
| Refund window | CFC:43 | "only within six months of the original successful transaction" | refunds/create | MATCH |
| Webhook headers | CF:435-436 | `x-webhook-timestamp`, `x-webhook-signature` | https://www.cashfree.com/docs/payments/online/webhooks/signature-verification | MATCH |
| Signature algorithm | CF:68-71 base64(HMAC-SHA256(secret, ts + rawBody)), no separator | examples concatenate timestamp and raw body; Base64Encode(HMACSHA256(...)) | same | MATCH (pseudocode `$timestamp.$payload` is PHP concat) |
| Signing key | CF:440 client secret | `$merchantSecretKey` / client secret | same | MATCH |
| Replay window | CF:38-46, 447-454 24 h past / 5 min future | "no replay protection or tolerance window" documented; retries 2, 10, 30 min, up to 10 custom | same; https://www.cashfree.com/docs/payments/online/webhooks/overview | UNVERIFIABLE (round-1 fix to 24 h is safe for documented retry policies) |
| Dedupe header | CF:475, 506-507 reads `x-idempotency-header` only | overview: "validate x-idempotency-header"; API-ref samples show `x-idempotency-key` | overview; https://www.cashfree.com/docs/api-reference/payments/latest/payments/webhooks | MISMATCH (docs disagree; code reads only one of the two names) |
| Payment webhook types | CF:479-485 | PAYMENT_SUCCESS_WEBHOOK, PAYMENT_FAILED_WEBHOOK, PAYMENT_USER_DROPPED_WEBHOOK, PAYMENT_CHARGES_WEBHOOK | payments/webhooks | MATCH (charges -> unknown) |
| Payment webhook paths | CF:456-470 data.order, data.payment, type, event_time | top-level data, event_time, type; data.order, data.payment | same | MATCH |
| REFUND_STATUS_WEBHOOK | CF:462, 471 data.refund | `"data":{"refund":{...}}`, `"type":"REFUND_STATUS_WEBHOOK"` | https://www.cashfree.com/docs/api-reference/payments/latest/refunds/webhooks | MATCH |
| AUTO_REFUND_STATUS_WEBHOOK | CF:464, 471 data.auto_refund | `"auto_refund": {...}`, no refund_id, has order_id | same | MATCH (round-1 fix correct) |
| Dispute webhooks | CF:465-466, 492-499, 511, 514-517, 524 | data.dispute (dispute_id, dispute_amount, dispute_status, dispute_amount_currency); data.order_details | https://www.cashfree.com/docs/api-reference/payments/latest/disputes/dispute-webhooks | MATCH (round-1 fix correct; amounts rupees) |
| JS SDK | CF:37, 296-305 | `https://sdk.cashfree.com/js/v3/cashfree.js`; mode sandbox/production; `paymentSessionId` | https://www.cashfree.com/docs/payments/online/web/redirect | MATCH |
| Domain whitelist | CFC:42 | "You must whitelist your domain with Cashfree" | same | MATCH |
| Error body | CF:612-617 `{message, code, type}` | BadRequestError: message, help, code, type `invalid_request_error` | orders/create (.md) | MATCH |
| Key-prefix guards | CF:602-609 | not documented | - | UNVERIFIABLE (code says so) |

## PhonePe (Standard Checkout v2)

Base: https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/

| Item | Code file:line | Docs quote | URL | Verdict |
|---|---|---|---|---|
| Sandbox token URL | PP:42 | `https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token` | .../authorization | MATCH |
| Prod token URL | PP:46 | `https://api.phonepe.com/apis/identity-manager/v1/oauth/token` | .../authorization | MATCH |
| Token request | PP:236-249 form, 4 fields | `application/x-www-form-urlencoded`; client_id, client_version, client_secret, grant_type | same | MATCH |
| grant_type | PP:240 | "set to client_credentials" | same | MATCH |
| expires_at units | PP:70-71, 253 epoch seconds | "Token expiry timestamp in epoch"; issued_at "(in seconds)" | same | MATCH |
| expires_in | PP:253 fallback | `null` in sample, undocumented | same | MATCH (handled) |
| Refresh before expiry | PP:53, 228 | "You must ensure that the token is refreshed before it expires." | same | MATCH |
| Auth header | PP:270 `O-Bearer <token>` | `Authorization` is "O-Bearer <merchant-auth-token>" | .../create-payment | MATCH |
| API bases | PP:43, 47 | `.../apis/pg-sandbox/checkout/v2/pay`; `https://api.phonepe.com/apis/pg/checkout/v2/pay` | .../create-payment | MATCH |
| Create payment | PP:334 `POST /checkout/v2/pay` | POST checkout/v2/pay | same | MATCH |
| merchantOrderId | PP:56, 306 | up to 63; "Only underscores and hyphens are allowed as special characters" | same | MATCH |
| amount | PP:51, 186-193, 321 integer paise, min 100 | "in paisa (e.g., ₹10 = 1000 paisa)"; minimum 100 | same | MATCH |
| expireAfter | PP:314-317 | range 300 to 3600 seconds | same | MATCH |
| paymentFlow.type | PP:325 | only allowed value "PG_CHECKOUT" | same | MATCH |
| message | PP:326 | "Payment message used for collect requests" | same | MATCH |
| redirectUrl | PP:308-313, 327 | merchantUrls.redirectUrl required | same | MATCH |
| prefillUserLoginDetails | PP:329 top-level `{phoneNumber}` | top-level sibling of paymentFlow; `"phoneNumber": "+91 998*****09"` | .../create-payment/initiate-payment | MATCH |
| metaInfo limits | PP:171-182 | udf1-10 up to 256; udf11-15 alnum plus `_-+@.`, max 50 | .../create-payment | MATCH |
| metaInfo free-form slots | PP:162-170 only udf1..udf5 receive unnamed values | udf1 to udf10: "No character constraints, up to 256" | same | MISMATCH (minor: 6-10 free values wrongly rejected) |
| Currency | PP:303-305 INR only | amount in paisa; no currency field | same | MATCH |
| Create response | PP:75-81, 340-345 orderId, state, expireAt, redirectUrl | table `expiryAt`, sample `expireAt` | same | MATCH (docs inconsistent; sample followed) |
| merchantOrderId reuse | PP:332-334 never auto-retried | "already present and not in CREATED state" -> BAD_REQUEST | same | MATCH |
| Order status | PP:291-298 `GET /checkout/v2/order/{id}/status?details=false&errorContext=true` | path `/checkout/v2/order/{merchantOrderId}/status`; details false = latest attempt | .../order-status | MATCH |
| Order state enum | PP:117-128 | `PENDING`, `FAILED`, or `COMPLETED` | same | MATCH |
| paymentDetails fields | PP:83-92 | paymentMode, transactionId, timestamp, amount, state, errorCode, detailedErrorCode | same | MATCH |
| paymentMode values | PP:139-146 | UPI_INTENT, UPI_COLLECT, UPI_QR, CARD, NET_BANKING | same | MATCH (TOKEN extra, harmless) |
| errorCode / detailedErrorCode | PP:100-101, 412-415 | appear in failed-order sample (Case 5) | same | MATCH |
| Refund create | PP:436-442 `POST /payments/v2/refund` | POST .../payments/v2/refund | .../refund | MATCH |
| Refund fields | PP:440 | merchantRefundId (max 63), originalMerchantOrderId, amount (min 100) mandatory | same | MATCH |
| Refund retry-safe | PP:435, 441 | page "says nothing" about reusing merchantRefundId | same | UNVERIFIABLE (PPC:18 already says not documented) |
| Refund response | PP:106-114, 443-450 refundId, amount, state | refundId, amount, state "expected value = PENDING" | same | MATCH |
| Refund status | PP:454-460 `GET /payments/v2/refund/{merchantRefundId}/status` | same path | same | MATCH |
| Refund state enum | PP:130-136 | PENDING, COMPLETED, FAILED | same | MATCH (CONFIRMED extra, harmless) |
| Webhook auth | PP:62-64, 477-485 sha256 hex of `username:password`, no prefix | "using the SHA256(username:password) method"; SDK sample 64 bare hex | .../webhook; https://developer.phonepe.com/payment-gateway/backend-sdk/nodejs-be-sdk/api-reference-node-js/webhook-handling | MATCH |
| Event field | PP:504-507 event, then type | "Ignore the type parameter"; use `event` | .../webhook | MATCH |
| Event names | PP:508-513 | checkout.order.completed, checkout.order.failed, pg.refund.completed, pg.refund.failed | same | MATCH (SDK also has PG_REFUND_ACCEPTED -> unknown) |
| Order webhook payload | PP:486-537 | payload: orderId, merchantId, merchantOrderId, state, amount, expireAt, paymentDetails, metaInfo | same | MATCH |
| Root-level state | PP:532 `p.state` | rely only on root-level `payload.state` | same | MATCH |
| Refund webhook shapes | PP:496-503 flat fallback | UPI completed sample flat; card/NB wrapped | same | MATCH |
| HMAC checksum headers | PPC:22 not implemented | `x-phonepe-checksum-key-id`, `x-phonepe-checksum-signature`; encoding unstated | same | MATCH |
| Error body | PP:610-615 | not documented on fetched pages | - | UNVERIFIABLE |
| Capabilities: customers note | PPC:24 "prefill via providerOptions.prefillUserLoginDetails" | code builds prefill from `customer.phone` (PP:329) | - | MISMATCH (internal claim, not docs; low) |

## Tests checked against the docs

- `test/providers/cashfree.test.ts:233-236` asserts that `rf_1` and `rf-1` are rejected as refundRef. Cashfree's own examples (`REF-123`, `refund_00912`, webhook `refund_sampleorder0413`) contradict this. Fix together with mismatch 1.
- `test/providers/cashfree.test.ts:222, 268-273, 391-405` use `refund_id: 'rf_1'` in mocked Cashfree responses while the adapter would refuse to create such a refund. Harmless, but inconsistent with the current validation.
- `test/providers/cashfree.test.ts:329-333` covers only `x-idempotency-header`; there is no test for the `x-idempotency-key` header shown in the API-reference webhook samples.
- Razorpay tests: signature vector (razorpay.test.ts:17) recomputed and correct; all other assertions agree with the docs.
- PhonePe tests: all assertions agree with the docs (`SHA256 ` prefix rejection at phonepe.test.ts:225 is consistent with the SDK's bare-hex sample).

## Round-1 fixes re-checked

All round-1 fixes are correct against the docs except one: the Cashfree refund_id charset fix (CF:51) is stricter than Cashfree's own examples (mismatch 1 below). The Cashfree `x-idempotency-header` addition is correct for the overview page but misses the header name used in the API reference (mismatch 2).

## Ranked MISMATCH list with exact fixes

1. **Cashfree refund_id charset is over-strict (CF:51, CF:384-389; CFC:15, CFC:37; cashfree.test.ts:233-236).** The prose says "Provie alphanumeric values", but the Create/Get Refund examples use `REF-123` and `refund_00912`, and the refund webhook sample uses `refund_sampleorder0413`. The round-1 fix now rejects refund ids that Cashfree itself documents, so refunds with common refundRefs fail before any call. Fix: `const REFUND_ID_RE = /^[A-Za-z0-9_-]{3,40}$/;`; change the error/hint to "3-40 characters of letters, digits, _ or -"; update CFC:15 and CFC:37; in the test, accept `rf_1`/`rf-1` and keep rejecting `r1`, 41 chars and a value with a space.
2. **Cashfree webhook dedupe header name (CF:475).** Overview says `x-idempotency-header`; the API-reference samples for webhook versions 2025-01-01 and 2026-01-01 send `x-idempotency-key`. Fix: `const idempotencyHeader = getHeader(input.headers, 'x-idempotency-header') ?? getHeader(input.headers, 'x-idempotency-key');` and mention both in CFC:17; add a test with `x-idempotency-key`.
3. **Razorpay subscriptions require totalCount even though end_at is a documented alternative (RZ:519-524).** Docs: total_count or `end_at` must be supplied. Fix: `if (!input.totalCount && input.providerOptions?.end_at === undefined) throw ...`, and send `total_count` only when set: `...(input.totalCount ? { total_count: input.totalCount } : {})`.
4. **PhonePe metaInfo free-form slots limited to udf1..udf5 (PP:162-170).** Docs allow free text in udf1..udf10 (256 chars). Fix: loop `for (let i = 1; i <= 10 && rest.length > 0; i++)` and change the message to "at most 10 free-form values (udf1..udf10)"; udf11-15 stay explicit-only because of their charset.
5. **PhonePe capability text contradicts the code (PPC:24).** The note says to prefill via `providerOptions.prefillUserLoginDetails`, but the adapter builds it from `customer.phone` (PP:329). Fix PPC:24: "PhonePe PG has no customer object; customer.phone is sent as prefillUserLoginDetails.phoneNumber."

## Notes (not mismatches)

- Razorpay order create: `receipt` is an idempotency key, and a second create with the same receipt returns 400 "Duplicate request". The adapter correctly never auto-retries, but a caller who retries after a timeout gets an error with no recovery. Optional improvement: on that error, fetch `GET /v1/orders?receipt=<orderRef>` and return the existing order.
- Razorpay `listSettlements` adds 86399 s to `to` (RZ:579), which assumes a date-only input; an ISO datetime is extended by a day.
- Cashfree `customer_phone`: `91XXXXXXXXXX` without `+` will be rejected by the API (10-char schema); the adapter does not normalise it.
- Cashfree `{order_id}` return_url placeholder is documented only in legacy docs; still unverified for 2026-01-01 (the code says so).
- Cashfree and PhonePe sandbox/live key guards and the PhonePe refund retry-safety rest on undocumented behaviour; the capability text already discloses this.
