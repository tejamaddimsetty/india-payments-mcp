# CCAvenue

There are **no public official API docs.** CCAvenue ships the integration kit and API PDFs inside the merchant dashboard (M.A.R.S.). Most facts below are UNVERIFIED: they match the PHP/Node/Java kits in circulation and third-party copies of the API PDF. Get the kit for **your** account from the dashboard and diff it against this file before shipping.

## Credentials and environment

- `merchant_id`, `access_code`, `working_key` (the AES secret). Dashboard > Settings > API Keys. UNVERIFIED path
- **IP whitelisting:** the server's public egress IP must be registered with CCAvenue before server API calls work. Serverless/auto-scaling hosts with changing IPs need a NAT gateway / static egress. Error `51407` = invalid access_code. PARTIAL
- The `access_code` is tied to the registered domain/URL; a mismatch fails checkout. UNVERIFIED

## Amounts

Rupee decimal, Numeric(12,2): `"499.00"`. PARTIAL

## Checkout flow (form POST, encrypted)

1. Server builds a plaintext query string: `merchant_id, order_id, currency=INR, amount, redirect_url, cancel_url, language=EN, billing_name, billing_email, billing_tel, …, merchant_param1..5`. UNVERIFIED
2. Encrypt it → `encRequest` (hex). Render an auto-submitting form to:
   - test `https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction`
   - prod `https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction`
   with fields `encRequest`, `access_code`. UNVERIFIED (Meta's WhatsApp CCAvenue guide shows prod `https://secure.ccavenue.com/transaction.do` for its UPI-intent flow.)
3. CCAvenue POSTs `encResp` (+ `orderNo`) to `redirect_url`. Decrypt → query string with `order_id, tracking_id, bank_ref_no, order_status (Success|Failure|Aborted|Invalid), amount, currency, payment_mode, …`. UNVERIFIED
4. Decryption succeeding is the only integrity check. **Always confirm with `orderStatusTracker` before fulfilling** and check amount + order_id.

## Encryption (classic kits)

AES-128-CBC, key = raw 16-byte `md5(working_key)`, IV = bytes `0x00..0x0f`, ciphertext hex. UNVERIFIED (no official public source; community kits agree). Some newer kits reportedly use AES-256-GCM; **no official evidence**. Default to CBC and ask CCAvenue which kit version your account uses.

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
- `version`: the old PDF says `1.1`; newer commands use `1.2`. `orderStatusTracker` with 1.2 is not confirmed: try 1.2, fall back to 1.1. UNVERIFIED
- Response: `status=0` + `enc_response` (decrypt with the same scheme); `status=1` = failure with message. UNVERIFIED

| Purpose | command | encrypted JSON | Status |
|---|---|---|---|
| Status | `orderStatusTracker` | `{order_no, reference_no}` (Meta guide shows `orderNo`/`referenceNo`) | UNVERIFIED |
| Refund | `refundOrder` | `{reference_no, refund_amount, refund_ref_no}` (`reference_no` = CCAvenue `tracking_id`) | UNVERIFIED |

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

Dashboard-configured "Dynamic Event Notification" (HTTP POST). Signature scheme **not documented publicly**. Treat it only as a trigger: on receipt, call `orderStatusTracker` and act on that result. UNVERIFIED

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
