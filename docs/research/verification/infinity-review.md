# Strict review: Infinity adapter and the shared Skydo/Infinity refactor

- **Reviewed:** 2026-10-29, uncommitted working tree on top of `ec96463`. The tree changed while the review ran (for example, `src/client.ts` and `src/providers/infinity/adapter.ts` were rewritten at 11:07). Every proof below was re-run against this final snapshot (sha1 prefixes): `infinity/adapter.ts d31d8833a323`, `shared/manual-collections.ts 3f44500afdf6`, `shared/zoho-bridge.ts 81b3140f51f4`, `shared/zoho.ts b21e96175fb4`, `shared/ledger.ts 7ef00a3349cb`, `shared/accounts.ts c2f85eb8b059`, `client.ts c4e7352e6fc7`, `codegen/templates/infinity.ts 3f8908be4165`, `skydo/adapter.ts b06eb19569ab`.
- **Scope:**
  - The new Infinity gateway: `src/providers/infinity/*`, `src/codegen/templates/infinity.ts`, and the Infinity parts of `client.ts`, `mcp/server.ts`, `codegen/index.ts`, `codegen/recommend.ts`, `mock/mock-gateway.ts` and `test/providers/infinity.test.ts`.
  - The refactor that moved Skydo's ledger, accounts and Zoho code into `src/providers/shared/`.
  - The Infinity docs: `docs/infinity.md`, `infinity-api-search.md`, the README Infinity section and the CHANGELOG.
- **Method:**
  - Read every line in scope. Compared the refactored Skydo adapter with `git show HEAD:src/providers/skydo/*.ts`.
  - **Differential test:** extracted HEAD's `src/` with `git archive` and ran the same scenarios through the old and new Skydo adapters, comparing JSON results, error code/message/hint/provider and every HTTP request. That covered 28 ledger-mode steps, 9 config errors and 4 Zoho scenarios: create new, existing paid with a write-off, void, and auth refused.
  - **Attack tests** for QuickLink validation (30 URL cases), link races, mode confusion, shared ledger files, the MCP gate (18-cell matrix over the real MCP server), mock-versus-real behaviour and paid=true paths.
  - Generated the integration for all 9 frameworks. Checked that every state-changing route calls `assertAdmin` and that no route reads an amount from the body. Typechecked the generated service and admin modules against `src/index.ts` (strict, clean). The Express, Fastify and Next.js route files could not be typechecked: their type packages are not installed.
  - Re-fetched these public www.infinityapp.in pages: the home page, `terms-and-condition`, `faqs/articles/what-quicklinks-are-and-who-can-use-them`, `how-to-track-quicklinks-payments` and `which-currencies-can-i-receive`. No other Infinity host was contacted.
  - The proofs live in the session scratchpad under `review-infinity/` (`skydo-diff.test.ts`, `infinity-attack.test.ts`, `gen.mts`) and are not committed.
- **Tests:** `npm test` passes 673 of 673 in 16 files, and `npx tsc --noEmit` is clean.
- No source files were edited.

## Summary

**No critical or high findings.** Nothing found marks an order paid without a full recorded receipt (ledger) or Zoho payments covering the total (Zoho):

- verify needs the order's own ledger entry or a Zoho invoice whose reference matches;
- a receipt can pay only one order;
- a partial receipt stays pending;
- the MCP gate blocks recording in sandbox and live unless both `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` and `confirm=true`.

**The Skydo refactor is behaviour-identical, with one exception.** In ledger mode, `verifyPayment` without an orderRef now reports `verifiedVia: 'manual_record'` instead of `'status_api'` (L1). That result is `valid: false` either way, so it cannot change a paid decision, but it makes the CHANGELOG's "behaviour and messages are unchanged" untrue as written.

The real defects are one medium and a set of lows:

- **Medium (M1):** in Zoho mode, the "one link per order" guarantee does not hold.
- **Low:** consistency gaps (a fresh link printed for a paid order, a shared ledger file, Skydo env names in Infinity errors), config footguns, a mock drift on the link check, and several documentation overclaims, including a literal `TESTCOUNT` placeholder in the README.

---

## Findings

### M1 (medium). Zoho mode silently accepts a different QuickLink for an existing orderRef

