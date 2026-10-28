/**
 * End-to-end: start the real CLI as a child process and drive it over stdio with the official MCP
 * client, exactly as Claude Code / Claude Desktop / Cursor would. Every tool is called at least once.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function start(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/cli.ts'],
    // Only what the server needs: no gateway keys leak in from the developer's shell.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PAYMENTS_LOG_LEVEL: 'error', ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(transport);
  return client;
}

/** Tool output is JSON, optionally preceded by a one-line note. */
function body(r: unknown): any {
  const text = (r as Result).content[0]!.text;
  const start = text.indexOf('{');
  return JSON.parse(text.slice(start));
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as Result;
  return { isError: r.isError === true, data: body(r) };
}

describe('MCP server over stdio (mock mode)', () => {
  let client: Client;
  beforeAll(async () => {
    client = await start({ PAYMENTS_MODE: 'mock' });
  }, 30_000);
  afterAll(async () => {
    await client?.close();
  });

  it('lists exactly the 19 documented tools, resources and the prompt', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'payments_list_providers', 'payments_get_capabilities', 'payments_check_config', 'payments_recommend_gateway',
        'payments_create_payment', 'payments_verify_payment', 'payments_get_status', 'payments_refund',
        'payments_get_refund_status', 'payments_verify_webhook', 'payments_simulate_webhook', 'payments_create_customer',
        'payments_create_subscription', 'payments_cancel_subscription', 'payments_list_settlements',
        'payments_generate_integration', 'payments_mock_complete_payment', 'payments_skydo_record_payment', 'payments_skydo_outstanding',
      ].sort(),
    );
    for (const t of tools) expect(t.description && t.description.length > 20).toBe(true);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('payments://matrix');
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((r) => r.uriTemplate)).toContain('payments://providers/{provider}');
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('integrate_payments');
  });

  it('discovery tools', async () => {
    const list = await call(client, 'payments_list_providers', {});
    expect(list.data.providers).toHaveLength(8);
    const caps = await call(client, 'payments_get_capabilities', { provider: 'skydo' });
    expect(caps.data.features.createPayment.support).toBe('partial');
    expect(caps.data.features.webhooks.support).toBe('unsupported');
    const cfg = await call(client, 'payments_check_config', {});
    expect(cfg.data.mode).toBe('mock');
    const rec = await call(client, 'payments_recommend_gateway', { needs: ['exporter_collections'] });
    expect(rec.data.ranking[0].provider).toBe('skydo');
    const matrix = await client.readResource({ uri: 'payments://matrix' });
    expect(String((matrix.contents[0] as { text: string }).text)).toContain('| createPayment |');
    const prov = await client.readResource({ uri: 'payments://providers/razorpay' });
    expect(JSON.parse(String((prov.contents[0] as { text: string }).text)).provider).toBe('razorpay');
    const prompt = await client.getPrompt({ name: 'integrate_payments', arguments: { provider: 'cashfree', framework: 'nextjs' } });
    expect(JSON.stringify(prompt.messages)).toContain('payments_generate_integration');
  });

  it.each(['razorpay', 'payu', 'cashfree', 'ccavenue', 'paytm', 'phonepe', 'stripe'])(
    'full payment lifecycle for %s: create -> pay -> verify -> status -> refund -> refund status -> webhook',
    async (provider) => {
      const ref = `e2e_${provider}_${Date.now()}`;
      const created = await call(client, 'payments_create_payment', {
        provider, order_ref: ref, amount: 49900,
        customer: { name: 'Asha', email: 'asha@example.com', phone: '9876543210' },
        return_url: 'https://shop.example.com/return',
      });
      expect(created.isError).toBe(false);
      expect(created.data).toMatchObject({ provider, orderRef: ref, amount: 49900, status: 'created' });

      const done = await call(client, 'payments_mock_complete_payment', { provider, order_ref: ref, outcome: 'success' });
      const payload = done.data.callbackPayload;

      const verified = await call(client, 'payments_verify_payment', { provider, payload, order_ref: ref, expected_amount: 49900 });
      expect(verified.data).toMatchObject({ valid: true, paid: true, status: 'captured' });
      const wrongAmount = await call(client, 'payments_verify_payment', { provider, payload, order_ref: ref, expected_amount: 100 });
      expect(wrongAmount.data.paid).toBe(false);

      // Ids are passed exactly as the real adapters require them (the mock enforces the same rules).
      const ids = { provider_order_id: created.data.providerOrderId };
      const status = await call(client, 'payments_get_status', { provider, order_ref: ref, ...ids });
      expect(status.data.status).toBe('captured');
      const paymentId = status.data.providerPaymentId;
      expect(paymentId).toBeTruthy();

      const refund = await call(client, 'payments_refund', { provider, order_ref: ref, refund_ref: `rf_${provider}`, amount: 9900, provider_payment_id: paymentId });
      expect(refund.data).toMatchObject({ status: 'processed', amount: 9900 });
      const again = await call(client, 'payments_refund', { provider, order_ref: ref, refund_ref: `rf_${provider}`, amount: 9900, provider_payment_id: paymentId });
      expect(again.data.providerRefundId).toBe(refund.data.providerRefundId);
      expect((await call(client, 'payments_get_status', { provider, order_ref: ref, ...ids })).data.status).toBe('partially_refunded');
      const rs = await call(client, 'payments_get_refund_status', { provider, refund_ref: `rf_${provider}`, order_ref: ref });
      if (provider === 'ccavenue') {
        // CCAvenue refund status is not implemented: the server must say so rather than guess.
        expect(rs).toMatchObject({ isError: true, data: { error: 'NOT_IMPLEMENTED' } });
      } else {
        expect(rs.data.status).toBe('processed');
      }

      const hook = await call(client, 'payments_simulate_webhook', {
        provider, type: 'payment.succeeded', order_ref: ref, amount: 49900, target_url: 'http://localhost:3000/api/payments/webhook',
      });
      expect(hook.data.curl).toContain("curl -X POST 'http://localhost:3000/api/payments/webhook'");
      const event = await call(client, 'payments_verify_webhook', { provider, headers: hook.data.headers, raw_body: hook.data.rawBody });
      expect(event.data).toMatchObject({ type: 'payment.succeeded', orderRef: ref });
      const tampered = await call(client, 'payments_verify_webhook', { provider, headers: hook.data.headers, raw_body: hook.data.rawBody.replace('49900', '1') });
      expect(tampered.isError).toBe(true);
      expect(tampered.data.error).toBe('SIGNATURE_INVALID');
    },
  );

  it('customers, subscriptions and settlements where the gateway supports them', async () => {
    expect((await call(client, 'payments_create_customer', { provider: 'razorpay', name: 'Asha', email: 'a@example.com' })).isError).toBe(false);
    const sub = await call(client, 'payments_create_subscription', {
      provider: 'razorpay', subscription_ref: 'sub_e2e_1', total_count: 12,
      plan: { name: 'Pro', amount: 49900, interval: 'month' },
    });
    expect(sub.isError).toBe(false);
    const cancel = await call(client, 'payments_cancel_subscription', { provider: 'razorpay', provider_subscription_id: sub.data.providerSubscriptionId });
    expect(cancel.data.status).toBe('cancelled');
    expect((await call(client, 'payments_list_settlements', { provider: 'razorpay' })).isError).toBe(false);
    // Unsupported on the real gateway => also refused in mock mode.
    const phonepeCustomer = await call(client, 'payments_create_customer', { provider: 'phonepe', name: 'x' });
    expect(phonepeCustomer).toMatchObject({ isError: true, data: { error: 'UNSUPPORTED' } });
  });

  it('generates integration code', async () => {
    const r = await call(client, 'payments_generate_integration', { provider: 'razorpay', framework: 'express', features: ['checkout', 'webhooks', 'refunds'] });
    expect(r.data.files.length).toBeGreaterThan(2);
    expect(JSON.stringify(r.data.files)).toContain("from 'india-payments-mcp'");
    const skydo = await call(client, 'payments_generate_integration', { provider: 'skydo', framework: 'express' });
    expect(skydo.data.warnings.join(' ')).toMatch(/no public/i);
  });

  it('rejects bad input with clear errors instead of crashing', async () => {
    const paise = await client.callTool({ name: 'payments_create_payment', arguments: { provider: 'razorpay', order_ref: 'bad_amt', amount: 499.5 } });
    expect(paise.isError).toBe(true);
    const unknown = await client.callTool({ name: 'payments_get_capabilities', arguments: { provider: 'gpay' } });
    expect(unknown.isError).toBe(true);
    const skydo = await call(client, 'payments_create_payment', { provider: 'skydo', order_ref: 'sky_1', amount: 100000 });
    expect(skydo).toMatchObject({ isError: true, data: { error: 'VALIDATION' } }); // no currency: Skydo never takes INR
    const skydoRefund = await call(client, 'payments_refund', { provider: 'skydo', order_ref: 'sky_1', refund_ref: 'rf_sky_1' });
    expect(skydoRefund).toMatchObject({ isError: true, data: { error: 'UNSUPPORTED' } });
    // The server is still alive afterwards.
    expect((await call(client, 'payments_list_providers', {})).data.providers).toHaveLength(8);
  });
});

