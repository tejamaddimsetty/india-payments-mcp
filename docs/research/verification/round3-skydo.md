# Round 3 strict review: Skydo adapter (Zoho Books bridge and ledger)

- **Reviewed:** 2026-10-29, commit `d9c006a` ("Round 2 verification fixes; harden Skydo bridge").
- **Scope:** `src/providers/skydo/*`, the Skydo parts of `src/client.ts` and `src/mcp/server.ts`, `src/codegen/templates/skydo.ts` and `src/codegen/index.ts` (generated for all 9 frameworks), `test/providers/skydo.test.ts`, `docs/skydo.md` and the other docs that mention Skydo.
- **Method:**
  - Read every line of the code above.
  - Generated the integration for every framework and typechecked the service module (clean).
  - Ran scratch reproductions against the real code, with a stateful fake Zoho and real multi-process ledger writers. They live in the session scratchpad under `r3/` (`repro.mts`, `ledger-race.mts`, `ledger-worker.mts`, `gen.mts`) and are not committed.
  - Checked the Zoho OpenAPI files (`invoices.yml`, `contacts.yml`) with pyyaml, and the live Zoho Books API introduction (rate limits, data centers).
  - Checked Skydo's FAQ CMS JSON, the Zoho-integration blog post and the Terms of Use (numbered with an `<ol>` walker).
- **Tests:** `npx vitest run test/providers/skydo.test.ts` passes 49 of 49.
- No source files were edited.

## Summary

The round-2 fixes are mostly genuine. The ledger lock holds under 6 real processes × 30 writes, with no lost updates even when it starts from a stale lock. Write-off and credit closures are no longer "paid". `providerOrderId` is bound to `orderRef`. Receipts are idempotent.

**Three new high-severity problems remain:**
- The twin-invoice fix voids **both** invoices in a real race.
- The new confirm gate does not apply in `sandbox` mode, which is the default mode and is live for Skydo.
- `docs/skydo.md` (committed in HEAD) still describes the pre-fix behaviour in about 15 places, including an MCP example that now fails validation.

---

## Round-2 findings: status

