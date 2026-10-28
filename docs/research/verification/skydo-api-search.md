# Skydo developer API: exhaustive re-verification

- **Checked:** 2026-10-29. HTTP probes were run 2026-10-28 19:46–19:53 UTC.
- **Method:** I checked the live site and its sitemaps, `llms.txt`, the CMS JSON embedded in the FAQ pages (which carries full answers, not only titles), a DNS and subdomain sweep, GitHub (users, orgs, code and repo search), package registries, automation and app marketplaces, web search and third-party comparisons.
- **Scope:** Read-only. I did not log in to any Skydo dashboard and did not send authenticated requests.

## Verdict

**(c) There is no public API today. Skydo has publicly stated an intent to build one, but it is roadmap only.**

- **No public API.** There is no public developer portal, API reference, SDK, sandbox, API keys, public webhooks or self-serve partner programme.
- **Website checkout is ruled out by Skydo itself.** Skydo's own FAQ, asked "Can I integrate Skydo on my website for checkout?", answers "Currently, this feature is not available."
- **The API is on the roadmap with no date.** The Series A post (10 Dec 2025) says: "Developer Platform: To support SaaS companies, marketplaces, and fintech partners, we will roll out developer-friendly APIs and webhooks." No timeline is given.
- **Nothing has launched since.** A Skydo blog post dated 27 Oct 2026 still names Zoho as the only automation path.
- **Partner integrations exist, but only on Skydo's terms.** Terms of Use §21 has a "Third Party Business Application" framework: connections approved by Skydo can send payment requests and receive payment-status notifications. The Zoho Books integration and the Amazon PSP route are instances of it. This shows a private, Skydo-approved partner integration channel exists. There is no public evidence that it can be obtained "on request", and no "contact us for API access" CTA appears anywhere on the site.
- **Infrastructure exists but is not public.**
  - `developer.skydo.com` resolves to an empty CloudFront/S3 distribution: 404 at the root, and every extension-less path just gets a trailing-slash 301.
  - `api.skydo.com` is the dashboard's own backend. It answers "All is well!! V4" at the root and 403 on every path.
  - `docs.skydo.com` is a login-gated BookStack wiki, which is internal.
  - These are signals of a future portal, not a usable API.
- **No reliable source contradicts this.**
  - The only "webhook" claim is on a reseller page (precisiontech.in). It gives no evidence and quotes wrong fees, so it is unreliable.
  - One GitHub repo (`ysr-hameed/s3-storage-private`) contains a `skydoService.js` calling `https://api.skydo.com/v1` with a Bearer key. That endpoint returns 403 and there are no docs, so it appears fabricated or speculative and is not evidence.

**Action for the adapter:** keep `src/providers/skydo/*` guidance-only and do not invent endpoints. Re-check `developer.skydo.com` periodically: it is the most likely place a real portal will appear.

## 1. URLs checked

### 1a. skydo.com pages

