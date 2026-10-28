# Verification round 2: Paytm PG and Stripe

Date: 2026-10-29. Independent re-check from scratch. Round-1 reports were read only to locate the fixes they asked for; none of their verdicts are reused.

Method:
- Paytm: docs pages downloaded from www.paytmpayments.com/docs and converted to text. The official checksum libraries were read in full from GitHub raw: Paytm_Node_Checksum `PaytmChecksum.js`, Paytm_PHP_Checksum, and Paytm_Python_Checksum.
- Stripe: docs.stripe.com pages (API reference, webhooks, refunds, UPI, India pages).
- The Stripe HMAC known-answer vector in the tests was recomputed with `openssl dgst -sha256 -hmac`.
- No calls were made to any Paytm or Stripe API host. No source files were changed.

Verdicts: MATCH, MISMATCH or UNVERIFIABLE. "Interp." means the docs do not say this and the mapping is our own choice.

## URL key

| Key | URL |
|---|---|
| T-INIT | https://www.paytmpayments.com/docs/api/initiate-transaction-api |
| T-STAT | https://www.paytmpayments.com/docs/api/v3/transaction-status-api |
| T-JSVER | https://www.paytmpayments.com/docs/jscheckout-verify-payment |
| T-JSINV | https://www.paytmpayments.com/docs/jscheckout-invoke-payment |
| T-SPP | https://www.paytmpayments.com/docs/show-payment-page |
| T-REF | https://www.paytmpayments.com/docs/api/refund-api |
| T-RSTAT | https://www.paytmpayments.com/docs/api/refund-status-api |
| T-PSWH | https://www.paytmpayments.com/docs/payment-status |
| T-ARWH | https://www.paytmpayments.com/docs/accept-refund-webhook |
| T-SRWH | https://www.paytmpayments.com/docs/success-refund-webhook |
| T-CKS | https://www.paytmpayments.com/docs/checksum-implementation |
| T-LIB | https://github.com/paytm/Paytm_Node_Checksum/blob/master/PaytmChecksum.js (+ PHP / Python repos) |
| S-WH | https://docs.stripe.com/webhooks (section "Verify webhook signatures manually") |
| S-EVT | https://docs.stripe.com/api/events/types |
| S-IDEM | https://docs.stripe.com/api/idempotent_requests |
| S-CS | https://docs.stripe.com/api/checkout/sessions/create |
| S-REFOBJ | https://docs.stripe.com/api/refunds/object |
| S-REF | https://docs.stripe.com/refunds |
| S-UPI | https://docs.stripe.com/payments/upi |
| S-INREC | https://docs.stripe.com/india-recurring-payments |
| S-INEXP | https://docs.stripe.com/india-accept-international-payments |
| S-UPG | https://docs.stripe.com/upgrades |

---

## Paytm Payment Gateway

Files: `src/providers/paytm/adapter.ts` (A), `checksum.ts` (C), `capabilities.ts` (K), `test/providers/paytm.test.ts` (T).

