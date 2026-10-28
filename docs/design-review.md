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

**Revision.** The public API accepts **integer minor units only** (paise for INR, cents for USD) (`assertMinorUnits`, zod `int().positive()`). Every adapter converts at the boundary with `toMajorString` / `fromMajor`. Each capability map carries `providerAmountFormat`, so the difference is visible without reading code. PayU builds the form first and hashes the final field values. (`src/core/money.ts`, the adapters)

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

**Later revision (0.2.0).** Skydo still has no API, but its own Zoho Books integration and standing receiving accounts can be automated without touching Skydo. The adapter now creates Zoho invoices for Skydo's documented Zoho sync to pick up (whether it imports API-created invoices is confirmed per account during setup), or hands out account details with a local ledger, so create, verify and status are `partial`; everything else stays `unsupported`, and the adapter still never contacts Skydo. See [skydo.md](skydo.md).

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
- **Refund lookup-before-retry** (#3). After `OUTCOME_UNKNOWN` the caller must check status; automatic reconciliation (e.g. Razorpay `GET /payments/{id}/refunds` matched by receipt) is on the roadmap. *(Done in round 3, except PayU and CCAvenue, which have no lookup by refund reference.)*
- **HTTP transport hardening** (#16): no session expiry and no DNS-rebinding allow-list; the bearer token is the only control. Keep it on `127.0.0.1` behind a reverse proxy. *(Round 3 added idle-session eviction, a session cap, exact `/mcp` path matching and port validation; the DNS-rebinding allow-list is still open.)*
- **Paytm response signatures** are not verified (#17); responses come over TLS from the configured host. *(Now checked against `head.signature` when Paytm includes one; the signed-string format is unconfirmed, see Round 3.)*
- In-memory idempotency and dedupe stores are per process. Use shared stores (Redis/Postgres) when running more than one instance.

---

## Round 3

Two more adversarial reviews ran against the round 2 code, each with working reproductions against the real code (fake `fetch`, a stateful fake Zoho, real multi-process ledger writers): [round3-project.md](research/verification/round3-project.md) for the money-safety rules, MCP server, CLI and npm packaging, and [round3-skydo.md](research/verification/round3-skydo.md) for the Skydo bridge and ledger. **Every finding below is fixed**, with regression tests (623 tests in total).

### Money safety (round3-project.md)

| # | Severity | Finding | Revision |
|---|---|---|---|
| H1 | High | `paid` was `true` for payments that were only **authorised**, and Razorpay always reported `authorized` even when nothing was captured. This library has no capture API, and uncaptured authorisations lapse (Razorpay auto-refunds, Stripe after about 7 days). | `paid` = valid **and** status `captured` or `partially_refunded` **and** bound to `orderRef` + `expectedAmount`. `authorized` returns `paid: false` with a reason ("enable auto-capture"). Razorpay verify reports `captured` only when the order is fully paid (`status: paid` and `amount_paid >= amount`). |
| H2 | High | A Razorpay **partial payment** (`partial_payment`) verified as fully paid. | `partial_payment` and `first_payment_min_amount` are protected; verify and status require the order to be fully paid, otherwise `authorized` / `pending` with the paid amount in the reason. |
| H3 | High | The `providerOptions` guard was a top-level list with gaps: Cashfree `order_meta` (notify URL), Razorpay `transfers`, Stripe `capture_method` / `transfer_data` / `metadata.order_ref`, Paytm and PayU splits, and **no guard at all on subscriptions**. | Baseline list plus per-gateway `protectedOptionKeys` for payments **and** subscriptions, checked before any network call (list in [security.md](security.md#provider_options-guard)). The binding key is set after `input.metadata`, so metadata cannot override `order_ref`. |
| M1 | Medium | Fully refunded payments counted as paid, so replaying a Stripe success URL after a refund re-fulfilled. Cashfree never reported `refunded`. | `refunded` is not paid; webhook events for a refunded status are no longer `payment.succeeded`. Cashfree reads Get All Refunds for an order and reports `refunded` / `partially_refunded`. |
| M2 | Medium | A refund that ended in `OUTCOME_UNKNOWN`, or was rejected as a duplicate, could not be found again through the API, and the tool overstated idempotency. | The client looks the refund up by `refundRef` and returns it (Razorpay lists the payment's refunds, so it needs `providerPaymentId`). PayU error 106 becomes `OUTCOME_UNKNOWN` with a hint; PayU and CCAvenue cannot look up by reference, so the error stands. Tool text now says the cache is per process (24 h). |
| M3 | Medium | The mock gateway accepted what real gateways reject (missing ids, USD on INR-only gateways, refund webhooks the real adapter refuses) and summed settlements across providers. | Mock requires the same ids, is INR-only for PayU/Paytm/PhonePe, follows each gateway's duplicate-refund behaviour, refuses the same webhook simulations, verifies Skydo/Cashfree/PhonePe/Stripe by status lookup, and settles per provider and currency. |
| M4 | Medium | Webhook dedupe for unauthenticated bodies (PhonePe, CCAvenue) used an id built from the forged body, so a forged delivery could pre-empt a genuine event. | After status confirmation the dedupe id is rebuilt from confirmed data (order ref, confirmed status, payment id). |
| M5 | Medium | `createPayment` replayed cached checkout data (Paytm `txnToken`, 15 min) for 24 h. | `createPayment` idempotency TTL is 10 minutes. |
| M6 | Medium | npm packaging: no `prepublishOnly`, `require()` failed (`exports` had only `import`), source maps pointed at unshipped sources, no `homepage` / `bugs`. | All fixed: `prepublishOnly` runs typecheck, tests and build; `exports` has a `default` condition; no source maps in the build. |
| L1-L7 | Low | Skydo shown as `ERROR` when unconfigured; HTTP transport (no session eviction, `/mcpfoo` matched, port unchecked); missing `provider_payment_id` on `payments_get_status`; refund-status ids undocumented; inconsistent refund-webhook `status`; mock-in-production guard read `process.env`; PayU `unmappedstatus` not covered by the hash. | Skydo shows `not configured` with a setup hint; sessions evicted after 30 min idle, max 1,000, exact `/mcp` path, port validated; tool inputs and descriptions completed; refund webhooks set `status` only when the event can tell full from partial; the injected env is used; `unmappedstatus` can only downgrade a status. |

### Skydo (round3-skydo.md)

| # | Severity | Finding | Revision |
|---|---|---|---|
| N1 | High | Twin-invoice handling voided **both** invoices in a real race. | Every process picks the same winner (oldest numeric `invoice_id`) and voids only its own invoice, only if it lost. |
| N2 | High | The confirm gate for recording receipts was off in `sandbox`, the default mode, which for Skydo is real data. | Gated in every non-mock mode: "Skydo has no sandbox". |
| N3, N11 | High | `docs/skydo.md` and other docs were stale (Terms "§" numbers that do not exist, "guidance only", "paise", examples without `receipt_id`). | Docs rewritten from the code. Terms cited as clause 13(iv)(f) (scraping) and clause 11 (third-party applications). |
| N4, N5, N7, N12 | Medium | Generated code: two Zoho calls per poll per invoice, no daily-limit guidance, no polling in Fastify, a repeat `requestPayment` reset `fulfilled`, wrong mock checklist. | `providerOrderId` stored (one call per refresh); Zoho daily limits and 96 calls/day per open invoice documented; Fastify `startSkydoPolling`; fulfilled orders never reset; checklist uses the admin refresh route. |
| N6 | Medium | A partly written-off invoice (bank fees) was `failed`, "no money received". | `payment_made > 0` with a write-off is `pending` for review; fully written off stays `failed`. |
| N8 | Medium | A retried create returned the list record (no invoice link, `unknown` status). | The full invoice is read. |
| N9 | Medium | `zohoCustomerId` was not checked. | Must be an active contact of type customer. |
| N10, N20 | Medium | "Fully automatic" claimed for unconfirmed API-created invoice import; refund wording over-generalised. | Skydo documents Zoho invoice sync; API-created invoice import must be confirmed during setup. Refund note limited to what the FAQ says. |
| N13-N15 | Low | Ledger lock: synchronous wait froze the event loop, TOCTOU stale-lock breaking, no fsync, temp file leaked on rename failure. | Async wait (up to 15 s), owner token checked before unlocking, stale after 10 s and broken by rename, fsync before rename, temp file cleaned up. Documented: local disk only. |
| N16, N18 | Low | `received_at` accepted `"1"` and future dates; receipt ids were case-sensitive and per order. | ISO 8601 and not in the future; receipt ids compare case-insensitively and are unique across orders. |

### Accepted / remaining after round 3

- **No live sandbox runs.** No adapter has been run against a live gateway sandbox; tests use request/response shapes from the docs. `npm run sandbox:smoke` exists for contributors with test keys.
- **Paytm response signature format.** Verifying the signature on Paytm API responses (`PAYTM_VERIFY_RESPONSE_SIGNATURE`) depends on a format the public docs do not fully pin down; confirm in sandbox. Webhook signature checks do not depend on it.
- **Skydo API-created invoice import is unconfirmed.** Skydo documents syncing Zoho invoices, not API-created ones specifically. Each merchant confirms it with the first invoice during setup ([skydo.md](skydo.md#step-6-configure-and-check)).
- **CCAvenue details are third-party sourced.** CCAvenue publishes no public API reference; status and refund calls rely on integration kits and third-party implementations.
- **`confirm=true` is still an honour system.** It is mitigated by client approval prompts: refunds, cancellations and Skydo receipt recording carry `destructiveHint`, so clients that honour annotations ask the human first.
- **Per-process state.** The idempotency cache (create 10 min, refunds 24 h), webhook dedupe and HTTP sessions are in memory unless you inject shared stores; Zoho search lag can still leave two live twin invoices (no cross-process lock), which the docs explain how to void.