| URL | Result |
|---|---|
| https://www.skydo.com | 200. No API, developer or integration nav or footer link |
| https://skydo.com/developers | 301 → https://www.skydo.com/developers |
| https://www.skydo.com/developers | **404** |
| https://www.skydo.com/api | **500** (no page) |
| https://www.skydo.com/docs | **404** |
| https://www.skydo.com/integrations | **404** |
| https://www.skydo.com/partners | **404** |
| https://www.skydo.com/pricing | **404** |
| https://www.skydo.com/changelog | **404** |
| https://www.skydo.com/careers | **404** |
| https://www.skydo.com/zoho-books-integration | **404** |
| https://www.skydo.com/pay | **404** |
| https://www.skydo.com/robots.txt | 200. Only `Disallow: /tutorial/`, plus a pointer to `llms.txt` |
| https://www.skydo.com/sitemaps/sitemap-index.xml | 200. Child sitemaps: main, swift-code-finder, currency-converter, people-ask, rbi-purpose-code-list |
| https://www.skydo.com/sitemap.xml | 200. 1,390 URLs. **None** contain api, developer, webhook, integration or partner programme (grep); the only "developer" hits are SEO pages for "web developer" and similar audiences |
| https://www.skydo.com/sitemaps/people-ask.xml | 200. No Skydo API or webhook Q&A. Only third-party (PayPal/Stripe) "link"/"integrate" questions |
| https://www.skydo.com/llms.txt | 200. Product list (local accounts, FIRA, dashboard "to track, invoice, and manage payments"). **No API mention** |
| https://www.skydo.com/faqs | 200. Categories: Payments, Fees, International accounts, Dashboard, InstaLinks |
| https://www.skydo.com/faqs/dashboard | 200. Includes "Can I integrate Skydo on my website for checkout?" → "Currently, this feature is not available." Full answers extracted from the embedded CMS JSON; see §2 |
| https://www.skydo.com/faqs/instalinks | 200. Answers in §2. No API mention |
| https://www.skydo.com/faqs/international-accounts | 200. Countries list in §2. No API mention |
| https://www.skydo.com/faqs/payments, /faqs/fees | 200. No mention of API, webhook, Zoho, CSV, Excel, Tally, QuickBooks or Xero (grep over raw HTML and JSON) |
| https://www.skydo.com/contact-us/sales | 200. No API, integration or developer wording |
| https://www.skydo.com/us (and /payouts → 308 → /us) | 200. US→India contractor payouts: "Bulk upload via file", batches, recurring. **No API mention** |
| https://www.skydo.com/terms-of-use | 200. §21 "Third Party Business Application" (Skydo-approved connections only). §25.8.12 bans "deep-links, page-scrape, robot, spider or other automatic device". §25.8.2 and §37.6 ban reverse engineering |
| https://www.skydo.com/blog/skydo-series-a-funding-announcement | 200. **"we will roll out developer-friendly APIs and webhooks"** (roadmap, undated). Also "By opening up our APIs…" |
| https://www.skydo.com/blog/category/whats-new-with-skydo | 200. 9 product posts (EDF generator, signup, Series A, Zoho integration, invoices and so on). **None announce an API or webhooks** |
| https://www.skydo.com/blog/skydo-feature-update-zoho-integration | 200. Zoho sync details in §2 |
| https://www.skydo.com/blog/a-quick-guide-to-using-the-skydo-platform | 200. Dashboard tour (invoices, reminders, ledger, FIRA, analytics). No API |
| https://www.skydo.com/blog/match-fira-to-invoice-automatically | 200, dated **27 Oct 2026**. Automation = auto-FIRA plus the Zoho integration only. Also says FIRA is "available in your inbox and Skydo dashboard" |
| https://www.skydo.com/blog/how-to-reconcile-export-payments-in-quickbooks (also /xero, /tally, /sap, /oracle-netsuite, /microsoft-dynamics) | 200. Generic manual reconciliation guides. No native connector |
| https://www.skydo.com/compare/skydo-vs-razorpay | 200. No API row |
| https://www.skydo.com/api/fxratelist | **200, unauthenticated JSON** of live mid-market FX rates (`[{fx_rate, api_timestamp, base, target}]`). This is a website widget endpoint, undocumented and not a product API. A third-party repo (vsniranjan/rate-radar) uses it |
| https://skydo-public-documents.s3.ap-south-1.amazonaws.com/veem/Terms+%26+Conditions+_+InstaLinks.pdf | 200. InstaLinks are facilitated by **Veem Inc.** (US/Canada AR, ACH). "Skydo will also send an email … to notify you of each transaction" |

### 1b. Subdomains

