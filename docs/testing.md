# Testing (deliverables I and J)

Testing happens at four layers, from cheapest to most realistic:

| Layer | Network | Credentials | What it proves |
|---|---|---|---|
| 1. Unit + contract tests (`npm test`) | none (fake fetch) | none | We send the exact bytes the gateway expects and verify the exact bytes it sends |
| 2. Mock mode (`PAYMENTS_MODE=mock`) | none | none | End-to-end flows through the MCP server and SDK, including capability gaps |
| 3. Webhook simulation | local only | webhook secret | Your endpoint verifies real signature schemes over the raw body |
| 4. Sandbox (`PAYMENTS_MODE=sandbox`) | gateway test hosts | test keys | The gateway agrees with us today |

---

## 1. Mock mode

```bash
claude mcp add india-payments -e PAYMENTS_MODE=mock -- npx -y india-payments-mcp
# or for the SDK / your app
PAYMENTS_MODE=mock npm run dev
```

What `MockGateway` does (`src/mock/mock-gateway.ts`):

- **Keeps each gateway's real capability map and input rules.** `payments_create_customer` on PhonePe fails with `UNSUPPORTED` in mock mode exactly as it would in production, and so does a Skydo refund. Like the real adapters, the mock requires `provider_order_id` for status on Razorpay and Stripe, requires `provider_payment_id` for refunds on Razorpay, Stripe, PayU, Paytm and CCAvenue, accepts INR only on PayU, Paytm and PhonePe, and refuses the webhook simulations the real adapter refuses (PayU and CCAvenue `refund.processed`). Skydo's currency rules (no INR, USD 50 minimum) are enforced in mock mode too; `payments_skydo_record_payment` and `payments_skydo_outstanding` are not available in mock mode, so simulate Skydo payments with `payments_mock_complete_payment`.
- Keeps state in one `MockLedger` per `PaymentsClient`, shared across MCP tool calls. State is in memory and lost when the process exits.
- `createPayment` returns a `manual` checkout. The customer is simulated with `payments_mock_complete_payment` (`outcome: success | failure`, `method` default `upi`), which returns a callback payload **HMAC-signed** with a random per-process mock secret. `verifyPayment` rejects tampered fields, orderRef mismatches and amount mismatches. For Skydo, Cashfree, PhonePe and Stripe, whose real verify is a status lookup, `verifyPayment` with `payload: {}` looks the order up by `order_ref` instead.
- Refunds enforce the refundable balance and move status to `partially_refunded` / `refunded`. A reused `refundRef` follows the real gateway: Razorpay, PayU and CCAvenue reject it as a duplicate (the client then looks the refund up where the real gateway can), the others return the earlier refund.
- `simulateWebhook` emits a normalized event signed with `x-mock-signature`. `listSettlements` returns one settlement per currency of that provider's captured volume minus a flat 2% "fee".
- Re-using an `orderRef` with **the same** request returns the cached result (client idempotency). With a **different** request it fails with `IDEMPOTENCY_CONFLICT`.

What mock mode does **not** test: real hashes and encodings, gateway validation rules (minimum amounts, field lengths beyond our own orderRef check), timing, or async states such as UPI `pending`. Use sandbox for those.

A typical agent smoke test, in plain language:

> Create a Rs 1 PayU payment for T_001 with return URL https://example.com/r → complete it successfully → verify it with expected amount 100 → refund it fully with refund ref RF_T_001 and the provider payment id from the verify result → refund again with the same ref → get refund status.

Every step should succeed, and the second refund should return the first refund's result from the in-process idempotency cache.

## 2. Sandbox setup per gateway

Where to get test credentials, and what to test with. **Test instruments are marked UNVERIFIED unless the research doc verified them. Take current values from the gateway's own test-data page.** They change.

