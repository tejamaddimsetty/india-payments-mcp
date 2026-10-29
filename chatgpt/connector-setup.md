# Using india-payments-mcp from ChatGPT (MCP connector)

ChatGPT can call remote MCP servers over HTTP ("connectors" / developer mode, depending on plan and current product naming). This server ships a Streamable HTTP transport for that. **What ChatGPT accepts changes over time** (which plans can add custom connectors, which auth methods are offered). Check OpenAI's current connector docs before relying on the steps below; the server side is stable, the ChatGPT side is not under our control.

## 1. Run the server over HTTP (sandbox or mock only)

```bash
export MCP_HTTP_TOKEN=$(openssl rand -hex 32)   # keep this; it is the bearer token
MCP_HTTP_TOKEN=$MCP_HTTP_TOKEN PAYMENTS_MODE=sandbox npx india-payments-mcp http
# or, with no gateway credentials at all:
MCP_HTTP_TOKEN=$MCP_HTTP_TOKEN PAYMENTS_MODE=mock npx india-payments-mcp http
```

- Listens on `http://127.0.0.1:8787` by default (`MCP_HTTP_HOST`, `MCP_HTTP_PORT`).
- MCP endpoint: exactly `/mcp` (other paths are 404). Health check: `/healthz` (no auth; returns version and mode only).
- `MCP_HTTP_PORT` must be an integer from 1 to 65535. Sessions idle for 30 minutes are closed (the client reconnects), and the server holds at most 1,000 sessions.
- Every `/mcp` request needs `Authorization: Bearer <MCP_HTTP_TOKEN>`. The server refuses to start without a token of 24+ characters.
- Add gateway test credentials as env vars for sandbox (`RAZORPAY_KEY_ID=rzp_test_…`, etc.). Restrict which gateways are exposed with `PAYMENTS_PROVIDERS=razorpay,cashfree`.
- Verify locally:

```bash
curl -s http://127.0.0.1:8787/healthz
npx @modelcontextprotocol/inspector   # connect to http://127.0.0.1:8787/mcp with the bearer header
```

## 2. Expose it with a tunnel

ChatGPT runs in OpenAI's cloud, so it needs a public HTTPS URL.

```bash
cloudflared tunnel --url http://127.0.0.1:8787     # prints https://<random>.trycloudflare.com
# or
ngrok http 8787
```

Your MCP URL is `https://<tunnel-host>/mcp`.

## 3. Add the connector in ChatGPT

Settings → Connectors (may require enabling developer mode / "custom connectors" under Advanced) → Create → MCP server URL `https://<tunnel-host>/mcp`.

**Authentication: the honest version.**

- The server implements **static bearer-token auth**. If ChatGPT's connector form offers a custom header or API-key/bearer option, enter the token there.
- ChatGPT's custom connectors have historically offered **OAuth or no auth** only. If that is what you see, the bearer token cannot be entered directly. Options:
  1. Put an auth-aware proxy in front (e.g. Cloudflare Access, an OAuth proxy such as `oauth2-proxy`, or a small reverse proxy that performs OAuth with ChatGPT and injects `Authorization: Bearer <MCP_HTTP_TOKEN>` upstream). This is the correct approach for anything that persists beyond a quick test.
  2. For a short-lived **mock-mode** experiment only: a proxy that adds the bearer header with "no auth" on the public side. Anyone who finds the URL can then call the tools. Never do this with sandbox credentials you care about, and never in live mode.
- We do not ship an OAuth server. If you need one, put it in the proxy.

## 4. Security rules

- **Never expose a live-mode server publicly.** `PAYMENTS_MODE=live` + a public URL means anyone with the token (or a misconfigured proxy) can create payments and, if `PAYMENTS_ALLOW_LIVE_MUTATIONS=true`, issue refunds. Live refunds (and Skydo/Infinity receipt recording, in sandbox too, because Skydo has no sandbox and Infinity documents none) also require `confirm=true` per call, but a model will happily pass that. Keep live mode to local stdio use with a human in the loop, or don't use it with agents at all.
- Prefer `PAYMENTS_MODE=mock` for ChatGPT. Code generation, capability maps, recommendations and signed test webhooks all work in mock mode with zero credentials.
- Sandbox keys are still keys: rotate them after a public tunnel session.
- Rotate `MCP_HTTP_TOKEN` per session; kill the tunnel when done. Quick tunnels (trycloudflare, free ngrok) have guessable-enough URLs to be scanned.
- Set `PAYMENTS_AUDIT_LOG=/path/audit.jsonl` to keep a record of every create/refund call.
- Tool results can contain customer names/emails/phones from the gateway. Treat the ChatGPT conversation as a place those values are sent.

## 5. Use it

In a chat with the connector enabled (or inside the "India Payments Integrator" Custom GPT if your plan lets GPTs use connectors):

- "Use payments_get_capabilities for cashfree and list constraints for my Next.js app."
- "Generate the integration for razorpay with framework nextjs and features checkout, webhooks, refunds."
- "Simulate a payment.succeeded webhook for order ord_123_a1, 49900 paise, target http://localhost:3000/api/webhooks/razorpay and give me the curl."

If tools are not available in your ChatGPT plan, the Custom GPT with knowledge files (`custom-gpt-instructions.md`) still works; it just cannot run the mock gateway or generate code from the server's templates.
