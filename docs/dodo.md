# Dodo Payments

[Dodo Payments](https://dodopayments.com) is a **Merchant of Record (MoR)** for digital products: Dodo is the legal seller, so it calculates, collects and remits VAT, GST and US sales tax for every sale, in 220+ countries. Indian buyers can pay with UPI, RuPay and Indian cards. You receive net payouts in USD, GBP or EUR.

Every fact below comes from Dodo's official docs and per-endpoint OpenAPI blocks (spec 1.120.26). Each one is listed with its source in [research/dodo-api-facts.md](research/dodo-api-facts.md). **Nothing here has been run against Dodo's real test mode yet**; see [Before you go live](#before-you-go-live).

## Is Dodo right for you?

| Yes | No |
|---|---|
| SaaS, AI tools, apps, plugins, templates, e-books, courses (digital, self-serve) | Physical goods |
| Selling worldwide without registering for tax in each country | Human-delivered services: consulting, freelancing, coaching |
| Indian buyers via UPI/RuPay plus international cards | INR payouts (discontinued; payouts are USD, GBP or EUR) |

For an Indian business selling physical goods or services to Indian customers, use Razorpay, Cashfree, PayU, PhonePe, Paytm or CCAvenue. For invoices to overseas clients, use Skydo or Infinity.

## How it works here

```text
your server                                   Dodo                                   customer
-----------                                   ----                                   --------
payments_create_payment ──► GET /products/{id}   (price must equal amount, or PWYW)
  provider=dodo, productId  POST /checkouts       (metadata: order_ref, expected_amount)
                        ◄── checkout { type: redirect, url: checkout_url }  ───────────► pays on Dodo's hosted page
                                                                                         ◄── back to return_url?payment_id=…&status=…  (unsigned)
payments_verify_payment ──► GET /payments/{payment_id}   (bound to order_ref + amount)
webhook payment.succeeded ◄── Standard Webhooks signature  (authoritative)
```

- **Checkout:** a hosted redirect (`checkout.type = "redirect"`). The link works once and expires after 24 hours.
- **The return is unsigned.** Dodo appends `payment_id` and `status` to `return_url` and signs nothing. `verifyPayment` ignores the `status` in the URL and re-reads the payment server-side. It **requires `providerOrderId`**, the `cks_...` session id `createPayment` returned, and is `valid` only when:
  - the payment belongs to that checkout session;
  - `metadata.order_ref` is your order;
  - the amount and the currency match.
- **Why the session, not just the order id:** anyone can create a Dodo payment carrying your `order_ref`, because static payment links accept `metadata_<key>` parameters. The checkout session is the one thing only your server created. The generated code passes the stored session id to `verifyPayment`, and its webhook handler ignores events whose session or currency differ from the stored order.
- **Webhooks** use [Standard Webhooks](https://www.standardwebhooks.com) and are authoritative (`bodyAuthenticated: true`). The verifier is tested against the specification's reference test vector, and against the official `standardwebhooks` library that Dodo's own SDK uses, in both directions.

## Products first

Dodo has **no ad-hoc prices**: every payment is for a product you created in Dodo. `payments_create_payment` takes the product from `provider_options.productId`, or else from `DODO_PAYMENTS_DEFAULT_PRODUCT_ID`, and reads it before creating the session:

| Product price | What happens |
|---|---|
| Fixed, one-time, same currency, `price == amount` | Session created |
| Fixed but a different price or currency, a product discount, purchasing power parity, or localized (per-currency or per-country) prices | `VALIDATION`, before anything is created |
| Pay-what-you-want (PWYW) | `amount` is sent as the price (it must be at least the product minimum). Dodo requires PWYW products to be priced in USD, GBP or EUR |
| Recurring | `VALIDATION` (use `payments_create_subscription`) |

To charge any amount in USD, GBP or EUR, create one PWYW product and set it as the default. INR amounts need one fixed-price INR product per price.

## Tax, discounts and currency

As Merchant of Record, Dodo may add tax on top of a tax-exclusive price. The adapter treats a payment as matching when `total_amount == amount` (tax-inclusive) or `total_amount - tax == amount` (tax-exclusive). It reports `amount` as your price in both cases, so your order amount comparison keeps working. The same rule is applied to status lookups and webhooks, using the `expected_amount` it stored in the session metadata.

Dodo turns discount codes and currency selection **on** by default, and both change what the customer pays. Every session this adapter creates turns them off (`feature_flags`). If Adaptive Currency on your account still charges another currency, the payment is reported as a currency mismatch and **never as paid**: `verifyPayment` returns `valid: false`, and status lookups and webhooks report `status: unknown`.

## Setup

1. Check your product is allowed: digital, and self-serve.
2. Switch the dashboard to **Test Mode**. Under **Developer > API Keys**, create a key (`dodo_test_...`) and set it as `DODO_PAYMENTS_API_KEY`.
3. Under **Products**, create what you sell: a fixed price, or one PWYW product. Set `DODO_PAYMENTS_DEFAULT_PRODUCT_ID`, or pass `productId` per payment.
4. Under **Developer > Webhooks**, add your endpoint (for example `https://your-domain/api/payments/webhook`) with these events:
   - `payment.succeeded`, `payment.failed`, `payment.processing`, `payment.cancelled`;
   - `refund.succeeded`, `refund.failed`;
   - the `subscription.*` events if you sell subscriptions.

   Copy the secret (`whsec_...`) into `DODO_PAYMENTS_WEBHOOK_KEY`.
5. Run with `PAYMENTS_MODE=sandbox` (Dodo test mode, `test.dodopayments.com`). A webhook key too short to be a real secret is refused. The adapter refuses a `dodo_live_` key in sandbox mode and a `dodo_test_` key in live mode. Older keys without a prefix are accepted.

```bash
DODO_PAYMENTS_API_KEY=dodo_test_...
DODO_PAYMENTS_WEBHOOK_KEY=whsec_...
DODO_PAYMENTS_DEFAULT_PRODUCT_ID=pdt_...
```

Test payments use UPI `success@upi` / `failure@upi`, or the Indian test cards on Dodo's India page. Visa `4576238912771450` succeeds and `4706131211212123` declines; use expiry 06/32 and CVV 123.

## Status, refunds and retries

- **Status:** Dodo cannot search by your order id or metadata. Store `providerOrderId` (the `cks_...` session id) from `createPayment`. `getPaymentStatus` needs it, or the payment id (`providerPaymentId`). By payment id alone, the result is bound only by metadata, so never fulfil on it: use `verifyPayment` with the session. Payments not created through this library (with no `order_ref`) are refused.
- **No idempotency key:** Dodo's API documents none. A create or refund whose response is lost (timeout or 5xx) is reported as `OUTCOME_UNKNOWN` and is never retried automatically. Look it up before trying again.
- **Refunds:** pass `provider_payment_id` (from `verifyPayment`, `getPaymentStatus` or the webhook).
  - Before creating a refund, the adapter checks the payment's existing refunds for one with the same `refund_ref` and returns it if found, so a retry never refunds twice.
  - Full refunds send no items. Partial refunds are one item of the single-product cart, in the payment's currency (Dodo otherwise assumes the settlement currency, usually USD).
  - Where Dodo added tax on top, refunding your price counts as a full refund and is reported as your price. Partial refunds of such payments are refused, because Dodo's item amounts include tax while ours don't; make those in the dashboard.
  - Only payments created through this library are refunded here.
  - The refund lookup runs per call: two processes refunding the same `refund_ref` at the same moment can both reach Dodo. Run refunds from one place.
  - Dodo's rules: refunds within 30 days, one refund in `pending`/`review` per payment at a time, and your Dodo balance must cover it. Payment fees are not returned.
- **Subscriptions:** create a recurring-price product in Dodo and pass its id as `provider_plan_id`. `providerSubscriptionId` is the `cks_...` session until the customer completes checkout. The real subscription id arrives on the return URL (`subscription_id`) and on the `subscription.active` webhook. Cancel with `payments_cancel_subscription`, either immediately or at the period end.
- **Settlements:** `payments_list_settlements` lists your Dodo payouts (USD, GBP or EUR, net of fees).

## India notes

- **UPI** appears only for billing country `IN`, currency `INR`, with `upi_intent` allowed. Pass `provider_options.allowed_payment_method_types: ["upi_intent", "credit", "debit"]`.
- **RBI e-mandates:** subscription renewals are charged 48 to 51 hours after the renewal date. Grant access on the `payment.succeeded` webhook, not on the date. The default mandate ceiling is ₹15,000.
- **Payouts and FIRA:** payouts go to a local or SWIFT account in USD, GBP or EUR. Dodo's docs do not mention FIRA/FIRC (inward remittance certificates), so ask Dodo how they work for your account before relying on them for export compliance.
- **KYC and GST:** Indian individuals need a PAN, and businesses a business PAN or GSTIN. Dodo applies GST for Indian merchants based on the customer's location.

## Generated code

`payments_generate_integration` with `provider: "dodo"` produces the standard redirect integration (the same shape as Stripe Checkout):

- a create route (the amount comes from your server);
- a callback route that verifies `payment_id` server-side;
- a raw-body webhook route;
- optional refunds;
- a test checklist.

Set `DODO_PAYMENTS_DEFAULT_PRODUCT_ID` (or pass `productId`), and make sure `getOrderAmount()` returns exactly the product price. All framework variants compile against real Express, Fastify and Next.js types. That check was run during development and is not part of `npm test`.

## Dodo's own MCP server

Dodo ships an official MCP server (`npx -y dodopayments-mcp`, or `https://mcp.dodopayments.com/mcp`). It has two tools: `search_docs`, and `execute`, which runs TypeScript against Dodo's SDK. Use it for anything Dodo-specific, such as licence keys, usage billing or discounts.

This project is not affiliated with Dodo. Its Dodo adapter is the cross-gateway interface: the same `payments_*` tools, money-safety rules and generated code as the Indian gateways.

## Before you go live

- [ ] One full test-mode payment: create, pay with `success@upi`, verify, check the webhook arrives and is verified.
- [ ] One failed payment (`failure@upi`) and one refund, then confirm `getRefundStatus`.
- [ ] Complete Dodo's verification (KYC, bank and business checks). Live payouts need all of it.
- [ ] Recreate the product and webhook in **Live Mode** (test and live are separate), and switch to a `dodo_live_` key with `PAYMENTS_MODE=live`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `charges for a product you created in Dodo` | No `productId` and no `DODO_PAYMENTS_DEFAULT_PRODUCT_ID` |
| `costs 99900 INR (minor units), not 149900` | The fixed product price differs from `amount`. Use the right product, or a PWYW product |
| `priced in USD, not INR` | The product currency differs from the order currency |
| `Amount mismatch` / `Currency mismatch` on a paid order | Adaptive Currency on your account, or a dashboard-side discount, changed the total. Reconcile by hand |
| `Pass providerOrderId` from `verifyPayment` | Pass the `cks_...` session id you stored at `createPayment` |
| `belongs to order (none: not created by this library)` | The payment came from a static link or the dashboard. Handle it in the Dodo dashboard |
| `cannot search by orderRef` | Pass `providerOrderId` (`cks_...`) or `providerPaymentId` |
| `OUTCOME_UNKNOWN` | Dodo's response was lost. Check the dashboard or `getPaymentStatus` before retrying |
| `dodo_live_ key with PAYMENTS_MODE=sandbox` | Use a test-mode key in sandbox |
| `401` from Dodo | The key belongs to the other mode, or was revoked |
