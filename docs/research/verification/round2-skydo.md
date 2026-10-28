# Round 2 adversarial review: Skydo adapter (Zoho Books bridge and ledger)

- **Reviewed:** 2026-10-29
- **Scope:** `src/providers/skydo/*`, `src/codegen/templates/skydo.ts`, `test/providers/skydo.test.ts`, and the Skydo parts of `src/client.ts` and `src/mcp/server.ts`.
- **Method:**
  - Zoho Books OpenAPI files (`invoices.yml`, `contacts.yml` from `openapi-all.zip`).
  - Zoho's live docs: the Books API introduction, the Books OAuth page, and the Accounts multi-DC page.
  - Live unauthenticated probes of Zoho hosts.
  - Skydo pages, using the CMS JSON embedded in `/faqs/*`, the Zoho blog post and the Terms.
  - A scratch repro script (not committed) that runs the real adapter against a fake fetch.
- No source files were edited.

`npx vitest run test/providers/skydo.test.ts` passes 30 of 30 tests. The repro script confirmed findings C1, H1, H2, H3, M1 and M2 against the real code, and its output is quoted under each one.

---

## Verified correct (no action)

| Claim / code | Evidence |
|---|---|
| `GET/POST /invoices`, `GET /invoices/{id}`, `POST /invoices/{id}/status/sent` ("Mark a draft invoice as sent.") | invoices.yml `paths` |
| `organization_id` query param, required on every path | invoices.yml `components.parameters.organization_id` (`required: true`) |
| POST /invoices required = `customer_id`, `line_items`; line item required = `item_id`; `name` (max 100), `rate`, `quantity`, `notes`, `exchange_rate`, `due_date`, `reference_number` exist | invoices.yml requestBody schema |
| `send` query param on POST /invoices (boolean) | invoices.yml create_invoice params |
| Create returns **201** `{code, message, invoice}`; invoice has `invoice_id, invoice_number, reference_number, status, customer_id, currency_code, total, balance, payment_made, last_payment_date, has_attachment, attachment_name, invoice_url, write_off_amount, credits_applied` | invoices.yml responses |
| Status enum: `sent, draft, overdue, paid, void, unpaid, partially_paid, viewed` | invoices.yml list param `status` |
| `GET /contacts?email=` is a valid filter ("email of the primary contact person", with `_startswith`/`_contains` variants, so the base form is the exact one) | contacts.yml |
| `contact_type=customer` is a valid filter ("Allowed Values: customer, vendor") | contacts.yml |
| The contacts list item carries `currency_code` and `status` (active/inactive) | contacts.yml list response |
| `Authorization: Zoho-oauthtoken <access_token>` | zoho.com/books/api/v3/introduction |
| Refresh grant: POST `{Accounts_URL}/oauth/v2/token` with `refresh_token, grant_type=refresh_token, client_id, client_secret`; the response includes `api_domain` and `expires_in: 3600` | zoho.com/books/api/v3/oauth (sample response shows `"api_domain": "https://www.zohoapis.com"`) |
| Accounts hosts: com, eu, in, com.au, jp, **ca = accounts.zohocloud.ca**, **sa = accounts.zoho.sa** | zoho.com/accounts/protocol/oauth/multi-dc.html; `accounts.zoho.com/oauth/serverinfo` returns `"ca":"https://accounts.zohocloud.ca"` |
| **CN = accounts.zoho.com.cn** | `https://accounts.zoho.com.cn/oauth/serverinfo` returns `"cn":"https://accounts.zoho.com.cn"` (CN is not in the global serverinfo) |
| Expired or invalid token → **HTTP 401 `{"code":57,"message":"You are not authorized to perform this operation"}`**, which `codeForHttpStatus` maps to `AUTH` | Live probe: `GET www.zohoapis.com/books/v3/invoices?organization_id=1` with a bogus token returned 401, code 57. Same on .ca, .sa, .com.cn, .uk, .sg |
| A bad refresh token gets **HTTP 200** `{"error":"invalid_client"}`, and the code handles that (zoho.ts:107) | Live probe of accounts.zoho.com |
| Scopes `ZohoBooks.invoices.ALL,ZohoBooks.contacts.READ` cover create, mark-sent (`invoices.CREATE`) and read | invoices.yml `security` |
| Skydo: only invoices created after connecting are imported | skydo.com/blog/skydo-feature-update-zoho-integration: "only new invoices created after the integration will be transferred" |
| Skydo: 10-minute sync | same post: "syncing frequency of every 10 minutes" |
| Skydo: marks the Zoho invoice paid | same post: "the corresponding invoice in Zoho is automatically marked as paid" |
| Skydo: FIRA uploaded to Zoho | same post: "generates and uploads FIRA directly to Zoho for each transaction" |
| Skydo: "all currencies or international only" | same post: "import all currencies or filter for international invoices only" |
| Skydo: minimum USD 50 | /faqs CMS JSON: "minimum transaction threshold of 50 USD" |
| Skydo: local accounts USD, GBP, AED, CAD, EUR, AUD, SGD | /faqs/international-accounts: "You can currently get paid locally from:" lists exactly these seven |
| Skydo: SWIFT for other currencies | /faqs/international-accounts: "Skydo supports 32 currencies via the International SWIFT account" |
| Skydo: InstaLinks are single-use | faq-13: "marked as completed and cannot be used again" |
| Skydo: email and WhatsApp notifications | /faqs: "You will receive an email and WhatsApp notification" |
| Skydo: Reports tab exports | faq-47 (Analytics & Reports → Reports → Download) |
| No secret leakage in results | The refresh token and client secret go only in the form body to the accounts host. `http.ts` never logs bodies or URLs, and the test asserts that neither secret appears in the result. Confirmed by reading `http.ts:131-172` |
| 2-decimal handling | Every Skydo local currency has 2 decimals. `money.ts` treats JPY/KRW etc. as 0-decimal, which is consistent in both directions (`toMajorString`/`fromMajor`) |