- **Where:** `src/providers/infinity/adapter.ts:212,244`, and `src/providers/shared/zoho-bridge.ts:94-100,151-156`.
- **Problem:**
  - Ledger mode refuses a second, different link (`manual-collections.ts:67-69`, "already has a different payment link").
  - In Zoho mode, `createInvoice` finds the existing invoice by reference and checks only amount and currency. It then returns `checkout.instructions` built from the new `parts`, which include the new link.
  - The Zoho invoice is not updated, so its notes still carry the original link, and no error is raised.
- **Docs that become wrong:** `infinity-api-search.md` ("the code refuses a different link for the same order") and `docs/infinity.md` ("Each order keeps one link").
- **Failure scenario:**
  1. An agent calls `payments_create_payment` again for `ord_z_1`, passing a QuickLink that belongs to another (for example, cheaper) Infinity invoice.
  2. The client receives instructions with link L2 while the Zoho invoice says L1.
  3. The client pays L2. Infinity's Zoho integration (undocumented) books that payment against whatever invoice L2 belongs to.
  4. `ord_z_1` never turns paid, or worse, the payment lands on a different Zoho invoice.
- **This does not mark anything paid without money.** It breaks the documented one-link-per-order invariant, and that invariant is what lets "a payment only ever match one order".
- **Proof** (`infinity-attack.test.ts`, test A): the existing invoice was created with link L1, then createPayment was called with L2.
  ```
  A instructions:
  Zoho Books invoice INV-42 is ready for USD 1200.00.
  ...
  Pay USD 1200.00 online (card or bank transfer): https://pay.infinityapp.in/q/two
  A requests: [ 'POST .../oauth/v2/token', 'GET .../books/v3/invoices', 'GET .../books/v3/invoices/460000000099' ]   <- no write, no error
  ```
- **Suggested fix:** For an existing (non-void) invoice in Zoho mode, either refuse a `quickLinkUrl` that is not already in `invoice.notes` (the full record from `getInvoice` should include `notes`), or ignore the passed link and return the instructions stored on the invoice. Add a test for both.

### L1 (low). Skydo semantic drift: `verifiedVia` on the no-orderRef path

- **Where:** `src/providers/shared/manual-collections.ts:134`, compared with `git show HEAD:src/providers/skydo/adapter.ts:403`.
- **Problem:** Before the refactor, Skydo always returned `verifiedVia: 'status_api'` when no orderRef was passed. Now the ledger path returns `'manual_record'`.
- **Impact:** `valid` is false in both cases, so no paid decision changes. A caller that branches on `verifiedVia` sees different output. The CHANGELOG line "Skydo's behaviour and messages are unchanged" is inaccurate.
- **Proof** (`skydo-diff.test.ts`, the only diff across 28 ledger steps, 9 config errors and 4 Zoho scenarios, including all requests sent):
  ```
  LEDGER DIFFS [ { "i": 10,
    "a": { "ok": { "valid": false, "status": "unknown", "verifiedVia": "status_api",     "reason": "Pass orderRef." } },
    "b": { "ok": { "valid": false, "status": "unknown", "verifiedVia": "manual_record", "reason": "Pass orderRef." } } } ]
  CONFIG DIFFS []
  ZOHO DIFFS []
  ```
- **Suggested fix:** Either keep it (`manual_record` is arguably more correct), document it and add a Skydo test that pins it, or restore `status_api` for Skydo. The differential test is worth committing as a regression guard.

### L2 (low). A paid order can be re-issued with a new, unrecorded QuickLink

- **Where:** `src/providers/infinity/adapter.ts:225-227,245` and `src/providers/shared/manual-collections.ts:71-74`.
- **Problem:**
  - `createEntry` attaches a first link only while the order is `created` or `pending`. For a `captured` or `cancelled` order it returns the entry unchanged.
  - The adapter has already built the instructions text from the newly passed link.
  - The response therefore tells the client to pay L2 "online", while `checkout.url` is undefined and the ledger never records L2.
- **Failure scenario:** After an order is paid, someone (or an agent) "resends the instructions" with a link. The client is asked to pay again, through a link the ledger never knew about.
- **Proof** (test B):
  ```
  B status captured url undefined
  Pay USD 1000.00 online (card or bank transfer): https://pay.infinityapp.in/q/two
  Reference: ord_b_1
  ```
- **Suggested fix:** Build the link text from the entry's stored `paymentUrl` after `createEntry`, not from the input. For a `captured` or `cancelled` order, refuse to issue payment instructions, or return a "nothing to pay" message.

### L3 (low). Skydo and Infinity can share one ledger file, and the entries carry no provider tag

