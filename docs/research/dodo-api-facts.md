# Dodo Payments: verified API facts

Researched 2026-10-29. Sources are limited to official Dodo material: docs.dodopayments.com, and the official SDK repos under github.com/dodopayments. Status labels follow `gateway-api-facts.md`:

- **VERIFIED**: read on the official doc page cited, in the OpenAPI block embedded in that page, or in Dodo's own SDK source.
- **PARTIAL**: the official page confirms part of the fact. The rest is inferred from a second official page or from SDK code.
- **UNVERIFIED**: no official source was found. Test it in test mode before relying on it.

**Source of truth.** Every API reference page on docs.dodopayments.com embeds an `## OpenAPI` YAML block for its endpoint. Those blocks declare `openapi: 3.1.0`, `info.title: public`, `info.version: 1.120.26`, and the servers `https://test.dodopayments.com/` and `https://live.dodopayments.com/`. Field names, enums and paths below were copied from those blocks. Fetch any page as raw Markdown by appending `.md`, for example https://docs.dodopayments.com/api-reference/checkout-sessions/create.md.

The docs index https://docs.dodopayments.com/llms.txt links to `/openapi/openapi.documented.yml` under "OpenAPI Specs", but that URL returned a **404 HTML page** on 2026-10-29. The node SDK's `.stats.yml` (https://raw.githubusercontent.com/dodopayments/dodopayments-typescript/main/.stats.yml) contains only `configured_endpoints: 171`, with no `openapi_spec_url`. No full single-file spec could be downloaded, so the per-endpoint embedded blocks are what this document relies on.

The API reference index is https://docs.dodopayments.com/_llms/en/api-reference.txt (159 pages).

---

## 0. Summary row (for the cross-gateway table)

