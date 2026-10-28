import type { ProviderCapabilities } from '../../core/capabilities.js';
import { profileFor } from './profiles.js';
import { has, lines, oneLine, type TemplateContext } from './shared.js';

const SECRETS_RULE =
  'Secrets (API secrets, salts, working keys, merchant keys, webhook secrets) live ONLY on your server. ' +
  'Anything shipped in an app binary or a web bundle can be extracted in minutes. The app talks to your server; your server talks to the gateway.';

function sdkList(cap: ProviderCapabilities, keys: string[]): string {
  const found = keys.map((k) => [k, cap.officialSdks[k]] as const).filter(([, v]) => !!v);
  if (found.length === 0) return `- No official SDK for this platform is listed in the ${cap.displayName} capability map. Check ${cap.docsUrl}, or use the browser fallback below.`;
  return found.map(([k, v]) => `- ${k}: ${v}`).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Mobile (React Native / Flutter)
// ---------------------------------------------------------------------------------------------

/** What the native SDK needs, read from the /api/payments/create response. */
function nativeHandoff(cap: ProviderCapabilities, platform: 'react-native' | 'flutter'): string {
  const rn = platform === 'react-native';
  switch (cap.provider) {
    case 'razorpay':
      return lines(
        `Response \`checkout\` is \`{ type: 'js_sdk', sdk: 'razorpay', options }\`. Pass these to the native SDK:`,
        ``,
        '| Native SDK field | From the create response |',
        '|---|---|',
        '| `key` | `checkout.options.key` (publishable key id) |',
        '| `order_id` | `checkout.options.order_id` |',
        '| `amount`, `currency` | `checkout.options.amount`, `checkout.options.currency` |',
        '| `prefill`, `notes` | `checkout.options.prefill`, `checkout.options.notes` |',
        ``,
        'Do NOT pass `callback_url` / `redirect` to the native SDK (they exist for the web redirect flow).',
        ``,
        rn
          ? 'On success `RazorpayCheckout.open(...)` resolves with `{ razorpay_payment_id, razorpay_order_id, razorpay_signature }`.'
          : 'On `Razorpay.EVENT_PAYMENT_SUCCESS` you get `PaymentSuccessResponse(paymentId, orderId, signature)`; send them as `razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature`.',
        'POST those three fields as JSON to `/api/payments/callback?orderRef=<orderRef>`. The server verifies the signature and answers `{ ok, status }`.',
      );
    case 'cashfree':
      return lines(
        `Response \`checkout\` is \`{ type: 'js_sdk', sdk: 'cashfree', options: { mode, paymentSessionId } }\`.`,
        ``,
        '| Native SDK field | From the create response |',
        '|---|---|',
        '| order id | `orderRef` |',
        '| payment session id | `checkout.options.paymentSessionId` |',
        '| environment | `checkout.options.mode` (`sandbox` / `production`) |',
        ``,
        'Cashfree returns no signature to the app. When the SDK reports completion, call',
        '`GET /api/payments/callback?orderRef=<orderRef>&order_id=<orderRef>` with `Accept: application/json`; the server confirms with the Get Order API.',
      );
    case 'paytm':
      return lines(
        `Response \`checkout\` is \`{ type: 'js_sdk', sdk: 'paytm', options }\`. For the Paytm All-in-One SDK:`,
        ``,
        '| Native SDK field | From the create response |',
        '|---|---|',
        '| `mid` | `checkout.options.fallbackRedirect.fields.mid` |',
        '| `orderId` | `checkout.options.data.orderId` |',
        '| `txnToken` | `checkout.options.data.token` |',
        '| `amount` | `checkout.options.data.amount` (rupee string) |',
        '| `callbackUrl` | `<PUBLIC_BASE_URL>/api/payments/callback?orderRef=<orderRef>` |',
        '| `isStaging` | `mode !== "live"` |',
        ``,
        'Paytm posts the CHECKSUMHASH-signed result to the callbackUrl server-side. In the app, treat the SDK result as a hint and re-ask your server (POST the SDK response bundle as JSON to the callback URL, which verifies the checksum).',
      );
    case 'stripe':
      return lines(
        'The default Stripe flow is a hosted Checkout Session: `checkout` is `{ type: "redirect", url }`. Open it in an in-app browser (see fallback below).',
        `For a native PaymentSheet (${rn ? '@stripe/stripe-react-native' : 'flutter_stripe'}), create the payment with \`providerOptions: { flow: 'payment_intent' }\` on the server; then:`,
        ``,
        '| Native SDK field | From the create response |',
        '|---|---|',
        '| publishable key | `checkout.options.publishableKey` |',
        '| `paymentIntentClientSecret` | `checkout.options.clientSecret` |',
        ``,
        'After `presentPaymentSheet()` succeeds, call `GET /api/payments/callback?orderRef=<orderRef>&payment_intent=<id from the client secret>` with `Accept: application/json`; the server retrieves the PaymentIntent.',
      );
    default:
      return lines(
        `${cap.displayName} returns a \`${cap.checkoutTypes.join(' / ')}\` checkout. Its native SDK needs extra server-side material`,
        'that this SDK does not generate yet (see "Known gaps"), so use the browser fallback below. It is fully supported and is what most apps ship.',
      );
  }
}

export function mobileGuide(ctx: TemplateContext, platform: 'react-native' | 'flutter'): string {
  const { cap } = ctx;
  const sdkKeys = platform === 'react-native' ? ['reactNative', 'android', 'ios'] : ['flutter', 'android', 'ios'];
  const gap: Record<string, string> = {
    phonepe: 'PhonePe\'s native SDK needs an "SDK order" token (POST /checkout/v2/sdk/order), not the PayPage redirectUrl this SDK creates.',
    payu: 'PayU CheckoutPro needs per-request hashes generated by a server endpoint the SDK calls back into; that endpoint is not generated here.',
    ccavenue: 'CCAvenue\'s mobile kit uses an RSA-key handshake that is not implemented here.',
  };
  return lines(
    `# ${cap.displayName} in a ${platform === 'react-native' ? 'React Native' : 'Flutter'} app`,
    ``,
    `Your app never talks to ${cap.displayName}'s server APIs directly. The generated Express server`,
    `(\`server/\`) does, using india-payments-mcp; the app only renders checkout.`,
    ``,
    `> ${SECRETS_RULE}`,
    ``,
    `## Flow`,
    ``,
    `1. App -> \`POST /api/payments/create\` with \`{ "orderId": "<your order id>" }\` (never an amount; the server prices the order).`,
    `2. Server responds:`,
    ``,
    '```json',
    `{`,
    `  "orderRef": "demo-order-1_a1b2c3d4e5f6",`,
    `  "provider": "${cap.provider}",`,
    `  "mode": "sandbox",`,
    `  "amount": 49900,`,
    `  "currency": "INR",`,
    `  "checkout": { "type": "${cap.checkoutTypes[0] ?? 'manual'}", "...": "see below" }`,
    `}`,
    '```',
    ``,
    `3. App opens the gateway's checkout with the data below.`,
    `4. App reports back to \`/api/payments/callback\`; the server verifies and answers \`{ ok, status }\`.`,
    `5. The webhook (\`/api/payments/webhook\`) is the source of truth if the app is killed mid-payment. Fulfil on the server, never in the app.`,
    ``,
    `## Native SDK`,
    ``,
    sdkList(cap, sdkKeys),
    ``,
    nativeHandoff(cap, platform),
    ``,
    `## Browser fallback (works for every gateway)`,
    ``,
    `- \`redirect\`: open \`checkout.url\` in ${platform === 'react-native' ? '`react-native-inappbrowser-reborn` / `expo-web-browser`' : '`flutter_custom_tabs` / `url_launcher` (in-app browser mode)'} (Custom Tabs on Android, SFSafariViewController/ASWebAuthenticationSession on iOS).`,
    `- \`form_post\`: load a WebView with an auto-submitting form built from \`checkout.url\` + \`checkout.fields\` (all fields are hidden inputs; nothing secret is in them).`,
    `- When the WebView/in-app browser navigates to \`<PUBLIC_BASE_URL>/checkout.html?orderRef=...&status=...\` the server has finished verifying. Close it and read \`status\` (display only).`,
    `- UPI intent apps (GPay, PhonePe, Paytm) need \`intent://\` / \`upi://\` links to open externally: allow them in your WebView's navigation handler.`,
    ``,
    gap[cap.provider] ? lines(`## Known gaps`, ``, `- ${gap[cap.provider]} Use the browser fallback.`, ``) : false,
    `## Checklist`,
    ``,
    `- [ ] No gateway secret in the app bundle, \`.env\` shipped with the app, or remote config.`,
    `- [ ] The app sends only an order id; the server decides the amount.`,
    `- [ ] Payment success shown in the app comes from YOUR server's answer, not the SDK callback alone.`,
    `- [ ] Webhook configured, so payments complete even when the app is closed during payment.`,
    ``,
  );
}

// ---------------------------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------------------------

export function shopifyGuide(ctx: TemplateContext): string {
  const { cap } = ctx;
  const plugin = cap.platformPlugins.shopify;
  return lines(
    `# ${cap.displayName} on Shopify`,
    ``,
    `## The honest constraints`,
    ``,
    `- **Shopify checkout only accepts approved payment apps.** Only Shopify-approved partners can build payments extensions; custom payment extensions are limited to eligible Shopify Plus merchants. You cannot plug your own server (or this SDK) into Shopify checkout.`,
    `- **Shopify Payments is not available to India-based stores.** Indian stores use third-party providers under Settings > Payments, and Shopify charges a third-party transaction fee that depends on your plan.`,
    `- So the integration is: install ${cap.displayName}'s official app, and (optionally) run a small server for reconciliation and reporting with india-payments-mcp.`,
    ``,
    `## Step 1: install the gateway's Shopify app`,
    ``,
    plugin
      ? `- ${cap.displayName}: ${plugin}`
      : `- ${cap.displayName} has **no official Shopify payments app** that we could verify. Pick a gateway that has one (Razorpay, PayU, PhonePe, Cashfree), or route ${cap.displayName}'s methods through such a gateway.`,
    `- Shopify Admin > Settings > Payments > add the provider, connect it with the gateway account owner's login, then place a test order in the gateway's test mode.`,
    `- Refunds: issue them from **Shopify Admin > Orders > Refund**. The app forwards them to ${cap.displayName}. Refunding directly through the gateway API (or this SDK) leaves Shopify's books out of sync.`,
    ``,
    `## Step 2 (optional): reconciliation server`,
    ``,
    `\`src/shopify-reconcile.ts\` receives Shopify \`orders/paid\` and \`refunds/create\` webhooks (HMAC-verified on the raw body),`,
    `and asks ${cap.displayName} via india-payments-mcp whether the money really arrived (status, refunds, settlements).`,
    `Use it to catch orders marked paid in Shopify that never settled, or refunds stuck at the gateway.`,
    ``,
    `- Shopify Admin > Settings > Notifications > Webhooks (or your custom app): subscribe \`orders/paid\` and \`refunds/create\` to \`https://YOUR_DOMAIN/webhooks/shopify\`, JSON format. Copy the signing secret into \`SHOPIFY_WEBHOOK_SECRET\`.`,
    `- **Mapping caveat:** the gateway's order id is assigned by ${cap.displayName}'s Shopify app, not by you. Look at a test order's transaction (\`authorization\` / \`receipt\` fields in the Shopify Order Transactions API) to see which id the app stores, and adapt \`gatewayRefFor()\`.`,
    ``,
  );
}

export function shopifyReconcileServer(ctx: TemplateContext): string {
  const { cap } = ctx;
  const statusSupported = cap.features.paymentStatus.support !== 'unsupported';
  return lines(
    `/**`,
    ` * Shopify -> ${cap.displayName} reconciliation. NOT a checkout integration (Shopify does not allow one).`,
    ` * Run: npx tsx src/shopify-reconcile.ts   Deps: express, india-payments-mcp`,
    ` */`,
    `import { createHmac, timingSafeEqual } from 'node:crypto';`,
    `import express from 'express';`,
    `import { createPaymentsClient } from 'india-payments-mcp';`,
    ``,
    `const PROVIDER = '${cap.provider}' as const;`,
    `const payments = createPaymentsClient({ actor: 'shopify-reconcile' });`,
    ``,
    `interface ShopifyTransaction { gateway?: string; authorization?: string | null; receipt?: Record<string, unknown> }`,
    `interface ShopifyOrder { id: number; name: string; total_price: string; currency: string; payment_gateway_names?: string[]; transactions?: ShopifyTransaction[] }`,
    ``,
    `/** Shopify signs webhooks with base64(HMAC-SHA256(rawBody, app secret)) in X-Shopify-Hmac-Sha256. */`,
    `function verifyShopify(rawBody: Buffer, header: string | undefined): boolean {`,
    `  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;`,
    `  if (!secret || !header) return false;`,
    `  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('base64'));`,
    `  const given = Buffer.from(header);`,
    `  return expected.length === given.length && timingSafeEqual(expected, given);`,
    `}`,
    ``,
    `/**`,
    ` * Which id did ${cap.displayName}'s Shopify app use as the gateway order id? It differs per app version.`,
    ` * Inspect a test order's transactions and adjust. Returning undefined skips the gateway check.`,
    ` */`,
    `function gatewayRefFor(order: ShopifyOrder): string | undefined {`,
    `  const tx = order.transactions?.find((t) => t.authorization);`,
    `  return tx?.authorization ?? undefined;`,
    `}`,
    ``,
    `const app = express();`,
    `app.post('/webhooks/shopify', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {`,
    `  if (!Buffer.isBuffer(req.body) || !verifyShopify(req.body, req.get('x-shopify-hmac-sha256'))) {`,
    `    res.status(401).end();`,
    `    return;`,
    `  }`,
    `  // Ack fast (Shopify times out after 5s), then do the slow work.`,
    `  res.status(200).end();`,
    ``,
    `  const topic = req.get('x-shopify-topic');`,
    `  const order = JSON.parse(req.body.toString('utf8')) as ShopifyOrder;`,
    `  if (topic !== 'orders/paid') return; // refunds/create: record it; check later with payments.getRefundStatus().`,
    `  const ref = gatewayRefFor(order);`,
    `  if (!ref) {`,
    `    payments.logger.warn('shopify.no_gateway_ref', { order: order.name });`,
    `    return;`,
    `  }`,
    statusSupported
      ? lines(
          `  try {`,
          `    const status = await payments.getPaymentStatus(PROVIDER, { orderRef: ref });`,
          `    const shopifyPaise = Math.round(Number(order.total_price) * 100);`,
          `    if (status.status !== 'captured' || (status.amount !== undefined && status.amount !== shopifyPaise)) {`,
          `      // TODO: alert (Slack/email). Shopify says paid but the gateway disagrees.`,
          `      payments.logger.error('shopify.mismatch', { order: order.name, gatewayStatus: status.status, gatewayAmount: status.amount, shopifyPaise });`,
          `    }`,
          `  } catch (err) {`,
          `    payments.logger.error('shopify.status_check_failed', { order: order.name, err: String(err) });`,
          `  }`,
        )
      : `  payments.logger.info('shopify.order_paid', { order: order.name, ref });`,
    `});`,
    ``,
    `app.listen(Number(process.env.PORT ?? 3001));`,
    ``,
  );
}

// ---------------------------------------------------------------------------------------------
// Skydo
// ---------------------------------------------------------------------------------------------

export function skydoGuide(cap: ProviderCapabilities, framework: string): string {
  return lines(
    `# Collecting international payments with Skydo`,
    ``,
    `Skydo has **no public developer API, SDK or webhooks** (checked ${cap.lastVerified}). There is nothing to integrate in`,
    `${framework === 'other' ? 'your code' : `a ${framework} project`}, and this generator deliberately does not produce code that pretends otherwise.`,
    ``,
    `## What to do instead`,
    ``,
    `1. **Payment links (InstaLinks):** create one in the Skydo dashboard per invoice (or a reusable one per client), in the client's currency, and put it on your invoice or send it by email.`,
    `2. **Global bank account details:** share your Skydo local receiving account (US/UK/EU/CA/AU and more) with clients who prefer bank transfers.`,
    `3. **Zoho Books:** connect Skydo to Zoho Books so invoices sync and are marked paid automatically. No QuickBooks/Xero/Zapier integration was found.`,
    `4. **Compliance:** download the FIRA for every received payment (needed for GST export-of-services and income tax).`,
    ``,
    `## If you need programmatic checkout`,
    ``,
    `Use a gateway with an API and export support (ask \`payments_recommend_gateway\` with needs \`["international"]\`, typically Razorpay or Stripe),`,
    `and keep Skydo for invoice-and-transfer clients. If your app must record Skydo payments, add a manual "mark paid" admin action that stores the Skydo transaction reference and FIRA number.`,
    ``,
    cap.constraints.length ? lines(`## Constraints`, ``, ...cap.constraints.map((c) => `- ${oneLine(c)}`), ``) : false,
  );
}

// ---------------------------------------------------------------------------------------------
// Language-agnostic spec ("other")
// ---------------------------------------------------------------------------------------------

export function otherSpec(ctx: TemplateContext): string {
  const { cap } = ctx;
  const p = profileFor(cap.provider);
  const secrets = cap.credentials.filter((c) => c.secret).map((c) => c.env);
  return lines(
    `# ${cap.displayName} integration spec (any language)`,
    ``,
    `Use this when your stack is not Node.js. If it is, run \`payments_generate_integration\` with \`express\`, \`nextjs\` or \`fastify\` instead and reuse the SDK.`,
    ``,
    `## Rules that apply in every language`,
    ``,
    `1. The server decides the amount from its own records. The browser sends an order id only.`,
    `2. Amounts are integer paise internally. ${cap.displayName} expects: ${oneLine(cap.providerAmountFormat)}`,
    `3. Use a fresh gateway order id per payment attempt (3-40 chars, \`[A-Za-z0-9_-]\`).`,
    `4. Never mark an order paid from the browser return alone: verify the signature/hash against the order id and amount YOU stored, then confirm with the status API or a signed webhook.`,
    `5. Verify webhooks over the **raw request bytes**, compare in constant time, dedupe by event id, return 2xx only after you have stored the result.`,
    `6. Server-only secrets: ${secrets.length ? secrets.map((s) => `\`${s}\``).join(', ') : '(none listed)'}.`,
    ``,
    `## HTTP flow your server exposes`,
    ``,
    '| Route | Caller | Does |',
    '|---|---|---|',
    `| \`POST /api/payments/create\` | your frontend | look up amount, create the ${cap.displayName} order, return the checkout action |`,
    `| \`POST|GET /api/payments/callback?orderRef=...\` | customer's browser (${p.returnStyle.join(' / ') || 'n/a'}) | verify, confirm status, redirect to a result page |`,
    `| \`POST /api/payments/webhook\` | ${cap.displayName} | verify signature on raw body, dedupe, update order |`,
    has(ctx, 'refunds') ? `| \`POST /api/payments/refund\` | admin only | refund with a unique refund id (idempotency key) |` : false,
    has(ctx, 'subscriptions') ? `| \`POST /api/payments/subscription\` | logged-in customer | create subscription, return its checkout action |` : false,
    ``,
    `Checkout styles ${cap.displayName} uses: ${cap.checkoutTypes.join(', ')}.`,
    `${p.trustNote}`,
    ``,
    `## Signature and API details`,
    ``,
    `Exact formulas (hash field order, separators, header names) are in this project's \`docs/research/gateway-api-facts.md\` and in the capability map:`,
    `call \`payments_get_capabilities\` with \`{ "provider": "${cap.provider}" }\`. Official docs: ${cap.docsUrl}`,
    ``,
    ...Object.entries(cap.features)
      .filter(([k]) => ['verifyPayment', 'webhooks', 'refund'].includes(k))
      .map(([k, v]) => `- **${k}** (${v.support}): ${oneLine(v.notes ?? '')}`),
    ``,
    `## Constraints`,
    ``,
    ...cap.constraints.map((c) => `- ${oneLine(c)}`),
    ``,
    `## Prototype the flow with the MCP tools first`,
    ``,
    `With \`PAYMENTS_MODE=mock\` (no keys needed), have your agent call, in order:`,
    ``,
    `1. \`payments_create_payment\` \`{ provider: "${cap.provider}", order_ref: "test_001", amount: 49900 }\``,
    `2. \`payments_mock_complete_payment\` \`{ provider: "${cap.provider}", order_ref: "test_001", outcome: "success" }\` -> a signed callback payload`,
    `3. \`payments_verify_payment\` with that payload, \`order_ref\` and \`expected_amount: 49900\``,
    `4. \`payments_get_status\` \`{ provider: "${cap.provider}", order_ref: "test_001" }\``,
    `5. \`payments_simulate_webhook\` with \`target_url: "https://YOUR_TUNNEL/api/payments/webhook"\` and run the returned curl against your server`,
    has(ctx, 'refunds') ? `6. \`payments_refund\` \`{ provider: "${cap.provider}", order_ref: "test_001", refund_ref: "rf_test_001" }\`` : false,
    ``,
    `Then switch to \`PAYMENTS_MODE=sandbox\` with test keys and repeat against your own server.`,
    ``,
  );
}
