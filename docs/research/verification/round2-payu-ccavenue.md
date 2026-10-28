# Round 2 verification: PayU India and CCAvenue

Date: 2026-10-29. Scope: `src/providers/payu/{adapter,capabilities}.ts`, `src/providers/ccavenue/{adapter,capabilities}.ts`, `test/providers/payu.test.ts`, `test/providers/ccavenue.test.ts`.
Method: every claim was checked again from scratch. The round-1 reports were used only to find out which fixes had been applied.

- PayU: the `.md` exports of docs.payu.in pages were fetched on 2026-10-29, along with the official SDK source (payu-india/payu-sdk-node `lib/payu/hasher.js` and payu-intrepos/web-sdk-php `PayU.php`).
- CCAvenue: two GitHub mirrors of CCAvenue's own NodeJS integration kit (AES-128 and AES-256 folders) and the kit's PHP `status_api.php` sample. Also the first-party ccavenue.com DEN page and third-party integrations, which are labelled as such.
- No calls were made to any PayU or CCAvenue API host. Code was not edited.
- Independent known-answer checks:
  - `shasum -a 512` over the documented PayU request and reverse-hash strings reproduces the hashes asserted in `payu.test.ts:46,55`.
  - `openssl enc -aes-128-cbc -K md5(key) -iv 00..0f` reproduces the CBC vector in `ccavenue.test.ts:43`.
- Both test files pass (68 tests).

## Sources

| Short | URL | Type |
|---|---|---|
| P-HASH | https://docs.payu.in/docs/hashing-request-and-response | official |
| P-PAY | https://docs.payu.in/reference/_payment_payu_hosted_checkout | official |
| P-ADDL | https://docs.payu.in/reference/addl_info-payment-apis | official |
| P-VER | https://docs.payu.in/reference/verify_payment_api | official |
| P-REF | https://docs.payu.in/reference/refund_transaction_api | official |
| P-REFERR | https://docs.payu.in/reference/error-codes-for-refund-initiation | official |
| P-CAS | https://docs.payu.in/reference/check_action_status_api_with_request_id | official |
| P-WH | https://docs.payu.in/docs/webhook-events-and-sample-payloads | official |
| P-MODE | https://docs.payu.in/docs/payment-mode-codes | official |
| P-NODE | https://github.com/payu-india/payu-sdk-node/blob/main/lib/payu/hasher.js | official SDK |
| P-PHP | https://github.com/payu-intrepos/web-sdk-php/blob/master/PayU.php | official SDK |
| C-K256 | https://github.com/werdivine/amrit-milk-dec25/tree/main/ccavenuekits/nodejs_extracted/NodeJS_Integration_Kit/AES-256 (same files in Ayush78516/priyesgh `docs/AES-256` and rajkumar-tech-2002/project_dote) | kit (mirror) |
| C-K128 | …/NodeJS_Integration_Kit/AES-128/nonseamless (same mirror) | kit (mirror) |
| C-PHPST | https://github.com/vikash9580/thebanarasi/blob/master/status_api.php (copy of kit status sample) | kit (mirror) |
| C-DEN | https://www.ccavenue.com/pr/Get-real-time-status-updates-of-crucial-events-in-your-account-with-Dynamic-Event-Notifications | official |
| C-T2S | https://github.com/Think-To-Share/payment/tree/main/src/Gateways/CcAvenue | third-party |
| C-KNIT | https://github.com/WordPressBugBounty/plugins-knit-pay/blob/main/knit-pay/gateways/CCAvenue/Statuses.php (cites dashboard.ccavenue.com integrationKit doc) | third-party |
| C-ODOO | https://github.com/odoo-india/payment_gateway/blob/19.0/odoo_payment_ccavenue/models/payment_transaction.py | third-party |
| C-KK | https://github.com/kalyanakannan/CCAvenue_API/blob/master/API.php | third-party |
| C-SPREE | https://github.com/godaddy/spree_ccavenue_api/blob/master/lib/api_caller.rb | third-party |

## PayU India

Lines refer to `src/providers/payu/adapter.ts` (A) and `capabilities.ts` (C).

