# Platform notes

## Shopify (be honest with the user)

- **Shopify Payments is not available to India-based stores.** Indian merchants use third-party providers added under Settings → Payments; Shopify charges an extra transaction fee for third-party providers that varies by plan.
- **You cannot build a Shopify checkout gateway for a merchant.** "Only approved Partners can build payments extensions on Shopify's Payments Platform." Custom payment extensions are "limited to eligible Shopify Plus Merchants only". VERIFIED https://shopify.dev/docs/apps/build/payments
- So for "add Razorpay/PayU/PhonePe to my Shopify store" the correct answer is **install the gateway's official app, no code**:

| Gateway | Shopify | |
|---|---|---|
| Razorpay | Official app "All-in-one Razorpay Payment Gateway". Connect as account owner, no API keys. Pre-28-Apr-2022 integrations must migrate | VERIFIED |
| PayU | "1PayU (Cards, UPI, NB, Wallet)" https://apps.shopify.com/payu-india + "Onsite Card Payments by PayU India"; merchant key + salt | VERIFIED |
| PhonePe | "PhonePe Payment Gateway" https://apps.shopify.com/phonepe-payment-gateway; Settings → Payments → "PhonePe PG" | VERIFIED |
| Cashfree | Advertises a no-code Shopify plugin | PARTIAL |
| CCAvenue | Historically listed in admin; current listing unconfirmed | UNVERIFIED |
| Paytm | No official app found | UNVERIFIED |
| Stripe | Not usable for India stores | PARTIAL |
| Skydo | None | VERIFIED-ABSENT |

What code *can* do alongside Shopify: a custom app or backend that reads orders (Admin API) and the gateway's API for reconciliation, refund reporting, or sending payment links for draft/B2B orders. Refunds should normally be issued **from Shopify admin** so Shopify's order state stays correct; refunding directly in the gateway desynchronises Shopify.

## WooCommerce / WordPress

- Prefer the official plugin: Razorpay `woo-razorpay`, PhonePe `phonepe-payment-solutions`, PayU, Cashfree, Paytm, CCAvenue all publish plugins (listing names for the last four UNVERIFIED). Stripe: "WooCommerce Stripe Payment Gateway" (invite-only account problem still applies).
- Custom gateway only if no plugin fits: extend `WC_Payment_Gateway`, implement `process_payment()` (create gateway order server-side, return redirect), register a callback via `woocommerce_api_<id>` (`/?wc-api=<id>`), and call `$order->payment_complete($transaction_id)` only after signature/status verification. Read the raw webhook body with `file_get_contents('php://input')`.
- Use `$order->get_total()` server-side for the amount; convert to paise with `(int) round($total * 100)` only once, or better `wc_format_decimal` + string math.
- Store secrets in plugin settings (DB) or `wp-config.php` constants, never in theme JS. HPOS (custom order tables) is the default in recent WooCommerce: use `wc_get_order()` / order meta APIs, not `postmeta` directly.
- Plain WordPress (no Woo): payment forms plugins (WPForms, Gravity Forms) have Razorpay/PayU add-ons; or a small custom plugin with a REST route following the same rules.

## Next.js (App Router)

- Create-order and verify in Route Handlers (`app/api/payments/.../route.ts`) or Server Actions. Secrets in server env only; never `NEXT_PUBLIC_*` for a secret. The publishable key (Razorpay key_id) may be `NEXT_PUBLIC_`.
- Webhook raw body: `const raw = await req.text();` before any `req.json()`. Set `export const runtime = 'nodejs'` (node:crypto) and `export const dynamic = 'force-dynamic'`.
- Pages Router: `export const config = { api: { bodyParser: false } }` and read the stream.
- Middleware/auth must not block the webhook and the gateway POST-back routes (PayU surl/furl, CCAvenue redirect, Paytm callback); they also need CSRF exemption.
- Vercel/serverless: CCAvenue needs a static egress IP (not available by default). Webhook handlers must finish within the function timeout; push work to a queue.

## Express / Fastify / NestJS

- Express: mount `express.raw({ type: '*/*' })` on the webhook route **before** `express.json()` is applied globally, or use `express.json({ verify: (req, _res, buf) => { req.rawBody = buf } })`.
- Fastify: `addContentTypeParser('application/json', { parseAs: 'string' }, ...)` scoped to the webhook route, or `fastify-raw-body`.
- NestJS: `NestFactory.create(AppModule, { rawBody: true })` then `req.rawBody`.
- Form-POST gateways: `express.urlencoded({ extended: false })` on surl/furl/callback routes.

## Django / DRF

- Raw body: `request.body` (bytes) before touching `request.data`. Decorate gateway POST-back views and webhooks with `@csrf_exempt` (only those). Use `hmac.compare_digest`.
- Amounts: `DecimalField` is acceptable for display, but store `amount_paise = models.BigIntegerField()` for payment logic.
- Status transitions: `PaymentAttempt.objects.filter(attempt_ref=ref, status__in=[...]).update(status='captured')` returns the row count: fulfil only when it's 1. Wrap in `transaction.atomic()`; use `transaction.on_commit` to enqueue fulfilment (Celery).

## Laravel

- Raw body: `$request->getContent()`. Exclude webhook and POST-back routes from `VerifyCsrfToken` (`$except`, or `validateCsrfTokens(except: [...])` in Laravel 11+ bootstrap). Use `hash_equals`.
- Conditional update: `PaymentAttempt::where('attempt_ref', $ref)->whereIn('status', [...])->update([...])` returns affected rows. Queue fulfilment with `afterCommit()`.
- Official PHP SDKs exist for Razorpay (`razorpay/razorpay`) and Cashfree; verify package names on Packagist.

## React Native / Expo

- The app never holds a secret. Flow: app → your API (create attempt, returns order id/session) → gateway SDK in app → SDK result → your API verifies → app shows status from your API.
- Razorpay: `react-native-razorpay` (native module: needs a dev build / prebuild with Expo, not Expo Go). Cashfree, PhonePe, Paytm have RN SDKs or can use a WebView/redirect; check each gateway's docs (UNVERIFIED package names except Razorpay).
- UPI intent returns are unreliable on Android (app killed, user switches back manually). Always resolve via your server status endpoint and webhook, not the SDK callback alone.
- `EXPO_PUBLIC_*` env vars are embedded in the bundle: publishable values only.

## Flutter

- `razorpay_flutter` for Razorpay; Cashfree/PhonePe/Paytm publish Flutter plugins (verify on pub.dev). Same server-first flow as React Native.
- Do not use `--dart-define` for secrets; they are recoverable from the binary.

## Native Android / iOS

- Use the gateway's official SDK (Razorpay, PhonePe Standard Checkout, Cashfree, Paytm All-in-One). The server creates the order and verifies.
- Android 11+: declaring UPI app intents needs `<queries>` entries for `upi://pay` in the manifest so the SDK can find UPI apps.
- iOS: add UPI app URL schemes (`phonepe`, `tez`, `paytmmp`, `bhim`, …) to `LSApplicationQueriesSchemes` if the SDK asks for them.
- App Store / Play rules: physical goods and services can use these gateways; **digital goods consumed in-app must use Apple IAP / Google Play Billing** (with regional alternative-billing exceptions). Check before building.

## Mobile app backends generally

Treat the mobile client like an untrusted browser: amount from server, verification on server, webhook as truth, idempotent create (the user will double-tap).
