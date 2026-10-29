# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor, Copilot, etc.) working **on this repository**. If you are integrating payments into some *other* project, read `skills/india-payments/SKILL.md` instead.

## What this is

`india-payments-mcp`: an MCP server and TypeScript SDK that puts Razorpay, PayU, Cashfree, CCAvenue, Paytm, PhonePe, Stripe, Dodo Payments, Skydo and Infinity behind one interface. Node ≥ 20, ESM, TypeScript, zero runtime dependencies beyond `@modelcontextprotocol/sdk` and `zod`. Gateways are called with plain `fetch`, never vendor SDKs.

## Layout

```
src/
  index.ts                 public SDK exports
  cli.ts                   stdio server (default), `http` (Streamable HTTP, bearer auth), `doctor`
  client.ts                PaymentsClient: validation, capability gating, idempotency, audit, live-mode rails, mock swap
  core/
    types.ts               unified types; amounts are integer minor units (paise for INR, cents for USD)
    capabilities.ts        ProviderCapabilities + SupportLevel (supported|partial|not_implemented|unsupported)
    gateway.ts             PaymentGateway interface + ProviderModule
    errors.ts              PaymentError codes (UNSUPPORTED, NOT_IMPLEMENTED, SIGNATURE_INVALID, LIVE_MUTATION_BLOCKED, ...)
    config.ts              env → config; credentials come from each provider's CredentialSpec
    crypto.ts money.ts http.ts idempotency.ts audit.ts logger.ts
  providers/<id>/
    capabilities.ts        the capability map: source of truth for what works
    adapter.ts             the gateway implementation (ProviderModule)
  providers/shared/        code shared by the no-API collection adapters (Skydo, Infinity): receiving accounts, ledger, manual collections, Zoho Books bridge
  providers/index.ts       registry
  mock/mock-gateway.ts     network-free gateway used when PAYMENTS_MODE=mock
  webhooks/handler.ts      framework-agnostic verify → dedupe → handle
  codegen/                 payments_generate_integration templates, recommendations, support matrix
  mcp/server.ts            MCP tools, resources, prompts, server instructions
test/                      vitest
docs/research/gateway-api-facts.md   per-gateway facts with VERIFIED / PARTIAL / UNVERIFIED labels (Dodo Payments: docs/research/dodo-api-facts.md)
skills/india-payments/     Claude Agent Skill for people integrating payments (docs, not code)
chatgpt/                   Custom GPT instructions, knowledge files, connector setup, generic system prompt
```

## Commands

```bash
npm install
npm test              # vitest run (must pass)
npm run typecheck     # tsc --noEmit (must pass)
npm run build         # emit dist/
npm run dev           # run the MCP server on stdio from source
npm run doctor        # which gateways are configured
npm run inspect       # MCP Inspector against the source server
PAYMENTS_MODE=mock npm run dev   # everything works without credentials
```

Run `npm test` and `npm run typecheck` before declaring any change done.

## Rules

