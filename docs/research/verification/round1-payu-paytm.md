# Verification round 1: PayU India and Paytm PG

Date: 2026-10-29. Method: official docs fetched live (docs.payu.in `.md` exports and `llms.txt` indexes; paytmpayments.com/docs pages), official SDK source on GitHub/npm (payu-intrepos/web-sdk-php, payu-india/payu-sdk-node, paytm/Paytm_Node_Checksum, npm `paytmchecksum@1.5.1`, paytm/Paytm_PHP_Checksum, paytm/Paytm_Python_Checksum). `docs/research/*.md` was not used. No code was changed.

Extra evidence: an unauthenticated POST with a dummy body (`mid":"X"`, bad signature) was sent to the Paytm staging hosts to check whether the routes exist. No credentials were used.

Verdicts: MATCH / MISMATCH / NOT IN DOCS / COULD NOT ACCESS. "DOC CONFLICT" is noted inside the verdict cell where the official pages disagree with each other.

## Doc URL key

| Key | URL |
|---|---|
| P-HASH | https://docs.payu.in/docs/hashing-request-and-response |
| P-PAY | https://docs.payu.in/reference/_payment_payu_hosted_checkout |
| P-ADDL | https://docs.payu.in/reference/addl_info-payment-apis |
| P-VER | https://docs.payu.in/reference/verify_payment_api |
| P-REF | https://docs.payu.in/reference/refund_transaction_api |
| P-REFERR | https://docs.payu.in/reference/error-codes-for-refund-initiation |
| P-CAS-RID | https://docs.payu.in/reference/check_action_status_api_with_request_id |
| P-CAS-PID | https://docs.payu.in/reference/check_action_status_api_with_payu_id |
| P-WH | https://docs.payu.in/docs/webhook-events-and-sample-payloads |
| P-RCB | https://docs.payu.in/reference/refund-status-callback |
| P-MODE | https://docs.payu.in/docs/payment-mode-codes |
| P-SDKPHP | https://github.com/payu-intrepos/web-sdk-php/blob/master/PayU.php (official PayU PHP SDK) |
| P-SDKNODE | https://github.com/payu-india/payu-sdk-node/blob/main/lib/payu/hasher.js (official PayU Node SDK) |
| T-INIT | https://www.paytmpayments.com/docs/api/initiate-transaction-api |
| T-JSINV | https://www.paytmpayments.com/docs/jscheckout-invoke-payment |
| T-SPP | https://www.paytmpayments.com/docs/show-payment-page |
| T-STAT | https://www.paytmpayments.com/docs/api/v3/transaction-status-api |
| T-JSVER | https://www.paytmpayments.com/docs/jscheckout-verify-payment |
| T-REF | https://www.paytmpayments.com/docs/api/refund-api |
| T-RSTAT | https://www.paytmpayments.com/docs/api/refund-status-api |
| T-PSWH | https://www.paytmpayments.com/docs/payment-status |
| T-CBWH | https://www.paytmpayments.com/docs/callback-and-webhook |
| T-SRWH | https://www.paytmpayments.com/docs/success-refund-webhook |
| T-ARWH | https://www.paytmpayments.com/docs/accept-refund-webhook |
| T-CKS | https://www.paytmpayments.com/docs/checksum-implementation |
| T-LIBJS | https://github.com/paytm/Paytm_Node_Checksum/blob/master/PaytmChecksum.js (same code as npm paytmchecksum@1.5.1) |
| T-LIBPHP | https://github.com/paytm/Paytm_PHP_Checksum/blob/master/paytmchecksum/PaytmChecksum.php |
| T-LIBPY | https://github.com/paytm/Paytm_Python_Checksum/blob/master/paytmchecksum/PaytmChecksum.py |

---

## PayU India (src/providers/payu/adapter.ts, capabilities.ts)