describe('MCP server over stdio (sandbox mode, no credentials)', () => {
  it('starts, reports missing env vars, and fails tool calls with CONFIG_MISSING', async () => {
    const client = await start({ PAYMENTS_MODE: 'sandbox' });
    try {
      const cfg = await call(client, 'payments_check_config', { provider: 'razorpay' });
      expect(cfg.data.providers[0]).toMatchObject({ ready: false, missing: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'] });
      const create = await call(client, 'payments_create_payment', { provider: 'razorpay', order_ref: 'ord_sbx', amount: 100 });
      expect(create).toMatchObject({ isError: true, data: { error: 'CONFIG_MISSING' } });
      expect(create.data.hint).toBeTruthy();
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe('MCP server over Streamable HTTP', () => {
  it('requires the bearer token and serves tools to an authorised client', async () => {
    const { spawn } = await import('node:child_process');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const token = 'e2e-token-0123456789abcdef0123456789';
    const port = 18000 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'http'], {
      env: { PATH: process.env.PATH ?? '', PAYMENTS_MODE: 'mock', MCP_HTTP_TOKEN: token, MCP_HTTP_PORT: String(port), PAYMENTS_LOG_LEVEL: 'error' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server did not start')), 15_000);
        child.stderr!.on('data', (d: Buffer) => d.toString().includes('listening') && (clearTimeout(t), resolve()));
      });
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
      // Exact path match: /mcpfoo is not the MCP endpoint.
      expect((await fetch(`${base}/mcpfoo`, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
      expect((await fetch(`${base}/mcp`, { method: 'POST', body: '{}', headers: { authorization: 'Bearer wrong' } })).status).toBe(401);

      const client = new Client({ name: 'e2e-http', version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(19);
      const created = await call(client, 'payments_create_payment', { provider: 'cashfree', order_ref: 'http_1', amount: 100 });
      expect(created.data.status).toBe('created');
      await client.close();
    } finally {
      child.kill();
    }
  }, 30_000);

  it('refuses an invalid MCP_HTTP_PORT', async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'http'], {
      env: { PATH: process.env.PATH ?? '', MCP_HTTP_TOKEN: 'e2e-token-0123456789abcdef0123456789', MCP_HTTP_PORT: 'eighty' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('MCP_HTTP_PORT');
  }, 20_000);

  it('doctor lists an unconfigured Skydo as not configured, not ERROR', async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'doctor'], {
      env: { PATH: process.env.PATH ?? '', PAYMENTS_MODE: 'sandbox', HOME: process.env.HOME ?? '' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    const line = r.stdout.split('\n').find((l) => l.startsWith('skydo'));
    expect(line).toMatch(/not configured/);
    expect(r.stdout).not.toMatch(/skydo\s+ERROR/);
  }, 20_000);

  it('refuses to start without a strong token', async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'http'], { env: { PATH: process.env.PATH ?? '', MCP_HTTP_TOKEN: 'short' }, encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('MCP_HTTP_TOKEN');
  }, 20_000);
});
