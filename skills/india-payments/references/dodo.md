# Dodo Payments

Full setup guide: `docs/dodo.md` in the india-payments-mcp repo; sourced facts in `docs/research/dodo-api-facts.md`. Status labels: VERIFIED / PARTIAL / UNVERIFIED. Nothing in this project has yet been run against Dodo's real test mode: the adapter is checked against Dodo's docs, fixtures and the official `standardwebhooks` library only.

## What Dodo is: read this first

- **Merchant of Record (MoR) for digital products.** Dodo is the legal seller: it calculates, collects and remits VAT/GST/sales tax worldwide and pays you out net. VERIFIED https://docs.dodopayments.com/features/mor-introduction
- **Digital only**: SaaS, AI products, digital goods, templates, plugins, apps, e-books, edtech. **Physical goods and manual or human-delivered services (consulting, freelancing, coaching) are not allowed**, nor professional or financial services. If the user sells those, Dodo is the wrong gateway: say so before writing code. VERIFIED https://docs.dodopayments.com/miscellaneous/merchant-acceptance
- India: Indian individuals (PAN) and entities (PAN or GSTIN) can sign up. Buyers in India pay by UPI (QR/intent), RuPay and Indian cards, in INR. Net banking and Indian wallets are not listed. VERIFIED https://docs.dodopayments.com/features/payment-methods/india
- **Payouts are in USD, GBP or EUR only; INR payouts were discontinued.** Dodo's docs do not mention FIRA/FIRC at all: ask Dodo how inward-remittance certificates work for your account before relying on Dodo for export documentation. VERIFIED (payouts), UNVERIFIED (FIRA)
- Dodo ships its **own official MCP server** (npm `dodopayments-mcp`, remote `https://mcp.dodopayments.com/mcp`): two "Code Mode" tools, `search_docs` and `execute` (agent-written TypeScript against the Dodo SDK). Use it for Dodo-only work this adapter does not wrap (products, discounts, licence keys). This project is the cross-gateway interface, with Dodo next to the Indian gateways; **it is not affiliated with Dodo** and is not "the Dodo MCP". VERIFIED https://docs.dodopayments.com/developer-resources/mcp-server

## Auth, hosts, amounts