---

## CRITICAL

### C1. Two processes sharing the default ledger file lose data (silent overwrite)
- **Location:** `src/providers/skydo/ledger.ts:28-40, 55-66`. Default path `adapter.ts:125`: `~/.india-payments-mcp/skydo-ledger.json`.
- **Problem:** The ledger reads the file once in the constructor, keeps a `Map`, and on every `put()` rewrites the **whole file** from that stale map.
- **Why it matters:** The documented flow is exactly two processes on one file. Your app (or the generated SDK service) creates orders, and the MCP server (`payments_skydo_record_payment`) records receipts. Both default to the same path.
- **Repro output:** `6 shared file: mcp record of app order -> NOT_FOUND ; ord_app still on disk? false`
  - The MCP process cannot see orders the app created after the MCP process started.
  - Its next write **deletes** the app's orders from disk.
  - Receipts recorded by one process are likewise erased by the other's next write.
- **Effect:** Orders vanish from `outstanding`, and receipts are lost. The "persistent ledger" claim is false whenever a second process exists.
- **Fix:** Make every operation a locked read-modify-write against the file.
  - Acquire an exclusive lock: `openSync(file + '.lock', 'wx')` with retry and backoff, plus stale-lock detection by pid/mtime. Alternatively use `proper-lockfile`.
  - Re-read and parse the file inside the lock, apply the single-entry change, write to the temp file, `fsyncSync`, rename, then release the lock.
  - Make `get()` and `list()` re-read the file (or check mtime) instead of serving the constructor snapshot.
  - Add a test with two `SkydoLedger` instances on one file: A creates, B records, then a fresh instance must see both.

---

## HIGH

### H1. A written-off (bad debt) or credit-note-settled Zoho invoice is reported as paid
- **Location:** `adapter.ts:57-75` (`'paid' → 'captured'`), `adapter.ts:291-308`.
- **Evidence:**
  - Zoho shows written-off invoices with status Paid. Zoho's own KB says that when you write off an invoice "it will be marked as Paid" (zstatic.zohostatic.com/billing/kb/invoices/what-is-void-writeoff.md).
  - Zoho community: "Invoice status on write-off is 'Paid'" (help.zoho.com/portal/en/community/topic/invoice-status-on-write-off-is-paid-how-do-i-change-this-to-written-off).
  - The invoice schema exposes `write_off_amount` and `credits_applied` (invoices.yml).