- **Where:** `src/providers/shared/ledger.ts:28-41,169-186` and the `ledgerFile` credentials of both providers.
- **Problem:** Entries are keyed by orderRef alone. If `INFINITY_LEDGER_FILE` and `SKYDO_LEDGER_FILE` point at the same file (an easy copy-paste), each provider reads and writes the other's orders.
- **Effects:**
  - An Infinity receipt marks a Skydo order captured.
  - Skydo's `createPayment` returns an Infinity QuickLink as `checkout.url`.
  - A receipt id is deduped across both providers.
- **Proof** (test C):
  ```
  C infinity record -> infinity captured ; skydo status -> skydo captured
  C skydo checkout.url -> https://pay.infinityapp.in/q/one
  ```
- **Suggested fix:** Store `provider` in each entry (or in the file header). On read, refuse entries from another provider, or refuse a file tagged for one. Two adapters in one process should also refuse to open the same path.

### L4 (low). Zoho errors raised for Infinity name Skydo's `ZOHO_*` variables

- **Where:** `src/providers/shared/zoho.ts:78,93-95,128,173`.
- **Problem:** The error text and hints are still hard-coded to `ZOHO_DATA_CENTER`, `ZOHO_ACCOUNTS_URL` and `ZOHO_ORGANIZATION_ID`.
- **Failure scenario:** An Infinity user follows the hint and sets `ZOHO_ACCOUNTS_URL` or `ZOHO_DATA_CENTER`. That does nothing for Infinity, and setting a partial `ZOHO_*` set makes Skydo fail with "half-configured". The env-name separation exists precisely to avoid this kind of cross-wiring.
- **Proof** (test D):
  ```
  D ZOHO_DATA_CENTER "mars" is not one of com, eu, ... | hint: ... or set ZOHO_ACCOUNTS_URL.
  D2 AUTH infinity | Check ZOHO_DATA_CENTER and that the refresh token (...) belongs to ZOHO_ORGANIZATION_ID.
  ```
- **Suggested fix:** Add an `envPrefix` (`''` or `'INFINITY_'`) to `ZohoConfig` and build every message from it.

### L5 (low). `INFINITY_QUICKLINK_ONLY=true` does not mean "QuickLinks only"

- **Where:** `src/providers/infinity/adapter.ts:167` and `capabilities.ts:44` ("Set to true to use Infinity with QuickLinks only (no bank details). Every payment then needs providerOptions.quickLinkUrl.").
- **Problem:** The flag only relaxes the constructor check. If `INFINITY_RECEIVING_ACCOUNTS` is also set, bank details are printed and payments without a link are accepted.
- **Proof** (test E): with `quickLinkOnly: 'true'` and accounts set, a link-less payment returns `"Please pay USD 1000.00 by bank transfer."`.
- **Suggested fix:** When the flag is true, require `quickLinkUrl` on every payment and suppress the account details. Alternatively, refuse the combination at construction.

### L6 (low). `INFINITY_QUICKLINK_HOSTS` accepts public suffixes and IP addresses

- **Where:** `src/providers/infinity/adapter.ts:88,111`.
- **Problem:** The host regex accepts `co.in`, `in.net` or `10.0.0.1`. Because subdomains are always allowed, `co.in` admits every `*.co.in` site.
- **Proof** (test F): with hosts `co.in`, `validateQuickLink('https://evil-pay.co.in/q')` is accepted, and so is `https://10.0.0.1/q` with hosts `10.0.0.1`.
- **Suggested fix:** Reject IPv4-looking entries. Either require entries to end in `infinityapp.in` (or an explicit list of Infinity domains), or require at least a registrable domain. Also consider an exact-host mode with no subdomain wildcard for custom entries.

### L7 (low). Mock mode accepts a QuickLink the real adapter refuses

- **Where:** `src/mock/mock-gateway.ts:117-150` and `src/client.ts:336-339`.
- **Problem:** Mock `createPayment` ignores `providerOptions.quickLinkUrl`. Code tested in mock mode passes with a phishing link, then fails in sandbox and live. This fails safe, but contradicts the stated goal that "mock mode behaves exactly like the real adapter". The currency drift seen at the start of the review was fixed in `client.ts:224` during the review.
- **Proof** (test J): `mock: created VALIDATION | real: VALIDATION VALIDATION`. The phishing link gives `created` in mock and `VALIDATION` in the real adapter; `currency: 'US'` now gives `VALIDATION` in both.
- **Suggested fix:** Run `validateQuickLink` (with the default hosts) in `PaymentsClient.createPayment` for `infinity`, so every mode gets the check.

