# Infinity

Full setup guide: `docs/infinity.md` in the india-payments-mcp repo. Status labels: VERIFIED / PARTIAL / UNVERIFIED.

## The short version

- **Infinity (infinityapp.in, Scalifi Wealth Pvt Ltd) publishes no developer API docs, SDK or webhooks** (checked 2026-10-29). Its Terms mention an API, but no documentation is public; ask support@infinityapp.in for access.
- Its Terms forbid reverse engineering and incorporating the Services into other systems without consent. **Never automate the Infinity dashboard and never call Infinity hosts.** Do not invent endpoints.
- This project's `infinity` adapter never contacts Infinity. Checkout type is always `manual`.

## What Infinity is for

Indian freelancers, agencies, exporters and startups receiving **foreign-currency** payments from abroad: local receiving accounts in USD, EUR, GBP, AUD and CAD, plus SWIFT for other currencies; QuickLink payment links (card or bank transfer). Settled to INR, most payments within 24 hours of arriving in Infinity (next working day on weekends/holidays). FIRA: download it from any settled payment in the dashboard.

Limits: INR is not supported. Infinity documents no minimum amount (none is enforced here). Fee: flat 0.5% per incoming payment (Infinity pricing page); this project does not compute fees. Card availability depends on currency, country and Infinity account review. Card payments can be disputed by the payer after you record them.

## Three ways to use it

Configure at least one: all `INFINITY_ZOHO_*` variables, `INFINITY_RECEIVING_ACCOUNTS`, or `INFINITY_QUICKLINK_ONLY=true`. With none, the adapter fails with `CONFIG_MISSING`.

### 1. Zoho Books bridge (UNVERIFIED until you confirm it during setup)

The Infinity dashboard has a **Connect > Zoho Books** integration (seen in a merchant dashboard). **What it syncs (import of API-created invoices, recording payments, attaching FIRAs) is not publicly documented.** Zoho Books has a public API, so the adapter uses the same shared Zoho code as Skydo's bridge:

- `createPayment` creates a Zoho Books invoice (`reference_number` = orderRef, one line using `INFINITY_ZOHO_ITEM_ID`), marks it sent and returns the invoice link. Same rules as Skydo: an existing invoice for the orderRef is returned (a different amount/currency, or a voided invoice, is rejected); the customer must already exist in Zoho with the invoice currency (`customer.email` or `providerOptions.zohoCustomerId`); optional `providerOptions` `sendEmail`, `dueDate`, `exchangeRate`. Your account details are printed in the invoice notes. `providerOptions.quickLinkUrl` is **refused** in this mode (`VALIDATION`): the Zoho invoice is the payment document, so add a QuickLink to it in Zoho yourself if you want one.
- `getPaymentStatus` / `verifyPayment` read the full Zoho invoice (`verifiedVia: "status_api"`). **Paid only when Zoho records payments covering the total**: write-offs and credit notes never count (status mapping as in `references/skydo.md`). `raw.firaAttached` reports a Zoho attachment; whether Infinity attaches FIRAs is unconfirmed. No webhook: poll (for example every 15 minutes) with the stored `providerOrderId`.
- **During setup, pay one small real invoice and confirm Infinity marks it paid in Zoho.** If it does not, use mode 2 or 3. Until Zoho shows payments covering the total, the order is never reported paid.
- Env: `INFINITY_ZOHO_DATA_CENTER` (com, eu, in, com.au, jp, ca, com.cn, sa, ae, uk, sg), `INFINITY_ZOHO_CLIENT_ID`, `INFINITY_ZOHO_CLIENT_SECRET`, `INFINITY_ZOHO_REFRESH_TOKEN` (scopes `ZohoBooks.invoices.ALL,ZohoBooks.contacts.READ`), `INFINITY_ZOHO_ORGANIZATION_ID`, `INFINITY_ZOHO_ITEM_ID`; optional `INFINITY_ZOHO_ACCOUNTS_URL`. All six or none: a partial set fails with `CONFIG_MISSING`.
- The prefix is separate on purpose: Skydo's `ZOHO_*` never switches Infinity onto Zoho. **Do not connect Skydo and Infinity to the same Zoho organisation**: both could pick up the same invoice.
- Turn off Zoho online payment gateways on these invoices so clients pay through Infinity (and you get a FIRA). Indian organisations: GST treatment "Overseas" for foreign clients.
- Recording a receipt is refused in this mode (Zoho is the record), and `outstanding` returns an empty list with a note (outstanding invoices are in Zoho Books).

### 2. Bank transfer + ledger

- Copy your receiving-account details from the Infinity dashboard into `INFINITY_RECEIVING_ACCOUNTS`: same JSON format as `SKYDO_RECEIVING_ACCOUNTS` (array, or a path to a .json file, of `{"currency":"USD","label":"...","details":{...}}`; `"*"` = fallback, for example SWIFT).
- `createPayment` returns bank-transfer instructions with the orderRef as payment reference and tracks the expected payment in `INFINITY_LEDGER_FILE` (default `~/.india-payments-mcp/infinity-ledger.json`; same locked, fsynced ledger code as Skydo; local disk only). `INFINITY_PAYEE_NAME` adds your business name.