- **Repro output:** `3 write-off verify: [ true, 'captured' ]` for `{status:'paid', payment_made:0, write_off_amount:1200}`. Through `PaymentsClient.verifyPayment` this becomes `paid: true`, and the generated `onPaid()` releases deliverables for money that never arrived.
- **Fix (in `getPaymentStatus`):**
  - Always fetch the full invoice with `GET /invoices/{id}`. The list item has no `payment_made` or `credits_applied`.
  - Return `captured` only when `status === 'paid' && Number(write_off_amount ?? 0) === 0 && fromMajor(payment_made) >= fromMajor(total)`.
  - If it is `paid` with a write-off, return `failed` (or `cancelled`) with `failureReason: 'Written off in Zoho Books, not paid'`.
  - If credits were applied, return `captured` only if the credits are not counted towards cash. Simplest: require `payment_made >= total`, and otherwise return `pending` with a reason.
  - Optionally expose `firaAttached` as a stronger "via Skydo" signal. A payment the user recorded by hand in Zoho, or one made through a Zoho online gateway via `invoice_url`, also sets `paid`. Document that "paid" means "paid in Zoho", not "received via Skydo".

### H2. `verifyPayment` accepts another order's invoice when `providerOrderId` is supplied
- **Location:** `adapter.ts:294` (no check that `invoice.reference_number === input.orderRef`), `adapter.ts:299`.
- **Repro output:** `4 cross-order verify: true captured ord_OTHER`, from `verifyPayment({orderRef:'ord_A', providerOrderId:'77' /* invoice of ord_OTHER */, expectedAmount})`.
- **Why it matters:** `PaymentsClient.verifyPayment` then returns `paid: true` for ord_A, because `bound` only checks that the caller *passed* orderRef. Any paid invoice with the same amount, such as a previous month's retainer, unlocks a different order. `provider_order_id` is an optional MCP input, so an agent can supply it.
- **Fix:** After `getInvoice`, require `invoice.reference_number === input.orderRef`. Otherwise throw `VALIDATION` ("Zoho invoice X belongs to reference Y, not Z"). Add a test for it.

### H3. Ledger receipts are not idempotent: a retried or duplicate record flips a partial payment to captured
- **Location:** `adapter.ts:337-354`; MCP `server.ts:452-469` (`idempotentHint: false`, no dedupe key).
- **Repro output:** `5 duplicate receipt: captured`. Recording 60,000 of 100,000 twice (same FIRA) gives captured.
  - MCP clients retry on timeouts.
  - Agents re-run tools.
  - A Skydo email and WhatsApp alert for the same credit can each be "recorded".
- **Fix:**
  - Add a required `receiptId`: the Skydo transaction or UTR reference, or the FIRA number, or a caller-supplied id. Reject or no-op when that id is already in `entry.receipts`.
  - Wrap the call in `withIdempotency(this.idem, 'skydo:record_payment', receiptId, input, ...)` in `client.ts:184`.
  - Make the MCP schema field `receipt_id: z.string().min(3).max(64)` required.

### H4. An AI agent can mark a live order paid with no human confirmation
- **Location:** `client.ts:184-187`, `server.ts:452-469`.
- **Problem:** `skydoRecordPayment` is not behind `assertLiveMutationAllowed`. The MCP test (`skydo.test.ts:335-353`) proves this: in `PAYMENTS_MODE=live` with `guardLiveMutations: true`, the agent records 250,000 GBP and `verify` immediately returns `paid: true`.
- **Why it matters:**
  - In ledger mode, recording a receipt is the only thing standing between "unpaid" and "fulfil".
  - The tool description invites the agent to act on "email/WhatsApp" content, which is a textbook prompt-injection vector: a forged email claiming "Skydo: payment received for INV-123".
  - Refunds get a confirm gate. This flip from unpaid to paid deserves one too.
