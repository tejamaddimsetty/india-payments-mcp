# Example payloads (deliverable F)

These are example MCP tool calls and the JSON each tool returns. Tool arguments are `snake_case`. Results use the SDK's `camelCase` types and are shown **without `raw`**, because the MCP layer strips it unless `include_raw: true`. Ids, hashes and tokens are illustrative. The field names and shapes match the code in `src/`.

Every tool returns one text block containing pretty-printed JSON. Errors set `isError: true` and return `PaymentError.toJSON()`. See [the error section](#errors).

---

## Discovery

### `payments_list_providers`

```json
// args
{}
```

```json
{
  "mode": "sandbox",
  "providers": [
    {
      "id": "razorpay",
      "name": "Razorpay",
      "summary": "Most complete developer API in India: orders, UPI, cards, netbanking, wallets, EMI, subscriptions, payment links, settlements, plus RazorpayX for payouts.",
      "configured": true,
      "features": {
        "createPayment": "supported", "verifyPayment": "supported", "paymentStatus": "supported",
        "refund": "supported", "refundStatus": "supported", "webhooks": "supported",
        "customers": "supported", "subscriptions": "supported", "settlements": "supported",
        "payouts": "not_implemented", "paymentLinks": "not_implemented"
      }
    },
    {
      "id": "skydo",
      "name": "Skydo",
      "summary": "Cross-border collections for Indian exporters, freelancers and agencies: ... No public API, so this project offers guidance only.",
      "configured": true,
      "features": { "createPayment": "unsupported", "verifyPayment": "unsupported", "...": "unsupported" }
    }
  ]
}
```

### `payments_get_capabilities`

```json
{ "provider": "phonepe" }
```

```json
{
  "provider": "phonepe",
  "displayName": "PhonePe Payment Gateway",
  "features": {
    "createPayment": { "support": "supported", "notes": "POST /checkout/v2/pay (Standard Checkout v2). Returns a hosted PayPage redirectUrl." },
    "verifyPayment": { "support": "partial", "notes": "The redirect back to your site carries no signed data, so verification is an Order Status API call (verifiedVia: status_api). ..." },
    "customers": { "support": "unsupported", "notes": "PhonePe PG has no customer object; ..." },
    "subscriptions": { "support": "not_implemented", "notes": "PhonePe Autopay (UPI mandates, plus eNACH) exists ... but is not wired up here." }
  },
  "paymentMethods": ["upi", "card", "netbanking"],
  "currencies": "INR only.",
  "checkoutTypes": ["redirect"],
  "providerAmountFormat": "Integer paise (same as ours).",
  "credentials": [
    { "env": "PHONEPE_CLIENT_ID", "key": "clientId", "required": true, "secret": false, "description": "OAuth client id ..." },
    { "env": "PHONEPE_WEBHOOK_PASSWORD", "key": "webhookPassword", "required": false, "secret": true, "description": "..." }
  ],
  "constraints": ["Minimum amount is 100 paise (Rs 1), for payments and refunds.", "..."],
  "lastVerified": "2026-10-28"
}
```

### `payments_check_config`

```json
{ "provider": "razorpay" }
```

```json
{
  "mode": "sandbox",
  "allowLiveMutations": false,
  "auditLog": null,
  "providers": [
    {
      "provider": "razorpay",
      "ready": true,
      "missing": [],
      "present": ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"],
      "optionalMissing": ["RAZORPAY_WEBHOOK_SECRET"]
    }
  ]
}
```

When a live key is configured in sandbox mode, the same provider entry gains:

```json
{ "initError": "PAYMENTS_MODE=sandbox but RAZORPAY_KEY_ID is a live key (rzp_live_). Refusing to move real money in sandbox mode." }
```

### `payments_recommend_gateway`

```json
{ "needs": ["exporter_collections", "international"], "business": "Design agency billing US clients" }
```

```json
{
  "ranking": [
    { "provider": "skydo", "name": "Skydo", "score": 16, "matches": ["exporter_collections", "international"], "blockers": [], "summary": "...", "constraints": ["No public developer API, SDK or webhooks. ...", "..."] },
    { "provider": "stripe", "name": "Stripe (India)", "score": 5, "matches": ["international"], "blockers": [], "summary": "...", "constraints": ["Stripe services are invite-only in India ...", "..."] }
  ],
  "note": "Heuristic ranking from the capability map. Pricing, settlement time and KYC approval vary by business; confirm with the gateway before committing."
}
```

---

## Create payment: one example per checkout shape

### Razorpay → `js_sdk`

```json
{
  "provider": "razorpay",
  "order_ref": "ORD_1001",
  "amount": 49900,
  "customer": { "name": "Asha Rao", "email": "asha@example.com", "phone": "9876543210" },
  "description": "Pro plan, 1 month",
  "metadata": { "plan": "pro" }
}
```

```json
{
  "provider": "razorpay",
  "environment": "sandbox",
  "orderRef": "ORD_1001",
  "providerOrderId": "order_PbX4qJ7d2Kf9Lm",
  "status": "created",
  "amount": 49900,
  "currency": "INR",
  "checkout": {
    "type": "js_sdk",
    "sdk": "razorpay",
    "scriptUrl": "https://checkout.razorpay.com/v1/checkout.js",
    "options": {
      "key": "rzp_test_1DP5mmOlF5G5ag",
      "order_id": "order_PbX4qJ7d2Kf9Lm",
      "amount": 49900,
      "currency": "INR",
      "description": "Pro plan, 1 month",
      "prefill": { "name": "Asha Rao", "email": "asha@example.com", "contact": "9876543210" },
      "notes": { "order_ref": "ORD_1001", "plan": "pro" }
    }
  }
}
```

The frontend runs `new Razorpay({ ...options, handler: (resp) => POST resp to your verify endpoint }).open()`. `key` is the publishable key id, and the secret never appears.

### PayU → `form_post`

```json
{
  "provider": "payu",
  "order_ref": "ORD_1002",
  "amount": 125000,
  "customer": { "name": "Ravi", "email": "ravi@example.com", "phone": "9123456780" },
  "description": "Annual subscription",
  "return_url": "https://shop.example.com/payu/return"
}
```

```json
{
  "provider": "payu",
  "environment": "sandbox",
  "orderRef": "ORD_1002",
  "providerOrderId": "ORD_1002",
  "status": "created",
  "amount": 125000,
  "currency": "INR",
  "checkout": {
    "type": "form_post",
    "url": "https://test.payu.in/_payment",
    "fields": {
      "key": "gtKFFx",
      "txnid": "ORD_1002",
      "amount": "1250.00",
      "productinfo": "Annual subscription",
      "firstname": "Ravi",
      "email": "ravi@example.com",
      "phone": "9123456780",
      "surl": "https://shop.example.com/payu/return",
      "furl": "https://shop.example.com/payu/return",
      "udf1": "", "udf2": "", "udf3": "", "udf4": "", "udf5": "",
      "hash": "3f1c9a...e07b (128 hex chars, sha512)"
    }
  }
}
```

Render a hidden `<form method="POST" action="{url}">` with one `<input type="hidden">` per field and auto-submit it. The hash isn't secret, but the salt that produced it never leaves the server.

### PhonePe → `redirect`

```json
{ "provider": "phonepe", "order_ref": "ORD_1003", "amount": 29900, "return_url": "https://shop.example.com/phonepe/return?order=ORD_1003" }
```

```json
{
  "provider": "phonepe",
  "environment": "sandbox",
  "orderRef": "ORD_1003",
  "providerOrderId": "OMO2510281530123456789",
  "status": "created",
  "amount": 29900,
  "currency": "INR",
  "checkout": { "type": "redirect", "url": "https://mercury-uat.phonepe.com/transact/uat_v2?token=eyJhbGciOi...", "method": "GET" },
  "expiresAt": "2026-10-28T10:20:00.000Z"
}
```

Put the order ref in your own `return_url`, as shown, because PhonePe's redirect doesn't tell you which order it was for.

### Cashfree → `js_sdk`

```json
{
  "provider": "cashfree",
  "orderRef": "ORD_1004",
  "providerOrderId": "4523123456",
  "status": "created",
  "amount": 49900,
  "currency": "INR",
  "checkout": {
    "type": "js_sdk",
    "sdk": "cashfree",
    "scriptUrl": "https://sdk.cashfree.com/js/v3/cashfree.js",
    "options": { "mode": "sandbox", "paymentSessionId": "session_a1B2c3D4e5..." }
  },
  "expiresAt": "2026-11-27T10:00:00+05:30"
}
```

### Mock mode → `manual`

With `PAYMENTS_MODE=mock`, the result text is prefixed with `MOCK MODE: simulate the customer with payments_mock_complete_payment.`

```json
{
  "provider": "razorpay",
  "environment": "sandbox",
  "orderRef": "ORD_1001",
  "providerOrderId": "mock_razorpay_order_1a2b3c4d",
  "status": "created",
  "amount": 49900,
  "currency": "INR",
  "checkout": {
    "type": "manual",
    "instructions": "MOCK MODE: no real checkout exists. Call payments_mock_complete_payment with provider \"razorpay\" and order_ref \"ORD_1001\" and outcome \"success\" or \"failure\" to simulate the customer paying. It returns a signed callback payload and webhook."
  }
}
```

---

## `payments_mock_complete_payment`

```json
{ "provider": "razorpay", "order_ref": "ORD_1001", "outcome": "success" }
```

```json
{
  "payment": {
    "orderRef": "ORD_1001",
    "providerOrderId": "mock_razorpay_order_1a2b3c4d",
    "providerPaymentId": "mock_razorpay_pay_9f8e7d6c",
    "amount": 49900,
    "currency": "INR",
    "status": "captured",
    "refunded": 0,
    "method": "upi",
    "createdAt": "2026-10-28T10:00:00.000Z"
  },
  "callbackPayload": {
    "provider": "razorpay",
    "order_ref": "ORD_1001",
    "provider_order_id": "mock_razorpay_order_1a2b3c4d",
    "provider_payment_id": "mock_razorpay_pay_9f8e7d6c",
    "amount": "49900",
    "status": "captured",
    "mock_signature": "5d0c...a91f (hex HMAC-SHA256)"
  }
}
```

---

## `payments_verify_payment`

### Razorpay, valid

```json
{
  "provider": "razorpay",
  "order_ref": "ORD_1001",
  "expected_amount": 49900,
  "payload": {
    "razorpay_payment_id": "pay_PbX5aQ1zZ8Yw3T",
    "razorpay_order_id": "order_PbX4qJ7d2Kf9Lm",
    "razorpay_signature": "b2f0e4...9c1d"
  }
}
```

```json
{
  "valid": true,
  "status": "authorized",
  "orderRef": "ORD_1001",
  "providerOrderId": "order_PbX4qJ7d2Kf9Lm",
  "providerPaymentId": "pay_PbX5aQ1zZ8Yw3T",
  "verifiedVia": "signature"
}
```

`authorized` is expected here: the signature proves authorisation, and auto-capture moves the payment to `captured`. Confirm capture through the `payment.captured` webhook or `payments_get_status`.

### Tampered or swapped payload

```json
{ "valid": false, "status": "unknown", "verifiedVia": "signature", "reason": "Signature mismatch" }
```

```json
{ "valid": false, "status": "unknown", "verifiedVia": "signature", "reason": "Order order_PbX4qJ7d2Kf9Lm belongs to receipt ORD_0999, not ORD_1001" }
```

### PhonePe (status API)

```json
{ "provider": "phonepe", "order_ref": "ORD_1003", "expected_amount": 29900, "payload": {} }
```

```json
{
  "valid": true,
  "status": "captured",
  "orderRef": "ORD_1003",
  "providerOrderId": "OMO2510281530123456789",
  "providerPaymentId": "OM2510281531009876543",
  "amount": 29900,
  "verifiedVia": "status_api"
}
```

`valid` means "authentic, and it matches your order and amount" on every gateway. It does not mean "paid": a genuine failure callback is `valid: true, status: "failed"`. `PaymentsClient` adds **`paid`** (`valid` and status `captured`/`authorized`/refunded). **Fulfil only when `paid` is true**, or after a `payment.succeeded` webhook or `payments_get_status` confirms capture. On Razorpay, `authorized` counts as paid; keep auto-capture enabled.

### CCAvenue (decryption)

```json
{ "provider": "ccavenue", "order_ref": "ORD_1005", "expected_amount": 100000, "payload": { "encResp": "a7c3f0...e91b", "orderNo": "ORD_1005" } }
```

```json
{ "valid": true, "status": "captured", "orderRef": "ORD_1005", "providerOrderId": "ORD_1005", "providerPaymentId": "112233445566", "amount": 100000, "verifiedVia": "decryption" }
```

---

## `payments_get_status`

```json
{ "provider": "razorpay", "order_ref": "ORD_1001", "provider_order_id": "order_PbX4qJ7d2Kf9Lm" }
```

```json
{
  "provider": "razorpay",
  "orderRef": "ORD_1001",
  "providerOrderId": "order_PbX4qJ7d2Kf9Lm",
  "providerPaymentId": "pay_PbX5aQ1zZ8Yw3T",
  "status": "captured",
  "amount": 49900,
  "amountRefunded": 0,
  "currency": "INR",
  "method": "upi"
}
```

---

## `payments_refund`

```json
{
  "provider": "razorpay",
  "order_ref": "ORD_1001",
  "refund_ref": "RF_ORD_1001_1",
  "provider_payment_id": "pay_PbX5aQ1zZ8Yw3T",
  "amount": 10000,
  "reason": "Customer downgraded",
  "speed": "normal"
}
```

```json
{ "provider": "razorpay", "refundRef": "RF_ORD_1001_1", "providerRefundId": "rfnd_PbY1c2D3e4F5g6", "status": "processed", "amount": 10000 }
```

Sending the identical call again returns the identical result from the idempotency store, with no second refund. Live mode is blocked unless the [double gate](#live_mutation_blocked) is satisfied:

```json
{ "provider": "razorpay", "order_ref": "ORD_1001", "refund_ref": "RF_ORD_1001_1", "provider_payment_id": "pay_PbX5aQ1zZ8Yw3T", "amount": 10000, "confirm": true }
```

## `payments_get_refund_status`

```json
{ "provider": "razorpay", "refund_ref": "RF_ORD_1001_1", "provider_refund_id": "rfnd_PbY1c2D3e4F5g6" }
```

```json
{ "provider": "razorpay", "refundRef": "RF_ORD_1001_1", "providerRefundId": "rfnd_PbY1c2D3e4F5g6", "status": "processed", "amount": 10000 }
```

---

## `payments_verify_webhook`

```json
{
  "provider": "razorpay",
  "headers": {
    "content-type": "application/json",
    "x-razorpay-event-id": "PbZ0aB1cD2eF3g",
    "x-razorpay-signature": "1c7e...44aa"
  },
  "raw_body": "{\"entity\":\"event\",\"account_id\":\"acc_Bx1\",\"event\":\"payment.captured\",\"contains\":[\"payment\"],\"payload\":{\"payment\":{\"entity\":{\"id\":\"pay_PbX5aQ1zZ8Yw3T\",\"amount\":49900,\"currency\":\"INR\",\"status\":\"captured\",\"order_id\":\"order_PbX4qJ7d2Kf9Lm\",\"method\":\"upi\",\"amount_refunded\":0,\"notes\":{\"order_ref\":\"ORD_1001\"},\"created_at\":1761645600}}},\"created_at\":1761645605}"
}
```

```json
{
  "provider": "razorpay",
  "id": "PbZ0aB1cD2eF3g",
  "type": "payment.succeeded",
  "providerEventType": "payment.captured",
  "orderRef": "ORD_1001",
  "providerOrderId": "order_PbX4qJ7d2Kf9Lm",
  "providerPaymentId": "pay_PbX5aQ1zZ8Yw3T",
  "status": "captured",
  "amount": 49900,
  "currency": "INR",
  "occurredAt": "2026-10-28T10:00:05.000Z"
}
```

## `payments_simulate_webhook`

```json
{ "provider": "razorpay", "type": "payment.succeeded", "order_ref": "ORD_1001", "amount": 49900, "target_url": "http://localhost:3000/webhooks/razorpay" }
```

```json
{
  "provider": "razorpay",
  "headers": {
    "content-type": "application/json",
    "x-razorpay-event-id": "evt_sim_6f1d0c2e-...",
    "x-razorpay-signature": "9a3b...0d1e"
  },
  "rawBody": "{\"entity\":\"event\",\"account_id\":\"acc_simulated\",\"event\":\"payment.captured\",...}",
  "description": "Razorpay payment.captured webhook signed with RAZORPAY_WEBHOOK_SECRET.",
  "curl": "curl -X POST 'http://localhost:3000/webhooks/razorpay' \\\n  -H 'content-type: application/json' \\\n  -H 'x-razorpay-event-id: evt_sim_...' \\\n  -H 'x-razorpay-signature: 9a3b...0d1e' \\\n  --data-binary '{\"entity\":\"event\",...}'"
}
```

---

## Customers, subscriptions, settlements

### `payments_create_customer`

```json
{ "provider": "razorpay", "name": "Asha Rao", "email": "asha@example.com", "phone": "9876543210" }
```

```json
{ "provider": "razorpay", "providerCustomerId": "cust_PbZ9yX8wV7uT6s" }
```

### `payments_create_subscription`

```json
{
  "provider": "razorpay",
  "subscription_ref": "SUB_ASHA_PRO",
  "plan": { "name": "Pro monthly", "amount": 49900, "interval": "month" },
  "total_count": 12,
  "provider_customer_id": "cust_PbZ9yX8wV7uT6s",
  "customer": { "name": "Asha Rao", "email": "asha@example.com", "phone": "9876543210" }
}
```

```json
{
  "provider": "razorpay",
  "subscriptionRef": "SUB_ASHA_PRO",
  "providerSubscriptionId": "sub_PbZAa1Bb2Cc3Dd",
  "status": "pending_authorization",
  "checkout": {
    "type": "js_sdk",
    "sdk": "razorpay",
    "scriptUrl": "https://checkout.razorpay.com/v1/checkout.js",
    "options": {
      "key": "rzp_test_1DP5mmOlF5G5ag",
      "subscription_id": "sub_PbZAa1Bb2Cc3Dd",
      "prefill": { "name": "Asha Rao", "email": "asha@example.com", "contact": "9876543210" }
    }
  }
}
```

### `payments_cancel_subscription`

```json
{ "provider": "razorpay", "provider_subscription_id": "sub_PbZAa1Bb2Cc3Dd", "at_cycle_end": true }
```

```json
{ "provider": "razorpay", "subscriptionRef": "SUB_ASHA_PRO", "providerSubscriptionId": "sub_PbZAa1Bb2Cc3Dd", "status": "active" }
```

`status` stays `active` until the cycle ends when `at_cycle_end` is true.

### `payments_list_settlements`

```json
{ "provider": "razorpay", "from": "2026-10-01", "to": "2026-10-27", "count": 10 }
```

```json
{
  "provider": "razorpay",
  "items": [
    { "id": "setl_PaQ1w2E3r4T5y6", "amount": 4870210, "currency": "INR", "status": "processed", "utr": "HDFCR52026102700123456", "settledAt": "2026-10-27T05:30:00.000Z", "fees": 99540, "tax": 17917 }
  ]
}
```

---

## `payments_generate_integration`

```json
{ "provider": "cashfree", "framework": "express", "features": ["checkout", "webhooks"] }
```

This returns the files to write (paths and contents), an env template and a test checklist. The exact shape is defined in `src/codegen/`.

---

## Errors

All errors share this envelope. Keys whose value is `undefined` are omitted.

### `UNSUPPORTED`: the gateway doesn't offer the feature

```json
{ "provider": "phonepe", "name": "Asha" }  // payments_create_customer
```

```json
{
  "error": "UNSUPPORTED",
  "message": "phonepe does not support customers. PhonePe PG has no customer object; prefill a phone number via providerOptions.prefillUserLoginDetails.",
  "retryable": false,
  "provider": "phonepe",
  "hint": "Call payments_get_capabilities to see what this gateway supports, or choose another gateway."
}
```

### `NOT_IMPLEMENTED`: the gateway has it, this project doesn't yet

```json
{
  "error": "NOT_IMPLEMENTED",
  "message": "cashfree offers subscriptions, but this adapter does not implement it yet.",
  "retryable": false,
  "provider": "cashfree",
  "hint": "Use providerOptions / the provider dashboard for now, or contribute it: see CONTRIBUTING.md."
}
```

### `LIVE_MUTATION_BLOCKED`

This happens through the MCP server (which creates its client with `guardLiveMutations: true`) in `PAYMENTS_MODE=live` when either `PAYMENTS_ALLOW_LIVE_MUTATIONS` is not true or `confirm` is not `true`:

```json
{
  "error": "LIVE_MUTATION_BLOCKED",
  "message": "Refund on razorpay in LIVE mode is blocked.",
  "retryable": false,
  "provider": "razorpay",
  "hint": "Set PAYMENTS_ALLOW_LIVE_MUTATIONS=true on the server AND pass confirm=true on the call after a human has approved it."
}
```

The audit log records it with `"outcome": "blocked"`.

### `IDEMPOTENCY_CONFLICT`

This happens when the same `order_ref` (the default idempotency key) is re-sent with a different amount:

```json
{
  "error": "IDEMPOTENCY_CONFLICT",
  "message": "Idempotency key \"ORD_1001\" was already used for a different razorpay:create_payment request.",
  "retryable": false,
  "hint": "Use a new idempotency key for a new request."
}
```

The same code is returned when a gateway answers HTTP 409.

### `VALIDATION`

```json
{
  "error": "VALIDATION",
  "message": "Razorpay status lookup needs providerOrderId (order_xxx) returned by createPayment.",
  "retryable": false,
  "provider": "razorpay",
  "hint": "Store providerOrderId next to your orderRef when you create the payment."
}
```

### `SIGNATURE_INVALID`

```json
{
  "error": "SIGNATURE_INVALID",
  "message": "Razorpay webhook signature mismatch.",
  "retryable": false,
  "provider": "razorpay",
  "hint": "Verify against the raw request body bytes, and use the webhook secret (not the API key secret)."
}
```

### `AUTH` / `TIMEOUT` (from the shared HTTP client)

```json
{
  "error": "AUTH",
  "message": "razorpay create_order failed (HTTP 401): Authentication failed",
  "retryable": false,
  "provider": "razorpay",
  "httpStatus": 401,
  "providerCode": "BAD_REQUEST_ERROR",
  "providerMessage": "Authentication failed",
  "hint": "Check the API credentials and that sandbox/live keys match PAYMENTS_MODE."
}
```

```json
{
  "error": "TIMEOUT",
  "message": "razorpay create_order: request timed out",
  "retryable": true,
  "provider": "razorpay",
  "hint": "The request may or may not have reached the gateway. Check payment status before retrying."
}
```

`retryable: true` on a create means **check status first**. See [reliability.md](reliability.md#playbook-timeout-on-create).

### `CONFIG_MISSING`

```json
{
  "error": "CONFIG_MISSING",
  "message": "Razorpay needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
  "retryable": false,
  "provider": "razorpay",
  "hint": "Dashboard > Account & Settings > API Keys. Use rzp_test_ keys in sandbox."
}
```