### L8 (low). Attaching a QuickLink within 10 minutes is refused through `PaymentsClient`

- **Where:** `src/client.ts:345-351`, where the createPayment idempotency key is the orderRef and the fingerprint includes `providerOptions`.
- **Problem:** The adapter supports "attach a first link to an order that had none" and "ask again without a link reuses the stored link" (`adapter.ts:211`). Through the client, either call within 10 minutes of the first request fails with `IDEMPOTENCY_CONFLICT`. The SDK, the MCP server and the generated `requestPayment` all go through the client. This fails closed, but the advertised flow does not work, and the message points at idempotency keys rather than the link.
- **Proof** (test I): `IDEMPOTENCY_CONFLICT Idempotency key "ord_i_1" was already used for a different infinity:create_payment request.`
- **Suggested fix:** For no-API providers (whose adapters are already idempotent per orderRef), skip the client-level createPayment cache. Alternatively, document that the attach flow needs a new `idempotencyKey`.

### L9 (low). Documentation and honesty issues

| # | Where | Problem | Evidence | Fix |
|---|---|---|---|---|
| a | `README.md:5,216` | The literal placeholder `TESTCOUNT tests pass` / `TESTCOUNT tests` would ship. HEAD had a real number | `grep TESTCOUNT README.md` gives 2 hits; the current count is 673 | Put in the number |
| b | `infinity-api-search.md:3` vs `:12` | Line 3 says "Nothing was sent to Infinity beyond plain page loads of its public website". Line 12 reports `api.infinityapp.in` "Responds 404 at `/`", and probing the `docs.`/`developer.` hosts is also reported. `api.` is not the public website | Lines 3 and 12 of the same file | Say exactly what was requested (one GET of `https://api.infinityapp.in/`, DNS lookups), or drop the row |
| c | `infinity-api-search.md`, Terms row | It omits that Terms B.5 names the documentation URL `https://docs.infinityapp.in/` | Re-fetched Terms: "API Documentation" means the API reference guide at docs.infinityapp.in. B.4 says the API "enables you to develop and customize your own dashboard". The quotes for O.4, O.6 (incorporating into other systems) and P.6 are accurate | Cite B.4/B.5 so a reader knows an API is contractually described, and say the named docs host does not resolve |
| d | `docs/infinity.md:3` | "Y Combinator-backed" has no source in the sources table. On the re-fetched home page it appears only inside a link URL ("from-y-combinator-and-others"). "Bengaluru" is supported (the home page lists a Bangalore address) | Home page re-fetch | Add the source or drop the phrase |
| e | capabilities and docs: "Infinity has no sandbox" | Stated as fact, but nothing public says so; the Terms do not mention a sandbox or test mode | Terms re-fetch | Write "no sandbox is documented" |
| f | `docs/infinity.md:98-104` | It lists `POST /refresh` and `GET /outstanding` for Express, Fastify **and Next.js**. Generated Next.js has only `invoices`, `invoices/[orderRef]`, `receipts` and `poll` | `gen.mts` output: nextjs, 8 files | Add the two Next.js routes, or reword |
| g | `docs/infinity.md:107` | "Every framework variant typechecks against real Express, Fastify and Next.js types. The Express server was run…" No test or script in the repo does this, and the reviewer could not reproduce it (no `@types/express`, `fastify` or `next` installed). The service and admin modules do typecheck against `src/index.ts` | `ls node_modules/@types` shows only chai, deep-eql, estree, node | Commit the check, or say it was done once by hand |
| h | `receiptId` = "the Infinity transaction reference" (`adapter.ts:185`, MCP schema, docs) | The QuickLink tracking article mentions only an "invoice or link reference", not a per-payment transaction reference. If admins use the invoice reference, a second equal instalment on the same invoice is silently deduped. This fails safe (the order stays pending), but it is confusing | Re-fetched `how-to-track-quicklinks-payments` | Say "a reference unique to this receipt (e.g. the transaction id in the dashboard, or invoice-ref + date)", and note the instalment case |
| i | README Verification status | "Skydo's 57 regression tests cover it [the shared code]". They do not cover the Infinity-only branches in the shared code (link attach in `createEntry`, `method()` callback, `paymentUrl`) | Code reading | Say "cover the Skydo paths" |

---

## Attacks tried that held

