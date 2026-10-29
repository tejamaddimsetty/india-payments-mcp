# Strict review: Dodo Payments adapter (uncommitted change)

- **Reviewed:** 2026-10-29, working tree on top of `ec96463`. The Dodo change is not committed.
- **Scope:** `src/providers/dodo/{adapter.ts,capabilities.ts}`, the Dodo parts of `src/client.ts`, `src/mock/mock-gateway.ts`, `src/codegen/templates/profiles.ts`, `src/codegen/recommend.ts`, `src/core/types.ts`, `src/providers/index.ts`, and `test/providers/dodo.test.ts`. Also checked: the generic code paths Dodo runs through (`client.ts` verify, refund and webhook, `webhooks/handler.ts`, `codegen/templates/service.ts`), and `generateIntegration({ provider: 'dodo' })` for all 9 frameworks.
- **Rules applied:** `AGENTS.md`, `docs/security.md`. API facts come from `docs/research/dodo-api-facts.md`. Field spelling is out of scope because another agent is verifying it.
- **Method:**
  - Read every line of the adapter and of the generic paths above.
  - Wrote scratch reproductions against the real source, with fake `fetch` and no network: `review-dodo/repro.mts` (P1-P9) and `review-dodo/gen.mts` (codegen for every framework) in the session scratchpad. They are not committed.
  - Sent no requests to Dodo.
- **Suite:** `npx vitest run` passes 747 of 747 tests in 17 files. `npx tsc --noEmit` is clean.
- No source files were edited.

## Summary

The adapter does the hard parts well:
- Webhook verification follows the Standard Webhooks construction.
- The session id wins over a browser `payment_id`.
- POSTs are never retried, and a lost response surfaces as OUTCOME_UNKNOWN.
- The binding keys are written last.
- Unclear `IntentStatus` values are never mapped to `captured`.

**The weak point is what the binding rests on.** On the default path, which is the generated callback and every webhook, a payment is tied to an order by `metadata.order_ref` alone. Dodo documents that customers can set that field themselves on static payment links (`metadata_<key>`). The amount check also ignores currency. Together, these let a customer mark an order paid with a payment that has the same number in a cheaper currency (H1). The other findings are refund-unit inconsistencies, unprotected checkout fields and smaller correctness gaps.

| # | Severity | Finding |
|---|---|---|
| H1 | **High** | Order binding is customer-forgeable (static-link `metadata_order_ref`) and currency is never compared: `paid: true` and a `payment.succeeded` webhook for the wrong currency |
| M1 | Medium | `providerOptions.return_url` (and other unprotected session fields) pass the guard: redirect hijack when `returnUrl` is omitted |
| M2 | Medium | Refund amounts mix two scales: the "full" threshold is the pre-tax price, while partial item amounts are tax-inclusive |
| M3 | Medium | After OUTCOME_UNKNOWN, a "matched price = full" refund is reported as IDEMPOTENCY_CONFLICT even though it succeeded |
| M4 | Medium | A payment with no `metadata.order_ref` is attributed to any `orderRef` (getPaymentStatus) and refundable under any `orderRef` |
| L1 | Low | A webhook key that decodes to 0 or 1 bytes is accepted: signatures can be forged without the secret |
| L2 | Low | Mock drift: mock verify passes with an empty payload, and mock skips the metadata limits that the real adapter enforces |
| L3 | Low | `listSettlements` reads one page with no `page_size`, and an invalid date throws a raw RangeError |
| L4 | Low | Concurrent refunds with the same `refundRef` from two processes POST twice (inherent, but undocumented in `constraints`) |
| L5 | Low | `checkPrice` ignores `purchasing_power_parity` and localized prices, so paid customers are never fulfilled |
| L6 | Low | Shopify codegen for Dodo emits an "install the official app" guide and a reconcile server that always throws |
| L7 | Low | Test gaps: no currency-only mismatch test, no forged-metadata test, no `return_url` guard test |

---

## HIGH

### H1. Binding relies on metadata a customer can set, and currency is never checked

**Where:**
- `adapter.ts:397-432` (`verifyPayment`). Without `providerOrderId`, the only binding is `metadata.order_ref` (`:415,:419`) and a numeric amount (`:417,:425`). `pay.currency` is never compared.
- `adapter.ts:580,587` (`parseWebhook`). `orderRef` comes from `data.metadata.order_ref`, and `amount` is numeric.
- `codegen/templates/service.ts:241` calls `verifyPayment(PROVIDER, { payload, orderRef, expectedAmount })` **without `providerOrderId: attempt.providerOrderId`**.
- `service.ts:258-302`: `applyStatus` and `onWebhookEvent` find the attempt by `event.orderRef` and compare the amount only. They never compare currency or `event.providerOrderId`.

