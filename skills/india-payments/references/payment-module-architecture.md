# Reference payment module architecture

Gateway-agnostic design for an app that sells something and takes money through an Indian gateway. Adapt names to the project's ORM; keep the constraints.

## Modules

```
payments/
  gateway/<provider>.ts     # the ONLY code that knows the gateway: create, verify, status, refund, parseWebhook
  service.ts                # createAttempt, confirmAttempt, refund, applyWebhookEvent (owns the state machine)
  routes.ts                 # POST /payments/attempts, POST|GET /payments/return/:provider, POST /webhooks/:provider, admin refund
  reconcile.ts              # scheduled job
  pricing.ts                # server-side amount computation (or reuse the existing cart/pricing code)
```

Routes never call the gateway directly; they call `service`. `service` never parses gateway payloads; it receives normalised results from `gateway/*`. With the `india-payments-mcp` npm package, `PaymentsClient` plays the role of `gateway/*`.

## Tables (PostgreSQL DDL)

```sql
-- Business order: what the customer is buying. One order, many payment attempts.
CREATE TABLE orders (
  id               BIGSERIAL PRIMARY KEY,
  public_id        TEXT        NOT NULL UNIQUE,              -- shown to the customer, e.g. ord_8Kq2
  customer_id      BIGINT      NOT NULL,
  amount_paise     BIGINT      NOT NULL CHECK (amount_paise > 0),   -- computed by the server
  currency         CHAR(3)     NOT NULL DEFAULT 'INR',
  status           TEXT        NOT NULL DEFAULT 'pending_payment'
                   CHECK (status IN ('pending_payment','paid','fulfilled','cancelled','refunded','partially_refunded')),
  paid_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per call to the gateway's "create order/session". attempt_ref is what the gateway sees.
CREATE TABLE payment_attempts (
  id                   BIGSERIAL PRIMARY KEY,
  order_id             BIGINT      NOT NULL REFERENCES orders(id),
  provider             TEXT        NOT NULL,                  -- razorpay | payu | cashfree | ...
  attempt_ref          TEXT        NOT NULL UNIQUE            -- orderRef sent to the gateway, [A-Za-z0-9_-]{3,40}
                       CHECK (attempt_ref ~ '^[A-Za-z0-9_-]{3,40}$'),
  provider_order_id    TEXT,                                  -- order_xxx, cf_order_id, session id, ...
  provider_payment_id  TEXT,                                  -- pay_xxx, mihpayid, TXNID, tracking_id, ...
  amount_paise         BIGINT      NOT NULL CHECK (amount_paise > 0),  -- copied from orders at creation; never from client
  currency             CHAR(3)     NOT NULL DEFAULT 'INR',
  status               TEXT        NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created','pending','authorized','captured','failed','cancelled','expired')),
  method               TEXT,                                  -- upi | card | netbanking | wallet | ...
  failure_reason       TEXT,
  verified_via         TEXT CHECK (verified_via IN ('signature','status_api','decryption','webhook','manual')),
  amount_refunded_paise BIGINT     NOT NULL DEFAULT 0 CHECK (amount_refunded_paise >= 0),
  expires_at           TIMESTAMPTZ,
  last_checked_at      TIMESTAMPTZ,                           -- reconciliation bookkeeping
  raw_last             JSONB,                                 -- last provider payload, secrets stripped
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount_refunded_paise <= amount_paise)
);
CREATE INDEX payment_attempts_order_idx ON payment_attempts(order_id);
CREATE UNIQUE INDEX payment_attempts_provider_payment_uq ON payment_attempts(provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX payment_attempts_open_idx ON payment_attempts(status, created_at) WHERE status IN ('created','pending','authorized');
-- At most one successful attempt per order:
CREATE UNIQUE INDEX payment_attempts_one_capture_uq ON payment_attempts(order_id) WHERE status = 'captured';

CREATE TABLE refunds (
  id                 BIGSERIAL PRIMARY KEY,
  attempt_id         BIGINT      NOT NULL REFERENCES payment_attempts(id),
  refund_ref         TEXT        NOT NULL UNIQUE,              -- idempotency key, generated ONCE, reused on retry
  provider_refund_id TEXT,
  amount_paise       BIGINT      NOT NULL CHECK (amount_paise > 0),
  status             TEXT        NOT NULL DEFAULT 'requested'
                     CHECK (status IN ('requested','pending','processed','failed')),
  reason             TEXT,
  requested_by       TEXT        NOT NULL,                     -- admin user id; refunds are human-approved
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refunds_open_idx ON refunds(status, created_at) WHERE status IN ('requested','pending');

-- Every webhook delivery we accepted. The UNIQUE constraint is the dedupe.
CREATE TABLE webhook_events (
  id             BIGSERIAL PRIMARY KEY,
  provider       TEXT        NOT NULL,
  event_id       TEXT        NOT NULL,     -- x-razorpay-event-id, Stripe event.id, or a derived key (provider+type+ref)
  event_type     TEXT        NOT NULL,
  attempt_ref    TEXT,
  payload        JSONB       NOT NULL,     -- parsed body for debugging; verification already ran on raw bytes
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  error          TEXT,
  UNIQUE (provider, event_id)
);
```

MySQL: replace `BIGSERIAL` with `BIGINT AUTO_INCREMENT`, `TIMESTAMPTZ` with `DATETIME(6)` (store UTC), `JSONB` with `JSON`, and enforce partial unique indexes in application code or with generated columns.