| Gateway | Test keys | Test instruments (check the gateway's docs) | Gotchas |
|---|---|---|---|
| Razorpay | Dashboard → switch to **Test Mode** → Account & Settings → API Keys (`rzp_test_…`). Webhook secret: set when you create a test webhook | Razorpay publishes test cards and UPI ids on its "Test Card Details" / "Test UPI" pages. Commonly cited: UPI `success@razorpay` / `failure@razorpay` (UNVERIFIED here) | Enable auto-capture in test mode too, or payments stay `authorized` and `paid` stays `false` |
| PayU | Dashboard → test mode → Developers → Key & Salt. Test and live keys look identical | PayU docs list test cards/UPI under "Test Cards, UPI ID and Wallets" (UNVERIFIED here) | `surl`/`furl` must accept POST. Test webhooks fire only for test transactions |
| Cashfree | Sandbox dashboard (merchant.cashfree.com, sandbox toggle) → Developers → API Keys | Cashfree docs have a "Test data" page with cards, UPI and netbanking (UNVERIFIED here) | **Whitelist your checkout domain** in the sandbox too (`localhost` handling is gateway-defined; use a tunnel if it's refused). Webhook timestamps must be fresh |
| CCAvenue | Ask CCAvenue support to enable a test/staging account. Credentials are in M.A.R.S. → Settings → API Keys | Provided by CCAvenue with test access (UNVERIFIED) | **Whitelist your server IP** for status/refund APIs. The access code is bound to the registered domain. Confirm the encryption kit (CBC vs GCM) |
| Paytm | paytmpayments.com dashboard → Developer Settings → API Keys (test MID + 16-char key). Website `WEBSTAGING` | Paytm docs provide staging test wallet/card credentials (UNVERIFIED here) | Hosts were rebranded to `*.paytmpayments.com`. `txnToken` lasts 15 min. Business errors return HTTP 200 |
| PhonePe | Sandbox `client_id` / `client_secret` / `client_version` come from the **PhonePe integration team**. Production comes from the Business Dashboard | PhonePe documents a sandbox PayPage/simulator flow (UNVERIFIED here) | Ask the integration team to configure the sandbox webhook URL and credentials. Minimum 100 paise |
| Stripe | Dashboard → Developers → API keys (`sk_test_…`, `pk_test_…`). Requires an existing (invited) account for India | Stripe's testing page lists `4242 4242 4242 4242` and India-specific cards (Stripe docs; not re-verified here) | `stripe listen --forward-to localhost:3000/webhooks/stripe` prints a test `whsec_` |
| Skydo | No Skydo sandbox. Zoho bridge: use a Zoho Books organisation that is **not** connected to Skydo (with `ZOHO_*` set, `sandbox` mode creates real invoices). Ledger mode: any `SKYDO_RECEIVING_ACCOUNTS` and a scratch `SKYDO_LEDGER_FILE` on a local disk. Through MCP, recording a receipt needs `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` and `confirm: true` in sandbox too | n/a | See [skydo.md](skydo.md). Confirm once, with one real invoice, that Skydo imports API-created Zoho invoices |

After configuring, run:

```bash
PAYMENTS_MODE=sandbox npx india-payments-mcp doctor
```

`doctor` instantiates each configured adapter, so key-prefix mismatches and missing required vars show up immediately. It makes **no** network calls.

Then exercise one full cycle per gateway: create → pay in the gateway's test UI → verify → status → partial refund → refund status → receive the real webhook through a tunnel.

## 3. Contract tests

Location: `test/providers/<id>.test.ts`, plus `test/core/*`, `test/client.test.ts` and `test/mcp.test.ts`. Runner: vitest (`npm test`).

The harness (`test/helpers.ts`):

- `fakeFetch(routes)` matches requests by `"METHOD url"` substring or regex, returns canned JSON, and **records every request** (url, method, lowercased headers, body).
- `testContext(provider, fetch)` builds an `AdapterContext` with a fixed clock (`2026-10-28T10:00:00Z`), a silent logger and **zero retries**, so tests are deterministic.

What a provider contract test must assert:

1. **Outbound request exactness**: URL and host per environment, auth header shape, body field names and **amount format** (paise → `"499.00"` for PayU, `499` for Cashfree), and the idempotency header where applicable.
2. **Signature generation against a known vector**: hash/HMAC/checksum input string and output, taken from the gateway's documentation or official library where available.
3. **Verification round-trip and tamper cases**: a valid payload passes. One changed field, a wrong secret, a different orderRef or a different amount each fail with the right `reason`.
4. **Status mapping**: every documented gateway status maps to the expected `PaymentStatus`, and unknown values map to `unknown`.
5. **Webhook**: `parseWebhook(simulateWebhook(x))` round-trips. A bad signature throws `SIGNATURE_INVALID`. Timestamp tolerance is enforced where the scheme has one (Cashfree, Stripe).
6. **Error mapping**: a 4xx body becomes `PROVIDER_ERROR` with `providerCode`/`providerMessage` via `extractError`. 401 becomes `AUTH`. HTTP-200 business failures (Paytm) become errors.
7. **Credential validation**: missing vars give `CONFIG_MISSING`. Mode/key mismatches give `CONFIG_INVALID`.

The client and MCP tests cover the cross-cutting rails: feature gating (`UNSUPPORTED` / `NOT_IMPLEMENTED` before any fetch), `LIVE_MUTATION_BLOCKED` without the env flag or `confirm`, idempotent replay and `IDEMPOTENCY_CONFLICT`, audit outcomes, and the HTTP client's retry rules (GET retried, non-retry-safe POST never retried, `Retry-After` honoured).

## 4. Webhook simulation

See [webhooks.md §7](webhooks.md#7-local-testing-with-payments_simulate_webhook). Short version:

```text
payments_simulate_webhook provider=cashfree type=payment.succeeded order_ref=ORD_1 amount=49900 target_url=http://localhost:3000/webhooks/cashfree
```

Run the returned `curl`. In sandbox mode this is signed with your real `CASHFREE_CLIENT_SECRET` scheme, so it tests **your endpoint's raw-body handling**, which is the most common integration bug. Then tamper with one byte of the body and confirm your endpoint returns 400.

## 5. CI

`.github/workflows/ci.yml` runs on every push to `main` and every PR, on Node 20 and 22:

```
npm ci → npm run typecheck → npm test → npm run build → node dist/cli.js --version && doctor
```

- CI sets `PAYMENTS_MODE=mock`. **No test may reach a real gateway.** Adapters receive fetch through `AdapterContext`, so a missing fake route returns 404 rather than leaking to the network.
- No secrets are configured in CI. If you add an optional sandbox job later, run it on `workflow_dispatch` / schedule only, with sandbox keys in GitHub environment secrets, and never on PRs from forks.
- A failing contract test after a gateway change is an **API drift** signal. File it with the `api_drift` issue template and include the doc link.