**Why it is forgeable:** `dodo-api-facts.md` §3a (VERIFIED, integration guide) lists static payment links `https://checkout.dodopayments.com/buy/{product_id}?…` that accept `metadata_<key>` query parameters, plus `paymentCurrency`, `showCurrencySelector` and `paymentAmount` (PWYW). Any customer can open such a link for any product of the merchant with `metadata_order_ref=<orderRef>`. The orderRef is not secret: `createCheckout` returns it to the browser, and it is in the return URL. The resulting payment is genuine and Dodo signs its webhook, but the binding key in it was written by the customer. The adapter comment at `:208` ("written by our server through the API") does not hold for static-link payments.

**Failure scenario:**
1. The order is INR 149900 (Rs 1,499, about US$18).
2. The attacker pays a static link on the merchant's PWYW product with Adaptive Currency in VND, tuning `paymentAmount` until `total_amount = 149900` VND (about US$6). With tax, `total_amount - tax = 149900` also works (`dodoMatchedAmount`, `:232-238`).
3. The attacker then opens `/api/payments/callback?orderRef=<victim>&payment_id=<theirs>`, or simply waits for the signed `payment.succeeded` webhook.
4. Both paths fulfil the order.

The larger the order, the larger the discount. The only floors are the PWYW minimum and Dodo's US$0.50 minimum.

**Proof** (`repro.mts` P1, P1b, P2):

```
## P1 verifyPayment, forged metadata + VND, no providerOrderId
 {"paid":true,"valid":true,"status":"captured","amount":149900,"providerOrderId":"cks_static_link","rawCurrency":"VND"}
## P1b same payment WITH providerOrderId
 {"paid":false,"status":"created"}
## P2 webhook normalised (generated onWebhookEvent looks up attempt by orderRef, compares amount only)
 {"type":"payment.succeeded","orderRef":"ord1_victim","amount":149900,"currency":"VND","providerOrderId":"cks_static_link"}
```

P1b shows that the server-created checkout session is the one binding a customer cannot forge. The generated code does not use it.

**Preconditions (be honest):** exploiting the currency step needs Adaptive Currency on the account, or products in more than one currency, plus a PWYW product or a lucky converted price. The static-link `metadata_<key>` → `payment.metadata` mapping comes from the doc's parameter list and has not been tested in test mode. Rated High rather than Critical until both are confirmed in Dodo test mode. With them confirmed, this is a critical underpayment.

**Fix:**
1. `verifyPayment` should return `valid: false` for a captured payment whose `checkout_session_id` differs from `providerOrderId`. Without `providerOrderId`, it should give `paid` only with an explicit "metadata-only binding" reason, or refuse.
2. Write `expected_currency` into metadata and compare `pay.currency` against it. This is defence in depth only, because metadata is forgeable.
3. Generated code:
   - Pass `providerOrderId: attempt.providerOrderId` to `verifyPayment`.
   - In `onWebhookEvent`, refuse when `event.providerOrderId !== attempt.providerOrderId` (when both are set) or when `event.currency !== attempt.currency`.
   - In `applyStatus`, take the currency into account.
4. Add a currency-only mismatch test and a forged-metadata static-link test.
5. Document in `constraints` that `metadata` is customer-writable on static links.

---

## MEDIUM

### M1. Unprotected checkout-session fields pass through `providerOptions`

**Where:**
- `adapter.ts:340`: `...extra` is spread first. `return_url` is added later only when `input.returnUrl` is set (`:346`), and the same pattern is at `:647-650` for subscriptions.
- `protectedOptionKeys` (`:717-721`) and the baseline (`client.ts:66-72`) include `redirect_url`, `cancel_url` and `success_url`, but **not `return_url`**.

AGENTS.md rule 3 requires protecting "redirect or notification URLs".

**Proof** (P3): `createPayment` through `PaymentsClient` with `providerOptions` set to `{ return_url, product_collection_id, custom_fields, customization, billing_address, tax_id }` produced this body:

```
{"return_url":"https://evil.example/phish","product_collection_id":"pdc_cheap","custom_fields":[{"key":"pin","label":"Card PIN",...}],
 "customization":{"show_order_details":false},"billing_address":{"country":"AE"},"tax_id":"X","product_cart":[...],"metadata":{...}}
```

