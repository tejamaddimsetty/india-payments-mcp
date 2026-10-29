# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Before 1.0, minor versions may contain breaking changes.

## [Unreleased]

## [0.4.1] - 2026-10-30

No code changes; package metadata and README only.

### Changed

- npm description and keywords now include Dodo Payments and Infinity (plus `zoho-books`, `payment-gateway`).
- README: npm version, downloads, CI and licence badges, and a link to the npm package.

## [0.4.0] - 2026-10-29

### Fixed

- Shopify code generation treated a "No ... app" / "Not usable ..." plugin note as an official app (Paytm, Stripe). It now says there is none and generates no reconciliation server for gateways without an app (`hasShopifyApp`).

### Added

- **Dodo Payments adapter** (provider id `dodo`): Merchant of Record for digital products. See [docs/dodo.md](docs/dodo.md); facts with sources in [dodo-api-facts.md](docs/research/dodo-api-facts.md).
  - Payments: hosted Checkout Session (`POST /checkouts`) for a product created in Dodo (`providerOptions.productId` or `DODO_PAYMENTS_DEFAULT_PRODUCT_ID`). The product is read first: a fixed price must equal `amount` in `currency`; pay-what-you-want products take `amount`. `metadata` carries `order_ref` and the expected amount and currency.
  - Verification: the unsigned `return_url` redirect is re-read with `GET /checkouts/{id}` and `GET /payments/{id}`. It requires `providerOrderId`: the payment must belong to the checkout session we created (anyone can attach our `order_ref` to a payment of their own via static-link metadata), then `order_ref`, amount and currency must match. Tax Dodo adds on top of a tax-exclusive price still matches. Sessions turn off discount codes and currency selection, which Dodo enables by default.
  - No API idempotency key: POSTs are never retried (`OUTCOME_UNKNOWN`), and refunds first look for an existing refund with the same `refund_ref`.
  - Refunds (full, or one partial item in the payment currency), refund status, Standard Webhooks (checked against the reference test vector and the official `standardwebhooks` library), customers, subscriptions for recurring products (checkout + `PATCH` cancel), payouts as settlements.
  - Key-prefix cross-check (`dodo_test_` in sandbox, `dodo_live_` in live), protected `providerOptions` (cart, customer, currency, discounts, saved-method charges, feature flags), Dodo metadata limits, mock-mode parity (product id and status-lookup rules).
  - Code generator profile (redirect return, webhook events, dashboard checklist).
- Generated code (every gateway): the payment callback now passes the stored `providerOrderId` to `verifyPayment`. For Dodo, the generated webhook handler also ignores events whose session or currency differ from the stored order.
- `standardwebhooks` (dev dependency) to test the Dodo webhook verifier against the official library.
- Independent line-by-line check of the adapter against Dodo's official docs ([dodo-doc-verification.md](docs/research/verification/dodo-doc-verification.md)) and an adversarial review ([dodo-review.md](docs/research/verification/dodo-review.md)).

## [0.3.0] - 2026-10-29

### Added

