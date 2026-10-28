# Verification round 1: Cashfree PG and PhonePe PG Standard Checkout v2

Date: 2026-10-29. Method: every external fact in the adapters was checked against the official docs, fetched live during this round (not from memory and not from docs/research/*.md). Quotes are short paraphrases or excerpts of 15 words or fewer. No code was changed.

Abbreviations: CF = `src/providers/cashfree/adapter.ts`, CFC = `src/providers/cashfree/capabilities.ts`, PP = `src/providers/phonepe/adapter.ts`, PPC = `src/providers/phonepe/capabilities.ts`.

Doc URL keys (Cashfree):
- [C-create] https://www.cashfree.com/docs/api-reference/payments/latest/orders/create
- [C-get] https://www.cashfree.com/docs/api-reference/payments/latest/orders/get
- [C-pays] https://www.cashfree.com/docs/api-reference/payments/latest/payments/get-payments-for-order
- [C-rf] https://www.cashfree.com/docs/api-reference/payments/latest/refunds/create
- [C-rfget] https://www.cashfree.com/docs/api-reference/payments/latest/refunds/get
- [C-wh-pay] https://www.cashfree.com/docs/api-reference/payments/latest/payments/webhooks
- [C-wh-rf] https://www.cashfree.com/docs/api-reference/payments/latest/refunds/webhooks
- [C-wh-disp] https://www.cashfree.com/docs/api-reference/payments/latest/disputes/dispute-webhooks
- [C-wh-sig] https://www.cashfree.com/docs/payments/online/webhooks/signature-verification
- [C-wh-ov] https://www.cashfree.com/docs/payments/online/webhooks/overview
- [C-js] https://www.cashfree.com/docs/payments/online/web/redirect
- [C-mig] https://www.cashfree.com/docs/payments/migration/migration
- [C-plans] https://www.cashfree.com/docs/api-reference/payments/latest/subscription/plans/create
- [C-subs] https://www.cashfree.com/docs/api-reference/payments/latest/subscription/mandate/create
- [C-api-ov] https://www.cashfree.com/docs/api-reference/payments/overview
- [C-payout] https://www.cashfree.com/docs/api-reference/payouts/getting-started-with-payouts-apis

Doc URL keys (PhonePe, all under https://developer.phonepe.com/payment-gateway/):
- [P-auth] website-integration/standard-checkout/api-integration/api-reference/authorization
- [P-pay] website-integration/standard-checkout/api-integration/api-reference/create-payment
- [P-init] website-integration/standard-checkout/api-integration/api-reference/create-payment/initiate-payment
- [P-status] website-integration/standard-checkout/api-integration/api-reference/order-status
- [P-refund] website-integration/standard-checkout/api-integration/api-reference/refund
- [P-wh] website-integration/standard-checkout/api-integration/api-reference/webhook
- [P-steps] website-integration/standard-checkout/api-integration/integration-steps
- [P-node-wh] backend-sdk/nodejs-be-sdk/api-reference-node-js/webhook-handling
- [P-iframe] website-integration/standard-checkout/api-integration/api-reference/invoke-iframe-paypage
- [P-autopay] autopay/standard-checkout/subscription-cancel
- [P-settle] https://developer.phonepe.com/settlement

## Cashfree PG

| # | Item | Code says (file:line) | Docs say | Doc URL | Verdict |
|---|------|------------------------|----------|---------|---------|
| 1 | Sandbox base URL | `https://sandbox.cashfree.com/pg` (CF:32) | Sandbox `https://sandbox.cashfree.com/pg` | C-create | MATCH |
| 2 | Production base URL | `https://api.cashfree.com/pg` (CF:33) | Production `https://api.cashfree.com/pg` | C-create | MATCH |
| 3 | Auth headers | `x-client-id`, `x-client-secret` (CF:177-178) | Security schemes include x-client-id and x-client-secret | C-create | MATCH |
| 4 | x-api-version value | `2026-01-01` (CF:36) | Default and only listed value `2026-01-01` | C-create, C-get, C-rf | MATCH (latest) |
| 5 | x-idempotency-key on create order | sent when `idempotencyKey` given (CF:239) | Optional, "UUID-formatted key"; retry with same key | C-create | MATCH (but key must be UUID; code does not enforce, see notes) |
| 6 | Create order method/path | `POST /orders` (CF:237) | `POST /orders` | C-create | MATCH |
| 7 | order_id length/charset | `/^[A-Za-z0-9_-]{3,45}$/` (CF:40) | 3-45 chars; "Only alphanumeric characters, underscores (_), and hyphens (-)" | C-create | MATCH |
| 8 | order_amount unit/type | rupees as JSON number via `toRupees` (CF:48-50, 221) | number (double), up to two decimals | C-create | MATCH |
| 9 | order_amount minimum | constraint "minimum Rs 1" (CFC:33); not validated in code | minimum 1 | C-create | MATCH (doc text); code does not pre-validate |
| 10 | order_currency | `order_currency: currency` (CF:222) | string, in required list; INR if empty | C-create | MATCH |
| 11 | customer_details required | always sent (CF:223-228) | `customer_details` required | C-create | MATCH |
| 12 | customer_id required | always sent (CF:224) | customer_id required, 3-50 chars | C-create | MATCH |
| 13 | customer_id charset | derived id `cust_<24 hex>` (CF:208) | "A unique identifier for the customer. Use alphanumeric values only." | C-create | MISMATCH (underscore) |
| 14 | customer_phone required | throws if missing (CF:199-205) | customer_phone required | C-create | MATCH |
| 15 | customer_phone format | strips spaces/dashes, no length check (CF:199) | 10 chars; prefix "+" to override 10-digit limit | C-create | MATCH (no client-side check; 91XXXXXXXXXX without + will be rejected by API) |
| 16 | customer_email / customer_name | passed through (CF:226-227) | optional, 3-100 chars each | C-create | MATCH (no length check) |
| 17 | order_meta.return_url | sent; `{order_id}` appended if absent (CF:210-216) | max 250 chars; GET after terminal state | C-create | MATCH |
| 18 | `{order_id}` placeholder in return_url | Cashfree substitutes `{order_id}` (CF:211-213) | Migration guide: new format `...return.php?order_id={order_id}` | C-mig | MATCH (only in migration guide; latest API ref and web-checkout page do not mention it) |
| 19 | order_meta.notify_url | sent if `notifyUrl` (CF:217) | max 250; "NotifyUrl should be an https URL." | C-create | MATCH (https not validated) |
| 20 | order_note | `order_note: description` (CF:230) | 3-200 chars | C-create | MATCH (length not validated) |
| 21 | order_tags | `order_tags: metadata` (CF:231) | values 1-255 chars; "A maximum of 10 tags" (schema says 15) | C-create | MATCH (limits not validated; docs self-inconsistent 10 vs 15) |
| 22 | Response cf_order_id | `String(order.cf_order_id)` (CF:251) | cf_order_id: string | C-create | MATCH |
| 23 | Response payment_session_id | required, used for checkout (CF:243, 262) | "Use it to create a transaction for the order" | C-create | MATCH |
| 24 | Response order_expiry_time | `expiresAt: order.order_expiry_time` (CF:265) | order_expiry_time: string timestamp | C-create | MATCH |
| 25 | order_status enum | ACTIVE, PAID, EXPIRED, TERMINATED, TERMINATION_REQUESTED (CF:57, 108-122) | Same five values | C-create, C-get | MATCH |
| 26 | Get order | `GET /orders/{order_id}` (CF:188-190, 307) | `GET /orders/{order_id}` | C-get | MATCH |
| 27 | Get payments for order | `GET /orders/{order_id}/payments`, array (CF:308, 312) | `GET /orders/{order_id}/payments`, response is array | C-pays | MATCH |
| 28 | payment_status enum | SUCCESS, FAILED, PENDING, FLAGGED, USER_DROPPED, CANCELLED, VOID, NOT_ATTEMPTED (CF:87-105) | SUCCESS, NOT_ATTEMPTED, FAILED, USER_DROPPED, VOID, CANCELLED, PENDING | C-pays | MATCH (all doc values covered; FLAGGED is extra, NOT IN DOCS, harmless) |
| 29 | cf_payment_id type | `string \| number`, stringified (CF:64, 332) | cf_payment_id: string | C-pays | MATCH |
| 30 | payment fields read | payment_amount, payment_currency, payment_message, payment_time, payment_group (CF:67-71) | all listed on payment entity | C-pays | MATCH |
| 31 | error_details fields | error_description, error_reason (CF:72, 337) | error_code, error_description, error_reason, error_source, ... | C-pays | MATCH |
| 32 | payment_group values / mapMethod | regex mapping (CF:132-139) | prepaid_card, upi_ppi_offline, cash, upi_credit_card, paypal, net_banking, cardless_emi, credit_card, bank_transfer, pay_later, debit_card_emi, debit_card, wallet, upi_ppi, upi, credit_card_emi | C-pays | MISMATCH (logic: `cardless_emi` maps to `card`; `upi_credit_card` maps to `card`; `upi_ppi*` pass through raw) |
| 33 | Create refund method/path | `POST /orders/{order_id}/refunds` (CF:359) | `POST /orders/{order_id}/refunds` | C-rf | MATCH |
| 34 | refund_amount | rupees number, required; full amount looked up if omitted (CF:346-353) | required, number; <= transaction amount | C-rf | MATCH |
| 35 | refund_id | `refund_id: refundRef` (CF:354) | required, 3-40 chars, alphanumeric ("Provie alphanumeric values") | C-rf | MATCH on presence; charset/length not validated (refundRef with `_`/`-` may be rejected) |
| 36 | refund_speed | `INSTANT` / `STANDARD` (CF:355) | enum STANDARD or INSTANT; default STANDARD | C-rf | MATCH |
| 37 | refund_note | `refund_note: reason` (CF:356) | optional, 3-100 chars | C-rf | MATCH (length not validated) |
| 38 | Refund idempotency | `retrySafe: true`, relies on refund_id uniqueness (CF:358-359) | Optional x-idempotency-key (UUID) for safe retry | C-rf | NOT IN DOCS (refund_id de-dupe not documented; header exists but code does not send it) |
| 39 | Refund response fields | cf_refund_id, cf_payment_id, refund_id, order_id, refund_amount, refund_currency, refund_status, status_description (CF:75-84) | all present in RefundEntity; cf_refund_id string | C-rf | MATCH |
| 40 | refund_status enum | SUCCESS; PENDING, ONHOLD; CANCELLED, FAILED (CF:124-129) | SUCCESS, PENDING, PENDING_APPROVAL, CANCELLED, ONHOLD, REJECTED | C-rf, C-rfget | MISMATCH (PENDING_APPROVAL and REJECTED fall to `unknown`; FAILED not a doc value) |
| 41 | Get refund | `GET /orders/{order_id}/refunds/{refund_id}` (CF:367) | `GET /orders/{order_id}/refunds/{refund_id}` | C-rfget | MATCH |
| 42 | Refund window | "Refunds are allowed only within 6 months" (CFC:38) | "only within six months of the original successful transaction" | C-rf | MATCH |
| 43 | Webhook headers | `x-webhook-signature`, `x-webhook-timestamp` (CF:383-384) | headers x-webhook-signature, x-webhook-timestamp | C-wh-sig, C-wh-ov | MATCH |
| 44 | Signature algorithm | base64(HMAC-SHA256(secret, timestamp + rawBody)) (CF:43-45) | Node: `headers['x-webhook-timestamp'] + request.rawBody`, HMAC sha256, base64 | C-wh-sig | MATCH (pseudocode `$timestamp.$payload` is PHP concatenation, not a literal dot) |
| 45 | Signing key | client secret (CF:388) | `const secretKey = <client secret>` | C-wh-sig | MATCH |
| 46 | Raw body requirement | verifies `input.rawBody` (CF:388) | "based on the raw payload, not the parsed payload" | C-wh-ov | MATCH |
| 47 | Timestamp units | ms, seconds accepted (CF:142-146) | sample `1617695238078` (13 digits); units not stated | C-wh-sig | MATCH (inferred) |
| 48 | 5-minute replay window | rejects if |now - ts| > 5 min (CF:39, 395-401) | No replay window documented; retries at 2, 10, 30 min | C-wh-sig, C-wh-ov | NOT IN DOCS (risk: if retries keep the original timestamp, every retry is rejected) |
| 49 | Payment webhook types | PAYMENT_SUCCESS_WEBHOOK, PAYMENT_FAILED_WEBHOOK, PAYMENT_USER_DROPPED_WEBHOOK (CF:418-424) | Those three plus PAYMENT_CHARGES_WEBHOOK | C-wh-pay | MATCH (charges maps to unknown) |
| 50 | Payment webhook payload paths | `data.order`, `data.payment`, top `type`, `event_time` (CF:403-414) | top-level data, event_time, type; data.order, data.payment | C-wh-pay | MATCH |
| 51 | Failed webhook error details | not read (CF:403-460) | `data.error_details` (sibling of payment, not inside it) | C-wh-pay | MATCH (not used) |
| 52 | REFUND_STATUS_WEBHOOK path | `data.refund` (CF:409, 414, 425) | standard refund fields under `data.refund` | C-wh-rf | MATCH |
| 53 | AUTO_REFUND_STATUS_WEBHOOK path | read from `data.refund` (CF:414, 426-429) | Auto-refund payload "is not data.refund. It is data.auto_refund" | C-wh-rf | MISMATCH |
| 54 | Dispute webhook types | only DISPUTE_CREATED (CF:431) | DISPUTE_CREATED, DISPUTE_UPDATED, DISPUTE_CLOSED | C-wh-disp | MATCH (others map to unknown) |
| 55 | Dispute payload paths | reads `data.order.order_id` for orderRef (CF:412, 450) | dispute under `data.dispute`; order_id under `data.order_details` | C-wh-disp | MISMATCH (orderRef/amount always undefined for disputes) |
| 56 | Webhook versions | not handled; shapes assumed version-independent | 2026-01-01, 2025-01-01, 2023-08-01 via `x-webhook-version` | C-wh-pay | MATCH (fields read exist in all three) |
| 57 | Webhook dedupe header | id built from type + ids (CF:439-441) | `x-idempotency-header` (version 2025-01-01+) for dedupe | C-wh-ov | NOT IN DOCS for our scheme; doc header unused (improvement) |
| 58 | JS SDK URL | `https://sdk.cashfree.com/js/v3/cashfree.js` (CF:37) | `<script src="https://sdk.cashfree.com/js/v3/cashfree.js">` | C-js | MATCH |
| 59 | JS SDK mode values | `production` / `sandbox` (CF:261) | `mode:"sandbox" //or production` | C-js | MATCH |
| 60 | checkout option name | `paymentSessionId` (CF:262) | `cashfree.checkout({ paymentSessionId, redirectTarget })` | C-js | MATCH |
| 61 | Domain whitelist | "only opens checkout on domains whitelisted" (CFC:37) | "You must whitelist your domain with Cashfree" | C-js | MATCH |
| 62 | Subscriptions endpoints | `POST /pg/plans` then `POST /pg/subscriptions` (CFC:19) | Create Plan `POST /plans`; create subscription POST `/pg/subscriptions` | C-plans, C-subs | MATCH |
| 63 | Subscriptions body changed across versions | (CFC:19) | v2026-01-01 "restructured the Create Subscription request body" | C-subs | MATCH |
| 64 | Settlements | "Get All Settlements" and `GET /pg/orders/{order_id}/settlements` (CFC:20) | Overview names "Get Settlements by Order ID" and "Get All Settlements"; paths not shown | C-api-ov | MATCH on names; path COULD NOT ACCESS (reference page 404 at guessed URL) |
| 65 | Payouts separate product | base `/payout`, separate credentials (CFC:21) | Payouts base `https://api.cashfree.com/payout` / `sandbox.cashfree.com/payout` | C-payout | MATCH on base; "separate credentials" NOT IN DOCS (not confirmed) |
| 66 | Credential prefix guards | sandbox id starts `TEST`, secrets contain `_test_`/`_prod_` (CF:528-535) | not documented | - | NOT IN DOCS (best-effort heuristic; could false-positive) |
| 67 | Error body shape | `{ message, code, type }` (CF:538-543) | not fetched this round | - | COULD NOT ACCESS (not checked) |
| 68 | Webhook timestamp in simulateWebhook | ms string (CF:504) | 13-digit sample | C-wh-sig | MATCH |

## PhonePe PG Standard Checkout v2

| # | Item | Code says (file:line) | Docs say | Doc URL | Verdict |
|---|------|------------------------|----------|---------|---------|
| 1 | Sandbox token URL | `https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token` (PP:42) | same | P-auth | MATCH |
| 2 | Production token URL | `https://api.phonepe.com/apis/identity-manager/v1/oauth/token` (PP:46) | same | P-auth | MATCH |
| 3 | Token method / content type | POST, URLSearchParams body -> form-encoded (PP:224-237; core/http.ts:67-69) | POST, "application/x-www-form-urlencoded" | P-auth | MATCH |
| 4 | Token form fields | client_id, client_version, client_secret, grant_type=client_credentials (PP:224-229) | same four fields; grant_type "client_credentials" | P-auth | MATCH |
| 5 | Token response access_token | `data.access_token` (PP:238, 243) | access_token valid until expires_at | P-auth | MATCH |
| 6 | expires_at units | epoch seconds, primary source (PP:70-71, 241) | expires_at "Token expiry timestamp in epoch"; issued_at in seconds | P-auth | MATCH |
| 7 | expires_in | fallback only (PP:72, 241) | sample value `null`, undocumented | P-auth | MATCH (null handled by `??`) |
| 8 | token_type | not used; header hard-coded `O-Bearer` | token_type "will be O-Bearer" | P-auth | MATCH |
| 9 | Refresh before expiry | refresh 120 s before expires_at (PP:53, 216) | "ensure that the token is refreshed before it expires" | P-auth | MATCH |
| 10 | Auth header format | `Authorization: O-Bearer <token>` (PP:258) | `Authorization: O-Bearer <merchant-auth-token>` | P-pay, P-status, P-refund | MATCH |
| 11 | Sandbox API base | `https://api-preprod.phonepe.com/apis/pg-sandbox` (PP:43) | `.../apis/pg-sandbox/checkout/v2/pay` | P-pay | MATCH |
| 12 | Production API base | `https://api.phonepe.com/apis/pg` (PP:47) | `https://api.phonepe.com/apis/pg/checkout/v2/pay` | P-pay | MATCH |
| 13 | Create payment | `POST /checkout/v2/pay` (PP:322) | POST `/checkout/v2/pay` | P-pay | MATCH |
| 14 | merchantOrderId rule | `/^[A-Za-z0-9_-]{1,63}$/` (PP:56, 294) | max 63; only underscore and hyphen as special characters | P-pay, P-init | MATCH |
| 15 | amount unit | integer paise (PP:174-181, 309) | "in paisa (e.g., ₹10 = 1000 paisa)" | P-pay | MATCH |
| 16 | amount minimum | 100 (PP:51) | Minimum value is 100 | P-pay | MATCH |
| 17 | expireAfter range | integer 300-3600 (PP:303-305) | "Minimum value = 300, maximum value = 3600 (in seconds)" | P-init | MATCH |
| 18 | metaInfo keys | udf1..udf15 pass through; free values go to udf1..udf5 (PP:154-172) | udf1-udf10 max 256; udf11-15 alnum + `_-+@.` max 50 | P-init | MATCH (length/charset not validated) |
| 19 | paymentFlow.type | `PG_CHECKOUT` (PP:313) | only allowed value `PG_CHECKOUT` | P-pay | MATCH |
| 20 | paymentFlow.message | description (PP:314) | "Payment message used for collect requests" | P-pay | MATCH |
| 21 | merchantUrls.redirectUrl | required (PP:296-301, 315) | mandatory | P-pay | MATCH |
| 22 | prefillUserLoginDetails | top level `{ phoneNumber }` (PP:317) | top-level sibling of paymentFlow; `{"phoneNumber": "+91 998*****09"}` | P-init | MATCH |
| 23 | Currency | INR only (PP:291-293) | amounts in paisa; no currency field | P-pay | MATCH |
| 24 | Create response fields | orderId, state, expireAt, redirectUrl (PP:75-81, 328-334) | orderId, state (PENDING), expireAt, redirectUrl | P-pay | MATCH (table spells `expiryAt`, sample `expireAt`) |
| 25 | expireAt units | epoch ms (PP:78-79, 333) | epoch; sample 1703756259307 (13 digits) | P-pay | MATCH (inferred) |
| 26 | Order status path | `GET /checkout/v2/order/{merchantOrderId}/status` (PP:282) | same | P-status | MATCH |
| 27 | details=false | latest attempt only (PP:282) | false: "return only latest attempt details" | P-status | MATCH |
| 28 | errorContext=true | (PP:282) | true includes errorContext when FAILED | P-status | MATCH |
| 29 | Order state enum | COMPLETED, FAILED, PENDING (PP:117-128) | PENDING, FAILED, COMPLETED | P-status | MATCH |
| 30 | Top-level errorCode / detailedErrorCode | read for failureReason (PP:100-101, 402) | present in FAILED sample | P-status | MATCH |
| 31 | paymentDetails fields | paymentMode, transactionId, timestamp, amount, state, errorCode, detailedErrorCode (PP:83-92) | same fields | P-status | MATCH |
| 32 | paymentMode values | UPI_*, CARD, TOKEN, NET_BANKING (PP:138-146) | UPI_INTENT, UPI_COLLECT, UPI_QR, CARD, NET_BANKING (+ CREDIT_LINE in sample) | P-status | MATCH (TOKEN extra, harmless; CREDIT_LINE passes through as `credit_line`) |
| 33 | amount in status | number, paise (PP:98, 397) | paisa; table says String, samples numbers | P-status | MATCH (doc inconsistent) |
| 34 | Refund create | `POST /payments/v2/refund` (PP:426) | POST `/payments/v2/refund` | P-refund | MATCH |
| 35 | Refund request fields | merchantRefundId, originalMerchantOrderId, amount (PP:428) | all three mandatory | P-refund | MATCH |
| 36 | merchantRefundId limits | 1-63 of `[A-Za-z0-9_-]` (PP:409) | max 63; charset not listed | P-refund | MATCH (code stricter) |
| 37 | Refund min amount | 100 paise (PP:422) | minimum value is 100 (1 INR) | P-refund | MATCH |
| 38 | Refund response | refundId, amount, state (PP:106-114, 434-436) | refundId, amount, state ("expected value = PENDING") | P-refund | MATCH |
| 39 | Refund retry safety | retrySafe true; merchantRefundId de-dupes (PP:423-429) | not stated | P-refund | NOT IN DOCS |
| 40 | Refund status path | `GET /payments/v2/refund/{merchantRefundId}/status` (PP:444) | same | P-refund | MATCH |
| 41 | Refund state enum | COMPLETED; PENDING, CONFIRMED; FAILED (PP:130-136) | PENDING, COMPLETED, FAILED | P-refund | MATCH (CONFIRMED extra, harmless) |
| 42 | Webhook auth | `Authorization` == sha256hex(`username:password`) (PP:62-64, 466-468) | "SHA256(username:password) method" | P-wh | MATCH |
| 43 | Header value format | bare lowercase 64-char hex, no prefix (PP:465-466) | Node SDK sample `ef4c914c...df723a` (64 hex, no prefix) | P-node-wh | MATCH |
| 44 | Event field | `event` preferred, `type` fallback (PP:484-485) | "Ignore the type parameter"; "Use the event parameter" | P-wh, P-steps | MATCH |
| 45 | Event names | checkout.order.completed/failed, pg.refund.completed/failed (PP:487-492) | exactly those four | P-wh, P-steps | MATCH |
| 46 | pg.refund.accepted | maps to `unknown` | Node SDK lists PG_REFUND_ACCEPTED ("acknowledged but not yet complete") | P-node-wh | MATCH (not in REST webhook page; unknown is safe) |
| 47 | Order event payload | payload.{merchantId, merchantOrderId, orderId, state, amount, expireAt, metaInfo, paymentDetails} (PP:474-516) | same fields under `payload` | P-wh | MATCH |
| 48 | Status from payload.state | `p.state` (PP:511) | "rely only on the root-level payload.state" | P-steps | MATCH |
| 49 | Refund event payload | payload.{merchantRefundId, originalMerchantOrderId, refundId, state, amount, timestamp} (PP:494-510) | Card/NB samples wrap in event+payload; UPI sample has no wrapper and no merchantRefundId | P-wh | MATCH (doc sample inconsistent; see notes) |
| 50 | Timestamps | epoch ms (PP:514) | "provided in epoch time"; 13-digit samples | P-wh | MATCH (inferred) |
| 51 | HMAC x-phonepe-checksum scheme | not implemented, "algorithm is undocumented" (PPC:22) | headers x-phonepe-checksum-key-id / -signature; algorithm not named | P-wh | MATCH |
| 52 | Iframe PayPage | `window.PhonePeCheckout.transact({ tokenUrl, type: "IFRAME", callback })` (PPC:57) | same call; tokenUrl = redirectUrl | P-iframe | MATCH |
| 53 | Subscriptions | Autopay exists under /payment-gateway/autopay/ (PPC:25) | Autopay pages (setup, status, cancel...) | P-autopay | MATCH |
| 54 | Settlements | settlement section at developer.phonepe.com/settlement (PPC:26) | page exists; settlement IDs, status, webhooks | P-settle | MATCH |
| 55 | Payment links | exist (PPC:28) | Create / Reshare / Cancel Payment Link pages | developer.phonepe.com/payment-gateway/payment-links/ | MATCH |
| 56 | Payouts unsupported | (PPC:27) | no payouts API found in PG docs | - | NOT IN DOCS (absence cannot be proven) |
| 57 | client_version "Usually 1 in sandbox" | (PPC:37) | "Client Version shared by PhonePe PG" | P-auth | NOT IN DOCS |
| 58 | Reuse of progressed merchantOrderId -> BAD_REQUEST | (PP:320-322, PPC:46) | not found on fetched pages | - | NOT IN DOCS |
| 59 | 401 -> refresh token and resend | (PP:268-274) | "If expires, you will have to send the request again" | P-auth | MATCH (spirit) |
| 60 | Error body `{ code, message, context }` | (PP:589-594) | not fetched this round | - | COULD NOT ACCESS (not checked) |
| 61 | Legacy v1 X-VERIFY deprecated | (PP:34-39, PPC:50) | not checked this round | - | COULD NOT ACCESS (not checked) |

## Mismatches and fixes

### Cashfree
1. **customer_id charset (CF:208).** Docs: "Use alphanumeric values only" (3-50 chars). The derived id `cust_<hex>` contains `_`. Fix: `const customerId = input.customer?.id ?? \`cust${sha256Hex(phone).slice(0, 24)}\`;` and validate a caller-supplied id against `/^[A-Za-z0-9]{3,50}$/`.
2. **refund_status enum (CF:124-129).** Docs list SUCCESS, PENDING, PENDING_APPROVAL, CANCELLED, ONHOLD, REJECTED. Fix: treat `PENDING_APPROVAL` as `pending` and `REJECTED` as `failed`, for example `if (s === 'PENDING' || s === 'ONHOLD' || s === 'PENDING_APPROVAL') return 'pending'; if (s === 'CANCELLED' || s === 'REJECTED' || s === 'FAILED') return 'failed';`.
3. **AUTO_REFUND_STATUS_WEBHOOK payload path (CF:403-414, 426).** Docs say the auto-refund object is `data.auto_refund`, not `data.refund`. It also has no `refund_id`. Fix: add `auto_refund?: CfRefund` to the body type and use `const refund = body.data?.refund ?? body.data?.auto_refund;`. The id fallback already uses `cf_refund_id` first.
4. **Dispute webhook payload paths (CF:412, 431, 450).** Dispute data is under `data.dispute` and the order under `data.order_details` (order_id, order_amount, order_currency, cf_payment_id). Fix: read `data.order_details?.order_id` for orderRef, `data.dispute?.dispute_id` for the event id, and `data.dispute?.dispute_amount` for the amount.
5. **payment_group mapping (CF:132-139).** `cardless_emi` skips the EMI branch and then matches `/card/`, so it becomes `card`. `upi_credit_card` also becomes `card`. Fix: check `group === 'cardless_emi'` first and return `'cardless_emi'`; check `group.startsWith('upi')` before the card regex and return `'upi'` (this also covers `upi_ppi` and `upi_ppi_offline`).

### PhonePe
None found. Every endpoint, field, unit, limit, enum and header in the adapter matches the docs.

## Not verified / risks
- **Cashfree 5-minute webhook replay window (CF:39, 395-401).** Not documented. Cashfree retries at 2, 10 and 30 minutes. If a retry keeps the original `x-webhook-timestamp`, every retry fails verification. Consider widening the window (for example 35-60 minutes) and deduping on `x-idempotency-header` instead.
- **Cashfree idempotency.** `x-idempotency-key` must be UUID-formatted per the docs; the code forwards any `idempotencyKey` string unchecked. The refund POST is marked retry-safe on the basis of refund_id uniqueness, which is not documented. Cashfree offers `x-idempotency-key` on refunds too, so the code could send a UUID derived from refundRef.
- **Cashfree refund_id** must be 3-40 alphanumeric (docs typo "Provie alphanumeric values"). refundRef is not validated, so `_` or `-` may be rejected.
- **Cashfree field lengths not validated client-side:** customer_phone (10 digits or a + prefix), order_note (3-200), customer_name/email (3-100), return_url/notify_url (250 chars; notify_url https), order_tags (10 vs 15 values, inconsistent in the docs).
- **Cashfree `{order_id}` placeholder.** Documented only in the migration guide, not in the latest Create Order reference or the web-checkout page.
- **Cashfree settlements paths** (`/pg/orders/{order_id}/settlements`, Get All Settlements). The endpoint names are confirmed but the paths are not; the reference page URL returned 404.
- **Cashfree Payouts "separate credentials"** not confirmed. The base `/payout` is confirmed.
- **Cashfree credential prefix guards** (TEST, `_test_`, `_prod_`) are not documented.
- **Error body shapes** for both gateways (extractError) were not checked this round.
- **PhonePe refund webhook UPI sample** in the docs has no `event`/`payload` wrapper and no merchantRefundId. If real UPI refund webhooks arrive unwrapped, `parseWebhook` reads an empty payload. Likely a docs artifact; worth a defensive fallback to the top-level body when `payload` is absent.
- **PhonePe claims not in the docs:** merchantRefundId de-dupe on retry, BAD_REQUEST on reusing a merchantOrderId, client_version "usually 1", payouts unavailability.
- **PhonePe metaInfo udf limits** (256 / 50 chars, udf11-15 charset) are not validated.