- **Fix:**
  - Call `this.assertLiveMutationAllowed('Recording a Skydo receipt', 'skydo', opts.confirm === true)` inside the audited block.
  - Add `confirm: z.boolean().optional()` to the tool and set `destructiveHint: true`.
  - Reword the description: "Only after a human has checked the Skydo dashboard or FIRA; never on the basis of an email or message content alone."

---

## MEDIUM

### M1. A failed mark-as-sent is never retried, so the invoice stays a draft forever
- **Location:** `adapter.ts:158-162` vs `183-186`.
- **Repro output:** `2 existing draft: created markSent calls: 0`.
  - If `createInvoice` succeeds and `markSent` fails (network error, 429), the caller retries.
  - On retry, `findInvoiceByReference` finds the draft, and the "existing" branch returns without marking it sent.
  - Per the adapter's own premise (adapter.ts:182), Skydo will not import it.
- **Fix:** In the existing branch, `if (invoice.status === 'draft') { await zoho.markSent(invoice.invoice_id); invoice = { ...invoice, status: 'sent' }; }`. Add a test for it.

### M2. The `ZOHO_ACCOUNTS_URL` override (and any region whose `api_domain` differs) fails on the first call
- **Location:** `zoho.ts:131-141`.
- **Problem:** `url` is built from `this.apiBase` *before* `send()` awaits `accessToken()`, and that call is what switches `apiBase` to the token's `api_domain`. For an override region (e.g. `ae`), `apiBase` starts as `https://www.zohoapis.com`.
- **Repro output:** `1 accountsUrl override first call: AUTH second: ok`, with the request log showing two refreshes and two GETs to `www.zohoapis.com` before the success. Each fresh process (and so every MCP session) fails its first call and burns two of the 10 access tokens per 10 minutes that Zoho allows ("maximum of 10 access tokens per refresh token in 10 minutes", Books OAuth page).
- **Fix:** Build the URL inside `send`: `const token = await this.accessToken(); const url = \`${this.apiBase}/books/v3${path}?${q}\`;`.

### M3. Zoho data centers are missing: UAE (listed by Zoho Books), plus UK and SG
- **Location:** `zoho.ts:13-22`, `capabilities.ts:38`.
- **Evidence:**
  - The Books API introduction lists "United Arab Emirates | .ae | https://www.zohoapis.ae/books/".
  - `accounts.zoho.com/oauth/serverinfo` returns `"ae":"https://accounts.zoho.ae"`, `"uk":"https://accounts.zoho.uk"` and `"sg":"https://accounts.zoho.sg"`.
  - `www.zohoapis.uk` and `www.zohoapis.sg` answer `/books/v3` with 401 code 57.
- **Why it matters:** AED is a Skydo local-account currency, so UAE is a core corridor. Today such users hit M2.
- **Fix:**
  - Add `ae: { accounts: 'https://accounts.zoho.ae', api: 'https://www.zohoapis.ae' }`.
  - Add `uk` and `sg` with the matching hosts, marked "Books availability not listed in the Books docs; endpoint responds".
  - Update the `ZOHO_DATA_CENTER` description.

### M4. The idempotency lookup can miss the invoice and create a duplicate (default page size 10; match semantics unspecified)
- **Location:** `zoho.ts:178-182`.
- **Problem:**
  - invoices.yml: `per_page` "default: 10", max 200.
  - The `reference_number` filter is described only as "Search invoices by reference number", with no statement that it is exact.
  - If Zoho matches by prefix or substring (as it does for several search fields), `ord_1` could also match `ord_10…ord_19`. The exact match could then sit beyond page 1, return `undefined`, and a **second invoice** would be created and imported into Skydo.
- **Also a race:** Two processes (MCP and app), or two concurrent requests in different processes, can both miss the invoice and both create one. The `withIdempotency` dedupe in `client.ts` is in-process only.
- **Fix:**
  - Pass `per_page: '200'` and follow `page_context.has_more_page`.
  - After creating, re-query by reference. If more than one non-void invoice now has the reference, void the newer one (`POST /invoices/{id}/status/void`, which exists in invoices.yml) and return the older one.
  - Optionally, offer `invoice_number = orderRef` with `ignore_auto_number_generation=true`, which uses Zoho's uniqueness rule. But Skydo's invoice FAQ asks for numbers "with less than 30 characters", so cap orderRef at 29 in that mode.

