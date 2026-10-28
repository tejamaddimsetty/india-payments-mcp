# Skydo

This is the reference for the Skydo adapter: what it does, how to set it up, and where it stops. The code is in `src/providers/skydo/` (`adapter.ts`, `zoho.ts`, `accounts.ts`, `ledger.ts`, `capabilities.ts`). If this page and the code disagree, the code is right; please open an issue.

---

## 1. Status

- **Skydo has no public developer API, SDK or webhooks** (checked 2026-10-29). There is no API reference, no sandbox and no API keys. Skydo's own FAQ says website checkout is "currently ... not available".
- **An API is on Skydo's roadmap.** The Series A announcement (10 Dec 2025) says Skydo will roll out "developer-friendly APIs and webhooks". No date has been given, and nothing had launched as of 2026-10-29.
- **Skydo's Terms of Use prohibit scrapers, bots and other automated access to the platform** (clause 13(iv)(f) bans "deep-links, page-scrape, robot, spider or other automatic device", in the version of 09 Apr 2026; clause 11, "Third-party applications", covers connections Skydo itself approves). This project does not log in to Skydo, scrape it, or call `api.skydo.com`.
- **What the adapter automates instead** are the two paths Skydo itself supports:
  1. **Zoho Books bridge.** Skydo documents that its native Zoho Books integration syncs new Zoho invoices; whether that includes invoices created through the Zoho API must be confirmed during setup. When the money arrives, Skydo marks the invoice paid in Zoho and attaches the FIRA. The adapter creates invoices and reads their status through Zoho's public API.
  2. **Receiving accounts + ledger.** The adapter gives your client your standing Skydo receiving-account details, with the order reference as the payment reference, and tracks the expected payment in a local JSON ledger. You record each receipt when Skydo notifies you.