| Gateway | Auth | Amount unit | Client checkout | Callback signature | Webhook signature |
|---|---|---|---|---|---|
| Dodo Payments (MoR) | `Authorization: Bearer <key>` (`dodo_test_…` / `dodo_live_…`) | integer **smallest currency unit** (cents, paise; currency's own decimals) | Hosted checkout: `POST /checkouts` → `checkout_url` (also overlay/inline SDKs) | **None**: `return_url` gets plain `payment_id`, `status`, `email` query params | **Standard Webhooks**: `webhook-signature: v1,<base64 HMAC-SHA256("{webhook-id}.{webhook-timestamp}.{rawBody}")>`, key = base64-decode(secret without `whsec_`) |

---

## 1. What Dodo is, and India notes

| Item | Fact | Status |
|---|---|---|
| Business model | **Merchant of Record (MoR)**: "We are the legal seller of your digital products". Dodo calculates, collects and remits sales tax (VAT/GST/US sales tax). The merchant receives **net payouts** | VERIFIED https://docs.dodopayments.com/features/mor-introduction.md |
| Buyer reach | "Accept payments from 220+ countries and regions" | VERIFIED https://docs.dodopayments.com/features/mor-introduction.md, list: https://docs.dodopayments.com/miscellaneous/list-of-countries-we-accept-payments-from.md |
| Who can sign up | Individuals or registered entities, with KYC ID issued by a country on the accepted list. **India is on the list** (item 75) | VERIFIED https://docs.dodopayments.com/miscellaneous/accepted-countries-and-territories.md, https://docs.dodopayments.com/miscellaneous/verification-process.md |
| What can be sold | **Digital only**: SaaS and AI products, digital goods, templates, plugins and apps. Prohibited: physical goods, manual or human-delivered services (consulting, freelancing, coaching), financial products, professional services, adult content, and more | VERIFIED https://docs.dodopayments.com/miscellaneous/merchant-acceptance.md |
| Product tax categories | `TaxCategory` enum: `digital_products`, `saas`, `e_book`, `edtech`, `live_tutoring` (required on product create) | VERIFIED https://docs.dodopayments.com/api-reference/products/post-products.md |
| Indian KYC | Indian individuals: PAN is mandatory. Registered businesses: Business PAN or GSTIN. Sole proprietors with a GSTIN should register as "Registered Entity" | VERIFIED https://docs.dodopayments.com/miscellaneous/faq.md (Q30, Q35) |
| Live vs payouts | Live mode is usable from sign-up, but live payments need every verification form approved. Payouts additionally need Bank Verification, Business Verification (entities) and a completed Monitoring Review | VERIFIED https://docs.dodopayments.com/miscellaneous/verification-process.md |
| INR as a charge currency | Supported (`INR` is in the `Currency` enum). UPI, RuPay and Indian-card subscriptions are billed in INR. INR minimum is ₹5.00, and at least the equivalent of $0.50 (one-time) or $1.00 (subscriptions) | VERIFIED https://docs.dodopayments.com/features/payment-methods/india.md, https://docs.dodopayments.com/features/adaptive-currency.md |
| INR payouts | **Discontinued.** "Support for the INR native wallet and INR-denominated payouts has been discontinued. Payouts are consolidated through the USD, GBP, and EUR wallets only." Dodo can move an INR balance to USD (less a conversion fee) on request to support | VERIFIED https://docs.dodopayments.com/features/payouts/payout-structure.md, https://docs.dodopayments.com/miscellaneous/faq.md |
| Payout to an Indian bank | Payout accounts are registered per currency and transfer method: **Local** (local bank details, no wire fee) or **Swift** (USD SWIFT wire, with fee). Payout fee under standard pricing is $5 for payouts below $1,000. Minimum payout threshold is $50 or more (default $100 per the table) | VERIFIED https://docs.dodopayments.com/features/payouts/payout-structure.md |
| Payout cycle | Default **bi-monthly** (billing periods paid on the 18th and the 4th of the next month). Weekly is available on request for high volume, and monthly applies to some high-risk businesses | VERIFIED https://docs.dodopayments.com/features/payouts/payout-structure.md |
| GST for Indian merchants | "Dodo Payments automatically calculates and applies GST for Indian merchants based on your customer's location." The merchant still files their own income tax | VERIFIED https://docs.dodopayments.com/miscellaneous/faq.md (Q31, Q34) |
| FIRA / FIRC / e-FIRA | **Not mentioned anywhere** in the docs. There was no hit for "FIRA", "FIRC" or "inward remittance" across the guide, FAQ, payout and verification pages. Payout invoices exist (`GET /invoices/payouts/{payout_id}`, plus `payout_document_url` on payouts) and can carry the merchant's Tax ID (e.g. GSTIN) | UNVERIFIED (FIRA absent), VERIFIED (payout invoice) https://docs.dodopayments.com/miscellaneous/verification-process.md |
| BYOP | Merchants can connect their own Stripe or Adyen to route selected countries ("Bring Your Own Processor"). `PaymentProvider` enum: `stripe`, `adyen`, `dodo` | VERIFIED https://docs.dodopayments.com/features/mor-introduction.md, https://docs.dodopayments.com/api-reference/payments/get-payments-1.md |

---

## 2. Environments, auth, limits

| Item | Fact | Status |
|---|---|---|
| Base URLs | Test: `https://test.dodopayments.com`. Live: `https://live.dodopayments.com`. Paths are at the root, with **no `/v1` prefix** (e.g. `POST https://test.dodopayments.com/checkouts`) | VERIFIED https://docs.dodopayments.com/api-reference/introduction.md, plus the OpenAPI `servers` block |
| SDK environment names | `live_mode` → live URL, `test_mode` → test URL. **SDK default is `live_mode`**. Env vars: `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY`, `DODO_PAYMENTS_BASE_URL` | VERIFIED https://github.com/dodopayments/dodopayments-typescript/blob/main/src/client.ts |
| Hosted checkout host | Test sessions return `https://test.checkout.dodopayments.com/session/cks_…`. Static payment links use `https://checkout.dodopayments.com/buy/{product_id}` | VERIFIED (examples) https://docs.dodopayments.com/developer-resources/checkout-session.md, https://docs.dodopayments.com/developer-resources/integration-guide.md |
| API key format | Test keys start with `dodo_test_`, live keys with `dodo_live_`. Older keys have no prefix and still work. Keys are mode-specific: a key sent to the wrong environment gets `401` with a message naming the mismatch | VERIFIED https://docs.dodopayments.com/api-reference/introduction.md, https://docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode.md |
| Key permissions | Per-resource None/Read/Write (Payouts and Balances are read-only). Missing access → `403 INSUFFICIENT_PERMISSION`. Optional IP allowlist of up to 20 entries; a blocked IP → `403 IP_ADDRESS_NOT_ALLOWED` | VERIFIED https://docs.dodopayments.com/api-reference/introduction.md |
| Auth header | `Authorization: Bearer dodo_test_...` (OpenAPI `security: API_KEY`). License activate/validate/deactivate are public (no key) | VERIFIED https://docs.dodopayments.com/api-reference/introduction.md |
| Error body | `{ "code": "INVALID_REQUEST_BODY", "message": "…" }`. Code list: https://docs.dodopayments.com/api-reference/error-codes.md | VERIFIED |
| Versioning | There is **no version header and no dated API version**. The only version is the spec's `info.version` (`1.120.26` on 2026-10-29). The changelog is per release (https://docs.dodopayments.com/changelog/introduction.md). Deprecated endpoints are flagged (`deprecated: true`) rather than versioned | PARTIAL (inferred from the absence of any version header in the spec and docs) |
| Rate limits | Per business, across all keys. Default: **40 req/s burst, 240 req/min sustained**. Tier 1: 100/s and 1,000/min. Tier 2: 500/s and 5,000/min. Unauthenticated: 20/s and 100/min per IP. Invoice PDFs: 5/min per record and 20/min per IP. Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (seconds). Over the limit → `429` | VERIFIED https://docs.dodopayments.com/api-reference/introduction.md |
| Idempotency (API requests) | **No documented idempotency header.** None of the docs or spec blocks mentions `Idempotency-Key`. In the TS SDK, `idempotencyHeader` is declared but never assigned in `client.ts`, so the SDK sends no idempotency header. Only usage events (`event_id`) and webhook delivery (`webhook-id`) are documented as idempotent | PARTIAL https://github.com/dodopayments/dodopayments-typescript/blob/main/src/client.ts (lines ~509, ~1074) |
| SDK retries | TS SDK `maxRetries` defaults to 2 | VERIFIED src/client.ts |

**Adapter consequence:** with no idempotency key, retrying `POST /checkouts` or `POST /refunds` after a timeout can create duplicates. For refunds, the API allows only one refund in `pending` or `review` per payment, which limits the damage (see §5). For checkouts, put our own reference in `metadata` and treat a duplicate unused session as harmless, since sessions expire after 24h.

---

## 3. One-time payments

### 3a. Ways to start one

| Way | Endpoint / URL | Notes | Status |
|---|---|---|---|
| **Checkout Session** (recommended) | `POST /checkouts` (operationId `create_session`) | Hosted page. Returns `checkout_url`. Each `checkout_url` "works once and expires after 24 hours" | VERIFIED https://docs.dodopayments.com/api-reference/checkout-sessions/create.md, https://docs.dodopayments.com/developer-resources/integration-guide.md |
| Checkout Session preview | `POST /checkouts/preview` | Price and tax preview | VERIFIED (path only) https://docs.dodopayments.com/api-reference/checkout-sessions/preview.md |
| Create One-Time Payment | `POST /payments` (operationId `create_one_time_payment_handler`) | **`deprecated: true`**: "Use Create Checkout Session (POST /checkouts) for new one-time payment integrations." | VERIFIED https://docs.dodopayments.com/api-reference/payments/post-payments.md |
| Static payment link | `https://checkout.dodopayments.com/buy/{product_id}?quantity=1&redirect_url=…` | No code. Query params include `quantity`, `redirect_url` (required; note the name is **not** `return_url`), `paymentCurrency`, `showCurrencySelector`, `showDiscounts`, `paymentAmount` (**major units**, PWYW only), `metadata_<key>`, `singlePage`, and prefill fields `fullName`, `firstName`, `lastName`, `email`, `country`, `addressLine`, `city`, `state`, `zipCode`, each with a `disable<Field>` flag | VERIFIED https://docs.dodopayments.com/developer-resources/integration-guide.md |
| Product short links | `POST /products/{id}/short_links`, `GET /products/short_links` | | VERIFIED (paths) https://docs.dodopayments.com/api-reference/products/post-products-id-short-links.md |

### 3b. `POST /checkouts` request (`CreateCheckoutSessionRequest`)

**Required: `product_cart` only.** VERIFIED https://docs.dodopayments.com/api-reference/checkout-sessions/create.md

| Field | Type | Meaning |
|---|---|---|
| `product_cart` | `ProductItemReq[]` | Up to 20 items. Each item: **`product_id`** (required), **`quantity`** (required, int ≥ 0), `amount` (int32, smallest unit; **only honoured for Pay-What-You-Want products**, one-time only), `addons[]` (`{addon_id, quantity}`, subscriptions only), `credit_entitlements[]` |
| `customer` | `CustomerRequest` = `{customer_id}` (AttachExistingCustomer) **or** `{email (required), name?, phone_number?}` (NewCustomer) | |
| `billing_address` | `{country (required, ISO alpha-2), city?, state?, street?, zipcode?}` | |
| `billing_currency` | `Currency` | Honoured only if Adaptive Pricing is enabled. Otherwise discarded |
| `allowed_payment_method_types` | `PaymentMethodTypes[]` (105 values, including `upi_intent`, `upi_collect`, `credit`, `debit`, `apple_pay`) | "Always provide 'credit' and 'debit' as a fallback" |
| `return_url` | string | "The url to redirect after payment failure or success." |
| `cancel_url` | string | Back button target. Without it, no back button is shown |
| `metadata` | `Metadata` | Map of string → string, int, number or bool |
| `confirm` | bool | If true, everything is finalized at create and missing data → API error. The response then includes `payment_id`, `client_secret` and `publishable_key` |
| `payment_method_id` | string | Saved method. Only with `confirm: true` plus an existing customer. `checkout_url` is then null |
| `discount_codes` | string[] (max 20) | `discount_code` is deprecated |
| `subscription_data` | `{trial_period_days?, on_demand?}` | Subscriptions |
| `mandate_min_amount_inr_paise` | int32 | INR e-mandate floor override (see §8) |
| `force_3ds` | bool | |
| `tax_id`, `customer_business_name` | string | B2B / GST invoice. `tax_id` needs `billing_address.country` |
| `feature_flags` | `CheckoutSessionFlags` | `allow_currency_selection`, `allow_discount_code`, `allow_phone_number_collection`, `allow_tax_id`, `always_create_new_customer`, `redirect_immediately`, `require_phone_number`, `require_tax_id`, `require_cardholder_name`, `single_page`, `allow_editing_addons`, and `allow_customer_editing_{name,email,country,state,city,street,zipcode,tax_id,business_name}` |
| `customization` | `{theme: dark\|light\|system, theme_config, force_language, show_order_details, show_on_demand_tag}` | |
| `custom_fields` | max 5. `{key, label, field_type: text\|number\|email\|url\|date\|dropdown\|boolean, options?, placeholder?, required}` | |
| `short_link`, `show_saved_payment_methods`, `minimal_address`, `product_collection_id` | | |

### 3c. `POST /checkouts` response (`CreateSessionResponse`)

`session_id` (required, `cks_…`), `checkout_url` (nullable; null when `payment_id`/`payment_method_id` is used), `payment_id`, `client_secret` and `publishable_key` (the last three only when `confirm: true`). VERIFIED https://docs.dodopayments.com/api-reference/checkout-sessions/create.md

### 3d. Products and amounts

| Item | Fact | Status |
|---|---|---|
| Products must exist first | **Yes.** `product_cart[].product_id` is required, so there is **no ad-hoc price/line item** in checkout sessions. The closest options are (a) a **Pay-What-You-Want** product plus `product_cart[].amount`, which must be ≥ the product minimum (one-time only, and PWYW "base currency must be USD, GBP, or EUR"), or (b) `POST /subscriptions/{id}/charge` with `product_price` for on-demand subscriptions | VERIFIED https://docs.dodopayments.com/developer-resources/dynamic-pricing-checkout.md, https://docs.dodopayments.com/api-reference/checkout-sessions/create.md |
| Create product | `POST /products`. Required: `name`, `tax_category`, `price`. `price` is a discriminated union on `type`: `one_time_price`, `recurring_price` or `usage_based_price`. `OneTimePrice` = `{price (int32, smallest unit), currency, discount_bps?, pay_what_you_want?, suggested_price?, tax_inclusive?, purchasing_power_parity?}` | VERIFIED https://docs.dodopayments.com/api-reference/products/post-products.md |
| Amount unit | Integer in the **currency's smallest unit**: "to charge $1.00, pass `100`". `total_amount` is described as "(e.g. cents for USD, yen for JPY, fils for KWD — see the currency's decimal places)". So INR is in **paise** (`mandate_min_amount_inr_paise` confirms ₹1 = 100 paise) | VERIFIED https://docs.dodopayments.com/api-reference/payments/get-payments-1.md, https://docs.dodopayments.com/features/payment-methods/india.md |
| Exception | Static payment link `paymentAmount` is in **major units** (`12.5` = $12.50) | VERIFIED https://docs.dodopayments.com/developer-resources/integration-guide.md |
| Products are per mode | Products, API keys and webhooks belong to the mode they were created in. Copy test → live from the dashboard | VERIFIED https://docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode.md |

