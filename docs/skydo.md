# Skydo

This is the reference for the Skydo adapter: what it does, how to set it up, and where it stops. The code is in `src/providers/skydo/` (`adapter.ts`, `zoho.ts`, `accounts.ts`, `ledger.ts`, `capabilities.ts`). If this page and the code disagree, the code is right; please open an issue.

---

## 1. Status

- **Skydo has no public developer API, SDK or webhooks** (checked 2026-10-29). There is no API reference, no sandbox and no API keys. Skydo's own FAQ says website checkout is "currently ... not available".
- **An API is on Skydo's roadmap.** The Series A announcement (10 Dec 2025) says Skydo will roll out "developer-friendly APIs and webhooks". No date has been given, and nothing had launched as of 2026-10-29.
- **Skydo's Terms of Use forbid automating the dashboard** (§25.8.12 bans scraping, robots and deep-links; §25.8.2 and §37.6 ban reverse engineering). This project does not log in to Skydo, scrape it, or call `api.skydo.com`.
- **What the adapter automates instead** are the two paths Skydo itself supports:
  1. **Zoho Books bridge.** Skydo's native Zoho Books integration imports new Zoho invoices. When the money arrives, Skydo marks the invoice paid in Zoho and attaches the FIRA. The adapter creates invoices and reads their status through Zoho's public API.
  2. **Receiving accounts + ledger.** The adapter gives your client your standing Skydo receiving-account details, with the order reference as the payment reference, and tracks the expected payment in a local JSON ledger. You record each receipt when Skydo notifies you.

The search behind these statements, with every URL checked, is in [research/verification/skydo-api-search.md](research/verification/skydo-api-search.md).

Capability map (from `src/providers/skydo/capabilities.ts`):

