# Security policy

## Reporting a vulnerability

**Please don't open a public issue.** Report privately through GitHub Security Advisories:

https://github.com/tejamaddimsetty/india-payments-mcp/security/advisories/new

Include:

- affected version or commit, and the gateway(s) involved
- the impact: for example signature bypass, an unintended refund or other money movement, secret disclosure, or an auth bypass on the HTTP transport
- reproduction steps, preferably in `PAYMENTS_MODE=mock` or sandbox
- any suggested fix

Never include real API keys, live credentials or customer data. Redact them.

## What to expect

- Acknowledgement within 3 working days.
- An initial assessment within 7 working days.
- A coordinated fix and advisory. We'll credit you unless you'd rather stay anonymous.

This is a volunteer-maintained project, so the timelines are best effort.

## Scope

In scope:

- Webhook or callback verification that accepts forged, tampered or replayed payloads
- Ways to bypass the live-mutation gate (`PAYMENTS_ALLOW_LIVE_MUTATIONS` + `confirm`) or refund idempotency
- Secret leakage through tool output, logs, the audit log, errors or generated code
- Authentication or authorization flaws in the HTTP transport
- Code paths that cause card data to be handled by the server

Out of scope:

- Vulnerabilities in the gateways themselves. Report those to the gateway.
- Deployments that ignore the documented guidance, for example exposing the HTTP transport without TLS or a proxy.
- Prompt injection that succeeds only when the operator has enabled live mutations **and** the MCP client auto-approves destructive tools. That's a configuration risk (see `docs/security.md`), but we still welcome reports that suggest better defaults.

## Supported versions

Only the latest released minor version receives security fixes.
