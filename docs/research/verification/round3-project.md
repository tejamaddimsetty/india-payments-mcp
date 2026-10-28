# Round 3: adversarial project review

Date: 2026-10-29. Scope: money-safety invariants through `PaymentsClient` (all gateways except Skydo internals), regressions from the round 1/2 fixes, the MCP server and CLI, and npm readiness. HEAD `d9c006a` plus an uncommitted working tree (24 files modified by another session while this review ran; findings are against the files as read).

Proof script: `/private/tmp/claude-501/-Users-tejamaddimsetty-Projects-talent-sourcer/39f056f2-10f8-4177-80f5-54a216018ed3/scratchpad/r3/proofs.mts`. Run it from the repo root with `npx tsx <path>`. It uses a fake `fetch`, so it makes no network calls.

## Baseline

| Check | Result |
|---|---|
| `npm run build` | OK |
| `npx tsc --noEmit -p tsconfig.json` | OK |
| `npm test` | 15 files, 589 tests, all pass |
| `node dist/cli.js --version` | `0.2.0` |
| `PAYMENTS_MODE=mock node dist/cli.js doctor` | 8 gateways listed as `mock` |
| `npm pack --dry-run` | 162 files: README, LICENSE, package.json and `dist/**` only. No tests, `.env`, scratch or stale dist files |
| Packed tarball installed in a clean dir | `npx india-payments-mcp --version` and `doctor` work; the stdio server answers `initialize` + `tools/list` (19 tools) |
| SDK consumer typecheck (`moduleResolution` NodeNext and Bundler, `skipLibCheck: false`) | OK; a mock create → complete → verify round trip runs (`paid: true`) |
| `require('india-payments-mcp')` from CJS (Node 22.13) | **Fails** with `ERR_PACKAGE_PATH_NOT_EXPORTED` (see M6) |
| simulateWebhook → parseWebhook, 7 gateways × 3 event types | All round-trip, except PayU refund (NOT_IMPLEMENTED) and CCAvenue refund (UNSUPPORTED), as documented |

## Findings, ranked

### HIGH

#### H1. `paid=true` for payments that are only authorised; Razorpay always reports `authorized`, even when nothing was captured

- `src/client.ts:284` counts `authorized` as settled. `src/providers/razorpay/adapter.ts:277-286` hard-codes `status: 'authorized'` for every signed callback. That happens right after the adapter has fetched the order (`:265`) and ignored `order.status` and `order.amount_paid`. Stripe maps `requires_capture` to `authorized` (`src/providers/stripe/adapter.ts:201-202`), and `verifyPayment` accepts it (`:538`).
- The library has no capture API at all.
- **Failure scenario.** A merchant's Razorpay account uses manual capture (a dashboard setting), or a Stripe PaymentIntent is created with `capture_method: 'manual'` (possible through providerOptions, see H3). `verifyPayment` returns `paid=true`. The merchant fulfils the order. Razorpay auto-refunds uncaptured payments after the capture window (round1 R71: 3 days), and a Stripe authorisation lapses after 7 days. The goods ship and no money is collected.
- This also contradicts the generated integration code: `src/codegen/templates/service.ts:252` fulfils only on `captured`.
- **Evidence.** In proof P1, the order has `status=attempted` and `amount_paid=0`, and the result is `{paid: true, status: "authorized"}`. In proof P5, a Stripe PaymentIntent in `requires_capture` gives `{paid: true, status: "authorized"}`.
- **Fix:**
  1. In the Razorpay order path, use the order the adapter already fetched: `status: order.status === 'paid' && order.amount_paid === order.amount ? 'captured' : 'authorized'`. When `orderRef` and `expectedAmount` are both absent, fetch `/payments/{id}` and use `mapRazorpayPaymentStatus`.
  2. In `client.ts:284`, drop `authorized` from `settled`. Return `paid: false` with `reason: 'Payment is authorised but not captured; capture it or enable auto-capture'`. Optionally add `capturePayment()`.
  3. Update `VerifyPaymentResult.paid` (`types.ts:136-140`), the README (line 230) and the `payments_verify_payment` description to match.

#### H2. A Razorpay partial payment verifies as fully paid

