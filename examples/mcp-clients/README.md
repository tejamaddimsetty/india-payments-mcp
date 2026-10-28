# Connecting india-payments-mcp to MCP clients

Start every client in **mock mode** (`PAYMENTS_MODE=mock`): no gateway account, no keys, no network.
Every tool works, payments are simulated, and `payments_mock_complete_payment` plays the customer.
Move to `sandbox` with test keys once the flow makes sense. Run `live` only on a server you control,
and leave `PAYMENTS_ALLOW_LIVE_MUTATIONS` unset unless a human approves each refund.

> Never paste live keys into a config file that is committed or synced. Prefer per-user config, the
> client's secret prompts (VS Code `inputs`), or environment variables set outside the file.

## Claude Code

```bash
# mock mode, available in every project
claude mcp add india-payments -e PAYMENTS_MODE=mock -- npx -y india-payments-mcp

# sandbox with Razorpay test keys (stored in your user config, not the repo)
claude mcp add india-payments-sandbox \
  -e PAYMENTS_MODE=sandbox -e PAYMENTS_PROVIDERS=razorpay \
  -e RAZORPAY_KEY_ID=rzp_test_xxx -e RAZORPAY_KEY_SECRET=xxx \
  -- npx -y india-payments-mcp
```

Check it with `claude mcp list`, then ask: *"Generate a Razorpay integration for my Express app"*
(calls `payments_generate_integration`).

## Claude Desktop

Settings → Developer → Edit Config, then merge [`claude-desktop.json`](./claude-desktop.json) into
`claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Restart Claude Desktop. Keep only the server you need: two servers with the same tools confuse tool selection.

## Cursor

Copy [`cursor-mcp.json`](./cursor-mcp.json) to `.cursor/mcp.json` in your project (or
`~/.cursor/mcp.json` for all projects), then enable the server under Settings → MCP.

## VS Code (GitHub Copilot agent mode)

Copy [`vscode-mcp.json`](./vscode-mcp.json) to `.vscode/mcp.json`. The sandbox entry asks for the
key secret through a password prompt (`inputs`), so the secret is never written to the file. Start
the server from the CodeLens above its entry, then use it in Copilot Chat's agent mode.

## ChatGPT (remote HTTP)

ChatGPT cannot launch local processes, so run the Streamable HTTP transport and expose it through a tunnel:

```bash
export MCP_HTTP_TOKEN=$(openssl rand -hex 32)          # bearer token, 24+ chars required
MCP_HTTP_TOKEN=$MCP_HTTP_TOKEN PAYMENTS_MODE=mock npx india-payments-mcp http
# listens on http://127.0.0.1:8787/mcp  (MCP_HTTP_HOST / MCP_HTTP_PORT to change)

cloudflared tunnel --url http://127.0.0.1:8787         # or: ngrok http 8787
```

Add a connector with the URL `https://<tunnel-host>/mcp` and the bearer token. The token is the only
thing between the internet and your gateway credentials, so use mock or sandbox mode, never live.
Stop the tunnel when you are done. Step-by-step instructions and the ChatGPT-side caveats are in
[`chatgpt/connector-setup.md`](../../chatgpt/connector-setup.md).

## Any other MCP client

stdio: command `npx`, args `["-y", "india-payments-mcp"]`, env `PAYMENTS_MODE=mock`.
HTTP: `npx india-payments-mcp http` with `MCP_HTTP_TOKEN`, endpoint `/mcp`, header `Authorization: Bearer <token>`.
`npx india-payments-mcp doctor` prints which gateways have credentials configured.