| Item | Code file:line | Source quote (≤15 words) | URL | Type | Verdict |
|---|---|---|---|---|---|
| Checkout host, test | A:35 `https://test.payu.in/_payment` | `$this->url = 'https://test.payu.in/_payment';` | P-PHP, P-PAY | official | MATCH |
| Checkout host, live | A:39 `https://secure.payu.in/_payment` | `$this->url = 'https://secure.payu.in/_payment';` | P-PHP, P-PAY | official | MATCH |
| Postservice host, test/live | A:36,40 | "Test … `https://test.payu.in/merchant/postservice.php?form=2`"; "Production … `https://info.payu.in/…`" | P-VER, P-PHP:291 | official | MATCH |
| Request hash | A:72-86 | `sha512(key\|txnid\|amount\|productinfo\|firstname\|email\|udf1\|…\|udf5\|\|\|\|\|\|SALT)` | P-HASH, P-NODE, P-PHP:137 | official | MATCH (KAT reproduced with shasum) |
| Reverse hash, base | A:93-111 | `sha512(SALT\|status\|\|\|\|\|\|udf5\|udf4\|udf3\|udf2\|udf1\|email\|firstname\|productinfo\|amount\|txnid\|key)` | P-HASH | official | MATCH (KAT reproduced) |
| Reverse hash, additional charges (round-1 fix M5) | A:96-97 | `sha512(additional_charges\|SALT\|status\|…` and PHP SDK `isset($params["additionalCharges"])` | P-HASH, P-PHP:158, P-NODE | official | MATCH (both spellings occur in official sources; reading both is correct) |
| Reverse hash, splitInfo | A:99 | `sha512(SALT\|status\|splitInfo\|\|\|\|\|\|udf5…` | P-HASH | official | MATCH |
| `key` in reverse hash = configured key | A:108 | Node SDK `validateHash` builds the string from the caller's `key` param | P-NODE | official | MATCH |
| Postservice hash | A:114-116 | "PayU uses `sha512(key\|command\|var1\|salt)`" | P-HASH, P-PHP:292 | official | MATCH |
| Postservice body encoding | A:232-235 | curl `Content-Type: application/x-www-form-urlencoded` | P-VER | official | MATCH |
| txnid ≤25 (round-1 fix M1) | A:52,320 | "`Character limit`: 25"; SDK `txnid.length > 25` throws | P-ADDL, P-NODE | official | MATCH |
| productinfo ≤100, email ≤50, udf ≤255 (round-1 fix M2) | A:52,321-324 | "productinfo \| 100 \| 100"; "email \| 50 \| 50"; "udf1 - udf5 \| 255" | P-ADDL, P-NODE | official | MATCH |
| firstname ≤60 | A:52,322 | "firstname \| 60 \| 20" (Production \| Test) | P-ADDL | official | **MISMATCH**: sandbox limit is 20 (see M-P1) |
| surl/furl ≤50 | A:54,325-332 (warn only) | "surl \| 50 \| 50"; "furl \| 50 \| 50" | P-ADDL | official | MISMATCH, accepted on purpose (warn-only, documented in C:35) |
| phone/address limits | A:274,279-287 (not checked) | "phone … `Character limit`: 50"; "zipcode \| 20"; "address1 \| 100"; "lastname \| 20" | P-ADDL | official | MISMATCH, low (not validated; see M-P4) |
| phone mandatory | A:254 | "phone `mandatory`" | P-ADDL | official | MATCH |
| Form fields key/txnid/amount/productinfo/firstname/email/phone/surl/furl/hash | A:267-293 | sample payload `key=…&txnid=…&amount=10.00&firstname=…&email=…&phone=…&productinfo=…&surl=…&furl=…&hash=` | P-PAY | official | MATCH |
| Amount format | A:270, C:27 | SDK `AMOUNT_REGEX = /^\d+(\.\d{1,2})?$/`; samples "10.00" | P-NODE, P-PAY | official | MATCH |
| verify_payment command / var1=txnid | A:367 | "var1 is your transaction ID" | P-VER, P-PHP:180 | official | MATCH |
| verify_payment fields read | A:118-129,368-390 | sample `"amt": "2.00", "transaction_amount"…, "mode": "UPI", "unmappedstatus": "captured"` | P-VER | official | MATCH |
| `amt` vs `transaction_amount` | A:379 `amt ?? transaction_amount` | "amt … original amount which was sent in the transaction request"; but failure sample shows amt 9900 / transaction_amount 10000 | P-VER | official (self-contradictory) | UNVERIFIABLE (see M-P6) |
| "Not Found" → created | A:159, 384 | `"mihpayid":"Not Found","status":"Not Found"` when txnID is not found | P-VER | official | MATCH |
| Status mapping success/failure/pending | A:151-161 | "Outcome … `success`, `failure`, or `pending`" | P-WH | official | MATCH |
| unmappedstatus auth → authorized | A:155 | "auth \| Success \| … not captured at PayU's end" | P-WH | official | MATCH |
| userCancelled → cancelled | A:154 | "userCancelled \| Failure \| … canceled by the customer" | P-WH | official | MATCH |
| "in progress" → pending | A:157 | "in progress \| Pending" | P-WH | official | MATCH |
| Mode codes CC/DC/NB/CASH/UPI/EMI/BNPL | A:173-183 | "Credit Card \| CC … Cash Card or Wallet \| CASH … BNPL \| BNPL" | P-MODE | official | MATCH (QR/NEFTRTGS/LR pass through lowercased) |
| Refund command and vars | A:417-421 | "var1 is the Payu ID (mihpayid) … var2 … Token ID … var3 … amount" | P-REF, P-PHP:217 | official | MATCH |
| Refund token ≤23 | A:45,401 | "Token ID length should not be greater than 23 characters" | P-REF | official | MATCH |
| Refund success test `status === 1` | A:422 | "status … **1** if API call is a success • **0** if … failed" | P-REF | official | MATCH; see M-P2 for the error_code 102 note |
| Refund id request_id / txn_update_id (round-1 fix M3) | A:434 | "`[msg] => Cancel Request Queued [txn_update_id] => <Request ID>`" | P-REF | official | MATCH |
| Refund result pending | A:436 | "`[msg] => Refund Request Queued`" | P-REF | official | MATCH |
| Refund var5 (callback URL) | not sent | table: "var5 `mandatory` … refund webhook/callback URL"; samples and PHP SDK omit it | P-REF, P-PHP:217 | official (conflicting) | UNVERIFIABLE (M-P5) |
| Refund de-duplication | A:416, C:15 | "token already used or request pending"; error 106 "Token already exists." | P-REF, P-REFERR | official | MATCH (a duplicate token is rejected; the "undocumented" wording is slightly stale) |
| Refund status command | A:451 `check_action_status` | OpenAPI `"enum": ["check_action_status"]`; curl/prose use `check_action_status_txnid` | P-CAS, P-PHP:222 | official (conflicting) | UNVERIFIABLE (code follows OpenAPI + SDK) |
| Refund status nested shape (round-1 fix) | A:456,563-574 | `"transaction_details": {"131278422": {"131278422": {… "amt": "10.00", … "status": "success"` | P-CAS | official | MATCH |
| Refund status flat shape (round-1 fix) | A:556-560 | OpenAPI `"refund_status"` enum, `"refund_amount"` | P-CAS | official | MATCH |
| Refund status values | A:163-170 | "QUEUED … SUCCESS … FAILURE … IN PROGRESS"; enum `pending, success, failed, processing` | P-CAS | official | MATCH (od_hit/in_progress come from round 1 and were not re-found; harmless) |
| "No action status found" → error | A:457-464 | `"13127842": "No action status found"` | P-CAS | official | MATCH |
| Payment webhook format | A:193-210 | "payment successful and failure payloads are in the Form POST URL Encoded format" | P-WH | official | MATCH (JSON accepted too; harmless) |
| Payment webhook hash | A:478 | "hash \| Hash calculated by PayU. Merchant must verify it" | P-WH | official | MATCH |
| `addedon` format | A:186-190 | "`addedon` … (e.g. `2026-02-27 14:24:42`)" | P-WH | official | MATCH (IST is assumed: UNVERIFIABLE) |
| Refund webhooks not parsed | A:481,510-511, C:17 | "Refund and Dispute payloads … application/json"; the sample has no `hash` field | P-WH | official | MATCH (the claim is correct; there is no hash to verify) |
| Salt version | C:30 "salt (v1)" | "PayU recommends you to use **Merchant Salt (Version 2)**" | P-HASH | official | UNVERIFIABLE (no v2 wire format documented) |
| Capability: refundStatus supported | C:16 | PHP SDK `checkRefundStatus` → `check_action_status`, var1=request_id | P-PHP:221-222 | official | MATCH |