| Host | Result | Interpretation |
|---|---|---|
| docs.skydo.com | 302 → /login (BookStack, nginx/PHP) | Internal wiki, login-gated. Not public docs |
| docs.skydo.com/api | 302 → /login | Same |
| developer.skydo.com | **404** (AmazonS3 via CloudFront `dn8f8v840nbow.cloudfront.net`) | Empty distribution, nothing published |
| developer.skydo.com/docs, /api, /reference, /v1 | 301 → trailing slash → **404** | Generic redirect rule, no content |
| developer.skydo.com/openapi.json, /swagger.json, /robots.txt, /sitemap.xml | 404 | Nothing published |
| developers.skydo.com | no DNS / connection failed | Does not exist |
| api.skydo.com | 200 `text/plain` "All is well!! V4" | Health check of the dashboard backend (Spring-style headers) |
| api.skydo.com/docs, /swagger, /swagger-ui.html, /openapi.json, /v1, /v4, /v1/checkout, /api/v1/invoices, /webhooks, /health | **403** (empty body) | Private backend, no public surface |
| api.skydo.com/actuator/health | 404 | n/a |
| dashboard.skydo.com | 307 → /login | Merchant dashboard |
| dashboard.skydo.com/payment-links | 307 → /login | InstaLinks area of the dashboard |
| invoice.skydo.com | 301 → dashboard.skydo.com/new-invoice | Dashboard shortcut |
| pay.skydo.com | 307 → /login ("Skydo Payouts") | US payouts product dashboard, not a pay-link domain |
| app., help., support., blog., partners., partner., sandbox., status., link., links., checkout., cdn.skydo.com | no DNS / connection failed | Do not exist |
| web.skydo.com | 301 → www.skydo.com | Alias |
| stg-website.skydo.com | 200 | Staging copy of the marketing site |
| fx-calculator.skydo.com | 200 | Marketing calculator |

### 1c. GitHub, packages and marketplaces