| # | Status | Evidence |
|---|---|---|
| C1 ledger lost updates | **FIXED** | `ledger.ts:87-143` locks with `openSync(lock,'wx')` and re-reads inside the lock, writes tmp then rename, and `get`/`list` re-read. Repro `ledger-race.mts`: 6 processes × 30 updates gives "expected 180 receipts, got 180" from a clean start, and the same from a 60-second-old stale lock. Residual issues are listed under N13-N15 |
| H1 write-off/credits reported paid | **FIXED** (one nuance, N6) | `adapter.ts:83-95`. `getPaymentStatus` always calls `getInvoice` (`adapter.ts:348`). String amounts (`"1250.00"`) work (repro R3b) |
| H2 cross-order providerOrderId | **FIXED** | `adapter.ts:350-352`; test at `:417` |
| H3 duplicate receipts | **FIXED** (minor gap, N18) | `adapter.ts:401-418` dedupes by `receiptId`, and a conflicting amount gives `IDEMPOTENCY_CONFLICT` |
| H4 agent marks paid without confirm | **PARTIAL** | The gate exists (`client.ts:190`) but only bites when `PAYMENTS_MODE=live`. For Skydo, sandbox is live, and sandbox is the default. See N2 |
| M1 draft never re-sent | **FIXED** | `adapter.ts:227-230` |
| M2 accountsUrl override first call fails | **FIXED** | `zoho.ts:147-151` builds the URL after `await accessToken()` |
| M3 UAE/UK/SG missing | **FIXED in code** | `zoho.ts:23-25` and `capabilities.ts:38`. `docs/skydo.md:108-117,440` are still stale (N3) |
| M4 lookup page size / duplicates | **PARTIAL** | Pagination is fixed (`zoho.ts:215-229`, `per_page=200`, `has_more_page`). The twin-voiding logic is wrong and voids both invoices (N1) |
| M5 void shows NOT_FOUND | **FIXED** | `zoho.ts:232-235` and `adapter.ts:197-199`. A void-only reference now refuses re-issue (a deliberate choice, explained in the error) |
| M6 wrong customer | **PARTIAL** | Email lookup is fixed (`zoho.ts:189-206`). The `zohoCustomerId` path is still unchecked (N9) |
| M7 unverifiable claims | **PARTIAL** | `capabilities.ts` is fixed: no § citation, "32 currencies", InstaLinks-only recurring. Still open: the guide heading "fully automatic, recommended" (`skydo.ts:358`) and the codegen warning "(automatic)" (`codegen/index.ts:209`), N10. The refund wording over-generalises an ACH-only FAQ (N20) |
| M8 broken ref / stale docs | **PARTIAL** | `docs/skydo.md` now exists but is stale (N3). Also still stale: `roadmap.md:11` "Skydo (guidance only)", `payloads.md:119` "§25.8.12" and `skydo-api-search.md:15,57,190,221` (N11) |
| M9 "paise" wording | **FIXED in MCP** | `server.ts:14,54,203,461`. `README.md:3` still says "Amounts are always integer paise" (N11) |
| M10 public route burns Zoho quota | **FIXED** | The public GET reads `storedStatus` only (`skydo.ts:107-110,152-156,243-253,326-330`). Refresh is admin-only |
| L1 minimum non-USD | **FIXED** (documented and noted per call) | `adapter.ts:177`, `capabilities.ts:55` |
| L2 received_at | **PARTIAL** | Only `Date.parse` is checked (`adapter.ts:405`). It accepts `"1"` (year 2001) and future dates, and the MCP schema is a bare `z.string()` (`server.ts:462`). See N16 |
| L3 ISO currency | **FIXED** | `adapter.ts:167` |
| L4 refresh rate-limit label | **PARTIAL / UNVERIFIED** | `zoho.ts:119` handles an HTTP-200 `{"error":...}` only. See N17 |
| L5 dir perms | **FIXED** | `ledger.ts:89` uses `mode: 0o700` |
| L6 corrupt ledger blocks Zoho | **FIXED** | `adapter.ts:147-148` |
| L7 template 2-decimals | **FIXED** | `skydo.ts:49` uses `toMajorString` |
| L8 Canada host in guide | **FIXED in guide** | `skydo.ts:372-373`. Not fixed in `docs/skydo.md` |
| L9 exchange_rate | **FIXED** | `capabilities.ts:53` |
| L10 GBP reference length | **FIXED** | `adapter.ts:178-180` |
| L11 Zoho gateway bypass | **FIXED** | `capabilities.ts:52`, `skydo.ts:399` |

---

## HIGH

### N1. Twin-invoice voiding voids BOTH invoices in a real race, and the orderRef is then dead
- **Location:** `adapter.ts:218-223`.
- **Problem:** Each process removes **its own** invoice from the candidate list (`i.invoice_id !== invoice.invoice_id`) and then voids its own invoice whenever *any* twin exists. In a true race both processes see the other's invoice, so both void their own, and each returns the other's (now void) invoice.
- **What happens next:**
  - `markSent` is called on a void invoice and the call fails.
  - On retry, `findInvoiceByReference` finds only void invoices, so `createPayment` throws "was voided. Use a new orderRef".
  - The customer cannot be invoiced under that order.
- **Repro** (`r3/repro.mts` R1: two gateways share one stateful fake Zoho, and both creates complete before either twin lookup):
  ```
  R1 twin race results: [ 'ERR skydo zoho_mark_sent failed (HTTP 400)', 'ERR skydo zoho_mark_sent failed (HTTP 400)' ]
  R1 zoho invoices: [ '460000000100:void', '460000000101:void' ]
  ```
