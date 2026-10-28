import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PaymentsClient } from '../client.js';
import { FEATURE_KEYS } from '../core/capabilities.js';
import { PaymentError, toPaymentError } from '../core/errors.js';
import { PROVIDER_IDS, type ProviderId } from '../core/types.js';
import { generateIntegration, FRAMEWORKS } from '../codegen/index.js';
import { recommendGateways } from '../codegen/recommend.js';
import { allCapabilities } from '../providers/index.js';
import { supportMatrixMarkdown } from '../codegen/matrix.js';
import { VERSION } from '../version.js';

const provider = z.enum(PROVIDER_IDS).describe('Gateway id');
const paise = z.number().int().positive().describe('Integer minor units of the currency: paise for INR (Rs 499.00 = 49900), cents for USD (USD 1,250.00 = 125000)');
const ref = z.string().regex(/^[A-Za-z0-9_-]{3,40}$/).describe('Merchant reference: 3-40 chars, letters/digits/_/-');

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(data: unknown, note?: string): ToolResult {
  const text = JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text: note ? `${note}\n\n${text}` : text }] };
}

function fail(err: unknown): ToolResult {
  const pe = err instanceof PaymentError ? err : toPaymentError(err);
  return { content: [{ type: 'text', text: JSON.stringify(pe.toJSON(), null, 2) }], isError: true };
}

async function run(fn: () => Promise<unknown> | unknown, note?: string | ((r: unknown) => string | undefined)): Promise<ToolResult> {
  try {
    const result = await fn();
    return ok(result, typeof note === 'function' ? note(result) : note);
  } catch (err) {
    return fail(err);
  }
}

/** Drop the raw provider payload unless asked, to keep agent context small. */
function slim<T>(value: T, includeRaw: boolean | undefined): T {
  if (includeRaw || !value || typeof value !== 'object') return value;
  const { raw: _raw, ...rest } = value as Record<string, unknown>;
  return rest as T;
}

const includeRaw = z.boolean().optional().describe('Include the untouched provider response (verbose).');

