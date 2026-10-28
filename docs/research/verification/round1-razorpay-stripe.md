# Verification round 1: Razorpay and Stripe adapters vs official docs

Date: 2026-10-29. Method: every externally visible fact in the adapters was checked against the official documentation, fetched live (razorpay.com/docs, docs.stripe.com, help.shopify.com). `docs/research/*.md` was not used. No code was changed.

Files checked:
- `src/providers/razorpay/adapter.ts`, `src/providers/razorpay/capabilities.ts`
- `src/providers/stripe/adapter.ts`, `src/providers/stripe/form.ts`, `src/providers/stripe/capabilities.ts`

Verdicts: **MATCH**, **MISMATCH**, **NOT IN DOCS** (the docs neither confirm nor contradict it), **COULD NOT ACCESS**. "R-" and "S-" ids are referenced in the summary at the end.

---

## Razorpay

| # | Item | Code says (file:line) | Docs say (short quote) | Doc URL | Verdict |
|---|---|---|---|---|---|
| R01 | API base URL | `https://api.razorpay.com/v1` (adapter.ts:39) | `-X POST https://api.razorpay.com/v1/orders` | https://razorpay.com/docs/api/orders/create/ | MATCH |
| R02 | Same host for test and live; key prefix decides mode | comment adapter.ts:42; prefix checks adapter.ts:579-585 | Auth page: "replace test mode keys with live mode keys"; no prefix or host stated | https://razorpay.com/docs/api/authentication/ | NOT IN DOCS (consistent with every example using one host) |
| R03 | Auth header | `Basic base64(keyId:keySecret)` (adapter.ts:124) | "base64 encoded string of `YOUR_KEY_ID:YOUR_KEY_SECRET`" | https://razorpay.com/docs/api/authentication/ | MATCH |
| R04 | Request body JSON | JSON via http client (core/http.ts:73-74) | parameters are "typically in JSON format" | https://razorpay.com/docs/api/understand/ | MATCH |
| R05 | Create order: method + path | `POST /orders` (adapter.ts:153) | `POST https://api.razorpay.com/v1/orders` | https://razorpay.com/docs/api/orders/create/ | MATCH |
| R06 | Order `amount` units | integer paise passed through (adapter.ts:146); capabilities.ts:27 | "Payment amount in the smallest currency sub-unit." | https://razorpay.com/docs/api/orders/create/ | MATCH |
| R07 | Minimum amount | "Minimum amount is 100 paise (Rs 1)." (capabilities.ts:34) | "The amount must be at least INR 1.00." | https://razorpay.com/docs/api/orders/create/ | MATCH |
| R08 | Order `currency` required | defaults `'INR'` (adapter.ts:144) | currency is required, "ISO code for the currency" | https://razorpay.com/docs/api/orders/create/ | MATCH |
| R09 | `receipt` length | "receipt ... max 40 characters." (capabilities.ts:35); sent as orderRef (adapter.ts:148) | "maximum length of 40 characters and has to be unique." | https://razorpay.com/docs/api/orders/create/ | MATCH (code doesn't enforce the 40-char limit) |
| R10 | `notes` limits | "max 15 key/value pairs, 256 chars each" (capabilities.ts:37) | "Maximum 15 key-value pairs, 256 characters (maximum) each." | https://razorpay.com/docs/api/orders/create/ | MATCH (adapter.ts:149 adds `order_ref` and merges metadata without checking the count) |
| R11 | Order status enum | `'created' \| 'attempted' \| 'paid'` (adapter.ts:62) | states `created`, `attempted`, `paid` | https://razorpay.com/docs/api/orders/create/ | MATCH |
| R12 | Order response fields read | `id, amount, amount_paid, amount_due, currency, receipt, status, notes` (adapter.ts:55-64) | Response lists id, amount, amount_paid, amount_due, currency, receipt, status, notes | https://razorpay.com/docs/api/orders/create/ | MATCH |
| R13 | Checkout.js URL | `https://checkout.razorpay.com/v1/checkout.js` (adapter.ts:40) | `https://checkout.razorpay.com/v1/checkout.js` | https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/ | MATCH |
| R14 | Checkout options `key`, `order_id`, `amount`, `currency`, `description` | emitted (adapter.ts:155-160) | key/amount/currency/order_id "mandatory"; description "optional" | https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/build-integration/ | MATCH |
| R15 | Checkout option `name` | **not emitted** (adapter.ts:155-168, 512-517) | `name`: "mandatory", "Your Business/Enterprise name shown on the Checkout form." | https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/build-integration/ | **MISMATCH** |
| R16 | Checkout `prefill.name/email/contact` | emitted (adapter.ts:161-165) | prefill child fields name, email, contact, each "optional" | same | MATCH |
| R17 | Redirect mode `callback_url` + `redirect: true` | adapter.ts:169-173, 516 | callback_url: "Customers will be redirected to this URL on successful payment." | https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/ | MATCH |
| R18 | Payment signature string + algorithm | `HMAC-SHA256(key_secret, order_id + "\|" + payment_id)` hex (adapter.ts:43-45; capabilities.ts:13) | `hmac_sha256(order_id + "\|" + razorpay_payment_id, secret)` | https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/ | MATCH |
| R19 | Which order_id is signed | uses `p.razorpay_order_id` from the browser payload (adapter.ts:223, 234); checks it against the server only if orderRef/expectedAmount were passed (241-249) | "Do not use the `razorpay_order_id` returned by Checkout." Use server-stored order_id. | same | **MISMATCH** |
| R20 | Callback field names | `razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature` (adapter.ts:190-191, 223) | Same three fields documented | same | MATCH |
| R21 | Subscription signature string | `HMAC-SHA256(key_secret, payment_id + "\|" + subscription_id)` (adapter.ts:47-49) | `hmac_sha256(razorpay_payment_id + "\|" + subscription_id, secret)` | https://razorpay.com/docs/payments/subscriptions/integration-guide/ | MATCH |
| R22 | Which subscription_id is signed | uses `p.razorpay_subscription_id` from the browser (adapter.ts:199, 202); checked against the server only if orderRef was passed (209) | Use the server's `subscription_id`, not the `razorpay_subscription_id` from Checkout | same | **MISMATCH** (same issue as R19) |
| R23 | Subscription callback fields | `razorpay_payment_id`, `razorpay_subscription_id`, `razorpay_signature` (adapter.ts:198-201) | Response returns those three fields | same | MATCH |
| R24 | Webhook signature header | `x-razorpay-signature` (adapter.ts:350) | passed "under the `X-Razorpay-Signature` header" | https://razorpay.com/docs/webhooks/validate-test/ | MATCH |
| R25 | Webhook signature algorithm/input/key | `HMAC-SHA256(webhookSecret, rawBody)` hex (adapter.ts:51-53) | "HMAC with SHA256"; raw body; "webhook secret set as the key" | same | MATCH |
| R26 | Webhook secret is not the API secret | capabilities.ts:31, 38 | webhook secret is the HMAC key (set per webhook) | same | MATCH |
| R27 | Event-id header for dedupe | `x-razorpay-event-id` (adapter.ts:371; capabilities.ts:17) | "The value for this header is unique per event" | same | MATCH |
| R28 | Webhook envelope fields | `event`, `created_at`, `payload.{payment,order,refund,subscription}.entity` (adapter.ts:358-367) | Top-level `entity, account_id, event, contains, payload, created_at` | https://razorpay.com/docs/webhooks/payloads/payments/ | MATCH |
| R29 | Event `payment.captured` | mapped (adapter.ts:374) | "Triggered when a payment is successfully captured." | https://razorpay.com/docs/webhooks/payloads/payments/ | MATCH |
| R30 | Event `payment.failed`, `payment.authorized` | mapped (adapter.ts:376-377) | "Triggered when a payment fails." / "...is authorised." | same | MATCH |
| R31 | Event `order.paid` with order entity + receipt | mapped; orderRef from `order.receipt` (adapter.ts:375, 398) | `payload.order.entity` contains `receipt`; only order event is `order.paid` | https://razorpay.com/docs/webhooks/orders/ | MATCH |
| R32 | Events `refund.processed`, `refund.failed` | mapped (adapter.ts:378-379) | "Triggered when the refund is successfully processed." / "not able to process" | https://razorpay.com/docs/webhooks/refunds/ | MATCH |
| R33 | Refund webhook entity fields | reads `id, payment_id, amount, notes, receipt` (adapter.ts:395-404) | refund entity: id, amount, payment_id, notes, receipt, status... | https://razorpay.com/docs/webhooks/refunds/ | MATCH |
| R34 | Subscription events | `subscription.activated/charged/halted/cancelled` (adapter.ts:380-383) | Listed among 10 subscription events | https://razorpay.com/docs/webhooks/subscriptions/ | MATCH |
| R35 | Subscription webhook entity used for orderRef | `payload.subscription.entity` is typed (adapter.ts:365) but never read; orderRef/providerOrderId stay empty for subscription.* | "payload.subscription.entity" is included in every event | https://razorpay.com/docs/webhooks/subscriptions/ | **MISMATCH** (the documented data exists but isn't read) |
| R36 | `payment.dispute.created` | mapped (adapter.ts:384) | Dispute events include `payment.dispute.created` | https://razorpay.com/docs/webhooks/disputes/ | MATCH |
| R37 | Dispute amount | amount read from `payment.entity` (adapter.ts:404) | Payload carries `payload.dispute.entity` | https://razorpay.com/docs/webhooks/disputes/ | **MISMATCH** (minor: reports the payment amount, not the disputed amount) |
| R38 | `settlement.processed` | mapped (adapter.ts:385); no settlement entity read, so amount is undefined | Payload `payload.settlement.entity` with id, amount, utr... | https://razorpay.com/docs/webhooks/settlements/ | **MISMATCH** (minor: event mapped, payload ignored) |
| R39 | Payment status enum | `created, authorized, captured, refunded, failed` (adapter.ts:72, 88-103) | "Possible values:" created, authorized, captured, refunded, failed | https://razorpay.com/docs/api/payments/fetch-with-id/ | MATCH |
| R40 | `refund_status` values | `'null' \| 'partial' \| 'full' \| null` (adapter.ts:74) | Values are `null`, `partial`, `full` | same | MATCH (the string `'null'` is harmless but wrong; the docs mean JSON null) |
| R41 | Partial refund keeps status `captured` | comment adapter.ts:91 | Docs don't say whether a partial refund changes status | https://razorpay.com/docs/payments/payments/ | NOT IN DOCS (code handles both cases) |
| R42 | Payment fields read | `amount_refunded, error_description, order_id, method, created_at` (adapter.ts:66-77) | All documented with these names | https://razorpay.com/docs/api/payments/fetch-with-id/ | MATCH |
| R43 | Fetch payments of an order | `GET /orders/{id}/payments`, reads `items` (adapter.ts:273, 277) | "`GET` `/v1/orders/:id/payments`"; response `entity: collection`, `items` | https://razorpay.com/docs/api/orders/fetch-payments/ | MATCH |
| R44 | Fetch order | `GET /orders/{id}` (adapter.ts:242, 272) | Orders API fetch by id | https://razorpay.com/docs/api/orders/create/ (index) | MATCH |
| R45 | Create refund path | `POST /payments/{id}/refund` (adapter.ts:315-317) | `POST /v1/payments/{id}/refund` | https://razorpay.com/docs/api/refunds/create-normal/ | MATCH |
| R46 | Refund `speed` | `'optimum'` for instant, else `'normal'` (adapter.ts:310) | "Supported values are `normal` and `optimum`" | https://razorpay.com/docs/api/refunds/create-instant/ | MATCH |
| R47 | Refund `amount` optional, full refund if omitted | only set when given (adapter.ts:314) | "If the `amount` parameter is not passed, the entire payment amount will be refunded." | https://razorpay.com/docs/api/refunds/create-normal/ | MATCH |
| R48 | Refund `receipt` and `notes` | receipt = refundRef; notes refund_ref/reason (adapter.ts:311-312) | receipt: "A unique identifier provided by you"; notes max 15 pairs | same | MATCH |
| R49 | Refund `receipt` is an idempotency key | refund POST not marked retry-safe (adapter.ts:315-320) | duplicate receipt on same payment gives a "Duplicate receipt" error | https://razorpay.com/docs/api/refunds/create-instant/ | MATCH (conservative; could be retry-safe but isn't required to be) |
| R50 | Refund status enum | `pending, processed, failed` (adapter.ts:83, 106-111) | `pending`, `processed` ("final state"), `failed` | https://razorpay.com/docs/api/refunds/fetch-with-id/ | MATCH |
| R51 | Fetch refund | `GET /refunds/{id}` (adapter.ts:335) | `-X GET https://api.razorpay.com/v1/refunds/rfnd_...` | same | MATCH |
| R52 | Create customer | `POST /customers` with name, email, contact, notes (adapter.ts:464-468) | POST /v1/customers; name, email, contact, notes | https://razorpay.com/docs/api/customers/create/ | MATCH (name 3-50 chars, email ≤64, contact ≤15 aren't validated) |
| R53 | `fail_existing` | `'0'` string returns the existing customer (adapter.ts:470) | `"0"`: "fetches details of the existing customer." | same | MATCH |
| R54 | Create plan | `POST /plans` with period, interval, item.{name,amount,currency} (adapter.ts:482-486) | POST /v1/plans; item.name/amount/currency required | https://razorpay.com/docs/api/payments/subscriptions/create-plan/ | MATCH |
| R55 | Plan `period` values | daily/weekly/monthly/yearly (adapter.ts:481) | daily, weekly, monthly, (quarterly), yearly | same | MATCH |
| R56 | Daily plan interval minimum | `interval: intervalCount ?? 1` with no check (adapter.ts:484) | "For daily plans, the minimum value should be `7`." | same | **MISMATCH** |
| R57 | Create subscription | `POST /subscriptions` with plan_id, total_count, notes (adapter.ts:495-499) | POST /v1/subscriptions; plan_id, total_count required | https://razorpay.com/docs/api/payments/subscriptions/create-subscription/ | MATCH |
| R58 | `total_count` required | throws without totalCount (adapter.ts:489-494) | total_count required; "either `total_count` or `end_at`" | same | MATCH |
| R59 | `customer_notify` type | `customer_notify: 1` (adapter.ts:498) | boolean: `true` (default) / `false` | same | **MISMATCH** (minor type difference) |
| R60 | `customer_id` on create subscription | sent when providerCustomerId given (adapter.ts:500) | Not a request parameter; populated "once the customer completes the authorisation" | same | **MISMATCH** |
| R61 | Subscription status mapping | `active` gives active, else pending_authorization (adapter.ts:507) | statuses: created, authenticated, active, pending, halted, cancelled, completed, expired | same | MATCH (coarse) |
| R62 | Subscription checkout options | key, subscription_id, prefill, callback_url, redirect (adapter.ts:512-517) | sample uses key, subscription_id, callback_url, prefill | https://razorpay.com/docs/payments/subscriptions/integration-guide/ | MATCH (`name` missing, same as R15) |
| R63 | Fetch subscription | `GET /subscriptions/{id}`, reads notes (adapter.ts:205, 208) | `-X GET .../v1/subscriptions/sub_...`; notes object | https://razorpay.com/docs/api/payments/subscriptions/fetch-subscription-id/ | MATCH |
| R64 | Cancel subscription path | `POST /subscriptions/{id}/cancel` (adapter.ts:526) | POST .../subscriptions/sub_.../cancel | https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription/ | MATCH |
| R65 | `cancel_at_cycle_end` type | `1 : 0` (adapter.ts:528) | boolean `true` / `false` (default); 1/0 only mentioned in failure guidance | same | **MISMATCH** (minor; tolerated) |
| R66 | Status after cancel | `cancelled` (adapter.ts:535) | "The status changes to `cancelled`" (at cycle end if requested) | same | MATCH |
| R67 | List settlements | `GET /settlements?from&to&count` (adapter.ts:541-548) | GET /v1/settlements/; from, to (unix seconds), count, skip | https://razorpay.com/docs/api/settlements/fetch-all/ | MATCH |
| R68 | `count` limit | `min(count ?? 25, 100)` (adapter.ts:544) | "Default is `10`... range is `1` to `100`" | same | MATCH |
| R69 | Settlement fields | id, amount, status, utr, created_at, fees, tax (adapter.ts:545) | id, amount, status (created/processed/failed), fees, tax, utr, created_at | same | MATCH |
| R70 | Error body | `error.code`, `error.description` (adapter.ts:588-591) | `error.code` "Type of the error"; `error.description` "Descriptive text" | https://razorpay.com/docs/errors/ | MATCH |
| R71 | Auto-capture / capture window | "payments auto-refund after the capture window" (capabilities.ts:36) | not captured "within this period will be refunded automatically" (3 days) | https://razorpay.com/docs/payments/payments/capture-settings/ | MATCH |
| R72 | Order is "paid" only after capture | capabilities.ts:36 | "After the successful capture of the payment, the order moves to the `paid` state." | https://razorpay.com/docs/api/orders/create/ | MATCH |
| R73 | paymentMethods list | `upi, card, netbanking, wallet, emi, cardless_emi, paylater` (capabilities.ts:24) | method values: card, netbanking, wallet, emi, upi, paylater | https://razorpay.com/docs/api/payments/fetch-with-id/ | NOT IN DOCS (`cardless_emi` isn't in the payment-entity enum on that page) |
| R74 | Signature compare constant-time | `safeEqual` (adapter.ts:202, 235, 352) | (docs only say compare) | — | MATCH (best practice) |

