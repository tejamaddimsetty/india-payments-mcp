# india-payments-mcp

One MCP server and TypeScript SDK for Indian payment gateways: **Razorpay, PayU, Cashfree, CCAvenue, Paytm, PhonePe, Stripe and Skydo**. You get one set of tools (`payments_create_payment`, `payments_verify_payment`, `payments_refund`, ...) and one set of types. Amounts are always integer paise, every gateway's checkout is described by four shapes, and webhooks normalize to one event model. Adapters handle the per-gateway hashes, encodings and amount formats. The server tells you, and your agent, which features each gateway actually lacks instead of pretending otherwise. It's built for developers wiring up checkout, vibecoders who want an agent to do it, and AI agents that need to check payment status or issue a refund safely.

> Status: 0.1.0. Seven gateways have working adapters and Skydo is guidance-only (it has no public API). Razorpay and the mock gateway are the reference implementations, and some CCAvenue details are UNVERIFIED. Check the per-gateway support level with `payments_get_capabilities` before relying on a feature. See [Disclaimer](#disclaimer).

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

Legend: **Yes** = implemented here. **Partial** = implemented with caveats. **Planned** = the gateway offers it but this project doesn't wrap it yet (calls fail with `NOT_IMPLEMENTED`). **No** = the gateway doesn't offer it (calls fail with `UNSUPPORTED`).

| Gateway | Create | Verify callback | Status | Refund | Refund status | Webhooks | Customers | Subscriptions | Settlements | Payouts |
|---|---|---|---|---|---|---|---|---|---|---|
| **Razorpay** | Yes (Checkout.js) | Yes (HMAC) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Planned (RazorpayX) |
| **Stripe** | Yes (Checkout redirect, or Payment Element) | Yes (status API) | Yes | Yes | Yes | Yes | Yes | Partial (Checkout `mode=subscription`) | Partial (via payouts list) | Planned (needs Connect) |
| **Cashfree** | Yes (cashfree.js) | Yes (status API) | Yes | Yes | Yes | Yes | Planned | Planned | Planned | Planned |
| **PayU** | Yes (form POST) | Yes (SHA-512 reverse hash) | Yes | Yes | Partial | Partial (payment events) | No | Planned | Planned | Planned |
| **CCAvenue** | Yes (encrypted form POST) | Yes (decrypt `encResp`) | Partial | Partial | Planned | Partial (no signed webhooks: decrypts `encResp`) | No | Planned | Planned | Planned |
| **Paytm** | Yes (JS Checkout + form fallback) | Yes (checksum) | Yes | Yes | Yes | Partial (payment events verified) | No | Planned | Planned | Planned |
| **PhonePe** | Yes (redirect) | Partial (unsigned redirect, verified via status API) | Yes | Yes | Yes | Partial (auth header doesn't sign the body) | No | Planned | Planned | No |
| **Skydo** | No public API | No | No | No | No | No | No | No | No | No |

The table above is a hand-written summary. **`payments_get_capabilities` and the `payments://matrix` MCP resource are the authoritative, generated version.** Both are built from each adapter's `capabilities.ts` and include per-feature notes, hard constraints, required env vars, official SDKs and Shopify/WooCommerce plugins. If this table and the generated matrix disagree, the generated matrix wins. Please open an issue when that happens.

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
| `payments_verify_payment` | Verifies the browser callback payload, binding it to `order_ref` and `expected_amount` | read-only (may call the status API) |
| `payments_get_status` | Fetches the authoritative payment status from the gateway | read-only |
| `payments_refund` | Refunds all or part of a payment. `refund_ref` is the idempotency key. Live mode needs a double gate | **moves money** |
| `payments_get_refund_status` | Fetches refund status | read-only |
| `payments_verify_webhook` | Verifies a webhook against its raw body and normalizes it to a common event | read-only |
| `payments_simulate_webhook` | Builds a correctly signed webhook (plus an optional curl command) for local testing. Disabled in live mode | none |
| `payments_create_customer` | Creates a customer on gateways that have them | creates a record |
| `payments_create_subscription` | Creates a recurring subscription and returns the mandate-authorisation checkout | creates a mandate request |
| `payments_cancel_subscription` | Cancels now or at cycle end. Live mode needs a double gate | **stops billing** |
| `payments_list_settlements` | Lists settlements for reconciliation | read-only |
| `payments_generate_integration` | Generates server routes, client checkout, env template and test checklist for a framework | read-only (returns files) |
| `payments_mock_complete_payment` | **Mock mode only.** Simulates the customer paying or failing and returns a signed callback payload | mock state only |

The server also exposes resources (`payments://matrix`, `payments://providers/{provider}`) and a prompt (`integrate_payments`). The full argument and return schemas are in [docs/architecture.md](docs/architecture.md#d-unified-mcp-tool-schema), and example payloads are in [docs/payloads.md](docs/payloads.md).

---

## SDK usage

```bash
npm install india-payments-mcp
```

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
//    Fulfil only when paid === true (valid only means "genuine": a genuine failure is valid too).
app.post('/api/payments/verify', express.json(), async (req, res) => {
  const result = await payments.verifyPayment('razorpay', {
    orderRef: 'ORD_1001',
    expectedAmount: 49900,
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

## Claude Skill and ChatGPT kit

- **Claude Skill**: [`skills/india-payments/SKILL.md`](skills/india-payments/SKILL.md). It teaches Claude the integration workflow (capabilities first, paise, verify before fulfil, raw-body webhooks, human approval for refunds). Install it alongside the MCP server.
- **ChatGPT**: [`chatgpt/custom-gpt-instructions.md`](chatgpt/custom-gpt-instructions.md) covers a Custom GPT / connector setup. ChatGPT connectors need a remote server, so run `india-payments-mcp http` behind TLS. See [deployment](docs/architecture.md#k-deployment).
- **Other agents**: [`AGENTS.md`](AGENTS.md) holds conventions for coding agents working in this repo.

---

## Modes

| Mode | Network | Credentials | Use it for |
|---|---|---|---|
| `mock` | none | none | Learning the API, demos, CI, agent experiments. Keeps each gateway's real capability map, so unsupported features fail the same way they would for real. Callbacks and webhooks are HMAC-signed with a fixed mock secret, so tampering is still detected |
| `sandbox` (default) | gateway test hosts | test keys | Integration testing against real gateway behaviour |
| `live` | gateway production hosts | live keys | Real money. Refunds and cancellations are double-gated (see below) |

Set the mode with `PAYMENTS_MODE`. Adapters cross-check key prefixes where the gateway has them. For example, the Razorpay adapter refuses `rzp_live_` keys in sandbox and `rzp_test_` keys in live.

---

## Safety rails

- **Live mutations are double-gated.** In `live` mode, `payments_refund` and `payments_cancel_subscription` fail with `LIVE_MUTATION_BLOCKED` unless the server runs with `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` **and** the call passes `confirm: true`. Agents are told to get human approval before setting `confirm`. Webhook simulation is disabled in live mode.
- **Refunds are idempotent by `refund_ref`.** The same `refund_ref` with the same request returns the stored result. The same `refund_ref` with a different request fails with `IDEMPOTENCY_CONFLICT`.
- **Order creation is idempotent by `idempotency_key`** (default: `order_ref`).
- **Money-moving POSTs are never retried blindly.** Only GETs and requests the gateway de-duplicates are retried.
- **Verification binds to your order.** Pass `order_ref` and `expected_amount` to `verify`, and a valid signature for a different order or amount is rejected.
- **Secrets never leave the server.** `check_config` reports env var *names* only. Logs (stderr, JSON) and the audit log redact secret-looking keys. Checkout options contain only publishable values.
- **Audit trail.** Set `PAYMENTS_AUDIT_LOG` to append every create, refund and subscription action, including blocked ones, as JSON Lines.
- **HTTP transport requires a bearer token** (`MCP_HTTP_TOKEN`, 24+ chars) and binds to `127.0.0.1` by default.

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
docs/            architecture, gateway matrix, payloads, webhooks, security, testing, reliability, risks, roadmap
  research/      gateway-api-facts.md: sourced facts with VERIFIED / PARTIAL / UNVERIFIED tags
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

- This project is **not affiliated with, endorsed by, or sponsored by** Razorpay, PayU, Cashfree, CCAvenue (Infibeam Avenues), Paytm (One97 / Paytm Payments Services), PhonePe, Stripe, Skydo, Shopify or any other company named here. All trademarks belong to their owners.
- This is **not financial, legal, tax or compliance advice**. You remain responsible for PCI-DSS, RBI and other regulatory obligations, and for your agreements with each gateway.
- Gateway behaviour changes without notice. **Verify every flow against the gateway's official documentation and in its sandbox before going live.** Facts in this repo carry a `lastVerified` date and VERIFIED / PARTIAL / UNVERIFIED tags in [docs/research/gateway-api-facts.md](docs/research/gateway-api-facts.md).
- The software is provided "as is" under the [MIT License](LICENSE), without warranty of any kind.
