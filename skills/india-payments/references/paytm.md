# Paytm Payment Gateway

Docs moved to **https://paytmpayments.com/docs** and the hosts were rebranded. Status labels: VERIFIED / PARTIAL / UNVERIFIED.

## Hosts (keep configurable)

| Use | Staging | Production | Status |
|---|---|---|---|
| Initiate + JS checkout | `https://securestage.paytmpayments.com` | `https://secure.paytmpayments.com` | VERIFIED |
| Order status (`/v3/order/status`) | `https://securestage.paytmpayments.com` | `https://secure.paytmpayments.com` | VERIFIED (the `.in` staging host returned 503 for this route) |
| Refund apply + refund status | `https://securegw-stage.paytmpayments.in` | `https://securegw.paytmpayments.in` | VERIFIED in docs; production not exercised, confirm in sandbox |
| Legacy | `securegw-stage.paytm.in` | `securegw.paytm.in` | appears only in legacy docs |

Do not hard-code the legacy hosts. Test both staging hosts if one fails.

## Credentials

`MID`, merchant key (exactly **16 bytes**, used as the AES key), `websiteName` (`WEBSTAGING` in staging, `DEFAULT` in prod, or what the dashboard shows). VERIFIED
Env (this project): `PAYTM_MID`, `PAYTM_MERCHANT_KEY`, `PAYTM_WEBSITE` (optional; defaults WEBSTAGING / DEFAULT).

## Amounts

Rupee **string**, max 2 decimals, in `txnAmount.value` (`"499.00"`). VERIFIED

## Checkout flow (JS Checkout)

1. Server: `POST {host}/theia/api/v1/initiateTransaction?mid={MID}&orderId={ORDER}` with
   `{head:{signature, channelId?:"WEB"|"WAP"}, body:{requestType:"Payment", mid, websiteName, orderId (≤50), callbackUrl?, txnAmount:{value:"499.00", currency:"INR"}, userInfo:{custId, mobile?}}}`. `custId` allows only letters, digits and `@ ! = _ $ .` (this project replaces other characters with `_`).
   `head.signature` = checksum of `JSON.stringify(body)`. Response: `body.resultInfo.resultStatus` `S|F|U` and `body.txnToken` (**valid 15 minutes**). Verify the response `head.signature`. VERIFIED https://paytmpayments.com/docs/api/initiate-transaction-api
2. Client: `<script src="{host}/merchantpgpui/checkoutjs/merchants/{MID}.js">`, then
   `window.Paytm.CheckoutJS.init({root:"", flow:"DEFAULT", data:{orderId, token, tokenType:"TXN_TOKEN", amount}, handler:{notifyMerchant}}).then(() => window.Paytm.CheckoutJS.invoke())`. VERIFIED https://paytmpayments.com/docs/jscheckout-invoke-payment
3. Paytm POSTs **form key-value pairs** to `callbackUrl`: `ORDERID, MID, TXNID, TXNAMOUNT, STATUS (TXN_SUCCESS|TXN_FAILURE|PENDING), RESPCODE, RESPMSG, BANKTXNID, CHECKSUMHASH, …`. Verify CHECKSUMHASH, check ORDERID/TXNAMOUNT, then confirm with the status API. VERIFIED https://paytmpayments.com/docs/payment-status
4. The dashboard webhook URL receives the same form payload for payments. Same verification.
5. Refund notifications (Accept Refund / Success Refund) are JSON `{head:{signature}, body:{orderId, txnId, refId, refundId, refundAmount, totalRefundAmount, status:"SUCCESS"|"FAILED"}}`, signature over the raw `body` JSON. The documented FAILED refund notification has no signature, so this project rejects it: poll refund status for failures. VERIFIED (shape); signed-string convention PARTIAL

## Checksum algorithm

From the vendor's `paytm/Paytm_Node_Checksum` source. VERIFIED https://github.com/paytm/Paytm_Node_Checksum/blob/master/PaytmChecksum.js

- AES-128-CBC, IV = literal `"@@@@&&&&####$$$$"`, key = merchant key as-is (16 bytes).
- salt = base64 of 3 random bytes (4 chars). `hash = sha256hex(params + "|" + salt) + salt`; `signature = base64(AES(hash))`.
- params string: for JSON APIs, `JSON.stringify(body)`; for form callbacks, values sorted by key, joined with `|`, null → `""`, after removing `CHECKSUMHASH`.

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
const IV = Buffer.from('@@@@&&&&####$$$$');
const enc = (s: string, k: string) => { const c = createCipheriv('aes-128-cbc', Buffer.from(k), IV); return c.update(s, 'utf8', 'base64') + c.final('base64'); };
const dec = (s: string, k: string) => { const d = createDecipheriv('aes-128-cbc', Buffer.from(k), IV); return d.update(s, 'base64', 'utf8') + d.final('utf8'); };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export const paramsString = (p: Record<string, string | null | undefined>) =>
  Object.keys(p).sort().map((k) => (p[k] == null || p[k] === 'null' ? '' : String(p[k]))).join('|');

