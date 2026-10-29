# Independent verification: Dodo Payments

Scope: `src/providers/dodo/adapter.ts` and `src/providers/dodo/capabilities.ts`, checked on 2026-10-29 against Dodo's own documentation and the official TypeScript SDK. `docs/research/dodo-api-facts.md` was used only to find URLs. Every fact below was re-read at the source.

## Source situation

- **docs.dodopayments.com**: each API reference page ends in `.md` and returns raw Markdown with that endpoint's OpenAPI 3.1 block. Every block fetched says `version: 1.120.26`, with servers `https://test.dodopayments.com/` and `https://live.dodopayments.com/`. These blocks are the main source here.
- **Official SDK** `github.com/dodopayments/dodopayments-typescript` (generated from the same spec). Files read on `main`: `src/client.ts`, `src/resources/webhooks/webhooks.ts`, `payments.ts`, `refunds.ts`, and `packages/mcp-server/src/{docs-search-tool,code-tool}.ts`.
- The webhook payload pages (`developer-resources/webhooks/intents/payment.md`, `refund.md`) return only a title in Markdown. The payload shapes were therefore taken from the SDK's webhook event types: `data: PaymentsAPI.Payment` and `data: RefundsAPI.Refund`. These are the same schemas as `GET /payments/{id}` and `GET /refunds/{id}`.
- Only read-only GETs were made. No authenticated request was sent.

### Key URLs

| Short name | URL |
|---|---|
| API intro | https://docs.dodopayments.com/api-reference/introduction.md |
| Create checkout | https://docs.dodopayments.com/api-reference/checkout-sessions/create.md |
| Get checkout | https://docs.dodopayments.com/api-reference/checkout-sessions/get-checkouts.md |
| Checkout guide | https://docs.dodopayments.com/developer-resources/checkout-session.md |
| PWYW guide | https://docs.dodopayments.com/developer-resources/dynamic-pricing-checkout.md |
| Get product | https://docs.dodopayments.com/api-reference/products/get-products-1.md |
| Get payment | https://docs.dodopayments.com/api-reference/payments/get-payments-1.md |
| Create refund | https://docs.dodopayments.com/api-reference/refunds/post-refunds.md |
| Get refund | https://docs.dodopayments.com/api-reference/refunds/get-refunds-1.md |
| Refunds guide | https://docs.dodopayments.com/features/transactions/refunds.md |
| Create customer | https://docs.dodopayments.com/api-reference/customers/create-customer.md |
| Patch subscription | https://docs.dodopayments.com/api-reference/subscriptions/patch-subscriptions.md |
| List payouts | https://docs.dodopayments.com/api-reference/payouts/get-payouts.md |
| Payout structure | https://docs.dodopayments.com/features/payouts/payout-structure.md |
| Webhooks | https://docs.dodopayments.com/developer-resources/webhooks.md |
| Webhook events | https://docs.dodopayments.com/developer-resources/webhooks/intents/webhook-events-guide.md |
| Metadata | https://docs.dodopayments.com/api-reference/metadata.md |
| Error codes | https://docs.dodopayments.com/api-reference/error-codes.md |
| Adaptive currency | https://docs.dodopayments.com/features/adaptive-currency.md |
| Localized pricing | https://docs.dodopayments.com/features/localized-pricing.md |
| Payment methods | https://docs.dodopayments.com/features/payment-methods.md |
| India methods | https://docs.dodopayments.com/features/payment-methods/india.md |
| Test vs live | https://docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode.md |
| Merchant acceptance | https://docs.dodopayments.com/miscellaneous/merchant-acceptance.md |
| MCP server | https://docs.dodopayments.com/developer-resources/mcp-server.md |
| SDKs | https://docs.dodopayments.com/developer-resources/dodo-payments-sdks.md |
| FAQ | https://docs.dodopayments.com/miscellaneous/faq.md |
| SDK webhooks | https://github.com/dodopayments/dodopayments-typescript/blob/main/src/resources/webhooks/webhooks.ts |
| SDK payments | https://github.com/dodopayments/dodopayments-typescript/blob/main/src/resources/payments.ts |
| SDK refunds | https://github.com/dodopayments/dodopayments-typescript/blob/main/src/resources/refunds.ts |
| SDK client | https://github.com/dodopayments/dodopayments-typescript/blob/main/src/client.ts |