**Scenario:** a prompt-injected agent omits `return_url` and sets `provider_options.return_url`. After paying, the customer is sent to a phishing page that carries their `payment_id`. The other passthrough fields have these effects:
- `custom_fields` adds attacker-worded inputs to the hosted checkout.
- `customization.show_order_details:false` hides what is being bought.
- `product_collection_id` may let the customer pick a different product. This fails safe on the amount check, but it is still not something an agent should set.

**Fix:**
- Add `return_url` to the Dodo payment and subscription lists (or the baseline).
- Also protect `product_collection_id`, `custom_fields`, `customization`, `short_link`, `billing_address` (the typed input exists), `tax_id` and `customer_business_name`. Or switch to an allowlist: `allowed_payment_method_types`, `force_3ds`, `minimal_address`, `show_saved_payment_methods`.
- Add a guard test.

### M2. Refund amounts mix pre-tax and tax-inclusive scales

**Where:**
- `adapter.ts:495` counts `input.amount === dodoMatchedAmount(...)`, the **pre-tax** price, as a full refund. With no items, Dodo refunds `total_amount` including tax.
- `:511` sends any other amount as `items[{amount}]`. Dodo's `PartialRefundItem.tax_inclusive` defaults to `true` (facts §5), so that amount is **tax-inclusive**.
- `service.ts:362` computes `refundable = attempt.amount - refundedAmount` on the pre-tax scale, and the `refund.processed` webhook adds Dodo's (tax-inclusive) `amount`.

**Proof** (P4). The payment is `total_amount` 176882, `tax` 26982, price 149900:

```
refund amount=149900 -> {"payment_id":"pay_1","currency":"INR",...}                       (customer gets 176882)
refund amount=149899 -> {"items":[{"item_id":"pdt_fixed","amount":149899}],...}           (customer gets 149899)
refund amount=74950  -> {"items":[{"item_id":"pdt_fixed","amount":74950}],...}            (less than half of what was paid)
```

**Effects:**
- One paisa of difference in the requested amount changes the refund by Rs 269.
- In the generated app, a partial refund of 50000 followed by 99900 marks the attempt `refunded`, while Dodo still holds 26982 of the customer's money and reports `refund_status: partial`.

**Fix:** pick one scale, and document it in `capabilities.ts` and the refund tool description:
- **Pre-tax scale:** send `tax_inclusive: false` on items so tax is added proportionally.
- **Total-paid scale:** treat only `total_amount` as full.

### M3. A lost response on a "matched price" full refund is reported as a conflict

