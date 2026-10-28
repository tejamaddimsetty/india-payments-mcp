# Design review

The reviewer agent's critique of the 0.1.0 design. Each challenge records what was wrong or risky, the revision made, and where it lives in the code. "Accepted risk" means it was consciously left open.

---

## Round 1: architecture review

### 1. Order references differ per gateway

**Challenge.** Each gateway constrains merchant order ids differently: Razorpay `receipt` ≤ 40, Cashfree 3-45 of `[A-Za-z0-9_-]`, PhonePe ≤ 63 with only `_` and `-`, Paytm ≤ 50, and CCAvenue rejects many special characters. If each adapter validates independently, an orderRef that works on Razorpay fails on PhonePe at switch-over time, in production.

**Revision.** One regex for every gateway, at the orchestrator: `^[A-Za-z0-9_-]{3,40}$`, the **strictest common denominator**. It's applied to `orderRef` and `refundRef` in `PaymentsClient` and in the MCP zod schema. The error hint explains why. Gateway-specific tighter limits (PayU refund `token_id` ≤ 23) remain documented in constraints. (`src/client.ts` `ORDER_REF`, `src/mcp/server.ts` `ref`)

### 2. Several gateways don't sign the browser return

**Challenge.** PhonePe v2 and Cashfree redirect back with no signature, and Stripe's `session_id` is unsigned. A `verifyPayment` that only checks signatures would have to either reject them all or trust forged query strings.

**Revision.** `VerifyPaymentResult.verifiedVia` ∈ `signature | status_api | decryption`. For unsigned redirects, the adapter calls the gateway's status API server-side and compares orderRef and amount. PhonePe's verify feature is marked `partial`, because the redirect doesn't even carry the order id, so `orderRef` must be passed. (`src/core/types.ts`, the cashfree/phonepe/stripe adapters)

### 3. Duplicate refunds

**Challenge.** Refunds are the most dangerous operation an agent can perform. Agents retry on timeouts, and MCP clients re-send tool calls. Gateway-side de-duplication exists for some gateways (Cashfree `refund_id`, PhonePe `merchantRefundId`, Paytm `refId`, Stripe `Idempotency-Key`) but not, documentedly, for PayU or CCAvenue.

**Revision.** `refundRef` is **required** and **is the idempotency key** at the client layer (`withIdempotency` scope `<provider>:refund`). It's also sent to the gateway as its de-dupe id wherever one exists. Those calls are marked `retrySafe`, and the rest are never auto-retried. A different request under the same `refundRef` fails with `IDEMPOTENCY_CONFLICT` instead of silently returning the old result. (`src/client.ts` `refund`, `src/core/idempotency.ts`)

### 4. One flag isn't enough to protect live money

**Challenge.** A single `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` turns every agent conversation into one that can refund. A single per-call `confirm` can be set by a prompt-injected agent.

**Revision.** **Double gate.** In live mode, refunds and subscription cancellations need the operator's env flag **and** `confirm: true` on the call. Blocked attempts are audited as `outcome: "blocked"`. Both tools carry `destructiveHint: true` so MCP clients prompt. Webhook simulation is disabled outright in live mode. Docs state plainly that `confirm` isn't proof of human approval, and that client-side approval prompts are the real control. (`src/client.ts` `assertLiveMutationAllowed`, `docs/security.md`)

### 5. Mock mode would hide capability gaps

**Challenge.** A naive mock that "supports everything" lets a developer build a subscription flow on PayU in mock mode and discover it's unsupported only in sandbox or production.

**Revision.** `MockGateway` takes the **real** capability map of the gateway it stands in for, and `PaymentsClient.requireFeature` runs before the mock is reached. Mock callbacks and webhooks are HMAC-signed, so tamper and mismatch paths are exercised too. (`src/mock/mock-gateway.ts`, `src/client.ts`)

### 6. Webhook verification over parsed JSON

**Challenge.** The most common integration bug is verifying a signature against `JSON.stringify(req.body)`. If the API accepts a parsed object, developers will pass one.

**Revision.** `WebhookInput.rawBody` is a **string**, documented as "exact bytes received, never re-serialized". The MCP tool takes `raw_body`. Adapter error hints say "verify against the raw request body bytes". `docs/webhooks.md` has a per-framework raw-body table, and the README example uses `express.raw()`. (`src/core/types.ts`, `docs/webhooks.md`)

### 7. Cashfree takes rupees, not paise

**Challenge.** Cashfree's `order_amount` is a rupee decimal number, unlike Razorpay, PhonePe and Stripe. PayU, Paytm and CCAvenue want rupee *strings*, and PayU hashes that exact string. A mixed convention guarantees 100× bugs.

**Revision.** The public API accepts **integer paise only** (`assertMinorUnits`, zod `int().positive()`). Every adapter converts at the boundary with `toMajorString` / `fromMajor`. Each capability map carries `providerAmountFormat`, so the difference is visible without reading code. PayU builds the form first and hashes the final field values. (`src/core/money.ts`, the adapters)