## Verification table

"adapter" means `adapter.ts` and "caps" means `capabilities.ts`.

### Base, auth, keys, errors

| # | Item | Code says (file:line) | Source says (≤15 words) | URL | Verdict |
|---|---|---|---|---|---|
| 1 | Test base URL | `https://test.dodopayments.com` (adapter:50) | "Test Mode: `https://test.dodopayments.com`" | API intro; SDK client `test_mode` | MATCH |
| 2 | Live base URL | `https://live.dodopayments.com` (adapter:50) | "Live Mode: `https://live.dodopayments.com`" | API intro | MATCH |
| 3 | Auth header | `Authorization: Bearer <key>` (adapter:268) | "`Authorization: Bearer dodo_test_...`"; OpenAPI `scheme: bearer` | API intro | MATCH |
| 4 | Key prefixes and mode lock | refuse `dodo_live_` in sandbox, `dodo_test_` in live, accept unprefixed (adapter:704-710; caps:39,52) | "test mode keys start with `dodo_test_`… Keys created before prefixes… keep working" | API intro | MATCH |
| 5 | Key location | "Dashboard > Developer > API Keys" (caps:39; adapter:702) | "Go to **Developer → API Keys** in your dashboard" | API intro | MATCH |
| 6 | Error body | `{code, message}` (adapter:713-716) | "An error response body contains two fields, `code` and `message`" | Error codes | MATCH |
| 7 | No idempotency key | POSTs are not retried; caps say there is no idempotency key (adapter:42,260-272; caps:48) | No idempotency header in any endpoint. SDK `idempotencyHeader` is declared but never set | SDK client.ts:509,1075 | MATCH |

### Products (GET /products/{id})

| # | Item | Code says | Source says | URL | Verdict |
|---|---|---|---|---|---|
| 8 | Path and method | `GET /products/{id}` (adapter:287) | `/products/{id}: get` (`get_product_handler`) | Get product | MATCH |
| 9 | `product_id`, `name`, `is_recurring`, `price` | interface (adapter:68-73) | All in `GetProductResponse` (`name` nullable) | Get product | MATCH |
| 10 | `price.type` values | `one_time_price` / `recurring_price` / `usage_based_price` (adapter:60) | `Price` oneOf with discriminator `type`, exactly these three | Get product | MATCH |
| 11 | `price.price` (minor units) | compared to `amount` (adapter:311) | "in the smallest denomination of the currency… int32" | Get product `OneTimePrice` | MATCH |
| 12 | `price.currency` | compared to order currency (adapter:296) | `currency` required on OneTimePrice | Get product | MATCH |
| 13 | `pay_what_you_want` and its minimum | if PWYW, refuse `amount < price.price` (adapter:302-306) | "If `pay_what_you_want` is `true`, this field represents the **minimum** amount" | Get product | MATCH |
| 14 | Discount field | reads only `discount_bps` (adapter:63,308) | `discount_bps` nullable int32 (basis points). The deprecated `discount` (whole %) is still in responses | Get product | MISMATCH (incomplete): a product with `discount_bps: null` and `discount > 0` passes the check |
| 15 | `tax_inclusive` | nullable boolean (adapter:65) | "`tax_inclusive`: boolean or null" | Get product | MATCH |
| 16 | Other fields that change the charged price | not checked | `purchasing_power_parity` (per-country discount) on the price; `pricing_mode` (`by_currency`/`by_country` localized prices) on the product | Get product; Localized pricing | MISMATCH (claim at caps:45 "must cost exactly `amount`… checked before the session" is not fully enforced) |
| 17 | `fixed_price` | not read (only for usage-based) | `UsageBasedPrice.fixed_price` required | Get product | MATCH (not applicable: adapter refuses usage-based) |

### Checkout sessions

