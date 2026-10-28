# Webhooks (deliverable G)

Webhooks are the only reliable signal for asynchronous outcomes: UPI collect approved minutes later, a refund reaching `processed`, a subscription charged at 3 a.m. Treat the browser redirect as a hint and the webhook (or a status fetch) as the truth.

The pipeline:

```
gateway ──POST──► your endpoint (raw body!) ──► client.parseWebhook(provider, {headers, rawBody})
                                                   │  verify signature / auth (adapter)
                                                   │  normalize -> NormalizedWebhookEvent
                                                   ▼
                                     createWebhookHandler: dedupe.claim(provider:event.id)
                                                   │  duplicate -> 200 {duplicate:true}
                                                   ▼
                                     onEvent(event)  ── throws ──► dedupe.release, 500 (gateway retries)
                                                   │
                                                   ▼
                                                  200
```

---

## 1. Per-gateway verification

| Gateway | What is verified | Secret | Body format | Dedupe `id` | Notes |
|---|---|---|---|---|---|
| Razorpay | `X-Razorpay-Signature` = hex HMAC-SHA256(raw body) | `RAZORPAY_WEBHOOK_SECRET` (**not** the key secret) | JSON | `x-razorpay-event-id` header, falling back to `event:entityId` | Verified against the exact raw bytes |
| Cashfree | `x-webhook-signature` = base64 HMAC-SHA256(`x-webhook-timestamp` + raw body), **no separator** | `CASHFREE_CLIENT_SECRET` | JSON | `x-idempotency-header` (or `x-idempotency-key`) when sent; otherwise built from the event type and payment/refund ids (refunds include the refund status) | Cashfree documents no replay window and retries at 2/10/30 min, so timestamps up to 24 h old (and up to 5 min in the future) are accepted; dedupe drops repeats. Auto-refund and `DISPUTE_CREATED` events are normalised |
| Stripe | `Stripe-Signature: t=..,v1=..`. HMAC-SHA256(`t + "." + raw body`), compared with **every** `v1` | `STRIPE_WEBHOOK_SECRET` (`whsec_…`) | JSON | `evt_…` | 300 s tolerance. Payloads use the endpoint's API version |
| PayU | Reverse SHA-512 hash in the body (same scheme as the surl/furl callback) | `PAYU_MERCHANT_SALT` | form-encoded **or** JSON (both accepted) | `mihpayid:status` | Payment events only. Refund webhooks aren't parsed, so poll refund status |
| Paytm | Payments: `CHECKSUMHASH` field (Paytm checksum over sorted values); `MID` must match. Refunds: `head.signature` over the JSON `body` | `PAYTM_MERCHANT_KEY` | form-encoded (payments), JSON `{head, body}` (refunds) | `TXNID:STATUS`, or `refund:REFID:<stage>` | The URL is set in the Paytm dashboard. The documented unsigned FAILED refund notification is rejected: poll refund status for those |
| PhonePe | `Authorization` header = hex SHA-256(`username:password`) | `PHONEPE_WEBHOOK_USERNAME` / `_PASSWORD` | JSON | `event:orderId\|refundId:state` | **Doesn't authenticate the body.** Always re-check with `payments_get_status` before acting |
| CCAvenue | Successful AES decryption of `encResp` with the working key (no signature exists; the cbc kit has no MAC, the gcm kit's tag authenticates) | `CCAVENUE_WORKING_KEY` | form-encoded (`encResp=...`) | `tracking_id:order_status` | Order Status events only. `bodyAuthenticated: false`; `createWebhookHandler` confirms with status |
| Skydo | n/a | n/a | n/a | n/a | Skydo has no webhooks; `payments_verify_webhook` returns `UNSUPPORTED`. Poll `payments_get_status` (Zoho bridge) or record receipts (ledger mode). See [skydo.md](skydo.md) |

A bad signature always throws `SIGNATURE_INVALID`. A missing webhook secret throws `CONFIG_MISSING`. `createWebhookHandler` maps both `SIGNATURE_INVALID` and `VALIDATION` to HTTP 400, so the gateway stops retrying a request that can never succeed. Everything else becomes 500.

### Gateways where the webhook alone isn't proof

For **PhonePe** (static header, body unsigned) and **CCAvenue** (no signature, only decryption), anyone holding the shared secret, or anyone who can replay an old `encResp`, can deliver a well-formed event. Treat these events as a *trigger* to call `payments_get_status`, and fulfil based on the status result:

```ts
onEvent: async (e) => {
  if (e.type !== 'payment.succeeded' || !e.orderRef) return;
  const s = await payments.getPaymentStatus(e.provider, { orderRef: e.orderRef, providerOrderId: e.providerOrderId });
  if (s.status === 'captured' && s.amount === expectedAmountFor(e.orderRef)) await fulfil(e.orderRef);
}
```

That pattern is cheap and correct for **every** gateway. Use it everywhere if you don't want per-gateway branches.

---

## 2. Normalized event types

| `type` | Meaning | Mapped from (examples) |
|---|---|---|
| `payment.succeeded` | Money captured | Razorpay `payment.captured`, `order.paid`. Stripe `payment_intent.succeeded`, `checkout.session.completed` (paid). PhonePe `checkout.order.completed`. Cashfree success. PayU / Paytm / CCAvenue success status |
| `payment.failed` | Attempt failed or cancelled | Razorpay `payment.failed`. Stripe `payment_intent.payment_failed`, `payment_intent.canceled`. PhonePe `checkout.order.failed` |
| `payment.pending` | In flight (UPI collect, bank processing) | Stripe `payment_intent.processing`. Pending statuses elsewhere |
| `payment.authorized` | Authorised, not captured | Razorpay `payment.authorized`. Stripe `payment_intent.amount_capturable_updated` |
| `refund.processed` / `refund.failed` | Refund final state | Razorpay `refund.processed`/`failed`. PhonePe `pg.refund.completed`/`failed`. Cashfree refund status |
| `subscription.activated` / `.charged` / `.halted` / `.cancelled` | Mandate lifecycle | Razorpay `subscription.*`. Stripe subscription events |
| `dispute.created` | Chargeback opened | Razorpay `payment.dispute.created`. Cashfree dispute events |
| `settlement.processed` | Payout to your bank | Razorpay `settlement.processed` |
| `unknown` | Verified, but not mapped | Anything else. `providerEventType` and `raw` carry the original |

An `unknown` event has **still passed verification**. Return 200 and log it. Don't 4xx it, or the gateway retries forever.

The exact mapping per gateway lives in each adapter's `parseWebhook`. The MCP tool `payments_verify_webhook` returns the same object.

---

## 3. Dedupe

Gateways deliver **at least once**. Duplicates are normal: retries after a slow 200, dashboard "resend", and several events for one payment (Razorpay `payment.captured` **and** `order.paid`).

- `createWebhookHandler` claims `"<provider>:<event.id>"` in a `WebhookDedupeStore` with a 7-day TTL by default (`dedupeTtlSeconds`). A repeat returns `200 {ok:true, duplicate:true}` without calling `onEvent`.
- If `onEvent` throws, the claim is **released** and the handler returns 500, so the gateway's retry is processed again.
- The default `MemoryWebhookDedupeStore` is per-process and lost on restart. In production, implement `WebhookDedupeStore` on Redis (`SET key 1 NX EX ttl`) or Postgres (`INSERT ... ON CONFLICT DO NOTHING`) shared by all instances.
- **Event-id dedupe isn't enough on its own.** Two *different* events can mean the same thing (`payment.captured` and `order.paid`). Make `onEvent` idempotent on your side, for example with a `UPDATE orders SET status='paid' WHERE order_ref=$1 AND status <> 'paid'` that only fulfils when a row actually changed.

## 4. Ordering

Gateways don't guarantee order. You can receive `refund.processed` before `payment.captured`, or `payment.failed` for attempt 1 after `payment.succeeded` for attempt 2 on the same order.

Rules:

1. **Never downgrade.** Model order state as monotonic: `created → pending → authorized → captured → partially_refunded → refunded`. Ignore a `payment.failed` for an order that is already `captured`. It belongs to a different attempt.
2. **Key on the payment, not just the order.** Store `providerPaymentId` per attempt. Several attempts per order are normal (UPI declined, then card succeeds).
3. **When in doubt, fetch.** `payments_get_status` returns the gateway's current view. Razorpay's status picks captured over authorised over latest across attempts.
4. **Use `occurredAt` for display, not for ordering decisions.** Clocks and retry delays make it unreliable for sequencing.

## 5. Retries and HTTP responses

| Your response | Gateway behaviour (typical) | Use when |
|---|---|---|
| 2xx | Delivered, stop | Processed, duplicate, or verified-but-uninteresting (`unknown`) |
| 400 | Most gateways retry anyway, then give up or disable the endpoint | Bad signature / malformed body (`SIGNATURE_INVALID`, `VALIDATION`) |
| 5xx / timeout | Retries with backoff for hours to days, depending on the gateway | Your handler failed (DB down) |

Respond quickly. Do the minimum inside the request (record the event, enqueue work) and return 200. Gateways time out slow endpoints, often within a few seconds, and then retry, which creates duplicates. If fulfilment is slow, write the event to a queue/outbox in `onEvent` and process it asynchronously.

Some gateways disable a webhook endpoint after repeated failures. Monitor your 4xx/5xx rate. Retry windows and disable thresholds vary by gateway and aren't encoded in this project. Check each dashboard.

---

## 6. Raw-body pitfalls by framework

Signatures are computed over the **exact bytes** sent. If anything parses and re-serializes JSON first (key order, whitespace, unicode escapes, number formatting), Razorpay, Cashfree and Stripe verification fails with `SIGNATURE_INVALID`, even with the right secret. For form-encoded gateways (PayU, Paytm, CCAvenue), pass the raw urlencoded string too. The adapter parses it.

| Framework | Correct | Common mistake |
|---|---|---|
| **Express** | `app.post('/webhooks/x', express.raw({ type: '*/*' }), h)` and `rawBody: req.body.toString('utf8')`. Register it **before** `app.use(express.json())`, or exclude this path from it | A global `express.json()` runs first, so `req.body` is already an object |
| **Next.js App Router** | `export async function POST(req: Request) { const rawBody = await req.text(); ... }` | Calling `await req.json()` and then `JSON.stringify` |
| **Next.js Pages Router** | `export const config = { api: { bodyParser: false } }`, then read the stream into a Buffer | Leaving the default body parser on |
| **Fastify** | `fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => done(null, body))` scoped to the webhook route, or the `fastify-raw-body` plugin | Default JSON parser |
| **NestJS** | `NestFactory.create(AppModule, { rawBody: true })`, then `req.rawBody.toString('utf8')` | Using the `@Body()` DTO |
| **Hono / Cloudflare Workers / Bun / Deno** | `const rawBody = await c.req.text()` (or `await request.text()`) | Reading the body twice (the stream is consumed) |
| **AWS Lambda + API Gateway** | `event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body` | Ignoring `isBase64Encoded` |
| **Behind a proxy / WAF** | Make sure nothing rewrites bodies (compression, charset normalization, JSON "beautifiers") | A WAF that re-encodes payloads |

Headers: pass them through as received. Lookup is case-insensitive, and array values use the first element. Node's `req.headers` can be passed directly.

---

## 7. Local testing with `payments_simulate_webhook`

`payments_simulate_webhook` produces a webhook **exactly as the gateway would sign it**, using your configured webhook secret, plus a ready-to-run `curl` if you pass `target_url`.

```text
You:     Simulate a Razorpay payment.succeeded webhook for ORD_1001, Rs 499, against http://localhost:3000/webhooks/razorpay
Claude:  (payments_simulate_webhook provider=razorpay type=payment.succeeded order_ref=ORD_1001 amount=49900 target_url=...)
         -> headers, rawBody, and a curl command. Run it and your handler should log payment.succeeded.
```

Notes:

- **Sandbox mode** uses the real scheme (Razorpay HMAC, Cashfree timestamped HMAC, Stripe `t=,v1=`, PayU reverse hash, Paytm checksum, PhonePe auth header, CCAvenue `encResp`). The gateway's webhook secret env var must be set.
- **Mock mode** uses a generic `x-mock-signature` (HMAC with a fixed mock secret) over a body that is already a `NormalizedWebhookEvent`. That's useful for agent flows, but it doesn't exercise the real signature code. Use sandbox mode for that.
- **Live mode** refuses with `LIVE_MUTATION_BLOCKED`. You should never be able to mint a validly signed production webhook with a tool.
- Supported types: `payment.succeeded`, `payment.failed`, `refund.processed`. PayU refuses `refund.processed` with `NOT_IMPLEMENTED`, because refund webhooks aren't parsed.
- Cashfree simulations carry the current timestamp. Replay them within 5 minutes, or the tolerance check rejects them, which is correct behaviour.
- Stripe simulations carry `t=` now. Replay within 300 s.

To receive **real** sandbox webhooks on localhost, expose your port with a tunnel (`cloudflared tunnel --url http://localhost:3000`, `ngrok http 3000`) and register that URL in the gateway's test dashboard. Stripe also offers `stripe listen --forward-to localhost:3000/webhooks/stripe`, which prints a `whsec_` secret to use as `STRIPE_WEBHOOK_SECRET`.
