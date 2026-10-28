#!/usr/bin/env node
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PaymentsClient } from './client.js';
import { createMcpServer } from './mcp/server.js';
import { VERSION } from './version.js';

const HELP = `india-payments-mcp ${VERSION}

Usage:
  india-payments-mcp              Start the MCP server on stdio (Claude Code, Claude Desktop, Cursor, ...)
  india-payments-mcp http         Start the MCP server over Streamable HTTP (for ChatGPT connectors / remote agents)
  india-payments-mcp doctor       Check which gateways are configured
  india-payments-mcp --version

Environment:
  PAYMENTS_MODE=mock|sandbox|live      (default sandbox)
  PAYMENTS_PROVIDERS=razorpay,cashfree (default: all)
  PAYMENTS_ALLOW_LIVE_MUTATIONS=true   allow refunds/cancellations in live mode (each call still needs confirm=true)
  PAYMENTS_AUDIT_LOG=/path/audit.jsonl
  MCP_HTTP_PORT=8787  MCP_HTTP_HOST=127.0.0.1  MCP_HTTP_TOKEN=<required for http>

See .env.example for every gateway's variables.`;

async function main() {
  const cmd = process.argv[2];
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return void console.log(HELP);
  if (cmd === '--version' || cmd === '-v') return void console.log(VERSION);
  if (cmd === 'doctor') return doctor();
  if (cmd === 'http') return serveHttp();
  if (cmd && cmd !== 'stdio') {
    console.error(`Unknown command "${cmd}".\n\n${HELP}`);
    process.exit(2);
  }
  const server = createMcpServer(new PaymentsClient({ actor: 'mcp:stdio', guardLiveMutations: true }));
  await server.connect(new StdioServerTransport());
}

function doctor() {
  const client = new PaymentsClient({ actor: 'cli' });
  console.log(`india-payments-mcp ${VERSION}`);
  console.log(`mode: ${client.mode}${client.mode === 'live' ? `  (live mutations ${client.config.allowLiveMutations ? 'ALLOWED' : 'blocked'})` : ''}\n`);
  let ready = 0;
  for (const id of client.providers()) {
    const r = client.configReport(id);
    let status = r.ready ? 'ready' : 'not configured';
    if (r.ready && client.mode !== 'mock') {
      try {
        client.gateway(id);
      } catch (e) {
        status = `ERROR: ${(e as Error).message}`;
      }
    }
    if (client.mode === 'mock') status = 'mock';
    if (status === 'ready' || status === 'mock') ready++;
    console.log(`${id.padEnd(10)} ${status}`);
    if (!r.ready && client.mode !== 'mock') console.log(`           missing: ${r.missing.join(', ')}`);
    if (r.optionalMissing.length && client.mode !== 'mock') console.log(`           optional: ${r.optionalMissing.join(', ')}`);
  }
  console.log(`\n${ready} gateway(s) usable.${ready === 0 ? ' Set PAYMENTS_MODE=mock to try everything without credentials.' : ''}`);
}

function bearerOk(req: IncomingMessage, token: string) {
  const got = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function serveHttp() {
  const token = process.env.MCP_HTTP_TOKEN;
  if (!token || token.length < 24) {
    console.error('MCP_HTTP_TOKEN (24+ chars) is required for the HTTP transport. Generate one: openssl rand -hex 32');
    process.exit(2);
  }
  const host = process.env.MCP_HTTP_HOST ?? '127.0.0.1';
  const port = Number(process.env.MCP_HTTP_PORT ?? 8787);
  const client = new PaymentsClient({ actor: 'mcp:http', guardLiveMutations: true });
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const http = createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, version: VERSION, mode: client.mode }));
      return;
    }
    if (!req.url?.startsWith('/mcp')) return void res.writeHead(404).end();
    if (!bearerOk(req, token)) return void res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();

    const sid = req.headers['mcp-session-id'];
    let transport = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void sessions.set(id, transport!),
      });
      transport.onclose = () => {
        if (transport?.sessionId) sessions.delete(transport.sessionId);
      };
      await createMcpServer(client).connect(transport);
    }
    await transport.handleRequest(req, res);
  });
  http.listen(port, host, () => console.error(`india-payments-mcp ${VERSION} listening on http://${host}:${port}/mcp (mode ${client.mode})`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