| # | Item | Code says | Source says | URL | Verdict |
|---|---|---|---|---|---|
| 18 | Create path | `POST /checkouts` (adapter:349,645) | `/checkouts: post` (`create_session`) | Create checkout | MATCH |
| 19 | `product_cart[]` `{product_id, quantity}` | `[{product_id, quantity: 1}]` (adapter:341,648) | `ProductItemReq` requires `product_id`, `quantity` | Create checkout | MATCH |
| 20 | PWYW `product_cart[].amount` | sent only for PWYW, in minor units (adapter:341) | "Amount the customer pays if pay_what_you_want is enabled… lowest denomination… Only… one time payments" | Create checkout; PWYW guide | MATCH |
| 21 | PWYW base currency | USD/GBP/EUR (caps:15,41,45; adapter:280) | "The product's base currency must be USD, GBP, or EUR." | PWYW guide | MATCH |
| 22 | New-customer object | `{email, name?, phone_number?}` (adapter:324) | `NewCustomer` requires `email`; `name`, `phone_number` optional | Create checkout | MATCH |
| 23 | Existing customer | `{customer_id}` (adapter:321) | `AttachExistingCustomer` requires `customer_id` | Create checkout | MATCH |
| 24 | `billing_address` | `{country, city?, state?, street?, zipcode?}` (adapter:344) | `CheckoutSessionBillingAddress`: `country` required (alpha-2), rest optional | Create checkout | MATCH |
| 25 | `return_url` | (adapter:346,650) | `return_url` string/null | Create checkout | MATCH |
| 26 | `metadata` | (adapter:347,651) | `metadata`: "associated with the payment" | Create checkout | MATCH |
| 27 | Session metadata copied to the payment | read from payment `metadata.order_ref` (adapter:415) | "To read the metadata you attached… retrieve the resulting payment" | Metadata | MATCH |
| 28 | Protected option keys exist | `product_cart, customer, billing_currency, confirm, payment_method_id, discount_codes, discount_code, subscription_data, cancel_url, feature_flags, mandate_min_amount_inr_paise` (adapter:719-720) | All are real request fields | Create checkout | MATCH |
| 29 | Discount codes and currency switching at checkout | caps:46 says such payments become mismatches, "keep them off". `feature_flags` is a protected key, so callers cannot turn them off, and the adapter does not either | `allow_discount_code` "Default is true"; `allow_currency_selection` "Default is true" | Create checkout `CheckoutSessionFlags` | MISMATCH (behaviour): by default every session lets the buyer apply a code or switch currency |
| 30 | Response | `session_id`, `checkout_url` nullable (adapter:75-78) | `session_id` required; `checkout_url` "None when payment_method_id is provided" | Create checkout | MATCH |
| 31 | Null `checkout_url` explanation | "confirm / payment_method_id sessions have no checkout_url" (adapter:354) | The spec says null only for `payment_method_id`. With `confirm: true` it still returns `client_secret`/`payment_id` | Create checkout; Checkout guide | MATCH (close enough; `confirm` alone may still return a URL) |
| 32 | 24 h expiry | `expiresAt = now + 24 h` (adapter:367; adapter:668) | "Checkout sessions expire after 24 hours by default, or 15 minutes when `confirm: true`." | Checkout guide | MATCH |
| 33 | Quoted "Each checkout_url works once…" | comment (adapter:366) | Not found on any fetched page | Checkout guide | UNVERIFIABLE (the 24 h part matches; "works once" does not appear) |
| 34 | `cks_` session prefix | (caps:18; adapter:667) | Example `"session_id": "cks_Gi6KGJ2zFJo9rq9Ukifwa"` | Checkout guide | MATCH |
| 35 | Return URL is unsigned and carries `payment_id`, `status` (`subscription_id` for subscriptions) | (caps:17,47; adapter:399,657) | Query parameters `payment_id`, `subscription_id`, `status`, `license_key`, `email`. No signature | Checkout guide | MATCH |
| 36 | Get path | `GET /checkouts/{id}` (adapter:377) | `/checkouts/{id}: get` | Get checkout | MATCH |
| 37 | Get response | `id`, `payment_id?`, `payment_status?` (adapter:80-84) | `GetCheckoutSessionsStatus`: `id`, `created_at`, `payment_id` (null while collecting details), `payment_status` (IntentStatus/null) | Get checkout | MATCH |
| 38 | No metadata on the session lookup | session lookup is followed by GET payment (adapter:384-395) | "`GET /checkouts/{id}` doesn't return `metadata`" | Metadata | MATCH |