### M5. A voided invoice shows up as NOT_FOUND, not `cancelled`
- **Location:** `zoho.ts:181` filters out `void`, so `mapZohoInvoiceStatus('void')` is unreachable from the orderRef path (`adapter.ts:295-296`).
- **Effect:** `verifyPayment` and `getPaymentStatus` throw NOT_FOUND for a cancelled order. The generated `pollUnpaid` then logs `poll_failed` forever and never marks it cancelled.
- **Fix:** Have `findInvoiceByReference` return the non-void match if one exists, otherwise the most recent void match. `getPaymentStatus` then reports `cancelled`, while `createPayment` treats a void-only result as "none" and re-issues.

### M6. The Customer lookup can silently pick the wrong customer
- **Location:** `zoho.ts:163-170`, `adapter.ts:210-234`.
- **Problems:**
  - Zoho allows duplicate contacts (contacts.yml `filter_by` includes `Status.Duplicate`). With two active customers on the same email, the first one is billed.
  - If only an inactive contact matches, it is still used (`?? data.contacts[0]`).
  - `getContact(zohoCustomerId)` does not check `contact_type === 'customer'`.
  - There is no client-side check that the returned `email` equals the requested one (case-insensitively).
- **Fix:**
  - Filter to `status === 'active'` and compare emails exactly (case-insensitive).
  - If more than one contact matches, throw `VALIDATION` ("several Zoho customers use this email; pass providerOptions.zohoCustomerId").
  - If none match, throw the existing not-found error.

### M7. False or unverifiable factual claims
- **`capabilities.ts:47`, "Terms (§25.8.12)":** No such numbering exists on the live page.
  - skydo.com/terms-of-use (last updated 09 April 2026) is one decimal list.
  - The ban ("deep-links, page-scrape, robot, spider or other automatic device") sits in **clause 13 "Restrictions on the use of the Platform and the Website", sub-item (iv)(f)**.
  - "Third-party applications" is clause **11**, not §21 as in `skydo-api-search.md`.
  - Fix: cite "Skydo Terms of Use, clause 13 (Restrictions on the use of the Platform), as of 09 Apr 2026", and correct `skydo-api-search.md` too.
- **`capabilities.ts:21`, "Refunds to a foreign client are handled with Skydo support":** No source says this. faq-18 says that for settled ACH payments "Skydo cannot initiate a refund directly", and the payer must raise a chargeback. Fix: "Skydo has no refund API. Per Skydo's FAQ, settled payments are reversed by the payer's chargeback, not a Skydo refund."
- **`capabilities.ts:25`, "Skydo FAQ: no recurring payments":** The FAQ is about InstaLinks only: "Recurring payments are not yet supported" (faq-6, InstaLinks section). Fix: "InstaLinks: recurring payments not yet supported (Skydo FAQ). Skydo has no subscription product."
- **`capabilities.ts:31`, "30+ more via SWIFT":** The FAQ says "32 currencies via the International SWIFT account" (that total includes the local ones). Fix: "32 currencies via the SWIFT account".
- **Guide heading `skydo.ts:331`, "fully automatic, recommended", and `adapter.ts:25` "fully automatic":** UNVERIFIED for API-created invoices. Skydo's post only says "Invoices created in Zoho are automatically synced".
  - It does not say whether invoices created through the API (rather than the UI) sync.
  - It does not say whether drafts are skipped (the reason `adapter.ts:182` calls `markSent`).
  - It does not say whether customer country, GST treatment or currency gates the "international only" filter.
  - Fix: label it "automatic once connected (Skydo's sync of API-created invoices is not separately documented; verify with one real invoice)". Say in the guide that the mark-sent step is a precaution, not a documented Skydo requirement. Run one end-to-end test on a real Skydo+Zoho account before calling it "fully automatic".