export function generateSignature(params: string, merchantKey: string) {
  const salt = randomBytes(3).toString('base64'); // 4 chars
  return enc(sha(`${params}|${salt}`) + salt, merchantKey);
}
export function verifySignature(params: string, merchantKey: string, checksum: string) {
  let plain: string;
  try { plain = dec(checksum, merchantKey); } catch { return false; }
  const salt = plain.slice(-4);
  const expected = sha(`${params}|${salt}`) + salt;
  return expected.length === plain.length && timingSafeEqual(Buffer.from(expected), Buffer.from(plain));
}
// JSON API:  head.signature = generateSignature(JSON.stringify(body), KEY)
// Callback:  const { CHECKSUMHASH, ...rest } = form; verifySignature(paramsString(rest), KEY, CHECKSUMHASH)
```

Note: the vendor library's object form skips the `CHECKSUMHASH` key and treats the literal string `"null"` as empty; mirror that exactly.

## Server APIs

| Purpose | Call | Status |
|---|---|---|
| Status | `POST https://secure(stage).paytmpayments.com/v3/order/status` `{head:{signature}, body:{mid, orderId, txnType?}}` → `resultStatus` ∈ `TXN_SUCCESS\|TXN_FAILURE\|PENDING\|NO_RECORD_FOUND`. resultCode 501 = server down (retry), 334 = invalid order id, 335 = invalid MID: these are errors, not a failed payment | VERIFIED https://paytmpayments.com/docs/api/v3/transaction-status-api |
| Refund | `POST https://securegw(-stage).paytmpayments.in/refund/apply` `{mid, orderId, refId (unique, ≤50), txnId (Paytm TXNID), txnType:"REFUND", refundAmount, preferredDestination?:"TO_INSTANT", comments?}`. A duplicate refId is rejected (617 / 671 / 626 / 629), not replayed: this project then returns the existing refund via refund status | VERIFIED https://paytmpayments.com/docs/refund-api/ |
| Refund status | `POST https://securegw(-stage).paytmpayments.in/v2/refund/status` `{mid, orderId, refId}`. 631 = record not found, 335 / 600 / 330 = request errors (not a failed refund) | VERIFIED |

JSON API responses carry `head.signature` over the raw `body` bytes: verify it when present (this project does; unsigned error responses are accepted on TLS alone). Business errors come back as HTTP 200 with `resultInfo.resultStatus` `F` / `TXN_FAILURE`: check `resultInfo`, not the HTTP status.

## Status mapping

| Paytm | Unified |
|---|---|
| `TXN_SUCCESS` | `captured` |
| `TXN_FAILURE` | `failed` |
| `PENDING` | `pending` |
| `NO_RECORD_FOUND` | `created` (or `unknown` if you expected a txn) |
| refund `TXN_SUCCESS` / `PENDING` / `TXN_FAILURE` | `processed` / `pending` / `failed` UNVERIFIED |
| `PAYMENTMODE` `CC`/`DC` / `NB` / `PPI` / `PAYTMCC` / `UPI` | `card` / `netbanking` / `wallet` / `paylater` / `upi` |

## Gotchas

- `txnToken` expires in 15 minutes: create it when the user clicks Pay, not on page load.
- `orderId` must be unique per attempt; ≤50 chars.
- Merchant key must be exactly 16 bytes or AES throws.
- `callbackUrl` gets a cross-site form POST; no session cookies. Exempt from CSRF; look up by ORDERID.
- `clientId` appears in callbacks if you have multiple keys.
- Subscriptions and settlement APIs exist in the docs nav; not verified here. Payouts are a separate product.

## Sandbox test data (UNVERIFIED in this research)

- Staging credentials and test wallet/cards: https://paytmpayments.com/docs/test-instruments (path may differ; find "Test Instruments" in the docs nav).

## Platforms

- Shopify: no official Paytm Shopify app found; Paytm wallet is reachable through other gateways (Razorpay, Cashfree). UNVERIFIED (absence)
- WooCommerce: Paytm publishes a WooCommerce plugin. UNVERIFIED listing.
- Mobile: Paytm "All-in-One SDK" for Android/iOS (invokes the Paytm app). UNVERIFIED details.
