# Stripe (India)

Status labels: VERIFIED / PARTIAL / UNVERIFIED.

## Availability: read this first

- **"Stripe services are invite only in India."** Indian businesses must request an invite and cannot self-sign-up. Stripe supports "a select number of businesses, with a focus on international expansion". Third-party sources date this to May 2024; still in force late 2026. Existing accounts continue to work. VERIFIED https://support.stripe.com/questions/india-faq
- Registered Indian business only (sole prop / LLP / company); no individuals. PARTIAL https://stripe.com/docs/india-exports
- Treat Stripe as an **international / exports** gateway, not the domestic-India default. If the user has no existing Stripe India account, recommend a domestic gateway and say why.
- Shopify Payments (built on Stripe) is not available to India-based stores.
- **Payment methods on an Indian Stripe account: cards.** UPI is not offered to India-domiciled accounts (IN is absent from the UPI "Business locations" list); it is for Stripe accounts outside India charging Indian customers. VERIFIED https://docs.stripe.com/payments/upi

## Auth, amounts

- `https://api.stripe.com/v1`, `Authorization: Bearer sk_test_…|sk_live_…`, form-encoded bodies. Test vs live by key prefix. VERIFIED
- Integer minor units (paise for INR). VERIFIED
- Use the `Idempotency-Key` header on every POST (Stripe-native idempotency; max 255 chars, expires after 24 h). Stripe replays the saved response for a reused key, including a 500: after a 5xx, check status before re-submitting with a new key. `client_reference_id` max 200 chars.
- Pin `Stripe-Version`. From API `2026-09-30.endive`, failed India mandates come back as `inactive` with `inactive_reason`. VERIFIED

## Exports

135+ presentment currencies on Visa/Mastercard; INR/USD on Amex. Non-INR needs extra onboarding info and transactions must be declared as exports (purpose codes, FIRC). PARTIAL. Each export charge needs a description of the goods/services and the customer's name and billing address: this project sends `payment_intent_data.description` and sets `billing_address_collection=required` on Checkout; for the PaymentIntent flow pass billing details into `stripe.confirmPayment`.

## Checkout flow

Option A, Checkout Session (simplest):
1. Server: `POST /v1/checkout/sessions` `{mode:"payment", line_items or price_data with server-computed unit_amount, success_url, cancel_url, client_reference_id: attemptRef, metadata:{attemptRef}}`. Redirect to `session.url`.
2. Never fulfil on `success_url`. Fulfil on webhook `checkout.session.completed` with `payment_status == "paid"` (and `checkout.session.async_payment_succeeded` for delayed methods).

Option B, PaymentIntent + Payment Element:
1. Server: `POST /v1/payment_intents` `{amount, currency, automatic_payment_methods[enabled]=true, metadata[attemptRef]}` → return `client_secret` only.
2. Client: Stripe.js `confirmPayment`. Fulfil on `payment_intent.succeeded` webhook.

## Webhook signature

`Stripe-Signature: t=<ts>,v1=<hex>[,v1=…][,v0=…]`. `expected = hex(HMAC_SHA256(t + "." + rawBody, whsec_secret))`. Compare against **every** `v1` (several during secret rolling), ignore other schemes, enforce a tolerance (libraries default 300 s; never disable). VERIFIED https://docs.stripe.com/webhooks?verify=verify-manually

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
export function verifyStripeWebhook(rawBody: string, header: string, whsec: string, toleranceSec = 300) {
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = parts.find(([k]) => k === 't')?.[1];
  const v1s = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || v1s.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = Buffer.from(createHmac('sha256', whsec).update(`${t}.${rawBody}`).digest('hex'));
  return v1s.some((v) => v.length === expected.length && timingSafeEqual(Buffer.from(v), expected));
}
```

Prefer the official `stripe` library's `stripe.webhooks.constructEvent(rawBody, sig, whsec)` when available. Dedupe on `event.id`.

Refund events: `charge.refunded` fires when a refund is created (it may still be pending, and `amount_refunded` is cumulative), so this project reports it as type `unknown`. Subscribe to `refund.created`, `refund.updated` and `refund.failed` (a refund can be created already `succeeded`, with no later `refund.updated`). `refund.updated` counts only when its status changed. Refund events dedupe on `refund:<re_id>:<status>`.

Refunding an uncaptured PaymentIntent (`requires_capture`) cancels it instead (full amount only, no `re_` id). Physical-goods exports also need a shipping address: pass `providerOptions.shipping_address_collection` on Checkout.

## Status mapping (PaymentIntent)

| Stripe | Unified |
|---|---|
| `requires_payment_method` / `requires_confirmation` / `requires_action` | `created` |
| `processing` | `pending` (India recurring card debits sit here ~26h) |
| `requires_capture` | `authorized` (NOT paid in this project; the authorisation lapses after about 7 days unless captured) |
| `succeeded` | `captured` |
| `canceled` | `cancelled` |
| charge `refunded` / `amount_refunded > 0` | `refunded` / `partially_refunded` |

Refunds: `POST /v1/refunds {payment_intent, amount?}`; status `pending|succeeded|failed|canceled|requires_action`.

This project: a fully refunded payment is `refunded` and never `paid`, so replaying a `success_url` after a refund does not re-fulfil. `providerOptions` may not set `capture_method`, `transfer_data`, `on_behalf_of`, `application_fee_amount`, `transfer_group`, `metadata`, `confirm`, `customer`, `payment_method`, `off_session`, `discounts` or the Checkout URLs/line items (subscriptions: also `subscription_data`); pass metadata through `metadata`, where `order_ref` cannot be overridden.

## RBI e-mandate rules for recurring (VERIFIED https://docs.stripe.com/india-recurring-payments)

- Off-session Indian card (and UPI, on non-India accounts) payments need an e-mandate registered with AFA (3DS / UPI PIN).
- Pre-debit notification ≥24h before each debit; Stripe delays card charges 26h (PaymentIntent in `processing`).
- Each charge **> Rs 15,000 needs AFA**; UPI recurring > Rs 15,000 unsupported.
- Mandates cannot be updated or cancelled via the API.

## Sandbox test data (UNVERIFIED in this research)

- Test cards at https://docs.stripe.com/testing (`4242 4242 4242 4242` generic; India-specific cards and 3DS cards listed there). Use `stripe listen --forward-to localhost:3000/webhooks/stripe` (Stripe CLI) for local webhooks.

## Platforms

- Shopify (India store): not usable. WooCommerce: official "WooCommerce Stripe Payment Gateway" plugin, subject to the same invite-only account restriction.