### 8. PhonePe webhook auth doesn't cover the body

**Challenge.** PhonePe's documented webhook check is `Authorization: sha256(username:password)`, a static value that authenticates the sender's knowledge of a shared secret, not the payload. Anyone who observes one webhook can replay that header with any body.

**Revision.** Webhooks are marked `partial` for PhonePe. The constraint says to always confirm with `payments_get_status`. `docs/webhooks.md` prescribes the "event is a trigger, status is the truth" pattern for PhonePe and CCAvenue. The newer HMAC header scheme isn't guessed at, because its algorithm is undocumented. (`src/providers/phonepe/*`, `docs/webhooks.md`)

### 9. The in-memory idempotency store is per-process

**Challenge.** `MemoryIdempotencyStore` is lost on restart and not shared between replicas. That's an illusion of safety in exactly the deployments that need it most.

**Revision.** `IdempotencyStore`, `WebhookDedupeStore` and `AuditSink` are **interfaces** injected via `PaymentsClient` / `createWebhookHandler` options. The memory versions are defaults for development and single-process use. Docs (`reliability.md`, `architecture.md` §K) say to plug in Redis/Postgres before scaling out, and shared stores are Phase 1 on the roadmap. Gateway-side de-dupe ids give a second layer where they exist. (`src/core/idempotency.ts`, `src/webhooks/handler.ts`)

### 10. Money-moving POSTs retried on timeout

**Challenge.** A generic HTTP client that retries every 5xx/timeout will double-create orders and refunds.

**Revision.** Retries are opt-in per request: GETs always, POSTs only with `retrySafe: true`, which adapters set only when the gateway de-duplicates. Non-retry-safe timeouts carry the hint "may or may not have reached the gateway. Check payment status before retrying." (`src/core/http.ts`, reliability playbooks)

### 11. Agents get confused by features that "exist but don't work"

**Challenge.** "The gateway doesn't do X" and "we haven't wrapped X" need different responses from an agent: switch gateway, or use the dashboard / contribute.

**Revision.** Four support levels and two distinct error codes (`UNSUPPORTED` vs `NOT_IMPLEMENTED`) with different hints. `payments_list_providers` returns the levels so an agent can plan before calling. (`src/core/capabilities.ts`, `src/core/errors.ts`)

### 12. Payload swapping

**Challenge.** A valid Razorpay signature proves `payment ↔ order`, not `order ↔ your cart`. An attacker can complete a ₹1 order and submit its signed payload against a ₹50,000 cart.

**Revision.** `verifyPayment` accepts `orderRef` and `expectedAmount`. Razorpay fetches the order and checks `receipt` and `amount`. The other adapters compare against signed, decrypted or fetched data. The MCP tool describes `order_ref` as "strongly recommended". (`src/providers/razorpay/adapter.ts`, `src/core/types.ts`)

### 13. Secrets leaking through tools and logs

**Challenge.** A config "doctor" tool, verbose `raw` responses and debug logs are three easy ways to leak keys to an LLM transcript.

**Revision.** `check_config` returns env var names only. `raw` is stripped from MCP output unless `include_raw` is set. The logger writes to stderr with key-based redaction, applied to the audit log too. Checkout options contain publishable values only. (`src/core/config.ts`, `src/core/logger.ts`, `src/mcp/server.ts`)

### 14. Skydo is in the list but has no API

**Challenge.** Including Skydo invites agents to hallucinate an integration.

**Revision.** Skydo has a full capability map with every feature `unsupported` and guidance in the notes. Its adapter throws `UNSUPPORTED` as a second line of defence. The recommender surfaces it only for `exporter_collections` and suggests pairing it with an API gateway. (`src/providers/skydo/*`)

### 15. Key/mode mismatches

**Challenge.** Running `PAYMENTS_MODE=sandbox` with live keys moves real money while everyone believes it's a test.

**Revision.** Adapters validate key prefixes where the format allows (Razorpay `rzp_test_` / `rzp_live_`) and throw `CONFIG_INVALID`. `doctor` and `check_config` instantiate adapters and surface `initError`. Where keys aren't distinguishable (PayU, CCAvenue), the capability constraints say so. (`src/providers/razorpay/adapter.ts`, `src/cli.ts`)

### Accepted risks after round 1

- **`valid` semantics differed by gateway** (Cashfree/Stripe meant "paid", others meant "authentic"). **Fixed:** `valid` now means authentic + matching everywhere, and `PaymentsClient.verifyPayment` adds a single `paid` flag to fulfil on.
- **In-process idempotency race.** **Fixed:** concurrent identical calls in one process now share one in-flight execution. Across processes the store must be atomic (Redis `SET NX`), which is planned.
- **One bearer token for the HTTP transport.** There's no per-tool or per-user authorization. Mitigated by deployment guidance. Read-only tokens are planned.