### 3e. Redirect back to `return_url`

Query params appended by Dodo (VERIFIED https://docs.dodopayments.com/developer-resources/checkout-session.md):

| Param | When |
|---|---|
| `payment_id` | Always, for one-time payments |
| `subscription_id` | Always, for subscriptions |
| `status` | Always (e.g. `succeeded`, or `active` for subscriptions) |
| `license_key` | If the product issues license keys (comma-separated if several) |
| `email` | If the customer has an email |

Example: `https://yoursite.com/return?payment_id=pay_xxx&status=succeeded&email=customer%40example.com`

- **Not signed.** No signature, hash or HMAC parameter is documented. VERIFIED (absence on the page above).
- Docs say: "Always fulfill on `payment.succeeded` from the webhook, not on the browser redirect." VERIFIED https://docs.dodopayments.com/developer-resources/integration-guide.md
- Adapter rule: treat return params as hints, then call `GET /payments/{payment_id}` (or `GET /checkouts/{session_id}`) server-side.

### 3f. Deprecated `POST /payments` (for completeness)

Required: `product_cart`, `customer`, `billing`. Optional: `return_url`, `metadata`, `payment_link` (bool, "Whether to generate a payment link"), `billing_currency`, `allowed_payment_method_types`, `payment_method_id`, `discount_codes`, `tax_id`, `customer_business_name`, `redirect_immediately`, `require_phone_number`, `short_link`, `show_saved_payment_methods`, `adaptive_currency_fees_inclusive`.

Response requires `payment_id`, `total_amount`, `client_secret`, `customer` and `metadata`. It also returns `payment_link`, `expires_on`, `product_cart`, `discount_ids`.

VERIFIED https://docs.dodopayments.com/api-reference/payments/post-payments.md

---

## 4. Retrieve payment

| Item | Fact | Status |
|---|---|---|
| Retrieve | `GET /payments/{payment_id}` → `PaymentResponse` | VERIFIED https://docs.dodopayments.com/api-reference/payments/get-payments-1.md |
| Required response fields | `payment_id`, `business_id`, `total_amount`, `currency`, `is_update_payment_method`. Other fields: `status`, `created_at`, `updated_at`, `customer{customer_id,name,email,phone_number,metadata}`, `billing`, `metadata`, `checkout_session_id`, `payment_link`, `payment_method`, `payment_method_type`, `payment_method_id`, `card_last_four`, `card_network`, `card_type`, `card_issuing_country`, `card_holder_name`, `error_code`, `error_message`, `tax`, `settlement_amount`, `settlement_currency`, `settlement_tax`, `refunds[]`, `refund_status` (`partial`\|`full`), `disputes[]`, `product_cart[]`, `subscription_id`, `charge_type` (`new`\|`renewal`\|`plan_change`\|`on_demand`), `invoice_id`, `invoice_url`, `discounts[]`, `three_ds_*`, `payment_provider`, `brand_id`, `retry_attempt` | VERIFIED (same page) |
| Amounts | `total_amount` (int32, includes tax, smallest unit) with `currency`. `settlement_amount`/`settlement_currency` are what lands in the Dodo balance after conversion and fees. `tax` is in smallest unit | VERIFIED |
| Status enum (`IntentStatus`) | `succeeded`, `failed`, `cancelled`, `processing`, `requires_customer_action`, `requires_merchant_action`, `requires_payment_method`, `requires_confirmation`, `requires_capture`, `partially_captured`, `partially_captured_and_capturable` | VERIFIED (enum); meanings beyond the names are **not documented** per value |
| List | `GET /payments`. Query: `created_at_gte`, `created_at_lte`, `page_size` (default 10, max 100), `page_number` (default 0), `customer_id`, `subscription_id`, `status`, `brand_id`, `product_id`, `currency`. Response `{items: [...]}` | VERIFIED https://docs.dodopayments.com/api-reference/payments/get-payments.md |
| Lookup by our reference | **Not possible via filter.** "The API can't search or filter by metadata, but it returns metadata in API responses and webhooks." Workaround: store the returned `session_id` (or `payment_id`) against our order, then call `GET /checkouts/{id}`, which returns `{id, created_at, payment_id, payment_status (IntentStatus), customer_email, customer_name}`. `payment_id` is null while the session is still collecting details | VERIFIED https://docs.dodopayments.com/api-reference/metadata.md, https://docs.dodopayments.com/api-reference/checkout-sessions/get-checkouts.md |
| Metadata limits | Keys ≤ 40 chars, string values ≤ 500 chars, max 50 pairs. Values may be string, int, number or bool (no objects, arrays or null). Over the limit → `MAXIMUM_KEYS_REACHED` | VERIFIED https://docs.dodopayments.com/api-reference/metadata.md |
| Other payment endpoints | `GET /payments/{payment_id}/line-items` (accepts `?currency=`), `GET /invoices/payments/{payment_id}` (PDF), `GET` and `POST /payments/{payment_id}/retry` | VERIFIED (paths) https://docs.dodopayments.com/api-reference/payments/retrieve-line-items.md |

Suggested normalisation (our mapping, not Dodo's):
- `succeeded` → paid.
- `processing`, `requires_*`, `partially_captured*` → pending.
- `failed` → failed.
- `cancelled` → cancelled.

---

## 5. Refunds

| Item | Fact | Status |
|---|---|---|
| Create | `POST /refunds` (operationId `create_refund_handler`) | VERIFIED https://docs.dodopayments.com/api-reference/refunds/post-refunds.md |
| Request | **Required: `payment_id`.** Optional: `items[]` (`PartialRefundItem` = `{item_id (required; a product_id or addon_id), amount? (int32; null = whole item), tax_inclusive? (default true)}`), `reason` (≤ 3000 chars), `metadata`, `currency` | VERIFIED |
| Full vs partial | Omit `items` for a full refund. Partial refunds are **per item**, with **no top-level `amount` field** | VERIFIED https://docs.dodopayments.com/features/transactions/refunds.md |
| Currency trap | By default each `items[].amount` is in the **settlement currency** ("USD for most payments"). To refund in the currency the customer paid in (e.g. INR), set `currency` to the payment currency and get refundable amounts from `GET /payments/{id}/line-items?currency=` | VERIFIED https://docs.dodopayments.com/features/transactions/refunds.md |
| Response (`RefundResponse`) | Required: `refund_id`, `payment_id`, `business_id`, `status`, `created_at`, `is_partial`, `metadata`, `customer`, `brand_id`. Also `amount`, `currency`, `reason`, `network_reference`, `network_reference_type` (`acquirer_reference_number`\|`system_trace_audit_number`\|`retrieval_reference_number`\|`other`), `network_reference_updated_at` | VERIFIED |
| Status enum (`RefundStatus`) | `succeeded`, `failed`, `pending`, `review` (processor risk or compliance review) | VERIFIED https://docs.dodopayments.com/features/transactions/refunds.md |
| Retrieve / list | `GET /refunds/{refund_id}`. `GET /refunds` with `created_at_gte`, `created_at_lte`, `page_size`, `page_number`, `status`, `subscription_id`, `customer_id`. Receipt PDF at `GET /invoices/refunds/{refund_id}` | VERIFIED https://docs.dodopayments.com/api-reference/refunds/get-refunds-1.md, https://docs.dodopayments.com/api-reference/refunds/get-refunds.md |
| Rules | The payment must be `succeeded`. Refunds are allowed up to **30 days** from the payment (the customer policy is 7 days). Cumulative refunds ≤ amount paid. **Only one refund per payment may be `pending`/`review` at a time.** The merchant's Dodo balance must cover the refund, and payment fees are not returned. Refunds go to the original method | VERIFIED https://docs.dodopayments.com/features/transactions/refunds.md |
| Idempotency | No idempotency key (see §2). The one-in-flight rule is the only documented duplicate guard | PARTIAL |

---

## 6. Webhooks

| Item | Fact | Status |
|---|---|---|
| Spec | "Dodo Payments webhooks follow the Standard Webhooks specification" | VERIFIED https://docs.dodopayments.com/developer-resources/webhooks.md |
| Headers | `webhook-id` (unique event id; use for dedupe), `webhook-signature`, `webhook-timestamp` (Unix seconds) | VERIFIED |
| Signed string | `{webhook-id}.{webhook-timestamp}.{rawBody}`, using the raw body exactly as received | VERIFIED |
| Key | Webhook secret shown on the endpoint's Overview tab. "If it starts with `whsec_`, remove that prefix, then base64-decode the rest to get the signing key" | VERIFIED |
| Algorithm | base64(HMAC-SHA256(signingKey, signedString)). The header holds one or more **space-separated** `v1,<base64>` entries, and any match is valid. Compare in constant time | VERIFIED |
| Tolerance | Docs say to reject timestamps "too far from the current time" and that "The Standard Webhooks libraries allow 5 minutes" | VERIFIED |
| Secret rotation | Old secret stays valid for 24h after rotation | VERIFIED |
| SDK helper | `client.webhooks.unwrap(rawBody, {headers})` and `unsafeUnwrap` in TS. The TS SDK depends on npm `standardwebhooks` (^1.0.0) and builds `new Webhook(key)` | VERIFIED https://github.com/dodopayments/dodopayments-typescript/blob/main/src/resources/webhooks/webhooks.ts |
| Envelope | `{ business_id: string, type: string, timestamp: string (ISO 8601), data: {...} }`. `data.payload_type` ∈ `Payment`, `Subscription`, `Refund`, `Dispute`, `LicenseKey`, `CreditLedgerEntry`, `CreditBalanceLow`, `AbandonedCheckout`, `DunningAttempt`, `EntitlementGrant`, `Payout`. In the SDK, `payment.*` events have `data: Payment`, the same object as `GET /payments/{id}` | VERIFIED (envelope) https://docs.dodopayments.com/developer-resources/webhooks.md; PARTIAL (data = Payment, from SDK types) |
| Delivery | 30 s connect and read timeout. Any non-2xx → retry. **8 attempts total**: immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h. Manual replay is in the dashboard. Events can arrive **out of order**. Use the body `timestamp` to order them | VERIFIED |
| Source IPs | IP pool changes. Do not rely on an allowlist; verify the signature instead | VERIFIED |
| Endpoint management API | `POST/GET /webhooks`, `GET/PATCH/DELETE /webhooks/{webhook_id}`, `GET /webhooks/{webhook_id}/secret`, `GET/PATCH /webhooks/{webhook_id}/headers` | VERIFIED (paths) https://docs.dodopayments.com/api-reference/webhooks/create-webhook.md |
| Empty filter | If an endpoint deselects all events, it receives **every** event type | VERIFIED |

**Complete event list** (VERIFIED https://docs.dodopayments.com/developer-resources/webhooks/intents/webhook-events-guide.md):

- Payment: `payment.succeeded`, `payment.failed`, `payment.processing`, `payment.cancelled`
- Refund: `refund.succeeded`, `refund.failed`
- Dispute: `dispute.opened`, `dispute.challenged`, `dispute.accepted`, `dispute.cancelled`, `dispute.expired`, `dispute.won`, `dispute.lost`
- Subscription: `subscription.active`, `subscription.updated`, `subscription.past_due`, `subscription.on_hold`, `subscription.paused`, `subscription.unpaused`, `subscription.renewed`, `subscription.plan_changed`, `subscription.update_payment_method`, `subscription.cancelled`, `subscription.failed`, `subscription.expired`
- License key: `license_key.created`
- Entitlement grant: `entitlement_grant.created`, `entitlement_grant.delivered`, `entitlement_grant.failed`, `entitlement_grant.revoked`
- Credit: `credit.added`, `credit.deducted`, `credit.expired`, `credit.rolled_over`, `credit.rollover_forfeited`, `credit.overage_charged`, `credit.overage_reset`, `credit.manual_adjustment`, `credit.balance_low`
- Recovery: `abandoned_checkout.detected`, `abandoned_checkout.recovered`
- Dunning: `dunning.started`, `dunning.recovered`
- Payout: `payout.created` (formerly `payout.not_initiated`), `payout.in_progress`, `payout.on_hold`, `payout.success`, `payout.failed`. These are **not terminal and not strictly ordered**: `failed` can follow `success`, and vice versa

There is no `refund.pending` event. Refunds only emit final-state events.

---

## 7. Customers

| Item | Fact | Status |
|---|---|---|
| Create | `POST /customers`. Required: **`name`, `email`**. Optional: `phone_number`, `metadata`, `preferred_locale` | VERIFIED https://docs.dodopayments.com/api-reference/customers/create-customer.md |
| Response | Required: `customer_id`, `business_id`, `name`, `email`, `created_at`. Also `phone_number`, `metadata`, `preferred_locale`, `blocked_at`, `blocklist_entry_id` | VERIFIED |
| Retrieve / list / update | `GET /customers/{customer_id}`, `GET /customers`, `PATCH /customers/{customer_id}` | VERIFIED (paths) https://docs.dodopayments.com/api-reference/customers/get-customers-1.md |
| Other | `POST /customers/{customer_id}/customer-portal/session`; `GET /customers/{customer_id}/payment-methods` and `DELETE …/payment-methods/{payment_method_id}`; wallets (`GET /customers/{id}/wallets`, `GET/POST …/wallets/ledger-entries`); `GET …/emails`, `…/entitlements`, `…/credit-entitlements`, `…/entitlement-grants` | VERIFIED (paths) |
| In checkout | Pass `customer: {customer_id}` or `{email, name?, phone_number?}`. By default checkout matches an existing customer by email (`feature_flags.always_create_new_customer` overrides this) | VERIFIED https://docs.dodopayments.com/api-reference/checkout-sessions/create.md |

---

## 8. Subscriptions

| Item | Fact | Status |
|---|---|---|
| Create (recommended) | `POST /checkouts` with a product whose price `type` is `recurring_price`. Optional `subscription_data: {trial_period_days (0–10000), on_demand: {mandate_only (required), product_price?, product_currency?, product_description?, adaptive_currency_fees_inclusive?}}`. Return redirect carries `subscription_id` and `status` | VERIFIED https://docs.dodopayments.com/api-reference/checkout-sessions/create.md, https://docs.dodopayments.com/developer-resources/subscription-integration-guide.md |
| Create (deprecated) | `POST /subscriptions`, `deprecated`. Required: `product_id`, `quantity`, `customer`, `billing`. Response: `subscription_id`, `payment_id`, `recurring_pre_tax_amount`, `customer`, `metadata`, `addons`, `payment_method_required`, `client_secret`, `payment_link`, `expires_on`, `trial_amount` | VERIFIED https://docs.dodopayments.com/api-reference/subscriptions/post-subscriptions.md |
| Status enum (`SubscriptionStatus`) | `pending`, `active`, `on_hold`, `paused`, `cancelled`, `failed`, `expired`, `past_due` | VERIFIED https://docs.dodopayments.com/api-reference/subscriptions/patch-subscriptions.md |
| Retrieve / list | `GET /subscriptions/{subscription_id}`, `GET /subscriptions` | VERIFIED (paths) https://docs.dodopayments.com/api-reference/subscriptions/get-subscriptions.md |
| Update / cancel / pause | `PATCH /subscriptions/{subscription_id}` with `status`: **`cancelled`** cancels (with `cancel_reason` ∈ `cancelled_by_customer`, `cancelled_by_merchant`, `cancelled_by_merchant_send_dunning`, `cancelled_by_merchant_grace_period_expired`, `dodo_team`; plus `cancellation_feedback` and `cancellation_comment`). `cancel_at_next_billing_date: true` cancels at period end. `paused` pauses and `active` resumes; these must be sent **alone** or the API returns 422. The old `pause` field always returns 422. Other fields: `billing`, `metadata`, `next_billing_date`, `tax_id`, `customer_name`, `customer_business_name`, `disable_on_demand`, `credit_entitlement_cart`, `subscription_period_count`, `subscription_period_interval` | VERIFIED https://docs.dodopayments.com/api-reference/subscriptions/patch-subscriptions.md |
| Change plan | `POST /subscriptions/{id}/change-plan`. Required: `product_id`, `quantity`, `proration_billing_mode` ∈ `prorated_immediately`, `full_immediately`, `difference_immediately`, `do_not_bill`, `prorated_immediately_keep_cycle`. Optional: `addons`, `effective_at`, `on_payment_failure`, `discount_codes`, `metadata`, `return_url`, `collect_via_payment_link`, `cancel_older_payment_link`, `cancel_scheduled_change_plan`. Also `POST …/change-plan/preview` and `DELETE …/change-plan/scheduled` | VERIFIED https://docs.dodopayments.com/api-reference/subscriptions/change-plan.md |
| On-demand charge | `POST /subscriptions/{id}/charge`. Required: `product_price` (int32, smallest unit). Optional: `product_currency`, `product_description`, `metadata`, `adaptive_currency_fees_inclusive`, `customer_balance_config`. Returns `{payment_id}` | VERIFIED https://docs.dodopayments.com/api-reference/subscriptions/create-charge.md |
| Other | `POST /subscriptions/{id}/update-payment-method`, `GET …/usage-history`, `GET …/credit-usage` | VERIFIED (paths) |
| Trial | With a trial, the first payment is a $0 mandate payment | VERIFIED https://docs.dodopayments.com/miscellaneous/faq.md (Q49) |

**India / RBI e-mandate** (VERIFIED https://docs.dodopayments.com/features/payment-methods/india.md):

- Subscriptions are supported on UPI, RuPay, Indian Visa and Mastercard, and Apple Pay via RBI mandates.
- Every renewal has a **48-hour pre-debit delay**. `payment.succeeded` arrives about **48–51 h** after the renewal date. Grant access on the webhook, not on the date.
- Mandate amount is `max(mandate_floor, billing_amount)`. Below the floor, the mandate is an on-demand mandate at the floor. At or above it, a fixed-amount mandate. The default floor is **₹15,000**.
- Override the floor per checkout with `mandate_min_amount_inr_paise` (int, ≥ 1, INR paise). This applies to Indian-card INR e-mandates only, not UPI AutoPay.
- An upgrade above the mandate limit fails, and the customer must re-authorise.
- A customer can cancel the mandate in their bank app. The next charge then fails and the subscription goes to `on_hold`.
- UPI appears only if billing country is `IN`, billing currency is `INR`, and `upi_intent` is in `allowed_payment_method_types` (`upi_collect` alone shows nothing). Merchants **outside India** also need Adaptive Currency for UPI subscriptions.

---

## 9. Payouts and settlements

| Item | Fact | Status |
|---|---|---|
| List payouts | `GET /payouts`. Query includes `created_at_gte`, `created_at_lte` (plus pagination). Response `{items: PayoutsResponse[]}`, where each item requires `payout_id`, `business_id`, `payment_method`, `status`, `fee`, `tax`, `amount`, `created_at`, `updated_at`, `currency`, `refunds`, `chargebacks`. Also `name`, `payout_document_url`, `remarks` | VERIFIED https://docs.dodopayments.com/api-reference/payouts/get-payouts.md |
| Payout status | `not_initiated`, `in_progress`, `on_hold`, `failed`, `success` | VERIFIED (same page) |
| Breakup | `GET /payouts/{payout_id}/breakup`, `GET /payouts/{payout_id}/breakup/details`, `GET /payouts/{payout_id}/breakup/details/csv` | VERIFIED (paths) https://docs.dodopayments.com/api-reference/payouts/retrieve-breakup.md |
| Payout invoice | `GET /invoices/payouts/{payout_id}` (rate limited to 5/min per record) | VERIFIED https://docs.dodopayments.com/api-reference/payouts/get-payout-invoice.md |
| Balance ledger | `GET /balances/ledger` | VERIFIED (path) https://docs.dodopayments.com/api-reference/balance-ledger/list-ledger-entries.md |
| API key scope | Payouts and Balances are read-only. An API key cannot change the payout cycle | VERIFIED https://docs.dodopayments.com/api-reference/introduction.md |

---

## 10. Disputes, licence keys, products (endpoint list)

All VERIFIED as paths from the per-endpoint OpenAPI blocks under https://docs.dodopayments.com/api-reference/.

- **Disputes**: `GET /disputes`, `GET /disputes/{dispute_id}`. These are read-only, with no evidence-submission API. Dispute fields: `dispute_id`, `payment_id`, `amount`, `currency`, `dispute_status` (`dispute_opened`, `dispute_expired`, `dispute_accepted`, `dispute_cancelled`, `dispute_challenged`, `dispute_won`, `dispute_lost`), `dispute_stage` (`pre_dispute`, `dispute`, `pre_arbitration`), `remarks`, `is_resolved_by_rdr`.
- **Licence keys**:
  - `GET /license_keys`, `POST /license_keys`, `GET /license_keys/{id}`, `PATCH /license_keys/{id}`.
  - `GET /license_key_instances`, `GET /license_key_instances/{id}`, `PATCH /license_key_instances/{id}`.
  - Public, no API key: `POST /licenses/activate`, `POST /licenses/validate`, `POST /licenses/deactivate`.
  - Manual fulfilment: `POST /grants/{grant_id}/license-key`.
- **Products**:
  - `POST /products`, `GET /products`, `GET /products/{id}`, `PATCH /products/{id}`.
  - `DELETE /products/{id}` archives; `POST /products/{id}/unarchive` restores.
  - `PUT /products/{id}/images`, `PUT /products/{id}/files`.
  - Localized prices: `GET/POST /products/{product_id}/localized-prices`, `GET/PATCH/DELETE /products/{product_id}/localized-prices/{id}`.
  - Short links: `POST /products/{id}/short_links`, `GET /products/short_links`.
- **Others in the spec**:
  - addons `/addons…`, brands `/brands…`, discounts `/discounts…`, meters `/meters…`, usage events (`POST /events/ingest`, `GET /events`, `GET /events/{event_id}`).
  - entitlements `/entitlements…`, credit entitlements `/credit-entitlements…`, product collections `/product-collections…`.
  - customer blocklist `/blocklist/customers…`, moderation (`POST /moderation/screen`, `GET /moderation/usage`).
  - `GET /checkout/supported_countries`.

---

## 11. Payment methods and currencies

| Item | Fact | Status |
|---|---|---|
| Methods (overview table) | Cards (credit and debit, global), Apple Pay (including India), Google Pay (not India), Amazon Pay (not India), Cash App, ACH, SEPA, Klarna, Afterpay, **UPI (IN, INR, subscriptions\*)**, **RuPay (IN, INR, subscriptions\*)**, iDEAL, Bancontact, EPS, Multibanco, BLIK, Satispay, PAYCO, Naver Pay, Kakao Pay, Revolut Pay, Billie, Pix, Stablecoins (not India), WeChat Pay, GCash, Alipay HK, FPS, Touch 'n Go | VERIFIED https://docs.dodopayments.com/features/payment-methods.md |
| India checkout types | `upi_intent` (UPI via QR; the only UPI form shown at checkout), `credit`, `debit` (including RuPay), `apple_pay`. **Net banking and Indian wallets are not listed** | VERIFIED https://docs.dodopayments.com/features/payment-methods/india.md |
| Currencies | The `Currency` enum has 145 ISO codes, including `INR` and `USD`. Per-currency minimums: https://docs.dodopayments.com/features/adaptive-currency.md#supported-currencies (INR minimum 5.00) | VERIFIED |
| Adaptive Currency | Shows and charges in the customer's local currency. The conversion fee is added on top by default: 4% under $500, 3% for $500–$1,500, 2% above. The "Fees Inclusive" setting makes the merchant absorb it. INR→INR is always inclusive | VERIFIED https://docs.dodopayments.com/features/adaptive-currency.md, https://docs.dodopayments.com/miscellaneous/faq.md |
| Test data | UPI `success@upi` / `failure@upi`. Indian test cards: Visa `4576238912771450` (success) and `4706131211212123` (decline); Mastercard `5409162669381034` (success) and `5105105105105100` (decline); expiry 06/32, CVV 123 | VERIFIED https://docs.dodopayments.com/features/payment-methods/india.md |

---

## 12. Official SDKs and Dodo's own MCP server

| Item | Fact | Status |
|---|---|---|
| TS/Node SDK | npm **`dodopayments`**, latest **2.59.0** (registry, 2026-10-29). Repo https://github.com/dodopayments/dodopayments-typescript (Stainless-generated; `dodopayments-node` redirects here). Install with `npm install dodopayments`. Client: `new DodoPayments({ bearerToken, webhookKey, environment: 'test_mode' })` | VERIFIED https://docs.dodopayments.com/developer-resources/sdks/typescript.md, https://registry.npmjs.org/dodopayments/latest |
| Other SDKs | Python `dodopayments` (pip), Go `github.com/dodopayments/dodopayments-go`, PHP `dodopayments/client`, plus Java, Kotlin, C#, Ruby and Rust repos. There is also a CLI (`dodopayments-cli`), a Terraform provider, and mobile checkout SDKs | VERIFIED https://docs.dodopayments.com/developer-resources/dodo-payments-sdks.md |
| **Official MCP server** | **Yes. npm `dodopayments-mcp` 2.59.0**, "The official MCP Server for the Dodo Payments API". Source: `packages/mcp-server` in dodopayments-typescript. Run locally with `npx -y dodopayments-mcp@latest` and env `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY`, `DODO_PAYMENTS_ENVIRONMENT=test_mode`. It also runs in Docker. The local code sandbox needs Deno ≤ 2.8 and works on macOS and Linux only | VERIFIED https://docs.dodopayments.com/developer-resources/mcp-server.md, https://github.com/dodopayments/dodopayments-typescript/tree/main/packages/mcp-server |
| MCP tools | "**Code Mode**": two tools only. **`search_docs`** searches API and SDK docs. **`execute`** runs agent-written TypeScript against the SDK in a sandbox. There are no per-endpoint tools | VERIFIED (doc description) https://docs.dodopayments.com/developer-resources/mcp-server.md; tool names VERIFIED in `packages/mcp-server/src/docs-search-tool.ts` (`name: 'search_docs'`) and `code-tool.ts` (`name: 'execute'`) |
| Remote MCP | `https://mcp.dodopayments.com/mcp`. OAuth on first connect, where the user enters an API key and picks the environment. Connect via `npx -y mcp-remote@latest https://mcp.dodopayments.com/mcp` | VERIFIED https://docs.dodopayments.com/developer-resources/mcp-server.md |
| Knowledge MCP | `https://knowledge.dodopayments.com/mcp`: docs semantic search with no key (built on ContextMCP) | VERIFIED (same page) |
| Agent plugin / skills | `dodopayments/dodo-agent-plugin` ("Official Dodo Payments Plugin for Claude Code, Codex, Cursor and Opencode") and `dodopayments/skills` | VERIFIED https://github.com/dodopayments (org repo list) |

**Positioning note:** Dodo already ships its own MCP, but it is Dodo-only and Code Mode (raw SDK scripting). Our adapter's value is a normalised cross-gateway tool surface (create_payment, get_status, refund, verify_webhook) where Dodo sits alongside the Indian gateways. We should avoid presenting ours as "the" Dodo MCP.

---

## 13. Implementation gotchas for our adapter

1. **Base URL by mode, no `/v1`.** Key prefix `dodo_test_` maps to `https://test.dodopayments.com`. The SDK defaults to **live**, so set the mode explicitly.
2. **Products first.** There are no ad-hoc line items. `create_payment(amount)` needs either a pre-created PWYW product (USD, GBP or EUR base only) or a product per price. Document this limitation clearly.
3. **Amounts** are integer minor units, with per-currency decimals (JPY has 0, KWD has 3). Payment-link `paymentAmount` is in major units.
4. **Return URL is unsigned.** Always re-fetch with `GET /payments/{payment_id}`, or use `GET /checkouts/{session_id}` if the redirect was lost.
5. **No metadata search.** Persist `session_id` and `payment_id` on our side.
6. **Refund amounts default to the settlement currency (usually USD).** For INR payments, pass `currency: "INR"` with item amounts in paise. There is no top-level amount; partial refunds take `items[{item_id, amount}]`.
7. **Webhooks** use Standard Webhooks: strip `whsec_`, base64-decode, HMAC the string `id.ts.body`, then match any space-separated `v1,` entry. Allow 5 min of tolerance and dedupe on `webhook-id`. We can verify with node `crypto` alone and skip the `standardwebhooks` dependency.
8. **No idempotency header.** Guard retries ourselves.
9. **India payouts** settle in USD, GBP or EUR, not INR. FIRA handling is undocumented.

---

## Unverified / open items

- The full single-file OpenAPI spec could not be downloaded: `https://docs.dodopayments.com/openapi/openapi.documented.yml` (linked from llms.txt) returns 404. Per-endpoint embedded blocks were used instead.
- Idempotency: there is no documented header. The server's behaviour with an `Idempotency-Key` header is unknown.
- What each `IntentStatus` value means (`requires_merchant_action`, `partially_captured_and_capturable`, and so on). Only the names are documented.
- FIRA, FIRC, e-FIRA or purpose-code handling for Indian merchants' inward remittances: no mention found.
- Whether Indian merchants can charge Indian customers in INR **without** Adaptive Currency on a one-time INR-priced product. The India page says one-time checkouts "don't need it if the product is priced in INR", but it is silent on India-based merchants specifically. Treat as PARTIAL.
- Field-level webhook payload schemas for refund, subscription and dispute events: the intent pages render empty in `.md`. The SDK types show `data` reuses the API objects. PARTIAL.
- Exact pagination params on `GET /payouts` and `GET /disputes` beyond `created_at_*` were not individually confirmed.
- Pricing figures beyond what the docs state (e.g. the transaction fee %) live on https://dodopayments.com/pricing, which was not checked.

## OpenAPI sources

- Per-endpoint embedded OpenAPI 3.1.0 blocks (`info.version: 1.120.26`): append `.md` to any API reference page, e.g. https://docs.dodopayments.com/api-reference/checkout-sessions/create.md, https://docs.dodopayments.com/api-reference/payments/get-payments-1.md, https://docs.dodopayments.com/api-reference/refunds/post-refunds.md, https://docs.dodopayments.com/api-reference/subscriptions/patch-subscriptions.md
- Index of all 159 API reference pages: https://docs.dodopayments.com/_llms/en/api-reference.txt
- Advertised (404 on 2026-10-29): https://docs.dodopayments.com/openapi/openapi.documented.yml
- SDK stats (no spec URL): https://github.com/dodopayments/dodopayments-typescript/blob/main/.stats.yml
