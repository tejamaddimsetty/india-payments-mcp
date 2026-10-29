---
name: india-payments
description: Build, fix or review payment code for Indian gateways (Razorpay, PayU, Cashfree, CCAvenue, Paytm, PhonePe, Stripe India, Skydo, Infinity). Use whenever the task involves adding payments or checkout, UPI, cards or netbanking, payment callbacks or signature verification, webhooks, refunds, subscriptions or UPI Autopay/e-mandates, settlements or reconciliation, or choosing a gateway for an Indian business, in a web app, mobile app backend, Shopify or WooCommerce store. Works with the india-payments-mcp server when it is connected, and standalone from the bundled references when it is not.
---

# India payments

You are building a payment module that moves real money. Correctness beats speed. Follow this procedure in order. Do not skip the rules in section E because the code "looks fine".

Reference files (load only what you need):

| File | When |
|---|---|
| `references/<gateway>.md` (`razorpay`, `payu`, `cashfree`, `ccavenue`, `paytm`, `phonepe`, `stripe`, `skydo`, `infinity`) | Always, for the chosen gateway |
| `references/payment-module-architecture.md` | Any app that stores orders: tables, state machine, reconciliation |
| `references/platforms.md` | Shopify, WooCommerce, WordPress, mobile (RN/Flutter/native), Next.js, Django, Laravel |

## A. Detect the stack

Read before writing. Determine:

1. Server language and framework (Express, Fastify, Next.js route handlers, NestJS, Django, Flask/FastAPI, Laravel, Rails, Go, Spring). Look at `package.json`, `requirements.txt`/`pyproject.toml`, `composer.json`, `Gemfile`, `go.mod`, `pom.xml`/`build.gradle`.
2. Client: web SPA, server-rendered pages, React Native, Flutter, native Android/iOS. Mobile apps still need a server: no gateway secret ever ships in an app binary.
3. Persistence: ORM and DB (Prisma, Drizzle, TypeORM, Sequelize, Django ORM, Eloquent, SQLAlchemy). The payment tables go through the same migration tool the project already uses.
4. Hosted commerce platform (Shopify, WooCommerce, Wix). If Shopify: stop and read `references/platforms.md` first. You cannot write a Shopify checkout gateway; the merchant installs the gateway's official app.
5. Whether the request body is available raw in the webhook route (body-parser order, Next.js `req.text()`, Django `request.body`). This decides how the webhook handler is written.
6. Existing payment code. If there is one, you are fixing or extending it. Audit it against section E before adding anything.

## B. Pick the gateway

- If the user named a gateway, use it. Do not argue unless it cannot do what they need (then say so, with the reason).
- If not, ask one question: "Which gateway do you have (or want) a merchant account with?" Gateway choice depends on KYC, pricing and existing contracts, which you cannot see.
- If they want a recommendation, call `payments_recommend_gateway` with their needs ordered by importance (`subscriptions`, `international`, `upi`, `refunds`, `settlements`, `shopify`, `woocommerce`, `mobile_sdk`, `webhooks`, `exporter_collections`, `fast_integration`). Present the top two with blockers. Without the MCP server, use the table below.

| Need | Sensible default | Notes |
|---|---|---|
| Fastest, most complete API, subscriptions | Razorpay | Paise, JS modal, signed callback, mature webhooks |
| UPI-heavy consumer app | PhonePe or Razorpay | PhonePe redirect is unsigned: always status-check |
| Cheap domestic, good refunds/payouts | Cashfree | Rupee amounts, domain whitelist for JS checkout |
| Enterprise / legacy bank relationship | PayU or CCAvenue | Form-POST hosted pages, hash/AES, more ops friction |
| Paytm wallet users | Paytm | Hosts moved to paytmpayments.com |
| Exports / foreign customers (registered business) | Stripe | Invite-only in India since 2024; do not plan on it without an existing account |
| Freelancer/exporter collecting USD/EUR from abroad | Skydo | No API. Invoices via its Zoho Books integration, or bank-transfer details + a receipts ledger. No INR, min USD 50 |
| Same, if the merchant uses Infinity (infinityapp.in) | Infinity | No API. Zoho Books bridge (sync not publicly documented: confirm with a first invoice), or receiving-account details and/or a QuickLink + a receipts ledger. No INR, flat 0.5% fee |

## C. Read the capability map and surface constraints

Call `payments_get_capabilities` for the gateway. Read every `constraints` entry and every feature whose `support` is not `supported`. Tell the user, before writing code, anything that changes their plan, for example:

- `unsupported`: the gateway does not offer it. Do not build around it with hacks.
- `not_implemented`: the gateway offers it but this MCP server does not wrap it. You may write a direct API call from the reference file; say that you did.
- `partial`: read `notes`. PhonePe webhooks, for example, do not sign the body.
- Required env vars (`credentials`), amount format, min amount, orderRef length limits (PayU txnid 25, PayU refund id 23, Cashfree refund id 3-40 of letters/digits/_/-), IP whitelisting (CCAvenue), which CCAvenue kit (`CCAVENUE_ENCRYPTION` cbc/gcm), domain whitelisting (Cashfree), invite-only and cards-only (Stripe India), no API (Skydo: Zoho Books bridge or ledger mode, see `references/skydo.md`; Infinity: Zoho Books bridge, bank transfer or QuickLink + ledger, see `references/infinity.md`).

Without the MCP server: take the same facts from `references/<gateway>.md`.

Never claim a feature works because it "probably" exists. If the capability map or the reference does not say it is supported, it is not.

## D. Generate and adapt the integration

Call `payments_generate_integration` with `provider`, `framework` and `features` (`checkout`, `webhooks`, `refunds`, `subscriptions`; default checkout + webhooks). It returns files with paths and contents. Then:

1. Map the paths into the repo's structure and conventions (router style, module layout, error handling, logger, validation library). Do not drop a parallel mini-app into the project.
2. Replace any in-memory order store with the project's DB, using the schema in `references/payment-module-architecture.md` (orders, payment_attempts, refunds, webhook_events). In-memory stores are for demos only.
3. Put new env vars in `.env.example` with empty values and a comment. Never write real secrets to any file in the repo.
4. Wire the client checkout into the existing UI. The client receives only publishable values (key id, session id, redirect URL, form fields).
5. Re-check the generated code against section E. Generated code is a starting point, not a proof.

If you are integrating the gateway directly (another language, or no MCP server), write the adapter from `references/<gateway>.md`, keeping it behind one module so the rest of the app never sees gateway specifics.

If the project is Node/TypeScript, the `india-payments-mcp` npm package can be used as a library instead of hand-written gateway calls:

```ts
import { createPaymentsClient, createWebhookHandler } from 'india-payments-mcp';
const payments = createPaymentsClient(); // reads PAYMENTS_MODE and <GATEWAY>_* env vars
const created = await payments.createPayment('razorpay', { orderRef: attemptRef, amount: 49900 });
```

## MCP tools (21)

| Group | Tools |
|---|---|
| Discovery | `payments_list_providers`, `payments_get_capabilities`, `payments_check_config`, `payments_recommend_gateway` |
| Payments | `payments_create_payment`, `payments_verify_payment`, `payments_get_status` |
| Refunds | `payments_refund` (moves money), `payments_get_refund_status` |
| Webhooks | `payments_verify_webhook`, `payments_simulate_webhook` (disabled in live mode) |
| Customers / subscriptions / settlements | `payments_create_customer`, `payments_create_subscription`, `payments_cancel_subscription`, `payments_list_settlements` |
| Code generation | `payments_generate_integration` |
| Skydo (ledger mode) | `payments_skydo_record_payment`, `payments_skydo_outstanding` |
| Infinity (ledger mode) | `payments_infinity_record_payment`, `payments_infinity_outstanding` |
| Mock | `payments_mock_complete_payment` (mock mode only) |

Resources: `payments://matrix`, `payments://providers/{provider}`. Prompt: `integrate_payments`.

## E. Non-negotiable payment rules

Every one of these is a real-money bug when violated. Check each one explicitly before you say you are done.