1. **Never fake support.** If a gateway does not offer a feature, its capability is `unsupported` and the adapter does not implement it. If it offers it but we have not built it, `not_implemented`. Do not return synthetic success, stub data or a guessed endpoint. Skydo has no API: the adapter never calls Skydo, it automates Skydo's Zoho Books integration or a local ledger (`partial` create/verify/status), and everything else is `unsupported`. Infinity is the same: the adapter never calls Infinity (no public API; its Terms forbid reverse engineering) and automates a Zoho Books bridge or a ledger fed by receiving-account details and/or a QuickLink the merchant created in the dashboard. Dodo Payments is a Merchant of Record with no ad-hoc prices: the adapter charges a product that exists in Dodo and refuses (before any POST) a product whose listed price is not exactly `amount` (or pay-what-you-want); it never creates products.
2. **The capability map is the source of truth.** `providers/<id>/capabilities.ts` drives `PaymentsClient` gating, `payments_list_providers`, `payments_recommend_gateway`, the support matrix, and docs. When you implement or remove a feature, update the map in the same change. A method that exists on the adapter while the map says `not_implemented` is still refused by the client.
3. **Facts come from `docs/research/gateway-api-facts.md` (Dodo Payments: `docs/research/dodo-api-facts.md`) or an official URL.** Cite the URL in a code comment or the capability `notes` for anything non-obvious (endpoints, signature formats, field limits). If you cannot verify a fact, mark it UNVERIFIED in comments and keep it configurable. Do not "fix" a documented algorithm from memory.
4. **Keep adapters isolated.** An adapter imports only from `src/core/*`, its own folder and `src/providers/shared/*` (no-API collection code used by Skydo and Infinity). No adapter imports another adapter. Gateway-specific logic never leaks into `client.ts`, `mcp/server.ts` or `codegen/` beyond what the capability map exposes.
5. **Amounts are integer minor units of the currency at every public boundary** (paise for INR, cents for USD). Conversion to rupees/strings happens inside the adapter via `core/money.ts`. Never use floating-point arithmetic on money.
6. **Verification is constant-time and on raw bytes.** Use `core/crypto.ts` helpers. Webhook verification takes the raw body string; never re-serialise parsed JSON.
7. **Secrets never leave the process.** Not in tool results, errors, logs, audit entries or `raw` payloads. `payments_check_config` reports presence only.
8. **Live-mode safety rails stay.** Refunds and subscription cancellations in live mode, and Skydo/Infinity receipt recording in every non-mock mode (Skydo has no sandbox and Infinity documents none; `NO_SANDBOX` in `client.ts`), require `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` and `confirm=true`. Webhook simulation is disabled in live mode. `paid` stays `captured` / `partially_refunded` only. Do not weaken these.
9. **Tests never hit the network.** Inject `fetch` and the clock through `AdapterContext`. Use recorded/fixture payloads; signature tests must include a tampered-body case and a wrong-secret case.
10. **Do not add runtime dependencies** without a strong reason. No vendor SDKs.

## Adding or extending a provider

1. Add the id to `PROVIDER_IDS` in `src/core/types.ts` (new gateways only).
2. `src/providers/<id>/capabilities.ts`: fill every `FEATURE_KEYS` entry honestly, `credentials` (env var names `<ID>_*`), `constraints` (blunt, things developers will trip over), `providerAmountFormat`, `checkoutTypes`, `officialSdks`, `platformPlugins`, `lastVerified`. Copy the shape of `providers/razorpay/capabilities.ts`.
3. `src/providers/<id>/adapter.ts`: export a `ProviderModule` whose `create(credentials, ctx)` validates credentials (throw `CONFIG_MISSING` / `CONFIG_INVALID`, e.g. live mode with a test key) and returns a `PaymentGateway`. Implement only what the capability map says is supported/partial. Map provider statuses to `PaymentStatus`; keep the untouched response in `raw`. Implement `extractError` so HTTP errors carry the provider's code/message. Set `protectedOptionKeys` (payment / subscription) for every request field that carries the amount, the binding keys, redirect or notification URLs, or routes money elsewhere (splits, transfers, connected accounts, manual capture); `PaymentsClient` refuses them in `providerOptions` on top of its baseline list. Implement `simulateWebhook` so `parseWebhook(simulateWebhook(x))` round-trips.
4. Register it in `src/providers/index.ts`.
5. Tests in `test/`: request shape per endpoint (fake fetch), amount conversion, status mapping, callback verification (valid / tampered / wrong amount / wrong order), webhook verification (valid / tampered / replayed), refund idempotency, error extraction.
6. Mock: if the real adapter needs ids, accepts only some currencies or rejects duplicate refund references, mirror that in `src/mock/mock-gateway.ts` so mock-mode code fails the same way.
7. Codegen: make sure `payments_generate_integration` produces correct server/client code for the checkout type.
8. Docs: add `skills/india-payments/references/<id>.md`, update `docs/research/gateway-api-facts.md` with sources, regenerate `chatgpt/knowledge/gateway-reference.md` (command in `chatgpt/custom-gpt-instructions.md`), update the README support matrix.

## MCP tools

Changing a tool's name, arguments or semantics is a breaking change for every agent prompt, skill and Custom GPT that references it (`skills/`, `chatgpt/`). Update those files in the same change. Tool descriptions are prompts: keep them short, factual and explicit about safety (minor units, raw body, confirm=true).

## Style

TypeScript strict. Small pure functions for signing/verification. Errors are `PaymentError` with a one-sentence actionable `hint`. Comments explain *why* (gateway quirks with source URLs), not *what*.
