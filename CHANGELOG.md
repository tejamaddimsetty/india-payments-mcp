# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Before 1.0, minor versions may contain breaking changes.

## [Unreleased]

## [0.2.0] - 2026-10-29

### Added

- **Skydo adapter** (previously guidance only). Skydo still has no public API, so the adapter never contacts Skydo; it automates the two paths Skydo supports. See [docs/skydo.md](docs/skydo.md).
  - Zoho Books bridge (`ZOHO_DATA_CENTER`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ORGANIZATION_ID`, `ZOHO_ITEM_ID`, optional `ZOHO_ACCOUNTS_URL`): creates a Zoho Books invoice per order (idempotent on `reference_number` = orderRef), marks drafts sent, and reads back the status that Skydo sets, including whether the FIRA is attached.
  - Zoho data centers: com, eu, in, com.au, jp, ca, com.cn, sa, ae, uk, sg. Invoice lookup is exact and paginated; a duplicate invoice created by a concurrent process is voided; a draft left by a failed attempt is marked sent on retry.
  - A Zoho invoice counts as paid (`captured`) only when payments cover the total: write-offs report `failed`, credit-note closures `unknown`. An invoice whose `reference_number` is not the orderRef is refused.
  - Receiving accounts + ledger (`SKYDO_RECEIVING_ACCOUNTS`, `SKYDO_PAYEE_NAME`, `SKYDO_LEDGER_FILE`): bank-transfer instructions per currency (with a `"*"` fallback) and a persistent JSON ledger of expected payments. Every change takes a file lock and re-reads the file, so an app and the MCP server can share it.
  - Receipts are idempotent per `receiptId` (MCP: `receipt_id`, required). Recording a receipt is behind the live-mutation gate in the MCP server (`PAYMENTS_ALLOW_LIVE_MUTATIONS` + `confirm`).
  - `createPayment`, `verifyPayment` and `paymentStatus` are now `partial` for Skydo. Refunds, webhooks, customers, subscriptions, settlements, payouts and payment links stay unsupported.
  - Skydo rules enforced in `PaymentsClient` (and so in mock mode too): `currency` is required, INR is rejected, USD payments must be at least USD 50. Other currencies get a reminder about the USD 50 equivalent, and GBP orderRefs over 18 characters a warning about truncated UK references.
- MCP tools `payments_skydo_record_payment` and `payments_skydo_outstanding` (19 tools in total), and SDK methods `PaymentsClient.skydoRecordPayment` and `skydoOutstanding`.
- `verifiedVia: "manual_record"` for results read from the Skydo ledger.
- `providerOrderId` on `verifyPayment` (MCP: `provider_order_id`): Razorpay now computes the signature with the `order_…` / `sub_…` id you stored, never the id the browser sends.
- Credentials: `RAZORPAY_MERCHANT_NAME` (Checkout `name`, which Razorpay marks mandatory), `CCAVENUE_ENCRYPTION` (`cbc` or `gcm`) and `PAYTM_VERIFY_RESPONSE_SIGNATURE` (turn off the API-response signature check only if valid responses are rejected).
- CCAvenue AES-256-GCM integration kit (`CCAVENUE_ENCRYPTION=gcm`, checkout at `gTransaction.do`).
- Paytm refund notifications (Accept/Success Refund JSON) are verified and normalised, and `head.signature` on API responses is checked when present.
- Integration code generator: a Skydo backend (invoice route, public status route that reads only local state, admin refresh and receipt routes, Zoho polling) instead of a guide only.
- `npm run sandbox:smoke` (`scripts/sandbox-smoke.ts`): creates small unpaid orders against the real sandboxes of configured gateways.
- End-to-end tests that start the MCP server as a child process and call it over stdio and Streamable HTTP.
- Verification reports in `docs/research/verification/`: every adapter checked line by line against official docs in two independent rounds, plus an exhaustive search for a Skydo API.
- MCP amount descriptions now say "minor units of the currency" (paise for INR, cents for USD), so agents do not convert Skydo amounts to INR.

### Changed

- **`paid` now requires binding.** `verifyPayment` returns `paid: true` only when the result is valid, the status is settled, **and** the caller passed both `orderRef` and `expectedAmount`. Otherwise `reason` explains why. (The MCP tool already required both.)
- Adapters corrected after verification against official docs:
  - Razorpay: Checkout `name` is sent; daily plans need `interval >= 7`; `customer_id` is no longer sent on subscription create (kept in `notes.customer_id`); subscriptions accept `providerOptions.end_at` instead of `totalCount`; a retried order creation that hits Razorpay's duplicate-receipt error returns the existing order; `cardless_emi` removed from payment methods.
  - Stripe: Indian accounts list `card` only (UPI is not available to India-domiciled accounts); refund webhooks use `refund.created` / `refund.updated` / `refund.failed` and `charge.refunded` is reported as `unknown`; refunding an uncaptured PaymentIntent cancels it; Idempotency-Key and `client_reference_id` length limits are enforced.
  - Cashfree: refund `x-idempotency-key` is a UUID derived from orderRef + refundRef; webhook timestamps up to 24 h old are accepted (Cashfree retries for 30+ minutes) with dedupe on the event id; auto-refund and dispute webhooks are normalised; Indian phone numbers normalised to 10 digits; `customer_id` derivation and refund status enum fixed.
  - PayU: txnid max 25 characters and field limits enforced; refund status (`check_action_status`) is now `supported` and parses both documented response shapes; PayU rejects a reused refund token (error 106), so on `OUTCOME_UNKNOWN` check refund status before retrying with a new refundRef.
  - Paytm: refund apply and refund status use the `securegw(-stage).paytmpayments.in` hosts; Accept vs Success refund notifications distinguished; wallet and pay-later payment methods added; payment-mode codes, mobile number and name normalised.
  - PhonePe: `metaInfo` udf limits validated (free-form metadata fills udf1..udf10); flat refund webhook samples handled; claims the docs do not make (refund de-duplication, order-id reuse) marked as assumptions.
  - CCAvenue: `orderStatusTracker` version 1.2, `refundOrder` 1.1; refund amounts formatted in the order's currency; `billing_country` sent as a country name.
- Config values that look like template placeholders (`replace-me`, `xxxxxxxx`, `<...>`) are treated as unset, so `doctor` does not report them as configured.
- `PHONEPE_CLIENT_VERSION` in `.env.example` is blank: use the value shown with your credentials.

### Not yet done

- No adapter has been run against a live gateway sandbox. See the verification status in the README.

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