1. **The amount comes from the server.** Compute it from the server-side cart/plan/price table. Never accept an amount, currency or price from the client request. The client sends an item/plan id; the server prices it.
2. **Amounts are integer minor units inside your app** (paise for INR, cents for USD). Store `amount_paise BIGINT` (or `amount_minor` with a currency column). Convert to the gateway's unit only at the adapter edge (Cashfree number rupees; PayU/Paytm/CCAvenue rupee strings with exactly 2 decimals). Never use floats for money; convert with integer math (`(p / 100n)` and `p % 100n`, or `(p/100).toFixed(2)` only on a value already known to be an integer).
3. **Verify before fulfilling.** An order is paid only when (a) the callback signature/hash verifies with a constant-time compare, or the gateway's status API says success when the callback is unsigned (PhonePe, Cashfree, Stripe redirects, and best practice for PayU/CCAvenue), AND (b) the verified order id and amount match what you stored. A redirect to `/success` proves nothing. With this SDK/MCP: `payments_verify_payment` returns `valid` (authentic and matching; a genuine failure is still valid) and `paid`. `paid` is true only when the result is valid AND the money is collected (status `captured` or `partially_refunded`; `authorized` is NOT paid, because this SDK has no capture API, and a fully `refunded` payment is NOT paid) AND you passed both `order_ref` and `expected_amount` (SDK: `orderRef`, `expectedAmount`); without them a genuine callback for some other, cheaper order could count, so `paid` stays false and `reason` says why. For Razorpay also pass the stored `provider_order_id` (`order_…`/`sub_…`): the signature is computed with it, never with the id from the browser; Razorpay reports `captured` only once the order is fully paid, so keep auto-capture on. **Fulfil only on `paid: true`**. Skydo and Infinity have no callback: call verify with `payload: {}` plus `order_ref` and `expected_amount`; it reads the Zoho invoice or the ledger. Webhooks from PhonePe and CCAvenue come with `bodyAuthenticated: false`: confirm with `payments_get_status` before fulfilling (`createWebhookHandler` does this automatically).
4. **Webhooks are the source of truth.** The browser may close before the callback. Fulfilment must also happen from the webhook path. Webhook handler: read the **raw body bytes** before any JSON parsing, verify the signature over those bytes, dedupe by event id (insert into `webhook_events` with a unique key; on conflict return 200 and stop), process inside a transaction, return 2xx fast. Return 4xx for a bad signature, 5xx only when your own processing failed so the gateway retries.
5. **Fulfilment is idempotent.** Callback and webhook will both arrive, sometimes concurrently. Transition the order with a conditional update (`UPDATE ... SET status='paid' WHERE id=? AND status IN ('created','pending')`) and fulfil only if a row changed.
6. **One unique orderRef per payment attempt.** Several gateways reject reuse (PhonePe, Paytm, Cashfree, PayU txnid). Your business order can have many attempts; each attempt gets a fresh ref like `ord_123_a2`. Creating the gateway order is idempotent on that ref (unique index + idempotency key), so a double-click does not create two charges.
7. **Refunds are idempotent by refundRef.** Generate the refund ref once, store it before calling the gateway, and reuse it on every retry. Never refund more than `captured - already_refunded`. Omitting the amount refunds the ORIGINAL amount on several gateways: after a partial refund always pass the remaining amount. If a refund (or any money-moving call) fails with `OUTCOME_UNKNOWN`, it may or may not have happened: check `payments_get_refund_status` / `payments_get_status` before retrying, never blind-retry, and never retry with a new refundRef. (The SDK already looks the refund up by refundRef after `OUTCOME_UNKNOWN` or a duplicate rejection where the gateway allows it; Razorpay needs `provider_payment_id` for that; PayU and CCAvenue cannot, so check their dashboard. Its idempotency cache is in process only: 24 h for refunds, 10 minutes for createPayment.) (`err.retryable` is true only for codes where a blind retry is safe.) Live refunds, subscription cancellations and Skydo/Infinity receipt recording (in sandbox too: Skydo has no sandbox and Infinity documents none) need human approval; the MCP server enforces `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` plus `confirm=true`. That double gate is applied by the MCP server only; SDK calls from your own app code rely on your own authorisation.
8. **Secrets are server-only.** Key secret, salt, working key, merchant key, client secret, webhook secret: environment/secret manager only, never in client bundles, mobile apps, logs, error messages, analytics, or git. `NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_`, `REACT_APP_` prefixes on a secret are a bug.
9. **Reconcile.** Run a job that finds attempts stuck in `created`/`pending` older than N minutes and calls the status API (`payments_get_status`), and that compares settlements with your ledger. Webhooks get lost; the job catches it.
10. **Handle pending UPI.** UPI collect/intent payments can sit in `pending` for minutes. Show "payment processing", do not mark failed on timeout, and do not let the user pay again for the same order while an attempt is pending unless the previous attempt is confirmed failed/expired. Resolve via webhook or reconciliation.
11. **Log without card data or secrets.** Log order ref, provider ids, status, amount. Never log card numbers, CVV, full UPI VPAs in plain analytics, auth headers, or raw signed payloads with secrets.
12. **Do not store card data.** Use the gateway's hosted checkout or SDK. Storing PAN takes you into PCI DSS scope and violates RBI tokenisation rules.

## F. Test: mock, then sandbox

