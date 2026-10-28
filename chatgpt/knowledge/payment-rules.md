# Payment rules, test plan, go-live checklist

Applies to every Indian gateway (Razorpay, PayU, Cashfree, CCAvenue, Paytm, PhonePe, Stripe, Skydo). Each rule below prevents a real-money bug.

## Non-negotiable rules

1. **Amount from the server.** Price from server-side cart/plan data. The client sends an item or plan id, never an amount, currency or price.
2. **Integer paise internally.** `amount_paise BIGINT`. Convert only at the gateway edge: Razorpay/PhonePe/Stripe take paise; Cashfree takes rupees as a number (`10.15`); PayU, Paytm and CCAvenue take rupee strings with 2 decimals (`"499.00"`). No floats for money.
3. **Verify before fulfilling.** Paid only when the callback signature/hash verifies (constant-time compare) or, for unsigned returns (PhonePe, Cashfree, Stripe redirects; best practice also PayU and CCAvenue), the gateway status API says success, AND the order id and amount match your stored values. A redirect to a success page proves nothing.
4. **Webhooks are the source of truth.** Fulfil from the webhook too; browsers close. Read the raw body bytes before parsing, verify over those bytes, dedupe by event id with a unique constraint, process in a transaction, return 2xx quickly. 4xx for bad signature; 5xx only when your processing failed (so the gateway retries).
5. **Idempotent fulfilment.** Callback and webhook both arrive, sometimes at once. Use a guarded update (`... WHERE status IN ('created','pending')`) and fulfil only if a row changed.
6. **Unique orderRef per attempt.** PhonePe, Paytm, Cashfree and PayU reject or misbehave on reuse. One business order, many attempts (`ord_123_a1`, `ord_123_a2`). Gateway order creation is idempotent on that ref.
7. **Idempotent refunds.** Generate refundRef once, store it before calling the gateway, reuse it on every retry. Refund ≤ captured − already refunded. Live refunds need human approval. PayU refund token_id max 23 chars.
8. **Secrets server-only.** Key secret, salt, working key, merchant key, client secret, webhook secret: env/secret manager only. Never in client bundles, mobile apps, logs or git. `NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_`, `REACT_APP_` on a secret is a bug.
9. **Reconcile.** Scheduled job: attempts stuck in created/pending/authorized past N minutes → status API → same guarded transition. Daily settlement match.
10. **Pending UPI.** UPI can sit pending for minutes. Show "processing", never mark failed on a client timeout, do not allow a second payment while one is pending. Accept late successes (money was taken) and refund duplicates.
11. **No card data.** Use hosted checkout/SDKs. Storing PAN breaks PCI DSS and RBI tokenisation rules.
12. **Logs:** order ref, provider ids, status, amount. Never secrets, auth headers, card data.

## Signature cheat sheet

| Gateway | Callback | Webhook |
|---|---|---|
| Razorpay | hex HMAC-SHA256(`stored_order_id|payment_id`, key_secret); subscriptions reversed `payment_id|subscription_id` | `X-Razorpay-Signature` = hex HMAC-SHA256(raw body, webhook secret ≠ key secret); dedupe `x-razorpay-event-id` |
| PayU | reverse SHA-512 `SALT|status||||||udf5..udf1|email|firstname|productinfo|amount|txnid|key` (+ `additional_charges|` prefix) | same reverse hash; body JSON or form |
| Cashfree | none: re-fetch order | `x-webhook-signature` = base64 HMAC-SHA256(timestamp + raw body, client secret), no separator |
| CCAvenue | AES decrypt of `encResp` (cbc kit: no MAC, not authentication; gcm kit: auth tag); confirm via status API | undocumented: treat as trigger, re-fetch status |
| Paytm | `CHECKSUMHASH` (AES-128-CBC checksum over sorted values) | same, form POST |
| PhonePe v2 | none: Order Status API | `Authorization` = hex sha256(`username:password`), does NOT cover body: re-fetch status |
| Stripe | n/a (fulfil on webhook) | `Stripe-Signature` t,v1: hex HMAC-SHA256(`t.body`, whsec), check every v1, 300 s tolerance |
| Skydo | no API and no callback: status from the Zoho Books invoice Skydo marks paid, or from receipts you record in the ledger | none (Skydo emails/WhatsApps you) |

## Test plan

1. Mock mode (MCP server `PAYMENTS_MODE=mock`): create → mock complete success and failure → verify.
2. Sandbox with test keys and the gateway's documented test cards/UPI ids.
3. Webhooks: valid → 200 + paid; duplicate → no-op; tampered body → 400; handler throws → 5xx; out-of-order (refund before capture).
4. Unhappy paths: failed payment, user closes checkout, amount mismatch, callback for another order, duplicate callback, pending UPI that later succeeds, partial refund, refund retry with same refundRef.
5. Unit tests on verification and the state machine with signed fixtures; no network.

## Go-live checklist

- KYC done, live keys issued, required methods enabled (UPI, EMI, international, e-mandate are often off).
- Live keys only in the production secret store; mode set to live.
- Live webhook URL registered (separate from test), HTTPS, secret set, events subscribed.
- Raw-body verification works behind the production proxy/CDN.
- Dedupe table, guarded updates, reconciliation job with alerts.
- Razorpay auto-capture on (or capture implemented). Cashfree domain whitelisted. CCAvenue egress IP whitelisted.
- Refunds behind admin auth + audit log.
- One real low-value transaction end to end, then refunded.

## Things only the human can do

Merchant signup and KYC; get keys; register webhook URL + secret; enable payment methods; whitelist domain/IP; enable auto-capture; install the official Shopify app (Shopify needs no code and cannot take custom gateways); request a Stripe India invite; connect Skydo to Zoho Books or copy Skydo receiving-account details, and confirm Skydo receipts in its dashboard; approve live refunds.