| Feature | Support | How |
|---|---|---|
| createPayment | Partial | Zoho invoice (Zoho bridge) or bank-transfer instructions + ledger entry (ledger mode). Never calls Skydo |
| verifyPayment | Partial | No callback exists. Reads the Zoho invoice (`verifiedVia: "status_api"`) or the ledger (`verifiedVia: "manual_record"`) |
| paymentStatus | Partial | Zoho invoice status, or the ledger |
| refund, refundStatus | No | No API. Refunds go through Skydo support |
| webhooks | No | No API. Skydo notifies you by email/WhatsApp |
| customers, subscriptions, settlements, payouts, paymentLinks | No | See [Limits](#7-limits) |

Payment method: `international_bank_transfer`. Checkout type: `manual`.

---

## 2. The two modes

| | Zoho Books bridge | Receiving accounts + ledger |
|---|---|---|
| Selected when | All six of `ZOHO_DATA_CENTER`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ORGANIZATION_ID`, `ZOHO_ITEM_ID` are set | `SKYDO_RECEIVING_ACCOUNTS` is set and the `ZOHO_*` variables are not |
| `createPayment` | Creates a Zoho Books invoice (`reference_number` = orderRef) and marks it sent | Returns transfer instructions for the matching receiving account and adds a ledger entry |
| `providerOrderId` | Zoho `invoice_id` | `skydo:<orderRef>` |
| Who learns the money arrived | Skydo, which marks the Zoho invoice paid | You, from Skydo's email/WhatsApp notification or dashboard |
| How the status changes | Automatically; poll `payments_get_status` | You call `payments_skydo_record_payment` |
| FIRA | Attached to the Zoho invoice by Skydo | In the Skydo dashboard and your inbox; you can store the number with each receipt |
| Extra accounts you need | Zoho Books (Skydo connected to it) | None |

Rules the adapter enforces:

- Setting only some of the six `ZOHO_*` variables is an error (`CONFIG_MISSING`, listing the missing ones). `ZOHO_ACCOUNTS_URL` is optional and not one of the six.
- If neither mode is configured, creating the Skydo gateway fails with `CONFIG_MISSING`.
- **With both configured, the Zoho bridge is used.** If a receiving account matches the invoice currency (or a `"*"` fallback exists), the transfer instructions are also written into the invoice's `notes`.
- `SKYDO_PAYEE_NAME` (optional) adds "to <your business name>" to the instructions.
- **There is no Skydo or Zoho sandbox in this adapter.** `PAYMENTS_MODE=sandbox` and `live` behave the same for Skydo. With the `ZOHO_*` variables set, `sandbox` creates real invoices in your Zoho organisation, and Skydo imports them. Use `PAYMENTS_MODE=mock` to try the flow, or point the variables at a Zoho organisation that is not connected to Skydo.

---

## 3. Setup: Zoho Books bridge

You need a Zoho Books organisation and a Skydo account in the same business name.

### Step 1. Connect Skydo to Zoho (in Skydo)

1. In the Skydo dashboard, open your profile and choose **Connect Skydo to Zoho**, then **Connect Securely**. Sign in to Zoho and pick the organisation you will set as `ZOHO_ORGANIZATION_ID`.
2. Choose whether Skydo imports invoices in **all currencies** or **international only**. Either works for this adapter, because it only creates foreign-currency invoices.
3. Skydo imports **only invoices created after you connect**. Earlier invoices never appear in Skydo.

Skydo syncs with Zoho about every 10 minutes. In one direction it imports new invoices; in the other it marks the matching invoice paid and uploads the FIRA PDF to it.

### Step 2. Create a service item (in Zoho Books)

Zoho requires an item on every invoice line.

1. Zoho Books > **Items** > **New**. Type: **Service**. Name it, for example, "Export services". The rate does not matter; the adapter sets the rate on each invoice.
2. Open the item and copy its `item_id`: the long number at the end of the item's URL in the browser. This is `ZOHO_ITEM_ID`.

The adapter writes one line per invoice: `name` = the payment `description` (cut to 100 characters, default "Services"), `rate` = the amount in major units, `quantity` = 1.

### Step 3. Create each client as a customer (in Zoho Books)

1. If the client's currency is not yet enabled, add it in Zoho Books > **Settings** > **Currencies**.
2. Zoho Books > **Sales** > **Customers** > **New**:
   - **Currency**: the client's billing currency (USD, GBP, EUR, ...). Zoho raises invoices in the customer's currency, so the adapter refuses a payment whose currency differs from the customer's.
   - **Email** of the primary contact person: the adapter finds the customer by this address (`GET /contacts?email=...&contact_type=customer`, exact match). Alternatively pass the customer's id as `providerOptions.zohoCustomerId`.
   - **GST Treatment**: **Overseas**, if your Zoho organisation is Indian.

The adapter never creates or edits customers. It only needs read access to contacts.

### Step 4. Create a Self Client and a refresh token (Zoho API Console)

1. Open the Zoho API Console for your data center: `https://api-console.zoho.com` (or the same host with your region's domain, for example `api-console.zoho.in`). Choose **Add Client** > **Self Client** > **Create**.
2. On the **Client Secret** tab, copy the **Client ID** (`ZOHO_CLIENT_ID`) and **Client Secret** (`ZOHO_CLIENT_SECRET`).
3. On the **Generate Code** tab, enter:
   - Scope: `ZohoBooks.invoices.ALL,ZohoBooks.contacts.READ`
   - Time duration: the longest offered (the code is single-use and expires after this time)
   - A description, then **Create**, and select your Zoho Books organisation if asked.
4. Copy the code and exchange it for a refresh token straight away, on the **accounts host of your data center**:

   ```bash
   curl -X POST "https://accounts.zoho.in/oauth/v2/token" \
     -d grant_type=authorization_code \
     -d client_id="$ZOHO_CLIENT_ID" \
     -d client_secret="$ZOHO_CLIENT_SECRET" \
     -d code="<the code from step 3>"
   ```

   The JSON response contains `refresh_token`, `access_token`, `api_domain` and `expires_in`. Put `refresh_token` in `ZOHO_REFRESH_TOKEN`. If the response is `{"error":"invalid_code"}`, the code expired or was already used: generate a new one. `{"error":"invalid_client"}` usually means you used another data center's accounts host.

Data centers (`ZOHO_DATA_CENTER` is the domain your `books.zoho.*` URL ends with):

| `ZOHO_DATA_CENTER` | Accounts host (token exchange) | Zoho Books API host |
|---|---|---|
| `com` | `https://accounts.zoho.com` | `https://www.zohoapis.com` |
| `eu` | `https://accounts.zoho.eu` | `https://www.zohoapis.eu` |
| `in` | `https://accounts.zoho.in` | `https://www.zohoapis.in` |
| `com.au` | `https://accounts.zoho.com.au` | `https://www.zohoapis.com.au` |
| `jp` | `https://accounts.zoho.jp` | `https://www.zohoapis.jp` |
| `ca` | `https://accounts.zohocloud.ca` | `https://www.zohoapis.ca` |
| `com.cn` | `https://accounts.zoho.com.cn` | `https://www.zohoapis.com.cn` |
| `sa` | `https://accounts.zoho.sa` | `https://www.zohoapis.sa` |

For a region not in this list, set `ZOHO_ACCOUNTS_URL` to its accounts host. The adapter switches to the `api_domain` that Zoho returns with each access token.

At runtime the adapter exchanges the refresh token for an access token (valid one hour), refreshes it 5 minutes before expiry, and refreshes once more if Zoho rejects a token as expired.

### Step 5. Organization ID (Zoho Books)

Zoho Books > **Settings** > **Organization Profile** > **Organization ID**. This is `ZOHO_ORGANIZATION_ID`, sent as `organization_id` on every call.

### Step 6. Configure and check

```bash
ZOHO_DATA_CENTER=in
ZOHO_CLIENT_ID=1000.XXXXXXXXXXXXXXXXXXXX
ZOHO_CLIENT_SECRET=...
ZOHO_REFRESH_TOKEN=1000....
ZOHO_ORGANIZATION_ID=60012345678
ZOHO_ITEM_ID=1234567000000012345
# Optional: also print your account details on each invoice
SKYDO_RECEIVING_ACCOUNTS=/path/to/skydo-accounts.json
SKYDO_PAYEE_NAME=Acme Exports Pvt Ltd
```

Run `npx india-payments-mcp doctor` (or the `payments_check_config` tool). Every Skydo variable is optional, so Skydo always shows `ready: true`; a configuration problem shows up as `initError`. Token problems only appear on the first Zoho call.

Then create one real invoice for a test client and confirm it appears in the Skydo dashboard within about 10 minutes.

---

## 4. Setup: receiving accounts + ledger

### Step 1. Copy your receiving accounts

In the Skydo dashboard, open **International Accounts**. Skydo gives each merchant standing local accounts (USD, GBP, EUR, CAD, AUD, AED, SGD) and a SWIFT account for other currencies. The details do not change per invoice, so printing them with a unique reference is what Skydo recommends.

### Step 2. Write `SKYDO_RECEIVING_ACCOUNTS`

The value is either inline JSON or a path to a `.json` file. It must be a non-empty array of:

- `currency`: an ISO code such as `"USD"`, or `"*"` for the fallback account used when no account matches the payment currency.
- `label` (optional): the heading printed above the details.
- `details`: an object of label → text, printed in order. Copy the field names and values exactly as Skydo shows them.

```json
[
  {
    "currency": "USD",
    "label": "US account (ACH / Fedwire)",
    "details": {
      "Account holder": "Acme Exports Pvt Ltd",
      "Bank": "<bank name from Skydo>",
      "Account number": "<account number>",
      "ACH routing number": "<routing number>"
    }
  },
  {
    "currency": "GBP",
    "label": "UK account (Faster Payments)",
    "details": { "Account holder": "Acme Exports Pvt Ltd", "Account number": "<...>", "Sort code": "<...>" }
  },
  {
    "currency": "*",
    "label": "SWIFT (any other currency)",
    "details": { "Account holder": "Acme Exports Pvt Ltd", "SWIFT/BIC": "<...>", "IBAN / Account": "<...>" }
  }
]
```

A payment in a currency with no matching account and no `"*"` entry fails with `CONFIG_MISSING`.

### Step 3. Choose where the ledger lives

`SKYDO_LEDGER_FILE` defaults to `~/.india-payments-mcp/skydo-ledger.json`. The file is created on the first payment, written atomically (temporary file, then rename) with mode `0600`, and read when the gateway starts, so state survives restarts. If it is not valid JSON, the gateway refuses to start rather than overwrite it.

Run one server process per ledger file. There is no locking, so two processes writing the same file can lose updates.

### Step 4. Check

Run `npx india-payments-mcp doctor`. As with Zoho, a malformed `SKYDO_RECEIVING_ACCOUNTS` shows up as `initError`.

---

## 5. The flow

Amounts are integer minor units of the **invoice currency** (cents for USD), not paise and not the INR settlement. USD 1,250.00 is `125000`. `currency` is required for Skydo; there is no INR default.

### 5.1 Create

MCP:

```json
// payments_create_payment
{
  "provider": "skydo",
  "order_ref": "INV_2026_041",
  "amount": 125000,
  "currency": "USD",
  "customer": { "name": "Globex Corp", "email": "ap@globex.example" },
  "description": "Design retainer, March 2026"
}
```

SDK:

```ts
import { PaymentsClient } from 'india-payments-mcp';

const payments = new PaymentsClient(); // reads PAYMENTS_MODE, SKYDO_* and ZOHO_* from process.env

const created = await payments.createPayment('skydo', {
  orderRef: 'INV_2026_041',
  amount: 125000,
  currency: 'USD',
  customer: { name: 'Globex Corp', email: 'ap@globex.example' },
  description: 'Design retainer, March 2026',
});
// created.checkout = { type: 'manual', instructions: string, url?: string }
// Store created.orderRef and created.providerOrderId with your order.
```

Ledger mode result (`raw` stripped, as the MCP server returns it):

```json
{
  "provider": "skydo",
  "environment": "live",
  "orderRef": "INV_2026_041",
  "providerOrderId": "skydo:INV_2026_041",
  "status": "created",
  "amount": 125000,
  "currency": "USD",
  "checkout": {
    "type": "manual",
    "instructions": "Please pay USD 1250.00 by bank transfer to Acme Exports Pvt Ltd.\nPayment reference (include it in the transfer note): INV_2026_041\n\nUS account (ACH / Fedwire)\nAccount holder: Acme Exports Pvt Ltd\nBank: ...\nAccount number: ...\nACH routing number: ...\n\nPayments are received through Skydo (skydo.com) and settled to India with a FIRA.\n\nWhen Skydo notifies you that the money arrived, record it (MCP: payments_skydo_record_payment; SDK: client.skydoRecordPayment)."
  }
}
```

Send the instructions to your client (email, invoice PDF). Also create the matching invoice in Skydo, because Skydo requires every incoming transfer to be matched to an invoice before it converts and pays out.

Zoho bridge result:

```json
{
  "provider": "skydo",
  "environment": "live",
  "orderRef": "INV_2026_041",
  "providerOrderId": "1234567000000098765",
  "status": "created",
  "amount": 125000,
  "currency": "USD",
  "checkout": {
    "type": "manual",
    "url": "https://books.zoho.in/...",
    "instructions": "Zoho Books invoice INV-000041 is ready for USD 1250.00.\nSkydo imports it within about 10 minutes (Skydo dashboard > Connect Skydo to Zoho must be done once), then marks it paid in Zoho and attaches the FIRA when the money arrives.\nShare the invoice link with your client: https://books.zoho.in/..."
  }
}
```

`url` is Zoho's `invoice_url` when Zoho returns one.

What the Zoho bridge does on create:

1. Looks for a non-void invoice with `reference_number` = orderRef. If one exists with the same amount and currency, it is returned (no duplicate invoice). With a different amount or currency, the call fails with `VALIDATION`.
2. Finds the customer: `providerOptions.zohoCustomerId` if given, otherwise `customer.email`. The customer's currency must equal the payment currency.
3. `POST /books/v3/invoices` with the customer, `reference_number`, one line item, and, when a receiving account matches, your account details in `notes`.
4. If Zoho returns a draft, marks it sent (`POST /invoices/{id}/status/sent`), because Skydo imports invoices as outstanding receivables.

Optional `provider_options` (SDK: `providerOptions`) for the Zoho bridge:

| Key | Type | Effect |
|---|---|---|
| `zohoCustomerId` | string | Use this Zoho contact instead of looking up `customer.email` |
| `sendEmail` | `true` | Create the invoice with `send=true`, so Zoho emails it to the customer |
| `dueDate` | string (`YYYY-MM-DD`) | Invoice `due_date` |
| `exchangeRate` | number | Invoice `exchange_rate` |

`providerOptions` can never override core fields such as `amount`, `currency` or `line_items` (`PaymentsClient` rejects them with `VALIDATION`).

### 5.2 Wait for the money

- **Zoho bridge:** nothing to do. Skydo has no webhooks, so poll. Skydo syncs every ~10 minutes, so checking unpaid invoices every 15 minutes is enough.
- **Ledger mode:** when Skydo emails or WhatsApps you that money for an order arrived, record it (next step).

### 5.3 Record a receipt (ledger mode only)

MCP:

```json
// payments_skydo_record_payment
{ "order_ref": "INV_2026_041", "amount_received": 124000, "fira_number": "FIRA-2026-000123", "note": "Intermediary bank deducted USD 10" }
```

SDK:

```ts
await payments.skydoRecordPayment({
  orderRef: 'INV_2026_041',
  amountReceived: 124000,           // minor units of the invoice currency
  firaNumber: 'FIRA-2026-000123',   // optional
  note: 'Intermediary bank deducted USD 10', // optional
  receivedAt: '2026-11-03T09:30:00Z',         // optional, default now
});
```

Result (this tool returns the ledger entry in `raw`):

```json
{
  "provider": "skydo",
  "orderRef": "INV_2026_041",
  "providerOrderId": "skydo:INV_2026_041",
  "status": "pending",
  "amount": 125000,
  "currency": "USD",
  "method": "international_bank_transfer",
  "failureReason": "Received USD 1240.00 of 1250.00.",
  "raw": { "orderRef": "INV_2026_041", "amount": 125000, "currency": "USD", "status": "pending", "amountReceived": 124000, "receipts": [ { "amount": 124000, "receivedAt": "2026-11-03T09:30:00Z", "firaNumber": "FIRA-2026-000123", "note": "Intermediary bank deducted USD 10" } ], "...": "..." }
}
```

Receipts add up. When the total reaches the invoice amount, the status becomes `captured`; anything short stays `pending`. **Recording the same receipt twice counts it twice**: check `payments_get_status` before recording again. Recording is audited (`skydo_record_payment`) but, unlike refunds, it is not behind the live-mutation gate, so an agent should record a receipt only when a human has confirmed Skydo's notification.

With the Zoho bridge configured, this call fails with `VALIDATION` ("Skydo marks invoices paid itself").

### 5.4 Check status and fulfil

MCP:

```json
// payments_verify_payment: bind the check to your order and amount
{ "provider": "skydo", "order_ref": "INV_2026_041", "expected_amount": 125000, "payload": {} }
```

```json
// payments_get_status
{ "provider": "skydo", "order_ref": "INV_2026_041" }
```

SDK:

```ts
const v = await payments.verifyPayment('skydo', { orderRef: 'INV_2026_041', expectedAmount: 125000, payload: {} });
if (v.paid) {
  // fulfil once (make this idempotent)
}
const s = await payments.getPaymentStatus('skydo', { orderRef: 'INV_2026_041', providerOrderId: created.providerOrderId });
```

There is no callback to verify, so `verifyPayment` reads the authoritative record: the Zoho invoice (`verifiedVia: "status_api"`) or the ledger (`verifiedVia: "manual_record"`). `valid` is `false` when the recorded amount differs from `expected_amount`. As for every gateway, **fulfil only when `paid` is `true`**: `PaymentsClient` sets it only when the result is valid, the status is settled (`captured` here), and you passed both `orderRef` and `expectedAmount`.

`getPaymentStatus` in Zoho mode uses the invoice id when you pass `providerOrderId`, otherwise it looks the invoice up by reference. The result's `raw` contains the invoice and `firaAttached` (`true` when the invoice has an attachment, which is how Skydo delivers the FIRA). The MCP server strips `raw` unless you pass `include_raw: true`.

### 5.5 List what is still owed

MCP: `payments_skydo_outstanding` (no arguments). SDK: `await payments.skydoOutstanding()`.

```json
{
  "mode": "ledger",
  "outstanding": [
    { "orderRef": "INV_2026_041", "amount": 125000, "currency": "USD", "status": "pending", "amountReceived": 124000, "createdAt": "2026-10-29T10:00:00.000Z", "updatedAt": "2026-11-03T09:30:00.000Z", "receipts": [ "..." ] }
  ]
}
```

It lists ledger entries with status `created` or `pending`, oldest first. Use it to chase clients or to reconcile against Skydo's Reports export. In Zoho mode it returns `{ "mode": "zoho", "outstanding": [], "note": "Zoho bridge: outstanding invoices are in Zoho Books (status sent/overdue/partially_paid)." }`.

### 5.6 Generated integration code

`payments_generate_integration` with `provider: "skydo"` generates a backend for this flow instead of a checkout: a service module (`requestPayment`, `refreshStatus`, `pollUnpaid` every 15 minutes, `recordReceipt`, `outstanding`), routes `POST /api/skydo/invoices`, `GET /api/skydo/invoices/:orderRef`, `POST /api/skydo/receipts` (admin) and, for Next.js, a poll route; plus an env template and `docs/SKYDO_PAYMENTS.md`. The admin routes check an `ADMIN_API_TOKEN` bearer token; that variable belongs to the generated app, not to this server. Replace it with your real admin auth.

### 5.7 Mock mode

With `PAYMENTS_MODE=mock`, `payments_create_payment` for Skydo still enforces the currency and minimum rules but returns the generic mock checkout. Simulate the payment with `payments_mock_complete_payment` (provider `skydo`), then call `payments_verify_payment` as above. `payments_skydo_record_payment` and `payments_skydo_outstanding` are not available in mock mode (`VALIDATION`).

---

## 6. Status in each state

| Zoho invoice status | Our `status` | Meaning |
|---|---|---|
| `draft` | `created` | Not yet sent (the adapter marks new drafts sent) |
| `sent`, `viewed`, `unpaid`, `overdue` | `created` | Waiting for the money |
| `partially_paid` | `pending` | Part of the money arrived. `failureReason` shows the balance |
| `paid` | `captured` | Skydo matched the payment and marked the invoice paid. `paid` can be `true` |
| `void` | `cancelled` | Invoice voided in Zoho |
| anything else | `unknown` | A Zoho status this adapter does not recognise |

| Ledger state | Our `status` | Meaning |
|---|---|---|
| Created, nothing recorded | `created` | Waiting for the money |
| Receipts total less than the amount | `pending` | Short payment (often bank fees abroad). `failureReason` shows received vs expected |
| Receipts total at least the amount | `captured` | Paid. `paid` can be `true` |

A ledger entry can also be `cancelled`; no tool sets that, and recording a receipt against a cancelled entry fails. To change an entry by hand, stop the server, edit the ledger file, and start it again; the server only reads the file at start-up and overwrites it on the next write.

---

## 7. Limits

- **Foreign currency from abroad only.** INR, or a missing `currency`, is rejected with `VALIDATION`. Use a domestic gateway (Razorpay, Cashfree, PayU, PhonePe, Paytm, CCAvenue) for INR.
- **Minimum USD 50 per payment** (Skydo FAQ). The adapter enforces it for USD (`amount` ≥ `5000`). It does not check minimums for other currencies.
- **No cards, UPI or website checkout.** Payment is a bank transfer to your Skydo receiving account.
- **No refunds** through this project. Refunds to a foreign client are handled with Skydo support.
- **No webhooks.** Poll (Zoho bridge) or record receipts (ledger mode).
- **No recurring payments** (Skydo FAQ), no customer objects, no settlement or payout API. Payouts to your Indian bank and FIRAs are in the Skydo dashboard (Reports tab exports).
- **Payment links (InstaLinks) can only be created in the Skydo dashboard, and each link is single-use.** This project cannot create or track them.
- **Fees and FX are not computed.** Amounts stay in the invoice currency; the INR settlement is not tracked. See Skydo's website for current fees.
- **Every incoming transfer must be matched to an invoice in Skydo.** Always give clients the orderRef as the payment reference.
- `orderRef` is 3-40 characters of letters, digits, `_` and `-` (the same rule as every gateway here). It is the Zoho `reference_number` and the bank-transfer reference.

---

## 8. Troubleshooting

### Configuration errors (`CONFIG_MISSING` / `CONFIG_INVALID`, shown as `initError` by `doctor`)

| Message | Fix |
|---|---|
| `Skydo needs SKYDO_RECEIVING_ACCOUNTS ... and/or the ZOHO_* variables for the Zoho Books bridge.` | Configure one of the modes |
| `Skydo's Zoho Books bridge is half-configured. Missing: ZOHO_...` | Set the listed variables, or remove all `ZOHO_*` to use ledger mode |
| `ZOHO_DATA_CENTER "..." is not one of com, eu, in, com.au, jp, ca, com.cn, sa.` | Use the domain your `books.zoho.*` URL ends with (`books.zoho.in` → `in`), or set `ZOHO_ACCOUNTS_URL` |
| `SKYDO_RECEIVING_ACCOUNTS is neither JSON nor an existing file` / `is not valid JSON` / `must be a non-empty JSON array` | Fix the value. Inline JSON must start with `[` |
| `SKYDO_RECEIVING_ACCOUNTS[i].currency must be an ISO code like "USD" or "*".` / `[i].details must be an object of label -> text.` | Fix entry `i`. All detail values must be strings |
| `No Skydo receiving account for GBP and no "*" fallback in SKYDO_RECEIVING_ACCOUNTS.` | Add that currency or a `"*"` account |
| `Skydo ledger file ... is not valid JSON` | Fix or move the file. It is never overwritten while unreadable |

Values that look like template placeholders (containing `replace-me`, eight or more `x` characters, or `<...>`) are treated as unset.

### Zoho errors

| Message | Cause and fix |
|---|---|
| `Zoho refused the refresh token (invalid_code).` (`AUTH`) | The refresh token is wrong or revoked, or belongs to another data center. Generate a new one (Step 4) and check `ZOHO_DATA_CENTER` |
| `Zoho refused the refresh token (invalid_client).` (`AUTH`) | Client ID/secret wrong, or the client belongs to another data center |
| `skydo zoho_create_invoice failed (HTTP 4xx): <Zoho message>` or `Zoho Books zoho_create_invoice failed: <Zoho message>` (`PROVIDER_ERROR`, or `AUTH` for HTTP 401/403) | Zoho rejected the request. `providerCode` and `providerMessage` carry Zoho's own code and message. Common causes: wrong `ZOHO_ORGANIZATION_ID`; `ZOHO_ITEM_ID` not an active item in that organisation; the token was generated without both scopes (Zoho then answers that you are not authorised to perform the operation) |
| `No Zoho Books customer with email ...` (`VALIDATION`) | Create the customer (Step 3), make that address the primary contact's email, or pass `providerOptions.zohoCustomerId` |
| `Pass customer.email (or providerOptions.zohoCustomerId) to pick the Zoho Books customer.` | Add one of them |
| `Zoho customer ... is billed in EUR, not USD.` | Use the customer's currency, or change it in Zoho Books |
| `Zoho invoice INV-... already uses reference ... with a different amount or currency.` | Use a new orderRef, or void the old invoice in Zoho |
| `No Zoho Books invoice with reference ...` (`NOT_FOUND`) | Wrong orderRef, the invoice was voided, or it was created in another organisation |

### The invoice does not appear in Skydo

1. **It was created before Skydo was connected to Zoho.** Skydo imports only invoices created after connecting. Create a new invoice with a new orderRef.
2. **Currency filter.** Check the "all currencies" / "international only" choice in Skydo's Zoho connection, and that the invoice is in a foreign currency.
3. **Wait for the sync.** Skydo syncs about every 10 minutes.
4. **Wrong organisation.** The organisation connected in Skydo must be the one in `ZOHO_ORGANIZATION_ID`.
5. **Status.** The adapter marks drafts sent. If you created the invoice by hand, make sure it is not still a draft and is not void.

### The client paid, but the status has not changed

- **Zoho bridge:** Skydo marks the invoice paid only after it has matched the payment to the invoice. Check the Skydo dashboard. A short payment (bank fees abroad) can leave the invoice `partially_paid` (`pending`).
- **Ledger mode:** nothing changes until you call `payments_skydo_record_payment`.

### Other errors

| Message | Fix |
|---|---|
| `Skydo receives foreign currency from abroad: pass the client's currency ...` | Pass `currency`; INR is not supported |
| `Skydo's minimum payment is USD 50.00 ...` | Amount is in cents: at least `5000` |
| `Skydo ledger has no order ...` (`NOT_FOUND`) | The order was created with another `SKYDO_LEDGER_FILE`, in Zoho mode, or in mock mode |
| `orderRef ... is already tracked with a different amount or currency.` | Use a new orderRef |
| `With the Zoho Books bridge, Skydo marks invoices paid itself; nothing to record.` | Expected in Zoho mode |
| `Mock mode simulates Skydo receipts with payments_mock_complete_payment.` | Expected in mock mode |

---

## 9. FAQ

**Does this project call Skydo?**
No. It calls Zoho Books (Zoho bridge) or nothing at all (ledger mode).

**Why not automate the Skydo dashboard?**
Skydo's Terms forbid scraping and automated access (§25.8.12). Doing it would also break whenever the dashboard changes.

**Which mode should I use?**
The Zoho bridge if you already use Zoho Books or are willing to: status updates are automatic and the FIRA lands on the invoice. Ledger mode if you don't use Zoho; it needs a person to record each receipt.

**Can I accept cards or UPI with Skydo?**
No. For card payments from international customers, use a gateway that offers them (for example Razorpay with international payments enabled, PayU, CCAvenue, or Stripe, which is invite-only in India). `payments_recommend_gateway` with `international` or `exporter_collections` ranks the options.

**Can I test without touching my real books?**
Use `PAYMENTS_MODE=mock`. `sandbox` is not a sandbox for Skydo: with `ZOHO_*` set it creates real Zoho invoices.

**Where is the FIRA?**
Zoho bridge: attached to the Zoho invoice by Skydo (`firaAttached` in the status `raw`). Ledger mode: in the Skydo dashboard and your inbox; store its number with `fira_number` when you record the receipt.

**Is creating a payment twice safe?**
Yes, with the same orderRef, amount and currency. The Zoho bridge finds the existing invoice by reference, and ledger mode returns the existing entry. A different amount or currency for the same orderRef fails.

**Is recording a receipt twice safe?**
No. Each call adds a receipt.

**Can the ledger be shared between servers?**
No. It is a local file for one process. For several instances, use the Zoho bridge, or keep your own database and use the SDK.

**What happens when Skydo ships an API?**
The adapter will switch to it: create, status and webhooks through Skydo directly, with the Zoho bridge and ledger kept for existing users. See [roadmap.md](roadmap.md).