| Source | Result |
|---|---|
| github.com/skydo | User account, 0 public repos, not the company |
| github.com/skydoapp, /skydotech, /skydo-official, /skydohq | 404 |
| github.com/skydo-tech | **Company org** (created 2022-08-27), 3 repos: `dlock` (Spring distributed lock), `hibernate-fsm`, `spring-search`. Internal Java libraries, **no SDK or API client** |
| GitHub code search `"api.skydo.com"` | 2 hits. RamitHansda/Programing: an ex-employee design doc for an internal support copilot, no public API. ysr-hameed/s3-storage-private `skydoService.js`: an undocumented `https://api.skydo.com/v1` Bearer client for "checkout/subscriptions/webhooks"; those endpoints return 403. **Not credible evidence** (no docs, does not match Skydo's product) |
| GitHub code search `"skydo.com/api"` | 1 hit: vsniranjan/rate-radar uses `www.skydo.com/api/fxratelist` (public FX widget) |
| GitHub repo search "skydo" | 492 results, all unrelated (skydock, skydoc, skydome…) |
| npm search "skydo" | 0 results. `skydo`, `skydo-sdk`, `skydo-api` → 404 |
| PyPI `skydo`, `skydo-sdk`, `skydo-api` | 404 |
| RubyGems search "skydo" | `[]` |
| Packagist search "skydo" | Unrelated results only |
| Zapier https://zapier.com/apps/skydo/integrations | **404** |
| Make https://www.make.com/en/integrations/skydo | 403 (bot wall). Web search found no Make app |
| n8n https://n8n.io/integrations/skydo/ | **404** |
| Pipedream https://pipedream.com/apps/skydo | **404** |
| RapidAPI search "skydo" | Generic SPA page. Web search shows no Skydo API listing |
| Postman public network | No Skydo workspace found in web search |
| Zoho Marketplace https://marketplace.zoho.com/app/books/skydo | Generic "page could not be found". The Zoho integration is **built into the Skydo dashboard** (OAuth "Connect Securely"), not a Marketplace listing |
| Xero App Store https://apps.xero.com/in/search?q=skydo | 404. No listing |
| QuickBooks / Intuit app store | No listing found (web search) |
| Product Hunt https://www.producthunt.com/products/skydo | 404 |

### 1d. Web search and third-party sources

| Query or source | Result |
|---|---|
| "Skydo API developers webhooks integration" (extended) | No official docs |
| https://www.winvesta.in/blog/businesses/xflow-vs-skydo-2026-honest-comparison-for-exporters | Competitor comparison: Skydo developer APIs "✗ (on roadmap)", "Developer tools are on the Series A roadmap but are not yet available." It also marks Zoho as ✗, which is wrong because the Zoho integration exists |
| https://precisiontech.in/solutions/payment-gateway-integration/skydo/ | Reseller SEO page claims Skydo "fires a webhook (or provides a daily transaction report via API)". No source, and it quotes fees ("$3–$15", "₹500 flat") that contradict Skydo's published slabs. **Unreliable** |
| "Skydo" API partner platform marketplace payouts embedded | No partner API. Amazon PSP approval (mediainfoline) only |
| Skydo job postings for public, partner or API platform roles | None found. skydo.com/careers → 404 |
| Skydo LinkedIn or Twitter posts on API, webhook or integrations 2026 | Nothing indexed |
| Skydo vs Razorpay MoneySaver, Payoneer, Wise API comparisons | No source credits Skydo with API access |
| Skydo QuickBooks, Tally or Xero integration | None native. Skydo's own blog only suggests pairing tools manually |
| https://dodopayments.com/zh/blogs/skydo-review, https://www.xflowpay.com/blog/skydo-vs-wise | Competitor reviews, no Skydo API claimed |

## 2. What a developer can actually use today

Facts below come from FAQ answers extracted from the CMS JSON embedded in `/faqs/*` pages, the Zoho post and the InstaLinks T&C.

### InstaLinks (payment links)

- **Created only in the dashboard.** FAQ faq-14: "Log in to your Skydo dashboard → InstaLinks (dashboard.skydo.com/payment-links) → Create Payment Link → Add your client and payment details → Share the link."
- **No URL pattern or prefill.** No URL-template or query-string creation is documented. The public `pay.skydo.com` host is the Payouts dashboard, not a link resolver. A link URL cannot be constructed programmatically.
- **Single use (faq-13).** "once a client completes a payment using a link, it is marked as completed and cannot be used again. You will need to create a new payment link for any future payments." There is no reusable or fixed per-client link.
- **Other link rules:**
  - No expiry (faq-12).
  - No recurring payments (faq-6), EMI (faq-7) or partial payments (faq-8).
- **Payment rail:** US ACH Debit through Veem Inc.
  - Fee: "Flat 2% per transaction (min $9 per transaction)" (faq-9).
  - Settles in about 6 US business days (faq-10/11).
  - The Series A post plans card support ("scaling Skydo InstaLinks for card payments").
- **Statuses (faq-31):**
  - **Outstanding:** the default.
  - **Paid – Settlement in Progress:** the payer has authorised. The merchant then uploads the invoice.
  - **Paid:** credited to the Indian bank.
- **Email notifications:** sent on authorisation and again on final confirmation or failure (faq-28 to faq-32).
- **Chargebacks:** possible. Skydo may debit the merchant's balance (faq-21/23/24/25).

### Local receiving accounts ("international accounts" / virtual accounts)

- **Local rails:** US (USD), UK (GBP), UAE (AED), Canada (CAD), Europe (EUR), Australia (AUD) and Singapore (SGD) (faq-19).
- **SWIFT account:** an International SWIFT ("Rest of the World") account for 32 currencies, used for non-local-currency payments. Details are at dashboard.skydo.com/international-accounts?location=row.
- **Static and per merchant.** The details are standing account details, not per-invoice. Skydo's invoice builder lets you pick "a pre-set local bank account" to print on the invoice. The 27 Oct 2026 FIRA blog says: "Share the correct account details and invoice reference with your client."
  - **So yes: they can be printed as static bank details on any invoice or checkout page.**
  - Skydo publishes no per-client virtual account numbers.
- **Every inbound credit must be matched to an invoice in the dashboard** before it is converted and paid out. From the FAQ on mismatches: "you can continue to map the received payment to the invoiced amount."
- **Limits:** minimum payment is USD 50, with no upper limit.
- **Fees:** USD 19 + GST up to $2,000, USD 29 + GST from $2,001 to $10,000, and 0.3% + GST above that.

### Zoho Books integration (the only native integration)

- **Setup:** Skydo profile → "Connect Skydo to Zoho" → Connect Securely (Zoho OAuth).
- **Sync frequency:** every 10 minutes.
- **What syncs:**
  - **Zoho → Skydo:** new invoices only ("only new invoices created after the integration will be transferred"). An option limits the sync to international invoices or includes all currencies.
  - **Skydo → Zoho:** the matching invoice is **auto-marked paid** when payment arrives, and the **FIRA PDF is uploaded** to the Zoho invoice.
  - Customer sync is not mentioned.
- **Implication for developers:** Zoho Books has a full public REST API. Invoices created in Zoho via its API flow into Skydo automatically, and paid status plus FIRA flow back. **This is the only programmatic loop into and out of Skydo available today.**

### Notifications

- **On receipt into the local account:** email and WhatsApp, at every step ("How will I be notified…" FAQ).
- **InstaLinks:** email on authorisation and again on success or failure.
- **Per-transaction confirmation email:** confirmed by the Veem T&C §3.9.
- **FIRA:** delivered "in your inbox" as well as on the dashboard.

### Exports

- **Bulk downloads (faq-47):** Analytics & Reports → Reports tab, filtered by date range and client. "Download" is available per document type: invoices, FIRAs, Skydo receipts and payment details.
- **FIRA:** per-invoice "Download FIRA", or bulk download.
- **Unknown file format:** Skydo does not publicly document whether "payment details" is CSV or XLSX. Confirm with a real account before building a parser.
- **Ledger:** shareable with a client.
- **Payouts product (US→India):** supports "Bulk upload via file", which is an inbound file, not an API.

### Terms-of-use constraints

- §25.8.12 forbids scraping, robots and "deep-links" against the platform. §25.8.2 and §37.6 forbid reverse engineering.
- **The MCP must not drive the dashboard or call `api.skydo.com`.**
- **Permitted inputs:** files and emails the user already receives, and public APIs of connected tools such as Zoho.

## 3. Ranked legitimate automation options for the MCP

1. **Zoho Books bridge (highest value; fully programmatic and sanctioned).**
   - The MCP creates or sends invoices through the Zoho Books API.
   - Skydo picks them up within about 10 minutes, and paid status plus the FIRA attachment flow back to Zoho.
   - The MCP reads payment status and FIRA from Zoho. The user connects Skydo↔Zoho once in the dashboard.
2. **Invoice/PDF generator with static Skydo receiving details.**
   - The user stores their Skydo local-account details (US ACH, UK FPS, EU SEPA, CA, AU, SG, AE, SWIFT) in MCP config.
   - The MCP picks the right account by client currency and country, and prints the details plus a unique invoice reference on a compliant export invoice.
   - The invoice includes invoice number, date, client name and address, service description, SAC/HSN, amount, and LUT where relevant (per Skydo's invoice FAQ).
   - The MCP should also enforce Skydo rules: the USD 50 minimum, local account for local currency, SWIFT for non-local currency, and the fee estimate from the published slabs.
3. **Expected-payments tracker plus CSV/report reconciliation.**
   - The MCP keeps a ledger of issued invoices and expected amounts.
   - The user drops the Reports-tab download (payment details, FIRAs) into a folder, and the MCP matches by reference, amount and client.
   - It flags short payments caused by bank or SWIFT deductions (a known Skydo FAQ case), overdue items, and missing FIRAs.
4. **Email notification parsing (opt-in, user's own mailbox).**
   - Parse Skydo's credit, InstaLink and FIRA emails through the user's Gmail or IMAP connector to update the tracker in near real time and archive FIRA PDFs.
   - Treat parsing as best-effort because templates are undocumented.
5. **InstaLink assist (human-in-the-loop).**
   - The MCP prepares the client and amount details and deep-links the user to `https://dashboard.skydo.com/payment-links` to click "Create Payment Link".
   - The user pastes the resulting single-use URL back, and the MCP tracks it (Outstanding → Paid–Settlement in Progress → Paid) and reminds the user to upload the invoice.
   - Fee awareness: 2% (minimum $9) versus the flat bank-transfer fee.
6. **FX quote (optional, low priority).**
   - `https://www.skydo.com/api/fxratelist` returns public mid-market rates, but it is an undocumented website endpoint and may change.
   - If used, label it as indicative, cache it, and prefer a neutral FX source. Do not present it as a Skydo API.
7. **Watch for the real API.**
   - Monitor `developer.skydo.com` (an empty CloudFront distribution today) and the "What's new" blog category.
   - Optionally ask Skydo support or partnerships (support@skydo.com; the Partnerships Manager is named on the blog) whether early or partner access exists under Terms §21.
   - Until then, there is no evidence that it is available on request.