### M8. Broken reference and stale docs that now contradict the adapter
- **Broken reference:** `adapter.ts:122` and `capabilities.ts:41` point to **`docs/skydo.md`, which does not exist**. Fix: add the file (setup A/B from `skydoGuide`), or point to the generated guide.
- **Stale docs:** These still say Skydo is "guidance only", "Every feature is `unsupported`" and calls "fail with `UNSUPPORTED` before any network activity":
  - `README.md:5`
  - `README.md:68` (every column "No")
  - `docs/gateway-matrix.md:125`
  - `docs/risks.md:14`
  - `docs/roadmap.md:11,57`
  - `docs/design-review.md:91`
- **Fix:** Update these to the current partial support (createPayment, verify and status are partial; the rest unsupported).

### M9. The MCP amount wording says "paise" for foreign-currency Skydo amounts
- **Location:** `server.ts:14` (`paise` schema "Rs 499.00 = 49900"), `server.ts:54` ("Amounts are ALWAYS integer paise"), and `server.ts:203`.
- **Why it matters:** For Skydo the unit is cents of the invoice currency. An agent told "paise" may convert USD to INR first. That would be blocked as INR, or worse, sent as an INR-sized number labelled USD.
- **Fix:** Use "integer minor units of `currency` (paise for INR, cents for USD)" everywhere.

### M10. Generated template: unauthenticated status route can exhaust the Zoho API quota
- **Location:** `skydo.ts:143-145` (Express), `217-234` (Next) and `305-308` (Fastify).
- **Problem:** Anyone who knows or guesses an order id can hit `GET /api/skydo/invoices/:orderRef` in a loop. Each hit costs one or two Zoho calls. Zoho allows 100 requests per minute per org and 1,000 per day on the Free plan (Books introduction), so polling and invoice creation can be starved.
- **Fix:** Have that route return the stored status only, without calling `refreshStatus`. Alternatively put it behind auth, or rate-limit or cache it (for example, at most one refresh per order per 5 minutes).

---

## LOW

- **L1. Minimum only enforced for USD** (`client.ts:169`, `adapter.ts:145`). Skydo states the threshold as "50 USD" with no per-currency rule, so GBP 10 or EUR 20 pass validation and fail at Skydo. Fix: document it as "USD 50 or equivalent; enforced exactly for USD only", or warn for other currencies.
- **L2. `received_at` is not validated** (`server.ts:462`, `adapter.ts:347`). Arbitrary strings get stored. Fix: `z.string().datetime({ offset: true })`, and reject future dates.
- **L3. Currency not validated as ISO-4217.** `client.ts:164` only rejects INR. `XYZ` reaches the ledger and goes out via the `*` fallback. Fix: `/^[A-Z]{3}$/`. Optionally, warn for 3-decimal currencies (KWD, BHD, OMR, JOD), which `money.ts` treats as 2-decimal.
- **L4. Refresh-rate errors are mislabelled.** Zoho limits refreshes to 10 per 10 minutes. When that limit is hit, the error is reported as "Zoho refused the refresh token … Generate a new refresh token" (`zoho.ts:108-111`), which sends users to the wrong fix. Fix: map an `error` containing "Access Denied" or "too many requests" to `RATE_LIMITED`. For Zoho 401s, also override the generic AUTH hint (`http.ts:170`, "sandbox/live keys").
- **L5. Ledger directory permissions.** `mkdirSync` (`ledger.ts:62`) uses the default umask (0755); the file itself is 0600, which is good. Fix: `mkdirSync(dir, { recursive: true, mode: 0o700 })`.
- **L6. One corrupt ledger file blocks Zoho mode.** A corrupt file makes the constructor throw even in Zoho mode, where the ledger is unused (`adapter.ts:125`). Fix: construct the ledger lazily, or only in ledger mode.
- **L7. Template `onPaid` assumes 2 decimals** (`skydo.ts:49`: `(inv.amount / 100).toFixed(2)`). It is wrong for 0-decimal currencies. Fix: use `toMajorString` exported from the SDK.
- **L8. Guide's accounts-host list omits Canada's odd host** (`skydo.ts:345`, "zoho.com, zoho.eu, zoho.in, zoho.com.au, ..."). Canada is `accounts.zohocloud.ca`, which users will not guess. Fix: print the full table from `ZOHO_DATA_CENTERS`.
- **L9. `exchange_rate` is optional in the code.** The spec says it is "Required when the invoice currency differs from the organization's base currency". What Zoho does when it is omitted (auto feed vs reject) is not documented in the OAS. Fix: document "set providerOptions.exchangeRate unless Zoho's automatic exchange-rate feed is on".
- **L10. Long payment references may be truncated.** In ledger mode the payment reference is the full 3-40 char orderRef, and UK Faster Payments references are commonly capped at 18 characters. UNVERIFIED against a Skydo source. Fix: recommend orderRefs of 18 characters or fewer in `paymentInstructions` for GBP.
- **L11. `invoice_url` can bypass Skydo.** It is a Zoho SecurePayment page. If the org has a Zoho online gateway enabled, the client can pay there, outside Skydo, and the invoice still becomes `paid`. Fix: one line in the guide.

