# CCAvenue

There are **no public official API docs.** CCAvenue ships the integration kit and API PDFs inside the merchant dashboard (M.A.R.S.). Most facts below are UNVERIFIED: they match the PHP/Node/Java kits in circulation and third-party copies of the API PDF. Get the kit for **your** account from the dashboard and diff it against this file before shipping.

## Credentials and environment

- `merchant_id`, `access_code`, `working_key` (the AES secret). Dashboard > Settings > API Keys. UNVERIFIED path
- Env (this project): `CCAVENUE_MERCHANT_ID`, `CCAVENUE_ACCESS_CODE`, `CCAVENUE_WORKING_KEY`, `CCAVENUE_ENCRYPTION` (optional: `cbc` default, or `gcm`; see Encryption).
- Test and live use different hosts AND different credentials.
- **IP whitelisting:** the server's public egress IP must be registered with CCAvenue before server API calls work. Serverless/auto-scaling hosts with changing IPs need a NAT gateway / static egress. Source: merchant setup guides, not CCAvenue itself. PARTIAL. Error codes such as `enc_error_code` are passed through unmapped.
- The `access_code` is tied to the registered domain/URL; a mismatch fails checkout. UNVERIFIED

## Amounts

Rupee decimal, Numeric(12,2): `"499.00"`. PARTIAL

## Checkout flow (form POST, encrypted)

1. Server builds a plaintext query string: `merchant_id, order_id, currency=INR, amount, redirect_url, cancel_url, language=EN, billing_name, billing_email, billing_tel, …, merchant_param1..5`. UNVERIFIED
2. Encrypt it → `encRequest` (hex). Render an auto-submitting form with fields `encRequest`, `access_code` to:
   - cbc kit: test `https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction`, prod `https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction`
   - gcm kit: prod `https://secure.ccavenue.com/gTransaction.do?command=initiateTransaction` (from the official NodeJS kit, via mirrors), test `https://test.ccavenue.com/gTransaction.do?command=initiateTransaction` (third-party source)
   UNVERIFIED against an official public page.
   `billing_country` is a country name (`India`, as in the kit sample); this project maps ISO alpha-2 codes to names.
3. CCAvenue POSTs `encResp` (+ `orderNo`) to `redirect_url`. Decrypt → query string with `order_id, tracking_id, bank_ref_no, order_status (Success|Failure|Aborted|Invalid), amount, currency, payment_mode, …`. UNVERIFIED
4. With the cbc kit, decryption succeeding is the only integrity check and it is NOT authentication (AES-CBC has no MAC; blocks can be spliced or bit-flipped). The gcm kit's auth tag does authenticate. Either way **confirm with `orderStatusTracker` before fulfilling** and check amount + order_id. `PaymentsClient.verifyPayment` does this automatically.

## Encryption: two kits

CCAvenue's current NodeJS kit ships both an AES-128 and an AES-256 folder. Set `CCAVENUE_ENCRYPTION` to the kit CCAvenue assigned your account; how accounts are assigned is not documented, so ask CCAvenue before going live.

- **cbc** (default, classic kit): AES-128-CBC, key = raw 16-byte `md5(working_key)`, IV = bytes `0x00..0x0f`, PKCS#7, ciphertext hex. UNVERIFIED officially (kits agree).
- **gcm** (AES-256 kit): AES-256-GCM, key = the 32-character working key used directly (no MD5), random 12-byte IV, output `hex(iv) + hex(ciphertext || 16-byte tag)`. From the kit's `ccavutil.js` (third-party mirrors of the official download). Whether the DoWebTrans server API also uses GCM for these accounts is UNVERIFIED (one third-party implementation does; this project does too).

cbc snippet:

```ts
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
const IV = Buffer.from([...Array(16).keys()]); // 0x00..0x0f
const key = (workingKey: string) => createHash('md5').update(workingKey).digest(); // 16 raw bytes

export function ccavEncrypt(plain: string, workingKey: string) {
  const c = createCipheriv('aes-128-cbc', key(workingKey), IV);
  return Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('hex');
}
export function ccavDecrypt(hex: string, workingKey: string) {
  const d = createDecipheriv('aes-128-cbc', key(workingKey), IV);
  return Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8'); // throws on wrong key/tamper (padding)
}
// const resp = Object.fromEntries(new URLSearchParams(ccavDecrypt(body.encResp, WORKING_KEY)));
```

## Server API

- POST form to prod `https://api.ccavenue.com/apis/servlet/DoWebTrans`, staging `https://apitest.ccavenue.com/apis/servlet/DoWebTrans`. Params `enc_request, access_code, command, request_type (JSON|XML|STRING), response_type, version`. PARTIAL
- `version`: this project sends `1.2` for `orderStatusTracker` (third-party implementations use 1.2 and 1.1) and `1.1` for `refundOrder` (every implementation found uses 1.1). UNVERIFIED
- Response: `status=0` + `enc_response` (decrypt with the same scheme); `status=1` = failure with message. UNVERIFIED

| Purpose | command | encrypted JSON | Status |
|---|---|---|---|
| Status | `orderStatusTracker` | `{order_no, reference_no}` (Meta guide shows `orderNo`/`referenceNo`) | UNVERIFIED |
| Refund | `refundOrder` | `{reference_no, refund_amount, refund_ref_no}` (`reference_no` = CCAvenue `tracking_id`). A repeated `refund_ref_no` is rejected, not de-duplicated; staging reportedly accepts one refund per order. No lookup by `refund_ref_no` exists, so after a timeout or a duplicate rejection check the order in the dashboard before retrying with a new ref | UNVERIFIED |
| Refund details | `getRefundDetails` | `{reference_no}` → `refund_list[]` with `refund_status` `TS-REFA`/`TS-REFC`/`TS-REFF`/`TS-REFD` (Odoo). Not implemented in this project | UNVERIFIED |

## Status mapping

| CCAvenue `order_status` | Unified |
|---|---|
| `Success` / `Shipped` | `captured` |
| `Failure` / `Unsuccessful` | `failed` |
| `Aborted` | `cancelled` |
| `Invalid` | `failed` |
| `Initiated` / `Awaited` | `pending` |
| `Refunded` / `Partially Refunded` (status API) | `refunded` / `partially_refunded` UNVERIFIED |

## Webhooks

Dashboard-configured "Dynamic Event Notification" (DEN, HTTP POST). Events: Order Status, Order Refund Status, Order Risk Status (official DEN page). Payload format and any signature are **not documented publicly**. This project parses only Order Status events sent as an `encResp` form body, marks them `bodyAuthenticated: false`, and `createWebhookHandler` re-confirms them with `orderStatusTracker`. Do the same: treat a DEN only as a trigger. UNVERIFIED

## Gotchas

- IP whitelist is the number-one go-live blocker (Vercel/Netlify/Lambda egress is not static).
- `redirect_url` receives a cross-site POST: SameSite cookies are missing; look up by `order_id`.
- Never use the decrypted `amount` alone to fulfil; compare to your stored amount and re-check via status API.
- Subscriptions (SI), settlements and payouts are reportedly in the API PDF. Not verifiable publicly.

## Sandbox test data

Test cards/netbanking are provided in the CCAvenue dashboard and kit docs. No public official URL found. UNVERIFIED

## Platforms

- Shopify: long listed as a provider in Shopify admin; no current App Store listing confirmed. UNVERIFIED
- WooCommerce/Magento/OpenCart: CCAvenue distributes plugins from the dashboard/its site. UNVERIFIED