| # | Item | Code file:line | Docs quote (≤15 words) | URL | Verdict |
|---|---|---|---|---|---|
| 1 | Initiate host, staging | A:39 `securestage.paytmpayments.com` | "https://securestage.paytmpayments.com/theia/api/v1/initiateTransaction?mid=YOUR_MID_HERE" | T-INIT | MATCH |
| 2 | Initiate host, live | A:40 `secure.paytmpayments.com` | "https://secure.paytmpayments.com/theia/api/v1/initiateTransaction?mid=YOUR_MID_HERE" | T-INIT | MATCH |
| 3 | Initiate path + query | A:299 `/theia/api/v1/initiateTransaction?mid=&orderId=` | "initiateTransaction?mid={mid}&orderId={order-id}" | T-INIT | MATCH |
| 4 | Envelope / content type | A:226-229 `{"body":…,"head":{"signature"}}`, JSON | `--data '{"body":{...},"head":{"signature":"{signature}"}}'` | T-INIT | MATCH |
| 5 | What is signed | A:223-224 exact `JSON.stringify(body)` | "Create the signature using the body parameter of the request." | T-INIT, T-CKS | MATCH |
| 6 | requestType | A:286 `'Payment'` | "'Payment' for 'One time Payment' for all checkout flows" | T-INIT | MATCH |
| 7 | websiteName | A:210 WEBSTAGING / DEFAULT | "WEBSTAGING For Staging/Integration environment … DEFAULT For Production" | T-INIT | MATCH |
| 8 | orderId length | A:274 ≤50 | "It is alphanumeric and max length is 50 characters." | T-INIT | MATCH. The charset and the pipe character are not validated (low; code 1008 is "Pipe character is not allowed") |
| 9 | callbackUrl | A:290 | "URL passed in callbackUrl has a higher preference" | T-INIT | MATCH |
| 10 | txnAmount | A:291 `{value:"499.00",currency}` | `{"value" : "1.00", "currency" : "INR"}` | T-INIT | MATCH |
| 11 | custId charset (round-1 fix) | A:53-55, A:294 | "Special characters allowed in CustId are @, ! ,=,_ ,$, ." | T-INIT | MATCH |
| 12 | userInfo.mobile format | A:294 `mobile: c?.phone` passed raw; core type allows E.164 (`src/core/types.ts:50`) | "10-digit mobile number of user." | T-INIT | MISMATCH (P3) |
| 13 | userInfo.firstName | A:294 `firstName: c?.name` (the full name) | "First name of the user" (lastName is a separate field) | T-INIT | MISMATCH, low (P7) |
| 14 | Initiate success codes | A:305 `resultStatus === 'S'` | "0000 \| S \| Success"; "0002 \| S \| Success Idempotent" | T-INIT | MATCH |
| 15 | Initiate checksum code (round-1 fix) | A:258 `'2005'` → AUTH | "2005 \| F \| Checksum provided is invalid" | T-INIT | MATCH |
| 16 | Initiate retry policy | A:297 comment says re-initiate is not documented as idempotent; retrySafe=false | "0002 \| S \| Success Idempotent"; "2023 \| F \| Repeat Request Inconsistent" | T-INIT | MISMATCH, low (P8: the docs do document idempotency) |
| 17 | txnToken TTL | A:67 15 min | "It is valid for 15 minutes." | T-INIT | MATCH |
| 18 | JS Checkout script URL | A:335 | `src="{HOST}/merchantpgpui/checkoutjs/merchants/{MID}.js"` | T-JSINV | MATCH |
| 19 | JS Checkout config | A:313-315 root/flow/data{orderId,token,tokenType,amount} | `"root": "", "flow": "DEFAULT"`, `"tokenType": "TXN_TOKEN"` | T-JSINV | MATCH |
| 20 | `fallbackRedirect` inside `options` | A:316-320 | Config lists root, flow, data, handler only | T-JSINV | UNVERIFIABLE / not in docs (low, carried over: move it out of `options`) |
| 21 | showPaymentPage form | A:318-319 URL + `mid, orderId, txnToken` | `action=".../theia/api/v1/showPaymentPage?mid=…&orderId=…"`; hidden mid, orderId, txnToken | T-SPP | MATCH |
| 22 | Status host | A:372 `.com` host | API ref: "https://securegw-stage.paytmpayments.in/v3/order/status"; JS guide: "https://securestage.paytmpayments.com/v3/order/status" | T-STAT, T-JSVER | MATCH (the two docs pages conflict; `.com` is documented in T-JSVER) |
| 23 | Status body | A:372 `{mid, orderId}` | "mid … mandatory"; "orderId … mandatory"; txnType "optional" | T-STAT | MATCH |
| 24 | Status resultStatus enum | A:109-127 | "Possible Values: TXN_SUCCESS, TXN_FAILURE, PENDING, NO_RECORD_FOUND" | T-STAT | MATCH (`NO_RECORD_FOUND` → `created` is Interp.) |
| 25 | Status lookup errors (round-1 fix) | A:59-60, A:377-379: 501 → PROVIDER_UNAVAILABLE; 330/334/335 throw | "334 \| TXN_FAILURE \| Invalid Order ID"; "501 \| TXN_FAILURE \| Server Down" | T-STAT | MATCH (330 is not in the v3 table; harmless) |
| 26 | Status response fields | A:85-96 | txnId, bankTxnId, orderId, txnAmount, paymentMode, refundAmt, txnDate | T-STAT | MATCH |
| 27 | paymentMode mapping | A:130-140 | "PPI For Paytm Wallet, UPI …, CC …, DC …, NB" | T-STAT | MATCH for the documented values. `PAYTMCC` is a GATEWAYNAME; the postpaid PAYMENTMODE sample is "Paytm Postpaid" (T-PSWH) (low) |
| 28 | Refund host (round-1 fix) | A:49-50 `securegw-stage.paytmpayments.in` / `securegw.paytmpayments.in` | "https://securegw-stage.paytmpayments.in/refund/apply"; "https://securegw.paytmpayments.in/refund/apply" | T-REF | MATCH |
| 29 | Refund request fields | A:424-433 mid, txnType REFUND, orderId, txnId, refId, refundAmount, preferredDestination, comments | txnType "Possible value: REFUND"; preferredDestination "TO_INSTANT"; comments 500 | T-REF | MATCH |
| 30 | refId / comments limits | A:63-64 50 / 500 | refId string(50) "Duplicates are rejected"; comments 500 | T-REF | MATCH |
| 31 | Refund apply response status | A:444-449 TXN_FAILURE throws, otherwise mapped | resultStatus "TXN_FAILURE or PENDING"; "601 \| PENDING"; "677 \| PENDING" | T-REF | MATCH |
| 32 | Duplicate-refId codes (round-1 fix) | A:58 `617, 671, 626, 629` → getRefundStatus(same refId) | "626 … Another Refund on same order is already in Progress, please retry"; "629 … Refund is already Successful" | T-REF | MISMATCH (P2: only 617 and 671 refer to a repeated refund request / refund id) |
| 33 | Refund status host + path | A:459-465 `/v2/refund/status` on securegw | "https://securegw-stage.paytmpayments.in/v2/refund/status"; "https://securegw.paytmpayments.in/v2/refund/status" | T-RSTAT | MATCH |
| 34 | Refund status body | A:461 `{mid, orderId, refId}` | mid, orderId, refId all Mandatory | T-RSTAT | MATCH |
| 35 | Refund status codes (round-1 fix) | A:62, A:468-478 | "10 \| TXN_SUCCESS \| Refund successful"; "631 \| TXN_FAILURE \| Record not found"; "501 \| PENDING" | T-RSTAT | MATCH (600 treated as a lookup error is Interp.) |
| 36 | Response head.signature verify (round-1 fix) | A:243-254 over the raw `"body"` substring; C:97-171 | "signature … Verify with the Paytm checksum library" (no signed string given) | T-REF, T-RSTAT, T-JSVER | UNVERIFIABLE (P1: if Paytm's response signature is not over the raw body bytes, every signed status/refund response is rejected) |
| 37 | Checksum: salt + hash | C:62-64, C:71-75 sha256hex(params+"\|"+salt)+salt, base64(3 random bytes) | Node lib: `params + "\|" + salt`, `randomBytes((length*3)/4)` | T-LIB | MATCH |
| 38 | Checksum: AES | C:26-38 AES-128-CBC, key utf8, IV `@@@@&&&&####$$$$`, base64 | `'AES-128-CBC'`, `iv = '@@@@&&&&####$$$$'` | T-LIB | MATCH |
| 39 | Checksum: verify | C:77-88 last 4 chars = salt, strip CHECKSUMHASH | `paytm_hash.substr(paytm_hash.length - 4)`; `delete params.CHECKSUMHASH` | T-LIB | MATCH |
| 40 | getStringByParams "null" rule | C:41-51 sorted keys, `"null"` → "" | PHP `strtolower($value) !== "null"`; Python `.lower() != "null"` | T-LIB | MATCH (the Node lib compares `!== null`, a bug; PHP and Python agree with the code) |
| 41 | Merchant key length | A:662 exactly 16 bytes | AES-128 key | T-LIB | MATCH |
| 42 | Payment webhook format | A:174-192, A:496-531 form key-values + CHECKSUMHASH | "server to server (S2S) response in key value pairs" | T-PSWH | MATCH |
| 43 | Payment webhook fields | A:514-529 STATUS, TXNID, ORDERID, TXNAMOUNT, CURRENCY, TXNDATE, MID | sample `[STATUS] => TXN_SUCCESS`, `[TXNDATE] => 2020-07-24 15:13:02.0` | T-PSWH | MATCH |
| 44 | Refund webhook envelope (round-1 fix) | A:484-495, A:544-589 `{head:{signature,version}, body}` | sample `"head": {"signature": "...", "version": "v1"}, "body": {...}` | T-ARWH, T-SRWH | MATCH |
| 45 | Refund webhook signed string | A:552-553 raw body substring | "For creating the checksum (signature) refer to … Checksum logic." | T-SRWH | UNVERIFIABLE (same risk as #36) |
| 46 | Accept Refund SUCCESS → `refund.processed` | A:564 | "Note that at this stage the refund to the user has not been initiated" | T-ARWH | MISMATCH (P4: the refund is accepted but not yet sent to the customer; one refund produces two `refund.processed` events) |
| 47 | Accept Refund body fields | A:149-165, A:567-571 status uses `totalRefundAmount` | Accept body has no `totalRefundAmount`; "refundAmount … Total cumulative refund amount" | T-ARWH | MISMATCH, low (P6: `status` is always undefined for a real Accept webhook) |
| 48 | Unsigned FAILED refund webhook rejected | A:546-551; K:16 says the "documented FAILED refund notification carries no signature" | Success Refund Fail sample has head `{"version": "v1"}` only; the Accept Refund Fail sample IS signed | T-SRWH, T-ARWH | MATCH for the code. K:16 text is half right (P9: Accept-Refund FAILED is signed and is handled) |
| 49 | Refund webhook `mid` check | A:560 | Success body has `"mid"`; Accept body has none | T-SRWH, T-ARWH | MATCH (the check is skipped when mid is absent) |
| 50 | Simulated refund webhook | A:596-621 | fields match the Success Refund sample | T-SRWH | MATCH |
| 51 | Capabilities: hosts, INR, 16-char key, token TTL | K:39-52 | as #1, #2, #17, #28 | — | MATCH |

### Paytm unit tests that contradict the docs

| Test file:line | Assertion | Docs | Verdict |
|---|---|---|---|
| T:350-360 | 626 and 629 are treated as "duplicate refId"; the fixture labels every code "Refund Already Raised" | 626 = another refund in progress (retry later); 629 = refund already successful | MISMATCH (goes with P2) |
| T:419-426 | Accept Refund SUCCESS fixture carries `totalRefundAmount` and expects `status: 'partially_refunded'` | The Accept Refund body has no `totalRefundAmount` field | MISMATCH, low (P6) |
| T:419-426 | Accept SUCCESS expects `type: 'refund.processed'` | "refund to the user has not been initiated" | MISMATCH (P4) |
| T:275 | Status code 330 → AUTH | 330 is not listed in the v3 status table (it is in the refund tables) | Harmless |
| T:439-444 | Flat JSON PENDING notification | The payment webhook is sent "for the final transaction status" | Harmless (lenient parsing) |

---

## Stripe

Files: `src/providers/stripe/adapter.ts` (A), `capabilities.ts` (K), `form.ts` (F), `test/providers/stripe.test.ts` (T).

| # | Item | Code file:line | Docs quote (≤15 words) | URL | Verdict |
|---|---|---|---|---|---|
| 1 | Base URL, auth, form encoding | A:41, A:307, F:13-35 | `curl https://api.stripe.com/v1/refunds -u "<<YOUR_SECRET_KEY>>:"`; bracket-nested form | S-REF | MATCH |
| 2 | API version pin (round-1 fix) | A:51 `2025-03-31.basil` | Current examples use `'2026-09-30.endive'`; "specify the API version … instead of relying on" the default | S-UPG | MATCH (a valid pinned version; the comment about newer versions is accurate) |
| 3 | Idempotency-Key length (round-1 fix) | A:53, A:331 | "Idempotency keys are up to 255 characters long." | S-IDEM | MATCH |
| 4 | Idempotency replay / expiry claims | A:316-321, K:82-83 | "Retries with the same key return the saved response, including 500 errors." | S-IDEM | MATCH |
| 5 | No key on GET/DELETE | A:329 | "Don't send idempotency keys in GET and DELETE requests" | S-IDEM | MATCH |
| 6 | client_reference_id length (round-1 fix) | A:55, A:57-61 | "The maximum length is 200 characters." | S-CS | MATCH |
| 7 | Checkout params | A:372-391 mode, line_items.price_data{currency,unit_amount,product_data.name}, quantity | price_data.currency "Three-letter ISO currency code, in lowercase" | S-CS | MATCH |
| 8 | billing_address_collection | A:386 `'required'` | "`required`: Checkout will always collect the customer's billing address." | S-CS | MATCH |
| 9 | Session expiry | A:412, K:85 | "By default, this value is 24 hours from creation." | S-CS | MATCH |
| 10 | Subscription price_data.recurring | A:902-907 interval, interval_count | "Either day, month, week or year." | S-CS | MATCH |
| 11 | Export-charge requirements | A:357, A:386, A:388; K:76 | goods also need "The shipping address with a valid 2-alphabet ISO-3166 country code" | S-INEXP | MISMATCH, low (P12: shipping address for physical goods is not mentioned or collected) |
| 12 | Invite-only, business types | K:10, K:74 | "Stripe is available by invite only in India." | S-INEXP | MATCH |
| 13 | Presentment currencies | K:57-58 | "135+ currencies on Visa and Mastercard, and INR or USD … American Express" | S-INEXP | MATCH |
| 14 | Card-only for India (round-1 fix) | K:53-56, K:79 | UPI "Business locations" list has no IN | S-UPI | MATCH |
| 15 | RBI e-mandate: AFA > 15,000, 24 h notice, 26 h hold, no update/cancel | K:77-78 | "Stripe waits 26 hours before charging"; "You can't cancel or update a mandate." | S-INREC | MATCH |
| 16 | PaymentIntent statuses | A:189-210 | requires_payment_method … processing, requires_capture, succeeded, canceled | S-REF | MATCH (`requires_payment_method` + last_payment_error → `failed` is Interp.) |
| 17 | Session status / payment_status | A:212-223 | status open/complete/expired; payment_status paid/unpaid/no_payment_required | S-CS | MATCH |
| 18 | Refund create params | A:589-599 payment_intent or charge, amount, reason, metadata | reason "`duplicate`, `fraudulent`, or `requested_by_customer`" | S-REFOBJ | MATCH |
| 19 | Refund statuses | A:225-238 | "This can be pending, requires_action, succeeded, failed, or canceled." | S-REFOBJ | MATCH |
| 20 | Refund metadata value cap | A:597 `.slice(0, 500)` | metadata values up to 500 chars | https://docs.stripe.com/api/metadata | MATCH |
| 21 | Refund of an uncaptured PI | A:579-601 always POST /refunds | "you must cancel the PaymentIntent" for requires_capture | S-REF | MISMATCH, low (P13) |
| 22 | Webhook signature scheme | A:68-70, A:641-654 HMAC-SHA256(`t.body`), every v1 checked | "concatenating: The timestamp … The character . … The actual JSON payload" | S-WH | MATCH. The test vector (T:267) was recomputed and matches |
| 23 | Ignore v0 / other schemes | A:83 | "To prevent downgrade attacks, ignore all schemes that aren't v1." | S-WH | MATCH |
| 24 | Multiple v1 while rolling | A:72-86 | "Stripe generates one signature for each secret." | S-WH | MATCH |
| 25 | Tolerance 300 s | A:63, A:655-661 uses `Math.abs(age)` | "default tolerance of 5 minutes between the timestamp and the current time" | S-WH | MATCH (stricter on future timestamps than the libraries; fine) |
| 26 | Webhook payload version | K:87 | "snapshot_api_version property controls the API version used to render" | S-UPG | MATCH |
| 27 | checkout.session.* mapping | A:676-698 | async_payment_succeeded: "a payment intent using a delayed payment method finally succeeds" | S-EVT | MATCH |
| 28 | payment_intent.* mapping | A:700-719 | amount_capturable_updated: "Occurs when a PaymentIntent has funds to be captured." | S-EVT | MATCH (`canceled` → `payment.failed` is Interp.) |
| 29 | refund.created/updated/failed handling | A:721-734 status-driven type | refund.updated: "Updates include adding metadata and providing details like the ARN" | S-REF | MISMATCH (P5: every metadata/ARN update of a succeeded refund emits another `refund.processed`, each with a fresh event id) |
| 30 | charge.refunded mapping (round-1 fix) | A:736-749 → `unknown` | "Listen to refund.created for information about the refund." | S-EVT | MATCH (code) |
| 31 | charge.refunded guidance text | K:80 "Use refund.updated … / refund.failed for the outcome" | "At a minimum, Stripe recommends that you listen for the refund.created event." | S-REF | MISMATCH, low (P10: a refund created as `succeeded` gets no refund.updated; the code handles refund.created but the text omits it) |
| 32 | charge.refund.updated | A:721 | "(Deprecated) … Listen to refund.updated for updates on all refunds instead." | S-REF | MATCH (handled; deprecated) |
| 33 | charge.dispute.created orderRef | A:751-761 reads `metadata` of the dispute object | `data.object` is a `dispute` (its own metadata, not the charge's) | S-EVT | MISMATCH, low (P11: orderRef is always undefined) |
| 34 | customer.subscription.paused/resumed | A:768-769 | "Only applies when subscriptions enter status=paused" | S-EVT | MATCH |
| 35 | invoice.paid (basil) | A:779-800 `parent.subscription_details.subscription` | "invoice payment attempt succeeds or an invoice is marked as paid out-of-band" | S-EVT | MATCH |
| 36 | payout.paid → settlement.processed | A:802-805 | "Occurs whenever a payout is *expected* to be available" | S-EVT | MATCH (an "expected" arrival, so a later payout.failed is possible; low) |
| 37 | Session / subscription expire, cancel | A:949, A:954-959 | POST …/expire; DELETE /v1/subscriptions/{id} | S-CS | MATCH |
| 38 | Redirect is unsigned; re-fetch | A:494-542, K:16-19 | Stripe.js appends `payment_intent` + `redirect_status` (not signed) | S-WH | MATCH |
| 39 | Capability: "No instant speed" | K:23, A:600 | no speed parameter on refund create | S-REFOBJ | MATCH |

### Stripe unit tests that contradict the docs

| Test file:line | Assertion | Docs | Verdict |
|---|---|---|---|
| T:221-229 | Fixture `payment_method_details.type: 'upi'` on an INR PI, `method: 'upi'` | IN accounts cannot accept UPI (S-UPI) | Harmless (not impossible for a non-IN account), but inconsistent with the India card-only claim |
| T:304-306 | `refund.updated` with succeeded → `refund.processed` with no dedupe on refund id | refund.updated also fires for metadata/ARN updates (S-REF) | MISMATCH (goes with P5) |
| T:267 | HMAC known-answer vector | recomputed: `c89214b5…2925` | MATCH |

---

## Ranked MISMATCH list with exact fixes

**P1 (high impact, UNVERIFIABLE): Paytm response and refund-webhook signature check can block every call.** adapter.ts:243-254, 552-553. The docs say to verify head.signature with the checksum library, but no page names the signed string. If Paytm signs a re-serialised body rather than the exact bytes on the wire, every signed status, refund and refund-status response throws SIGNATURE_INVALID, and so does every refund webhook. Fix (no doc change needed):
- Keep the raw-body check.
- On a mismatch, also try `JSON.stringify(JSON.parse(raw).body)`.
- If neither matches, throw SIGNATURE_INVALID.
- Add an opt-out env flag (`PAYTM_VERIFY_RESPONSE_SIGNATURE=false`) so a merchant is not blocked while this is confirmed in the sandbox. Flag it as "confirm in sandbox" in capabilities.

**P2 (medium): Paytm 626/629 are not duplicate-refId codes.** adapter.ts:58, 438-443; test paytm.test.ts:350-360. The docs say "626: Another Refund on same order is already in Progress, please retry after few minutes" and "629: Refund is already Successful". Fix:
- `DUPLICATE_REFUND_CODES = new Set(['617','671'])`.
- 626: `throw this.resultError('create_refund', info, data, 'PROVIDER_UNAVAILABLE')`. It is retryable, and refundRef is unchanged.
- 629: call `getRefundStatus` with the same refId. If that throws NOT_FOUND (631), rethrow the original 629 as PROVIDER_ERROR so the caller sees "Refund is already Successful", not "Record not found".
- Update the test fixtures to the documented messages.

**P3 (medium): Paytm `userInfo.mobile` must be 10 digits.** adapter.ts:294. The core `Customer.phone` allows E.164 (`+91…`), and that is sent unchanged. Fix: `const m = c?.phone?.replace(/\D/g,'').replace(/^(91|0)(?=\d{10}$)/,''); mobile: m && /^\d{10}$/.test(m) ? m : undefined`.

**P4 (medium): Paytm Accept Refund SUCCESS is not "processed".** adapter.ts:564; test :426. The docs say "at this stage the refund to the user has not been initiated". Fix: map Accept Refund (`status === 'SUCCESS'` and no `userCreditInitiateTimestamp`) to `type: 'unknown'` with providerEventType `REFUND_SUCCESS` (informational). Emit `refund.processed` only for the Success Refund webhook (`userCreditInitiateTimestamp` present). Update the test.

**P5 (medium): Stripe emits a duplicate `refund.processed` per refund.** adapter.ts:721-734. refund.updated also fires for metadata and ARN updates, and refund.created can already carry `succeeded`. Fix:
- For refund events, set `id: \`refund:${r.id}:${r.status}\`` so the dedupe key is stable across these events.
- Or, for `refund.updated`, return `refund.processed` / `refund.failed` only when `event.data.previous_attributes?.status` is present (a status transition). refund.created and refund.failed need no such check.

**P6 (low): Paytm Accept Refund has no `totalRefundAmount`.** adapter.ts:567-571; test :421-426. The docs say `refundAmount` is "Total cumulative refund amount" on the Accept page. Fix: `const total = b.totalRefundAmount ?? (isAccept ? b.refundAmount : undefined)`, or leave `status` undefined for Accept, and drop `totalRefundAmount` from the Accept test fixture.

**P7 (low): Paytm `firstName` gets the full name.** adapter.ts:294. Fix: `const [firstName, ...rest] = (c?.name ?? '').trim().split(/\s+/); firstName: firstName || undefined, lastName: rest.join(' ') || undefined`.

**P8 (low): Paytm Initiate idempotency comment is wrong.** adapter.ts:297. The docs list "0002 Success Idempotent" and "2023 Repeat Request Inconsistent". Fix: correct the comment. Optionally set `retrySafe: true`, since a same-parameter retry returns 0002.

**P9 (low, text): Paytm capability says FAILED refund notifications are unsigned.** capabilities.ts:16, adapter.ts:539-540. Only the Success Refund FAILED sample is unsigned; the Accept Refund FAILED sample is signed. Fix the text: "Accept-Refund FAILED (signed) is normalised to refund.failed; the unsigned Success-Refund FAILED sample is rejected — poll getRefundStatus."

**P10 (low, text): Stripe refund-event guidance omits refund.created.** capabilities.ts:80. Stripe: "At a minimum, Stripe recommends that you listen for the refund.created event". Fix the text: "Subscribe to refund.created, refund.updated and refund.failed (a refund can be created already `succeeded`, with no later refund.updated)."

**P11 (low): Stripe dispute orderRef comes from the dispute's own metadata.** adapter.ts:751-761. Fix: leave orderRef undefined and document that the caller should look up `payment_intent`. Alternatively, fetch the PI (`GET /v1/payment_intents/{id}`) and read `metadata.order_ref`.

**P12 (low): Stripe export goods need a shipping address.** capabilities.ts:76, adapter.ts:372-391. Docs: goods exports need "The shipping address with a valid 2-alphabet ISO-3166 country code". Fix the constraint text. Optionally document `providerOptions.shipping_address_collection.allowed_countries` for goods.

**P13 (low): Stripe refund on an uncaptured PaymentIntent.** adapter.ts:579-601. For `requires_capture` the docs say "You must cancel the PaymentIntent". Fix: if the caller passes a PI known to be `requires_capture`, document or route to `POST /v1/payment_intents/{id}/cancel`. At minimum, add a hint on the resulting Stripe error.

**Carried-over lows (not re-ranked):**
- Paytm `fallbackRedirect` sits inside the JS Checkout `options` (adapter.ts:316); move it beside `options`.
- Paytm orderId charset and `|` are not validated (code 1008).
- `mapPaytmPaymentMode` does not map the documented postpaid value "Paytm Postpaid".

## Round-1 fixes re-checked

| Fix | Verdict |
|---|---|
| Paytm response signature over the raw body | Implemented correctly. Whether it matches Paytm's signing is UNVERIFIABLE (P1) |
| Paytm refund hosts securegw(-stage).paytmpayments.in | MATCH |
| Paytm refund webhook nested JSON | MATCH (envelope). Semantic issues P4 and P6 |
| Paytm custId sanitising | MATCH |
| Paytm error codes: 2005, status 501/334/335, refund-status 631/335/600/501 | MATCH. The duplicate-refId code set is wrong (P2) |
| Stripe charge.refunded → unknown | MATCH. Capability text incomplete (P10) |
| Stripe card-only for India | MATCH |
| Stripe length limits (255 / 200) | MATCH |
| Stripe API version pin | MATCH |