1. **Mock** (`PAYMENTS_MODE=mock`, no credentials, no network): `payments_create_payment` → `payments_mock_complete_payment` (success and failure) → feed the returned payload to `payments_verify_payment` with `order_ref` and `expected_amount`. Use this to exercise your own routes and state machine. Mock mode enforces the real ids (Razorpay/Stripe status needs `provider_order_id`; refunds on Razorpay, Stripe, PayU, Paytm and CCAvenue need `provider_payment_id`) and INR-only gateways (PayU, Paytm, PhonePe), so fix those errors rather than working around them. (Skydo/Infinity: their record/outstanding tools are not available in mock mode; use `payments_mock_complete_payment`, then verify with `payload: {}`.)
2. **Sandbox** (`PAYMENTS_MODE=sandbox`, test credentials from the gateway dashboard): run `payments_check_config` first. Then a real sandbox checkout with the test cards/UPI ids in `references/<gateway>.md`.
3. **Webhooks locally**: call `payments_simulate_webhook` with `target_url` pointing at your local endpoint (exposed by a tunnel if the gateway itself must reach it). It returns a correctly signed request and a curl command. Test: valid signature → 200 and order paid; same event twice → second is a no-op; tampered body → 400; handler throws → 5xx.
4. Test the unhappy paths: failed payment, user closes checkout, amount mismatch in callback, callback for a different order, duplicate callback, pending UPI that later succeeds, partial refund, refund retry with the same refundRef.
5. Write automated tests for verification and the state machine using recorded/simulated payloads. Do not hit the network in unit tests.

## G. Go-live checklist

- [ ] Gateway account KYC complete and live keys issued; the payment methods you need are enabled on the account.
- [ ] Live keys in the production secret store only; test keys not present in production; `PAYMENTS_MODE=live`.
- [ ] Webhook URL registered in the live dashboard (separate from test), HTTPS, secret set, events subscribed (payment success/failure, refund processed/failed, subscription events if used).
- [ ] Amount, currency and order id verified on every callback and webhook; status API used for unsigned gateways.
- [ ] Raw-body webhook verification works behind the production proxy/CDN (some strip or re-encode bodies).
- [ ] Dedupe table and conditional status update in place; reconciliation job scheduled and alerting.
- [ ] Auto-capture enabled where relevant (Razorpay): with this SDK an `authorized` payment is never `paid`, and there is no capture API.
- [ ] Domain whitelisted (Cashfree), server egress IP whitelisted (CCAvenue), return URLs on the live domain.
- [ ] Refunds gated behind admin auth and audit log; refund amount bounded by captured minus refunded.
- [ ] One real low-value live transaction end to end, then refunded.
- [ ] Customer-facing: receipts, failure messages, "processing" state for pending UPI, support contact.

## H. Tell the human what only they can do

End every integration by listing the dashboard tasks explicitly. You cannot do these:

- Create/complete the merchant account and KYC; get test and live API keys.
- Register the webhook URL and its secret (Razorpay webhook secret, PhonePe webhook username/password, Stripe `whsec_`), and choose events.
- Enable payment methods (UPI, EMI, international cards, subscriptions/e-mandate) which are often off by default.
- Whitelist the domain (Cashfree) or server IP (CCAvenue, RazorpayX payouts).
- Turn on auto-capture (Razorpay) if desired.
- For Shopify: install the gateway's official Shopify app and connect it; no code.
- For Stripe India: request an invite. For Skydo: either connect Skydo to Zoho (Skydo profile > Connect Skydo to Zoho), create the Zoho service item, clients and a Self Client refresh token, or copy the receiving-account details into `SKYDO_RECEIVING_ACCOUNTS`; then, in ledger mode, check each receipt in the Skydo dashboard and record it with its Skydo transaction reference as `receipt_id` (never from forwarded email text alone). With Zoho, confirm during setup that the first API-created invoice appears in Skydo (Skydo documents Zoho invoice sync, not API-created invoices specifically). For Infinity: either connect Zoho Books in the Infinity dashboard (Connect > Zoho Books) and set the separate `INFINITY_ZOHO_*` variables (never the same Zoho organisation as Skydo), then pay one real invoice and confirm Infinity marks it paid in Zoho (what the integration syncs is not publicly documented); or copy the receiving-account details into `INFINITY_RECEIVING_ACCOUNTS` and/or create a QuickLink per invoice in the dashboard (same amount and currency); then check each receipt in the Infinity dashboard and record it with its Infinity transaction reference as `receipt_id`.
- Approve any live refund or subscription cancellation.

## Working WITHOUT the MCP server

The skill must work when no `payments_*` tools are available (Cursor without MCP, an offline agent, another language stack). Then:

- Section B: use the table above. Section C: read `references/<gateway>.md` (constraints, units, auth, status mapping).
- Section D: write the adapter yourself from the reference file's endpoints and verification snippets, and the module from `references/payment-module-architecture.md`. Keep all gateway code in one module (`payments/<gateway>.ts` or equivalent).
- Section F: there is no mock tool. Write unit tests that build signed payloads with the documented algorithm (the reference snippets do this), then test in the gateway sandbox, using the gateway's own webhook test tools or a tunnel.
- Mark anything the reference file labels UNVERIFIED as "confirm in sandbox" in your summary to the user. Do not present it as fact.
- To install the server later: `npx india-payments-mcp` (stdio) with `PAYMENTS_MODE=mock` needs no credentials.
