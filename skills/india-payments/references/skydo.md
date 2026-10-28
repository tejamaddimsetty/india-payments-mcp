# Skydo

## The short version

**Skydo has no public developer API.** No API docs, developer portal, webhooks or SDK found on skydo.com as of 2026-10-28. VERIFIED-ABSENT. Do not write code that calls a Skydo API; do not invent endpoints. If a user asks for a "Skydo integration", tell them this plainly.

Skydo's "single API integration" marketing refers to its bank-side Banking Circle partnership, not a customer API. A consultancy page claims webhooks/API reports; there is no official source. A third-party review calls Skydo a weak fit for SaaS needing developer APIs or custom checkout.

## What Skydo is for

Indian exporters, freelancers and agencies collecting **foreign** payments (USD, GBP, EUR, CAD, AUD and more) with lower FX fees, FIRA, and GST-compliant invoicing. Not domestic INR checkout.

## Integration options that exist (PARTIAL: https://www.skydo.com/ , https://skydo.com/blog/skydo-feature-update-zoho-integration , https://www.skydo.com/faqs/dashboard?q=faq-14)

- Dashboard payment links ("InstaLinks") the merchant creates by hand and sends to the client.
- "Global Bank Account" local receiving details (virtual accounts in US/UK/EU/CA/AU and more) for bank transfers.
- GST-compliant invoices with FIRA.
- Native Zoho Books integration: invoice sync, auto mark-paid.
- No Zapier, QuickBooks or Xero integration found.

## What to build in an app

1. Model a Skydo payment as `manual`: store an order with status `created`, a human-entered payment-link URL, and expected amount/currency.
2. Show the customer the link or the bank details.
3. Mark it paid **manually** (admin action with audit log) after the merchant sees the credit in the Skydo dashboard, or let Zoho Books be the source of truth if they use it.
4. No webhooks, no signature verification, no status API: there is nothing to verify programmatically. Say so in the UI ("payment confirmed manually").

In this MCP server every `skydo` feature is `unsupported` (including `createPayment`, which throws UNSUPPORTED with instructions to use InstaLinks or Global Bank Account details); its checkout type is `manual`. That is correct, not a gap.

## Alternatives if they need an API for foreign collections

Razorpay (international cards, if enabled), Stripe (invite-only in India, exports focus), PayU/CCAvenue (multi-currency on request). Each requires the merchant to enable international payments and handle export documentation.

## Platforms

Shopify / WooCommerce: none. VERIFIED-ABSENT
