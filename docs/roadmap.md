# Roadmap

Phases are ordered by what unblocks real production use first. Items move to the CHANGELOG when shipped. "Planned" in the capability maps (`not_implemented`) corresponds to items here.

---

## Phase 0: foundation (done, 0.1.0)

- [x] Unified types: integer minor units (paise for INR), `orderRef`, four checkout shapes, normalized statuses and webhook events
- [x] Capability model with four support levels, and fail-fast `UNSUPPORTED` / `NOT_IMPLEMENTED` before any network call
- [x] Adapters: Razorpay (full incl. customers, subscriptions, settlements), Stripe (core + customers, partial subscriptions and settlements), Cashfree, PayU, Paytm, PhonePe (core + refunds + webhooks), CCAvenue (core, partial status/refund, UNVERIFIED details flagged), Skydo (capability map and guidance; the adapter followed in 0.2.0)
- [x] Mock mode that keeps real capability maps, with signed callbacks and webhooks and a refundable-balance ledger
- [x] Safety rails: live-mutation double gate, refundRef idempotency, client idempotency with conflict detection, audit log, redacted stderr logging
- [x] HTTP client with timeouts, retry-safe-only retries, `Retry-After`, and error mapping
- [x] Webhook handler: verify → dedupe → handle, with correct status codes
- [x] MCP server: 17 tools, matrix and capability resources, `integrate_payments` prompt
- [x] stdio + Streamable HTTP transports (bearer auth), `doctor`, Docker image
- [x] Integration code generator, gateway recommender
- [x] Claude Skill, ChatGPT kit, examples, docs, CI

## Phase 0.5: verification and Skydo (done, 0.2.0)

- [x] Every adapter checked line by line against official docs; mismatches fixed (reports in `docs/research/verification/`)
- [x] `paid` requires `orderRef` + `expectedAmount`; Razorpay signs with the stored `providerOrderId`
- [x] CCAvenue AES-256-GCM kit (`CCAVENUE_ENCRYPTION=gcm`)
- [x] Skydo: Zoho Books bridge and receiving accounts + ledger, `payments_skydo_record_payment`, `payments_skydo_outstanding` (19 tools)
- [x] Sandbox smoke-test script (`npm run sandbox:smoke`) and stdio/HTTP end-to-end tests
- [x] Round 3 adversarial reviews fixed: `paid` only for `captured` / `partially_refunded`; Razorpay full-payment check; per-gateway `providerOptions` guard for payments and subscriptions; refund lookup by `refundRef` after `OUTCOME_UNKNOWN` or a duplicate; Cashfree refunded states; mock mirrors real input rules; webhook dedupe on confirmed data; Skydo twin invoices, ledger lock, receipt gate in sandbox; CJS-friendly `exports` ([design-review.md](design-review.md#round-3))

## Phase 1: production hardening (next)

- [ ] **Shared stores**: `RedisIdempotencyStore` (claim with `SET NX` before calling the gateway, which closes the in-process race), `RedisWebhookDedupeStore`, and Postgres equivalents. Ship as optional subpath exports so the core stays at two dependencies
- [ ] **Out-of-band approval for live refunds**: MCP elicitation or a signed approval token, plus per-order / per-day amount caps, so `confirm=true` is no longer an honour system
- [x] **Refund reconciliation after `OUTCOME_UNKNOWN`**: the client looks the refund up by `refundRef` (Razorpay `GET /payments/{id}/refunds` matched by receipt; Cashfree, Paytm, PhonePe, Stripe by their refund-status lookups). PayU and CCAvenue have no lookup by reference and still need a dashboard check
- [x] HTTP transport: idle-session eviction (30 min), session cap (1,000), exact `/mcp` path, port validation
- [ ] **HTTP transport hardening**: DNS-rebinding allow-list
- [ ] **OpenTelemetry**: spans per gateway call (`provider`, `op`, `status`, `attempt`) and metrics (latency, error codes, retries, blocked mutations), via an optional `telemetry` hook on `PaymentsClient`
- [ ] **Per-tool authorization for HTTP**: read-only vs mutating tokens, so an agent deployment can be structurally unable to refund
- [ ] **Refund rate limits**: a per-order / per-day ceiling configurable on the client
- [ ] **Run every adapter against its live sandbox** and record the results (none has been run yet). Then a CI workflow for `sandbox:smoke` (manual dispatch, environment secrets) per gateway
- [ ] CCAvenue: confirm the API version and field names with the official PDF, and whether DoWebTrans uses GCM for gcm-kit accounts. Implement refund status (`getRefundDetails`)

## Phase 2: money out and links

- [ ] **Payouts**: RazorpayX (`X-Payout-Idempotency`, fund accounts, IP allowlisting) and Cashfree Payouts v2. New feature tools `payments_create_payout` / `payments_get_payout_status`, with the live double gate, separate credentials, and a separate `PAYMENTS_ALLOW_LIVE_PAYOUTS` flag
- [ ] **Payment links**: Razorpay, Cashfree, PayU, PhonePe, Stripe. Unified `payments_create_payment_link` returning a URL + expiry
- [ ] Stripe Connect transfers (payouts to third parties) as a separate opt-in

## Phase 3: recurring everywhere

- [ ] **Cashfree subscriptions** (plans + subscriptions + mandate authorisation, pinned to one `x-api-version`)
- [ ] **PayU subscriptions** (Standing Instructions `si=1`, mandate APIs)
- [ ] PhonePe Autopay (UPI mandates), Paytm subscriptions
- [ ] Subscription lifecycle tools: pause/resume, fetch, list invoices. Pre-debit notification helpers where the gateway exposes them
- [ ] Stripe: resolve `cs_` → `sub_` ids automatically after Checkout completes

## Phase 4: reconciliation and settlements

- [ ] Settlements for Cashfree, PayU, Paytm, PhonePe
- [ ] `payments_reconcile` tool: date range → matched/unmatched captured payments, refunds, fees and settlements across gateways
- [ ] Settlement-level fee/tax breakdown (Razorpay recon API, Stripe balance transactions)
- [ ] Disputes/chargebacks: list and fetch evidence deadlines

## Phase 5: reach

- [ ] **Python SDK** (same types and capability JSON; generated from the TS capability maps to avoid drift)
- [ ] **Skydo API: switch when Skydo ships it.** Skydo announced developer APIs and webhooks in December 2025 with no date. When a public API exists, move create, status and refunds (if offered) to it and add webhook verification, keeping the Zoho Books bridge and ledger for existing users. Watch `developer.skydo.com` (an empty placeholder as of 2026-10-29) and Skydo's "What's new" blog
- [ ] Skydo ledger mode: import Skydo's Reports-tab export to match receipts automatically instead of recording them by hand (the export format is undocumented; confirm with a real account first)
- [ ] More frameworks in the code generator
- [ ] Hosted docs site generated from capability maps
- [ ] Additional gateways on request (for example Juspay/HyperCheckout, Easebuzz, Instamojo, BillDesk), subject to the same verification standard

## Not planned

- Handling raw card data in any form (PCI scope)
- Acting as a Shopify payments extension (partner-only platform)
- Unofficial / scraped APIs (for example a Skydo dashboard scraper)