- **Why it matters:** This is exactly the scenario the code was added for: the app and the MCP server, or two serverless instances of the generated Next.js route on a double-submit. Without the twin logic you would get two live invoices. With it you get zero.
- **Test gap:** The M4 test (`skydo.test.ts:451`) only simulates the process whose invoice is newer, so the symmetric side was never exercised.
- **Secondary issue:** `created_time` has one-second resolution (`"2013-11-18T02:17:40-0800"`, invoices.yml), so ties are likely in a race. The `invoice_id` fallback compares strings lexicographically.
- **Fix:** Every process must compute the **same** winner from the full set, including its own invoice, and void only if it is not the winner:
  ```ts
  invoice = await zoho.createInvoice(body, opts.sendEmail === true);
  const live = (await zoho.findInvoicesByReference(input.orderRef)).filter((i) => i.status !== 'void');
  if (!live.some((i) => i.invoice_id === invoice!.invoice_id)) live.push(invoice); // search may lag
  const key = (i: ZohoInvoice) => [i.created_time ?? '', i.invoice_id.padStart(25, '0')] as const;
  live.sort((a, b) => { const [ta, ia] = key(a), [tb, ib] = key(b); return ta === tb ? ia.localeCompare(ib) : ta.localeCompare(tb); });
  const winner = live[0]!;
  if (winner.invoice_id !== invoice.invoice_id) {
    await zoho.markVoid(invoice.invoice_id);
    invoice = await zoho.getInvoice(winner.invoice_id); // full record: invoice_url, payment_made
  }
  ```
- **Tests to add:**
  - The R1 two-gateway race, asserting exactly one non-void invoice and both calls returning the same `invoice_id`.
  - The older-process side of the existing M4 test.
- **Docs:** State in `docs/skydo.md` that Zoho search lag can still yield two live invoices (no cross-process lock exists), and say how to void one.

### N2. The confirm gate for recording receipts is off in `sandbox`, which for Skydo is live data and is the default mode
- **Location:** `client.ts:218-219` (`if (this.config.mode !== 'live' || !this.guardLiveMutations) return;`), called at `client.ts:190`. `cli.ts:19` sets the default to sandbox. `docs/skydo.md:51` and `README.md:220` say sandbox behaves like live for Skydo.
- **Repro** (R4, `PaymentsClient({ guardLiveMutations: true })` as the MCP server builds it, same ledger file):
  ```
  R4 sandbox: recorded without confirm -> captured
  R4 live: LIVE_MUTATION_BLOCKED Recording a Skydo receipt on skydo in LIVE mode is blocked.
  ```
- **Why it matters:** An agent on an MCP server left at the default mode can mark a real order paid from a forged "Skydo: payment received" email. That is the exact H4 attack, still open in the default configuration. The ledger file is the same default path in both modes.
- **Fix (pick one):**
  - **(a)** In `assertLiveMutationAllowed`, treat Skydo as live in every non-mock mode:
    ```ts
    const effectivelyLive = this.config.mode === 'live' || (provider === 'skydo' && this.config.mode !== 'mock');
    if (!effectivelyLive || !this.guardLiveMutations) return;
    ```
  - **(b)** Refuse to construct the real Skydo gateway in `sandbox` (`CONFIG_INVALID`: "Skydo has no sandbox; use mock or live").
- **Also:** Update the tool description (`server.ts:457`, "In live mode needs confirm=true") and `capabilities.ts:59`. Add a test asserting `LIVE_MUTATION_BLOCKED` in sandbox.

### N3. `docs/skydo.md` (committed in HEAD) contradicts the fixed code in about 15 places; its examples now fail
The file was written against pre-fix behaviour. If a docs agent is rewriting it now, it must cover every row below.

