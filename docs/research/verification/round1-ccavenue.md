# Round 1 verification: CCAvenue

Scope: `src/providers/ccavenue/adapter.ts` and `src/providers/ccavenue/capabilities.ts`, checked on 2026-10-29.

## Source situation

- CCAvenue publishes **no public API reference**. `mars.ccavenue.com/downloads/...` (the integration PDF) no longer resolves in DNS, the Wayback Machine was offline during this check, and Scribd copies of the API PDF return only a landing page.
- The best available evidence is **copies of CCAvenue's own integration kits** that merchants committed to GitHub. They keep the kit's file names, sample forms and hard-coded URLs. These are labelled **official kit (mirror)** below. They are not hosted by CCAvenue, so they are byte copies by third parties. Two independent mirrors of `NodeJS_Integration_Kit` agree (they differ only in formatting).
- Everything else comes from third-party implementations (Odoo India, Knit Pay WordPress plugin, GoDaddy's Spree gem, a Go client, Perfex CRM module, and others). Agreement among several of them is noted.
- The only first-party ccavenue.com page with technical content is the Dynamic Event Notification press page.

### Key URLs

| Short name | URL |
|---|---|
| NodeKit-128 (mirror A) | https://github.com/Ayush78516/priyesgh/tree/main/docs/AES-128 |
| NodeKit-256 (mirror A) | https://github.com/Ayush78516/priyesgh/tree/main/docs/AES-256 |
| NodeKit (mirror B, `NodeJS_Integration_Kit/AES-128` + `AES-256`) | https://github.com/werdivine/amrit-milk-dec25/tree/main/ccavenuekits/nodejs_extracted/NodeJS_Integration_Kit |
| PHP kit (mirror) | https://github.com/info2programmer/php-and-mysqli-e-commerce/tree/master/payonline |
| PHP status sample (mirror of kit `status_api.php`) | https://github.com/vikash9580/thebanarasi/blob/master/status_api.php |
| Knit Pay (WP plugin) | https://github.com/WordPressBugBounty/plugins-knit-pay/blob/main/knit-pay/gateways/CCAvenue/API.php |
| Odoo India | https://github.com/odoo-india/payment_gateway/tree/main/odoo_payment_ccavenue |
| GoDaddy Spree | https://github.com/godaddy/spree_ccavenue_api/blob/master/lib/api_caller.rb |
| Go client | https://github.com/gurunandan-bhat/ccavenue/tree/main/client |
| Perfex module | https://github.com/InWebzer/Perfex-CCAvenue-Payment-Gateway/blob/main/helpers/ccavenue_order_status_helper.php |
| CCAvenue_API (PHP wrapper) | https://github.com/kalyanakannan/CCAvenue_API/blob/master/API.php |
| Think-To-Share (GCM PHP) | https://github.com/Think-To-Share/payment/tree/main/src/Gateways/CcAvenue |
| CCAvenue DEN press page | https://www.ccavenue.com/pr/Get-real-time-status-updates-of-crucial-events-in-your-account-with-Dynamic-Event-Notifications |
| StoreHippo setup guide | https://help.storehippo.com/topic/setting-up-ccavenue-as-the-payment-gateway |
| Meta WhatsApp CCAvenue guide | https://developers.facebook.com/documentation/business-messaging/whatsapp/payments/payments-in/upi-intent/pg-guide-ccavenue |

## Verification table

Paths are relative to `src/providers/ccavenue/`. "adapter" = `adapter.ts`, "caps" = `capabilities.ts`.

| # | Item | Code says (file:line) | Source says (≤15 words) | URL | Source type | Verdict |
|---|---|---|---|---|---|---|
| 1 | Live checkout URL (CBC kit) | `https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction` (adapter:38) | `action="https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction"` | NodeKit-128 `nonseamless/ccavRequestHandler.js`; PHP kit `ccavRequestHandler.php` | official kit (mirror) | MATCH |
| 2 | Test checkout URL | `https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction` (adapter:34) | `CCAVENUE_TEST_URL = 'https://test.ccavenue.com'` + `endpoint = 'transaction/transaction.do'` | Odoo `const.py`, `payment_transaction.py`; Knit Pay `API.php` | third-party (2 agree) | MATCH |
| 3 | Checkout form fields | `fields: { encRequest, access_code }` (adapter:266) | `name="encRequest" ... name="access_code"` | NodeKit-128 + PHP kit request handlers | official kit (mirror) | MATCH |
| 4 | Plaintext request fields | `merchant_id, order_id, amount, currency, redirect_url, cancel_url, language: 'EN'` (adapter:227-235) | kit form: `merchant_id order_id currency amount redirect_url cancel_url language` | NodeKit-128 `public/dataFrom.html` | official kit (mirror) | MATCH |
| 5 | Optional billing fields | `billing_name/email/tel/address/city/state/zip/country` (adapter:237-247) | `billing_name ... billing_country value="India" billing_tel ... billing_email` | NodeKit-128 `dataFrom.html` | official kit (mirror) | MATCH (note: kit sample passes country **name** "India", not ISO code) |
| 6 | merchant_param1..5 | five slots (adapter:49, 249-251) | `merchant_param1` ... `merchant_param5` | NodeKit-128 `dataFrom.html` | official kit (mirror) | MATCH |
| 7 | Plaintext encoding | `new URLSearchParams(order).toString()` (adapter:256) | Node kit encrypts raw urlencoded POST body: `body += data; encRequest = ccav.encrypt(body,...)` | NodeKit-128 `ccavRequestHandler.js` | official kit (mirror) | MATCH (PHP kit sends unencoded `k=v&`; both forms are accepted by CCAvenue per the kits) |
| 8 | Cipher (classic) | `aes-128-cbc` (adapter:55, 62) | `crypto.createCipheriv('aes-128-cbc', key, iv)` | NodeKit-128 `ccavutil.js` | official kit (mirror) | MATCH |
| 9 | Key derivation (classic) | `md5(workingKey)` raw 16-byte digest (adapter:55; core/crypto.ts:19-21) | PHP: `$key = hextobin(md5($key));` Node: `createHash('md5') ... digest('binary')` | PHP status sample; NodeKit-128 | official kit (mirror) | MATCH |
| 10 | IV (classic) | bytes `0x00..0x0f` (adapter:52) | `pack("C*", 0x00, 0x01, ... 0x0e, 0x0f)` | PHP status sample; NodeKit-128 `'\x00\x01...\x0f'` | official kit (mirror) | MATCH |
| 11 | Ciphertext encoding | lowercase hex; decrypt accepts any case (adapter:56, 61) | `cipher.update(plainText,'utf8','hex')` / PHP `bin2hex($openMode)` | NodeKit-128; PHP status sample | official kit (mirror) | MATCH |
| 12 | Padding | Node default PKCS#7 (adapter:55-63) | `openssl_encrypt(... 'AES-128-CBC' ..., OPENSSL_RAW_DATA, ...)` (PKCS#7 default) | PHP status sample | official kit (mirror) | MATCH |
| 13 | **Newer AES-256-GCM kit exists** | only a warning: "may use a different (AES-256-GCM) kit" (caps:37); **no implementation** | `const algorithm = 'aes-256-gcm'; const iv = crypto.randomBytes(12);` | NodeKit-256 `ccavutil.js` (both mirrors) | official kit (mirror) | MISMATCH (scheme exists in current NodeJS kit; adapter can't use it) |
| 14 | GCM key derivation | n/a | `createCipheriv(algorithm, key, iv)` where key = raw working key, no MD5 | NodeKit-256 `ccavRequestHandler.js` + `ccavutil.js` | official kit (mirror) | NOT IMPLEMENTED |
| 15 | GCM wire format | n/a | `return iv.toString('hex') + Buffer.concat([encrypted, authTag]).toString('hex');` | NodeKit-256 `ccavutil.js` | official kit (mirror) | NOT IMPLEMENTED |
| 16 | GCM checkout URL | not present (adapter:32-41) | `action="https://secure.ccavenue.com/gTransaction.do?command=initiateTransaction"` | NodeKit-256 `ccavRequestHandler.js` | official kit (mirror) | MISMATCH for GCM accounts |
| 17 | GCM test URL | not present | `SANDBOX_URL = 'https://test.ccavenue.com/gTransaction.do?command=initiateTransaction'` | Think-To-Share `CcAvenueGateway.php` | third-party | NOT IMPLEMENTED |
| 18 | GCM kit extra field | n/a | AES-256 sample form adds `name="tid"` (timestamp) to the order fields | NodeKit-256 `public/dataFrom.html` | official kit (mirror) | NOTE (looks optional; the CBC kit dropped it) |
| 19 | Redirect response field | reads `payload.encResp` (adapter:273) | `var encryption = ccavPOST.encResp;` / PHP `$_POST["encResp"]` | NodeKit-128 `ccavResponseHandler.js`; PHP kit | official kit (mirror) | MATCH |
| 20 | Decrypted response format | urlencoded `k=v&...` parsed with URLSearchParams (adapter:167) | `$decryptValues=explode('&', $rcvdString); ... explode('=',...)` | PHP kit `ccavResponseHandler.php` | official kit (mirror) | MATCH |
| 21 | Redirect `order_status` values | Success/Failure/Aborted/Invalid/Timeout handled (adapter:69-82) | kit checks `"Success"`, `"Aborted"`, `"Failure"`; others are "Security Error" | PHP kit `ccavResponseHandler.php` | official kit (mirror) | MATCH |
| 22 | Extra redirect statuses | `invalid`, `timeout` → failed (adapter:75-77) | `case INVALID = "Invalid"; case TIMEOUT = "Timeout";` | Think-To-Share `PaymentStatus.php`; Odoo `const.py` | third-party (2 agree) | MATCH |
| 23 | Redirect fields read | `order_id, tracking_id, amount, currency, order_status, failure_message, status_message, trans_date` (adapter:274-300, 404-417) | `order_id, tracking_id, bank_ref_no, order_status, failure_message, payment_mode, ... trans_date` | Think-To-Share `PaymentData.php`; karthickraja `ccavenue.types.ts` | third-party | MATCH (official kit only shows `order_status` is the 4th field) |
| 24 | `trans_date` format | `dd/mm/yyyy hh:mm:ss` IST (adapter:461-467) | `format: 'd/m/Y H:i:s', timeZone: 'Asia/Kolkata'` | Think-To-Share `PaymentData.php` | third-party | MATCH |
| 25 | Live API URL | `https://api.ccavenue.com/apis/servlet/DoWebTrans` (adapter:39) | "Production API URL:-https://api.ccavenue.com/apis/servlet/DoWebTrans" | Scribd copy of CCAvenue API PDF (search snippet); Knit Pay; Odoo; Perfex | third-party copy of official PDF + 3 impls | MATCH |
| 26 | Test API URL | `https://apitest.ccavenue.com/apis/servlet/DoWebTrans` (adapter:35) | `'https://apitest.ccavenue.com/apis/servlet/DoWebTrans'` | PHP status sample; Knit Pay; Perfex; Odoo | official kit (mirror) + third-party | MATCH (older code used `login.ccavenue.com`, which is legacy) |
| 27 | API POST params | `enc_request, access_code, command, request_type, response_type, version` (adapter:178-185) | `enc_request=...&access_code=...&command=orderStatusTracker&request_type=JSON&response_type=JSON` | PHP status sample; Perfex; Go `client.go` | official kit (mirror) + third-party | MATCH |
| 28 | Body encoding | form-urlencoded (adapter:178, URLSearchParams) | `req.Header.Add("Content-Type", "application/x-www-form-urlencoded")` | Go `client.go` | third-party | MATCH |
| 29 | `version` value | `'1.2'` for every command (adapter:47) | "current possible values is 1.1"; some newer calls say "pass version as 1.2" | Scribd API PDF copy (search snippet) | third-party copy of official PDF | MISMATCH-RISK (see fixes) |
| 30 | version used for orderStatusTracker | `1.2` | `client.NewClient(cfg, "1.2")` (Go); `"version": "1.2"` (ERPNext); Perfex uses `'1.1'` | Go `cmd/status.go`; ERPNext `checkstatus.py`; Perfex | third-party (split) | PARTIAL (both used in the wild) |
| 31 | version used for refundOrder | `1.2` | `'version': '1.1'` (Odoo, Python refund, CCAvenue_API) | Odoo `payment_transaction.py`; kalyanakannan `API.php`; Ajith-te `refund.py` | third-party (3 agree, none use 1.2) | MISMATCH-RISK |
| 32 | Status command | `orderStatusTracker` (adapter:307) | `&command=orderStatusTracker&request_type=JSON` | PHP status sample; Knit Pay; Spree; Go | official kit (mirror) + third-party | MATCH |
| 33 | Status request body | `{ order_no }` only (adapter:308) | `'order_no' => '20210629-12173612', 'reference_no' =>''` | PHP status sample; Knit Pay sends only `order_no` | official kit (mirror) + third-party | MATCH |
| 34 | Outer response | `status=0&enc_response=<hex>`; on `status=1` enc_response is plain error, `enc_error_code` (adapter:187-199) | "status '1' denotes failed API call and enc_response will contain plain error" | Odoo `payment_provider.py` comment; Perfex reads `enc_error_code` | third-party (citing the PDF) | MATCH |
| 35 | Status inner wrapper | handles `Order_Status_Result` or flat (adapter:306, 312) | `json_decode(...)['Order_Status_Result']` (no version sent); Perfex/Go read flat (version sent) | Knit Pay; Spree; Perfex; Go | third-party | MATCH (both shapes handled) |
| 36 | Inner `status` / `error_desc` / `error_code` | non-zero `status` or `error_desc` → error (adapter:313-319) | `if ( $response['status'] ) { throw ... $response['error_desc'] }` | Knit Pay; Go `OrderError` | third-party | MATCH |
| 37 | Status response fields | `order_no, reference_no, order_status, order_amt, order_gross_amt, order_currncy, order_option_type, order_card_name, order_bank_response` (adapter:123-137, 321-334) | `json:"order_currncy"`, `json:"order_amt"`, `json:"order_option_type"`, `json:"order_card_name"` ... | Go `status.go`; Perfex | third-party (2 agree) | MATCH (`order_currency` fallback appears nowhere, but is harmless) |
| 38 | Tracker `order_status` values | Successful, Shipped, Unsuccessful, Cancelled, Auto-Cancelled, Awaited, Initiated, Refunded, Auto-Reversed (adapter:69-91) | `CAPTURED = ['Successful','Shipped','Success']`, `REFUNDED = ['Refunded','Auto-Reversed']` | karthickraja `ccavenue.mapper.ts` | third-party (single) | PARTIAL |
| 39 | `Fraud`, `System refund`, `Partially refunded` | mapped (adapter:76, 87, 90) | no source found | n/a | n/a | NOT FOUND |
| 40 | `Chargeback` | not mapped (falls to `unknown`) | no source found | n/a | n/a | NOT FOUND |
| 41 | Refund command | `refundOrder` (adapter:359) | `command: 'refundOrder'` | Spree; Odoo; CCAvenue_API; Python refund | third-party (4 agree) | MATCH |
| 42 | Refund request JSON | `{ reference_no, refund_amount, refund_ref_no }` (adapter:360) | `"reference_no":"1236547", "refund_amount":"1.0", "refund_ref_no":"API1234"` | kalyanakannan `API.php`; Odoo; Spree | third-party (3 agree) | MATCH |
| 43 | `reference_no` = tracking_id | `providerPaymentId` (tracking_id) (adapter:340, 360) | `reference_no: tracking_id` | Spree `api_caller.rb`; Odoo uses `provider_reference` | third-party | MATCH |
| 44 | `refund_amount` format | rupee decimal string (adapter:360) | `'refund_amount': f'{-self.amount:.2f}'` | Odoo | third-party | MATCH |
| 45 | Refund response | `Refund_Order_Result` or flat; `refund_status` 0 = ok; `reason`, `error_code` (adapter:363-371) | `json_params['Refund_Order_Result']['refund_status']` / `['reason']` | Spree; Odoo reads flat `refund_status`; Python reads `error_code` | third-party | MATCH |
| 46 | Duplicate `refund_ref_no` | "de-duplication ... not documented" (adapter:357) | "repeat attempts raise duplicate parameter errors" (staging, one refund per order) | Odoo `payment_transaction.py` comment | third-party | MATCH (it is rejected, not deduplicated) |
| 47 | Refund status lookup | `not_implemented` (caps:17) | `'command': 'getRefundDetails'` with `{reference_no}`; statuses `TS-REFC/TS-REFA/TS-REFF/TS-REFD` | Odoo | third-party | NOTE (a command exists; capability text can name it) |
| 48 | Refund notifications | "only carries payment results" (adapter:424); "Payment events only" (caps:18) | Order Refund Status: "Occurs every time a ... refund ... is processed by the bank" | CCAvenue DEN press page | **official** | MISMATCH (wording: DEN does have a refund event; the adapter just does not parse it) |
| 49 | DEN payload format / signature | "no publicly documented signed webhook" (caps:18) | page says only that the event object is posted "securely" | CCAvenue DEN press page | official | MATCH (no signature documented) |
| 50 | IP whitelisting for API calls | "Server IP must be whitelisted" (caps:35; adapter:197) | "whitelist the outgoing server IP for server to server call" | StoreHippo guide | third-party | MATCH |
| 51 | Error 51407 = invalid access_code | caps:35 | no source found | n/a | n/a | NOT FOUND |
| 52 | Credentials location | "Dashboard > Settings > API Keys" (adapter:476; caps:30) | go to "Setting, then API Keys" | StoreHippo guide; Medium/edureka snippets | third-party | MATCH |
| 53 | Amount format | Numeric(12,2) rupee string (caps:28) | `amount`: "Numeric (12, 2)" | Meta WhatsApp guide | third-party | MATCH |
| 54 | `orderNo` in redirect POST | simulator adds `orderNo` beside `encResp` (adapter:448-451) | official kits read only `encResp` | NodeKit/PHP kit | official kit (mirror) | NOT FOUND (harmless in a simulator) |
| 55 | `payment_mode` for UPI | simulator uses `'Unified Payments'` (adapter:438) | Odoo maps `'UPI': 'upi'` | Odoo `const.py` | third-party | NOT FOUND (simulator only) |
| 56 | Paytm "AES-256-CBC, IV 01..10" claim | n/a | "Algorithm: AES-256-CBC ... IV: fixed value 0102...0f10" | paytm/paytm-agent-skills `REFERENCE.md` | third-party | REJECTED: wrong (an MD5 key is 16 bytes, so this can't be AES-256; every kit uses IV 00..0f). Do not cite it. |

## Mismatches and exact fixes

1. **AES-256-GCM kit not supported (items 13-17).** The current CCAvenue NodeJS kit ships an `AES-256` folder next to `AES-128`. Exact scheme from the kit's `ccavutil.js`:
   - cipher `aes-256-gcm`
   - key = the working key **as given** (32-character string → 32 UTF-8 bytes), **no MD5**
   - nonce = 12 random bytes
   - output = `hex(iv) + hex(ciphertext || authTag)`, with a 16-byte tag at the end
   - decrypt: `iv = buf[0..12)`, `tag = buf[-16..]`, `ct = buf[12..-16)`
   - checkout URL `https://secure.ccavenue.com/gTransaction.do?command=initiateTransaction` (test: `https://test.ccavenue.com/gTransaction.do?command=initiateTransaction`, third-party). Note the path has no `/transaction/` and starts with `g`.

   Fix: add an optional credential `CCAVENUE_ENCRYPTION` = `cbc` (default) | `gcm`. Add `ccavenueEncryptGcm`/`ccavenueDecryptGcm` implementing the above, and choose the checkout URL per scheme:
   ```ts
   checkoutGcm: { sandbox: 'https://test.ccavenue.com/gTransaction.do?command=initiateTransaction',
                  live:    'https://secure.ccavenue.com/gTransaction.do?command=initiateTransaction' }
   ```
   When decrypting GCM, try a 12-byte IV first and fall back to 16 bytes. Several third-party GCM integrations, some for CCAvenue white-labels such as Bank Muscat SmartPay, use a 16-byte IV, and the IV length cannot be detected from the data. Whether DoWebTrans also switches to GCM for these accounts is unverified. One third-party implementation (Digital-Edge-360) uses GCM for the API too, so use the same scheme for `api()` when `gcm` is set. Update caps:37 to describe the exact scheme instead of "may use".

2. **`version` for refundOrder (items 29, 31).** Every refundOrder implementation found sends `version=1.1`, and the API PDF copy says "current possible values is 1.1". Fix: make the version per command:
   ```ts
   const API_VERSION: Record<string, string> = { orderStatusTracker: '1.2', refundOrder: '1.1' };
   ...
   version: API_VERSION[command] ?? '1.1',
   ```
   The more conservative option is `'1.1'` for both. Perfex uses 1.1 for orderStatusTracker, while the Go client and ERPNext use 1.2, so either value works for status. Update the comment at adapter:43-46 and caps:15-16.

3. **Refund notifications wording (item 48).** CCAvenue's own DEN page lists an "Order Refund Status" event. Change adapter:424 to something like `'refund notifications', 'CCAvenue sends an Order Refund Status DEN event, but its payload is not publicly documented; poll getPaymentStatus.'`, and change caps:18 "Payment events only" to "Only Order Status events are parsed; CCAvenue also offers Order Refund Status and Order Risk Status events (payload undocumented)."

4. **Minor / docs only:**
   - caps:17 can name `getRefundDetails` (request `{reference_no}`, returns `refund_list[]` with `refund_status` codes `TS-REFA`/`TS-REFC`/`TS-REFF`/`TS-REFD`, according to Odoo). This is third-party evidence only.
   - caps:35 "Error 51407 = invalid access_code" has no source. Mark it unverified or drop it.
   - adapter:247 `billing_country`: the kit sample uses a country name ("India"). If callers pass ISO codes such as `IN`, consider mapping them or documenting that a name is expected. This is unverified either way.
   - Odoo notes that staging accepts only one refund per order. That is worth a line next to caps:16's partial-refund note.

## What remains unverifiable

- The complete official list of orderStatusTracker `order_status` values. `Fraud`, `System refund`, `Partially refunded` and `Chargeback` were not found in any source. `Shipped`, `Successful`, `Unsuccessful`, `Awaited`, `Auto-Reversed` and the others come from a single third-party mapper.
- Whether the wrapped (`Order_Status_Result` / `Refund_Order_Result`) or flat response shape depends on `version`. Implementations that send no version unwrap a wrapper, while 1.1/1.2 implementations read flat JSON. The code handles both, so this is low risk.
- Whether `version=1.2` is accepted for `refundOrder`. No implementation found uses it.
- Error code 51407, and any official IP-whitelisting statement from CCAvenue itself (only a StoreHippo guide was found).
- The GCM scheme's sandbox URL, and whether DoWebTrans uses GCM for AES-256 accounts. The NodeJS kit covers checkout only, and it is unclear how an account is assigned to the 128 or 256 kit.
- DEN payload format (encResp form vs JSON event object) and any signature.
- `refund_ref_no` idempotency semantics in production: Odoo saw duplicates rejected on staging.
- The official API PDF itself. `mars.ccavenue.com` does not resolve, Scribd copies are not readable, and the archive was offline.