- **Not yet proven end to end.** Skydo documents that invoices created in Zoho sync automatically, but not specifically whether invoices created through the Zoho API are included. Confirm it with one real invoice during setup ([step 6](#step-6-configure-and-check)). The adapter has been reviewed against Zoho's OpenAPI files and Skydo's pages in three rounds (the third an adversarial review with multi-process ledger races), but has not yet run against a real Skydo account.

The search behind these statements is in [research/verification/skydo-api-search.md](research/verification/skydo-api-search.md); the adversarial reviews of the adapter are in [research/verification/round2-skydo.md](research/verification/round2-skydo.md) and [research/verification/round3-skydo.md](research/verification/round3-skydo.md).

Capability map (from `src/providers/skydo/capabilities.ts`):

| Feature | Support | How |
|---|---|---|
| createPayment | Partial | Zoho invoice (Zoho bridge) or bank-transfer instructions + ledger entry (ledger mode). Never calls Skydo |
| verifyPayment | Partial | No callback exists. Reads the Zoho invoice (`verifiedVia: "status_api"`) or the ledger (`verifiedVia: "manual_record"`) |
| paymentStatus | Partial | Zoho invoice status, or the ledger |
| refund, refundStatus | No | No API. Skydo's FAQ says it cannot initiate a refund directly for settled InstaLink payments; for anything else ask Skydo support |
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
| How the status changes | Skydo updates the invoice (once it imports it); poll `payments_get_status` | You call `payments_skydo_record_payment` |
| FIRA | Attached to the Zoho invoice by Skydo | In the Skydo dashboard and your inbox; you can store the number with each receipt |
| Extra accounts you need | Zoho Books (Skydo connected to it) | None |

Rules the adapter enforces:

- Setting only some of the six `ZOHO_*` variables is an error (`CONFIG_MISSING`, listing the missing ones). `ZOHO_ACCOUNTS_URL` is optional and not one of the six.
- If neither mode is configured, creating the Skydo gateway fails with `CONFIG_MISSING`.
- **With both configured, the Zoho bridge is used.** If a receiving account matches the invoice currency (or a `"*"` fallback exists), the transfer instructions are also written into the invoice's `notes`. The ledger is not used in Zoho mode.
- `SKYDO_PAYEE_NAME` (optional) adds "to <your business name>" to the instructions.
- **There is no Skydo or Zoho sandbox in this adapter.** `PAYMENTS_MODE=sandbox` and `live` behave the same for Skydo. With the `ZOHO_*` variables set, `sandbox` creates real invoices in your Zoho organisation, and Skydo may import them; the ledger is your real ledger. For that reason recording a receipt through the MCP server is gated in `sandbox` **and** `live` ("Skydo has no sandbox", see [5.3](#53-record-a-receipt-ledger-mode-only)). Use `PAYMENTS_MODE=mock` to try the flow, or point the variables at a Zoho organisation that is not connected to Skydo.

---

## 3. Setup: Zoho Books bridge

You need a Zoho Books organisation and a Skydo account for the same business.

### Step 1. Connect Skydo to Zoho (in Skydo)

1. In the Skydo dashboard, open your profile and choose **Connect Skydo to Zoho**, then **Connect Securely**. Sign in to Zoho and pick the organisation you will set as `ZOHO_ORGANIZATION_ID`.
2. Choose whether Skydo imports invoices in **all currencies** or **international only**. The adapter only creates foreign-currency invoices, so either setting should include them.
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
   - **Email** of the primary contact person: the adapter finds the customer by this address (`GET /contacts?email=...&contact_type=customer`, then an exact, case-insensitive re-check). If two active customers share the address, or the only match is inactive, it refuses to guess. Alternatively pass the customer's id as `providerOptions.zohoCustomerId`.
   - **GST Treatment**: **Overseas**, if your Zoho organisation is Indian.
3. **Turn off Zoho online payment gateways** for these customers or invoices. Otherwise a client can pay on the Zoho invoice page, outside Skydo, and you get no FIRA.

The adapter never creates or edits customers. It only needs read access to contacts.

### Step 4. Create a Self Client and a refresh token (Zoho API Console)

1. Open the Zoho API Console for your data center: `https://api-console.zoho.com` (or the same host with your region's domain, for example `api-console.zoho.in`). Choose **Add Client** > **Self Client** > **Create**.
2. On the **Client Secret** tab, copy the **Client ID** (`ZOHO_CLIENT_ID`) and **Client Secret** (`ZOHO_CLIENT_SECRET`).
3. On the **Generate Code** tab, enter:
   - Scope: `ZohoBooks.invoices.ALL,ZohoBooks.contacts.READ`
   - Time duration: the longest offered (the code is single-use and expires after this time)
   - A description, then **Create**, and select your Zoho Books organisation if asked.
4. Copy the code and exchange it for a refresh token straight away, on the **accounts host of your data center** (table below):

   ```bash
   curl -X POST "https://accounts.zoho.in/oauth/v2/token" \
     -d grant_type=authorization_code \
     -d client_id="$ZOHO_CLIENT_ID" \
     -d client_secret="$ZOHO_CLIENT_SECRET" \
     -d code="<the code from step 3>"
   ```

   The JSON response contains `refresh_token`, `access_token`, `api_domain` and `expires_in`. Put `refresh_token` in `ZOHO_REFRESH_TOKEN`. If the response is `{"error":"invalid_code"}`, the code expired or was already used: generate a new one. `{"error":"invalid_client"}` usually means a wrong client id/secret, or another data center's accounts host.

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
| `ae` | `https://accounts.zoho.ae` | `https://www.zohoapis.ae` |
| `uk` | `https://accounts.zoho.uk` | `https://www.zohoapis.uk` |
| `sg` | `https://accounts.zoho.sg` | `https://www.zohoapis.sg` |

For a region not in this list, set `ZOHO_ACCOUNTS_URL` to its accounts host. The adapter always switches to the `api_domain` that Zoho returns with the access token.

At runtime the adapter exchanges the refresh token for an access token (valid one hour), caches it, refreshes it 5 minutes before expiry, and refreshes once more if Zoho rejects a token as expired. Zoho issues at most 10 access tokens per refresh token in 10 minutes; hitting that limit gives `RATE_LIMITED`.

### Step 5. Organization ID (Zoho Books)

Zoho Books > **Settings** > **Organization Profile** > **Organization ID**. This is `ZOHO_ORGANIZATION_ID`, sent as `organization_id` on every call.

### Step 6. Configure and check

```bash
ZOHO_DATA_CENTER=in
ZOHO_CLIENT_ID=1000.ABC123...
ZOHO_CLIENT_SECRET=...
ZOHO_REFRESH_TOKEN=1000....
ZOHO_ORGANIZATION_ID=60012345678
ZOHO_ITEM_ID=1234567000000012345
# Optional: also print your account details on each invoice
SKYDO_RECEIVING_ACCOUNTS=/path/to/skydo-accounts.json
SKYDO_PAYEE_NAME=Acme Exports Pvt Ltd
```

Run `npx india-payments-mcp doctor` (or the `payments_check_config` tool). Every Skydo variable is optional, so when neither mode is configured, or the Zoho bridge is half-configured, Skydo shows as `not configured` with a `setup:` line explaining what to set (`payments_check_config`: `ready: false` plus `setup`). Any other configuration problem shows up as `ERROR` / `initError`. Token problems only appear on the first Zoho call.

**Then create one real invoice** for a test client with `payments_create_payment` and confirm it appears in the Skydo dashboard within about 10 minutes. This is the step that proves Skydo imports API-created invoices for your account.

If your Zoho organisation's base currency differs from the invoice currency and Zoho rejects the invoice, pass `providerOptions.exchangeRate` (or turn on Zoho's automatic exchange-rate feed).

---

## 4. Setup: receiving accounts + ledger

### Step 1. Copy your receiving accounts

In the Skydo dashboard, open **International Accounts**. Skydo gives each merchant standing local accounts (USD, GBP, EUR, CAD, AUD, AED, SGD) and a SWIFT account (32 currencies). The details do not change per invoice, so printing them with a unique reference is what Skydo recommends.

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

Replace every `<...>` placeholder: a value containing `<...>` is treated as unset. A payment in a currency with no matching account and no `"*"` entry fails with `CONFIG_MISSING`.

### Step 3. Choose where the ledger lives

`SKYDO_LEDGER_FILE` defaults to `~/.india-payments-mcp/skydo-ledger.json`.

- The file is created on the first payment, with mode `0600` in a `0700` directory.
- Every change is a locked read-modify-write: the adapter takes an exclusive lock file (`<ledger>.lock`) holding a unique owner token, re-reads the ledger, applies the one change, writes it to a temporary file, fsyncs it and renames it over the ledger. Reads always read the file. So **your app and the MCP server can share one ledger file**, for example the app creating orders and the MCP server recording receipts.
- Waiting for the lock is asynchronous (the event loop keeps running). A process only removes a lock it still owns. A lock older than 10 seconds was left by a crashed process and is broken (by renaming it first, so only one waiter can break it). If the lock cannot be taken within 15 seconds, the call fails with `PROVIDER_UNAVAILABLE` ("locked by another process"); retry.
- **Use a local disk.** Lock files are not reliable on network file systems (NFS, SMB, synced folders).
- If the file is not valid JSON, the gateway refuses to start rather than overwrite it.

### Step 4. Check

Run `npx india-payments-mcp doctor`. A malformed `SKYDO_RECEIVING_ACCOUNTS` or ledger file shows up as `ERROR` / `initError`.

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
    "instructions": "Please pay USD 1250.00 by bank transfer to Acme Exports Pvt Ltd.\nPayment reference (include it in the transfer note): INV_2026_041\n\nUS account (ACH / Fedwire)\nAccount holder: Acme Exports Pvt Ltd\nBank: ...\nAccount number: ...\nACH routing number: ...\n\nPayments are received through Skydo (skydo.com) and settled to India with a FIRA.\n\nWhen Skydo notifies you that the money arrived, record it (MCP: payments_skydo_record_payment; SDK: client.skydoRecordPayment) with the Skydo transaction reference as receiptId."
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
    "instructions": "Zoho Books invoice INV-000041 is ready for USD 1250.00.\nSkydo imports Zoho invoices about every 10 minutes (Skydo profile > Connect Skydo to Zoho, done once), marks the invoice paid when the money arrives, and attaches the FIRA.\nInvoice link for your client: https://books.zoho.in/..."
  }
}
```

`url` is Zoho's `invoice_url` when Zoho returns one. For currencies other than USD, the instructions end with a reminder that Skydo's minimum is the USD 50 equivalent; for GBP with an orderRef longer than 18 characters, with a warning that UK transfers often cut references to 18 characters.

What the Zoho bridge does on create:

1. Looks up every invoice with `reference_number` = orderRef (all pages, exact match).
   - A non-void invoice with the same amount and currency is returned (no duplicate invoice). The adapter reads the full invoice record first, so a retry returns the same invoice link and status as the first call. With a different amount or currency, the call fails with `VALIDATION`.
   - If the only match is void, the call fails with `VALIDATION`: use a new orderRef.
2. Otherwise finds the customer (`providerOptions.zohoCustomerId`, which must be an active contact of type customer, or `customer.email`), whose currency must equal the payment currency.
3. `POST /books/v3/invoices` with the customer, `reference_number`, one line item, and, when a receiving account matches, your account details in `notes`.
4. Looks up the reference again. If another process created an invoice for the same orderRef at the same time, every process picks the same winner, the **oldest invoice by Zoho's numeric `invoice_id`**; each process voids only its own invoice, and only if it lost, then returns the full winning invoice. Exactly one invoice survives. There is no cross-process lock, so if Zoho's search has not yet indexed the other invoice, two live invoices can remain: void the newer one in Zoho Books.
5. If the invoice is a draft, marks it sent (`POST /invoices/{id}/status/sent`). This also repairs an earlier attempt that created the invoice but failed before marking it sent. (Skydo does not document whether drafts sync; marking them sent is a precaution.)

Optional `provider_options` (SDK: `providerOptions`) for the Zoho bridge:

| Key | Type | Effect |
|---|---|---|
| `zohoCustomerId` | string | Use this Zoho contact instead of looking up `customer.email`. It must be an active contact of type customer |
| `sendEmail` | `true` | Create the invoice with `send=true`, so Zoho emails it to the customer |
| `dueDate` | string (`YYYY-MM-DD`) | Invoice `due_date` |
| `exchangeRate` | number | Invoice `exchange_rate` |

`providerOptions` can never override core fields such as `amount`, `currency` or `line_items` (`PaymentsClient` rejects them with `VALIDATION`; the full list is in [security.md](security.md#provider_options-guard)).

### 5.2 Wait for the money

- **Zoho bridge:** Skydo has no webhooks, so poll. Skydo syncs every ~10 minutes, so checking unpaid invoices every 15 minutes is enough. Pass the stored `providerOrderId` (the Zoho `invoice_id`) so each check costs one Zoho call; without it the adapter also searches by reference (two calls). At 15 minutes each open invoice costs 96 calls a day, against a Zoho Books daily limit of 1,000 (Free) to 10,000 (Premium and above) calls per organisation: raise the interval if you have many open invoices on a small plan.
- **Ledger mode:** when Skydo emails or WhatsApps you that money for an order arrived, **check it in the Skydo dashboard**, then record it (next step). Never record a receipt on the strength of a forwarded email or message alone.

### 5.3 Record a receipt (ledger mode only)

MCP:

```json
// payments_skydo_record_payment
{
  "order_ref": "INV_2026_041",
  "receipt_id": "SKY-TXN-88412",
  "amount_received": 124000,
  "fira_number": "FIRA-2026-000123",
  "note": "Intermediary bank deducted USD 10",
  "confirm": true
}
```

SDK:

```ts
await payments.skydoRecordPayment({
  orderRef: 'INV_2026_041',
  receiptId: 'SKY-TXN-88412',        // Skydo transaction reference or FIRA number (required, max 100 chars)
  amountReceived: 124000,           // minor units of the invoice currency
  firaNumber: 'FIRA-2026-000123',   // optional
  note: 'Intermediary bank deducted USD 10', // optional
  receivedAt: '2026-11-03T09:30:00Z',         // optional ISO 8601 date, not in the future; default now
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
  "raw": { "orderRef": "INV_2026_041", "amount": 125000, "currency": "USD", "status": "pending", "amountReceived": 124000, "receipts": [ { "receiptId": "SKY-TXN-88412", "amount": 124000, "receivedAt": "2026-11-03T09:30:00.000Z", "firaNumber": "FIRA-2026-000123", "note": "Intermediary bank deducted USD 10" } ], "...": "..." }
}
```

- Receipts add up. When the total reaches the invoice amount, the status becomes `captured`; anything short stays `pending`.
- **`receipt_id` makes recording idempotent.** Receipt ids compare case- and whitespace-insensitively (`sky-1 ` equals `SKY-1`). Recording the same `receipt_id` with the same amount again changes nothing. The same `receipt_id` with a different amount fails with `IDEMPOTENCY_CONFLICT`, and so does a `receipt_id` already recorded on **another** order (one Skydo transfer pays one order).
- `received_at` must be an ISO 8601 date or date-time (`2026-10-29` or `2026-10-29T10:00:00Z`) and not in the future (more than a day ahead is rejected).
- **Gated in sandbox and live.** Recording a receipt can mark an order paid, and Skydo has no sandbox, so through the MCP server it needs `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` on the server **and** `confirm: true` on the call, exactly like a live refund, in every mode except `mock`. SDK calls are gated only if you create the client with `guardLiveMutations: true` (then pass `{ confirm: true }` as the second argument).
- Every call is audited as `skydo_record_payment`, including the `receiptId`.
- With the Zoho bridge configured, this call fails with `VALIDATION` ("Skydo marks invoices paid itself").

### 5.4 Check status and fulfil

MCP:

```json
// payments_verify_payment: bind the check to your order and amount
{ "provider": "skydo", "order_ref": "INV_2026_041", "expected_amount": 125000, "provider_order_id": "1234567000000098765", "payload": {} }
```

```json
// payments_get_status
{ "provider": "skydo", "order_ref": "INV_2026_041" }
```

SDK:

```ts
const v = await payments.verifyPayment('skydo', {
  orderRef: 'INV_2026_041',
  expectedAmount: 125000,
  providerOrderId: created.providerOrderId,
  payload: {},
});
if (v.paid) {
  // fulfil once (make this idempotent)
}
const s = await payments.getPaymentStatus('skydo', { orderRef: 'INV_2026_041', providerOrderId: created.providerOrderId });
```

- There is no callback to verify, so `verifyPayment` reads the authoritative record: the Zoho invoice (`verifiedVia: "status_api"`) or the ledger (`verifiedVia: "manual_record"`). `valid` is `false` when the recorded amount differs from `expected_amount`. `reason` carries the status explanation (for example the balance of a partial payment).
- As for every gateway, **fulfil only when `paid` is `true`**: `PaymentsClient` sets it only when the result is valid, the status is `captured` (or `partially_refunded` on other gateways), and you passed both `orderRef` and `expectedAmount`.
- In Zoho mode the adapter uses the invoice id when you pass `providerOrderId`, otherwise it looks the invoice up by reference. It always reads the full invoice, and **refuses an invoice whose `reference_number` is not your orderRef** (`VALIDATION`), so another order's invoice can never answer for yours.
- The result's `raw` contains the invoice and `firaAttached` (`true` when the invoice has an attachment, which is how Skydo delivers the FIRA). The MCP server strips `raw` unless you pass `include_raw: true`.

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

`payments_generate_integration` with `provider: "skydo"` generates a backend for this flow instead of a checkout:

- a service module: `requestPayment`, `refreshStatus`, `pollUnpaid` (every 15 minutes with the Zoho bridge), `recordReceipt`, `outstanding`, `storedStatus`. It stores the `providerOrderId` (Zoho `invoice_id`, or `skydo:<orderRef>`) with each invoice, so a refresh costs **one** Zoho call. Asking for the same invoice again never resets an order that was already fulfilled;
- routes: `POST /api/skydo/invoices`; `GET /api/skydo/invoices/:orderRef`, which **reads the stored status only** and never calls Zoho, to protect your Zoho API quota; and the admin routes `POST /api/skydo/invoices/:orderRef/refresh` (the only route that refreshes from Zoho or the ledger), `GET /api/skydo/outstanding` and `POST /api/skydo/receipts` (with `receiptId`). For Next.js there is also a poll route; the Fastify plugin exports `startSkydoPolling(intervalMs = 15 min)` to call once at startup;
- comments with the Zoho Books limits: 100 calls per minute, and 1,000 (Free) to 10,000 (Premium and above) calls per day per organisation; each open invoice costs 96 calls a day at the 15-minute interval;
- an env template and `docs/SKYDO_PAYMENTS.md`.

The admin routes check an `ADMIN_API_TOKEN` bearer token. That variable belongs to the generated app, not to this server. Replace it with your real admin auth.

### 5.7 Mock mode

With `PAYMENTS_MODE=mock`, `payments_create_payment` for Skydo still enforces the currency and minimum rules but returns the generic mock checkout. Simulate the payment with `payments_mock_complete_payment` (provider `skydo`), then call `payments_verify_payment` as above, with `payload: {}`: as in real mode, the mock verifies Skydo by looking the order up by `order_ref`, not by a callback signature. `payments_skydo_record_payment` and `payments_skydo_outstanding` are not available in mock mode (`VALIDATION`).

---

## 6. Status in each state

| Zoho invoice | Our `status` | Meaning |
|---|---|---|
| `draft` | `created` | Not yet sent (the adapter marks drafts sent) |
| `sent`, `viewed`, `unpaid`, `overdue` | `created` | Waiting for the money |
| `partially_paid` | `pending` | Part of the money arrived. `failureReason` shows the balance |
| `paid`, payments cover the total, nothing written off | `captured` | Paid. `paid` can be `true` |
| `paid`, fully written off (bad debt, `payment_made` 0) | `failed` | Zoho shows "paid", but the amount was written off; no money arrived for it |
| `paid`, partly written off (`payment_made` > 0, for example bank fees deducted abroad) | `pending` | Money arrived, but less than invoiced. `failureReason` shows received vs written off; review and fulfil manually if acceptable |
| `paid`, but payments cover less than the total (closed with credit notes), or Zoho returned no `payment_made` | `unknown` | Cannot confirm the money arrived. `failureReason` explains |
| `void` | `cancelled` | Invoice voided in Zoho |
| anything else | `unknown` | A Zoho status this adapter does not recognise |

"Paid in Zoho" means paid in Zoho, which is not always "received through Skydo": a payment you record by hand in Zoho, or one made through a Zoho online gateway, also counts. Use `firaAttached` (status `raw`) as the signal that Skydo processed it.

| Ledger state | Our `status` | Meaning |
|---|---|---|
| Created, nothing recorded | `created` | Waiting for the money |
| Receipts total less than the amount | `pending` | Short payment (often bank fees abroad). `failureReason` shows received vs expected |
| Receipts total at least the amount | `captured` | Paid. `paid` can be `true` |

A ledger entry can also be `cancelled`; no tool sets that, and recording a receipt against a cancelled entry fails. To change an entry by hand, edit the ledger file while nothing is writing to it (no lock file present).

---

## 7. Limits

- **Foreign currency from abroad only.** INR, or a missing or non-ISO `currency`, is rejected with `VALIDATION`. Use a domestic gateway (Razorpay, Cashfree, PayU, PhonePe, Paytm, CCAvenue) for INR.
- **Minimum USD 50 per payment** (Skydo FAQ), or the equivalent in other currencies. The adapter enforces it exactly for USD (`amount` ≥ `5000`); for other currencies it only adds a reminder to the instructions.
- **No cards, UPI or website checkout.** Payment is a bank transfer to your Skydo receiving account.
- **No refunds** through this project. Skydo's FAQ says it cannot initiate a refund directly for settled InstaLink payments; for anything else ask Skydo support.
- **No webhooks.** Poll (Zoho bridge) or record receipts (ledger mode).
- **No recurring payments** (InstaLinks do not support them, per Skydo's FAQ, and Skydo has no subscription product): raise one invoice per billing period. No customer objects, no settlement or payout API. Payouts to your Indian bank and FIRAs are in the Skydo dashboard (Reports tab exports).
- **Payment links (InstaLinks) can only be created in the Skydo dashboard, and each link is single-use.** This project cannot create or track them.
- **Fees and FX are not computed.** Amounts stay in the invoice currency; the INR settlement is not tracked. See Skydo's website for current fees.
- **Every incoming transfer must be matched to an invoice in Skydo.** Always give clients the orderRef as the payment reference. For GBP, keep it to 18 characters or fewer (UK transfers often cut references).
- `orderRef` is 3-40 characters of letters, digits, `_` and `-` (the same rule as every gateway here). It is the Zoho `reference_number` and the bank-transfer reference.
- **Zoho API limits apply** to the Zoho bridge: per Zoho's docs, 100 requests per minute per organisation, and 1,000 (Free) to 10,000 (Premium and above) requests per day depending on your plan. Each create costs a few calls; each status check costs one with `providerOrderId`, two without. Polling every 15 minutes costs 96 calls a day per open invoice.

---

## 8. Troubleshooting

### Configuration errors (`CONFIG_MISSING` / `CONFIG_INVALID`, shown as `initError` by `doctor`)

| Message | Fix |
|---|---|
| `Skydo needs SKYDO_RECEIVING_ACCOUNTS ... and/or the ZOHO_* variables for the Zoho Books bridge.` | Configure one of the modes |
| `Skydo's Zoho Books bridge is half-configured. Missing: ZOHO_...` | Set the listed variables, or remove all `ZOHO_*` to use ledger mode |
| `ZOHO_DATA_CENTER "..." is not one of com, eu, in, ...` | Use the domain your `books.zoho.*` URL ends with (`books.zoho.in` → `in`), or set `ZOHO_ACCOUNTS_URL` |
| `SKYDO_RECEIVING_ACCOUNTS is neither JSON nor an existing file` / `is not valid JSON` / `must be a non-empty JSON array` | Fix the value. Inline JSON must start with `[` |
| `SKYDO_RECEIVING_ACCOUNTS[i].currency must be an ISO code like "USD" or "*".` / `[i].details must be an object of label -> text.` | Fix entry `i`. All detail values must be strings |
| `No Skydo receiving account for GBP and no "*" fallback in SKYDO_RECEIVING_ACCOUNTS.` | Add that currency or a `"*"` account |
| `Skydo ledger file ... is not valid JSON` | Fix or move the file. It is never overwritten while unreadable |

Values that look like template placeholders (containing `replace-me`, eight or more `x` characters, or `<...>`) are treated as unset.

### Zoho errors

| Message | Cause and fix |
|---|---|
| `Zoho refused the refresh token (invalid_code ...)` (`AUTH`) | The refresh token is wrong or revoked, or belongs to another data center. Generate a new one (step 4) and check `ZOHO_DATA_CENTER` |
| `Zoho refused the refresh token (invalid_client ...)` (`AUTH`) | Client ID/secret wrong, or the client belongs to another data center |
| `Zoho is rate-limiting token refreshes (...)` (`RATE_LIMITED`) | More than 10 token refreshes in 10 minutes (for example many short-lived processes). Wait a few minutes |
| `AUTH` with hint "Check ZOHO_DATA_CENTER and that the refresh token ... belongs to ZOHO_ORGANIZATION_ID" | Zoho rejected the call even with a fresh token (HTTP 401, Zoho code 57, "You are not authorized to perform this operation"): wrong organisation, wrong data center, or the token lacks one of the two scopes |
| `skydo zoho_create_invoice failed (HTTP 4xx): <Zoho message>` or `Zoho Books zoho_create_invoice failed: <Zoho message>` (`PROVIDER_ERROR`) | Zoho rejected the request; `providerCode` and `providerMessage` carry Zoho's own code and message. Common causes: `ZOHO_ITEM_ID` is not an active item in that organisation; the invoice currency differs from the organisation's base currency and no exchange rate is set (pass `providerOptions.exchangeRate`) |
| `No Zoho Books customer with email ...` (`VALIDATION`) | Create the customer (step 3), make that address the primary contact's email, or pass `providerOptions.zohoCustomerId` |
| `N active Zoho Books customers use ...` | Pass `providerOptions.zohoCustomerId` to pick one |
| `The Zoho Books customer for ... is inactive.` | Mark the customer active in Zoho Books |
| `Pass customer.email (or providerOptions.zohoCustomerId) to pick the Zoho Books customer.` | Add one of them |
| `Zoho contact ... is a vendor, not a customer.` (`VALIDATION`) | `zohoCustomerId` points at a non-customer contact. Pass a customer's id |
| `Zoho customer ... is inactive.` (`VALIDATION`) | The `zohoCustomerId` customer is inactive. Mark it active in Zoho Books |
| `Zoho customer ... is billed in EUR, not USD.` | Use the customer's currency, or change it in Zoho Books |
| `Zoho invoice INV-... already uses reference ... with a different amount or currency.` | Use a new orderRef, or void the old invoice in Zoho |
| `Zoho invoice INV-... for ... was voided. Use a new orderRef for a new invoice.` | As it says |
| `Zoho invoice INV-... has reference ..., not ...` (`VALIDATION`) | The `providerOrderId` you passed belongs to another order. Pass the id stored for this order |
| `No Zoho Books invoice with reference ...` (`NOT_FOUND`) | Wrong orderRef, or the invoice was created in another organisation |

### The invoice does not appear in Skydo

1. **It was created before Skydo was connected to Zoho.** Skydo imports only invoices created after connecting. Create a new invoice with a new orderRef.
2. **Currency filter.** Check the "all currencies" / "international only" choice in Skydo's Zoho connection, and that the invoice is in a foreign currency.
3. **Wait for the sync.** Skydo syncs about every 10 minutes.
4. **Wrong organisation.** The organisation connected in Skydo must be the one in `ZOHO_ORGANIZATION_ID`.
5. **Status.** The adapter marks drafts sent. If you created the invoice by hand, make sure it is not still a draft and is not void.
6. **API-created invoices.** If invoices you create by hand in Zoho appear in Skydo but API-created ones never do, Skydo is not importing API-created invoices for your account: ask Skydo support, and use ledger mode meanwhile. Please open an issue too.

### The client paid, but the status has not changed

- **Zoho bridge:** Skydo marks the invoice paid only after it has matched the payment to the invoice. Check the Skydo dashboard. A short payment (bank fees abroad) can leave the invoice `partially_paid` (`pending`).
- **Ledger mode:** nothing changes until you call `payments_skydo_record_payment`.

### Other errors

| Message | Fix |
|---|---|
| `Skydo receives foreign currency from abroad: pass the client's currency ...` | Pass an ISO `currency`; INR is not supported |
| `Skydo's minimum payment is USD 50.00 ...` | Amount is in cents: at least `5000` |
| `Skydo ledger has no order ...` (`NOT_FOUND`) | The order was created with another `SKYDO_LEDGER_FILE`, in Zoho mode, or in mock mode |
| `orderRef ... is already tracked with a different amount or currency.` | Use a new orderRef |
| `receiptId is required ...` | Pass `receipt_id` (MCP) / `receiptId` (SDK) |
| `Receipt ... was already recorded with amount ...` (`IDEMPOTENCY_CONFLICT`) | That receipt is already in the ledger with another amount. Check it; use a different `receipt_id` only for a genuinely different transfer |
| `Receipt ... is already recorded on order ...` (`IDEMPOTENCY_CONFLICT`) | The same Skydo transfer (ids compare case-insensitively) was recorded against another order. Check which order it really paid |
| `receivedAt "..." is not an ISO 8601 date ...` / `receivedAt ... is in the future.` (`VALIDATION`) | Pass `2026-10-29` or `2026-10-29T10:00:00Z`, not later than today |
| `Recording a Skydo receipt on skydo in LIVE mode is blocked.` or `... is blocked: Skydo has no sandbox, so sandbox mode works on real data.` (`LIVE_MUTATION_BLOCKED`) | MCP in sandbox or live: set `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` and pass `confirm: true` after a human has checked the receipt |
| `Skydo ledger ... is locked by another process.` (`PROVIDER_UNAVAILABLE`) | Another process held the lock for over 15 seconds (a crashed holder's lock is broken after 10). Retry |
| `With the Zoho Books bridge, Skydo marks invoices paid itself; nothing to record.` | Expected in Zoho mode |
| `Mock mode simulates Skydo receipts with payments_mock_complete_payment.` | Expected in mock mode |

---

## 9. FAQ

**Does this project call Skydo?**
No. It calls Zoho Books (Zoho bridge) or nothing at all (ledger mode).

**Why not automate the Skydo dashboard?**
Skydo's Terms of Use prohibit scrapers, bots and other automated access. It would also break whenever the dashboard changes.

**Which mode should I use?**
The Zoho bridge if you already use Zoho Books or are willing to: once Skydo is connected and you have confirmed it imports your API-created invoices, status updates need no one, and the FIRA lands on the invoice. Ledger mode if you don't use Zoho; it needs a person to confirm and record each receipt.

**Can I accept cards or UPI with Skydo?**
No. For card payments from international customers, use a gateway that offers them (for example Razorpay with international payments enabled, PayU, CCAvenue, or Stripe, which is invite-only in India). `payments_recommend_gateway` with `international` or `exporter_collections` ranks the options.

**Can I test without touching my real books?**
Use `PAYMENTS_MODE=mock`. `sandbox` is not a sandbox for Skydo: with `ZOHO_*` set it creates real Zoho invoices, and the ledger is real (receipt recording is gated as in live).

**Where is the FIRA?**
Zoho bridge: attached to the Zoho invoice by Skydo (`firaAttached` in the status `raw`). Ledger mode: in the Skydo dashboard and your inbox; store its number with `fira_number` when you record the receipt.

**Is creating a payment twice safe?**
Yes, with the same orderRef, amount and currency. The Zoho bridge finds the existing invoice by reference and returns the full invoice; if a concurrent process created a twin, the oldest `invoice_id` wins and only the loser is voided. Ledger mode returns the existing entry. A different amount or currency for the same orderRef fails.

**Is recording a receipt twice safe?**
Yes, if you use the same `receipt_id` (case does not matter): the second call changes nothing. The same id cannot be recorded on a different order.

**Can my app and the MCP server share the ledger?**
Yes, on the same machine and a local disk: every change is made under an owner-checked file lock, re-reads the file and is fsynced before the rename. Do not use network file systems; lock files are not reliable there. For several machines, use the Zoho bridge or keep your own database.

**Can an AI agent mark an order paid?**
Only in ledger mode, with `payments_skydo_record_payment`, and (outside mock mode, so in sandbox as well as live) only when the server allows live mutations and the call passes `confirm: true`. `confirm` is an honour system: configure your MCP client to ask the human before this tool runs. The tool description tells agents to act only on a receipt a human has checked. Treat forwarded "payment received" emails as untrusted.

**What happens when Skydo ships an API?**
The adapter will switch to it: create, status and webhooks through Skydo directly, with the Zoho bridge and ledger kept for existing users. See [roadmap.md](roadmap.md).