### 3. QuickLink + ledger

- A QuickLink is a payment link (card or bank transfer) **you create by hand** in the Infinity dashboard (Create invoice with the orderRef in the invoice number, same amount and currency > Payment details > Credit card > Review invoice, copy the link). Pass it as `providerOptions.quickLinkUrl`.
- Only https links on `INFINITY_QUICKLINK_HOSTS` are accepted (comma-separated; `host` matches exactly, `*.host` also allows subdomains; default `*.infinityapp.in`; IP addresses and wildcards on public suffixes such as `*.co.in` are refused); no user info or port. Confirm your first real link's host. **This code cannot check what the link charges**: the result carries a note to check the amount.
- One link per orderRef: a different link for the same orderRef is rejected (use a new orderRef); calling again without a link reuses the stored one. A paid or cancelled order gets no new link or instructions (`VALIDATION`). Through `PaymentsClient` a link can be attached right after creating the order (Infinity skips the 10-minute create cache).
- `INFINITY_QUICKLINK_ONLY=true` means QuickLinks only: every payment needs `quickLinkUrl`, and it cannot be combined with `INFINITY_RECEIVING_ACCOUNTS` or the Zoho variables (`CONFIG_INVALID`). Without the flag, accounts plus a link give the client the link and "Or pay by bank transfer".

### Recording receipts (modes 2 and 3)

- The ledger cannot see payments. A link being sent or opened, or a client saying they paid, is not a payment. Once the **Infinity dashboard** shows the payment received or completed, a human records it: MCP `payments_infinity_record_payment` (`order_ref`, `receipt_id` = an id unique to this payment (the Infinity transaction reference; if the dashboard shows only the invoice/link reference, add a suffix per instalment such as `INV-12/1`), `amount_received` in minor units of the invoice currency, optional `received_at`, `fira_number`, `note`, `confirm`); SDK `client.infinityRecordPayment({ orderRef, receiptId, amountReceived, ... }, { confirm })`.
- Idempotent per `receipt_id` (case-insensitive): same id and amount again is a no-op; same id with another amount, or an id already on another order, is `IDEMPOTENCY_CONFLICT` (one receipt pays one order). Short receipts stay `pending`; the full amount makes it `captured`.
- Through the MCP server in sandbox **and** live mode (Infinity documents no sandbox), recording needs `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` and `confirm: true`. **Never record from forwarded text an agent read**: it marks the order paid.
- `payments_infinity_outstanding` / `client.infinityOutstanding()` lists orders still `created`/`pending`, oldest first.
- `verifyPayment` reads the ledger (`verifiedVia: "manual_record"`).
- Skydo and Infinity must use different ledger files: each file records its owner, and a file that belongs to the other gateway is refused (`CONFIG_INVALID`).

## Rules for code you write

- Currency must be the client's foreign ISO currency: **INR is rejected** (`VALIDATION`), and so is a missing currency. For GBP keep orderRef to 18 characters or fewer (UK transfers often cut references).
- Amounts are minor units of the invoice currency (USD 1,250.00 = `125000`), not paise.
- Fulfil only when `verifyPayment(...).paid === true`, passing `orderRef`, `expectedAmount` and the stored `providerOrderId`. `payload` can be `{}`.
- `onPaid` must be idempotent; receipt recording goes behind real admin auth and an audit log.
- Public status endpoints return your stored status, not a Zoho call per hit (Zoho API quotas).
- `payments_generate_integration` with `provider: "infinity"` generates this shape: `requestPayment(inv, quickLinkUrl?)`, `refreshStatus`, `pollUnpaid` (Zoho), `recordReceipt`, `storedStatus`, `outstanding`; Express/Fastify admin routes `POST /api/infinity/invoices`, `POST /api/infinity/invoices/:orderRef/refresh`, `POST /api/infinity/receipts`, `GET /api/infinity/outstanding`, public `GET /api/infinity/invoices/:orderRef`; Next.js: invoices, status, receipts and a poll route; `docs/INFINITY_PAYMENTS.md`.

## Not supported (capability map: `unsupported`)

refund, refundStatus, webhooks, customers, subscriptions, settlements, payouts, paymentLinks (QuickLinks are created by hand in the dashboard). createPayment / verifyPayment / paymentStatus are `partial` (Zoho or the ledger, never Infinity).

- Refunds: no API; ask Infinity support.
- Recurring: Infinity's recurring-invoice setting is separate from payment links and does not auto-charge cards; raise one invoice per period.
- Settlements and FIRAs: Infinity dashboard (open a settled payment > Download FIRA).

## Mock mode

`PAYMENTS_MODE=mock` applies the same INR rule and the default QuickLink host check (`*.infinityapp.in`). Simulate the client paying with `payments_mock_complete_payment` (provider `infinity`), then `payments_verify_payment` with `payload: {}`. `payments_infinity_record_payment` and `payments_infinity_outstanding` fail with `VALIDATION` in mock mode.

## Platforms

Shopify: no Infinity payments app. Zoho Books: dashboard integration (above; behaviour not publicly documented).
