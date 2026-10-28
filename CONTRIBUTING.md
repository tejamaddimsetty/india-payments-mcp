# Contributing

Thanks for helping. This project is only as good as its facts. A gateway adapter that is 95% right moves the wrong amount 5% of the time, so the bar for gateway facts is higher than the bar for code style.

## Setup

```bash
git clone https://github.com/tejamaddimsetty/india-payments-mcp.git
cd india-payments-mcp
npm install
npm run typecheck && npm test
PAYMENTS_MODE=mock npm run inspect     # MCP Inspector against your working tree
PAYMENTS_MODE=mock npm run doctor
```

Node 20+. Tests never hit the network. Use `fakeFetch` / `testContext` from `test/helpers.ts`.

## Verification standard

Every gateway fact (URL, header, field, hash input, status value, limit) must be:

1. **Cited**: link the official doc page, or the gateway's own open-source library, in `docs/research/gateway-api-facts.md` next to the fact.
2. **Tagged**:
   - **VERIFIED**: you read it on the official page or in the vendor's library.
   - **PARTIAL**: the official source confirms part of it.
   - **UNVERIFIED**: community knowledge, third-party copies, or inference. Say so in the capability `notes` / `constraints` too.
3. **Dated**: bump `lastVerified` in the gateway's `capabilities.ts` when you re-check it.

Blog posts, Stack Overflow answers, and "it worked for me" aren't sources on their own. They're fine as a lead, and the fact stays UNVERIFIED until someone confirms it. A sandbox test you ran is good evidence. Say what you ran and when.

Never guess a signature or encryption scheme. If the algorithm isn't documented, leave the feature `partial` or `not_implemented` and explain why (see PhonePe's HMAC webhook headers).

## Adding a provider: checklist

- [ ] Research section added to `docs/research/gateway-api-facts.md`: base URLs (sandbox/live), auth, create, status, refund, refund status, callback verification, webhook verification, amount unit, id constraints. Every row is cited and tagged
- [ ] Provider id added to `PROVIDER_IDS` (`src/core/types.ts`), plus a `CheckoutAction` SDK name if it needs a new browser SDK
- [ ] `src/providers/<id>/capabilities.ts`: every `FEATURE_KEYS` entry filled. `unsupported` only when the gateway lacks it, and `not_implemented` when we do. Credentials listed with env var names, `required`, `secret`. Blunt `constraints`. `lastVerified`
- [ ] `src/providers/<id>/adapter.ts` exporting a `ProviderModule`, registered in `src/providers/index.ts`
  - [ ] `create()` validates credentials (`CONFIG_MISSING`) and mode/key consistency where detectable (`CONFIG_INVALID`)
  - [ ] Converts paise ↔ the gateway's format at the boundary only
  - [ ] Uses `ctx.http.request`, never global `fetch`. `retrySafe: true` only where the gateway de-duplicates
  - [ ] Uses `safeEqual` for every signature/hash comparison. Webhooks are verified over `rawBody`
  - [ ] `verifyPayment` returns `valid: false` + `reason` (doesn't throw) and enforces `orderRef` / `expectedAmount`
  - [ ] `parseWebhook` throws `SIGNATURE_INVALID` on a bad signature and returns a stable dedupe `id`
  - [ ] Unknown statuses map to `unknown`. `raw` is always populated
  - [ ] `simulateWebhook` round-trips through `parseWebhook`
  - [ ] `extractError` pulls the gateway's error code and message
- [ ] Tests in `test/providers/<id>.test.ts`: exact outbound requests, known-vector signatures, tamper cases, status mapping, webhook round-trip, error mapping, credential validation
- [ ] Env vars added to `.env.example` with placeholder values
- [ ] `docs/gateway-matrix.md` and the README matrix updated. `payments://matrix` regenerates itself
- [ ] `npm run typecheck && npm test && npm run build` pass

## Implementing a "Planned" feature

Same standard, smaller scope: research rows, a capability level change (`not_implemented` → `supported` or `partial` with notes), the adapter method, and tests. If the feature moves money (refunds, payouts, cancellations), route it through the client's live-mutation gate and idempotency, and add it to the audit log.

## Reporting API drift

Gateway changed something? Open an issue with the **API drift** template. Include the doc link, the old and new behaviour, and the error you saw (redacted). A failing sandbox call with the request shape is ideal.

## Pull requests

- Keep PRs to one gateway or one concern.
- No new runtime dependencies without discussion. The package ships with two (`@modelcontextprotocol/sdk`, `zod`) by design.
- No secrets, real keys or real customer data in code, tests, fixtures or issues. Use obvious placeholders.
- Update `CHANGELOG.md` under "Unreleased".
- Fill in the PR template, including the verification section.

## Security issues

Don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
