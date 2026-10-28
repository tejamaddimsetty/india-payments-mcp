# Next.js App Router example (Razorpay)

Drop-in route handlers and a client component for the Next.js App Router. These files are the
literal output of:

```
payments_generate_integration { "provider": "razorpay", "framework": "nextjs", "features": ["checkout", "webhooks", "refunds"] }
```

Run the same tool with another `provider` (payu, cashfree, ccavenue, paytm, phonepe, stripe) to get
that gateway's version. Only `lib/payments.ts` (one constant), `lib/start-checkout.ts` (the browser SDK
branch) and `.env.example` change between gateways.

## Files

| File | What it does |
|---|---|
| `lib/payments.ts` | The payments service: one SDK client (cached on `globalThis` for dev hot reload), server-side pricing (`getOrderAmount`), verification, idempotent fulfilment, webhook handler, admin refund. All routes call into it. |
| `app/api/payments/create/route.ts` | `POST { orderId }` → `CheckoutAction`. The amount comes from `getOrderAmount`, never from the request. |
| `app/api/payments/callback/route.ts` | `GET`/`POST` return URL. Reads query + form/JSON body, verifies against the stored attempt (orderRef + amount), re-checks status, then 303 to `/checkout`. |
| `app/api/payments/webhook/route.ts` | Reads `await req.text()` (raw bytes) and hands it to `createWebhookHandler`. Never `req.json()` before verifying. |
| `app/api/payments/refund/route.ts` | Admin-only refund. `assertAdmin` is a bearer-token placeholder: swap in your auth. |
| `app/api/payments/mock-complete/route.ts` | Dev only (404 unless `PAYMENTS_MODE=mock`): simulates the customer paying. |
| `lib/start-checkout.ts` | Browser side: renders the `CheckoutAction` (Razorpay modal, redirect, form post, mock dialog). |
| `components/CheckoutButton.tsx` | `'use client'` component + `useCheckout()` hook. |
| `app/checkout/page.tsx` | Demo page and result page. |

## Use it in your app

```bash
npm install india-payments-mcp
cp -r app/api/payments <your-app>/app/api/
cp lib/payments.ts lib/start-checkout.ts <your-app>/lib/
cp components/CheckoutButton.tsx <your-app>/components/
cp .env.example <your-app>/.env.local      # then fill it in
```

All routes declare `runtime = 'nodejs'` (the SDK uses `node:crypto`) and `dynamic = 'force-dynamic'`.

### Mock mode first

```bash
PAYMENTS_MODE=mock PUBLIC_BASE_URL=http://localhost:3000 npm run dev
```

Open `/checkout`, click **Pay now**, choose success or failure in the dialog. The result runs through
the same verification code path a real Razorpay return takes.

### Then sandbox

Set `PAYMENTS_MODE=sandbox`, the `RAZORPAY_*` test keys and `PUBLIC_BASE_URL` (a tunnel URL such as
`https://<id>.trycloudflare.com`), add a webhook to `<PUBLIC_BASE_URL>/api/payments/webhook` for
`payment.captured, payment.failed, order.paid, refund.processed, refund.failed`, and pay with a test
card or UPI id.

## Before production

- Replace the in-memory `attempts` map and `DEMO_ORDERS` in `lib/payments.ts` with your database.
  Serverless instances do not share memory, so the in-memory version loses state between requests.
- Back the webhook dedupe store with Redis/Postgres (`createWebhookHandler({ dedupe })`).
- Replace `assertAdmin` with a real role check: it is the only thing standing between the internet and refunds.
