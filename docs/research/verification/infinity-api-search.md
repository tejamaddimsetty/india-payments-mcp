# Infinity (infinityapp.in): API search and facts used

Checked 2026-10-29. Everything the Infinity adapter states comes from the sources below. Requests to Infinity were limited to plain GETs: public pages of www.infinityapp.in, and one unauthenticated `curl` GET of `/` on each of `docs.`, `developer.`, `developers.`, `api.` and `dashboard.infinityapp.in` to see which hosts exist. No credentials were used, nothing was submitted, and no API route was called.

## Is there a developer API?

| Check | Result |
|---|---|
| Web search: "infinityapp.in API developer docs payment link webhook" (extended) | No Infinity docs. Results were other products named Infinity / Infini / InfinitePay |
| Terms and Conditions (infinityapp.in/terms-and-condition) | Defines an "API" provided by Infinity and says details are "available through our API Documentation", but that documentation is not public. Also: no reverse engineering (O.4, O.6); no incorporating the Services into other systems or third-party use of Infinity IP without prior written consent (O.6); "The Dashboard, APIs, and associated software, documentation, and data" are Confidential Information (P.6) |
| Hosts `docs.`, `developer.`, `developers.` (`.infinityapp.in`) | Do not resolve. The Terms (B.4/B.5) name docs.infinityapp.in as the API documentation, so docs exist or existed but are not publicly reachable |
| `api.infinityapp.in` | Responds 404 at `/` (exists; nothing public) |
| Help centre (infinityapp.in/faqs) | No API, developer or webhook articles |
| QuickLink blog post | "does not require heavy payment gateway integration ... No website or technical setup required" |
| Zoho Books | No public page. A merchant dashboard's **Connect** tab lists a Zoho Books integration (reported by the project owner from a user's dashboard on 2026-10-29). What it syncs is undocumented |

Conclusion: no usable public API. The adapter never contacts Infinity. It uses the Zoho integration through Zoho's public API (confirm-during-setup), and receiving-account details / QuickLinks with a ledger.

## Facts used, with sources

| Fact | Source |
|---|---|
| Receivable currencies: "USD, EUR, GBP, AUD, CAD" with local account details; SWIFT "for currencies where local rails are not supported" | faqs/articles/which-currencies-can-i-receive |
| "a flat 0.5% on each incoming payment"; no setup/monthly fees; "0% FX Markup" | faqs/articles/how-infinity-pricing-works |
| "Most payments settle to your Indian bank account within 24 hours of arriving in Infinity"; weekends/holidays next working day; statuses "received to converted to settled" | faqs/articles/when-will-i-receive-my-money |
| FIRA: "Open any settled payment and click Download FIRA"; generated automatically at no cost | faqs/articles/getting-your-fira |
| QuickLinks are "shareable online payment links that eligible Infinity users can send to overseas clients"; availability "may depend on the payment currency, country, method, and account review"; generating or sharing one "does not mean a client has paid" | faqs/articles/what-quicklinks-are-and-who-can-use-them |
| Client pays by "Debit/Credit card or Bank Transfer" | blog/infinity-quicklink |
| Client needs no Infinity account to pay by card | faqs/articles/does-a-client-need-an-infinity-account-to-pay |
| Create a link from an invoice: Create invoice > client, currency, number, purpose code, dates > items > Step 3 Payment details > Credit card > Review invoice > copy link. Recurring invoice setting is separate from the payment link; don't tell clients a card is charged automatically | faqs/articles/how-to-generate-a-payment-link-from-an-invoice |
| QuickLink statuses: pending, completed, failed. Rely on the status in your account, not a client's claim | faqs/articles/how-to-track-quicklinks-payments |
| Company: Scalifi Wealth Pvt Ltd; funds move through RBI-regulated AD-I banks | infinityapp.in footer |

## Not documented (and how the code handles it)

| Unknown | Handling |
|---|---|
| Minimum amount | None enforced; noted |
| QuickLink URL host and format | Only https links on `INFINITY_QUICKLINK_HOSTS` (default *.infinityapp.in: the domain and subdomains); merchant confirms the host of the first real link |
| Whether a QuickLink is single-use or reusable, fixed-amount or not | One link per order; the code refuses a different link for the same order and tells the merchant to check the link amount |
| What the Zoho Books integration syncs | Zoho is read as the source of truth; paid only when Zoho payments cover the total; merchant confirms with one real invoice during setup |
| Refunds | Unsupported (ask Infinity support) |
| Transaction reference format | Free-form `receipt_id` (max 100 chars), deduped case-insensitively |