Gateways without an event id (PayU, Paytm, PhonePe, CCAvenue): derive `event_id = sha256(provider + event_type + attempt_ref + provider_payment_id + status)`. Repeats of the same fact dedupe; a genuinely new state (refund after capture) gets a new key.

## State machine (payment_attempts.status)

```
created ──► pending ──► captured ──► (refunds tracked separately; amount_refunded_paise)
   │           │  ▲         ▲
   │           │  └─ authorized ┘  (manual-capture card flows; capture or it auto-reverses)
   │           ├──► failed
   ├──► expired (gateway order/session/token expired with no payment)
   └──► cancelled (user aborted, confirmed by gateway)
```

Rules:

- Transitions only move forward. `captured`, `failed`, `expired`, `cancelled` are terminal for the attempt, with one exception: a "late success" (gateway reports `captured` after you marked `failed`/`expired` on a timeout). Accept it: money was taken. Mark captured, and if the order was already paid via another attempt, auto-refund this one (needs human approval in live mode) and alert.
- Apply every transition with a guarded update and act only if a row changed:

```sql
UPDATE payment_attempts
   SET status = 'captured', provider_payment_id = $2, verified_via = $3, updated_at = now()
 WHERE attempt_ref = $1 AND status IN ('created','pending','authorized')
RETURNING order_id;
-- 0 rows => already handled (or terminal): do nothing, return success to the caller.
```

- In the same transaction: `UPDATE orders SET status='paid', paid_at=now() WHERE id=$order AND status='pending_payment'`, then enqueue fulfilment (outbox row), never call email/shipping inline inside the payment transaction.
- Before any transition to `captured`, check `verified_amount == attempt.amount_paise` and currency. Mismatch: do not fulfil, set `failure_reason='amount_mismatch'`, alert.

## Flows

**Create attempt** (`POST /payments/attempts {orderPublicId}`):
1. Load order (owned by the caller), status must be `pending_payment`.
2. If an attempt for this order is `pending` (UPI in flight), return it instead of creating a new one, unless the client explicitly retries after it's resolved.
3. Insert attempt with `attempt_ref = <order public id>_<n>` (unique), `amount_paise = order.amount_paise`.
4. Call gateway create with idempotency key = `attempt_ref`. Store `provider_order_id`. Return only the checkout action (publishable values).

**Return/callback** (`/payments/return/:provider`): verify (signature or status API), guarded update, redirect to a result page that reads the order status from your DB. If not yet captured, show "processing" and poll your own API.

**Webhook** (`POST /webhooks/:provider`):
1. Raw body. Verify. Bad signature → 400.
2. `INSERT INTO webhook_events … ON CONFLICT (provider, event_id) DO NOTHING`. Then `SELECT … FOR UPDATE` the row: if `processed_at IS NOT NULL` → 200 (duplicate, stop). If it exists but is unprocessed (an earlier delivery failed), process it now.
3. For unsigned/weakly-signed gateways (PhonePe, CCAvenue), call the status API now and use that result.
4. Apply the transition and set `processed_at` in the same transaction. On exception: roll back, record `error` in a separate statement, return 5xx so the gateway retries.
5. Return 2xx within a few seconds; heavy work goes to a queue (outbox).

**Refund** (admin only):
1. Lock the attempt row (`SELECT … FOR UPDATE`). Check `amount <= amount_paise - amount_refunded_paise - sum(open refunds)`.
2. Insert `refunds` row with a fresh `refund_ref` (`rf_<attemptid>_<n>`; PayU needs ≤23 chars). Commit.
3. Call gateway refund with `refund_ref`. On network error, retry **with the same refund_ref**. Never generate a new ref for a retry.
4. On `processed` (sync or via webhook / status poll): increment `amount_refunded_paise`, update order status.

## Reconciliation job

Every 5–15 minutes:

```sql
SELECT * FROM payment_attempts
 WHERE status IN ('created','pending','authorized')
   AND created_at < now() - interval '10 minutes'
   AND (last_checked_at IS NULL OR last_checked_at < now() - interval '10 minutes')
 ORDER BY created_at LIMIT 200;
```

For each: call status API (`payments_get_status` / `client.getPaymentStatus`), apply the same guarded transition, set `last_checked_at`. After the gateway's expiry window plus a margin (e.g. 24h) with no payment: mark `expired`. Same loop for `refunds` in `requested`/`pending`.

Daily: pull settlements (`payments_list_settlements` where supported, otherwise the dashboard report), match settled payment ids to captured attempts, and flag: captured but never settled, settled but unknown to you, amount mismatches (fees/tax are expected differences; record them).

Alert on: attempts stuck `pending` > 24h, amount mismatches, late successes on already-paid orders, webhook signature failures spike, refunds stuck `pending` > the gateway's SLA.

## Idempotency summary

| Operation | Key | Enforcement |
|---|---|---|
| Create gateway order | `attempt_ref` | UNIQUE column + gateway idempotency header where supported |
| Mark paid | `attempt_ref` + status guard | conditional UPDATE, partial unique index on captured |
| Webhook | `(provider, event_id)` | UNIQUE constraint |
| Refund | `refund_ref` | UNIQUE column, reuse on retry, gateway-side de-dup (Razorpay receipt, Cashfree refund_id, PayU token_id, Paytm refId, PhonePe merchantRefundId) |
| Fulfilment | `order_id` | order status guard + outbox |
