# Reliability

Payments fail in partial, ambiguous ways. A request times out *after* the gateway created the order. A UPI payment sits in `pending` for minutes. The webhook arrives before the customer's browser does. This document covers what the code does about that, and the playbooks for what it can't do for you.

---

## 1. Retries: only the safe ones

`src/core/http.ts` decides per request:

| Condition | Retried? |
|---|---|
| `GET` | Yes, always retry-safe |
| `POST` with `retrySafe: true`: the gateway de-duplicates by an idempotency header or a merchant-supplied unique id | Yes |
| Any other `POST` | **Never.** It fails with a hint: "The request may or may not have reached the gateway. Check payment status before retrying." |
| Error type: `NETWORK`, `TIMEOUT` | Retried if retry-safe |
| HTTP 429 (`RATE_LIMITED`), 5xx (`PROVIDER_UNAVAILABLE`) | Retried if retry-safe. `Retry-After` is honoured, capped at 10 s |
| 4xx business errors, 401/403, 404, 409 | Never |

Backoff: base 300 ms, doubled each attempt with jitter (between ½ and 1× the cap). Attempts are `PAYMENTS_MAX_RETRIES` (default 2) + 1.

Which POSTs adapters mark retry-safe:

| Gateway | Create payment | Refund | Other |
|---|---|---|---|
| Razorpay | No (orders aren't idempotent) | No | Customer create (`fail_existing: "0"`) and subscription cancel: yes |
| Cashfree | Only when you pass `idempotencyKey`, sent as `x-idempotency-key` | Yes (`refund_id`) | |
| Stripe | Yes (every POST sends `Idempotency-Key`, default `checkout_session:<orderRef>`) | Yes (`Idempotency-Key = refundRef`) | |
| PhonePe | No (a progressed `merchantOrderId` is BAD_REQUEST) | Yes (`merchantRefundId`) | OAuth token: yes |
| Paytm | No | Yes (`refId`) | Status: yes |
| PayU | n/a (form post, no API call) | No (de-duplication on `token_id` undocumented) | `verify_payment`: yes |
| CCAvenue | n/a (form post) | No (undocumented) | `orderStatusTracker`: yes |

`PaymentError.retryable` is `true` for `PROVIDER_UNAVAILABLE`, `NETWORK`, `TIMEOUT` and `RATE_LIMITED`. That means **retryable in principle**. For non-idempotent creates, check status first (§6).

## 2. Idempotency

Two layers:

1. **Client layer** (`withIdempotency`, all gateways). The key is scoped as `<provider>:<operation>:<key>`, and the request is fingerprinted (stable JSON, SHA-256).
   - `createPayment`: key = `idempotencyKey ?? orderRef`, kept **10 minutes**, because the cached result carries short-lived checkout data (Paytm `txnToken` lasts 15 min, PhonePe redirect URLs expire).
   - `refund`: key = `refundRef`, kept **24 h**. **refundRef is the idempotency key.**
   - Refund lookup: when the refund POST ends in `OUTCOME_UNKNOWN`, or the gateway rejects the `refundRef` as a duplicate, the client looks the refund up by `refundRef` (`getRefundStatus`) and returns it if it exists; a different amount gives `IDEMPOTENCY_CONFLICT`. Razorpay needs `providerPaymentId` for that lookup; Cashfree and Paytm use orderRef + refundRef, PhonePe refundRef, Stripe `providerPaymentId`. **PayU and CCAvenue cannot look a refund up by reference**, so there the original error is returned (PayU's "token already exists", error 106, is reported as `OUTCOME_UNKNOWN`).
   - Same key + same request → the stored result is returned and no gateway call is made. Same key + different request → `IDEMPOTENCY_CONFLICT`. **Failures aren't stored**, so a failed call can be retried with the same key.
   - `MemoryIdempotencyStore` holds 10,000 entries (oldest evicted first). It's **per-process and lost on restart.**
2. **Gateway layer**: the de-duplicating ids in the table above. These protect you even when the client store is cold, for example after a restart or across replicas.

**Production:** implement `IdempotencyStore` (`get` / `set(key, record, ttlSeconds)`) on Redis or Postgres and pass it as `new PaymentsClient({ idempotencyStore })`. Without it, two replicas behind a load balancer don't share refund de-duplication at the client layer. On PayU and CCAvenue, where the gateway layer is also absent, that's a real double-refund window. A shared store is on the [roadmap](roadmap.md).

Note: within one process, concurrent identical calls share one in-flight execution. Across processes the store itself must claim atomically: a Redis implementation should use `SET NX` to claim the key before calling the gateway.

## 3. Timeouts

- `PAYMENTS_HTTP_TIMEOUT_MS` (default 30,000) per HTTP attempt, enforced with `AbortController`. A timeout surfaces as `TIMEOUT`.
- The total worst case for a retry-safe call is about `(maxRetries + 1) × timeout + backoff`. With the defaults that's about 90 s. MCP clients may give up sooner. Lower the timeout (for example 10,000) for interactive agent use.
- Gateway-side expiries to plan around: Paytm `txnToken` lasts 15 min. PhonePe `expireAfter` is 300-3600 s. Stripe Checkout Sessions last 24 h by default. Cashfree orders have `order_expiry_time`. `createPayment` returns `expiresAt` where the gateway provides it.

## 4. Reconciliation jobs

Webhooks get lost, endpoints go down and statuses change after the fact. Run reconciliation; don't trust a single signal.

| Job | Frequency | What |
|---|---|---|
| **Pending sweeper** | every 5-15 min | For orders in `created` / `pending` / `authorized` (authorised is not paid: it must become `captured`) older than N minutes (and younger than the gateway's expiry), call `getPaymentStatus`. Advance state monotonically. Mark expired ones `expired` |
| **Refund sweeper** | hourly | For refunds in `pending`, call `getRefundStatus`. Alert on refunds pending more than 7 days, or the gateway's SLA |
| **Daily settlement recon** | daily | `listSettlements` for yesterday (Razorpay; Stripe via payouts). Match settled amount = Σ captured − refunds − fees − tax against your ledger. Investigate mismatches. For gateways where settlements are Planned, use dashboard reports |
| **Webhook gap check** | daily | Orders `captured` per status API with no corresponding webhook point to a broken endpoint or secret |

All of these are read-only and safe to run in `live` mode without `PAYMENTS_ALLOW_LIVE_MUTATIONS`.

Status API requirements: Razorpay needs `providerOrderId`, and Stripe needs the `cs_` / `pi_` id (mock mode enforces the same). Others look up by `orderRef`. Skydo and Infinity (Zoho bridge) cost one Zoho call with `providerOrderId`, two without; Zoho Books allows 1,000 (Free) to 10,000 (Premium and above) calls per day, and a 15-minute poll costs 96 calls a day per open invoice. **Persist `providerOrderId` and `providerPaymentId` next to `orderRef`.**

## 5. Observability

- **Logs**: JSON lines on stderr, at the level set by `PAYMENTS_LOG_LEVEL`. Each line includes `ts, level, msg, svc, provider`. HTTP lines (`http.response` at debug, `http.error` / `http.non_2xx` at warn) include `op`, `status`, `ms`, `attempt`, `requestId` and `willRetry`. Webhook rejections log `webhook.rejected`. Handler failures log `webhook.handler_failed`. Secret-looking keys are redacted.
- **Audit**: `PAYMENTS_AUDIT_LOG` JSONL (see [security.md §4](security.md#4-audit-log)) is your business-event trail.
- **Metrics**: there's no built-in metrics exporter yet. Two hooks work today:
  - pass a custom `logger` (the `Logger` interface) to `PaymentsClient` and count `http.non_2xx`, `http.error` and latency `ms` per `provider`/`op`.
  - pass a custom `auditSink` and emit counters per `action`/`outcome`/`errorCode`.
- Suggested alerts: `AUTH` errors (rotated or wrong keys), `SIGNATURE_INVALID` spikes (a secret mismatch or an attack), `blocked` outcomes (someone or something trying live refunds), p95 latency per gateway, and the sweeper backlog size.
- OpenTelemetry tracing is on the [roadmap](roadmap.md).

## 6. Failure playbooks

### Playbook: timeout on create

Symptom: `createPayment` returns `OUTCOME_UNKNOWN` (or `TIMEOUT` / `NETWORK` where the create is retry-safe), and the gateway may or may not have created the order.

1. **Don't** call create again with a new orderRef. You may end up with two live orders for one cart.
2. For gateways keyed by your `orderRef` (Cashfree, PhonePe, Paytm, PayU, CCAvenue), call `getPaymentStatus({ orderRef })`. If the order exists, reuse it. If `NOT_FOUND`, it's safe to create with the **same** orderRef.
3. For Stripe, retry with the same orderRef / `idempotencyKey`. The `Idempotency-Key` makes the gateway return the original Session.
4. For Razorpay, retry with the **same** orderRef. Razorpay rejects a second order with the same `receipt` as a duplicate, and the adapter then fetches the existing order by receipt and returns it if amount and currency match (otherwise the original error is thrown). Store the returned `providerOrderId`.
5. For Skydo or Infinity with the Zoho bridge, retry with the same orderRef: the adapter finds the existing invoice by reference and returns the full invoice. If a concurrent create made a twin, every process keeps the oldest `invoice_id` and voids only its own losing invoice.
6. A client-layer replay with the same key only returns a stored result if the first call **succeeded**. Failures aren't cached, so step 2 applies.

### Playbook: UPI payment pending

Symptom: verify/status returns `pending`. UPI collect requests can take minutes, and the customer may approve late.

1. Show "Payment processing", not "failed". Don't let the customer pay again for the same order without first checking status.
2. Wait for the webhook (`payment.succeeded` / `payment.failed`). The pending sweeper also polls status.
3. After the gateway's expiry, mark it `expired`. A late success after you marked it expired is a real success (money moved). Your state machine must accept `expired → captured`, then fulfil or refund.

### Playbook: webhook arrives before the redirect

Symptom: `payment.succeeded` is processed, and then the browser lands on the return URL and calls verify.

- This is normal. Make both paths idempotent on `orderRef` (`UPDATE … WHERE status <> 'paid'`). Whichever comes second is a no-op.
- The return page should show the order's **current** state from your DB, falling back to `verify` / `getPaymentStatus`. It shouldn't re-run fulfilment.

### Playbook: redirect arrives, webhook never does

- Verify with `payments_verify_payment` (signature or status API). Fulfil only when `paid` is true.
- Check the webhook is configured in the gateway dashboard, the secret matches, and your endpoint gets the raw body (`SIGNATURE_INVALID` in logs is the tell). Run the webhook gap check.

### Playbook: duplicate webhooks

- `createWebhookHandler` returns `200 {duplicate:true}` for a repeated event id. This needs a **shared** dedupe store across replicas.
- Different events with the same meaning (`payment.captured` + `order.paid`) have different ids, so fulfilment must be idempotent by `orderRef`.
- If your handler threw, the claim was released and the retry is processed. That's what you want.

### Playbook: refund returned an error, unclear if it happened

The client already tries step 1 itself after `OUTCOME_UNKNOWN` or a duplicate rejection, where the gateway supports a lookup by `refundRef`; if that lookup succeeds you get the refund back instead of an error.

1. Call `getRefundStatus` with the same `refundRef` (plus the ids the gateway needs: Razorpay `providerRefundId` or `providerPaymentId`; PayU `providerRefundId`; Cashfree/Paytm `orderRef`; Stripe `providerRefundId` or `providerPaymentId`).
2. If found, record it. If not found, retry `refund` with the **same** `refundRef`, never a new one. Gateways that de-duplicate on it (Cashfree, PhonePe, Paytm, Stripe) are safe; Razorpay rejects the duplicate and the client then finds the existing refund.
3. For PayU / CCAvenue, check `getPaymentStatus().amountRefunded` and the dashboard before retrying: PayU rejects a reused `token_id` (error 106, reported as `OUTCOME_UNKNOWN`) and CCAvenue a reused `refund_ref_no`, and neither can look a refund up by reference.

### Playbook: gateway outage

- `PROVIDER_UNAVAILABLE` / `TIMEOUT` across the board. Reads retry automatically. Creates don't.
- Fail over at the **checkout** level: offer a second gateway for new orders (`payments_recommend_gateway` and the capability map make this a config change). Never move an in-flight order to another gateway.
- Pause reconciliation alerts for that gateway, then run a catch-up sweep when it recovers.
