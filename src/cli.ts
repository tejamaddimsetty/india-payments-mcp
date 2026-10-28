#!/usr/bin/env node
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PaymentsClient } from './client.js';
import { PaymentError } from './core/errors.js';
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
    let setup: string | undefined;
    if (r.ready && client.mode !== 'mock') {
      try {
        client.gateway(id);
      } catch (e) {
        // CONFIG_MISSING from a gateway with no single required variable (Skydo) = not set up yet.
        if (e instanceof PaymentError && e.code === 'CONFIG_MISSING') {
          status = 'not configured';
          setup = [e.message, e.hint].filter(Boolean).join(' ');
        } else {
          status = `ERROR: ${(e as Error).message}`;
        }
      }
    }
    if (client.mode === 'mock') status = 'mock';
    if (status === 'ready' || status === 'mock') ready++;
    console.log(`${id.padEnd(10)} ${status}`);
    if (!r.ready && client.mode !== 'mock') console.log(`           missing: ${r.missing.join(', ')}`);
    if (setup) console.log(`           setup: ${setup}`);
    else if (r.optionalMissing.length && client.mode !== 'mock') console.log(`           optional: ${r.optionalMissing.join(', ')}`);
  }
  console.log(`\n${ready} gateway(s) usable.${ready === 0 ? ' Set PAYMENTS_MODE=mock to try everything without credentials.' : ''}`);
}

/** HTTP sessions idle for longer than this are closed. */
const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_SWEEP_MS = 60_000;
const MAX_SESSIONS = 1000;

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
  const portRaw = process.env.MCP_HTTP_PORT ?? '8787';
  const port = Number(portRaw);
  if (!/^\d+$/.test(portRaw) || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`MCP_HTTP_PORT must be an integer between 1 and 65535 (got "${portRaw}").`);
    process.exit(2);
  }
  const client = new PaymentsClient({ actor: 'mcp:http', guardLiveMutations: true });
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; lastSeen: number }>();
  // Evict idle sessions so repeated `initialize` calls cannot grow memory without bound.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of sessions) {
      if (s.lastSeen < cutoff) {
        sessions.delete(id);
        void s.transport.close().catch(() => {});
      }
    }
  }, SESSION_SWEEP_MS);
  sweep.unref();

  const http = createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, version: VERSION, mode: client.mode }));
      return;
    }
    // Exact path: '/mcp' (optionally with a query string), not '/mcpfoo'.
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/mcp') return void res.writeHead(404).end();
    if (!bearerOk(req, token)) return void res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();

    const sid = req.headers['mcp-session-id'];
    const existing = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (existing) existing.lastSeen = Date.now();
    let transport = existing?.transport;
    if (!transport) {
      if (sessions.size >= MAX_SESSIONS) {
        res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'too many sessions' }));
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void sessions.set(id, { transport: transport!, lastSeen: Date.now() }),
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