### Payments (GET /payments/{payment_id})

| # | Item | Code says | Source says | URL | Verdict |
|---|---|---|---|---|---|
| 39 | Path | `GET /payments/{id}` (adapter:373) | `/payments/{payment_id}: get` | Get payment | MATCH |
| 40 | `total_amount` | includes tax (adapter:96,229-238) | "Total amount charged to the customer including tax, in the currency's smallest unit" | Get payment | MATCH |
| 41 | `tax` | nullable int (adapter:98) | `tax` integer/null, smallest unit | Get payment | MATCH |
| 42 | `currency`, `metadata`, `checkout_session_id` | (adapter:97-100) | all present; `checkout_session_id` "set to the id of the session" | Get payment | MATCH |
| 43 | `payment_method`, `payment_method_type`, `error_message`, `subscription_id` | (adapter:101-107) | all present, nullable | Get payment | MATCH |
| 44 | `status` enum mapping | 11 values mapped (adapter:138-162) | IntentStatus: succeeded, failed, cancelled, processing, requires_customer_action, requires_merchant_action, requires_payment_method, requires_confirmation, requires_capture, partially_captured, partially_captured_and_capturable | Get payment; SDK payments.ts:219 | MATCH (all 11 values exist) |
| 45 | `refund_status` | `'partial' \| 'full' \| null` (adapter:104,141) | `PaymentRefundStatus` enum `partial`, `full`; "None if no succeeded refunds exist" | Get payment | MATCH |
| 46 | `product_cart[]` item | `{product_id, quantity}` (adapter:106) | `OneTimeProductCartItemResponse`: `product_id`, `quantity` | Get payment | MATCH |
| 47 | `refunds[]` item: `refund_id`, `status`, `amount` | (adapter:86-91) | `RefundListItem`: `refund_id`, `status`, `amount` (nullable), `currency`, `is_partial`, `reason`… | Get payment; SDK payments.ts:760-825 | MATCH |
| 48 | `refunds[]` item: `metadata` | `metadata?` read as fast path (adapter:90,466-467) | `RefundListItem` has **no** `metadata` (Refund detail does) | Get payment; SDK payments.ts | MISMATCH (low): the fast path never runs. Each refund is fetched in full (adapter:468-470), so the code still works |
| 49 | Currency checked when verifying | caps:46 says other-currency payments are reported as an "amount/currency mismatch". verifyPayment compares only the amount (adapter:425) | `currency` "Currency used for the payment"; Adaptive Currency may change it | Get payment; Adaptive currency | MISMATCH: `pay.currency` is never compared to the order currency |

### Refunds

| # | Item | Code says | Source says | URL | Verdict |
|---|---|---|---|---|---|
| 50 | Create path | `POST /refunds` (adapter:522) | `/refunds: post` | Create refund | MATCH |
| 51 | `payment_id` | required (adapter:514) | `required: [payment_id]` | Create refund | MATCH |
| 52 | `items[]` `{item_id, amount}` | `item_id = product_id` (adapter:511) | `PartialRefundItem`: `item_id` ("`product_id` or `addon_id`"), `amount` nullable, `tax_inclusive` (default true) | Create refund | MATCH |
| 53 | Full refund = no `items` | (adapter:515) | `items` optional ("Partially Refund an Individual Item") | Create refund | MATCH |
| 54 | `currency` is a request field | `currency: pay.currency`, always sent (adapter:517) | "The currency of every `items[].amount`. It must be the currency the customer paid in" | Create refund | MATCH (it is a real field). Risk: "If an earlier refund… has no amount in the payment currency, a refund with `currency` returns `REFUND_CURRENCY_NOT_SUPPORTED`", and credits cannot be refunded with `currency` |
| 55 | Without `currency` the amounts are in settlement currency | comment (adapter:516; caps:49) | "By default, each `amount` is in… settlement currency, which is USD for most payments" | Refunds guide | MATCH |
| 56 | `reason` ≤ 3000 | (adapter:57,486) | "Maximum length is 3000 characters" | Create refund | MATCH |
| 57 | `metadata` | `{refund_ref, order_ref}` (adapter:519) | `metadata` on CreateRefundRequest; RefundResponse `metadata` required | Create refund | MATCH |
| 58 | Response fields | `refund_id`, `payment_id`, `status`, `amount?`, `currency?`, `metadata?` (adapter:110-117) | RefundResponse: all present (`amount`, `currency` nullable) | Create refund | MATCH |
| 59 | Get path | `GET /refunds/{refund_id}` (adapter:469,528) | `/refunds/{refund_id}: get` | Get refund | MATCH |
| 60 | Refund status mapping | succeeded→processed, failed, pending/review→pending (adapter:164-176) | RefundStatus: succeeded, failed, pending, review | Create refund; Refunds guide | MATCH |
| 61 | 30-day window | (caps:21,49) | "30 days from the payment date (default)… After 30 days, refunds are not allowed" | Refunds guide | MATCH |
| 62 | One refund in flight | (caps:21,49) | "Only one refund per payment can be in progress… `pending` or `review`" | Refunds guide | MATCH |
| 63 | Balance must cover it; payment fees not returned | (caps:21,49) | "Your balance must cover the refund amount"; "Payment Fees entry has no reversal" | Refunds guide | MATCH |
| 64 | No refund speed option | (adapter:521) | No speed field in CreateRefundRequest | Create refund | MATCH |