- `PROTECTED_PROVIDER_OPTIONS` (`src/client.ts:62-68`) does not include `partial_payment` or `first_payment_min_amount`. Razorpay then binds the amount with `order.amount !== input.expectedAmount` (`src/providers/razorpay/adapter.ts:263`), which compares the order total, not what was paid. `getPaymentStatus` (`:309`) also returns `amount: order.amount`.
- **Failure scenario.** An order is created with `providerOptions: { partial_payment: true, first_payment_min_amount: 100 }`. This can come from the developer, or from an agent through `payments_create_payment.provider_options`. The customer pays Rs 1. The signature is valid, `order.amount` equals `expectedAmount`, and the client returns `paid=true`.
- **Evidence.** Proof P2 shows the order body sent with `partial_payment: true`. With `amount_paid=100` of `49900`, the result is `{paid: true}`.
- **Fix:**
  1. Add `partial_payment` and `first_payment_min_amount` to the protected list.
  2. In `verifyPayment` and `getPaymentStatus`, require `order.amount_paid === order.amount` before reporting `captured`, and report `amount: order.amount_paid` (or the captured payment's `amount`).

#### H3. The providerOptions guard is a top-level deny-list with gaps: money routing, callback redirects, nested binding keys, and no guard at all on subscriptions

- `src/client.ts:62-68` and `:253-258` check only top-level keys, and only in `createPayment`. These keys pass through today (proof P4):
  - **Cashfree:** `order_meta` (`return_url`, `notify_url`). This redirects the customer and the webhooks, which is exactly what the comment at `client.ts:59-60` says must be impossible. `order_splits` (Easy Split to vendors) also passes.
  - **Razorpay:** `transfers` (Route: settles the payment to a linked account), `partial_payment` (H2).
  - **Stripe PaymentIntent flow:** `capture_method` (H1), `transfer_data`, `on_behalf_of`, `application_fee_amount`. `metadata.order_ref` is merged by `deepMerge` (`stripe/adapter.ts:263-271`) and overrides the binding key that `verifyPayment` reads (`:521`).
  - **Paytm:** `splitSettlementInfo`, `requestType`.
  - **PayU:** `splitRequest`.
  - **`client.createSubscription` (`client.ts:342-345`) has no check at all.** Stripe's `deepMerge` (`stripe/adapter.ts:981-995`) lets `success_url`, `cancel_url` and `line_items` (for example a cheaper price) through. Razorpay lets `plan_id` and `total_count` through (`razorpay/adapter.ts:513`).
- **Failure scenario.** A prompt-injected agent calls `payments_create_payment` with `provider_options.order_meta.notify_url = https://attacker/…` (Cashfree), or with `transfers` / `transfer_data` aimed at another linked or connected account. The amount checks still pass, so nothing flags the order.
- **Fix:**
  - Replace the global deny-list with a per-adapter policy: an exported `blockedProviderOptions: string[]` on each `ProviderModule`, checked in the client for both `createPayment` and `createSubscription`.
  - Minimum additions:
    - Cashfree: `order_meta`, `order_splits`.
    - Razorpay: `transfers`, `partial_payment`, `first_payment_min_amount`, `plan_id`, `total_count`.
    - Stripe: `capture_method`, `transfer_data`, `on_behalf_of`, `application_fee_amount`, `transfer_group`, `cancel_url`, `success_url`, `line_items`, `mode`, `subscription_data`, and any `metadata` key named `order_ref`, `subscription_ref` or `refund_ref`.
    - Paytm: `splitSettlementInfo`, `requestType`, `userInfo`.
    - PayU: `splitRequest`.
  - Better: let the MCP server accept only an allow-list of cosmetic keys (`expireAfter`, `flow`, `order_expiry_time`, `payment_method_types`, `ui` options), while the SDK keeps the escape hatch.
  - Fix the `payments_create_payment` description, which says "merged into the request" without warning.

### MEDIUM

#### M1. `paid=true` for fully refunded payments; Stripe redirects can be replayed after a refund

- `src/client.ts:284` also counts `refunded` and `partially_refunded` as settled.
- Stripe's return URL (`?session_id=cs_…`) is unsigned and reusable. After a refund, replaying it makes `verifyPayment` fetch the session and map it to `refunded` (`stripe/adapter.ts:185-186`), which gives `paid=true`.
- Cashfree is inconsistent with the other adapters: `getPaymentStatus` (`cashfree/adapter.ts:369`) reports `captured` for a `PAID` order even after a full refund, so Cashfree never shows `refunded`.
- **Failure scenario.** An order is refunded, cancelled and marked unpaid on the merchant side. The customer reopens the success URL. Merchant code that trusts `paid` (as the MCP description instructs: "Fulfil ONLY when paid=true") re-fulfils it.
- **Fix:**
  - `paid` = `valid && status ∈ {captured, partially_refunded} && bound`.
  - Add `refunded: boolean` and `amountRefunded` to the result instead.
  - For Cashfree, derive `refunded` / `partially_refunded` from `GET /orders/{id}/refunds`, or document the gap in the capability notes.

#### M2. A refund that ends in `OUTCOME_UNKNOWN` cannot be resolved through the API; the MCP description overstates idempotency

- `withIdempotency` stores only successes (`src/core/idempotency.ts:95-99`), so retrying the same `refundRef` sends a second POST (proof P3: 2 refund POSTs).
- Every gateway rejects or replays the duplicate, so no money moves twice:
  - Razorpay: "Duplicate receipt" (round1 R49).
  - PayU: error 106 "Token already exists" (`payu/adapter.ts:435-437`).
  - CCAvenue: duplicate `refund_ref_no` is rejected (round1 #46).
  - PhonePe: duplicate `merchantRefundId`; behaviour is not documented.
- However, Razorpay, PayU and CCAvenue surface the duplicate as `PROVIDER_ERROR` "refund rejected", which reads as a failure even though the refund exists. The caller then cannot find it:
  - Razorpay `getRefundStatus` requires `providerRefundId` (`razorpay/adapter.ts:357-359`).
  - PayU requires the `request_id` (`payu/adapter.ts:466-468`).
  - CCAvenue has no refund-status method.
- `payments_refund` says "re-sending it after a success returns the same refund" (`src/mcp/server.ts:231`). That is only true inside one process for 24 hours (`MemoryIdempotencyStore`). Only Paytm handles this case properly (`paytm/adapter.ts:500-505`).
- **Fix:**
  1. Razorpay: on a 400 "Duplicate receipt", call `GET /payments/{id}/refunds`, match `receipt === refundRef`, and return that refund. Let `getRefundStatus` take `providerPaymentId` + `refundRef` the same way.
  2. PayU: map error 106 to a lookup through `getPaymentStatus` / `check_action_status`, or return `OUTCOME_UNKNOWN` with a hint instead of "refund rejected".
  3. In `client.refund`, when the adapter throws `OUTCOME_UNKNOWN`, store a tombstone under the key. A later call should then get `OUTCOME_UNKNOWN` with "check refund status first" instead of a blind resend.
  4. Reword the tool description to say "within this server process".

#### M3. MockGateway has drifted from the real adapters

Proof P7 (`src/mock/mock-gateway.ts`) shows:

- `listSettlements` (`:276`) sums captured payments from every provider in the shared ledger. A Razorpay settlement included a PayU USD payment.
- `getPaymentStatus` (`:179`) works without `providerOrderId`, which real Razorpay and Stripe require (`razorpay/adapter.ts:290`, `stripe/adapter.ts:546`).
- `refund` (`:196`) works without `providerPaymentId`, which Razorpay, PayU, Paytm, CCAvenue and Stripe all require. It also returns the earlier refund on a duplicate `refundRef` (`:198`), where Razorpay, PayU and CCAvenue error.
- `createPayment` accepts USD on PayU, Paytm and PhonePe, and needs no `returnUrl` or customer. The real adapters reject all of these, so code that passes in mock mode fails in sandbox. That contradicts the class comment at `:31-34`.
- `client.simulateWebhook` (`client.ts:329-336`) skips capability checks, and mock mode simulates a PayU refund webhook that the real adapter refuses.
- **Fix:**
  - Filter settlements by `this.id`.
  - Give each `ProviderModule` an optional `validateInput(op, input)` hook (currency, required ids, `returnUrl`, customer fields). Run it in both mock and real mode, so the real adapters' checks also run in mock mode.
  - Make mock refund dedupe follow the provider's duplicate behaviour.

#### M4. Webhook dedupe ids for unauthenticated-body gateways come from the forged body, before status confirmation

- `src/webhooks/handler.ts:86-103` confirms PhonePe and CCAvenue events through the status API, but then dedupes on `event.id`. That id is built from unauthenticated body fields: PhonePe `${event}:${orderId}:${state}` (`phonepe/adapter.ts:507`), and CCAvenue `${tracking_id}:${order_status}`.
- **Failure scenario.** The PhonePe header is a static `sha256(user:pass)`, identical on every delivery. Anyone who has seen one delivery (logs, a proxy, a shared tunnel) can send a body that claims the id a genuine future event will carry, before the payment completes. The forged event is confirmed as `pending` and marked `done`, and the genuine `checkout.order.completed` is then dropped as a duplicate. The result is a missed fulfilment rather than a loss of money, so it is less severe than H1-H3.
- **Fix:** after confirmation, rebuild the id from confirmed data, for example `${provider}:${orderRef}:${confirmed.status}:${confirmed.providerPaymentId ?? ''}`.

#### M5. `createPayment` replays cached checkout data for 24 hours, after the checkout has expired

- `src/client.ts:261` uses `idempotencyKey ?? orderRef` with a 24-hour TTL.
- A retry, or an agent calling `payments_create_payment` again for the same `order_ref`, gets the stored result. That includes a Paytm `txnToken` that expires after 15 minutes (`paytm/adapter.ts:112`) and PhonePe `redirectUrl` / `expireAt` values.
- **Fix:** do not serve cached results past `result.expiresAt`. Either cap the TTL at `expiresAt - now`, or re-fetch on a cache hit when `expiresAt` has passed.

#### M6. npm packaging

1. **No `prepack` / `prepublishOnly` script** (`package.json:22-32`). `npm publish` ships whatever is in `dist/`, and right now the working tree has 24 uncommitted modified files. Fix: `"prepublishOnly": "npm run typecheck && npm test && npm run build"`, and publish from a clean tag.
2. **`exports` has only an `import` condition** (`package.json:9-14`), so `require('india-payments-mcp')` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` even on Node 22.12+, which supports `require(esm)`. Fix: `".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "default": "./dist/index.js" }`, plus `"./package.json": "./package.json"`.
3. **Source maps point at `../src/*.ts`, which is not shipped** (`tsconfig.json:15`, no `inlineSources`). Fix: set `"inlineSources": true`, or turn `sourceMap` off for the build.
4. **Missing `homepage` and `bugs` fields.** These are minor, but npm shows them.

### LOW

- **L1.** `doctor` and `payments_check_config` report Skydo as `ERROR: Skydo needs SKYDO_RECEIVING_ACCOUNTS…` when nothing is configured (`src/cli.ts:48-55`). Skydo has no required credentials, so `ready` is true and `gateway()` throws. Fix: treat `CONFIG_MISSING` from `create()` as "not configured".
- **L2.** HTTP transport (`src/cli.ts:81-104`):
  - Sessions are never evicted except on `onclose`. Any token holder can grow memory without limit by repeating `initialize`. Fix: add an idle TTL and a session cap.
  - `req.url?.startsWith('/mcp')` also matches `/mcpfoo`.
  - `MCP_HTTP_PORT` is not validated (`NaN` makes `listen` pick a random port).
- **L3.** `payments_get_status` (`server.ts:220`) does not expose `provider_payment_id`, although `PaymentStatusInput` has it.
- **L4.** `payments_get_refund_status` (`server.ts:262`) does not say which ids each gateway needs: Razorpay and PayU need `provider_refund_id`; Cashfree and Paytm need `order_ref`; Stripe needs `provider_refund_id` or `provider_payment_id`.
- **L5.** Normalised refund webhooks are inconsistent. Razorpay and Paytm set `status: 'refunded'` (proof P6); Cashfree, PhonePe and Stripe leave `status` undefined. Pick one rule.
- **L6.** The mock-in-production guard (`client.ts:136`) reads `process.env.NODE_ENV` even when the caller passes `opts.env`. SDK users who inject env objects get inconsistent behaviour.
- **L7.** The PayU response hash does not cover `unmappedstatus`. It is used in `mapPayuStatus` (`payu/adapter.ts:165-167`), so a tampered callback can flip `authorized` and `captured` for the same `success` status. This only matters once H1 is fixed (it would then flip `paid`). Fix: base the status on `status` alone for `paid`, or confirm through `verify_payment` when `unmappedstatus` is present.

## Checked and found sound

- **Callback-to-order binding:**
  - Razorpay binds on the receipt from the fetched order, and keeps order and subscription signatures from being swapped.
  - PayU, Paytm and CCAvenue check `txnid` / `ORDERID` / `order_id`.
  - Cashfree, PhonePe and Stripe use status-API lookups keyed by the caller's `orderRef`.
  - CCAvenue CBC results are re-confirmed through `orderStatusTracker` in the client.
- **Webhook signatures:** all verify against raw bytes with constant-time compares. Stripe has a 300-second tolerance; Cashfree has a 24-hour window; Paytm verifies refund JSON signatures always.
- **HTTP retries:** non-idempotent POSTs map network errors and 5xx to `OUTCOME_UNKNOWN`, which is not retryable. Refund POSTs are auto-retried only where the gateway dedupes: Cashfree (UUID key), Stripe (`Idempotency-Key`), Paytm (`refId` plus handling of codes 617/671/629), PhonePe (`merchantRefundId`).
- **New credentials:** `RAZORPAY_MERCHANT_NAME`, `CCAVENUE_ENCRYPTION` and `PAYTM_VERIFY_RESPONSE_SIGNATURE` are in the capability maps, so `config`, `doctor`, `credentialReport` and codegen pick them up. They are in `.env.example` (lines 58, 82, 93), and invalid values give `CONFIG_INVALID`. `PAYTM_VERIFY_RESPONSE_SIGNATURE=false` does not weaken webhook checks.
- **stdio:** the logger writes to stderr, so stdout carries only JSON-RPC. The HTTP transport requires a bearer token of 24+ characters, compared in constant time, and binds to 127.0.0.1 by default.
