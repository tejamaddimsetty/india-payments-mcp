# Infinity

[Infinity](https://www.infinityapp.in) (Scalifi Wealth Pvt Ltd, Bengaluru) collects international payments for Indian freelancers, agencies, exporters and startups. It gives you local receiving accounts abroad (USD, EUR, GBP, AUD, CAD, plus SWIFT for other currencies) and **QuickLinks**, payment links your client pays by card or bank transfer. It charges a flat 0.5% per incoming payment, settles to your Indian bank account (most payments within 24 hours of arriving), and issues a FIRA for every settled payment.

## Status: no public API

Checked on 2026-10-29 (details in [research/verification/infinity-api-search.md](research/verification/infinity-api-search.md)):

- Infinity's Terms mention an API and "API Documentation", but no documentation is public: there is no docs site, no SDK, no webhooks, and nothing in a web search. If you need it, ask support@infinityapp.in.
- Its Terms forbid reverse engineering the Services and incorporating them into other systems without consent. **This project never contacts Infinity, its dashboard or any private endpoint.**
- A merchant's Infinity dashboard has a **Connect** tab with a **Zoho Books** integration. What it syncs (whether it imports invoices created through the Zoho API, records payments on them, attaches FIRAs) is not publicly documented.

So, like Skydo, the adapter automates the paths Infinity offers merchants, and tells you plainly where a human has to confirm something.

## Three ways to use it

| | Zoho Books bridge | Bank transfer | QuickLink |
|---|---|---|---|
| Configure | all `INFINITY_ZOHO_*` variables | `INFINITY_RECEIVING_ACCOUNTS` | `providerOptions.quickLinkUrl` per payment (`INFINITY_QUICKLINK_ONLY=true` if you have no bank details configured) |
| What the client gets | A Zoho Books invoice (reference = your order id) | Your Infinity account details for their currency, with the order id as reference | The QuickLink you created in the Infinity dashboard (card or bank transfer), plus bank details if configured |
| How "paid" is known | Read from Zoho: paid only when Zoho payments cover the invoice total | You record the receipt after checking the Infinity dashboard | Same as bank transfer |
| Status source (`verifiedVia`) | `status_api` | `manual_record` | `manual_record` |

Bank transfer and QuickLink can be combined; `INFINITY_QUICKLINK_ONLY=true` cannot be combined with bank details or Zoho. With the Zoho bridge, account details are printed in the invoice notes, and `quickLinkUrl` is refused: the Zoho invoice is the payment document, so add a QuickLink to it in Zoho yourself if you want one.

## Setup

### Bank transfer (and QuickLinks)

1. Copy your receiving account details from the Infinity dashboard into `INFINITY_RECEIVING_ACCOUNTS`, as inline JSON or a path to a `.json` file (same format as Skydo's):

   ```json
   [
     { "currency": "USD", "label": "US account (ACH)", "details": { "Account holder": "...", "Account number": "...", "ACH routing": "..." } },
     { "currency": "*", "label": "SWIFT", "details": { "SWIFT/BIC": "...", "Account number": "..." } }
   ]
   ```

   `"*"` is the fallback for currencies without a local account.
2. Optional: `INFINITY_PAYEE_NAME` (your business name in the instructions) and `INFINITY_LEDGER_FILE` (default `~/.india-payments-mcp/infinity-ledger.json`).
3. QuickLinks: in Infinity, **Create invoice** (invoice number = your order id, the same amount and currency) > **Payment details** > **Credit card** > **Review invoice**, then copy the generated link and pass it as `providerOptions.quickLinkUrl`.
   - Only `https` links on `INFINITY_QUICKLINK_HOSTS` (default `*.infinityapp.in`: the domain and its subdomains) are accepted, without credentials or ports. A bare host matches exactly; `*.` allows subdomains. IP addresses and wildcards on public suffixes (`*.co.in`) are refused. This stops an agent or a pasted message from sending your client to a look-alike site.
   - Check the host of your first real link. If Infinity uses another host, add it to `INFINITY_QUICKLINK_HOSTS`.
   - The code cannot read what a link charges, so make sure the link is for exactly the order amount.

### Zoho Books bridge

1. In the Infinity dashboard: **Connect** tab > **Zoho Books**, and connect your Zoho organisation.
2. In Zoho Books, set up:
   - a service item for invoice lines; its `item_id` goes in `INFINITY_ZOHO_ITEM_ID`;
   - each client, once, as a customer in their billing currency. Indian organisations should set GST treatment "Overseas".
3. Turn off Zoho's online payment gateways for these invoices, so clients pay through Infinity and you get a FIRA.
4. Get a refresh token:
   - Zoho API Console > **Self Client** > Generate Code with scope `ZohoBooks.invoices.ALL,ZohoBooks.contacts.READ`.
   - Exchange the code at your region's accounts host, the same steps as in [skydo.md](skydo.md#step-4-create-a-self-client-and-a-refresh-token-zoho-api-console).
5. Set `INFINITY_ZOHO_DATA_CENTER`, `INFINITY_ZOHO_CLIENT_ID`, `INFINITY_ZOHO_CLIENT_SECRET`, `INFINITY_ZOHO_REFRESH_TOKEN`, `INFINITY_ZOHO_ORGANIZATION_ID` and `INFINITY_ZOHO_ITEM_ID`. `INFINITY_ZOHO_ACCOUNTS_URL` is optional.
6. **Confirm the sync with one real invoice.** Create it with `payments_create_payment`, have a small real payment sent, and check that Infinity marks the invoice paid in Zoho.
   - Until Zoho shows payments covering the total, the order is never reported paid.
   - If Infinity never marks it paid, use the bank-transfer mode instead.

Infinity uses its own `INFINITY_ZOHO_*` variables, so setting Skydo's `ZOHO_*` never moves Infinity onto Zoho, and the reverse. **Don't connect Skydo and Infinity to the same Zoho organisation:** both could pick up the same invoice.

The Zoho code is shared with Skydo's bridge (`src/providers/shared/zoho*.ts`), which has been through three verification rounds:

- invoice creation is idempotent on `reference_number`;
- a twin created by a race is voided deterministically;
- a full read checks `payment_made` and `write_off_amount`. A write-off or credit-note closure is never counted as paid, and an invoice whose reference is not the order id is refused.

## Flow

```text
your app / agent                       india-payments-mcp                     you (admin)
----------------                       ------------------                     -----------
payments_create_payment  ───────────►  validate currency (not INR) and the link
  provider=infinity, USD 2500.00       Zoho: create invoice + mark sent
  provider_options.quickLinkUrl        ledger: track expected payment
                         ◄───────────  checkout { type: manual, instructions, url }
send instructions to client
                                       ... client pays through Infinity ...
                                                                              sees it in the Infinity dashboard
                                       Zoho: Infinity marks the invoice paid  (Zoho mode: nothing to do)
                                       ledger: payments_infinity_record_payment ◄── receipt_id + amount, confirm=true
payments_verify_payment  ───────────►  paid = status captured + order ref and amount match
```

Ledger receipts follow these rules:

- Amounts are in minor units of the invoice currency (cents), not the INR settlement.
- `receipt_id` must be unique to each payment: the Infinity transaction reference if the dashboard shows one. Infinity's help centre mentions only an "invoice or link reference"; if that is all you have, add a suffix per instalment (`INV-12/1`, `INV-12/2`), because recording the same id again is a no-op. Ids are compared case- and space-insensitively, and one receipt can only pay one order.
- A short receipt keeps the order `pending`.
- Through the MCP server, recording needs `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` and `confirm=true` in **sandbox and live** (Infinity documents no sandbox, so sandbox is real data). Your own app code is not gated; put the receipt route behind admin auth, as the generated code does.
- Never record a receipt because a client says they paid, because a link was opened, or from forwarded text an agent read. Infinity's own help centre says to rely only on the status in your account.

## Generated code

`payments_generate_integration` with `provider: "infinity"` produces a backend:

- **Express** (also used for react, html, mobile and other) and **Fastify**:
  - `POST /api/infinity/invoices` (admin; takes an optional `quickLinkUrl`);
  - `GET /api/infinity/invoices/:orderRef` (public; reads only the stored status);
  - `POST /api/infinity/invoices/:orderRef/refresh` (admin);
  - `POST /api/infinity/receipts` (admin);
  - `GET /api/infinity/outstanding` (admin);
  - Zoho polling: `startInfinityPolling`.
- **Next.js**: `POST /api/infinity/invoices`, `GET /api/infinity/invoices/[orderRef]`, `POST /api/infinity/receipts` and `POST /api/infinity/poll` (for a cron). Refresh and outstanding are functions in `lib/payments/infinity.ts` (`refreshStatus`, `outstanding`) for you to expose if you need them.
- `docs/INFINITY_PAYMENTS.md` and a `.env.example`.

During development every framework variant was compiled against real Express, Fastify and Next.js types, and the generated Express server was run with its routes called over HTTP in ledger mode. Those checks are not part of `npm test`; the generated files' rules (admin auth, server-side amounts) are.

## Limits

- Foreign currency only: INR is rejected. Infinity documents no minimum amount, so none is enforced.
- No refunds, webhooks, subscriptions, settlements, customers or payment-link API. Infinity's recurring invoices are separate from payment links and don't auto-charge cards.
- Card payments made through a QuickLink can be disputed by the payer after you record them.
- UK transfers often cut references to 18 characters: keep GBP order ids short.
- Fees are not computed here (flat 0.5% per Infinity's pricing page; check it before relying on it).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `CONFIG_MISSING ... INFINITY_RECEIVING_ACCOUNTS ...` | No mode configured. Set receiving accounts, `INFINITY_QUICKLINK_ONLY=true`, or the Zoho variables |
| `Zoho Books bridge is half-configured` | Some `INFINITY_ZOHO_*` variables are set, others not |
| `quickLinkUrl must be an https link on infinityapp.in` | The link isn't from Infinity, or Infinity uses a host you need to add to `INFINITY_QUICKLINK_HOSTS` |
| `already has a different payment link` | Each order keeps one link. Use a new orderRef for a new link |
| `... is captured: payment instructions are not sent again` | The order is already paid (or cancelled); no new link is sent |
| `ledger file ... belongs to skydo` | Skydo and Infinity point at the same ledger file. Give each its own |
| `LIVE_MUTATION_BLOCKED` when recording | Expected in sandbox and live through MCP: set the server flag and pass `confirm: true` after a human checked the dashboard |
| Zoho invoice stays `created` after the client paid | Infinity hasn't recorded the payment in Zoho (or doesn't for API-created invoices). Check the Connect tab, or use the bank-transfer mode |