### Webhooks

| # | Item | Code says | Source says | URL | Verdict |
|---|---|---|---|---|---|
| 65 | Headers | `webhook-id`, `webhook-timestamp`, `webhook-signature` (adapter:543-545) | Headers `webhook-id`, `webhook-signature`, `webhook-timestamp` (Unix seconds) | Webhooks | MATCH |
| 66 | Signed string | `${id}.${timestamp}.${rawBody}` (adapter:185) | "`{id}.{timestamp}.{body}`. Use the raw body exactly as received" | Webhooks | MATCH |
| 67 | Secret handling | strip `whsec_`, base64-decode (adapter:179-181) | "If it starts with `whsec_`, remove that prefix, then base64-decode the rest" | Webhooks | MATCH |
| 68 | Algorithm and encoding | HMAC-SHA256, base64 (adapter:185) | "Compute the HMAC-SHA256… and base64-encode the result" | Webhooks | MATCH |
| 69 | Header format | space-separated `v1,<sig>`, any match, constant-time (adapter:555-560) | "one or more space-separated signatures… `v1,<base64-signature>`… any `v1`… constant-time" | Webhooks | MATCH |
| 70 | Tolerance | 300 s, both directions (adapter:52,549-551) | "The Standard Webhooks libraries allow 5 minutes." | Webhooks | MATCH |
| 71 | Secret location | `whsec_...` from the endpoint's Overview tab (caps:40) | "Your webhook signing secret appears on the endpoint's **Overview** tab" | Webhooks | MATCH |
| 72 | Envelope | `business_id`, `type`, `timestamp`, `data.payload_type` (adapter:130-135,569,589) | Body: `business_id`, `type`, `timestamp` (ISO 8601), `data` with `payload_type` | Webhooks | MATCH |
| 73 | Payment event `data` fields | `metadata`, `checkout_session_id`, `payment_id`, `status`, `refund_status`, `total_amount`, `tax`, `currency` (adapter:571-588) | `PaymentSucceededWebhookEvent.data: PaymentsAPI.Payment` (same schema as GET payment) | SDK webhooks.ts:904-920 | MATCH |
| 74 | Refund event `data` fields | `refund_id`, `payment_id`, `amount`, `currency`, `metadata` (adapter:583-588) | `RefundSucceededWebhookEvent.data: RefundsAPI.Refund` (`metadata` required) | SDK webhooks.ts:1447-1463; refunds.ts:61-116 | MATCH |
| 75 | Event names mapped | payment.{succeeded,failed,cancelled,processing}, refund.{succeeded,failed}, subscription.{active,renewed,on_hold,past_due,failed,cancelled,expired}, dispute.opened, payout.success (adapter:188-204) | All of these appear in the events guide (`payout.failed` also exists; it is in the SDK and payout docs and is unmapped here) | Webhook events; Payout structure | MATCH |
| 76 | `payload_type` values in the simulator | `Payment`, `Refund` (adapter:605,609) | "One of: `Payment`, `Subscription`, `Refund`…" | Webhooks | MATCH |
| 77 | Webhook event coverage | "Payment, refund, subscription, dispute and payout events" (caps:24) | Event groups listed in the guide | Webhook events | MATCH |

