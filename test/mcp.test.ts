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
    const res = await client.callTool({ name: 'payments_create_payment', arguments: { provider: 'skydo', order_ref: 'mcp_2', amount: 100 } });
    expect(res.isError).toBe(true);
    expect(json(res).error).toBe('UNSUPPORTED');
  });

  it('serves the support matrix resource', async () => {
    const client = await connect();
    const res = await client.readResource({ uri: 'payments://matrix' });
    expect(String((res.contents[0] as any).text)).toContain('Razorpay');
  });
});
