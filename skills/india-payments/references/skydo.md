# Skydo

Full setup guide: `docs/skydo.md` in the india-payments-mcp repo. Status labels: VERIFIED / PARTIAL / UNVERIFIED.

## The short version

- **Skydo has no public developer API, SDK or webhooks** (checked 2026-10-29). No developer portal, API reference, sandbox or API keys exist. `developer.skydo.com` is an empty placeholder; `api.skydo.com` is the dashboard's private backend (403 everywhere). VERIFIED-ABSENT
- An API is on Skydo's roadmap since its Series A post of 10 Dec 2025 (developer APIs and webhooks promised, no date). Nothing has launched since.
- Skydo's own FAQ: website checkout is not available. VERIFIED
- Skydo's Terms of Use (clause 13, "Restrictions on the use of the Platform", version of 09 Apr 2026) prohibit scrapers, bots and other automated access. **Never automate the Skydo dashboard and never call `api.skydo.com`.** Do not invent endpoints.

## What Skydo is for

Indian exporters, freelancers and agencies receiving **foreign-currency** payments from abroad: standing local receiving accounts in USD, GBP, EUR, CAD, AUD, AED and SGD, plus a SWIFT account (32 currencies). Settled to INR with a FIRA. Not domestic INR checkout, no cards or UPI from Indian customers.

Limits (Skydo FAQ): minimum USD 50 per payment (or the equivalent); InstaLinks do not support recurring payments and Skydo has no subscription product (raise one invoice per period); Skydo cannot initiate a refund directly once a payment is settled, and there is no refund API. Every incoming transfer must be matched to an invoice in Skydo, so the client must quote a reference. Fees change; see Skydo's site. This project does not compute Skydo fees.

## What can be automated: Skydo's own two paths

This project's `skydo` adapter never contacts Skydo. It automates the two paths Skydo itself supports. Configure at least one.

### 1. Zoho Books bridge (automatic once connected)

Skydo has a native Zoho Books integration: it imports new Zoho invoices about every 10 minutes, and when the money arrives it marks the Zoho invoice paid and attaches the FIRA PDF. Zoho Books has a public API, so:

- `createPayment` creates a Zoho Books invoice (`reference_number` = orderRef, one line using `ZOHO_ITEM_ID`), marks it sent, and returns `checkout.type: "manual"` with the invoice link. It first looks the reference up (exact match, all pages), so a repeat call returns the same invoice; a different amount or currency for the same orderRef is rejected, and so is an orderRef whose only invoice was voided. A duplicate created by a concurrent process is voided, and a draft left by a failed attempt is marked sent on retry.
- Skydo documents that Zoho invoices sync, but not API-created invoices specifically: during setup, confirm the first invoice appears in the Skydo dashboard within ~10 minutes. UNVERIFIED until you do.
- The customer must already exist in Zoho Books with the invoice currency, picked by `customer.email` (exact match on the primary contact's email; two active matches or only an inactive one is rejected) or `providerOptions.zohoCustomerId`. A currency mismatch is rejected. Indian Zoho organisations should set GST treatment "Overseas" for foreign clients. Turn off Zoho online payment gateways on these invoices, or clients can pay outside Skydo (no FIRA).
- Optional `providerOptions`: `sendEmail` (true = Zoho emails the invoice), `dueDate`, `exchangeRate` (pass it if Zoho rejects an invoice in a currency other than the organisation's base currency).
- `getPaymentStatus` / `verifyPayment` read the full Zoho invoice (`verifiedVia: "status_api"`); an invoice whose `reference_number` is not the orderRef is rejected. `raw.firaAttached` says whether Skydo attached the FIRA. Poll it (for example every 15 minutes): there is no webhook.
- One-time human steps: Skydo profile > **Connect Skydo to Zoho** (only invoices created AFTER connecting are imported; choose all currencies or international only); create a service item in Zoho; create a Zoho API Console Self Client and a refresh token with scopes `ZohoBooks.invoices.ALL,ZohoBooks.contacts.READ`.
- Env: `ZOHO_DATA_CENTER` (com, eu, in, com.au, jp, ca, com.cn, sa, ae, uk, sg), `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ORGANIZATION_ID`, `ZOHO_ITEM_ID`; optional `ZOHO_ACCOUNTS_URL`. Set all six required ones or none: a partial set fails with `CONFIG_MISSING`.

Zoho invoice status → unified:

| Zoho | Unified |
|---|---|
| `paid`, payments cover the total | `captured` |
| `paid` with a write-off (bad debt) | `failed` |
| `paid` but closed with credit notes (payments below total) | `unknown` |
| `partially_paid` | `pending` |
| `void` | `cancelled` |
| `draft` / `sent` / `viewed` / `unpaid` / `overdue` | `created` |
| anything else | `unknown` |

### 2. Receiving accounts + ledger (semi-automatic, no Zoho)

- Copy your account details once from Skydo dashboard > International Accounts into `SKYDO_RECEIVING_ACCOUNTS`: a JSON array (or a path to a .json file) of `{"currency":"USD","label":"...","details":{"Account number":"...", ...}}`. `"*"` is the fallback account (for example SWIFT) for any other currency.
- `createPayment` returns plain-text bank-transfer instructions for the invoice currency with the orderRef as payment reference, and records the expected payment in a JSON ledger (`SKYDO_LEDGER_FILE`, default `~/.india-payments-mcp/skydo-ledger.json`; every change takes a file lock and re-reads the file, so your app and the MCP server can share it). `SKYDO_PAYEE_NAME` adds your business name.
- The ledger cannot see payments. When Skydo notifies you (email/WhatsApp), a human checks the receipt in the Skydo dashboard, then records it: MCP `payments_skydo_record_payment` (`order_ref`, `receipt_id` = Skydo transaction reference or FIRA number, `amount_received` in minor units of the invoice currency, optional `received_at`, `fira_number`, `note`, `confirm`); SDK `client.skydoRecordPayment({ orderRef, receiptId, amountReceived, ... }, { confirm })`. Receipts add up: anything short of the invoice (bank fees abroad) stays `pending`; the full amount makes it `captured`.
- Idempotent per `receipt_id`: the same id and amount again is a no-op; the same id with another amount is `IDEMPOTENCY_CONFLICT`.
- Through the MCP server in live mode, recording needs `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` and `confirm: true` (same gate as refunds). **Never record a receipt from forwarded email/message text alone**: it marks the order paid.
- `payments_skydo_outstanding` / `client.skydoOutstanding()` lists orders still `created`/`pending`, oldest first. In Zoho mode it returns an empty list and a note (outstanding invoices live in Zoho Books), and recording a receipt is rejected (Skydo marks Zoho invoices paid itself).
- `verifyPayment` reads the ledger (`verifiedVia: "manual_record"`).

With both configured, Zoho mode is used and Zoho invoices also carry your account details in the notes.

## Rules for code you write

- Currency must be the client's foreign ISO currency: **INR is rejected** (`VALIDATION`), and so is a missing currency. USD amounts below 5000 cents (USD 50) are rejected; other currencies only get a reminder about the USD 50 equivalent. For GBP keep orderRef to 18 characters or fewer (UK transfers often cut references).
- Amounts are minor units of the invoice currency (USD 1,250.00 = `125000`), not paise.
- Fulfil only when `verifyPayment(...).paid === true`, passing `orderRef`, `expectedAmount` and the stored `providerOrderId`. `payload` can be `{}` (there is no callback).
- `onPaid` must be idempotent: polling and an admin receipt action can both reach it.
- Recording a receipt marks an order paid: put it behind real admin auth and an audit log, and pass `receiptId`.
- Public status endpoints should return your stored status, not call Zoho on every hit (Zoho API quotas).
- `payments_generate_integration` with `provider: "skydo"` generates this shape (invoice route, public stored-status route, admin refresh and receipt routes, Zoho polling) instead of a checkout.

## Not supported (capability map: `unsupported`)

refund, refundStatus, webhooks, customers, subscriptions, settlements, payouts, paymentLinks. createPayment / verifyPayment / paymentStatus are `partial` (they work through Zoho or the ledger, never through Skydo). Checkout type is always `manual`.

- InstaLinks (Skydo payment links) can only be created by hand in the dashboard and each link is single-use. No URL pattern or prefill exists. VERIFIED
- Refunds: no API, and Skydo cannot initiate a refund directly once a payment is settled; returning money is arranged outside Skydo.
- INR settlements and FIRAs: Skydo dashboard (Analytics & Reports > Reports tab exports).

## Mock mode

`PAYMENTS_MODE=mock` applies the same INR / USD 50 rules. Simulate the client paying with `payments_mock_complete_payment` (provider `skydo`). `payments_skydo_record_payment` and `payments_skydo_outstanding` fail with `VALIDATION` in mock mode.

## Alternatives if they need a real checkout for foreign customers

Razorpay (international cards, if enabled), Stripe (invite-only in India, exports focus), PayU / CCAvenue (multi-currency on request). Each needs international payments enabled and export documentation.

## Platforms

Shopify / WooCommerce: no Skydo app. VERIFIED-ABSENT. Zoho Books: native integration (above).