### Customers, subscriptions, payouts

| # | Item | Code says | Source says | URL | Verdict |
|---|---|---|---|---|---|
| 78 | Create customer | `POST /customers`, `name`+`email` required, `phone_number?`, `metadata?` (adapter:622-628; caps:25) | `CreateCustomerRequest` required `name`, `email`; `phone_number`, `metadata` optional | Create customer | MATCH |
| 79 | Customer response | `customer_id` (adapter:629) | `CustomerResponse.customer_id` required | Create customer | MATCH |
| 80 | Cancel path | `PATCH /subscriptions/{id}` (adapter:674) | `/subscriptions/{subscription_id}: patch` | Patch subscription | MATCH |
| 81 | Cancel now | `{status: 'cancelled', cancel_reason: 'cancelled_by_merchant'}` (adapter:673) | "Set to `cancelled` to cancel"; CancelReason includes `cancelled_by_merchant` | Patch subscription | MATCH |
| 82 | Cancel at period end | `{cancel_at_next_billing_date: true}` (adapter:673) | "When set, the subscription will remain active until the end of billing period" | Patch subscription | MATCH |
| 83 | Response | `subscription_id`, `status`, `metadata` (adapter:674-676) | SubscriptionResponse requires `subscription_id`, `status`, `metadata` | Patch subscription | MATCH |
| 84 | `recurring_price` check for subscriptions | (adapter:638) | Price type `recurring_price` | Get product | MATCH |
| 85 | List payouts path and filters | `GET /payouts?created_at_gte&created_at_lte` (ISO date-time) (adapter:681-683) | query `created_at_gte`, `created_at_lte` (date-time, inclusive) | List payouts | MATCH |
| 86 | Page size | none sent; `slice(0, count ?? 100)` (adapter:684) | "`page_size`… default is 10 max is 100"; `page_number` default 0 | List payouts | MISMATCH: returns at most 10 payouts while the code implies up to 100 |
| 87 | Payout fields | `payout_id`, `amount`, `currency`, `status`, `fee`, `tax`, `updated_at`, `created_at` (adapter:119-128,685-691) | All in PayoutsResponse. `tax` is **deprecated** ("Use the v3 payout breakup endpoints") | List payouts | MATCH (note: `tax` deprecated) |
| 88 | `success` as settled status | `status === 'success'` (adapter:689) | PayoutStatus: not_initiated, in_progress, on_hold, failed, success | List payouts | MATCH |
| 89 | Payouts in USD/GBP/EUR, INR discontinued | (caps:11,30,35,50) | "INR-denominated payouts has been discontinued… USD, GBP, and EUR wallets only" | Payout structure; FAQ Q84 | MATCH |
| 90 | Payouts net of fees | (caps:30) | Payouts page shows "earnings… net of fees, refunds, and taxes" | Payout structure | MATCH |
| 91 | Local or SWIFT account | (caps:50) | Transfer method Local or Swift | Payout structure | MATCH |
| 92 | FIRA/FIRC not mentioned | (caps:50) | No "FIRA"/"FIRC" on any fetched page | — | MATCH (absence confirmed on fetched pages) |
| 93 | API cannot pay third parties | (caps:31) | API index lists only List Payouts / breakup / invoice under Payouts | API index | MATCH (absence) |

### Metadata

| # | Item | Code says | Source says | URL | Verdict |
|---|---|---|---|---|---|
| 94 | Key length | ≤ 40 (adapter:55) | "keys can be up to 40 characters long" | Metadata | MATCH |
| 95 | String value length | ≤ 500 (adapter:56) | "String values can be up to 500 characters long" | Metadata | MATCH |
| 96 | Pair count | ≤ 50 (adapter:54) | "up to 50 metadata key-value pairs per object" | Metadata | MATCH |
| 97 | Value types | not checked (adapter:215-226) | "Objects, arrays, and `null` are not accepted as metadata values" | Metadata | MISMATCH (low): user metadata with nested objects or nulls reaches Dodo and fails with a 422 instead of a local VALIDATION error |
| 98 | No search by metadata | (caps:18; adapter:436) | "The API can't search by metadata" | Metadata | MATCH |