**Where:** `client.ts:441` compares `found.amount` (Dodo's refund amount, 176882) with `input.amount` (149900) after OUTCOME_UNKNOWN. The adapter's own equivalence (`adapter.ts:499`, `full && existing.amount === pay.total_amount`) is not applied on this path.

**Proof** (P4b):

```
lost response, client lookup -> {"code":"IDEMPOTENCY_CONFLICT","message":"A dodo refund with refundRef \"rf_9\" already exists for 176882, not 149900."}
retry with the same refundRef (adapter path) -> {"providerRefundId":"rfn_9","amount":176882}
```

**Effect:** the operator is told the refund conflicts, although it went through. A different operator or agent then retries with a new `refundRef`. Dodo's cumulative cap is the only thing stopping a second refund.

**Fix:** make `getRefundStatus` (or the adapter's `refund`) normalise the result, or let the adapter own the lookup-after-unknown. For example, call `findRefund` inside `refund` when the POST fails with OUTCOME_UNKNOWN, using the same `same` rule.

### M4. Unbound payments are attributed to, and refundable under, any orderRef

**Where:**
- `adapter.ts:445-451`: `if (owner && owner !== input.orderRef)`. With no `order_ref`, it returns `orderRef: input.orderRef`.
- `:490-493`: same check before refunding.

`verifyPayment` correctly refuses this case (`:419`), so the three methods disagree.

**Proof** (P5). The payment has `metadata: {}`, as in a dashboard or static-link payment or a subscription renewal:

```
getPaymentStatus -> {"orderRef":"ord_victim","status":"captured","amount":100,"currency":"USD"}
refund under ord_victim -> {"providerRefundId":"rfn_f","posted":1}
```

**Scenario:** a customer email says "I paid, it's pay_xxx". The agent calls `payments_get_status` with that id, gets `captured` labelled with the victim's orderRef, and fulfils. Or an agent refunds a foreign payment and the audit log files it under the wrong order.

**Fix:** require `owner === input.orderRef` (refuse a missing `order_ref`) in `getPaymentStatus` and `refund`, or leave `orderRef` unset and add a reason. Also compare `pay.checkout_session_id` with `providerOrderId` when both are given.

---

## LOW

### L1. Degenerate webhook keys are accepted

**Where:** `dodoSigningKey` (`adapter.ts:179-181`) uses `Buffer.from(..., 'base64')`, which never throws and silently drops invalid characters. `create()` (`:697-712`) does not validate `webhookKey`.

**Proof** (P6):

```
key="whsec_"   decodes to 0 bytes; attacker-signed webhook {"accepted":true}  create(): accepted
key="whsec_ab" decodes to 1 bytes; attacker-signed webhook {"accepted":true}  create(): accepted
```

A 0-byte key means anyone can sign webhooks. One byte means 256 guesses.

**Fix:** in `create()`, throw `CONFIG_INVALID` when the decoded key is shorter than 24 bytes (Standard Webhooks secrets are 24-64 bytes) or when the base64 does not round-trip.

### L2. Mock drifts from real input rules

**Where:** the mock routes Dodo through `verifyByLookup` (`mock-gateway.ts:200`), keyed on `orderRef`. The real adapter needs `payload.payment_id` or `providerOrderId` (`adapter.ts:401`). The mock also skips Dodo's metadata limits (`:215-226`), the refund reason limit (3000) and the product price check.

**Proof** (P7):

```
mock (41-char metadata key accepted, empty payload) {"paid":true}
real adapter, same call {"valid":false,"reason":"Payload must contain payment_id (Dodo return_url), or pass providerOrderId (the cks_ session id)."}
```

The existing test (`dodo.test.ts`, "mock mode needs a product id…") asserts the mock-only behaviour as correct. AGENTS.md step 6 says mock mode must fail the same way.

**Fix:** in the mock, require `payment_id` or `providerOrderId` for Dodo verify, and apply `assertMetadata` and the reason limit.

### L3. `listSettlements` reads one page only and throws a raw error on bad dates

**Where:** `adapter.ts:679-694`. The request has no `page_size` or `page_number`, and `count` (up to 100) only slices what comes back. Dodo list endpoints default to 10 items (facts §4, `GET /payments`; `/payouts` pagination is unconfirmed, §Unverified). `new Date('yesterday').toISOString()` throws `RangeError`, not `PaymentError('VALIDATION')`.

**Proof** (P8): the URL is `…/payouts?created_at_gte=2026-01-01T00%3A00%3A00.000Z`, and the invalid date gives `{"name":"RangeError","message":"Invalid time value"}`.

**Fix:**
- Send `page_size=min(count,100)` once confirmed.
- Mark the capability note "first page only" until then.
- Validate dates.

### L4. Cross-process refund race with the same refundRef

**Where:** `adapter.ts:497-522`. The adapter looks up first and then POSTs, with no key in between. `MemoryIdempotencyStore` is per process.

**Proof** (P9): two clients with separate stores, refunding concurrently, sent 2 POSTs for one `refundRef`. The fake made the first refund succeed instantly.

Dodo's "one refund pending/review per payment" rule and the cumulative cap limit the damage, but two partial refunds can both land when the first settles fast (UPI). This is inherent with no idempotency key.

**Fix:** state in `constraints` that a shared `IdempotencyStore` is required for refunds across instances. Optionally, re-read `payment.refunds` after a non-unknown provider error.

### L5. Product price check ignores PPP and localized prices

**Where:** `checkPrice` (`adapter.ts:291-318`) checks `type`, `currency`, `pay_what_you_want`, `discount_bps` and `price`. It does not check `purchasing_power_parity` (part of `OneTimePrice`, facts §3d) or localized prices (`/products/{id}/localized-prices`, §10).

Both change what the customer is charged. The amount check then fails safe, but a customer who paid is never fulfilled. Only discounts and Adaptive Currency are mentioned in `constraints`.

**Fix:** refuse `purchasing_power_parity: true` at create time, as is already done for `discount_bps`, and name PPP and localized prices in `constraints` and the dashboard steps.

### L6. Shopify codegen for Dodo contradicts itself and generates a broken server

**Where:**
- `capabilities.ts:63` sets `platformPlugins.shopify` to "No Dodo Shopify payments app found." That string is truthy, so `codegen/index.ts:267` does not add the "no verified Shopify app" warning.
- The generated guide says "install Dodo Payments's official app".
- `src/shopify-reconcile.ts` calls `getPaymentStatus(PROVIDER, { orderRef: ref })`, which always throws for Dodo ("cannot search by orderRef").

Paytm has the same pre-existing pattern. Skydo and Infinity are special-cased.

**Fix:** leave `platformPlugins.shopify` undefined, or special-case Dodo like Skydo.

### L7. Test gaps

- `dodo.test.ts` "rejects … a different amount" tests currency only together with an amount change (`USD`, 1800), so H1 is invisible.
- No test covers a forged `metadata.order_ref` without `providerOrderId`, the `return_url` guard (M1), a refund amount between price and total (M2), the M3 path, or an unbound payment (M4).

---

## Attacks that held

| Attack | Result |
|---|---|
| Browser `payment_id` swapped while the stored session is passed | Refused, `adapter.ts:388-390` (test plus P1b). A session with no payment yet ignores the browser id and returns `created` (P1b) |
| Payment of another (server-created) order | Refused by `order_ref` (`:419`). Our sessions write `order_ref`/`expected_amount` last, so `input.metadata` cannot override them (`:336`, test) |
| Forging `expected_amount` to inflate the reported amount | Not possible. `dodoMatchedAmount` only ever returns `total_amount` or `total_amount - tax` (both Dodo's numbers), so forging can only *lower* the reported figure. The tax-exclusive rule cannot be met by paying less in the same currency |
| Unclear statuses | `partially_captured` and new values map to `unknown`, `requires_capture*` to `authorized`, and `succeeded`+`full` to `refunded`, so none are paid (`client.ts` `PAID_STATUSES`). `succeeded`+`partial` maps to `partially_refunded` (paid), per the rules |
| Webhook tampering, wrong secret, id swap, stale/future timestamp (±300 s), missing headers | All refused (tests). Non-digit, huge or `Infinity` timestamps are refused. Multiple `v1,` entries are checked without early exit through `safeEqual`. `v2,` and malformed entries are skipped. The raw body is verified before `JSON.parse`. Replays are deduped on `webhook-id` by `createWebhookHandler`. A dot inside `webhook-id` cannot shift the signed string, because the timestamp must be digits and the body starts with `{` |
| Events without `metadata` | `orderRef`/`refundRef` are undefined, and the generated handler acks and ignores them |
| Secret without `whsec_` | Decoded as plain base64, as Standard Webhooks specifies (but see L1 for degenerate values) |
| Lost `POST /checkouts` or `POST /refunds` | OUTCOME_UNKNOWN with exactly one POST (`retrySafe: method !== 'POST'`, tests). The client finds the refund by `refundRef` afterwards (test; see M3 for the amount caveat) |
| Same refundRef twice in one process | `withIdempotency` plus the adapter pre-lookup: no second POST, and a different amount gives `IDEMPOTENCY_CONFLICT` (test) |
| Partial refund on a multi-item cart | Refused (`:508-510`). Refund currency is forced to the payment currency (`:517`) |
| Price-check bypasses | A missing or `null` fixed `price` fails `price.price !== amount`. A wrong currency, a recurring/usage price or `discount_bps` is refused before any POST. PWYW below the minimum is refused. A truthy non-boolean `pay_what_you_want` can only make Dodo ignore `amount` and charge the fixed price, which then fails the amount check (safe) |
| `confirm` / `payment_method_id` / `discount_codes` / `billing_currency` / `customer` / `product_cart` / `feature_flags` / `subscription_data` via providerOptions | Refused (test). `mandate_min_amount_inr_paise` is refused for subscriptions |
| Key/mode cross-check | `dodo_live_` in sandbox and `dodo_test_` in live are refused, and legacy unprefixed keys are accepted as documented |
| Cancel a `cks_` "subscription" | Refused with a clear hint. The PATCH bodies match facts §8 (`status` and `cancel_reason`, or `cancel_at_next_billing_date`) |
| Codegen, all 9 frameworks | All generate without error (`gen.mts`). The webhook route is raw-body, the refund route uses `providerPaymentId: attempt.providerPaymentId` (filled from `verifyPayment` or the webhook), and the env file lists the three `DODO_PAYMENTS_*` vars. The flow works, apart from H1 (no `providerOrderId` and no currency check), M2 (refund scale) and L6 (Shopify) |
| Secrets | The API key is only in the `Authorization` header. `raw` holds no `client_secret` because `confirm` is protected |
