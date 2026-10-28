---
name: Bug report
about: Something in the SDK, MCP server or an adapter behaves incorrectly
title: "[bug] "
labels: bug
---

<!-- Never paste real API keys, webhook secrets, live payment ids tied to real customers, or personal data. Redact them. -->
<!-- Security issue (signature bypass, unintended refunds, secret leak)? Do NOT file here: use https://github.com/tejamaddimsetty/india-payments-mcp/security/advisories/new -->

**Summary**

**Gateway(s)**: razorpay / payu / cashfree / ccavenue / paytm / phonepe / stripe / skydo / n/a

**Mode**: mock / sandbox / live

**Surface**: MCP tool (which one?) / SDK (`PaymentsClient` method) / CLI / webhook handler

**Version**: `npx india-payments-mcp --version` →

**Environment**: Node version, OS, MCP client (Claude Code / Desktop / Cursor / ChatGPT / other)

**Steps to reproduce**

1.
2.

**Expected**

**Actual** (include the error JSON: `error`, `message`, `providerCode`, `hint`)

```json
```

**Logs** (stderr, `PAYMENTS_LOG_LEVEL=debug`, redacted)

```
```

**Does it reproduce in `PAYMENTS_MODE=mock`?** yes / no / not tried
