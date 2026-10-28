# india-payments skill

A Claude Agent Skill that makes an agent build Indian payment integrations the way a payments engineer would: server-side amounts, verified callbacks, webhooks as source of truth, idempotent refunds, reconciliation.

```
skills/india-payments/
  SKILL.md                                   # the operating procedure (loaded when triggered)
  references/
    razorpay.md payu.md cashfree.md ccavenue.md paytm.md phonepe.md stripe.md skydo.md
    payment-module-architecture.md           # tables, state machine, reconciliation, idempotency
    platforms.md                             # Shopify, WooCommerce, Next.js, Django, Laravel, mobile
```

## Install

Personal (all projects):

```bash
mkdir -p ~/.claude/skills
cp -R skills/india-payments ~/.claude/skills/
```

Per project (commit it so the team gets it):

```bash
mkdir -p .claude/skills
cp -R /path/to/india-payments-mcp/skills/india-payments .claude/skills/
```

Without cloning:

```bash
npx degit tejamaddimsetty/india-payments-mcp/skills/india-payments ~/.claude/skills/india-payments
```

As a plugin: if you distribute this through a Claude Code plugin marketplace, put the folder under the plugin's `skills/` directory; the plugin can also declare the MCP server in its `.mcp.json` so both install together.

Claude loads the skill automatically when a task mentions payments, checkout, UPI, refunds, webhooks or subscriptions with an Indian gateway. You can also ask for it by name.

## Pair it with the MCP server

The skill works alone, but with the server the agent can read live capability maps, generate integration code, run a mock gateway and produce correctly signed test webhooks.

Claude Code:

```bash
claude mcp add india-payments --env PAYMENTS_MODE=mock -- npx -y india-payments-mcp
```

Claude Desktop / Cursor / any stdio client (`mcpServers` config):

```json
{
  "mcpServers": {
    "india-payments": {
      "command": "npx",
      "args": ["-y", "india-payments-mcp"],
      "env": { "PAYMENTS_MODE": "sandbox", "RAZORPAY_KEY_ID": "rzp_test_...", "RAZORPAY_KEY_SECRET": "..." }
    }
  }
}
```

Modes: `mock` (no network, no credentials, use this first), `sandbox` (gateway test endpoints, test keys), `live` (real money; refunds, cancellations and Skydo receipt recording additionally need `PAYMENTS_ALLOW_LIVE_MUTATIONS=true` and `confirm=true` per call after a human approves). Do not give an agent a live-mode server unless you mean it. Check your setup with `npx india-payments-mcp doctor`.

Tools the skill uses: `payments_recommend_gateway`, `payments_get_capabilities`, `payments_check_config`, `payments_generate_integration`, `payments_create_payment`, `payments_mock_complete_payment`, `payments_verify_payment`, `payments_get_status`, `payments_simulate_webhook`, `payments_refund`, `payments_get_refund_status`, and for Skydo ledger mode `payments_skydo_record_payment` and `payments_skydo_outstanding`. SKILL.md lists all 19 server tools.

## Other agents

- Cursor: `.cursor/rules/india-payments.mdc` in this repo points Cursor at the same rules.
- ChatGPT / Gemini / Codex: see `chatgpt/` at the repo root (Custom GPT instructions, knowledge files, connector setup, a vendor-neutral system prompt).

## Accuracy

Gateway facts come from `docs/research/gateway-api-facts.md` (researched 2026-10-28), corrected by the round-1 line-by-line checks of every adapter against the official docs in `docs/research/verification/` (2026-10-29). Each fact is labelled VERIFIED, PARTIAL or UNVERIFIED. Nothing has yet been run against live gateway sandboxes. Sandbox test cards/UPI ids were not re-fetched during that research and are marked UNVERIFIED with the official page to check. Report corrections as issues with the official doc URL.