- **Infinity adapter** (infinityapp.in, provider id `infinity`). Infinity publishes no API docs or webhooks, and its Terms forbid reverse engineering, so the adapter never contacts Infinity. See [docs/infinity.md](docs/infinity.md) and the sources in [infinity-api-search.md](docs/research/verification/infinity-api-search.md).
  - Zoho Books bridge (`INFINITY_ZOHO_*`, separate from Skydo's `ZOHO_*`) for Infinity's Zoho Books integration (dashboard Connect tab). It uses the same bridge code as Skydo: an invoice counts as paid only when Zoho payments cover the total. What Infinity syncs is undocumented, so confirm with one real invoice.
  - Bank transfer (`INFINITY_RECEIVING_ACCOUNTS`) and QuickLinks (`providerOptions.quickLinkUrl`). Only `https` links on `INFINITY_QUICKLINK_HOSTS` (default `infinityapp.in` and subdomains), with no credentials or port, are accepted. One link per order; `INFINITY_QUICKLINK_ONLY=true` for link-only use.
  - Ledger with idempotent receipts, the same rules as Skydo's ledger mode. Recording is gated in the MCP server in `sandbox` and `live` (Infinity documents no sandbox).
  - `currency` required and INR rejected in every mode, including mock. No minimum is documented, so none is enforced.
- MCP tools `payments_infinity_record_payment` and `payments_infinity_outstanding` (21 tools), and SDK methods `PaymentsClient.infinityRecordPayment` and `infinityOutstanding`.
- Integration code generator for Infinity (Express, Fastify and Next.js; admin-only invoice and receipt routes; Zoho polling) and `docs/INFINITY_PAYMENTS.md`.
- Recommender: `exporter_collections` ranks Skydo first, then Infinity.
- Adversarial review of Infinity ([infinity-review.md](docs/research/verification/infinity-review.md)): no critical or high findings. The medium and low findings are fixed with regression tests: no QuickLink in Zoho mode, no new link on a paid or cancelled order, gateway-tagged ledger files, `INFINITY_ZOHO_*` names in Zoho error hints, `INFINITY_QUICKLINK_ONLY` exclusive, exact-or-`*.` host matching without IPs or public-suffix wildcards, the same link check in mock mode, and no 10-minute create cache for Infinity (its ledger and Zoho lookup are idempotent already).

### Changed

- Ledger files now record the owning gateway (`"provider"`). An untagged file written by 0.2.0 is read as Skydo's, and a file that belongs to another gateway is refused with `CONFIG_INVALID`, so Skydo and Infinity can never share one.
- Skydo's ledger, receiving-account and Zoho Books code moved to `src/providers/shared/` (`ledger.ts`, `accounts.ts`, `manual-collections.ts`, `zoho.ts`, `zoho-bridge.ts`) and is now shared by Skydo and Infinity. Skydo's behaviour and messages are unchanged (all 57 Skydo tests pass unmodified, and a before/after run of 28 ledger steps, 9 config errors and 4 Zoho scenarios matched, including every HTTP request); the old `src/providers/skydo/{ledger,accounts,zoho}.ts` paths re-export the shared modules.
- The live-mutation gate applies in `sandbox` to every gateway without a sandbox (Skydo, Infinity).

## [0.2.0] - 2026-10-29

### Added

- **Skydo adapter** (previously guidance only). Skydo still has no public API, so the adapter never contacts Skydo; it automates the two paths Skydo supports. See [docs/skydo.md](docs/skydo.md).
  - Zoho Books bridge (`ZOHO_DATA_CENTER`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ORGANIZATION_ID`, `ZOHO_ITEM_ID`, optional `ZOHO_ACCOUNTS_URL`): creates a Zoho Books invoice per order (idempotent on `reference_number` = orderRef), marks drafts sent, and reads back the status that Skydo sets, including whether the FIRA is attached.
  - Zoho data centers: com, eu, in, com.au, jp, ca, com.cn, sa, ae, uk, sg. Invoice lookup is exact and paginated, and an existing invoice is returned as the full record (invoice link and payment fields). When concurrent processes both create an invoice, every process keeps the oldest `invoice_id` and voids only its own losing invoice. A draft left by a failed attempt is marked sent on retry. `zohoCustomerId` must be an active contact of type customer.
  - A Zoho invoice counts as paid (`captured`) only when payments cover the total: a full write-off reports `failed`, a partial write-off after a real payment `pending` (for review), credit-note closures `unknown`. An invoice whose `reference_number` is not the orderRef is refused.
  - Receiving accounts + ledger (`SKYDO_RECEIVING_ACCOUNTS`, `SKYDO_PAYEE_NAME`, `SKYDO_LEDGER_FILE`): bank-transfer instructions per currency (with a `"*"` fallback) and a persistent JSON ledger of expected payments. Every change takes an owner-checked file lock (asynchronous wait up to 15 s, stale after 10 s), re-reads the file and fsyncs before the atomic rename, so an app and the MCP server can share it on a local disk.
  - Receipts are idempotent per `receiptId` (MCP: `receipt_id`, required), compared case-insensitively and unique across orders; `receivedAt` must be ISO 8601 and not in the future. Recording a receipt is behind the live-mutation gate in the MCP server (`PAYMENTS_ALLOW_LIVE_MUTATIONS` + `confirm`) in `sandbox` as well as `live`, because Skydo has no sandbox.
  - `createPayment`, `verifyPayment` and `paymentStatus` are now `partial` for Skydo. Refunds, webhooks, customers, subscriptions, settlements, payouts and payment links stay unsupported.
  - Skydo rules enforced in `PaymentsClient` (and so in mock mode too): `currency` is required, INR is rejected, USD payments must be at least USD 50. Other currencies get a reminder about the USD 50 equivalent, and GBP orderRefs over 18 characters a warning about truncated UK references.
- MCP tools `payments_skydo_record_payment` and `payments_skydo_outstanding` (19 tools in total), and SDK methods `PaymentsClient.skydoRecordPayment` and `skydoOutstanding`.
- `verifiedVia: "manual_record"` for results read from the Skydo ledger.
- `providerOrderId` on `verifyPayment` (MCP: `provider_order_id`): Razorpay now computes the signature with the `order_…` / `sub_…` id you stored, never the id the browser sends.
- Credentials: `RAZORPAY_MERCHANT_NAME` (Checkout `name`, which Razorpay marks mandatory), `CCAVENUE_ENCRYPTION` (`cbc` or `gcm`) and `PAYTM_VERIFY_RESPONSE_SIGNATURE` (turn off the API-response signature check only if valid responses are rejected).
- CCAvenue AES-256-GCM integration kit (`CCAVENUE_ENCRYPTION=gcm`, checkout at `gTransaction.do`).
- Paytm refund notifications (Accept/Success Refund JSON) are verified and normalised, and `head.signature` on API responses is checked when present.
- Integration code generator: a Skydo backend (invoice route, public status route that reads only the stored status, admin refresh, outstanding and receipt routes, Zoho polling including `startSkydoPolling` for Fastify) instead of a guide only. It stores `providerOrderId` so each refresh costs one Zoho call, and documents the Zoho daily limits (1,000 Free to 10,000 Premium+ calls; 96 calls a day per open invoice at 15 minutes).
- `npm run sandbox:smoke` (`scripts/sandbox-smoke.ts`): creates small unpaid orders against the real sandboxes of configured gateways.
- End-to-end tests that start the MCP server as a child process and call it over stdio and Streamable HTTP.
- Verification reports in `docs/research/verification/`: three independent verification rounds against official docs plus adversarial reviews (round 3: money-safety rules and the Skydo bridge), and an exhaustive search for a Skydo API. Summary in [docs/design-review.md](docs/design-review.md#round-3).
- `payments_get_status` accepts `provider_payment_id` (CCAvenue `reference_no`); `payments_get_refund_status` documents the ids each gateway needs, and Razorpay refund status can look a refund up by `providerPaymentId` + `refundRef`.
- `ProviderModule.protectedOptionKeys`: per-gateway `providerOptions` keys refused for payments and subscriptions.
- MCP amount descriptions now say "minor units of the currency" (paise for INR, cents for USD), so agents do not convert Skydo amounts to INR.

### Changed

- **`paid` now requires binding and collected money.** `verifyPayment` returns `paid: true` only when the result is valid, the status is `captured` or `partially_refunded`, **and** the caller passed both `orderRef` and `expectedAmount`. `authorized` (this library has no capture API; enable auto-capture) and fully `refunded` payments are **not** paid. Otherwise `reason` explains why. (The MCP tool already required both bindings.)
- Razorpay `verifyPayment` reports `captured` only when the order is fully paid (`status: paid` and `amount_paid >= amount`), otherwise `authorized`; `getPaymentStatus` reports a partly paid order as `pending`.
- `providerOptions` guard: a baseline list plus per-gateway keys (splits, transfers, connected accounts, manual capture, partial payments, redirect URLs, binding keys) for `createPayment` **and** `createSubscription`. Stripe `metadata` can no longer override `order_ref` / `subscription_ref`.
- Refunds: after `OUTCOME_UNKNOWN` or a duplicate rejection the client looks the refund up by `refundRef` and returns it (PayU and CCAvenue cannot look up by reference). The idempotency cache is in process: `createPayment` 10 minutes (checkout tokens expire), refunds 24 h.
- Cashfree reports `refunded` / `partially_refunded` (with `amountRefunded`) from Get All Refunds for an order.
- Mock mode mirrors the real adapters' input rules (required ids, INR only for PayU/Paytm/PhonePe, duplicate-refund behaviour, refused webhook simulations), verifies Skydo/Cashfree/PhonePe/Stripe by status lookup, and settles per provider and currency.
- `createWebhookHandler` dedupes events from unauthenticated bodies (PhonePe, CCAvenue) on the confirmed data, not the body's id. A confirmed fully `refunded` status is no longer `payment.succeeded`. Refund events set the payment `status` only when the event can tell a full from a partial refund.
- HTTP transport: exact `/mcp` path, `MCP_HTTP_PORT` validated, sessions idle for 30 minutes evicted, at most 1,000 sessions.
- Packaging: `exports` has a `default` condition, so `require('india-payments-mcp')` works on Node versions that can require ES modules; `prepublishOnly` runs typecheck, tests and build; no source maps; `homepage` / `bugs` fields.
- `doctor` / `payments_check_config` show an unconfigured Skydo as `not configured` with a setup hint instead of an error.
- Adapters corrected after verification against official docs:
  - Razorpay: Checkout `name` is sent; daily plans need `interval >= 7`; `customer_id` is no longer sent on subscription create (kept in `notes.customer_id`); subscriptions accept `providerOptions.end_at` instead of `totalCount`; a retried order creation that hits Razorpay's duplicate-receipt error returns the existing order; `cardless_emi` removed from payment methods.
  - Stripe: Indian accounts list `card` only (UPI is not available to India-domiciled accounts); refund webhooks use `refund.created` / `refund.updated` / `refund.failed` and `charge.refunded` is reported as `unknown`; refunding an uncaptured PaymentIntent cancels it; Idempotency-Key and `client_reference_id` length limits are enforced.
  - Cashfree: refund `x-idempotency-key` is a UUID derived from orderRef + refundRef; webhook timestamps up to 24 h old are accepted (Cashfree retries for 30+ minutes) with dedupe on the event id; auto-refund and dispute webhooks are normalised; Indian phone numbers normalised to 10 digits; `customer_id` derivation and refund status enum fixed.
  - PayU: txnid max 25 characters and field limits enforced; refund status (`check_action_status`) is now `supported` and parses both documented response shapes; PayU rejects a reused refund token (error 106), which is now reported as `OUTCOME_UNKNOWN` (the earlier refund probably exists): find its `request_id` before doing anything else, and never retry with a new refundRef until you know the first one failed. `unmappedstatus` (not covered by the hash) can only downgrade a status.
  - Paytm: refund apply and refund status use the `securegw(-stage).paytmpayments.in` hosts; Accept vs Success refund notifications distinguished; wallet and pay-later payment methods added; payment-mode codes, mobile number and name normalised.
  - PhonePe: `metaInfo` udf limits validated (free-form metadata fills udf1..udf10); flat refund webhook samples handled; claims the docs do not make (refund de-duplication, order-id reuse) marked as assumptions.
  - CCAvenue: `orderStatusTracker` version 1.2, `refundOrder` 1.1; refund amounts formatted in the order's currency; `billing_country` sent as a country name.
- Config values that look like template placeholders (`replace-me`, `xxxxxxxx`, `<...>`) are treated as unset, so `doctor` does not report them as configured.
- `PHONEPE_CLIENT_VERSION` in `.env.example` is blank: use the value shown with your credentials.

### Not yet done

- No adapter has been run against a live gateway sandbox. See the verification status in the README.
- Paytm's API-response signature format is not pinned down by the docs; Skydo's import of API-created Zoho invoices is unconfirmed (check during setup); CCAvenue details are third-party sourced; `confirm=true` is an honour system mitigated by client approval prompts.

## [0.1.0] - 2026-10-28

### Added

- `PaymentsClient` SDK with unified types: integer paise, merchant `orderRef`, four checkout shapes (`js_sdk`, `redirect`, `form_post`, `manual`), normalized payment/refund statuses and webhook events.
- Capability model (`supported` / `partial` / `not_implemented` / `unsupported`) per gateway, with fail-fast `UNSUPPORTED` / `NOT_IMPLEMENTED` errors before any network call.
- Gateway adapters:
  - Razorpay: orders + Checkout.js, signature verification, status, refunds, refund status, webhooks, customers, subscriptions, settlements.
  - Stripe: Checkout Sessions / PaymentIntents, status-API verification, refunds, webhooks, customers; partial subscriptions and settlements (payouts list).
  - Cashfree: orders + cashfree.js, status-API verification, refunds, webhooks (timestamped HMAC, 5-minute tolerance).
  - PayU: hosted form POST with SHA-512 hashes, verify_payment status, refunds; partial refund status and webhooks.
  - Paytm: Initiate Transaction + JS Checkout (form fallback), checksum verification, status, refunds, refund status; partial webhooks.
  - PhonePe Standard Checkout v2: OAuth, redirect PayPage, status-API verification, refunds, refund status; partial webhooks.
  - CCAvenue: encrypted form POST, `encResp` decryption; partial status, refunds and webhooks (several details UNVERIFIED).
  - Skydo: guidance only (no public API).
- Mock mode (`PAYMENTS_MODE=mock`) that keeps real capability maps, with HMAC-signed callbacks and webhooks and a refundable-balance ledger.
- Safety rails: a live-mutation double gate (`PAYMENTS_ALLOW_LIVE_MUTATIONS` + `confirm`), `refundRef` idempotency, client idempotency with conflict detection, a JSONL audit log, and redacted stderr logging.
- HTTP client with timeouts, retry-safe-only retries with jittered backoff, `Retry-After` support and provider error mapping.
- `createWebhookHandler`: verify → dedupe → handle, with gateway-friendly status codes.
- MCP server with 17 tools, `payments://matrix` and `payments://providers/{provider}` resources, and the `integrate_payments` prompt.
- CLI: stdio server (default), Streamable HTTP transport with bearer-token auth (`http`), and `doctor`.
- Integration code generator and gateway recommender.
- Dockerfile, CI workflow, documentation set, Claude Skill and ChatGPT kit.