| Line(s) | Says | Code now |
|---|---|---|
| 11, 493 | Terms "§25.8.12", "§25.8.2", "§37.6" | No such numbering exists. The Terms (last updated 09 Apr 2026) are one decimal list. The scraping/robots ban is **clause 13, item (iv)(f)**, and "Third-party applications" is **clause 11**. Re-verified with an `<ol>` walker over the live HTML: `page-scrape -> [13, 4, 6]` |
| 25, 422 | "Refunds go through Skydo support" / "handled with Skydo support" | Unsourced. FAQ: for settled **ACH Debit** payments "Skydo cannot initiate a refund directly"; the payer raises a chargeback |
| 108-117, 440 | DC table and error text without `ae`, `uk`, `sg` | `zoho.ts:23-25`; error lists 11 DCs |
| 190, 192, 413, 513-514 | "read when the gateway starts", "There is no locking… can lose updates", "server only reads the file at start-up and overwrites it", "Can the ledger be shared? No" | Locked read-modify-write and re-read on every call. Sharing is supported (`capabilities.ts:58`, `gateway-matrix.md:138`) |
| 251 | Ledger instructions text | Now ends "...with the Skydo transaction reference as receiptId." (`adapter.ts:318`) |
| 272 | Zoho instructions text | Differs from `adapter.ts:243-245` |
| 281 | "Looks for a non-void invoice…" | Void-only reference: `VALIDATION` "was voided. Use a new orderRef". Concurrent twins are voided (and see N1) |
| 308, 313-320 | MCP and SDK record examples with no `receipt_id` / `receiptId` | **Both now fail.** `receipt_id` is required (`server.ts:460`, `adapter.ts:401-403`). The live-mode example also needs `confirm: true` |
| 335 | Example `raw.receipts[]` without `receiptId` | Receipts carry `receiptId` |
| 339, 510-511 | "Recording the same receipt twice counts it twice", "not behind the live-mutation gate", "Is recording a receipt twice safe? No" | Idempotent per receiptId, and gated in live (see N2) |
| 388 | Generated routes list | Now: public GET is stored status only; admin `POST …/:orderRef/refresh` (Express/Fastify); admin `GET /api/skydo/outstanding`; Next.js poll route |
| 403 | `paid` → `captured` | `paid` → `captured` only when `payment_made ≥ total` and there is no write-off. A write-off gives `failed`; credits or a missing `payment_made` give `unknown` |
| 400-405 | Status table | Missing the write-off and credit rows above |
| 420 | "does not check minimums for other currencies" | Now adds a USD-50-equivalent note to the instructions (`adapter.ts:177`) |
| 424 | "No recurring payments (Skydo FAQ)" | The FAQ covers InstaLinks only (faq-6). Use `capabilities.ts:25` wording |
| 459 | NOT_FOUND cause "the invoice was voided" | A voided invoice now reports `cancelled` |
| 480 | Ledger NOT_FOUND causes | Fine |