export function createMcpServer(client: PaymentsClient = new PaymentsClient({ actor: 'mcp', guardLiveMutations: true })) {
  const server = new McpServer(
    { name: 'india-payments-mcp', version: VERSION },
    {
      instructions: [
        'One interface for Indian payment gateways: razorpay, payu, cashfree, ccavenue, paytm, phonepe, stripe, skydo.',
        `Current mode: ${client.mode}. In "mock" mode nothing touches the network; use payments_mock_complete_payment to simulate the customer.`,
        'Amounts are ALWAYS integers in the currency\'s minor unit: paise for INR, cents for USD/GBP/EUR (Skydo invoices are in the client\'s currency, never convert them to INR). Before building anything, call payments_get_capabilities for the chosen gateway and respect unsupported features.',
        'To write integration code for a project, call payments_generate_integration. Never put secret keys in client-side code.',
        'Refunds and subscription cancellations in live mode need PAYMENTS_ALLOW_LIVE_MUTATIONS=true and confirm=true, and must be approved by a human first.',
      ].join('\n'),
    },
  );

  // ---------- discovery ----------

  server.registerTool(
    'payments_list_providers',
    {
      title: 'List payment gateways',
      description: 'List every supported gateway with a one-line summary, whether credentials are configured, and the feature support matrix.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(() => ({
        mode: client.mode,
        providers: client.providers().map((id) => {
          const cap = client.capabilities(id);
          return {
            id,
            name: cap.displayName,
            summary: cap.summary,
            configured: client.mode === 'mock' ? true : client.configReport(id).ready,
            features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, cap.features[k].support])),
          };
        }),
      })),
  );

  server.registerTool(
    'payments_get_capabilities',
    {
      title: 'Gateway capabilities',
      description: 'Full capability map for one gateway: features (supported / partial / not_implemented / unsupported), payment methods, required env vars, hard constraints, official SDKs and platform plugins (Shopify, WooCommerce).',
      inputSchema: { provider },
      annotations: { readOnlyHint: true },
    },
    async ({ provider }) => run(() => client.capabilities(provider)),
  );

  server.registerTool(
    'payments_check_config',
    {
      title: 'Check configuration',
      description: 'Doctor: shows the mode and which environment variables are present or missing per gateway. Never returns secret values.',
      inputSchema: { provider: provider.optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ provider }) =>
      run(() => {
        const ids = provider ? [provider] : client.providers();
        return {
          mode: client.mode,
          allowLiveMutations: client.config.allowLiveMutations,
          auditLog: client.config.auditLogPath ?? null,
          providers: ids.map((id) => {
            const report = client.configReport(id);
            let initError: string | undefined;
            if (report.ready && client.mode !== 'mock') {
              try {
                client.gateway(id);
              } catch (e) {
                // CONFIG_MISSING from a gateway with no single required variable (Skydo: receiving
                // accounts and/or the Zoho bridge) means "not configured yet", not a broken setup.
                if (e instanceof PaymentError && e.code === 'CONFIG_MISSING') {
                  return { ...report, ready: false, setup: [e.message, e.hint].filter(Boolean).join(' ') };
                }
                initError = (e as Error).message;
              }
            }
            return { ...report, initError };
          }),
        };
      }),
  );

  server.registerTool(
    'payments_recommend_gateway',
    {
      title: 'Recommend a gateway',
      description: 'Rank gateways for a use case using the capability map (e.g. subscriptions, international payments, Shopify, lowest integration effort).',
      inputSchema: {
        needs: z
          .array(z.enum(['subscriptions', 'international', 'upi', 'refunds', 'settlements', 'shopify', 'woocommerce', 'mobile_sdk', 'webhooks', 'exporter_collections', 'fast_integration']))
          .describe('Requirements, most important first'),
        business: z.string().optional().describe('Free-text description of the business, for the explanation only'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ needs }) => run(() => recommendGateways(needs, allCapabilities())),
  );

  // ---------- payments ----------

  server.registerTool(
    'payments_create_payment',
    {
      title: 'Create payment',
      description:
        'Create an order / payment session. Returns `checkout`, which tells the frontend what to do: js_sdk (load script + options), redirect (send the browser to url), form_post (auto-submit a form with fields), or manual. Persist orderRef + providerOrderId.',
      inputSchema: {
        provider,
        order_ref: ref,
        amount: paise,
        currency: z.string().length(3).optional().describe('ISO 4217, default INR'),
        customer: z
          .object({ id: z.string().optional(), name: z.string().optional(), email: z.string().email().optional(), phone: z.string().optional() })
          .optional(),
        description: z.string().max(255).optional(),
        return_url: z.string().url().optional().describe('Browser redirect after payment (required for PayU, CCAvenue, Paytm, PhonePe, Stripe Checkout)'),
        notify_url: z.string().url().optional().describe('Server-to-server notification URL where the gateway takes it per request'),
        metadata: z.record(z.string(), z.string()).optional(),
        idempotency_key: z.string().max(64).optional().describe('Defaults to order_ref'),
        provider_options: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Provider-specific extra fields merged into the gateway request (e.g. Stripe flow, PhonePe expireAfter, Cashfree order_expiry_time). Fields that set the amount, order id, URLs or metadata, route money elsewhere (splits, transfers, connected accounts) or change capture are refused with VALIDATION.',
          ),
        include_raw: includeRaw,
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (a) =>
      run(
        async () =>
          slim(
            await client.createPayment(a.provider, {
              orderRef: a.order_ref,
              amount: a.amount,
              currency: a.currency,
              customer: a.customer,
              description: a.description,
              returnUrl: a.return_url,
              notifyUrl: a.notify_url,
              metadata: a.metadata,
              idempotencyKey: a.idempotency_key,
              providerOptions: a.provider_options,
            }),
            a.include_raw,
          ),
        () => (client.mode === 'mock' ? 'MOCK MODE: simulate the customer with payments_mock_complete_payment.' : undefined),
      ),
  );

  server.registerTool(
    'payments_verify_payment',
    {
      title: 'Verify payment callback',
      description:
        'Verify the payload the browser/app received after checkout (Razorpay handler response, PayU/CCAvenue/Paytm POST-back, etc.). Fulfil ONLY when paid=true: the callback is genuine, bound to order_ref and expected_amount, and the money is captured (status captured or partially_refunded). status=authorized (authorised, not captured) and status=refunded are NOT paid. valid=true just means the callback is genuine; a genuine failure is still valid. For gateways that do not sign callbacks it confirms through the status API.',
      inputSchema: {
        provider,
        payload: z.record(z.string(), z.string()).describe('Callback fields exactly as received'),
        order_ref: ref.describe('The order you expect this callback to be for (from your own database)'),
        expected_amount: paise.describe('The amount you stored for that order, in minor units of its currency'),
        provider_order_id: z.string().optional().describe('providerOrderId you stored from payments_create_payment (Razorpay order_/sub_ id). Recommended.'),
        include_raw: includeRaw,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) =>
      run(async () =>
        slim(await client.verifyPayment(a.provider, { payload: a.payload, orderRef: a.order_ref, expectedAmount: a.expected_amount, providerOrderId: a.provider_order_id }), a.include_raw),
      ),
  );

  server.registerTool(
    'payments_get_status',
    {
      title: 'Payment status',
      description: 'Fetch the authoritative payment status from the gateway (source of truth for reconciliation). Razorpay and Stripe need provider_order_id; CCAvenue accepts provider_payment_id (reference_no).',
      inputSchema: {
        provider,
        order_ref: ref,
        provider_order_id: z.string().optional().describe('providerOrderId from payments_create_payment (Razorpay order_..., Stripe cs_/pi_...). Required for Razorpay and Stripe.'),
        provider_payment_id: z.string().optional().describe('Optional gateway payment id (CCAvenue reference_no / tracking_id).'),
        include_raw: includeRaw,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) =>
      run(async () =>
        slim(await client.getPaymentStatus(a.provider, { orderRef: a.order_ref, providerOrderId: a.provider_order_id, providerPaymentId: a.provider_payment_id }), a.include_raw),
      ),
  );

  server.registerTool(
    'payments_refund',
    {
      title: 'Refund payment',
      description:
        'Refund all or part of a captured payment. refund_ref is the idempotency key: within this server process (24 h) re-sending it returns the stored refund, and if the gateway reports the refund_ref as a duplicate or the outcome is unknown, the existing refund is looked up by refund_ref and returned where the gateway supports that (Razorpay, Cashfree, Paytm, PhonePe, Stripe). Across restarts, and on PayU / CCAvenue, a repeat can fail instead of returning the earlier refund. If a call fails with OUTCOME_UNKNOWN, check payments_get_refund_status / payments_get_status BEFORE retrying, and never retry with a new refund_ref. Razorpay, PayU, Paytm, CCAvenue and Stripe need provider_payment_id. In live mode this moves real money: ask the human first, then pass confirm=true.',
      inputSchema: {
        provider,
        order_ref: ref,
        refund_ref: ref,
        provider_payment_id: z.string().optional(),
        amount: paise.optional().describe('Omit for full refund'),
        reason: z.string().max(255).optional(),
        speed: z.enum(['normal', 'instant']).optional(),
        confirm: z.boolean().optional().describe('Required (true) in live mode, after human approval'),
        include_raw: includeRaw,
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (a) =>
      run(async () =>
        slim(
          await client.refund(
            a.provider,
            { orderRef: a.order_ref, refundRef: a.refund_ref, providerPaymentId: a.provider_payment_id, amount: a.amount, reason: a.reason, speed: a.speed },
            { confirm: a.confirm },
          ),
          a.include_raw,
        ),
      ),
  );

  server.registerTool(
    'payments_get_refund_status',
    {
      title: 'Refund status',
      description:
        'Fetch refund status from the gateway. Ids needed per gateway: Razorpay: provider_refund_id (rfnd_...), or provider_payment_id (pay_...) to find it by refund_ref. PayU: provider_refund_id (the request_id returned by payments_refund). Cashfree and Paytm: order_ref + refund_ref. PhonePe: refund_ref. Stripe: provider_refund_id (re_...) or provider_payment_id (pi_/ch_...). CCAvenue: not available (check the dashboard).',
      inputSchema: {
        provider,
        refund_ref: ref,
        order_ref: ref.optional(),
        provider_refund_id: z.string().optional(),
        provider_payment_id: z.string().optional(),
        include_raw: includeRaw,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) =>
      run(async () =>
        slim(
          await client.getRefundStatus(a.provider, {
            refundRef: a.refund_ref,
            orderRef: a.order_ref,
            providerRefundId: a.provider_refund_id,
            providerPaymentId: a.provider_payment_id,
          }),
          a.include_raw,
        ),
      ),
  );

  // ---------- webhooks ----------

  server.registerTool(
    'payments_verify_webhook',
    {
      title: 'Verify webhook',
      description: 'Verify a webhook signature and normalise it into a common event (payment.succeeded, refund.processed, ...). Pass the RAW body string exactly as received.',
      inputSchema: {
        provider,
        headers: z.record(z.string(), z.string()),
        raw_body: z.string(),
        include_raw: includeRaw,
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => run(async () => slim(await client.parseWebhook(a.provider, { headers: a.headers, rawBody: a.raw_body }), a.include_raw)),
  );

  server.registerTool(
    'payments_simulate_webhook',
    {
      title: 'Simulate webhook',
      description:
        'Produce a correctly signed webhook (headers + raw body) for local testing. In sandbox mode it uses the provider\'s real signing scheme and your webhook secret; replay it with curl against your LOCAL endpoint. Disabled in live mode. Never reuse sandbox webhook secrets in production.',
      inputSchema: {
        provider,
        type: z.enum(['payment.succeeded', 'payment.failed', 'refund.processed']),
        order_ref: ref,
        amount: paise,
        currency: z.string().length(3).optional(),
        provider_payment_id: z.string().optional(),
        refund_ref: ref.optional(),
        target_url: z.string().url().optional().describe('If given, the response includes a ready-to-run curl command'),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) =>
      run(async () => {
        const hook = await client.simulateWebhook(a.provider, {
          type: a.type,
          orderRef: a.order_ref,
          amount: a.amount,
          currency: a.currency,
          providerPaymentId: a.provider_payment_id,
          refundRef: a.refund_ref,
        });
        const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
        const curl = a.target_url
          ? [`curl -X POST ${q(a.target_url)}`, ...Object.entries(hook.headers).map(([k, v]) => `  -H ${q(`${k}: ${v}`)}`), `  --data-binary ${q(hook.rawBody)}`].join(' \\\n')
          : undefined;
        return { ...hook, curl };
      }),
  );

  // ---------- customers, subscriptions, settlements ----------

  server.registerTool(
    'payments_create_customer',
    {
      title: 'Create customer',
      description: 'Create a customer record on gateways that have one (Razorpay, Stripe).',
      inputSchema: {
        provider,
        name: z.string().optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        metadata: z.record(z.string(), z.string()).optional(),
      },
      annotations: { openWorldHint: true },
    },
    async (a) => run(async () => slim(await client.createCustomer(a.provider, { name: a.name, email: a.email, phone: a.phone, metadata: a.metadata }), false)),
  );

  server.registerTool(
    'payments_create_subscription',
    {
      title: 'Create subscription',
      description: 'Create a recurring subscription (UPI Autopay / card e-mandate). Returns a checkout action the customer must complete to authorise the mandate.',
      inputSchema: {
        provider,
        subscription_ref: ref,
        provider_plan_id: z.string().optional(),
        plan: z
          .object({
            name: z.string(),
            amount: paise,
            currency: z.string().length(3).optional(),
            interval: z.enum(['day', 'week', 'month', 'year']),
            interval_count: z.number().int().positive().optional(),
          })
          .optional(),
        customer: z.object({ name: z.string().optional(), email: z.string().email().optional(), phone: z.string().optional() }).optional(),
        provider_customer_id: z.string().optional(),
        total_count: z.number().int().positive().optional().describe('Billing cycles (Razorpay requires it)'),
        return_url: z.string().url().optional(),
        metadata: z.record(z.string(), z.string()).optional(),
        provider_options: z.record(z.string(), z.unknown()).optional(),
        include_raw: includeRaw,
      },
      annotations: { openWorldHint: true },
    },
    async (a) =>
      run(async () =>
        slim(
          await client.createSubscription(a.provider, {
            subscriptionRef: a.subscription_ref,
            providerPlanId: a.provider_plan_id,
            plan: a.plan ? { name: a.plan.name, amount: a.plan.amount, currency: a.plan.currency, interval: a.plan.interval, intervalCount: a.plan.interval_count } : undefined,
            customer: a.customer,
            providerCustomerId: a.provider_customer_id,
            totalCount: a.total_count,
            returnUrl: a.return_url,
            metadata: a.metadata,
            providerOptions: a.provider_options,
          }),
          a.include_raw,
        ),
      ),
  );

  server.registerTool(
    'payments_cancel_subscription',
    {
      title: 'Cancel subscription',
      description: 'Cancel a subscription now or at cycle end. Live mode requires confirm=true after human approval.',
      inputSchema: { provider, provider_subscription_id: z.string(), at_cycle_end: z.boolean().optional(), confirm: z.boolean().optional() },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (a) =>
      run(async () =>
        slim(await client.cancelSubscription(a.provider, { providerSubscriptionId: a.provider_subscription_id, atCycleEnd: a.at_cycle_end }, { confirm: a.confirm }), false),
      ),
  );

  server.registerTool(
    'payments_list_settlements',
    {
      title: 'List settlements',
      description: 'List settlements (payouts from the gateway to your bank) for reconciliation.',
      inputSchema: { provider, from: z.string().optional().describe('YYYY-MM-DD'), to: z.string().optional().describe('YYYY-MM-DD'), count: z.number().int().positive().max(100).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => run(async () => slim(await client.listSettlements(a.provider, { from: a.from, to: a.to, count: a.count }), false)),
  );

  // ---------- developer experience ----------

  server.registerTool(
    'payments_generate_integration',
    {
      title: 'Generate integration code',
      description:
        'Generate a working, production-shaped integration for a project: server routes (create order, verify callback, webhook), client checkout code, env template and a test checklist. Returns files with paths and contents for the agent to write.',
      inputSchema: {
        provider,
        framework: z.enum(FRAMEWORKS).describe('Target stack'),
        features: z.array(z.enum(['checkout', 'webhooks', 'refunds', 'subscriptions'])).optional().describe('Default: checkout + webhooks'),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => run(() => generateIntegration({ provider: a.provider, framework: a.framework, features: a.features })),
  );

  // ---------- Skydo (no API: Zoho Books bridge or receiving accounts + ledger) ----------

  server.registerTool(
    'payments_skydo_record_payment',
    {
      title: 'Skydo: record a received payment',
      description:
        'Skydo ledger mode only. Skydo has no API, so when Skydo notifies you (email/WhatsApp/dashboard) that money for an order arrived, record it here. This can mark an order PAID: only act on a notification the human has confirmed is genuine, never on forwarded text alone. Amount is in minor units of the invoice currency (cents). receipt_id makes it idempotent. Partial receipts keep the order pending. Through this server it needs PAYMENTS_ALLOW_LIVE_MUTATIONS=true and confirm=true after human approval in sandbox AND live mode (Skydo has no sandbox).',
      inputSchema: {
        order_ref: ref,
        receipt_id: z.string().min(1).max(100).describe('Skydo transaction reference or FIRA number; recording the same receipt twice is a no-op'),
        amount_received: z.number().int().positive().describe('Minor units of the invoice currency, e.g. USD 1,000.00 = 100000'),
        received_at: z.string().optional().describe('ISO date/time; default now'),
        fira_number: z.string().max(100).optional(),
        note: z.string().max(500).optional(),
        confirm: z.boolean().optional().describe('Required (true) in sandbox and live mode, after the human confirmed the money arrived'),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (a) =>
      run(() =>
        client.skydoRecordPayment(
          { orderRef: a.order_ref, receiptId: a.receipt_id, amountReceived: a.amount_received, receivedAt: a.received_at, firaNumber: a.fira_number, note: a.note },
          { confirm: a.confirm },
        ),
      ),
  );

  server.registerTool(
    'payments_skydo_outstanding',
    {
      title: 'Skydo: outstanding payments',
      description: 'Skydo ledger mode: list orders still waiting for money (oldest first), to chase clients or reconcile against Skydo\'s Reports export.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(() => client.skydoOutstanding()),
  );

  server.registerTool(
    'payments_mock_complete_payment',
    {
      title: 'Mock: complete payment',
      description: 'MOCK MODE ONLY. Simulate the customer finishing checkout. Returns a signed callback payload (feed it to payments_verify_payment) and the updated payment.',
      inputSchema: { provider, order_ref: ref, outcome: z.enum(['success', 'failure']), method: z.string().optional() },
      annotations: { readOnlyHint: false },
    },
    async (a) => run(() => client.mockGateway(a.provider).complete(a.order_ref, a.outcome, a.method)),
  );

  // ---------- resources ----------

  server.registerResource(
    'support-matrix',
    'payments://matrix',
    { title: 'Gateway support matrix', description: 'Feature support across all gateways (Markdown)', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: supportMatrixMarkdown(allCapabilities()) }] }),
  );

  server.registerResource(
    'provider-capabilities',
    new ResourceTemplate('payments://providers/{provider}', {
      list: async () => ({
        resources: PROVIDER_IDS.map((id) => ({ uri: `payments://providers/${id}`, name: `${id} capabilities`, mimeType: 'application/json' })),
      }),
    }),
    { title: 'Provider capabilities', description: 'Capability map for one gateway (JSON)', mimeType: 'application/json' },
    async (uri, vars) => {
      const id = String(vars.provider) as ProviderId;
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(client.capabilities(id), null, 2) }] };
    },
  );

  // ---------- prompts ----------

  server.registerPrompt(
    'integrate_payments',
    {
      title: 'Integrate a payment gateway',
      description: 'Step-by-step plan for adding a gateway to the current project.',
      argsSchema: { provider: z.string().describe('razorpay, payu, cashfree, ccavenue, paytm, phonepe, stripe or skydo'), framework: z.string().describe('express, nextjs, ...') },
    },
    ({ provider, framework }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Add ${provider} payments to this ${framework} project.`,
              `1. Call payments_get_capabilities for ${provider}; list any constraints that affect this project.`,
              `2. Call payments_generate_integration with provider=${provider} framework=${framework}, then write the files, adapting paths to the project.`,
              '3. Add the env vars to .env.example (never commit real secrets).',
              '4. Run the flow in PAYMENTS_MODE=mock, then sandbox: create payment, complete, verify, simulate the webhook against the local endpoint.',
              '5. Report what was added and what the human must do in the gateway dashboard (webhook URL, secrets, KYC, enabling methods).',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}