- **Paid without money:**
  - verify for a big order with the `providerOrderId` and payload of a paid cheap order gives `paid: false`. An unbound verify gives `paid: false`. `expectedAmount` mismatch gives `paid: false`.
  - A cheap order's receipt id reused on the big order (case and space variants) gives `IDEMPOTENCY_CONFLICT`.
  - 99999 of 100000 cents stays `pending` with `paid: false` (test K).
  - Re-create with a different amount or currency is refused, in both ledger and Zoho modes.
  - Zoho: a write-off, or credits short of the total, is never captured. A `providerOrderId` whose invoice reference is a different order is refused. A `skydo:`/`infinity:` providerOrderId falls back to lookup by reference.
- **QuickLink races:** two processes attaching different links to the same order at once: exactly one succeeds and the other gets "different payment link" (test K race, real file lock). A link can never be replaced, only attached once.
- **Mode confusion:**
  - Zoho mode refuses `recordPayment`, and `outstanding()` returns `[]` with a pointer to Zoho.
  - A broken ledger file cannot block Zoho mode.
  - Skydo's full `ZOHO_*` set leaves Infinity in ledger mode. Infinity's `INFINITY_ZOHO_*` cannot reach Skydo, because the config keys come only from each provider's credential specs.
  - A half-configured `INFINITY_ZOHO_*` set is refused and the missing names are listed.
- **QuickLink URL validation** (30 cases, test G), all safe:
  - Rejected: look-alike suffix and prefix (`infinityapp.in.evil.com`, `evilinfinityapp.in`), Cyrillic homoglyph and punycode, trailing dot, userinfo (`user:pw@`, `infinityapp.in@evil.com`), non-default port, `http:`, `javascript:`, `data:`, `wss:`, protocol-relative, IPv6 and hex IP, URLs over 2048 chars, and the backslash tricks `evil.com\@…` and `evil.com\.infinityapp.in`.
  - Accepted, but always normalised to an Infinity host: uppercase, surrounding whitespace, `:443`, an embedded tab, `%2E`, the full-width dot, `infinityapp.in\evil.com` (which becomes the path `/evil.com`), and a fragment.
  - Error text echoes only host and scheme, never userinfo. It does echo the raw value when the value does not parse as a URL.
- **MCP gate** (18-cell matrix, real MCP server, test H): `payments_infinity_record_payment` is `LIVE_MUTATION_BLOCKED` in sandbox and live for every combination except `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` with `confirm=true`. The block is audited, and mock mode refuses the tool.
- **providerOptions:** the baseline protected keys still apply (`amount`, `currency`, `line_items`, `receipt` and others). `quickLinkUrl` is validated in both ledger and Zoho modes.
- **Ledger semantics:** `shared/ledger.ts` differs from HEAD's `skydo/ledger.ts` only in the class name, the label/provider parameters and the `paymentUrl?` field (diff checked). The lock, stale-lock break, fsync+rename and re-read inside the lock are unchanged. Infinity defaults to its own `infinity-ledger.json`.
- **Generated code** (all 9 frameworks):
  - Every state-changing route (create invoice, refresh, receipts, poll, outstanding) calls `assertAdmin`, which compares tokens in constant time and refuses an empty token.
  - No amount is read from a request body.
  - `refreshStatus` binds `orderRef` and `expectedAmount` and fulfils only on `paid && !fulfilled`, with the flag set before `onPaid`.
  - Polling skips fulfilled and cancelled orders. It starts only when `INFINITY_ZOHO_REFRESH_TOKEN` is set, so Skydo's token does not trigger it.
  - The service and admin modules typecheck (strict).
- **Skydo refactor:** apart from L1, the outputs, error code/message/hint/provider and every HTTP request are byte-identical between HEAD and the working tree. That covers ledger mode, config errors (missing, empty, non-file, bad currency, empty details, bad JSON, half-configured Zoho, bad data center, unreadable ledger) and the Zoho create/existing/void/auth-failure flows. All 57 Skydo tests pass unmodified.
- **Honesty spot-checks that held** (re-fetched):
  - Currencies "USD, EUR, GBP, AUD, CAD", and SWIFT "for currencies where local rails are not supported".
  - The QuickLink definition, availability ("currency, country, method, and account review") and "does not mean a client has paid".
  - The statuses pending, completed and failed, and "use the actual status displayed in your account".
  - Flat 0.5% on the home page.
  - Terms O.4 and O.6 (reverse engineering, "incorporate the Services into other systems") and P.6 (Dashboard and APIs are Confidential Information), quoted accurately.
  - support@infinityapp.in (Terms §K).
