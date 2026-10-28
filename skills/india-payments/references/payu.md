# PayU India

Docs: https://docs.payu.in · Hash: https://docs.payu.in/docs/generate-hash-payu-hosted · Environments: https://docs.payu.in/docs/payu-india-api-environment
Status labels: VERIFIED / PARTIAL / UNVERIFIED (test in sandbox).

## Auth and environments

- No API auth header. You hold a merchant `key` and a `salt`; every request carries a SHA-512 `hash` that includes the salt. The salt never leaves the server.
- Hosted checkout (form POST): test `https://test.payu.in/_payment`, prod `https://secure.payu.in/_payment`. PARTIAL
- Server APIs ("postservice"): test `https://test.payu.in/merchant/postservice.php?form=2`, prod `https://info.payu.in/merchant/postservice.php?form=2`. Some samples omit `.php`. `application/x-www-form-urlencoded` with `key, command, var1..varN, hash`. VERIFIED https://docs.payu.in/reference/verify_payment_api

## Amounts

Rupee decimal **string**, e.g. `"499.00"`. The exact same string must appear in the form and in the hash. Format from paise with integer math; never `String(4.99*100)`. PARTIAL

## Checkout flow (hosted, form POST)

1. Server: create attempt, `txnid = attemptRef` (unique per attempt, **max 25 chars**). Build fields `key, txnid, amount, productinfo, firstname, email, phone, surl, furl, udf1..udf5, hash`. Limits (enforced by this project): productinfo 100, firstname 60, email 50, udf1..udf5 255. The docs also list 50 for surl/furl; that looks stale, so this project only logs a warning. VERIFIED https://docs.payu.in (additional parameters)
2. Client: render an auto-submitting `<form method="POST" action="https://…/_payment">` with those fields. Nothing secret is in the form; the hash is.
3. PayU POSTs back (form-urlencoded) to `surl` or `furl`. That route is a server POST endpoint, not a SPA page. Exempt it from CSRF.
4. Server: verify the reverse hash, check `txnid` and `amount` match the stored attempt, then call `verify_payment` before fulfilling (PayU recommends this).
5. Webhook (dashboard-configured) also carries the reverse hash; process idempotently.

## Hashes

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
const sha512 = (s: string) => createHash('sha512').update(s).digest('hex'); // lowercase hex
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Request: key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT   VERIFIED
// Always keep all 5 udf slots (empty allowed), then 5 more empty fields, then SALT.
export function requestHash(f: Record<string, string>, salt: string) {
  const u = (k: string) => f[k] ?? '';
  return sha512([f.key, f.txnid, f.amount, f.productinfo, f.firstname, f.email,
    u('udf1'), u('udf2'), u('udf3'), u('udf4'), u('udf5'), '', '', '', '', '', salt].join('|'));
}

// Response (reverse): SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key   VERIFIED
// If the response has additional_charges, PREFIX "additional_charges|" before SALT.            VERIFIED
// The webhook field table spells it additionalCharges: accept both.
export function verifyResponse(r: Record<string, string>, salt: string) {
  const u = (k: string) => r[k] ?? '';
  let s = [salt, r.status, '', '', '', '', '', u('udf5'), u('udf4'), u('udf3'), u('udf2'), u('udf1'),
    r.email, r.firstname, r.productinfo, r.amount, r.txnid, r.key].join('|');
  const addl = r.additional_charges ?? r.additionalCharges;
  if (addl) s = `${addl}|${s}`;
  return eq(sha512(s), (r.hash ?? '').toLowerCase());
}

// Postservice: sha512(key|command|var1|SALT). ONLY var1 is hashed, even for refunds.   VERIFIED
export const postserviceHash = (key: string, command: string, var1: string, salt: string) =>
  sha512(`${key}|${command}|${var1}|${salt}`);
```

With split payments the response hash uses `status|splitInfo||||||` instead of `status||||||`. VERIFIED. With `api_version=19` the request hash adds udf6–10 and more fields; see the hash page. VERIFIED

## Server APIs

| Purpose | command | vars | Status |
|---|---|---|---|
| Verify / status | `verify_payment` | `var1=txnid` (pipe-separate several) → `{status:1\|0, msg, transaction_details:{<txnid>:{mihpayid, status, bank_ref_num, amt, mode, …}}}`; missing → `"Not Found"` | VERIFIED |
| Refund | `cancel_refund_transaction` | `var1=mihpayid` (PayU id, **not** txnid), `var2=token_id` (your unique refund id, **max 23 chars**), `var3=amount`. Cancels if `auth` (the id then comes back as `txn_update_id`), refunds if `captured` (`request_id`). Omitting the amount refunds the ORIGINAL amount: after a partial refund always pass the remaining amount | VERIFIED https://docs.payu.in/docs/refund-transaction-api |
| Refund status | `check_action_status`, `var1=request_id`. Two documented response shapes: nested `transaction_details.{request_id}.{request_id}.{status, amt}` and flat `{refund_status, refund_amount}`. `QUEUED` / `REQUESTED` / `IN PROGRESS` / `processing` / `od_hit` = pending. The sample curl says `check_action_status_txnid`; confirm in sandbox | VERIFIED (docs + official PHP SDK `checkRefundStatus`) |

## Status mapping

| PayU `status` | Unified |
|---|---|
| `success` (and `unmappedstatus: captured`) | `captured` |
| `pending` | `pending` |
| `failure` | `failed` |
| `auth` (unmappedstatus) | `authorized` |
| `userCancelled`/`dropped`/`bounced` (unmappedstatus) | `failed` or `cancelled` UNVERIFIED |

## Gotchas

- `token_id` for refunds is max 23 chars. A 40-char refundRef will be rejected: derive a shorter id (and store the mapping).
- Amount string mismatch (`"499"` vs `"499.00"`) breaks the hash silently.
- Reverse-hash field order is the reverse of the request and the 5 empties sit right after `status`, not after `udf5`.
- surl/furl receive a cross-site POST: SameSite=Lax session cookies are not sent. Look the attempt up by `txnid`, not by session.
- Webhook body format: docs disagree (JSON vs form-urlencoded). Accept both and verify the same reverse hash. PARTIAL. This project parses payment webhooks only; poll refund status instead of relying on refund webhooks.
- `txnid` max 25 chars; nothing in the key tells test from live, so make sure `PAYMENTS_MODE` matches the key.
- PayU rejects a reused refund token (error 106 "Token already exists") instead of returning the earlier refund: on `OUTCOME_UNKNOWN`, check refund status before retrying, and retry with a NEW refundRef. error_code 102 (queued) counts as accepted.
- Test-mode webhooks fire only for test transactions.
- Subscriptions: Standing Instructions (`si=1`, `si_details`) and mandate APIs exist. UNVERIFIED

## Sandbox test data (UNVERIFIED in this research)

- Test credentials (key/salt) come from the PayU dashboard in test mode. https://docs.payu.in/docs/test-cards-upi-id-and-wallets
- Test cards, test UPI ids and wallets are listed at the URL above; check it rather than trusting remembered numbers.

## Platforms

- Shopify: official apps "1PayU (Cards, UPI, NB, Wallet)" https://apps.shopify.com/payu-india and "Onsite Card Payments by PayU India"; configured with merchant key and salt. VERIFIED https://docs.payu.in/docs/install-payu-plugin
- WooCommerce: PayU publishes a WooCommerce plugin (search "PayU India" on wordpress.org). UNVERIFIED listing name.
