# india-payments-mcp

One MCP server and TypeScript SDK for Indian payment gateways: **Razorpay, PayU, Cashfree, CCAvenue, Paytm, PhonePe, Stripe, Skydo and Infinity**. You get one set of tools (`payments_create_payment`, `payments_verify_payment`, `payments_refund`, ...) and one set of types. Amounts are always integers in the minor unit of the currency (paise for INR, cents for USD), every gateway's checkout is described by four shapes, and webhooks normalize to one event model. Adapters handle the per-gateway hashes, encodings and amount formats. The server tells you, and your agent, which features each gateway actually lacks instead of pretending otherwise. It's built for developers wiring up checkout, vibecoders who want an agent to do it, and AI agents that need to check payment status or issue a refund safely.

> Status: 0.3.0. Seven gateways have API adapters. Skydo and Infinity have no public API, so their adapters automate their Zoho Books integrations or hand out your receiving-account details (and, for Infinity, a QuickLink) with a ledger ([docs/skydo.md](docs/skydo.md), [docs/infinity.md](docs/infinity.md)). The seven API adapters and Skydo have been through three independent verification rounds against official docs plus adversarial reviews; Infinity reuses Skydo's reviewed Zoho and ledger code and had its own adversarial review (see [Verification status](#verification-status)). Infinity's Zoho integration is not publicly documented, so confirm it with one real invoice. 681 tests pass, but no adapter has been run against a live gateway sandbox yet, and some CCAvenue details remain UNVERIFIED. See [Verification status](#verification-status). Check the per-gateway support level with `payments_get_capabilities` before relying on a feature. See [Disclaimer](#disclaimer).

---

## 60-second quickstart

You don't need any credentials. Mock mode simulates every gateway in memory and never touches the network.

**Claude Code**

```bash
claude mcp add india-payments -e PAYMENTS_MODE=mock -- npx -y india-payments-mcp
```

**Claude Desktop / Cursor / any stdio MCP client** (`claude_desktop_config.json`, `.cursor/mcp.json`, ...):

```json
{
  "mcpServers": {
    "india-payments": {
      "command": "npx",
      "args": ["-y", "india-payments-mcp"],
      "env": { "PAYMENTS_MODE": "mock" }
    }
  }
}
```

More client configs are in [`examples/mcp-clients`](examples/mcp-clients).

**Then ask:**

> **You:** Which gateway should I use for a SaaS with monthly UPI Autopay subscriptions? Then create a ₹499 test payment on it for order ORD_1001.
>
> **Claude:** *(calls `payments_recommend_gateway` with needs `["subscriptions","upi"]`)* Razorpay comes out on top: subscriptions are implemented end to end (plans, mandate authorisation through Checkout, cancel). Stripe's are partial and Stripe is invite-only for Indian businesses. On Cashfree, PayU and PhonePe, subscriptions are still "Planned" in this project.
> *(calls `payments_create_payment` provider=razorpay, order_ref=ORD_1001, amount=49900)* Created `mock_razorpay_order_1a2b3c4d` with status `created`. In mock mode no checkout page exists, so I'll simulate the customer.
> *(calls `payments_mock_complete_payment` outcome=success, then `payments_verify_payment` with the returned callback payload, order_ref and expected_amount)* The signature is valid, the amount matches, and the status is `captured`.
>
> **You:** Refund ₹100 of it.
>
> **Claude:** *(calls `payments_refund` refund_ref=RF_ORD_1001_1, amount=10000)* Refund processed. The payment status is now `partially_refunded`. Re-sending the same `refund_ref` returns this same refund instead of creating a second one.

Check your setup any time:

```bash
npx india-payments-mcp doctor
```

---

## Gateway support matrix

Generated from each adapter's `src/providers/<id>/capabilities.ts`. Unsupported features fail with `UNSUPPORTED` and Planned ones with `NOT_IMPLEMENTED`, before any network call.

| Feature | Razorpay | PayU India | Cashfree Payments | CCAvenue | Paytm Payment Gateway | PhonePe Payment Gateway | Stripe (India) | Skydo | Infinity |
|---|---|---|---|---|---|---|---|---|---|
| createPayment | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Partial | Partial |
| verifyPayment | Yes | Yes | Yes | Yes | Yes | Partial | Yes | Partial | Partial |
| paymentStatus | Yes | Yes | Yes | Partial | Yes | Yes | Yes | Partial | Partial |
| refund | Yes | Yes | Yes | Partial | Yes | Yes | Yes | No | No |
| refundStatus | Yes | Yes | Yes | Planned | Yes | Yes | Yes | No | No |
| webhooks | Yes | Partial | Yes | Partial | Partial | Partial | Yes | No | No |
| customers | Yes | No | Planned | No | No | No | Yes | No | No |
| subscriptions | Yes | Planned | Planned | Planned | Planned | Planned | Partial | No | No |
| settlements | Yes | Planned | Planned | Planned | Planned | Planned | Partial | No | No |
| payouts | Planned | Planned | Planned | Planned | Planned | No | Planned | No | No |
| paymentLinks | Planned | Planned | Planned | Planned | Planned | Planned | Planned | No | No |
| checkout | js_sdk, redirect | form_post | js_sdk | form_post | js_sdk, form_post | redirect | redirect, js_sdk | manual | manual |

Yes = implemented here. Partial = implemented with caveats (see capability notes). Planned = the gateway offers it, this project does not yet. No = the gateway does not offer it.

`payments_get_capabilities` and the `payments://matrix` MCP resource return the same data with per-feature notes, hard constraints, env vars, official SDKs and Shopify/WooCommerce plugins. To refresh this table after changing a capability map:

```bash
npx tsx -e "import {supportMatrixMarkdown} from './src/codegen/matrix.ts'; import {allCapabilities} from './src/providers/index.ts'; console.log(supportMatrixMarkdown(allCapabilities()))"
```

For checkout types, amount units, signature schemes and onboarding notes per gateway, see [docs/gateway-matrix.md](docs/gateway-matrix.md).

---

## MCP tools

| Tool | What it does | Side effects |
|---|---|---|
| `payments_list_providers` | Lists every enabled gateway with its summary, whether it's configured, and its feature support levels | read-only |
| `payments_get_capabilities` | Returns one gateway's full capability map: features + notes, payment methods, env vars, constraints, SDKs, plugins | read-only |
| `payments_check_config` | Doctor: shows the mode, live-mutation flag, audit log path, and present/missing env vars per gateway. Never returns values | read-only |
| `payments_recommend_gateway` | Ranks gateways for needs such as `subscriptions`, `international`, `shopify`, `exporter_collections` | read-only |
| `payments_create_payment` | Creates an order/session and returns a `checkout` action (`js_sdk` / `redirect` / `form_post` / `manual`) | creates an order (no money moves) |
| `payments_verify_payment` | Verifies the browser callback payload, binding it to `order_ref` and `expected_amount` (both required; pass `provider_order_id` for Razorpay). Fulfil only when `paid` is `true` | read-only (may call the status API) |
| `payments_get_status` | Fetches the authoritative payment status from the gateway. Razorpay and Stripe need `provider_order_id` | read-only |
| `payments_refund` | Refunds all or part of a payment. `refund_ref` is the idempotency key. Razorpay, PayU, Paytm, CCAvenue and Stripe need `provider_payment_id`. Live mode needs a double gate | **moves money** |
| `payments_get_refund_status` | Fetches refund status (the ids each gateway needs are in the tool description; CCAvenue has none) | read-only |
| `payments_verify_webhook` | Verifies a webhook against its raw body and normalizes it to a common event | read-only |
| `payments_simulate_webhook` | Builds a correctly signed webhook (plus an optional curl command) for local testing. Disabled in live mode | none |
| `payments_create_customer` | Creates a customer on gateways that have them | creates a record |
| `payments_create_subscription` | Creates a recurring subscription and returns the mandate-authorisation checkout | creates a mandate request |
| `payments_cancel_subscription` | Cancels now or at cycle end. Live mode needs a double gate | **stops billing** |
| `payments_list_settlements` | Lists settlements for reconciliation | read-only |
| `payments_generate_integration` | Generates server routes, client checkout, env template and test checklist for a framework | read-only (returns files) |
| `payments_skydo_record_payment` | **Skydo ledger mode only.** Records a receipt a human has checked in the Skydo dashboard (minor units of the invoice currency). Needs `receipt_id` (idempotent per receipt) and, in sandbox and live alike (Skydo has no sandbox), the double gate with `confirm: true`; partial receipts keep the order `pending` | **can mark an order paid** |
| `payments_skydo_outstanding` | **Skydo ledger mode.** Lists orders still waiting for money, oldest first | read-only |
| `payments_infinity_record_payment` | **Infinity ledger mode only.** Records a receipt a human has checked in the Infinity dashboard (bank transfer or QuickLink). Same rules as the Skydo tool: `receipt_id`, minor units of the invoice currency, and the double gate in sandbox and live alike (Infinity documents no sandbox) | **can mark an order paid** |
| `payments_infinity_outstanding` | **Infinity ledger mode.** Lists orders still waiting for money, oldest first | read-only |
| `payments_mock_complete_payment` | **Mock mode only.** Simulates the customer paying or failing and returns a signed callback payload | mock state only |

That is 21 tools. The server also exposes resources (`payments://matrix`, `payments://providers/{provider}`) and a prompt (`integrate_payments`). The full argument and return schemas are in [docs/architecture.md](docs/architecture.md#d-unified-mcp-tool-schema), and example payloads are in [docs/payloads.md](docs/payloads.md).

---

## SDK usage

```bash
npm install india-payments-mcp
```

The package is ES modules with a `default` export condition, so both `import` and `require('india-payments-mcp')` work on Node versions that can `require()` ES modules (20.19+ and 22.12+). On older Node 20 releases, CommonJS code needs `await import('india-payments-mcp')`.

```ts
import express from 'express';
import { PaymentsClient, createWebhookHandler, PaymentError } from 'india-payments-mcp';

// Reads PAYMENTS_MODE and gateway credentials from process.env.
const payments = new PaymentsClient();

const app = express();

// 1. Create an order. Persist orderRef + providerOrderId, then hand `checkout` to the frontend.
app.post('/api/orders', express.json(), async (req, res) => {
  const order = await payments.createPayment('razorpay', {
    orderRef: 'ORD_1001',          // 3-40 chars, [A-Za-z0-9_-]
    amount: 49900,                 // paise: Rs 499.00
    customer: { name: 'Asha', email: 'asha@example.com', phone: '9876543210' },
    returnUrl: 'https://shop.example.com/pay/return',
  });
  res.json({ providerOrderId: order.providerOrderId, checkout: order.checkout });
});

// 2. Verify what the browser sends back, bound to YOUR stored order and amount.
//    Fulfil only when paid === true. paid is true only when the callback is genuine, the status is
//    captured or partially_refunded (authorized-only and fully refunded are NOT paid), AND you passed
//    orderRef + expectedAmount. valid alone means "genuine": a genuine failure is valid too.
//    For Razorpay also pass the order_... id you stored as providerOrderId; Razorpay reports captured
//    only once the order is fully paid, so turn on auto-capture.
app.post('/api/payments/verify', express.json(), async (req, res) => {
  const result = await payments.verifyPayment('razorpay', {
    orderRef: 'ORD_1001',
    expectedAmount: 49900,
    providerOrderId: 'order_...',  // the id you stored at step 1
    payload: req.body,
  });
  res.status(result.paid ? 200 : 402).json({ paid: result.paid, status: result.status });
});

// 3. Webhooks: verify the raw body -> dedupe by event id -> your handler.
//    express.raw() MUST run before any JSON parser on this route.
const onRazorpayWebhook = createWebhookHandler({
  client: payments,
  provider: 'razorpay',
  onEvent: async (event) => {
    if (event.type === 'payment.succeeded') {
      // Fulfil idempotently, then check event.amount against your stored amount. A thrown error
      // returns 500 so the gateway retries. Razorpay: subscribe to order.paid, which carries
      // event.orderRef; payment.* events carry only event.providerOrderId.
    }
  },
});
app.post('/webhooks/razorpay', express.raw({ type: '*/*' }), async (req, res) => {
  const out = await onRazorpayWebhook({ headers: req.headers, rawBody: req.body.toString('utf8') });
  res.status(out.status).json(out.body);
});

// Errors are typed: err.code is one of VALIDATION, UNSUPPORTED, NOT_IMPLEMENTED, AUTH, TIMEOUT,
// OUTCOME_UNKNOWN, LIVE_MUTATION_BLOCKED, IDEMPOTENCY_CONFLICT, ... err.retryable is true only when a
// blind retry is safe. OUTCOME_UNKNOWN means "may have happened": look it up before retrying.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof PaymentError) return void res.status(400).json(err.toJSON());
  res.status(500).json({ error: 'INTERNAL' });
});
```

A complete runnable version is in [`examples/express-checkout`](examples/express-checkout). For production, pass your own `idempotencyStore` (Redis/Postgres) and `auditSink` to `new PaymentsClient({...})`, plus a shared `dedupe` store to `createWebhookHandler`. The defaults are in-memory and per-process.

---

## Skydo

Skydo (cross-border collections for Indian exporters and freelancers) has **no public developer API or webhooks**; an API has been on its roadmap since December 2025, and its Terms of Use prohibit automated access to the platform. This project never contacts Skydo. Instead the Skydo adapter automates the two paths Skydo supports:

- **Zoho Books bridge** (set all six `ZOHO_*` variables): `payments_create_payment` creates a Zoho Books invoice with your order reference. Skydo documents syncing Zoho invoices and, when the money arrives, marking them paid with the FIRA attached; whether it imports API-created invoices is not documented, so confirm it with your first invoice during setup. `payments_get_status` / `payments_verify_payment` read the invoice back.
- **Receiving accounts + ledger** (set `SKYDO_RECEIVING_ACCOUNTS`): `payments_create_payment` returns bank-transfer instructions for your Skydo account in the client's currency, with the order reference, and tracks the payment in a local JSON ledger. You confirm each receipt with `payments_skydo_record_payment` (a `receipt_id` plus `confirm: true`) after checking it in the Skydo dashboard. The ledger file can be shared by your app and the MCP server on the same local disk (file lock).

Skydo payments are foreign currency only (INR is rejected), at least USD 50 (or the equivalent), and have no refunds, webhooks, recurring payments or API payment links. Skydo documents its Zoho sync but not API-created invoices specifically, so confirm the first invoice appears in your Skydo dashboard. Setup, the full flow and troubleshooting are in **[docs/skydo.md](docs/skydo.md)**.

---

## Infinity

Infinity (infinityapp.in; cross-border collections for freelancers, agencies and exporters) publishes **no developer API docs or webhooks**. Its Terms mention an API, but nothing is public, and they forbid reverse engineering or incorporating the Services into other systems, so this project never contacts Infinity. The Infinity adapter offers three modes:

- **Zoho Books bridge** (all `INFINITY_ZOHO_*` variables): Infinity's dashboard has a Zoho Books integration (Connect tab). `payments_create_payment` creates a Zoho invoice with your order reference, using the same reviewed code as Skydo's bridge, and the status is read back from Zoho. An order is paid only when Zoho records payments covering the total. What Infinity's integration syncs is not publicly documented, so confirm with one real invoice that Infinity marks it paid in Zoho.
- **Bank transfer** (`INFINITY_RECEIVING_ACCOUNTS`): your Infinity account details for the client's currency, with the order reference.
- **QuickLink** (`provider_options.quickLinkUrl`): a payment link you create in the Infinity dashboard, which the client pays by card or bank transfer. Only `https` links on Infinity's domain (`INFINITY_QUICKLINK_HOSTS`) are accepted, so a pasted look-alike link is refused.

Without Zoho, the payment is tracked in a ledger and an admin records the receipt with `payments_infinity_record_payment` after checking the Infinity dashboard. Foreign currency only (INR is rejected); no refunds, webhooks or recurring charges. Setup, flow and troubleshooting: **[docs/infinity.md](docs/infinity.md)**.

---

## Verification status

- Three independent verification rounds against official docs, plus adversarial reviews of the money-safety rules and the Skydo bridge; 681 tests. The reports, with the doc URL behind each check and the fixes they caused, are in [docs/research/verification](docs/research/verification) (round 3: [round3-project.md](docs/research/verification/round3-project.md), [round3-skydo.md](docs/research/verification/round3-skydo.md)); the summary is in [docs/design-review.md](docs/design-review.md#round-3). The Skydo API search is in [skydo-api-search.md](docs/research/verification/skydo-api-search.md).
- Infinity: sources for every fact used, and the API search, are in [infinity-api-search.md](docs/research/verification/infinity-api-search.md). Its Zoho and ledger logic is the shared Skydo code (`src/providers/shared/`); a before/after comparison showed Skydo's results, errors and Zoho requests are unchanged by the move. Infinity's own QuickLink, gate and mode rules had a separate adversarial review ([infinity-review.md](docs/research/verification/infinity-review.md)); its one medium and nine low findings are fixed, with regression tests.
- **Not yet run against live gateway sandboxes.** Tests use recorded request/response shapes from the docs. `npm run sandbox:smoke` (see `scripts/sandbox-smoke.ts`) creates small unpaid orders against the sandboxes of the gateways you have test keys for; results from contributors are welcome.
- Facts the docs do not settle are marked in the capability notes (`UNVERIFIED`, "confirm in sandbox"). CCAvenue publishes no public API reference, so its status and refund calls rely on integration kits and third-party implementations.

---

## Claude Skill and ChatGPT kit

- **Claude Skill**: [`skills/india-payments/SKILL.md`](skills/india-payments/SKILL.md). It teaches Claude the integration workflow (capabilities first, integer minor units, verify before fulfil, raw-body webhooks, human approval for refunds). Install it alongside the MCP server.
- **ChatGPT**: [`chatgpt/custom-gpt-instructions.md`](chatgpt/custom-gpt-instructions.md) covers a Custom GPT / connector setup. ChatGPT connectors need a remote server, so run `india-payments-mcp http` behind TLS. See [deployment](docs/architecture.md#k-deployment).
- **Other agents**: [`AGENTS.md`](AGENTS.md) holds conventions for coding agents working in this repo.

---

## Modes

| Mode | Network | Credentials | Use it for |
|---|---|---|---|
| `mock` | none | none | Learning the API, demos, CI, agent experiments. Keeps each gateway's real capability map and mirrors its input rules (ids such as `provider_order_id` / `provider_payment_id` where the real gateway needs them, INR only on PayU/Paytm/PhonePe, duplicate-refund behaviour, refused webhook simulations), so a call that would fail against the real gateway fails in mock too. Skydo, Cashfree, PhonePe and Stripe verify by status lookup, as in real mode. Callbacks and webhooks are HMAC-signed with a fixed mock secret, so tampering is still detected |
| `sandbox` (default) | gateway test hosts | test keys | Integration testing against real gateway behaviour |
| `live` | gateway production hosts | live keys | Real money. Refunds and cancellations are double-gated (see below) |

Set the mode with `PAYMENTS_MODE`. Adapters cross-check key prefixes where the gateway has them. For example, the Razorpay adapter refuses `rzp_live_` keys in sandbox and `rzp_test_` keys in live. Skydo and Infinity are the exception: they have no sandbox, so `sandbox` works on real data (with the `ZOHO_*` / `INFINITY_ZOHO_*` variables set it creates real Zoho Books invoices, and the ledger is your real ledger). Receipt recording is therefore gated in `sandbox` as well as `live`. Use `mock` to try them.

---

## Safety rails

- **Live mutations are double-gated in the MCP server.** In `live` mode, `payments_refund`, `payments_cancel_subscription` `payments_skydo_record_payment` and `payments_infinity_record_payment` (for Skydo and Infinity also in `sandbox`, since Skydo has no sandbox and Infinity documents none) fail with `LIVE_MUTATION_BLOCKED` unless the server runs with `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` **and** the call passes `confirm: true`. Agents are told to get human approval before setting `confirm`. The gate is on because the MCP server creates its client with `guardLiveMutations: true`; SDK users, whose apps have their own authorisation, are not gated unless they pass that option. Webhook simulation is disabled in live mode.
- **Refunds are idempotent by `refund_ref`.** Within one process (the default idempotency cache is in memory, 24 h for refunds) the same `refund_ref` with the same request returns the stored result, and with a different request fails with `IDEMPOTENCY_CONFLICT`. When a refund ends in `OUTCOME_UNKNOWN`, or the gateway rejects the `refund_ref` as a duplicate, the client looks the refund up by `refund_ref` and returns it if it exists (Razorpay needs `provider_payment_id` for that lookup). PayU and CCAvenue have no lookup by `refund_ref`, so there the error stands: check the dashboard before retrying, and never retry with a new `refund_ref`. Across restarts, pass a shared `idempotencyStore`.
- **Order creation is idempotent by `idempotency_key`** (default: `order_ref`) for 10 minutes in process, because cached results carry short-lived checkout data (Paytm `txnToken`, PhonePe redirect URL).
- **Money-moving POSTs are never retried blindly.** Only GETs and requests the gateway de-duplicates are retried. When a non-retry-safe request times out or gets a 5xx, the error is `OUTCOME_UNKNOWN`: it may or may not have happened, so look the payment or refund up before retrying.
- **Verification binds to your order.** `paid` is `true` only when the callback is genuine, the money is collected (`captured` or `partially_refunded`; `authorized`-only and fully `refunded` payments are not paid) **and** you passed both `order_ref` and `expected_amount`. A valid signature for a different order or amount is rejected. For Razorpay, pass the `order_…` id you stored as `provider_order_id`.
- **`provider_options` cannot override core fields or route money.** A baseline list (amount, currency, order id, credentials, hashes, redirect URLs: for example `amount`, `key`, `hash`, `surl`, `order_id`, `merchantUrls`, `success_url`, `line_items`) plus each gateway's own list for payments and subscriptions (splits, transfers, connected accounts, manual capture, partial payments, binding keys such as Stripe `metadata` and Razorpay subscription `notes`) is rejected with `VALIDATION` before any network call. The per-gateway lists are in [docs/security.md](docs/security.md#provider_options-guard). `metadata` cannot override the `order_ref` binding key.
- **Secrets never leave the server.** `check_config` reports env var *names* only. Logs (stderr, JSON) and the audit log redact secret-looking keys. Checkout options contain only publishable values.
- **Audit trail.** Set `PAYMENTS_AUDIT_LOG` to append every create, refund, subscription and Skydo/Infinity receipt action, including blocked ones, as JSON Lines.
- **HTTP transport requires a bearer token** (`MCP_HTTP_TOKEN`, 24+ chars) and binds to `127.0.0.1` by default. It serves the exact path `/mcp` (plus public `/healthz`), validates `MCP_HTTP_PORT`, evicts sessions idle for 30 minutes and refuses new sessions beyond 1,000 (HTTP 503).

Details, PCI-DSS scope and the threat model for agents are in [docs/security.md](docs/security.md).

---

## Project structure

```
src/
  core/          types, errors, capability model, config, HTTP client, idempotency, audit, logger, money, crypto
  providers/     one folder per gateway: capabilities.ts (facts) + adapter.ts (code)
  mock/          network-free gateway used in PAYMENTS_MODE=mock
  webhooks/      framework-agnostic verify -> dedupe -> handle endpoint logic
  mcp/           MCP server: tools, resources, prompts
  codegen/       integration code generator, gateway recommender, support matrix
  client.ts      PaymentsClient: validation, feature gating, idempotency, audit, live rails
  cli.ts         stdio server, `http` transport, `doctor`
test/            vitest suites + fake fetch helpers
docs/            architecture, gateway matrix, payloads, skydo, webhooks, security, testing, reliability, risks, roadmap
  research/      gateway-api-facts.md: sourced facts with VERIFIED / PARTIAL / UNVERIFIED tags
    verification/  line-by-line checks of each adapter against official docs
scripts/         sandbox-smoke.ts: smoke test against real gateway sandboxes
examples/        express-checkout, mcp-clients
skills/          Claude Skill
chatgpt/         ChatGPT setup kit
```

The full layout is in [docs/architecture.md](docs/architecture.md#m-repository-structure).

---

## Documentation

| Doc | Contents |
|---|---|
| [architecture.md](docs/architecture.md) | Design, team responsibilities, tool schema, adapter design, deployment, repo layout |
| [gateway-matrix.md](docs/gateway-matrix.md) | Per-gateway checkout, units, signatures, webhooks, refunds, constraints, plugins, onboarding |
| [payloads.md](docs/payloads.md) | Example request/response for every tool, including errors |
| [skydo.md](docs/skydo.md) | Skydo: status, Zoho Books bridge and ledger setup, flow, limits, troubleshooting, FAQ |
| [infinity.md](docs/infinity.md) | Infinity: status, Zoho Books bridge, bank transfer and QuickLink setup, flow, limits, troubleshooting |
| [webhooks.md](docs/webhooks.md) | Verification per gateway, normalized events, dedupe, ordering, raw-body pitfalls |
| [security.md](docs/security.md) | Secrets, live rails, audit, PCI-DSS scope, RBI rules, agent threat model |
| [testing.md](docs/testing.md) | Mock mode, sandbox setup, contract tests, webhook simulation, CI |
| [reliability.md](docs/reliability.md) | Retries, idempotency, timeouts, reconciliation, failure playbooks |
| [risks.md](docs/risks.md) | Known risks and mitigations |
| [roadmap.md](docs/roadmap.md) | What's next |
| [design-review.md](docs/design-review.md) | Reviewer critique and the changes it caused |

---

## Contributing

Gateway APIs drift, and much Indian gateway documentation is incomplete. The most valuable contributions are:

1. **Fact corrections.** Each one needs a link to the official doc. Use the [API drift](.github/ISSUE_TEMPLATE/api_drift.md) issue template.
2. **Planned features made real**, such as Cashfree subscriptions or PayU settlements.
3. **Sandbox confirmations of facts marked UNVERIFIED**, especially for CCAvenue.

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. It has the add-a-provider checklist and the verification standard.

```bash
npm install
npm run typecheck && npm test
PAYMENTS_MODE=mock npm run inspect   # MCP Inspector against the local server
```

---

## Disclaimer

- This project is **not affiliated with, endorsed by, or sponsored by** Razorpay, PayU, Cashfree, CCAvenue (Infibeam Avenues), Paytm (One97 / Paytm Payments Services), PhonePe, Stripe, Skydo, Infinity (Scalifi Wealth), Shopify or any other company named here. All trademarks belong to their owners.
- This is **not financial, legal, tax or compliance advice**. You remain responsible for PCI-DSS, RBI and other regulatory obligations, and for your agreements with each gateway.
- Gateway behaviour changes without notice. **Verify every flow against the gateway's official documentation and in its sandbox before going live.** Facts in this repo carry a `lastVerified` date and VERIFIED / PARTIAL / UNVERIFIED tags in [docs/research/gateway-api-facts.md](docs/research/gateway-api-facts.md); the doc-by-doc checks are in [docs/research/verification](docs/research/verification).
- The software is provided "as is" under the [MIT License](LICENSE), without warranty of any kind.