| # | Item | Code says (file:line) | Docs say (short quote) | Doc URL | Verdict |
|---|---|---|---|---|---|
| 1 | Checkout URL, test | `https://test.payu.in/_payment` (adapter.ts:35) | "Test: `https://test.payu.in/_payment`" | P-PAY | MATCH |
| 2 | Checkout URL, prod | `https://secure.payu.in/_payment` (adapter.ts:39) | "Production: `https://secure.payu.in/_payment`" | P-PAY | MATCH |
| 3 | Postservice URL, test | `https://test.payu.in/merchant/postservice.php?form=2` (adapter.ts:36) | "`https://test.payu.in/merchant/postservice.php?form=2`" (verify page shows `postservice?form=2`) | P-REF, P-CAS-RID, P-VER | MATCH (verify page omits `.php`; both forms are documented) |
| 4 | Postservice URL, prod | `https://info.payu.in/merchant/postservice.php?form=2` (adapter.ts:40) | "`https://info.payu.in/merchant/postservice.php?form=2`" | P-VER, P-REF | MATCH |
| 5 | Postservice content type | URLSearchParams body, so `application/x-www-form-urlencoded` (adapter.ts:218-221, core/http.ts) | "`Content-Type: application/x-www-form-urlencoded`" | P-VER | MATCH |
| 6 | Checkout delivery | browser form POST (adapter.ts:289) | Content-Type `application/x-www-form-urlencoded` form post | P-PAY | MATCH |
| 7 | Request hash formula | `key\|txnid\|amount\|productinfo\|firstname\|email\|udf1..udf5\|\|\|\|\|\|SALT` (adapter.ts:63-77) | "sha512(key\|txnid\|amount\|productinfo\|firstname\|email\|udf1\|udf2\|udf3\|udf4\|udf5\|\|\|\|\|\|SALT)" | P-HASH | MATCH |
| 8 | Unused UDFs hash as empty | `f[k] ?? ''` (adapter.ts:71) | "Use an empty string `""` for each unused UDF" | P-HASH | MATCH |
| 9 | Hash algorithm and case | sha512 hex, lowercase (core/crypto.ts:15) | sample: "strtolower(hash('sha512', $hashString))" | P-HASH | MATCH |
| 10 | Reverse hash, regular | `SALT\|status\|\|\|\|\|\|udf5..udf1\|email\|firstname\|productinfo\|amount\|txnid\|key` (adapter.ts:84-100) | "sha512(SALT\|status\|\|\|\|\|\|udf5\|udf4\|udf3\|udf2\|udf1\|email\|firstname\|productinfo\|amount\|txnid\|key)" | P-HASH | MATCH |
| 11 | Reverse hash, additional charges | prepends `p.additional_charges` (adapter.ts:86) | "sha512(additional_charges\|SALT\|status\|\|\|\|\|\|udf5..." | P-HASH | MATCH for surl/furl. The webhook field table names it `additionalCharges` (P-WH), so a webhook with convenience fees may fail the hash. DOC CONFLICT, see mismatch M5 |
| 12 | Reverse hash, splitInfo | `p.splitInfo` after status (adapter.ts:88) | "sha512(SALT\|status\|splitInfo\|\|\|\|\|\|udf5..." | P-HASH | MATCH |
| 13 | Reverse hash uses configured key | `key` param, not payload (adapter.ts:97) | "key: Merchant key ... same as in the transaction request" | P-WH | MATCH |
| 14 | Incoming hash compared lowercase | `p.hash.toLowerCase()` (adapter.ts:301) | samples are lowercase hex | P-WH | MATCH |
| 15 | Postservice (command) hash | `sha512(key\|command\|var1\|salt)` (adapter.ts:103-105) | "PayU uses `sha512(key\|command\|var1\|salt)`" | P-HASH | MATCH |
| 16 | Refund hash ignores var2/var3 | var1 only (adapter.ts:220) | Refund Transaction API: "`sha512(key\|command\|var1\|salt)`" | P-HASH | MATCH |
| 17 | Mandatory checkout fields | key, txnid, amount, productinfo, firstname, email, phone, surl, furl, hash (adapter.ts:240-263) | addl table marks phone "`mandatory`" (OpenAPI omits phone and lists pg/bankcode) | P-ADDL, P-PAY | MATCH (DOC CONFLICT on phone/pg/bankcode; pg/bankcode are for seamless) |
| 18 | txnid max length | no check; `txnid = input.orderRef` (adapter.ts:255) | "`Character limit`: 25"; Node SDK throws if `txnid.length > 25` | P-ADDL, P-SDKNODE | MISMATCH (missing validation, M1) |
| 19 | txnid uniqueness | constraint text (capabilities.ts:34) | "Must be unique for every new transaction" | P-ADDL | MATCH |
| 20 | Amount format | `toMajorString` gives "499.00" (adapter.ts:256) | Node SDK: "digits with upto 2 decimal places"; samples "10.00" | P-SDKNODE, P-PAY | MATCH |
| 21 | productinfo / firstname / email limits | not validated (adapter.ts:257-259) | productinfo 100, firstname 60 (test 20), email 50 | P-ADDL | MISMATCH (missing validation, M2, low) |
| 22 | surl/furl length | not validated (adapter.ts:261-262) | "surl \| 50 \| 50" character limit | P-ADDL | MISMATCH (missing validation, M2, low; the 50 limit looks strict, so warn rather than throw) |
| 23 | UDF count and length | 5 UDFs, no length check (adapter.ts:44, 246-251) | "up to five udfs"; "Character limit 255 for udf1–udf5" | P-PAY, P-WH | MATCH on count; length not validated (low) |
| 24 | Address field names | address1, address2, city, state, zipcode, country (adapter.ts:267-272) | same names in parameter list | P-PAY, P-ADDL | MATCH |
| 25 | Currency | INR only (adapter.ts:227) | amount table has no currency field for domestic | P-PAY | NOT IN DOCS (reasonable) |
| 26 | verify_payment command and var1 | `verify_payment`, var1 = txnid (adapter.ts:327) | "`var1`: the transaction ID" | P-VER | MATCH |
| 27 | verify_payment response path | `transaction_details[txnid]` (adapter.ts:328) | sample `"transaction_details": { "<txnid>": {...} }` | P-VER | MATCH |
| 28 | verify fields read | mihpayid, status, unmappedstatus, amt, transaction_amount, mode, error_Message, field9 (adapter.ts:107-118) | all present in the sample response | P-VER | MATCH |
| 29 | `amt` meaning | `txn.amt ?? txn.transaction_amount` (adapter.ts:339) | amt: "original amount which was sent in the transaction request" | P-VER | MATCH |
| 30 | Not-found transaction | `status === 'not found'` gives created; mihpayid "Not Found" dropped (adapter.ts:146, 344) | `"mihpayid": "Not Found", "status": "Not Found"` | P-VER | MATCH (field values). Mapping to `created` is our interpretation |
| 31 | status enum | success / failure / failed / pending (adapter.ts:138-147) | "`success`, `failure`, or `pending`" (addl also says `failed`) | P-WH, P-ADDL | MATCH |
| 32 | unmappedstatus auth | success+auth gives authorized (adapter.ts:142) | "auth \| Success \| ... not captured at PayU's end" | P-WH | MATCH |
| 33 | unmappedstatus userCancelled | gives cancelled (adapter.ts:141) | "userCancelled \| Failure \| canceled by the customer" | P-WH | MATCH |
| 34 | unmappedstatus bounced/dropped/autoRefund/initiated | fall through to the top-level status (adapter.ts:143-144) | bounced/dropped/autoRefund are Failure; initiated / in progress are Pending | P-WH | MATCH (through top-level status) |
| 35 | Mode codes | CC/DC/NB/UPI/CASH/EMI/BNPL mapped (adapter.ts:159-169) | NB, CC, DC, CASH, UPI, EMI, NEFTRTGS, BNPL, QR, LR | P-MODE | MATCH for listed codes. QR / SBQR (seen in the webhook sample) fall through as `qr` / `sbqr`, not `upi` (low) |
| 36 | addedon format and timezone | IST `YYYY-MM-DD HH:mm:ss` (adapter.ts:171-176) | "e.g. `2026-02-27 14:24:42`" | P-WH | MATCH (format). IST offset is NOT IN DOCS |
| 37 | Refund command | `cancel_refund_transaction` (adapter.ts:378) | "command \| Mandatory \| Must be `cancel_refund_transaction`" | P-REF | MATCH |
| 38 | Refund var1 | mihpayid (providerPaymentId) (adapter.ts:379) | "var1 ... The Payu ID (mihpayid)" | P-REF | MATCH |
| 39 | Refund var2 token length | max 23 (adapter.ts:45, 361) | "Token ID length should not be greater than 23 characters" | P-REF | MATCH |
| 40 | Refund var2 uniqueness | not auto-retried (adapter.ts:376) | reused token: "token already used or request pending" | P-REF | MATCH |
| 41 | Refund var3 amount | rupee decimal string (adapter.ts:379) | OpenAPI types var3 as integer `500`; split sample sends `"0.10"` | P-REF | MATCH (DOC CONFLICT on type; decimal string is what the samples and SDK send) |
| 42 | Refund success detection | `data.status !== 1` is failure (adapter.ts:382) | "**1** if API call is a success"; "error_code value 102 should be treated as success" | P-REF | MATCH |
| 43 | Refund id field | `data.request_id` (adapter.ts:394) | captured: `[request_id]`; auth (cancel): `[txn_update_id] => <Request ID>` | P-REF | MISMATCH (M3: cancel-of-auth returns `txn_update_id`, so providerRefundId is undefined) |
| 44 | Refund result status | always `pending` (adapter.ts:396) | "Refund Request Queued" / async processing | P-REF | MATCH |
| 45 | Refund status command | `check_action_status`, var1 = request_id, no var2 (adapter.ts:409-411) | Prose: "In **check_action_status** API ... input this Request ID". Sample curl: `command=check_action_status_txnid` | P-CAS-RID, P-SDKPHP | MATCH. The official PHP SDK `checkRefundStatus` sends `check_action_status` + var1=request_id. DOC CONFLICT with the sample curl and the hash table (`check_action_status_txnid`) |
| 46 | PayU-ID mode of the same command | not used | "`var2` ... set to "payuid"" for mihpayid lookup | P-CAS-PID | MATCH (code correctly omits var2) |
| 47 | Refund status response shape | walks nested object for `status` string + amount/amt/action/request_id (adapter.ts:514-525) | `transaction_details.{rid}.{rid}.{status, amt, action, request_id ...}` | P-CAS-RID | MATCH for the prose sample. The OpenAPI sample is flat (`refund_status`, `refund_amount`) and would not be found (DOC CONFLICT, low) |
| 48 | Refund status amount field | `detail.amount ?? detail.amt` (adapter.ts:423) | sample field is `"amt": "10.00"` | P-CAS-RID | MATCH |
| 49 | Refund status values | success/processed/refunded; failure/failed/cancelled; queued/pending/requested/in progress (adapter.ts:150-156) | QUEUED, SUCCESS, FAILURE, IN PROGRESS, REQUESTED, od_hit; OpenAPI adds processing | P-CAS-RID | MISMATCH (M4: `od_hit` and `processing` map to `unknown`) |
| 50 | Refund status not-found | throws when no detail (adapter.ts:415-421) | `"transaction_details": { "13127842": "No action status found" }` | P-CAS-RID | MATCH |
| 51 | Payment webhook body format | form or JSON accepted (adapter.ts:179-196) | payment payloads "in the Form POST URL Encoded format" | P-WH | MATCH |
| 52 | Payment webhook verification | reverse hash with merchant salt (adapter.ts:436) | "hash \| Hash calculated by PayU. Merchant must verify it" | P-WH | MATCH (formula is not restated on the webhook page; it points to the response hash) |
| 53 | Payment webhook events | succeeded / failed / pending / authorized (adapter.ts:443-449) | Events: Successful, Failed, Refund, Dispute | P-WH | MATCH |
| 54 | Refund webhook | not parsed; throws SIGNATURE_INVALID (adapter.ts:437-440) | Refund payloads are "application/json" with no hash field | P-WH, P-RCB | MATCH with the capability claim ("not parsed"). Note: refund webhooks carry no signature at all |
| 55 | Webhook event id | `mihpayid:status` (adapter.ts:453) | no event id field in payload | P-WH | NOT IN DOCS (synthesised, OK) |
| 56 | Webhook amount | `p.amount` (adapter.ts:460) | "`amount` ... reflects the **original transaction amount**" | P-WH | MATCH |
| 57 | Simulated webhook fields | mihpayid, mode, status, unmappedstatus, key, txnid, amount, productinfo, firstname, email, phone, udf1-5, field9, error, error_Message, addedon, hash; form-encoded (adapter.ts:472-503) | same names in the success sample | P-WH | MATCH |
| 58 | Salt version | "Merchant salt (v1)" (capabilities.ts:30) | "PayU recommends you to use **Merchant Salt (Version 2)**" | P-HASH | NOT IN DOCS (the v2 hash wire format is not documented on the hash page; could not verify) |
| 59 | Capability: refundStatus "partial … from community SDKs" | capabilities.ts:16, adapter.ts:406 | official PHP SDK uses `check_action_status` + request_id | P-SDKPHP, P-CAS-RID | MISMATCH (text outdated: the command is in the official SDK and docs. Could be upgraded to "supported") |
| 60 | Capability: refund "Omitting amount refunds ORIGINAL amount" | capabilities.ts:15; adapter.ts:366-374 uses verify `amt` | amt = original amount; var3 "equal to the amount" for full refund | P-REF, P-VER | MATCH |
| 61 | Capability: webhooks "form and JSON accepted" | capabilities.ts:17 | payment = form, refund/dispute = JSON | P-WH | MATCH |
| 62 | Capability: test refund outcomes | not stated | UAT: amount 100-200 success, 0-99 failure, other in_progress | P-REF | NOT IN CODE (useful for the test docs) |