---

## Round 2: final code review

An independent reviewer agent attacked the finished code with working proofs of concept. Every attack it proved is now a test in `test/security-regressions.test.ts`.

| # | Severity | Finding | Revision |
|---|---|---|---|
| 1 | Critical | **Razorpay signature confusion.** Order and subscription signatures share a key with the fields reversed, so a genuine `{order_id, payment_id, sig}` replayed as `{payment_id: order_id, subscription_id: payment_id}` verified as a captured subscription payment, with no order/amount binding. | Strict `pay_`/`order_`/`sub_` prefixes. The subscription branch fetches the subscription and the payment from Razorpay and binds `subscription_ref` and amount. |
| 2 | Critical | **CCAvenue cut-and-paste.** AES-CBC has no MAC: splicing blocks of a genuine *Success* response onto another order's *Aborted* response decrypted to "order B, Success". | `PaymentsClient.verifyPayment` never trusts `verifiedVia: "decryption"`: it confirms with the status API. CCAvenue webhooks carry `bodyAuthenticated: false`. Capability notes corrected. |
| 3 | High | **Refund after timeout could run twice.** A timed-out non-idempotent POST was reported as `TIMEOUT, retryable: true`. | New `OUTCOME_UNKNOWN` (not retryable) for timeouts, network errors and 5xx on non-idempotent POSTs. Tool descriptions say "look it up before retrying". Wording "never refunds twice" removed. |
| 4 | High | **Webhook re-confirmation kept the forged event type** (PhonePe/CCAvenue body says success, status API says failed, `onEvent` got `payment.succeeded`). | `createWebhookHandler` recomputes `type` from the confirmed status. |
| 5 | High | **`paid` without binding.** A genuine callback for a cheap order returned `paid: true` when the caller omitted `orderRef`/`expectedAmount`. | `paid` requires both. MCP `payments_verify_payment` makes `order_ref` and `expected_amount` required. |
| 6 | Medium | **Webhook lost in a dedupe race.** A retry during processing got `200 duplicate`; if the first delivery then failed, the gateway stopped retrying. | Dedupe store has `claimed / in_progress / done`. In-progress duplicates get 409 so the gateway retries. |
| 7 | Medium | HTTP timeout did not cover reading the body. | Timer stays armed until the body is read. |
| 8 | High | Docs and tool text said "fulfil on `valid`". | Everywhere now says "fulfil only on `paid`". |
| 9 | Medium | Razorpay webhook `orderRef` came from `payment.notes`, which the browser can set. | `orderRef` comes only from the order receipt (`order.paid`). Notes are no longer sent to Checkout. Generated code falls back to `providerOrderId`. |
| 11 | Medium | Mock mode used a hard-coded public secret. | Random secret per process; mock refuses to start with `NODE_ENV=production` unless `PAYMENTS_ALLOW_MOCK_IN_PRODUCTION=true`. |
| 12 | Medium | `payments_simulate_webhook` built a curl string with an unescaped URL. | All curl parts shell-quoted; tool text warns never to reuse sandbox webhook secrets in production. |
| 13 | Medium | `providerOptions` could override the validated amount, order id or redirect URLs. | `PaymentsClient` rejects protected keys before calling the adapter. |
| 14 | Medium | Razorpay partially refunded payments mapped to `captured`; PayU/Cashfree/CCAvenue "full refund" after a partial one uses the original amount. | Razorpay mapping fixed. The other three document "pass the remaining amount explicitly". |
| 15 | Low | HTTP 409 was mapped to `IDEMPOTENCY_CONFLICT`, confusing provider conflicts with SDK ones. | 409 is now `PROVIDER_ERROR` with the provider's code. |
| 17 | Low | Non-numeric `PAYMENTS_HTTP_TIMEOUT_MS` became `NaN`. | Numeric env vars are validated (`CONFIG_INVALID`). |

**Accepted, documented, not fixed in 0.1.0**

- **`confirm=true` is an honour system** (#10). The agent can set it. The real control is the MCP client's per-call approval for tools marked `destructiveHint`. Out-of-band approval tokens / MCP elicitation and amount caps are on the roadmap.
- **Refund lookup-before-retry** (#3). After `OUTCOME_UNKNOWN` the caller must check status; automatic reconciliation (e.g. Razorpay `GET /payments/{id}/refunds` matched by receipt) is on the roadmap.
- **HTTP transport hardening** (#16): no session expiry and no DNS-rebinding allow-list; the bearer token is the only control. Keep it on `127.0.0.1` behind a reverse proxy.
- **Paytm response signatures** are not verified (#17); responses come over TLS from the configured host.
- In-memory idempotency and dedupe stores are per process. Use shared stores (Redis/Postgres) when running more than one instance.