---

## Tests: do they prove the behaviour?

All 30 pass. Most are genuine: they assert the exact URLs, form body, query strings and JSON body against the spec, and the AUTH retry uses a real 401 with code 57. Gaps and weak spots:

- **Tests that bake in the bugs:**
  - `skydo.test.ts:256-261`: "paid with FIRA → captured" never varies `write_off_amount`, `payment_made` or `has_attachment`, so H1 is invisible.
  - The status test passes `providerOrderId` and `orderRef` for the same invoice, so H2 is untested.
- **"Is idempotent" (`:235-240`)** only covers an existing *sent* invoice. It misses an existing draft (M1), pagination, and duplicates (M4).
- **"Persists the ledger" (`:153-163`)** uses sequential instances where the first has finished. It never runs two live instances, so C1 is untested.
- **"Records partial then full receipts" (`:131-143`)** never records the same receipt twice (H3).
- **"Full ledger flow over MCP" (`:335-357`)** actively demonstrates H4: a live-mode record without `confirm` succeeds. It should be inverted to expect `LIVE_MUTATION_BLOCKED` without confirm.
- **"Uses the api_domain" (`:309-318`)** sets `api_domain` equal to the data-center default, so it cannot detect M2. Use `zohoAccountsUrl` with a different `api_domain`.
- **`void f;` (`:287`)** is dead code.
- **Missing cases:**
  - A void invoice via the reference path (M5).
  - Duplicate or inactive contacts (M6).
  - A custom `received_at`.
  - Non-USD minimum.
  - Secrets absent from *error* objects (only success results are checked).

## Answers to the specific questions

1. **Zoho API correctness.**
   - All paths, params, body fields and response fields used match invoices.yml and contacts.yml.
   - `email` is the exact-match form (variants exist for prefix and contains). It matches the primary contact person only.
   - `contact_type=customer` is valid.
   - The Authorization header and refresh grant are correct. The token response includes `api_domain`.
   - Accounts hosts are correct for every DC listed, including CA (`accounts.zohocloud.ca`), AU (`accounts.zoho.com.au`), SA (`accounts.zoho.sa`) and CN (`accounts.zoho.com.cn`, from CN serverinfo). UAE, UK and SG are missing (M3).
   - Errors are HTTP 4xx with `{code,message}`. An expired or invalid token gives 401 with code 57 (live probe).
2. **Skydo import rules.**
   - Skydo states only that "Invoices created in Zoho are automatically synced".
   - API vs UI creation: **not addressed (unknown)**.
   - The "sent" status requirement: **not addressed (unknown)**.
   - Currency: an "all currencies or international only" option exists. Customer country: **not addressed**.
   - Only invoices created after connecting are imported.
   - Treat end-to-end behaviour as unverified until tested on a real account (M7).
3. **Logic bugs.** See C1, H1-H4 and M1-M6. No path leaks the refresh token or client secret.
4. **Tests.** See the previous section.