## CCAvenue

Lines refer to `src/providers/ccavenue/adapter.ts` (A) and `capabilities.ts` (C).

| Item | Code file:line | Source quote (≤15 words) | URL | Type | Verdict |
|---|---|---|---|---|---|
| CBC live checkout | A:50 | `action="https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction"` | C-K128 `ccavRequestHandler.js` | kit (mirror) | MATCH |
| CBC test checkout | A:44 | Odoo/Knit Pay use `test.ccavenue.com` + `transaction/transaction.do` | C-ODOO | third-party | MATCH (third-party only) |
| GCM live checkout (round-1 fix) | A:52 | `action="https://secure.ccavenue.com/gTransaction.do?command=initiateTransaction"` | C-K256 `ccavRequestHandler.js` | kit (mirror, 3 copies) | MATCH |
| GCM test checkout (round-1 fix) | A:46 | `SANDBOX_URL = 'https://test.ccavenue.com/gTransaction.do?command=initiateTransaction'` | C-T2S `CcAvenueGateway.php:23` | third-party | MATCH (third-party only, labelled in code) |
| Form fields | A:350 | `name="encRequest" … name="access_code"` | C-K128, C-K256 | kit (mirror) | MATCH |
| Plaintext fields | A:311-338 | form: `merchant_id order_id amount currency redirect_url cancel_url language … merchant_param1..5` | C-K128/C-K256 `dataFrom.html` | kit (mirror) | MATCH (the AES-256 sample adds an optional `tid`) |
| billing_country as a name (round-1 fix) | A:131-139,331 | `name="billing_country" value="India"` (both kits) | C-K128, C-K256 | kit (mirror) | MATCH (Intl gives "India"; CCAvenue's spelling for other countries is UNVERIFIABLE) |
| CBC cipher, key, IV, hex | A:68-80 | `createCipheriv("aes-128-cbc", key, iv)`; `md5`; `"\x00\x01…\x0f"`; `update(plainText,"utf8","hex")` | C-K128 `ccavutil.js`; PHP `hextobin(md5($key))` | kit (mirror) | MATCH (KAT reproduced with openssl) |
| GCM cipher (round-1 fix) | A:100-104 | `const algorithm = "aes-256-gcm"; const iv = crypto.randomBytes(12);` | C-K256 `ccavutil.js` | kit (mirror) | MATCH |
| GCM key = raw working key | A:88-97 | `crypto.createCipheriv(algorithm, key, iv)` with `workingKey` string, no MD5 | C-K256 | kit (mirror) | MATCH (32-byte check is what Node enforces anyway) |
| GCM wire format | A:103 | `iv.toString("hex") + Buffer.concat([encrypted, authTag]).toString("hex")` | C-K256 | kit (mirror) | MATCH |
| GCM decrypt layout | A:111-128 | `iv = slice(0,12); authTag = slice(-16); ciphertext = slice(12,-16)` | C-K256 | kit (mirror) | MATCH (16-byte-IV fallback is extra but safe: GCM authentication rejects a wrong split) |
| GCM for DoWebTrans | A:236-242 | T2S `enquirePayment` encrypts `orderStatusTracker` with its GCM `Crypto` (left as `dd()` TODO) | C-T2S | third-party (unfinished) | UNVERIFIABLE (labelled in C:15) |
| Redirect field `encResp` | A:357 | `var encryption = ccavPOST.encResp;` | C-K128, C-K256 | kit (mirror) | MATCH |
| Decrypted response is urlencoded | A:251 | PHP kit `explode('&', $rcvdString)` | kit (round-1 ref) | kit (mirror) | MATCH |
| API hosts | A:47,53 | `curl_setopt($ch, CURLOPT_URL, "https://apitest.ccavenue.com/apis/servlet/DoWebTrans")`; T2S `LIVE_ENQUIRY_URL = 'https://api.ccavenue.com/…'` | C-PHPST, C-T2S | kit (mirror) + third-party | MATCH |
| API params | A:262-269 | `'enc_request='…'&access_code='…'&command=orderStatusTracker&request_type=JSON&response_type=JSON'` | C-PHPST | kit (mirror) | MATCH (the kit sends no `version`) |
| version per command (round-1 fix) | A:63,268 | Odoo refundOrder `'version': '1.1'`; KK `$version = '1.1'` for all | C-ODOO:268, C-KK:22 | third-party | MATCH for refundOrder 1.1; orderStatusTracker 1.2 is UNVERIFIABLE (split in the wild) |
| Status request `{order_no}` | A:392 | `'order_no' => '20210629-12173612', 'reference_no' =>''` | C-PHPST | kit (mirror) | MATCH |
| Outer response parse | A:271-283 | kit: `explode('&', $result)` … `if ($info_value[0] == 'enc_response')` | C-PHPST | kit (mirror) | MATCH |
| Wrapper `Order_Status_Result` / `Refund_Order_Result` | A:396,447 | Spree reads the wrapper; Odoo reads flat `refund_status` | C-SPREE, C-ODOO | third-party | MATCH (both handled) |
| Tracker status values | A:142-170 | `SUCCESSFUL … AUTO_CANCELLED … AUTO_REVERSED … FRAUD … SYSTEM_REFUND … TIMEOUT … UNSUCCESSFUL` | C-KNIT | third-party (cites dashboard doc) | MATCH; `Partially refunded` has no source; `Chargeback` (Kotak enum) maps to unknown (M-C2) |
| Redirect status values | A:144-157 | Odoo `'Success' … 'Failure' … 'Aborted' … 'Invalid' … 'Timeout'` | C-ODOO:214-224 | third-party | MATCH |
| Refund command and body | A:442-446 | Odoo `'reference_no': …provider_reference, 'refund_amount': f'{…:.2f}', 'refund_ref_no'` | C-ODOO:253-256 | third-party | MATCH |
| Refund success `refund_status` 0 | A:448 | Odoo `elif status == 0:  # CCAvenue refund initiated success` | C-ODOO:228 | third-party | MATCH |
| Refund amount currency | A:430,444 | explicit `amount` is formatted as INR whatever the order currency | n/a | n/a | MISMATCH, low (M-C1) |
| getRefundDetails exists | C:17 | Odoo `'command': 'getRefundDetails'`, statuses `TS-REFC`, `TS-REFA`, `TS-REFF`/`TS-REFD` | C-ODOO:292,171-180 | third-party | MATCH (capability text is accurate) |
| DEN refund event wording | A:512, C:18 | "Order Refund Status: Occurs every time a full or partial refund … processed" | C-DEN | official | MATCH |
| DEN signature | C:18 | page only says the event object is posted "securely" | C-DEN | official | MATCH (none documented) |
| Error code 51407 | test ccavenue.test.ts:174 | no source found | n/a | n/a | UNVERIFIABLE (fixture only) |

## Unit tests vs sources

No assertion contradicts a source. Notes:

- `payu.test.ts:46,55` and `ccavenue.test.ts:43` were reproduced independently with shasum and openssl, using the documented formulas.
- `payu.test.ts:286` uses a fixture shaped `transaction_details.{request_id}.{mihpayid}`. The documented shape has request_id at both levels (`:297` covers that). The fixture is undocumented but harmless, because the walker ignores keys.
- `payu.test.ts:131` checks email >50 (official). No test covers the sandbox firstname limit of 20 (M-P1).
- `ccavenue.test.ts:174`: `enc_error_code=51407` meaning "invalid access code" is unsourced and appears only in a fixture.
- `ccavenue.test.ts:270` (16-byte GCM IV) covers a third-party variant only, which is acceptable.
- `ccavenue.test.ts:231-237`: the test is named "orderStatusTracker 1.2, refundOrder 1.1" but asserts only the refund half. The status half is asserted at `:161` and `:326`.

## Ranked MISMATCH list with exact fixes

1. **M-P1 (PayU, medium for sandbox users): firstname limit is 20 in the test environment.** P-ADDL "Character Limit for Request Parameters" gives firstname as 60 in production and 20 in test, and lastname as 20 in both. Code enforces 60 everywhere (A:52,322).
   - Fix in `validateFieldLengths`: `tooLong('firstname', this.environment === 'sandbox' ? 20 : PAYU_FIELD_LIMITS.firstname);`
   - Or, if you prefer not to reject, `this.ctx.logger.warn(...)` when `environment === 'sandbox' && firstname.length > 20`.
   - Add "firstname 60 (20 in test)" to C:35.
2. **M-P2 (PayU, low, hardening): refund error_code 102 is documented as success.** P-REF and P-CAS: "The error_code value 102 should be treated as success; the rest are failures." Per P-REFERR, 102 = QUEUED. Code (A:422) accepts only `status === 1`. All documented success samples carry `status: 1`, so this only matters if PayU ever sends `error_code: 102` with `status: 0`.
   - Fix: `const accepted = typeof data === 'object' && (data.status === 1 || String(data.error_code ?? '') === '102'); if (!accepted) { …throw… }`.
3. **M-C1 (CCAvenue, low): an explicit refund amount is always formatted as INR.** A:430 sets `let currency = 'INR'` and changes it only when the amount is looked up. For a zero-decimal-currency order (for example JPY) with an explicit `amount`, `toMajorString(amount, 'INR')` sends a wrong `refund_amount`. Two-decimal currencies are unaffected.
   - Fix: when `input.amount !== undefined`, still fetch the currency (`const s = await this.getPaymentStatus(...); currency = s.currency ?? 'INR'`), or add `currency?: string` to `RefundInput` and use `input.currency ?? 'INR'`.
4. **M-P4 (PayU, low): other documented field limits are not validated.**
   - Limits: phone 50, lastname 20, address1/address2 100, city/state/country 50, zipcode 20 (P-ADDL).
   - Fix: add `address1: 100, address2: 100, city: 50, state: 50, country: 50, zipcode: 20, phone: 50` to `PAYU_FIELD_LIMITS`, and call `tooLong` for each in `validateFieldLengths`.
5. **M-C2 (CCAvenue, low/doc): status mapping gaps.**
   - `Chargeback` appears in a CCAvenue-derived enum (caideli1/cloud-service KotakOrderStatusEnum) and currently maps to `unknown` (A:167). Either leave it as is or add `case 'chargeback': return 'refunded';` with a comment.
   - `partially refunded` (A:165) has no source. Keep it and mark it UNVERIFIED in a comment.
6. **M-P3 (PayU, accepted deviation): surl/furl limit of 50.** The official table says 50 in both environments, and the code only warns (A:325-332). This was a deliberate round-1 decision and is documented in C:35. No change unless sandbox rejects long URLs.
7. **M-P0 (PayU, doc wording): refund de-duplication.** C:15 and A:416 say de-duplication on token_id "is not documented". PayU documents that a reused token is rejected ("token already used or request pending"; error 106 "Token already exists.").
   - Fix: reword to "A reused token (var2) is rejected (error 106), not de-duplicated; on OUTCOME_UNKNOWN check status before retrying with the same token."

UNVERIFIABLE items (no code change justified without a sandbox):

- PayU `check_action_status` vs `check_action_status_txnid`: the same doc page uses both.
- PayU refund `var5`: marked "mandatory" in the table but absent from every sample and from the official PHP SDK.
- PayU `amt` vs `transaction_amount` semantics when an offer or discount applies.
- PayU Salt v2 wire format.
- PayU `addedon` timezone.
- CCAvenue orderStatusTracker `version` 1.2 vs 1.1.
- CCAvenue use of GCM on DoWebTrans.
- CCAvenue GCM sandbox URL (third-party only).
- CCAvenue error code 51407.
- CCAvenue DEN payload format.

## Round-1 fixes: verdict

| Fix | Verdict |
|---|---|
| PayU txnid ≤25 and productinfo/email/udf limits | Correct (P-ADDL, P-NODE). firstname is correct for production only (M-P1). |
| PayU surl/furl warn-only | Deviates from the docs on purpose; documented. |
| PayU txn_update_id for cancel-of-auth | Correct (P-REF sample). |
| PayU refund status, nested and flat shapes, plus pending states | Correct (P-CAS prose sample and OpenAPI enum). No regression: the flat detector requires a string `refund_status`, and the nested walker skips the numeric top-level `status`. |
| PayU additional_charges / additionalCharges | Correct (P-HASH uses one spelling; P-PHP, P-NODE and P-WH use the other). Prefix only when non-empty, same as P-NODE. |
| CCAvenue GCM scheme (cipher, raw key, 12-byte IV, iv‖ct‖tag hex, gTransaction.do) | Correct, byte for byte against the kit `ccavutil.js` and `ccavRequestHandler.js`. |
| CCAvenue version per command (refundOrder 1.1, orderStatusTracker 1.2) | refundOrder 1.1 is supported by every third-party source. 1.2 for status is in use in the wild. No regression. |
| CCAvenue billing_country as a name | Correct ("India" in both kits). ISO→name via Intl, names left unchanged. |
| CCAvenue DEN refund wording | Correct (C-DEN). |
