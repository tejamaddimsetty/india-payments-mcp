import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { PaymentsClient } from '../src/client.js';
import { createMcpServer } from '../src/mcp/server.js';

async function connect() {
  const server = createMcpServer(new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' } }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const json = (r: any) => JSON.parse(r.content[0].text.replace(/^[\s\S]*?\n\n(?=\{)/, ''));

describe('MCP server', () => {
  it('exposes the payment tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const t of ['payments_list_providers', 'payments_create_payment', 'payments_refund', 'payments_verify_webhook', 'payments_generate_integration']) {
      expect(names).toContain(t);
    }
    expect(tools.find((t) => t.name === 'payments_refund')?.annotations?.destructiveHint).toBe(true);
  });

  it('runs a mock checkout end to end over MCP', async () => {
    const client = await connect();
    const created = await client.callTool({ name: 'payments_create_payment', arguments: { provider: 'razorpay', order_ref: 'mcp_1', amount: 49900 } });
    expect(created.isError).toBeFalsy();
    const done = await client.callTool({ name: 'payments_mock_complete_payment', arguments: { provider: 'razorpay', order_ref: 'mcp_1', outcome: 'success' } });
    const payload = json(done).callbackPayload;
    const verified = await client.callTool({ name: 'payments_verify_payment', arguments: { provider: 'razorpay', payload, order_ref: 'mcp_1', expected_amount: 49900 } });
    expect(json(verified).valid).toBe(true);
  });

  it('returns structured errors, not exceptions', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'payments_create_customer', arguments: { provider: 'phonepe', name: 'x' } });
    expect(res.isError).toBe(true);
    expect(json(res).error).toBe('UNSUPPORTED');
  });

  it('serves the support matrix resource', async () => {
    const client = await connect();
    const res = await client.readResource({ uri: 'payments://matrix' });
    expect(String((res.contents[0] as any).text)).toContain('Razorpay');
  });

  it('payments_get_status takes provider_payment_id; refund descriptions name the ids each gateway needs', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const status = tools.find((t) => t.name === 'payments_get_status')!;
    expect(Object.keys((status.inputSchema as { properties: object }).properties)).toContain('provider_payment_id');
    expect(tools.find((t) => t.name === 'payments_get_refund_status')!.description).toMatch(/PayU: provider_refund_id/);
    const refund = tools.find((t) => t.name === 'payments_refund')!.description!;
    expect(refund).toContain('within this server process');
    expect(tools.find((t) => t.name === 'payments_verify_payment')!.description).toMatch(/authorized.*NOT paid/);
  });

  it('payments_check_config reports an unconfigured Skydo as not configured with setup help, not an error', async () => {
    const server = createMcpServer(new PaymentsClient({ env: { PAYMENTS_MODE: 'sandbox' } }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = json(await client.callTool({ name: 'payments_check_config', arguments: { provider: 'skydo' } }));
    expect(r.providers[0]).toMatchObject({ ready: false });
    expect(r.providers[0].initError).toBeUndefined();
    expect(r.providers[0].setup).toMatch(/SKYDO_RECEIVING_ACCOUNTS/);
  });
});
