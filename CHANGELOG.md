# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Before 1.0, minor versions may contain breaking changes.

## [Unreleased]

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