- Test mode `https://test.dodopayments.com`, live `https://live.dodopayments.com`, paths at the root (no `/v1`). `Authorization: Bearer <key>`, JSON bodies. VERIFIED
- Keys are mode-specific: `dodo_test_…` / `dodo_live_…` (older keys have no prefix and still work). This project: `PAYMENTS_MODE=sandbox` uses test mode and refuses a `dodo_live_` key; `live` refuses `dodo_test_` (`CONFIG_INVALID`). Unprefixed keys cannot be cross-checked. A webhook key that decodes to fewer than 24 bytes is also `CONFIG_INVALID`. Test and live have **separate keys, products and webhooks**. VERIFIED
- Integer smallest currency unit (paise, cents; the currency's own decimals): same as ours. The API has 145 ISO currency codes (Adaptive Currency: 80+ local currencies). INR minimum: the higher of Rs 5 and the equivalent of US$0.50 (US$1.00 for subscriptions). VERIFIED
- **No idempotency header** is documented. This project never retries a Dodo POST: a create or refund that times out or gets a 5xx is `OUTCOME_UNKNOWN`. GETs and the cancel PATCH are retried. PARTIAL (absence)
- Env: `DODO_PAYMENTS_API_KEY` (required), `DODO_PAYMENTS_WEBHOOK_KEY` (`whsec_…`, needed to verify webhooks), `DODO_PAYMENTS_DEFAULT_PRODUCT_ID` (optional).

## Products first (no ad-hoc prices)

Every checkout is for a product created in the Dodo dashboard (Products) or API; `product_cart[].product_id` is required. VERIFIED https://docs.dodopayments.com/api-reference/checkout-sessions/create

- This project charges one product: `providerOptions.productId`, else `DODO_PAYMENTS_DEFAULT_PRODUCT_ID`; with neither, `VALIDATION` (in mock mode too).
- It reads the product (`GET /products/{id}`) before creating the session and refuses (`VALIDATION`, no POST): a recurring or usage-based price, a currency other than `currency`, a product discount (`discount_bps` or the deprecated percent `discount`), purchasing power parity, localized prices (`pricing_mode`), or a fixed price that is not exactly `amount`.
- To charge arbitrary amounts, create one **pay-what-you-want** product: `amount` is sent as `product_cart[].amount` and must be at least its minimum. Dodo requires a PWYW base currency of **USD, GBP or EUR**, so pass `currency` explicitly (the default is INR). INR amounts need a fixed-price INR product per price.
- MoR tax: Dodo may add tax on top of a tax-exclusive price. A payment matches when `total_amount = amount` (tax-inclusive) or `total_amount - tax = amount` (tax-exclusive), in the order currency.
- Discount codes and currency selection default to on in Dodo's checkout; **this project's sessions turn both off** (`feature_flags: {allow_discount_code: false, allow_currency_selection: false}`; `feature_flags` stays refused in `provider_options`). If Adaptive Currency still charges another currency, the payment is a currency mismatch, never paid.

## Checkout flow

1. Server: `POST /checkouts` `{product_cart:[{product_id, quantity:1, amount? (PWYW only)}], customer?, billing_address?, return_url?, feature_flags, metadata:{order_ref, expected_amount, expected_currency}}`. The adapter sets the three binding keys last, so `metadata` cannot override them. Metadata limits (checked locally): 50 keys, keys ≤ 40 chars, string values ≤ 500, values string/number/boolean only. Returns `session_id` (`cks_…`) and `checkout_url`; redirect to it. The `checkout_url` expires after 24 h (`expiresAt`). VERIFIED
2. Unified result: `checkout: {type: "redirect", url, method: "GET"}`, `providerOrderId` = the `cks_` session id. **Store `providerOrderId` next to your orderRef**: verify needs it, and Dodo cannot search by metadata.
3. Dodo redirects to `return_url` with plain query params `payment_id`, `status` (and `email`, `license_key` when present). **Not signed.** VERIFIED https://docs.dodopayments.com/developer-resources/checkout-session
4. Verify server-side: `payments_verify_payment` with `payload` = the query params, `order_ref`, `expected_amount` and **`provider_order_id` (required)**. Without it the result is `valid: false` (mock mode too): anyone can create a Dodo payment carrying your `order_ref`, because static payment links take `metadata_<key>`. The adapter calls `GET /checkouts/{id}` and `GET /payments/{payment_id}` (`verifiedVia: "status_api"`) and ignores the `status` query param. The payment must be that session's own (`checkout_session_id`); then `metadata.order_ref`, the amount (rules above) and the currency (`metadata.expected_currency`) must match. A session with no payment yet is `valid: true`, `status: "created"`.
5. Fulfil on `paid: true` or on a `payment.succeeded` webhook matched to your stored session (below), never on the redirect alone.

Status lookup needs `provider_order_id` (`cks_…`) or `provider_payment_id` (`pay_…`); with only `order_ref` it fails with `VALIDATION` (mock mode enforces the same). It refuses a payment whose `metadata.order_ref` is missing or another order's ("not created by this library"), and reports `unknown` when the currency differs from the order's. A lookup by `provider_payment_id` alone is bound by metadata only: do not fulfil on it.

Not wrapped: static payment links (`checkout.dodopayments.com/buy/{product_id}`, no API needed; `not_implemented`), `confirm: true` sessions and saved payment methods, overlay/inline checkout SDKs.

## Status mapping (IntentStatus)

Dodo documents the names, not the per-value meanings, so unclear values are never `captured`.

| Dodo | Unified |
|---|---|
| no payment on the session yet | `created` |
| `processing`, `requires_customer_action`, `requires_merchant_action`, `requires_payment_method`, `requires_confirmation` | `pending` |
| `requires_capture`, `partially_captured_and_capturable` | `authorized` (NOT paid) |
| `succeeded` | `captured`; `refund_status` `partial` / `full` → `partially_refunded` / `refunded` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |
| `partially_captured`, anything new; any status in another currency than the order's (status lookup, webhooks) | `unknown` |

## Refunds

`POST /refunds {payment_id, items?, currency?, reason?, metadata:{refund_ref, order_ref}}`. VERIFIED https://docs.dodopayments.com/features/transactions/refunds

- Needs `provider_payment_id`. Only payments created through this library are refunded: a missing or different `metadata.order_ref` is `VALIDATION` (refund those from the Dodo dashboard).
- **Full refund**: omit `amount`, or pass the total, or the price Dodo added tax on top of. No items and no `currency` are sent.
- **Partial refund**: one item `{item_id: product_id, amount}` with `currency` = the payment currency (Dodo otherwise reads item amounts in the settlement currency, usually USD). Dodo has no top-level amount, so only one-item carts (what this adapter creates). **Partial refunds of payments where Dodo added tax on top are refused** (`VALIDATION`): refund in full or use the dashboard.
- Refund amounts are reported on the price scale: a full refund of a taxed payment reports the price you charged, so retries and lookups compare like with like.
- **No idempotency key.** Before every POST the adapter looks for a refund on that payment with the same `metadata.refund_ref` and returns it (a different amount = `IDEMPOTENCY_CONFLICT`). Listed refunds carry no metadata, so it fetches each one (at most 25; more is `PROVIDER_ERROR`). After `OUTCOME_UNKNOWN` the client looks it up again by `refund_ref`. The check is per call: two processes refunding the same `refundRef` at the same moment can both reach Dodo (Dodo then allows only one in flight per payment). Run refunds from one place.
- Dodo rules: within **30 days** of payment, the payment must be `succeeded`, **one refund in `pending`/`review` per payment at a time**, cumulative ≤ paid, **your Dodo balance must cover it**, payment fees are not returned. `speed` is ignored.
- Status: `succeeded` → `processed`, `pending`/`review` → `pending`, `failed` → `failed`. Look up with `provider_refund_id`, or `provider_payment_id` + `refund_ref`.

## Webhook signature (Standard Webhooks)

Headers `webhook-id`, `webhook-timestamp` (Unix seconds), `webhook-signature` (space-separated `v1,<base64>` entries; any match is valid, which covers secret rotation). Key = base64-decode of the secret without `whsec_`. Signature = base64 HMAC-SHA256(key, `{id}.{timestamp}.{rawBody}`). 5-minute tolerance. VERIFIED https://docs.dodopayments.com/developer-resources/webhooks. This project's tests check the implementation against the Standard Webhooks reference vector and against the official `standardwebhooks` library (which Dodo's SDK uses) in both directions.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
export function verifyDodoWebhook(rawBody: string, h: Record<string, string | undefined>, secret: string, toleranceSec = 300) {
  const id = h['webhook-id'], ts = h['webhook-timestamp'], sig = h['webhook-signature'];
  if (!id || !ts || !/^\d+$/.test(ts) || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) return false;
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = Buffer.from(createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64'));
  return sig.split(' ').some((e) => e.startsWith('v1,') && Buffer.from(e.slice(3)).length === expected.length && timingSafeEqual(Buffer.from(e.slice(3)), expected));
}
```

Dedupe on `webhook-id`. Dodo makes up to 8 delivery attempts over about a day, and events can arrive **out of order**: order by the body `timestamp`.

Events mapped: `payment.succeeded`, `payment.failed`, `payment.cancelled` (→ `payment.failed`), `payment.processing` (→ `payment.pending`), `refund.succeeded` / `refund.failed`, `subscription.active` / `renewed` / `on_hold` / `past_due` / `failed` / `cancelled` / `expired`, `dispute.opened`, `payout.success`; anything else is `unknown`. There is no `refund.pending` event. Payment events report the matched price as `amount`, and `status: "unknown"` when `data.currency` differs from `metadata.expected_currency`. The signature proves Dodo sent the event, not that the payment is yours: **ignore payment events whose `providerOrderId` (the `checkout_session_id`) or `currency` differ from your stored attempt.** The generated integration does this for Dodo.

## Subscriptions

- Checkout Session for a product with a **recurring price**: `providerPlanId` = that product id, required in every mode (mock too). Plans cannot be created from `plan`; a one-time product is refused. Discount codes and currency selection are off on these sessions too. VERIFIED https://docs.dodopayments.com/developer-resources/subscription-integration-guide
- `providerSubscriptionId` is the `cks_` session id until the customer subscribes; the real `sub_…` id arrives as `subscription_id` on the return URL and in the `subscription.active` webhook. Store it: cancelling a `cks_` id is refused.
- Cancel: `PATCH /subscriptions/{id}` with `status: cancelled` (now) or `cancel_at_next_billing_date: true` (`at_cycle_end`).
- India (RBI e-mandate): UPI, RuPay and Indian cards. UPI shows only for billing country IN, currency INR and `upi_intent` allowed. Every renewal has a 48-hour pre-debit delay: `payment.succeeded` arrives about **48-51 h after the renewal date**, so grant access on the webhook. For Indian-card e-mandates the default mandate ceiling is **Rs 15,000** (`mandate_min_amount_inr_paise`, refused in `provider_options` here; not UPI AutoPay); an upgrade above it needs re-authorisation. A mandate cancelled in the bank app puts the subscription `on_hold`. VERIFIED https://docs.dodopayments.com/features/payment-methods/india

## Customers, settlements

- Customers: `POST /customers` (name and email required).
- Settlements: mapped to `GET /payouts` with `page_size` = `count` (max 100) and `page_number=0` (USD/GBP/EUR payouts of your Dodo balance, net of fees; `settledAt` only when `success`). A bad `from`/`to` date is `VALIDATION`. Default cycle twice a month; a minimum payout threshold applies. Payouts to third parties: `unsupported`.

`provider_options` may not set `product_cart`, `customer`, `billing_currency`, `billing_address`, `confirm`, `payment_method_id`, `discount_codes`, `discount_code`, `subscription_data`, `feature_flags`, `return_url`, `cancel_url`, `custom_fields`, `customization`, `product_collection_id` or `tax_id` (subscriptions also `mandate_min_amount_inr_paise`). Pass `productId` and harmless fields such as `allowed_payment_method_types` there; pass `return_url` and the billing address through the normal arguments.

## Test mode data (VERIFIED on the India page, 2026-10-29; re-check before use)

- UPI `success@upi` / `failure@upi`. Indian cards: Visa `4576238912771450` (success), `4706131211212123` (decline); Mastercard `5409162669381034` (success), `5105105105105100` (decline); expiry 06/32, CVV 123.
- Create the product and the webhook endpoint in Test Mode; recreate both in Live Mode before go-live.

## Platforms

- Shopify: no Dodo Shopify payments app found; the code generator emits no Shopify reconcile server for Dodo. WooCommerce/WordPress plugins were not researched.
