## What and why

<!-- One gateway or one concern per PR. Link the issue. -->

## Type

- [ ] Bug fix
- [ ] New gateway / new feature on a gateway
- [ ] Fact correction / API drift
- [ ] Core / MCP / CLI / DX
- [ ] Docs only

## Verification (required for gateway changes)

- [ ] Every new or changed gateway fact is cited in `docs/research/gateway-api-facts.md` and tagged VERIFIED / PARTIAL / UNVERIFIED
- [ ] UNVERIFIED facts are called out in the capability `notes` / `constraints`
- [ ] `lastVerified` bumped in the touched `capabilities.ts`
- [ ] Tested in the gateway's sandbox (describe below), or explained why not

Sandbox notes:

## Safety

- [ ] No secrets, real keys or customer data anywhere in the diff
- [ ] Money-moving POSTs are `retrySafe` only where the gateway de-duplicates
- [ ] Signatures are compared with `safeEqual`, and webhooks are verified over the raw body
- [ ] New mutating operations go through the live-mutation gate, idempotency and the audit log

## Checks

- [ ] `npm run typecheck`
- [ ] `npm test` (new or updated tests in `test/`)
- [ ] `npm run build`
- [ ] `.env.example`, `docs/gateway-matrix.md`, the README matrix and `CHANGELOG.md` (Unreleased) updated where relevant