**Fix:** Rewrite those sections from the current code. Add a "Concurrency" subsection (lock: local disk only, 5-second wait, 30-second stale threshold, and N1's residual risk).

---

## MEDIUM

### N4. Generated poller exhausts the Zoho daily quota with a handful of open invoices
- **Location:** `skydo.ts:68-96`. `refreshStatus` → `verifyPayment` without `providerOrderId` → `findInvoicesByReference` (1 call) + `getInvoice` (1 call), per open invoice, every 15 minutes.
- **Cost:** That is 96 × 2 = **192 calls per open invoice per day**. Zoho Books introduction (live, 2026-10-29): "Free Plan - 1000 API requests/day", "Standard Plan- 2000 requests/day", "Professional Plan- 5000". So about 5 open invoices exhaust Free, and about 10 exhaust Standard. Export invoices often stay open for weeks.
- **Other gaps:**
  - The template comment cites only the per-minute limit (`skydo.ts:85`).
  - The template never stores `providerOrderId`.
  - Once a quota error starts, `failed`/`unknown` invoices are polled forever.
- **Fix:**
  - Store `created.providerOrderId` and pass it to `verifyPayment`, which removes the list call.
  - Better: poll with **one** call, `GET /invoices?status=paid&last_modified_time=<last poll>` (both params exist in invoices.yml), and `getInvoice` only the matches you track.
  - Back off by invoice age.
  - Document the per-plan daily limits.

### N5. Fastify integration never polls, so Zoho-bridge orders are never fulfilled automatically
- **Location:** `skydo.ts:305-347`. The plugin imports neither `pollUnpaid` nor any scheduler, has no poll route, and Fastify gets no `server.ts`. Only the admin refresh route updates status. The guide (`skydo.ts:378`) promises "pollUnpaid() (every 15 min) … calls onPaid()".
- **Fix:** Add a poll route like Next.js's, or export `startSkydoPolling` from the plugin with an `onReady` hook.

### N6. A small write-off after a real payment is reported as `failed`, "no money was received"
- **Location:** `adapter.ts:88-89`.
- **Repro R3:** `{status:'paid', total:1250, payment_made:1240, write_off_amount:10}` returns `failed` with "USD 10 was written off as bad debt; no money was received for it."
- **Why it matters:** Skydo's FAQ ("What if there is a mismatch between funds received and invoiced amount?") says sender banks deduct small fees and the payment can still be mapped to the invoice. How Skydo closes that gap in Zoho is undocumented. Calling a 99%-paid invoice `failed` (a terminal state) is wrong, and the message is false.
- **Fix:**
  ```ts
  if (writeOff > 0) {
    const paid = Number(inv.payment_made ?? 0);
    return paid > 0
      ? { status: 'pending', reason: `Zoho shows "paid": ${inv.currency_code} ${paid} received, ${writeOff} written off. Decide whether to fulfil.` }
      : { status: 'failed', reason: `Zoho shows "paid" because ${inv.currency_code} ${writeOff} was written off as bad debt; no payment was recorded.` };
  }
  ```
  Also print `0` instead of `null` in the credits message (R3c prints "only null of 1250").

### N7. Template `requestPayment` resets `fulfilled`, so `onPaid` can run twice
- **Location:** `skydo.ts:61`, `saveInvoice({ ...inv, status: created.status, fulfilled: false })`.
- **Problem:** A second `POST /api/skydo/invoices` for an already-fulfilled order is idempotent at Zoho, but the template overwrites the local record. The next poll then calls `onPaid` again.
- **Fix:**
  ```ts
  const prev = await loadInvoice(inv.orderRef);
  await saveInvoice({ ...inv, status: prev?.status ?? created.status, fulfilled: prev?.fulfilled ?? false });
  ```

### N8. Retried createPayment returns a degraded result: no invoice link, and a paid invoice reports `unknown`
- **Location:** `adapter.ts:191-193` and the twin winner at `:222`. Both use the **list** item, and the invoices.yml list schema has no `invoice_url` or `payment_made`.
- **Repro R2:**
  ```
  R2 first url: https://books.zoho.in/SecurePayment?id=… | retry url: undefined
  R2 createPayment on paid invoice -> status unknown
  ```
- **When it happens:** Only across processes or after a restart; in-process retries hit the idempotency cache.
- **Fix:** After choosing the existing or winning invoice, call `invoice = await zoho.getInvoice(invoice.invoice_id)`.

### N9. `providerOptions.zohoCustomerId` is still not checked (rest of M6)
- **Location:** `adapter.ts:258-259`, `zoho.ts:209-212`. A vendor, inactive or wrong contact is used as-is.
- **Fix:** After `getContact`, require `contact_type === 'customer'` and `status !== 'inactive'`. The single-contact response carries both fields. Otherwise throw `VALIDATION`.

### N10. "Fully automatic" is still claimed for unverified API-created-invoice import (rest of M7)
- **Location:** `skydo.ts:358` "Option A: Zoho Books bridge (fully automatic, recommended)" and `codegen/index.ts:209` "(automatic)".
- **Evidence:** The body text now carries the right caveat (`skydo.ts:375-376`). The Skydo blog says only "Invoices created in Zoho are automatically synced".
- **Fix:** Heading "Option A: Zoho Books bridge (automatic once Skydo is connected; verify with your first invoice)". Codegen warning "(automatic once connected; confirm the first invoice reaches Skydo)".

### N11. Other stale Skydo text outside `docs/skydo.md` (rest of M8/M9)

| Location | Says | Fix |
|---|---|---|
| `docs/roadmap.md:11` | "Skydo (guidance only)" | "Skydo (Zoho Books bridge + ledger; partial create/verify/status)" |
| `docs/payloads.md:119` | "its Terms (§25.8.12)" | "its Terms of Use (clause 13)" |
| `docs/research/verification/skydo-api-search.md:15,57,190,221` | §21, §25.8.12, §25.8.2, §37.6 | Clause 11 ("Third-party applications") and clause 13 (iv)(f) (scraping/robots). Reverse engineering: clause 13's "decompile, reverse engineer" item and the IP clause. Name them by heading, not § numbers |
| `README.md:3` | "Amounts are always integer paise" | "integer minor units (paise for INR, cents for USD)" |
| `README.md:106` | Tool row omits receipt_id, idempotency and confirm | Add them |

---

## LOW

- **N12. Mock test checklist is wrong.**
  - `codegen/index.ts:223` says "GET /api/skydo/invoices/:orderRef -> captured" after `payments_mock_complete_payment`.
  - GET now returns stored status only and stays `created` until the poll or the admin refresh runs.
  - Fix: "...then POST /api/skydo/invoices/:orderRef/refresh (admin; Next.js: POST /api/skydo/poll) and GET → captured".
- **N13. Lock wait freezes the process, and a crashed holder blocks writers for 30 s.**
  - `sleepSync` uses `Atomics.wait` (`ledger.ts:46-48,106`) on the main thread.
  - Repro: "fresh crash lock: PROVIDER_UNAVAILABLE after 5030ms; timer ticks during wait: 0". The MCP stdio server and the app's HTTP server are frozen for up to 5 s.
  - A `kill -9` mid-write leaves a lock that is not stale for 30 s, while waiters give up after 5 s. Every ledger write fails for 30 s with "locked by another process".
  - Fix: write `pid` into the lock file and treat it as stale when `process.kill(pid, 0)` throws `ESRCH` (same host). Make `withLock` async with `await setTimeout(20)`, or use `proper-lockfile`.
- **N14. Stale-lock breaking is TOCTOU.**
  - `ledger.ts:99`: `statSync` then `unlinkSync`. A process descheduled between the two can delete a lock another process just acquired, giving two holders.
  - The `finally` `unlinkSync` (`:114`) can delete a lock that is not ours if ours was broken.
  - Not reproduced (narrow window). The 6-process stale-start test was clean.
  - Fix: write a random nonce into the lock and unlink only if the content still matches. Break stale locks by `renameSync(lock, lock + '.' + nonce)` and then re-check.
- **N15. Durability and portability.**
  - No `fsyncSync` before `renameSync` (`ledger.ts:83-84`). After a power loss the ledger can be empty, and the gateway then refuses to start (safe) but the data is lost.
  - On rename failure (Windows EPERM/EBUSY from AV or indexers) the `.tmp` file is leaked and the error escapes untyped.
  - mtime staleness and `O_EXCL` are unreliable on network filesystems.
  - Fix: open the tmp file, `writeSync`, `fsyncSync`, `closeSync`, rename, then fsync the directory (POSIX). Retry rename on EPERM/EBUSY 3× and unlink tmp in `finally`. Document "local disk only".
- **N16. `received_at` validation is loose.**
  - `Date.parse('1')` is valid (2001-01-01), and future dates are accepted.
  - Fix: MCP `z.string().datetime({ offset: true }).or(z.string().date())`; adapter rejects dates more than 1 day in the future or before `entry.createdAt` minus 1 day.
- **N17. Rate-limit detection assumes HTTP 200 (UNVERIFIED).**
  - `zoho.ts:116-121` only sees `{"error":...}` bodies on HTTP 200. If Zoho answers the "too many requests" refresh with HTTP 4xx, `http.ts` throws VALIDATION/AUTH before this branch. The L4 test (`skydo.test.ts:544`) uses 200.
  - Also, a failing *refresh* surfaces as AUTH, and `call()` (`zoho.ts:162-166`) then refreshes a second time. That burns 2 of the 10 refreshes per 10 minutes on every failing call.
  - Fix: in `accessToken`, catch `PaymentError` from the token request and map `/too many|access denied/i` in `providerMessage` to `RATE_LIMITED`. In `call()`, do not retry when the AUTH came from the refresh (tag it, e.g. `operation === 'zoho_refresh_token'`).
- **N18. Receipt dedupe is per order and case-sensitive.**
  - `adapter.ts:412`: the same Skydo transaction reference can be recorded against two different orders, and `fira-1` and `FIRA-1` count twice.
  - Fix: normalise the id (trim, upper-case) and, inside the same lock, scan all entries for the receiptId. Reject it with `IDEMPOTENCY_CONFLICT` if it belongs to another order.
- **N19. Twin ordering compares `created_time` with second resolution plus a lexicographic `invoice_id`** (`adapter.ts:222`). Covered by the N1 fix (zero-padded id tie-break).
- **N20. Refund wording over-generalises.**
  - `capabilities.ts:21` ("cannot initiate a refund directly once a payment is settled") and `skydo.ts:397` turn an ACH-Debit-specific FAQ into a general rule.
  - Fix: "Skydo's FAQ: for settled ACH Debit payments Skydo cannot initiate a refund; the payer raises a chargeback. Refund/chargeback help: support@skydo.com."
- **N21. Test titles overclaim.**
  - `skydo.test.ts:381` is titled "...a live lock is respected" but never tests a live lock.
  - `:451` covers only one side of the race (see N1).
  - Fix: add a fresh-lock test expecting `PROVIDER_UNAVAILABLE` with a short timeout (make `LOCK_TIMEOUT_MS` injectable), and the two-gateway race test.

---

## Fact re-check (capabilities.ts and generated guide)

| Claim | Verdict | Source |
|---|---|---|
| No public API; API on roadmap since Dec 2025 | OK | Series A post quoted in skydo-api-search.md: "we will roll out developer-friendly APIs and webhooks" |
| Terms forbid automated access (capabilities.ts:47, no clause number) | OK | Terms clause 13 (iv)(f): "Use deep-links, page-scrape, robot, spider or other automatic device…" |
| Local accounts USD, GBP, EUR, CAD, AUD, AED, SGD; 32 currencies via SWIFT | OK | /faqs/international-accounts |
| Minimum USD 50 | OK | FAQ CMS: "minimum transaction threshold of 50 USD" |
| Zoho sync every 10 min; only new invoices; marks paid; uploads FIRA; all currencies or international only | OK | Skydo Zoho blog post |
| "profile > Connect Skydo to Zoho > Connect Securely" | OK | Blog: "navigate to the profile section", then "'Connect Skydo to Zoho' section. Here, click on 'Connect Securely.'" |
| InstaLinks single-use; recurring not supported on InstaLinks | OK | faq-13; faq-6 "Recurring payments are not yet supported." |
| "cannot initiate a refund directly once settled" | OVER-GENERALISED (N20) | faq-18 is about ACH Debit only |
| "Every incoming transfer must be matched to an invoice in Skydo" | OK (inferred) | FAQ mismatch answer: "map the received payment to the invoiced amount… mapped successfully and processed to your INR account" |
| "Fully automatic" (guide heading) | UNVERIFIED (N10) | Blog does not mention API-created or draft invoices |
| Zoho DCs incl. .ae | OK | Books introduction table lists .ae. .uk and .sg are not in the Books table (correctly marked in round 2 as "endpoint responds") |
| Zoho: 100 requests/min per org | OK, but incomplete | The introduction also gives daily plan limits (1000 Free / 2000 Standard / 5000 Professional / 10000 Premium+) and 5 concurrent calls on Free. Add these to the template comment (N4) |
| List invoices lacks `payment_made`/`invoice_url`; has `created_time`, `write_off_amount` | Confirmed (invoices.yml) | Drives N8 and the code's correct use of `getInvoice` for status |
| `reference_number` filter semantics | Unspecified ("Search invoices by reference number"); the code re-checks exactly | invoices.yml |
| Contacts list has `email`, `status` (active/inactive), `contact_type` | Confirmed | contacts.yml |

## Generated templates

Generated for all 9 frameworks. The service module typechecks under `strict` against the SDK source. Files:
- **express, react, html, react-native, flutter, shopify, other:** `skydo.ts`, `admin.ts`, `skydo-routes.ts`, `server.ts`, env, guide.
- **nextjs:** 4 route files.
- **fastify:** plugin with no poller (N5).

Template issues are N4, N5, N7, N10 and N12. Admin auth uses `timingSafeEqual` correctly. The public status route no longer calls Zoho.