---

## Stripe

| # | Item | Code says (file:line) | Docs say (short quote) | Doc URL | Verdict |
|---|---|---|---|---|---|
| S01 | API base URL | `https://api.stripe.com/v1` (adapter.ts:41) | `curl https://api.stripe.com/v1/charges` | https://docs.stripe.com/api/authentication | MATCH |
| S02 | Auth header | `Bearer sk_...` (adapter.ts:294) | "If you need to authenticate using bearer auth... `Authorization: Bearer`" | same | MATCH |
| S03 | Key prefixes | sk_test_/sk_live_/rk_test_/rk_live_ (adapter.ts:976-983; capabilities.ts:54) | `sk_test_`, `sk_live_`, restricted `rk_live_`; restricted keys in both modes | same | MATCH |
| S04 | Request body encoding | `application/x-www-form-urlencoded` (form.ts:2; core/http.ts:69) | "accepts form-encoded request bodies, returns JSON-encoded responses" | https://docs.stripe.com/api | MATCH |
| S05 | Nested/array encoding | `a[0][b]=`, `metadata[k]=` (form.ts:21-32) | examples `line_items[0][price]`, `expand[]` | https://docs.stripe.com/api/checkout/sessions/create | MATCH |
| S06 | `Stripe-Version` header | `Stripe-Version: 2025-03-31.basil` (adapter.ts:48, 313) | "unless you override it by setting the `Stripe-Version` header" | https://docs.stripe.com/api/versioning | MATCH |
| S07 | Version string validity | `2025-03-31.basil` (adapter.ts:48) | "`2025-03-31.basil` introduces both breaking changes and new features" | https://docs.stripe.com/changelog/basil | MATCH (valid; not current, since docs say "The current version is 2026-09-30.endive") |
| S08 | Webhook payload version is not the request header | comment adapter.ts:46; capabilities.ts:80 | "Webhook events use the API version that's set during... endpoint creation" | https://docs.stripe.com/api/versioning | MATCH |
| S09 | Basil moved invoice.subscription to `parent.subscription_details.subscription` | adapter.ts:44-45, 760-765 | `parent.subscription_details.subscription` (string, expandable) | https://docs.stripe.com/api/invoices/object (query=parent) | MATCH |
| S10 | Idempotency-Key header on every POST | adapter.ts:314 | "all `POST` requests accept idempotency keys" | https://docs.stripe.com/api/idempotent_requests | MATCH |
| S11 | No key on GET/DELETE | only for POST (adapter.ts:314) | "Don't send idempotency keys in `GET` and `DELETE` requests" | same | MATCH |
| S12 | Key lifetime 24 h | capabilities.ts:77; comment adapter.ts:303 | "remove keys ... after they're at least 24 hours old" | same | MATCH |
| S13 | Same key + different params errors | capabilities.ts:77 | "errors if they're not the same to prevent accidental misuse" | same | MATCH |
| S14 | Key length | `checkout_session:${orderRef}`, raw `refundRef` etc., unvalidated (adapter.ts:369, 418, 576, 906) | "Idempotency keys are up to 255 characters long." | same | MATCH (limit isn't enforced; long refs will be rejected) |
| S15 | Retrying 5xx with same key | POSTs `retrySafe: true` (adapter.ts:323) | "Retries with the same key return the saved response, including `500` errors." | same | MATCH (note: retrying a 5xx returns the cached 500; only network errors and 409/429 retries help) |
| S16 | Checkout Session create path | `POST /checkout/sessions` (adapter.ts:367) | `curl https://api.stripe.com/v1/checkout/sessions` | https://docs.stripe.com/api/checkout/sessions/create | MATCH |
| S17 | `mode` values | `payment` / `subscription` (adapter.ts:349, 891) | enum `payment`, `setup`, `subscription` | same | MATCH |
| S18 | `line_items[].price_data.{currency,unit_amount,product_data.name}` | adapter.ts:350-355 | currency (lowercase, required), product_data.name required | https://docs.stripe.com/api/checkout/sessions/create (query=line_items) | MATCH |
| S19 | Currency lowercase | `.toLowerCase()` (adapter.ts:329, 877) | "Three-letter ISO currency code, in lowercase." | same | MATCH |
| S20 | `recurring.interval` / `interval_count` | `recurring: { interval, interval_count }` (adapter.ts:879) | "Either `day`, `week`, `month` or `year`." | same | MATCH |
| S21 | `success_url` template | appends `session_id={CHECKOUT_SESSION_ID}` (adapter.ts:262-264) | "This is a literal string and you must add it exactly" | https://docs.stripe.com/payments/checkout/custom-success-page?payment-ui=stripe-hosted | MATCH (form encoding percent-encodes the braces; the server decodes them) |
| S22 | `cancel_url` | = returnUrl (adapter.ts:357) | "customers will be directed to this URL if they decide to cancel" | https://docs.stripe.com/api/checkout/sessions/create | MATCH |
| S23 | `client_reference_id` | = orderRef (adapter.ts:358) | "The maximum length is 200 characters." | same | MATCH (limit isn't enforced) |
| S24 | `customer_email` vs `customer` | email omitted when customer set (adapter.ts:896-897) | customer_email "used when the Customer object is created" | same | MATCH |
| S25 | `billing_address_collection` | `'required'` (adapter.ts:361, 898) | enum `auto` / `required`: "Checkout will always collect the customer's billing address." | same | MATCH |
| S26 | `payment_intent_data.{description,metadata}` | adapter.ts:363 | "passed to PaymentIntent creation for Checkout Sessions in `payment` mode"; description, metadata | same (query=payment_intent_data) | MATCH |
| S27 | `subscription_data.metadata` | adapter.ts:900 | `subscription_data.metadata` (map, optional) | same (query=subscription_data) | MATCH |
| S28 | Session default expiry 24 h | capabilities.ts:79 | "By default, this value is 24 hours from creation." | https://docs.stripe.com/api/checkout/sessions/create | MATCH |
| S29 | Session `url` null for non-hosted ui_mode | error hint names `'embedded'/'custom'` (adapter.ts:371-376) | url "Applies to Checkout Sessions with `ui_mode: hosted_page`" | https://docs.stripe.com/api/checkout/sessions/object | MATCH for basil (current docs renamed the values to `embedded_page`/`elements`/`form`; update the hint if the version is bumped) |
| S30 | Session `status` enum and nullability | `'open' \| 'complete' \| 'expired' \| null` (adapter.ts:114) | "(enum, nullable)... one of `open`, `complete`, or `expired`" | same | MATCH |
| S31 | Session `payment_status` enum | `paid, unpaid, no_payment_required` (adapter.ts:115) | "one of `paid`, `unpaid`, or `no_payment_required`" | same | MATCH |
| S32 | Complete but unpaid means pending | adapter.ts:204-207 | complete: "Payment processing may still be in progress" | same | MATCH |
| S33 | Session fields read | `amount_total, currency, client_reference_id, metadata, payment_intent, subscription, expires_at, url` (adapter.ts:109-125) | All documented; payment_intent and subscription "expandable" | same | MATCH |
| S34 | Retrieve session with expand | `GET /checkout/sessions/{id}?expand[]=payment_intent&expand[]=payment_intent.latest_charge` (adapter.ts:456-461) | expand nested "up to a maximum depth of four levels" | https://docs.stripe.com/api/expanding_objects | MATCH |
| S35 | Expire session | `POST /checkout/sessions/{id}/expire` (adapter.ts:923) | "can be expired when it is in one of these statuses: `open`" | https://docs.stripe.com/api/checkout/sessions/expire | MATCH |
| S36 | Subscription created only after Checkout completes | capabilities.ts:33; adapter.ts:911-912 | Basil: Checkout "now postpone[s] creation of subscriptions until after the user completes payment" | https://docs.stripe.com/changelog/basil | MATCH |
| S37 | PaymentIntent create | `POST /payment_intents` with amount, currency, automatic_payment_methods.enabled, description, metadata, receipt_email (adapter.ts:405-416) | all documented params; `automatic_payment_methods.enabled` (boolean, required) | https://docs.stripe.com/api/payment_intents/create | MATCH |
| S38 | PaymentIntent status enum | 7 values (adapter.ts:93-100, 180-196) | "one of `requires_payment_method`, `requires_confirmation`, `requires_action`, `processing`, `requires_capture`, `canceled`, or `succeeded`" | https://docs.stripe.com/api/payment_intents/object | MATCH |
| S39 | `latest_charge` expandable | `expand[]=latest_charge` (adapter.ts:465) | "(string, nullable, expandable)... ID of the latest Charge" | same | MATCH |
| S40 | `last_payment_error`, `client_secret`, `metadata` | adapter.ts:101-105 | documented with these names | same | MATCH |
| S41 | Charge fields read | `amount_refunded, refunded, payment_intent, failure_message, payment_method_details.type` (adapter.ts:75-85) | documented with these names | https://docs.stripe.com/api/charges/object | MATCH |
| S42 | Stripe.js redirect params | `?payment_intent=pi_...&redirect_status=...` (adapter.ts:470-471, 477) | "`payment_intent` ... or `payment_intent_client_secret`" appended to return_url | https://docs.stripe.com/js/payment_intents/confirm_payment | MATCH (`redirect_status` isn't on this page; the code doesn't depend on it) |
| S43 | Billing details at confirm time | `billingDetails` handed to the browser (adapter.ts:421-431) | confirmPayment `payment_method_data.billing_details` | same | MATCH |
| S44 | Stripe.js URL | `https://js.stripe.com/v3/` (adapter.ts:42) | "continue to support `js.stripe.com/v3` for the foreseeable future"; versioned URLs recommended (`js.stripe.com/endive/stripe.js`) | https://docs.stripe.com/sdks/stripejs-versioning | MATCH (supported, but not the recommended versioned URL) |
| S45 | Create refund | `POST /refunds` with payment_intent or charge, amount, reason, metadata (adapter.ts:564-576) | params `payment_intent`, `charge`, `amount`, `reason`, `metadata` | https://docs.stripe.com/api/refunds/create | MATCH |
| S46 | Refund `reason` enum | `duplicate, fraudulent, requested_by_customer` (adapter.ts:52) | "possible values are `duplicate`, `fraudulent`, and `requested_by_customer`" | same | MATCH |
| S47 | No refund speed option | speed ignored (adapter.ts:575; capabilities.ts:23) | No speed/instant parameter in the create-refund params | same | MATCH |
| S48 | Refund status enum and nullability | `pending, requires_action, succeeded, failed, canceled, null` (adapter.ts:131) | "(string, nullable)... `pending`, `requires_action`, `succeeded`, `failed`, or `canceled`" | https://docs.stripe.com/api/refunds/object | MATCH |
| S49 | Fetch / list refunds | `GET /refunds/{id}`; `GET /refunds?payment_intent=\|charge=&limit=100` (adapter.ts:590-594) | list filters `charge`, `payment_intent`; limit "between 1 and 100" | https://docs.stripe.com/api/refunds/list | MATCH |
| S50 | Metadata limits | "max 50 keys, key <= 40 chars, value <= 500 chars" (capabilities.ts:78); reason sliced to 500 (adapter.ts:572) | "up to 50 keys, with key names up to 40 characters ... values up to 500" | https://docs.stripe.com/api/metadata | MATCH (also: "can't use square brackets ([ and ]) in keys", not enforced for user metadata) |
| S51 | `Stripe-Signature` format | `t=...,v1=...,v0=...` parsed; only `v1` used (adapter.ts:59-73) | "only valid live signature scheme is `v1`"; "ignore all schemes that aren't `v1`" | https://docs.stripe.com/webhooks (verify manually) | MATCH |
| S52 | Signed payload | `${t}.${rawBody}` (adapter.ts:55-57) | timestamp, "The character `.`", "The actual JSON payload" | same | MATCH |
| S53 | Algorithm / key | HMAC-SHA256 hex with whsec_ (adapter.ts:56) | "Compute an HMAC with the SHA256 hash function"; endpoint signing secret as key | same | MATCH |
| S54 | Compare against every v1 constant-time | adapter.ts:621-623 | "use a constant-time-string comparison ... to each of the received signatures" | same | MATCH |
| S55 | Tolerance 300 s, never 0 | adapter.ts:49-50, 630-636 | "default tolerance of 5 minutes"; "Don't use a tolerance value of `0`." | same | MATCH |
| S56 | Retries carry a fresh timestamp | hint adapter.ts:634 | "we generate a new signature and timestamp for the new delivery attempt" | same | MATCH |
| S57 | Dedupe on event id | capabilities.ts:28 | "logging the event IDs you've processed" | same | MATCH |
| S58 | `checkout.session.completed / async_payment_succeeded / async_payment_failed` | adapter.ts:651-673 | data.object is `checkout.session`; async = "delayed payment method" | https://docs.stripe.com/api/events/types | MATCH |
| S59 | `payment_intent.succeeded / payment_failed / processing / amount_capturable_updated / canceled` | adapter.ts:677-683 | all five exist; data.object `payment_intent` | same | MATCH |
| S60 | `refund.created / refund.updated / refund.failed` | adapter.ts:696 | data.object `refund` | same | MATCH |
| S61 | `charge.refund.updated` | treated as refund object (adapter.ts:696-697) | "`data.object` is one of: `refund`" | same | MATCH |
| S62 | `charge.refunded` mapped to `refund.processed` | adapter.ts:711-724 | "Occurs whenever a charge is refunded, including partial refunds. Listen to `refund.created`" | same | **MISMATCH** (the refund may still be pending; UPI refunds are async) |
| S63 | `charge.dispute.created` fields | reads `amount, currency, charge, payment_intent` (adapter.ts:727) | dispute has `amount`, `charge`, `currency`, `payment_intent` (nullable) | https://docs.stripe.com/api/disputes/object | MATCH |
| S64 | `customer.subscription.created/updated/deleted/paused/resumed` | adapter.ts:738-751 | all five exist; paused/resumed only for `status=paused` | https://docs.stripe.com/api/events/types | MATCH |
| S65 | Subscription status enum | 8 values (adapter.ts:140) | "`incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`, or `paused`" | https://docs.stripe.com/api/subscriptions/object | MATCH |
| S66 | `invoice.paid` + `amount_paid` | adapter.ts:754-775 | "Occurs whenever an invoice payment attempt succeeds"; `amount_paid` (integer) | https://docs.stripe.com/api/events/types ; /api/invoices/object | MATCH |
| S67 | `payout.paid` | mapped to settlement.processed (adapter.ts:777-780) | "Occurs whenever a payout is *expected* to be available" | https://docs.stripe.com/api/events/types | MATCH |
| S68 | Cancel subscription now | `DELETE /subscriptions/{id}` (adapter.ts:933) | `curl -X DELETE https://api.stripe.com/v1/subscriptions/{{SUBSCRIPTION_ID}}` | https://docs.stripe.com/api/subscriptions/cancel | MATCH |
| S69 | Cancel at period end | `POST /subscriptions/{id}` `cancel_at_period_end=true` (adapter.ts:929-931) | `cancel_at_period_end` (boolean): cancel "at the end of the current period" | https://docs.stripe.com/api/subscriptions/update | MATCH |
| S70 | Create customer | `POST /customers` with name, email, phone, metadata (adapter.ts:856-858) | `name`, `email`, `phone`, `metadata` params | https://docs.stripe.com/api/customers/create | MATCH |
| S71 | List payouts filters | `arrival_date[gte]`, `arrival_date[lte]`, `limit<=100` (adapter.ts:946-948) | `arrival_date.gte` / `.lte` inclusive; limit 1–100 | https://docs.stripe.com/api/payouts/list | MATCH |
| S72 | Payout status enum | `paid, pending, in_transit, canceled, failed` (adapter.ts:149) | "`paid`, `pending`, `in_transit`, `canceled` or `failed`" | https://docs.stripe.com/api/payouts/object | MATCH |
| S73 | Payout `trace_id.value` | adapter.ts:152, 957 | "The trace ID value if `trace_id.status` is `supported`, otherwise `nil`." | same (query=trace_id) | MATCH |
| S74 | Error body | `error.code ?? decline_code ?? type`, `error.message` (adapter.ts:996-999) | `code`, `decline_code`, `message`, `type` documented | https://docs.stripe.com/api/errors | MATCH |
| S75 | India invite-only | capabilities.ts:10, 72 | "Stripe is available by invite only in India." | https://docs.stripe.com/india-accept-international-payments | MATCH |
| S76 | "since ~May 2024" | capabilities.ts:72 | (no date given) | same | NOT IN DOCS |
| S77 | Only registered businesses, no individuals | capabilities.ts:72 | "sole proprietorship, limited liability partnership, or company"; "can't be an individual" | same | MATCH |
| S78 | Presentment currencies | "135+ ... on Visa/Mastercard, INR/USD on Amex" (capabilities.ts:45) | "135+ currencies on Visa and Mastercard, and INR or USD ... American Express" | same | MATCH |
| S79 | FIRC/eFIRA mention | capabilities.ts:45 | not mentioned on the page | same | NOT IN DOCS |
| S80 | Export charge needs name, billing address, description | capabilities.ts:74; adapter.ts:333, 361, 363 | "The customer's name", "The billing address", "The charge description" | same | MATCH |
| S81 | UPI on Indian Stripe accounts | `paymentMethods: ['card','upi']`, comment "UPI on Indian accounts is listed" (capabilities.ts:42-43) | UPI "Business locations" list: AT, AU, ... SG, SI, SK, US (no IN) | https://docs.stripe.com/payments/upi | **MISMATCH** |
| S82 | RBI e-mandate with AFA (3DS / UPI PIN) | capabilities.ts:75 | "validated through AFA, such as 3DS"; "UPI PIN for UPI" | https://docs.stripe.com/india-recurring-payments | MATCH |
| S83 | Pre-debit ≥24 h, ~26 h card hold, PI in `processing` | capabilities.ts:75 | "at least 24 hours"; "delays collecting card payments by 26 hours"; "transitions to a `processing` state" | same | MATCH |
| S84 | >Rs 15,000 needs AFA; UPI recurring >15,000 unsupported | capabilities.ts:76 | "over 15,000 INR ... must go through AFA each time"; UPI not supported above 15,000 INR | same | MATCH |
| S85 | Mandates can't be updated/cancelled via API | capabilities.ts:76 | "You can't cancel or update a mandate." | same | MATCH |
| S86 | Shopify Payments not available for India stores | capabilities.ts:73, 91 | India absent from the Shopify Payments supported-countries list (via search) | https://help.shopify.com/en/manual/payments/shopify-payments/supported-countries | MATCH (the list page couldn't be fetched directly; confirmed through search results only) |
| S87 | Webhook endpoints set in Dashboard; notifyUrl ignored | capabilities.ts:80 | endpoints created in Workbench or `/v2/core/event_destinations` | https://docs.stripe.com/webhooks | MATCH |

---

## Summary: mismatches and fixes

### Razorpay

1. **R15 / R62: Checkout option `name` is missing.** The docs mark `name` as mandatory. Fix: add `name: <merchant display name>` to both checkout `options` objects (adapter.ts:155-168 and 512-517). This needs a source for the value, for example a new optional credential/config such as `RAZORPAY_MERCHANT_NAME`, or an input field.
2. **R19 / R22: the signature is computed over browser-supplied ids.** The docs say to use the server-stored `order_id` (and `subscription_id`), not the ones Checkout returns. Today, when the caller passes neither `orderRef` nor `expectedAmount`, a valid signature for *any* order passes. Fix: accept `input.providerOrderId` (and, for subscriptions, the stored `sub_` id) and compute the HMAC with it. If neither `providerOrderId` nor `orderRef` is given, return `valid: false` ("cannot bind to an order"). Keep the receipt/amount lookup.
3. **R60: `customer_id` is not a documented create-subscription parameter** (adapter.ts:500). Razorpay fills it in after authorisation. Fix: stop sending it; if the link matters, store `providerCustomerId` in `notes`.
4. **R56: daily plans need `interval >= 7`.** Fix: in `createSubscription` (adapter.ts:481-486), if `period === 'daily' && interval < 7`, throw `PaymentError('VALIDATION', 'Razorpay daily plans need intervalCount >= 7')`.
5. **R59: `customer_notify` is boolean.** Fix: `customer_notify: true` (adapter.ts:498).
6. **R65: `cancel_at_cycle_end` is boolean.** Fix: `{ cancel_at_cycle_end: input.atCycleEnd === true }` (adapter.ts:528). 1/0 is tolerated today.
7. **R35: subscription webhooks ignore `payload.subscription.entity`.** Fix in parseWebhook: `const sub = body.payload.subscription?.entity;` then `orderRef: order?.receipt ?? sub?.notes?.subscription_ref`, `providerOrderId: payment?.order_id ?? order?.id ?? sub?.id`.
8. **R37: dispute amount comes from the payment.** Fix: add `dispute?: { entity: { id: string; amount: number; currency: string } }` to the payload type and use `dispute.amount` for `payment.dispute.*`.
9. **R38: `settlement.processed` doesn't read `payload.settlement.entity`.** Fix: read its `id`/`amount`/`utr` into the normalized event.
10. Cosmetic, R40: `refund_status` type has the string `'null'`; it should be `null` only.

### Stripe

1. **S81: UPI is claimed for Indian Stripe accounts.** Stripe's UPI page lists the business locations that can accept UPI, and IN isn't among them. Fix: change `paymentMethods` to `['card']` for India-domiciled accounts (capabilities.ts:43) and rewrite the comment at capabilities.ts:42. Optionally add a note that UPI is for non-India Stripe accounts charging Indian customers. The RBI e-mandate constraints can stay, since they apply to Indian cards and UPI wherever the account is.
2. **S62: `charge.refunded` is mapped to `refund.processed`.** The docs say it fires on any (partial) refund, and the refund itself may still be `pending` (UPI refunds take up to 7 working days). Its `amount_refunded` is also cumulative, not this refund's amount. Fix: map `charge.refunded` to `type: 'unknown'`, or a pending type, and rely on `refund.updated` / `refund.failed` for the final state (adapter.ts:711-724).

No other Stripe mismatches. Items to watch (not wrong today):
- S07: the pinned API version `2025-03-31.basil` is valid but four major releases behind the current `2026-09-30.endive`. If it's bumped, update the `ui_mode` hint (S29: `embedded_page`/`elements`/`form`) and re-check invoice and Checkout shapes.
- S44: `js.stripe.com/v3/` is still supported, but Stripe recommends the versioned URL (e.g. `https://js.stripe.com/basil/stripe.js` to match the pinned API version).
- S14 / S23: the 255-char idempotency-key limit and the 200-char `client_reference_id` limit aren't enforced.
- S15: retrying a 5xx with the same Idempotency-Key returns the cached 500. Auto-retries only help for network errors and 409/429.

## Could not verify

- R02: that Razorpay test and live share one host, and the `rzp_test_` / `rzp_live_` prefixes. No official page states either explicitly.
- R41: whether a Razorpay payment's `status` becomes `refunded` after a partial refund. Not documented; the code handles both cases.
- R73: `cardless_emi` as a Razorpay `method` value. It isn't in the payment-entity enum on the fetched page.
- S76 / S79: Stripe India's "since ~May 2024" date and FIRC/eFIRA. Not on Stripe's India page.
- S86: the Shopify Payments supported-countries page couldn't be fetched directly. The verdict rests on search results.
- S42: `redirect_status` as a Stripe.js return_url parameter isn't on the confirmPayment page. The code doesn't depend on it.