### Capability text

| # | Item | Code says | Source says | URL | Verdict |
|---|---|---|---|---|---|
| 99 | MoR, digital only | (caps:11,44) | Accepts "SaaS & AI products, Digital goods, Templates, Plugins & Apps"; refuses physical goods and "coaching, freelancing or consulting" | Merchant acceptance | MATCH ("productised services" with limited repeatable human work are allowed; the caps text is slightly broader than the policy) |
| 100 | "145 currencies" | (caps:11,35) | The OpenAPI `Currency` enum has 145 codes. The product docs say "80+ local currencies" | Create checkout; Payment methods | MISMATCH (wording): 145 is the count of API codes, not a documented figure |
| 101 | "INR minimum Rs 5" | (caps:35) | "at least ₹5.00 and at least the equivalent of the USD minimum: $0.50… $1.00 for subscriptions" | India methods; Adaptive currency | MISMATCH: the real floor is the higher of ₹5 and the USD equivalent (about ₹40+) |
| 102 | Payment methods | card, upi, rupay, apple_pay, google_pay, klarna, afterpay, ach, sepa (caps:34) | All listed. Google Pay is "Global (except India)"; Klarna/Afterpay need USD with a US address and more than $50 | Payment methods | MATCH |
| 103 | UPI conditions | billing country IN, INR, `upi_intent` allowed (caps:51) | "billing country is India (`IN`)… billing currency is INR"; "UPI only as `upi_intent`" | India methods | MATCH |
| 104 | 48-51 h renewals; ₹15,000 mandate default | (caps:51) | "Debit Completed (~48-51 Hours)"; "system default of ₹15,000" | India methods | MATCH (₹15,000 applies to Indian-card e-mandates only: "UPI subscriptions… aren't affected") |
| 105 | Separate test/live keys, products, webhooks | (caps:52) | "Each mode has its own API keys, products, and webhooks." | Test vs live | MATCH |
| 106 | Static links | `checkout.dodopayments.com/buy/{product_id}` (caps:32) | `https://checkout.dodopayments.com/buy/pdt_123abc456def?paymentAmount=15.00` | PWYW guide | MATCH |
| 107 | Official MCP | npm `dodopayments-mcp`, tools `search_docs` + `execute` (caps:53,60) | `npx -y dodopayments-mcp@latest`; SDK tools `name: 'search_docs'`, `name: 'execute'` | MCP server; SDK mcp-server src | MATCH |
| 108 | SDK packages | npm dodopayments, pip dodopayments, Go `github.com/dodopayments/dodopayments-go`, PHP `dodopayments/client` (caps:55-61) | `npm install dodopayments`, `pip install dodopayments`, `go get github.com/dodopayments/dodopayments-go`, `composer require dodopayments/client` | SDKs | MATCH |
| 109 | Shopify app | "No Dodo Shopify payments app found." (caps:63) | Not checked against the Shopify App Store | — | UNVERIFIABLE |
| 110 | Discounts/Adaptive Currency change the total and are never reported as paid | (caps:46; adapter:425-426) | Amount check: true. Currency check: not done (see #49). Codes allowed by default (see #29) | Create checkout | MISMATCH (see #29, #49) |

## Summary

- **MISMATCH (fix needed)**: #29 discount codes and currency switching are on by default and cannot be turned off; #49 currency is never verified; #16 PPP and localized pricing are not detected; #86 payouts are capped at 10; #14 the deprecated `discount` field is ignored; #101 the INR minimum is understated; #100 "145 currencies"; #97 metadata value types are not checked; #48 the refund-list `metadata` fast path is dead code.
- **UNVERIFIABLE**: #33 the "works once" quote; #109 the Shopify claim.
- Everything else (paths, methods, request and response fields, enums, webhook scheme, limits, refund rules) matches the official spec 1.120.26 and SDK.