---

## Paytm Payment Gateway (src/providers/paytm/adapter.ts, checksum.ts, capabilities.ts)

| # | Item | Code says (file:line) | Docs say (short quote) | Doc URL | Verdict |
|---|---|---|---|---|---|
| 1 | Initiate host, staging | `https://securestage.paytmpayments.com` (adapter.ts:38) | "`https://securestage.paytmpayments.com/theia/api/v1/initiateTransaction?mid={mid}&orderId={order-id}`" | T-INIT | MATCH |
| 2 | Initiate host, prod | `https://secure.paytmpayments.com` (adapter.ts:39) | `secure.paytmpayments.com/theia/api/v1/initiateTransaction` | T-INIT | MATCH |
| 3 | Initiate path and query | `/theia/api/v1/initiateTransaction?mid=…&orderId=…` (adapter.ts:212) | same | T-INIT | MATCH |
| 4 | Content type | `application/json` (adapter.ts:163) | "Content Type : JSON" | T-INIT | MATCH |
| 5 | Envelope | `{"body":…,"head":{"signature":…}}` (adapter.ts:164) | `--data '{"body":{...},"head":{"signature":"{signature}"}}'` | T-INIT | MATCH |
| 6 | What is signed | exact `JSON.stringify(body)` string (adapter.ts:158-159) | "Create the signature using the body parameter of the request" | T-INIT, T-CKS | MATCH |
| 7 | requestType | `'Payment'` (adapter.ts:200) | "'Payment' for 'One time Payment' for all checkout flows" | T-INIT | MATCH |
| 8 | mid | `mid` in body (adapter.ts:201) | "mid … mandatory" | T-INIT | MATCH |
| 9 | websiteName values | WEBSTAGING / DEFAULT (adapter.ts:145) | "WEBSTAGING For Staging … DEFAULT For Production" | T-INIT | MATCH |
| 10 | orderId max length | 50 (adapter.ts:188) | "alphanumeric and max length is 50 characters" | T-INIT | MATCH (charset not validated; the status page allows `@ - _ .`) |
| 11 | callbackUrl | `callbackUrl: input.returnUrl` (adapter.ts:204) | "URL passed in callbackUrl has a higher preference" | T-INIT | MATCH |
| 12 | txnAmount shape | `{ value: "499.00", currency }` (adapter.ts:205) | `{"value" : "1.00", "currency" : "INR"}` | T-INIT | MATCH |
| 13 | Currency | INR only (adapter.ts:185) | "Possible Values: INR" | T-INIT | MATCH |
| 14 | userInfo.custId mandatory | `c?.id ?? CUST_${orderRef}` (adapter.ts:207) | "Special characters allowed in CustId are @, ! ,=,_ ,$, ." | T-INIT | MISMATCH (M6: a `-` in orderRef or customer.id produces an invalid custId) |
| 15 | userInfo.mobile / email / firstName | field names (adapter.ts:207) | mobile, email, firstName | T-INIT | MATCH |
| 16 | Pipe character | not checked | "1008 \| F \| Pipe character is not allowed" | T-INIT | NOT IN CODE (low) |
| 17 | Initiate success check | `resultStatus === 'S'` + txnToken (adapter.ts:218) | "0000 \| S \| Success"; "0002 \| S \| Success Idempotent" | T-INIT | MATCH |
| 18 | Initiate checksum-error code | AUTH only when `resultCode === '330'` (adapter.ts:172) | "2005 \| F \| Checksum provided is invalid" | T-INIT | MISMATCH (M7: initiate uses 2005, not 330) |
| 19 | txnToken TTL | 15 min (adapter.ts:42) | "It is valid for 15 minutes" | T-INIT | MATCH |
| 20 | JS Checkout script URL | `${host}/merchantpgpui/checkoutjs/merchants/${mid}.js` (adapter.ts:248) | `src="{HOST}/merchantpgpui/checkoutjs/merchants/{MID}.js"` | T-JSINV | MATCH |
| 21 | JS Checkout hosts | same host as API (adapter.ts:38-39) | "Staging: https://securestage.paytmpayments.com Production: https://secure.paytmpayments.com" | T-JSINV | MATCH |
| 22 | JS config root / flow | `root: ''`, `flow: 'DEFAULT'` (adapter.ts:226-227) | `"root": "", "flow": "DEFAULT"` | T-JSINV | MATCH |
| 23 | JS config data | `{orderId, token, tokenType:'TXN_TOKEN', amount}` (adapter.ts:228) | `"orderId" … "token" … "tokenType": "TXN_TOKEN", "amount"` | T-JSINV | MATCH |
| 24 | JS config handler | none (merchant adds `notifyMerchant`) | `"handler": { "notifyMerchant": function(eventName,data)` | T-JSINV | MATCH (handler is client-side) |
| 25 | `fallbackRedirect` inside options | extra key in the config object (adapter.ts:229-233) | config has root/flow/data/handler only | T-JSINV | NOT IN DOCS (low: if a caller passes `options` straight to `CheckoutJS.init`, an unknown key goes in. Consider moving it out of `options`) |
| 26 | showPaymentPage URL | `${host}/theia/api/v1/showPaymentPage?mid=…&orderId=…` (adapter.ts:231) | `action="https://securestage.paytmpayments.com/theia/api/v1/showPaymentPage?mid=…&orderId=…"` | T-SPP | MATCH |
| 27 | showPaymentPage fields | `mid, orderId, txnToken` (adapter.ts:232) | orderId, txnToken, mid all "Yes" | T-SPP | MATCH |
| 28 | Status host | `securestage/secure.paytmpayments.com` + `/v3/order/status` (adapter.ts:285) | API ref: `https://securegw-stage.paytmpayments.in/v3/order/status`. JS guide: `securestage.paytmpayments.com/v3/order/status` | T-STAT, T-JSVER | MATCH (DOC CONFLICT. The probe showed `.com` answers; `securegw-stage.paytmpayments.in/v3/order/status` returned "no healthy upstream" 503) |
| 29 | Status request body | `{mid, orderId}` (adapter.ts:285) | body: mid mandatory, orderId mandatory, txnType optional | T-STAT | MATCH |
| 30 | Status response fields | txnId, bankTxnId, orderId, txnAmount, txnType, gatewayName, paymentMode, refundAmt, txnDate (adapter.ts:60-71) | same names | T-STAT | MATCH |
| 31 | Status resultStatus enum | TXN_SUCCESS / TXN_FAILURE / PENDING / NO_RECORD_FOUND (adapter.ts:84-102) | "Possible Values: TXN_SUCCESS, TXN_FAILURE, PENDING, NO_RECORD_FOUND" | T-STAT | MATCH |
| 32 | Status error codes vs payment failure | any TXN_FAILURE becomes `failed`; only 330 throws (adapter.ts:288, 293) | "501 \| TXN_FAILURE \| Server Down"; "334 … Invalid Order ID"; "335 … Mid is invalid" | T-STAT | MISMATCH (M8: server-down / bad MID / bad order id are reported as a failed payment. 330 is not in this API's code list) |
| 33 | NO_RECORD_FOUND | `created` (adapter.ts:97-98) | "331 \| NO_RECORD_FOUND \| No Record Found" | T-STAT | MATCH (mapping to `created` is our interpretation) |
| 34 | paymentMode values | lowercased raw (adapter.ts:303) | "PPI … UPI … CC … DC … NB" | T-STAT | MATCH (field). Not normalised: gives `cc`/`dc`/`nb`/`ppi`, while PayU gives `card`/`netbanking`/`wallet` (low, consistency) |
| 35 | Response signature | not verified (adapter.ts:289-290) | "You should validate the parameter values by verifying the signature" | T-STAT, T-REF | MISMATCH (M9, recommended not mandatory. `HttpResponse.text` holds the raw bytes, so this can be done) |
| 36 | Refund host | same `.com` host + `/refund/apply` (adapter.ts:337) | only `https://securegw-stage.paytmpayments.in/refund/apply` / `securegw.paytmpayments.in` documented | T-REF | MISMATCH vs docs (M10). Probe: the `.com` staging route also answers with a Paytm JSON envelope. Needs a sandbox run to decide |
| 37 | Refund body fields | mid, txnType:'REFUND', orderId, txnId, refId, refundAmount (adapter.ts:326-333) | same names, all mandatory | T-REF | MATCH |
| 38 | refundAmount format | `toMajorString` "30.00" (adapter.ts:332) | "upto two decimal places. The only special character allowed is (".")" | T-REF | MATCH |
| 39 | preferredDestination | `TO_INSTANT` when speed=instant (adapter.ts:333) | "Possible Values: TO_INSTANT" | T-REF | MATCH |
| 40 | comments | `comments: input.reason` (adapter.ts:334) | "comments string(500) optional" | T-REF | MATCH (500 limit not validated, low) |
| 41 | refId length | not validated (adapter.ts:331) | "refId string(50) mandatory" | T-REF | MISMATCH (M11, low: no length check) |
| 42 | refId de-dup, retrySafe=true | auto-retry allowed (adapter.ts:336-337) | "Duplicate REFID will be rejected"; "617 \| TXN_FAILURE \| Refund Already Raised"; "671 … Refund retry is not supported with same refund id" | T-REF | MISMATCH (M12: a retry after a lost response returns TXN_FAILURE 617/671, and the adapter throws "refund failed" even though the first call registered the refund) |
| 43 | Refund response statuses | throws on TXN_FAILURE; else map (adapter.ts:339, 344) | "Possible Values: TXN_FAILURE, PENDING" | T-REF | MATCH |
| 44 | Refund 501 | PENDING passes through as pending (adapter.ts:344) | "501 \| PENDING \| System Error" | T-REF | MATCH (per docs; the probe got 501 PENDING for a garbage request, so 501 is not a reliable "accepted") |
| 45 | Refund response fields | refundId, refundAmount, refId, txnId (adapter.ts:73-81, 343-345) | refundId, refundAmount, refId, txnId present | T-REF | MATCH |
| 46 | Refund checksum error | 330 (via TXN_FAILURE throw) | "330 \| TXN_FAILURE \| Checksum provided is invalid" | T-REF | MATCH (but resultError only sets AUTH for 330, which is correct here) |
| 47 | Refund status host | `.com` + `/v2/refund/status` (adapter.ts:355) | only `https://securegw-stage.paytmpayments.in/v2/refund/status` documented | T-RSTAT | MISMATCH vs docs (M10, same as #36; the `.com` route answered the probe) |
| 48 | Refund status body | `{mid, orderId, refId}` (adapter.ts:356) | mid, orderId, refId all mandatory | T-RSTAT | MATCH |
| 49 | Refund status enum | TXN_SUCCESS / PENDING / TXN_FAILURE (adapter.ts:104-109) | "TXN_SUCCESS, TXN_FAILURE, PENDING, NO_RECORD_FOUND"; "10 \| TXN_SUCCESS \| Refund successful" | T-RSTAT | MATCH (NO_RECORD_FOUND gives `unknown`) |
| 50 | Refund status lookup errors | TXN_FAILURE becomes `failed` except 330 (adapter.ts:362, 367) | "631 \| TXN_FAILURE \| Record not found"; "335 … Mid is invalid"; "600 … Invalid refund request" | T-RSTAT | MISMATCH (M13: a lookup error such as 631/335 is reported as a failed refund) |
| 51 | Refund status fields | refId, refundId, refundAmount (adapter.ts:365-368) | refId, refundId, refundAmount, totalRefundAmount | T-RSTAT | MATCH |
| 52 | Callback (verifyPayment) fields | CHECKSUMHASH, MID, ORDERID, TXNID, TXNAMOUNT, STATUS, RESPMSG (adapter.ts:256-281) | MID, TXNID, ORDERID, BANKTXNID, TXNAMOUNT, CURRENCY, STATUS, RESPCODE, RESPMSG, TXNDATE, …, CHECKSUMHASH | T-SPP | MATCH |
| 53 | Callback STATUS values | TXN_SUCCESS / TXN_FAILURE / PENDING (adapter.ts:85-94) | "has only three values: TXN_SUCCESS, TXN_FAILURE and PENDING" | T-SPP | MATCH |
| 54 | Callback checksum verify | all POSTed fields minus CHECKSUMHASH, sorted, merchant key (adapter.ts:260; checksum.ts:49-56) | "verified on merchant server using Paytm library with all the parameters" | T-SPP | MATCH |
| 55 | TXNDATE format | parsed as IST `yyyy-MM-dd HH:mm:ss.S` (adapter.ts:399, 431) | "format "yyyy-MM-dd HH:mm:ss.S"" | T-SPP | MATCH (IST offset is NOT IN DOCS) |
| 56 | Payment webhook format | form-encoded key-values (+ flat JSON accepted) (adapter.ts:111-129) | "S2S response in key value pairs on the webhook configured and on callback URL" | T-PSWH | MATCH |
| 57 | Payment webhook fields | ORDERID, MID, TXNID, TXNAMOUNT, CURRENCY, STATUS, TXNDATE, CHECKSUMHASH (adapter.ts:387-415) | same set in samples | T-PSWH | MATCH |
| 58 | Payment webhook only final | PENDING gives payment.pending (adapter.ts:396) | "sent for the final transaction status i.e. success or failed" | T-PSWH | MATCH (harmless extra branch) |
| 59 | Refund webhook format | expects flat REFID / REFUNDID / REFUNDAMOUNT form fields; nested JSON is rejected (adapter.ts:119-124, 393, 398) | JSON `{"head":{"signature":…},"body":{"refId":…,"refundId":…,"status":"SUCCESS"}}` | T-SRWH, T-ARWH | MISMATCH (M14: every real Paytm refund webhook is rejected as VALIDATION) |
| 60 | Refund webhook status values | STATUS TXN_SUCCESS / TXN_FAILURE (adapter.ts:395) | body.status "SUCCESS" / "FAILED" | T-ARWH, T-SRWH | MISMATCH (part of M14) |
| 61 | Refund webhook signature | CHECKSUMHASH over form fields (adapter.ts:381) | head.signature, verified with the checksum library (failure sample has no signature) | T-SRWH | MISMATCH (part of M14) |
| 62 | Simulated refund webhook | flat form with REFID/REFUNDID (adapter.ts:433-440) | JSON head/body (see #59) | T-SRWH | MISMATCH (part of M14) |
| 63 | Webhook port | not enforced | "webhook URLs only allow port number 443" | T-CBWH | NOT IN CODE (doc note for users) |
| 64 | Webhook config location | "set in the Paytm Dashboard" (capabilities.ts:41) | "configure the following webhook URL from the merchant dashboard" | T-CBWH | MATCH |
| 65 | Checksum IV | `@@@@&&&&####$$$$` (checksum.ts:22) | `PaytmChecksum.iv = '@@@@&&&&####$$$$'` | T-LIBJS | MATCH |
| 66 | Cipher | AES-128-CBC, key = merchant key utf8 (checksum.ts:26-29) | `crypto.createCipheriv('AES-128-CBC', key, PaytmChecksum.iv)` | T-LIBJS | MATCH |
| 67 | Cipher in/out encodings | `'binary'` in, base64 out (checksum.ts:28) | `cipher.update(input, 'binary', 'base64')` | T-LIBJS | MATCH |
| 68 | Salt | `randomBytes(3).toString('base64')` (4 chars) (checksum.ts:69) | `crypto.randomBytes((length * 3.0) / 4.0` with length 4 | T-LIBJS | MATCH |
| 69 | Hash | `sha256hex(params + "\|" + salt) + salt` (checksum.ts:58-60) | `createHash('sha256').update(finalString).digest('hex') + salt` | T-LIBJS | MATCH |
| 70 | Verify: salt = last 4 chars | `paytmHash.slice(-4)` (checksum.ts:82) | `paytm_hash.substr(paytm_hash.length - 4)` | T-LIBJS | MATCH |
| 71 | Param string ordering | `Object.keys().sort()`, values joined `\|` (checksum.ts:37-47) | `Object.keys(params).sort()`; PHP `ksort`; Python `sorted(params.keys())` | T-LIBJS, T-LIBPHP, T-LIBPY | MATCH |
| 72 | "null" string becomes empty | `s.toLowerCase() === 'null'` gives "" (checksum.ts:44) | PHP: `strtolower($value) !== "null"`; Python: `.lower() != "null"`. Node lib: `toLowerCase() !== null` (always true, so it keeps "null") | T-LIBPHP, T-LIBPY, T-LIBJS | MATCH with PHP/Python (and the evident intent). Differs from the Node lib, which has a bug. The header comment (checksum.ts:5, 12) credits the Node lib for this rule; it should credit PHP/Python |
| 73 | CHECKSUMHASH stripped before verify | yes, without mutating caller (checksum.ts:51-53) | `delete params.CHECKSUMHASH` | T-LIBJS | MATCH |
| 74 | JSON bodies signed as string | string passed through untouched (checksum.ts:50) | "you need to pass the request body as a String" | T-CKS | MATCH |
| 75 | Merchant key length 16 | enforced (adapter.ts:470) | AES-128 requires a 16-byte key (implied by algorithm) | T-LIBJS | NOT IN DOCS (follows from AES-128) |
| 76 | Capabilities: hosts constraint | "staging securestage…, production secure…" + refund pages note (capabilities.ts:33-34) | as #1, #36 | T-INIT, T-REF | MATCH (note should add production `securegw.paytmpayments.in` for refund/status pages) |
| 77 | Capabilities: payment methods | `['upi','card','netbanking','emi']` (capabilities.ts:23) | PAYMENTMODE includes "Paytm wallet – PPI", "Postpaid - PAYTMCC" | T-SPP | MISMATCH (M15, low: wallet / paylater missing) |
| 78 | Capabilities: refund "refId de-duplicates" | capabilities.ts:14 | "Duplicate REFID will be rejected" | T-REF | MATCH (see M12 for the retry consequence) |
| 79 | Capabilities: webhooks "Refund notification shape is not verified" | capabilities.ts:16 | Refund webhooks are JSON head/body (T-SRWH) | T-SRWH | MISMATCH (text now verifiable: shape is documented and the code does not handle it) |
| 80 | Capabilities: business errors on HTTP 200 | capabilities.ts:39 | probe returned HTTP 200 + `resultInfo` for a bad request | T-STAT (probe) | MATCH |
| 81 | resultError hint code 330 "UNVERIFIED" | adapter.ts:171 | 330 listed for refund and refund-status APIs; 2005 for initiate | T-REF, T-RSTAT, T-INIT | MATCH for refund APIs; see M7 for initiate |

---

## Mismatches and exact fixes

PayU

- **M1 (PayU txnid limit).** adapter.ts:224-256. Add `if (input.orderRef.length > 25) throw new PaymentError('VALIDATION', 'PayU txnid (orderRef) must be at most 25 characters.', { provider: 'payu' })`. Update capabilities.ts constraints with "txnid max 25 chars".
- **M2 (PayU field limits, low).** adapter.ts:257-262. Validate productinfo ≤100, firstname ≤60, email ≤50, udf ≤255 (what the official Node SDK enforces). For surl/furl the docs list 50 chars. Warn, or document it, rather than throw, because the limit looks stale.
- **M3 (PayU cancel-of-auth id).** adapter.ts:126-132, 394. Add `txn_update_id?: string` to `PayuRefundResponse` and use `providerRefundId: data.request_id ?? data.txn_update_id`.
- **M4 (PayU refund states).** adapter.ts:150-156. Map `'od_hit'` and `'processing'` (and `'in_progress'`, which the UAT table uses) to `'pending'`.
- **M5 (PayU additional charges name, doc conflict).** adapter.ts:86. Use `const addl = p.additional_charges ?? p.additionalCharges; if (addl) parts.push(addl);`.
- Capability text (PayU #59). capabilities.ts:16 and adapter.ts:406. The command and response shape are in the official docs and the official PHP SDK (`checkRefundStatus` sends `check_action_status` with var1=request_id). Update the text, and consider changing 'partial' to 'supported'.

Paytm

- **M6 (custId charset).** adapter.ts:207. Sanitise to the allowed set, for example `(c?.id ?? \`CUST_${input.orderRef}\`).replace(/[^A-Za-z0-9@!=_$.]/g, '_')`.
- **M7 (initiate checksum code).** adapter.ts:172. Treat `'2005'` like `'330'`: `const auth = info?.resultCode === '330' || info?.resultCode === '2005';`.
- **M8 (status API errors reported as payment failure).** adapter.ts:288-293. Before mapping, throw `resultError` for resultCode in `['501','334','335','330']`. 501 is "Server Down" and should be retryable, so use a provider/unavailable code, not `failed`.
- **M9 (response signature not verified).** adapter.ts:289-290 (and the refund calls). `HttpResponse.text` holds the raw response. Extract the raw `"body":{…}` substring and call `verifySignature(rawBody, merchantKey, head.signature)`. If that is too fragile, keep TLS-only but say so in capabilities.
- **M10 (refund/refund-status host).** adapter.ts:38-39, 337, 355. The docs list only `https://securegw-stage.paytmpayments.in` (staging) and `https://securegw.paytmpayments.in` (production) for `/refund/apply` and `/v2/refund/status`. To follow the docs, add `PAYTM_REFUND_HOST = { sandbox: 'https://securegw-stage.paytmpayments.in', live: 'https://securegw.paytmpayments.in' }` and use it for those two calls. The unauthenticated probe showed that both hosts answer these routes on staging, and that `/v3/order/status` on the `.in` staging host returned 503. Leave status on `.com`, and confirm the refund host in a sandbox run.
- **M11 (refId length, low).** adapter.ts:309-331. Validate `refundRef` is 1-50 chars. Optionally validate `comments` ≤500.
- **M12 (refund retry vs duplicate refId).** adapter.ts:336-339. Either set `retrySafe` to `false`, or keep the retry and, on resultCode `'617'` / `'671'` / `'626'` / `'629'`, call `getRefundStatus({orderRef, refundRef})` and return that result instead of throwing.
- **M13 (refund status lookup errors).** adapter.ts:362-367. Throw `resultError` for resultCode in `['631','335','600','501']` rather than returning `failed` (501 is PENDING in the docs, so returning pending is acceptable).
- **M14 (refund webhooks).** adapter.ts:111-129, 373-417, 433-440. Real refund webhooks (Accept Refund, Success Refund) are JSON `{head:{signature,version}, body:{orderId, txnId, refId, refundId, refundAmount, totalRefundAmount, status:"SUCCESS"|"FAILED", ...}}`. Fix:
  1. In `parseWebhook`, if the raw body parses as JSON with a `body` object, verify `head.signature` against the raw `body` JSON substring with `verifySignature(rawBodyString, key, signature)`.
  2. Map `body.status` SUCCESS to `refund.processed` and FAILED to `refund.failed`.
  3. Read `refId` / `refundId` / `refundAmount` / `orderId` / `txnId` (camelCase).
  4. Treat a missing `head.signature` (shown in the failure sample) as unverifiable and reject it.
  5. Update `simulateWebhook('refund.processed')` to emit this JSON shape.
  6. Update capabilities.ts:16.
- **M15 (payment methods, low).** capabilities.ts:23. Add `'wallet'` (PPI) and `'paylater'` (PAYTMCC). Optionally normalise `paymentMode` in adapter.ts:303 (CC/DC to card, NB to netbanking, PPI to wallet, PAYTMCC to paylater).
- Comment fix (checksum.ts:5, 12-13). The "null" handling follows the PHP/Python libraries. The Node `PaytmChecksum.js` (GitHub and npm 1.5.1) compares `toLowerCase() !== null`, which is always true. The behaviour is correct; only the attribution is wrong.

## Could not verify

- PayU Salt v2 hash wire format. The docs recommend v2 but the hash page gives no v2 formula, so the code's use of v1 cannot be checked.
- PayU `check_action_status` vs `check_action_status_txnid` for request-id lookups. The prose and the official PHP SDK say `check_action_status`; the sample curl and the hash table say `_txnid`. Only a sandbox call settles this.
- PayU check_action_status response shape. The prose sample is nested and the OpenAPI sample is flat (`refund_status`). The code handles only the nested form.
- PayU `additional_charges` vs `additionalCharges` in the webhook payload (see M5).
- PayU whether verify_payment `status: "Not Found"` also covers a txnid that was never submitted at all (mapped to `created`).
- PayU timezone of `addedon` (assumed IST; the docs give no offset).
- Paytm the correct production host for `/refund/apply` and `/v2/refund/status` (docs: `securegw.paytmpayments.in`; code: `secure.paytmpayments.com`). The probe shows both staging hosts route these paths. Nothing was checked in production.
- Paytm resultCode for an invalid checksum on `/v3/order/status`. 330 is not in that API's code list. The probe with a bad signature and a bad MID returned 501 "System Error", so the code that is actually used could not be isolated.
- Paytm refund webhook signature input. The docs say to verify with the checksum library but do not say whether the signed string is the raw `body` JSON. That is the convention for the other JSON APIs, but it is not stated for webhooks.
- Paytm whether an initiated-but-unpaid order returns NO_RECORD_FOUND or PENDING on `/v3/order/status`.
- Paytm TXNDATE timezone (assumed IST; not stated).
