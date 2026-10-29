/**
 * Integration code generator behind the `payments_generate_integration` MCP tool.
 *
 * Output is a set of files (path + contents) that an agent writes into the user's project, plus the
 * human-only steps (dashboard settings) and a test checklist. Server code always goes through the
 * india-payments-mcp SDK, so signature rules and amount handling are never re-implemented per project.
 *
 * Provider facts (credentials, SDK links, plugins, constraints) are read from the live capability
 * maps in src/providers, so the generated env template can never drift from what the SDK reads.
 */
import type { ProviderCapabilities } from '../core/capabilities.js';
import type { ProviderId } from '../core/types.js';
import { PROVIDERS } from '../providers/index.js';
import { jsSdkFor, startCheckoutModule } from './templates/browser.js';
import { mobileGuide, otherSpec, shopifyGuide, shopifyReconcileServer } from './templates/docs.js';
import { infinityFiles, infinityGuide } from './templates/infinity.js';
import { skydoFiles, skydoGuide } from './templates/skydo.js';
import { expressFiles } from './templates/express.js';
import { fastifyFiles } from './templates/fastify.js';
import { htmlFiles } from './templates/html.js';
import { checkoutButton, NEXT_SERVICE_PATH, nextjsFiles } from './templates/nextjs.js';
import { dashboardStepsFor, profileFor } from './templates/profiles.js';
import { serviceModule } from './templates/service.js';
import { envFile, envVarsFor, oneLine, type Feature, type GeneratedFile, type TemplateContext } from './templates/shared.js';

export const FRAMEWORKS = ['express', 'nextjs', 'fastify', 'react', 'html', 'react-native', 'flutter', 'shopify', 'other'] as const;
export type Framework = (typeof FRAMEWORKS)[number];
export type IntegrationFeature = Feature;
export type { GeneratedFile };

export interface GenerateIntegrationOptions {
  provider: ProviderId;
  framework: Framework;
  /** Default: checkout + webhooks. */
  features?: IntegrationFeature[];
}

export interface GeneratedIntegration {
  provider: ProviderId;
  framework: Framework;
  summary: string;
  files: GeneratedFile[];
  envVars: string[];
  dashboardSteps: string[];
  testChecklist: string[];
  warnings: string[];
}

const DEFAULT_FEATURES: IntegrationFeature[] = ['checkout', 'webhooks'];

export function generateIntegration(opts: GenerateIntegrationOptions): GeneratedIntegration {
  const mod = PROVIDERS[opts.provider];
  if (!mod) throw new Error(`Unknown provider "${opts.provider}".`);
  if (!(FRAMEWORKS as readonly string[]).includes(opts.framework)) {
    throw new Error(`Unknown framework "${opts.framework}". Use one of: ${FRAMEWORKS.join(', ')}.`);
  }
  const cap = mod.capabilities;
  const warnings: string[] = [];
  const features = resolveFeatures(cap, opts.features, warnings);
  const ctx: TemplateContext = { cap, features, orderRefField: profileFor(cap.provider).orderRefField };

  if (cap.provider === 'skydo') return skydo(ctx, opts.framework, warnings);
  if (cap.provider === 'infinity') return infinity(ctx, opts.framework, warnings);
  if (opts.framework === 'shopify') return shopify(ctx, warnings);

  const files: GeneratedFile[] = [];
  let summary: string;
  const fw = opts.framework;

  switch (fw) {
    case 'express':
      files.push(...expressServer(ctx, 'src'), ...htmlFiles(cap));
      summary = `Express server (${routeList(features)}) using india-payments-mcp, plus a static checkout page that renders ${cap.displayName}'s checkout.`;
      break;
    case 'fastify':
      files.push({ path: 'src/payments/service.ts', language: 'typescript', contents: serviceModule(ctx, { singleton: false, resultPath: '/checkout.html' }) });
      files.push(...fastifyFiles(ctx, 'src'), ...htmlFiles(cap));
      summary = `Fastify plugin (${routeList(features)}) using india-payments-mcp, with the webhook in a raw-body scope, plus a static checkout page.`;
      break;
    case 'nextjs':
      files.push({ path: NEXT_SERVICE_PATH, language: 'typescript', contents: serviceModule(ctx, { singleton: true, resultPath: '/checkout' }) });
      files.push(...nextjsFiles(ctx));
      summary = `Next.js App Router route handlers (${routeList(features)}) using india-payments-mcp, a client CheckoutButton and a /checkout page.`;
      break;
    case 'react':
      files.push(...expressServer(ctx, 'server'));
      files.push({ path: 'src/payments/startCheckout.ts', language: 'typescript', contents: startCheckoutModule(cap, { typescript: true, resultPath: '/checkout.html' }) });
      files.push({ path: 'src/payments/CheckoutButton.tsx', language: 'tsx', contents: checkoutButton(cap.displayName, './startCheckout', false) });
      summary = `React hook + CheckoutButton for ${cap.displayName}, and the Express backend it needs (React apps cannot hold gateway secrets). Proxy /api to the server in dev (Vite: server.proxy).`;
      break;
    case 'html':
      files.push(...expressServer(ctx, 'server'), ...htmlFiles(cap));
      summary = `Plain HTML + ES module checkout script for ${cap.displayName}, served by a small Express backend that holds the secrets.`;
      break;
    case 'react-native':
    case 'flutter':
      files.push(...expressServer(ctx, 'server'));
      files.push({ path: 'docs/MOBILE_PAYMENTS.md', language: 'markdown', contents: mobileGuide(ctx, fw) });
      summary = `Express backend for a ${fw === 'flutter' ? 'Flutter' : 'React Native'} app plus a guide mapping the /api/payments/create response onto ${cap.displayName}'s mobile SDK. Secrets stay server-side.`;
      if (!['razorpay', 'cashfree', 'paytm', 'stripe'].includes(cap.provider)) {
        warnings.push(`${cap.displayName}'s native mobile SDK needs server material this SDK does not produce yet; the guide uses the in-app browser / WebView flow instead.`);
      }
      break;
    case 'other':
      files.push({ path: 'docs/PAYMENTS_INTEGRATION_SPEC.md', language: 'markdown', contents: otherSpec(ctx) });
      summary = `Language-agnostic integration spec for ${cap.displayName}: HTTP routes, verification rules, constraints and the MCP tool calls to prototype the flow.`;
      break;
  }
  files.push(envFile(ctx));

  addProviderWarnings(cap, fw, warnings);
  return {
    provider: cap.provider,
    framework: fw,
    summary,
    files,
    envVars: envVarsFor(ctx),
    dashboardSteps: dashboardStepsFor(cap, features),
    testChecklist: testChecklist(ctx, fw),
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------

function resolveFeatures(cap: ProviderCapabilities, requested: IntegrationFeature[] | undefined, warnings: string[]): Set<Feature> {
  const out = new Set<Feature>(requested && requested.length > 0 ? requested : DEFAULT_FEATURES);
  out.add('checkout'); // every integration starts with taking a payment
  const check = (f: Feature, key: 'refund' | 'subscriptions' | 'webhooks') => {
    if (!out.has(f)) return;
    const s = cap.features[key];
    if (s.support === 'unsupported' || s.support === 'not_implemented') {
      out.delete(f);
      warnings.push(
        `${f} skipped: ${cap.displayName} ${s.support === 'unsupported' ? 'does not offer it' : 'offers it but this SDK does not implement it yet'}.${s.notes ? ' ' + oneLine(s.notes) : ''}`,
      );
    } else if (s.support === 'partial' && s.notes) {
      warnings.push(`${f} is partial on ${cap.displayName}: ${oneLine(s.notes)}`);
    }
  };
  check('refunds', 'refund');
  check('subscriptions', 'subscriptions');
  check('webhooks', 'webhooks');
  // The generated server always exposes the webhook route: it is how payments complete when the
  // customer closes the tab. Only skip it when the gateway has no webhooks at all.
  if (cap.features.webhooks.support !== 'unsupported') out.add('webhooks');
  return out;
}

function expressServer(ctx: TemplateContext, base: string): GeneratedFile[] {
  return [
    { path: `${base}/payments/service.ts`, language: 'typescript', contents: serviceModule(ctx, { singleton: false, resultPath: '/checkout.html' }) },
    ...expressFiles(ctx, base),
  ];
}

function routeList(features: ReadonlySet<Feature>): string {
  return [
    'create',
    'callback',
    'webhook',
    features.has('refunds') && 'refund',
    features.has('subscriptions') && 'subscription',
  ]
    .filter(Boolean)
    .join(', ');
}

function addProviderWarnings(cap: ProviderCapabilities, fw: string, warnings: string[]) {
  const p = profileFor(cap.provider);
  if (p.returnStyle.includes('redirect_get') && !p.returnStyle.includes('form_post')) {
    warnings.push(`${cap.displayName}'s browser return is unsigned: the generated callback always confirms with the status API, and the webhook is the source of truth.`);
  }
  if (cap.provider === 'stripe') warnings.push('Stripe accounts in India are invite-only; treat Stripe as an international/exports gateway.');
  if (cap.provider === 'ccavenue') warnings.push('CCAvenue: whitelist your server egress IP and register the callback domain before testing; status/refund APIs fail otherwise. Most CCAvenue API details are not publicly documented: test in sandbox.');
  if (cap.provider === 'cashfree' && fw !== 'other') warnings.push('Cashfree: whitelist the checkout domain in the dashboard or cashfree.js will not open.');
  if (cap.provider === 'phonepe') warnings.push('PhonePe webhooks are authenticated by a static header that does not sign the body; the generated handler re-fetches order status before changing state.');
  if (fw !== 'other') {
    warnings.push('The generated data layer (orders, attempts) and the webhook dedupe store are in-memory stubs: replace them with your database before running more than one instance or deploying to serverless.');
  }
}

function testChecklist(ctx: TemplateContext, fw: Framework): string[] {
  const { cap } = ctx;
  const run = fw === 'nextjs' ? 'npm run dev' : fw === 'other' ? 'start your server' : 'npx tsx ' + (['express', 'fastify'].includes(fw) ? 'src' : 'server') + '/server.ts';
  const page = fw === 'nextjs' ? '/checkout' : '/checkout.html';
  const list = [
    `Mock mode: set PAYMENTS_MODE=mock (no keys needed), ${run}, open ${page}, click Pay and choose success; the result shows "captured" and the server logs order.fulfilled exactly once.`,
    `Mock failure path: click Pay and cancel the dialog; the order must NOT be fulfilled.`,
    `Tampering: POST /api/payments/create with an extra "amount": 1 field; the created payment must still use the server price.`,
    `Sandbox: set PAYMENTS_MODE=sandbox and the ${cap.displayName} test credentials, run the payments_check_config MCP tool (or \`npx india-payments-mcp doctor\`), then pay with the gateway's test UPI/card.`,
    `Expose your server with a tunnel (e.g. \`cloudflared tunnel --url http://localhost:3000\` or ngrok), set PUBLIC_BASE_URL to the tunnel URL and register {tunnel}/api/payments/webhook in the dashboard.`,
    `Simulate a webhook: call payments_simulate_webhook { provider: "${cap.provider}", type: "payment.succeeded", order_ref: <an orderRef from your logs>, amount: 49900, target_url: "<PUBLIC_BASE_URL>/api/payments/webhook" } and run the returned curl. Expect 200 {ok:true}; run it again and expect {duplicate:true}. (In sandbox the MCP server must have the same webhook secret as your app.)`,
    `Bad signature: edit one byte of that curl body and resend; expect 400 and no state change.`,
  ];
  if (ctx.features.has('refunds')) {
    list.push(`Refund: POST /api/payments/refund with Authorization: Bearer $ADMIN_API_TOKEN and { "orderRef": "...", "amount": 100 }; confirm the refund.processed webhook updates the attempt. Without the token expect 401.`);
  }
  if (ctx.features.has('subscriptions')) {
    list.push('Subscription: create one in sandbox, authorise it, and confirm the subscription.activated webhook arrives.');
  }
  list.push(
    `Go-live: PAYMENTS_MODE=live with live keys, a live webhook (separate secret), HTTPS PUBLIC_BASE_URL, real database for attempts + webhook dedupe${ctx.features.has('refunds') ? ', refund route behind real admin auth' : ''}; then make one real low-value payment and refund it.`,
  );
  return list;
}

function skydo(ctx: TemplateContext, framework: Framework, warnings: string[]): GeneratedIntegration {
  const { cap } = ctx;
  warnings.push(
    'Skydo has no public developer API, SDK or webhooks. The generated code never calls Skydo: it uses Skydo\'s native Zoho Books integration (confirm during setup that Skydo imports API-created invoices) or your Skydo receiving-account details plus a ledger an admin updates. There is no website checkout, no INR, no cards/UPI and no API refunds.',
  );
  if (framework === 'shopify') warnings.push('Skydo has no Shopify payments app; this is a standalone invoicing backend.');
  const env = envFile(ctx);
  env.contents += '\n# Admin token for recording receipts / polling routes. Replace with your real auth.\nADMIN_API_TOKEN=\n';
  return {
    provider: cap.provider,
    framework,
    summary:
      'Skydo export collections: invoice via the Zoho Books bridge (Skydo marks it paid and attaches the FIRA) or bank-transfer instructions + ledger, status refresh/polling instead of webhooks, and an admin receipt route.',
    files: [...skydoFiles(framework), env, { path: 'docs/SKYDO_PAYMENTS.md', language: 'markdown', contents: skydoGuide(cap) }],
    envVars: [...envVarsFor(ctx), 'ADMIN_API_TOKEN'],
    dashboardSteps: dashboardStepsFor(cap, ctx.features),
    testChecklist: [
      'PAYMENTS_MODE=mock: POST /api/skydo/invoices, then payments_mock_complete_payment (provider skydo), then POST /api/skydo/invoices/:orderRef/refresh (admin) -> captured and onPaid runs once; GET /api/skydo/invoices/:orderRef then shows the stored status.',
      'Ledger mode: set SKYDO_RECEIVING_ACCOUNTS, create an invoice, check the instructions show the right account for the currency and the order id as reference; record a short receipt with a receiptId (stays pending), repeat it (no change), then record the rest with another receiptId (captured).',
      'Zoho bridge: create one real invoice for a test client in Zoho, confirm it appears in the Skydo dashboard within ~10 minutes, then have a small real payment (>= USD 50) sent and confirm Zoho shows it paid with the FIRA attached and pollUnpaid() fulfils it.',
      'Restart the server and confirm the ledger file kept its state.',
    ],
    warnings,
  };
}

function infinity(ctx: TemplateContext, framework: Framework, warnings: string[]): GeneratedIntegration {
  const { cap } = ctx;
  warnings.push(
    'Infinity publishes no developer API, SDK or webhooks. The generated code never calls Infinity: it uses Infinity\'s Zoho Books integration (confirm during setup that Infinity marks invoices paid in Zoho) or hands clients your Infinity receiving-account details and/or a QuickLink you created in the dashboard, with an admin recording each receipt. There is no website checkout, no INR, no UPI and no API refunds.',
  );
  if (framework === 'shopify') warnings.push('Infinity has no Shopify payments app; this is a standalone invoicing backend.');
  const env = envFile(ctx);
  env.contents += '\n# Admin token for creating invoices and recording receipts. Replace with your real auth.\nADMIN_API_TOKEN=\n';
  return {
    provider: cap.provider,
    framework,
    summary:
      'Infinity export collections: a Zoho Books invoice for Infinity\'s Zoho integration (status polled from Zoho), or bank-transfer instructions and/or your QuickLink tracked in a ledger with admin routes to record receipts.',
    files: [...infinityFiles(framework), env, { path: 'docs/INFINITY_PAYMENTS.md', language: 'markdown', contents: infinityGuide(cap) }],
    envVars: [...envVarsFor(ctx), 'ADMIN_API_TOKEN'],
    dashboardSteps: dashboardStepsFor(cap, ctx.features),
    testChecklist: [
      'PAYMENTS_MODE=mock: POST /api/infinity/invoices (admin), then payments_mock_complete_payment (provider infinity), then POST /api/infinity/invoices/:orderRef/refresh (admin) -> captured and onPaid runs once.',
      'Set INFINITY_RECEIVING_ACCOUNTS, create an invoice, check the instructions show the right account for the currency and the order id as reference.',
      'Pass a QuickLink copied from the Infinity dashboard: it must be accepted; a link on another host must be rejected.',
      'Record a short receipt with a receiptId (stays pending), repeat it (no change), then record the rest with another receiptId (captured). Restart and confirm the ledger kept its state.',
      'Zoho bridge: connect Zoho Books in the Infinity dashboard (Connect tab), create one real invoice, have a small real payment sent, and confirm Zoho shows it paid and pollUnpaid() fulfils it. If Infinity does not mark it paid in Zoho, use ledger mode.',
      'Ledger mode, first real payment: send a small real invoice, wait for the Infinity dashboard to show it received, record it, and download the FIRA once settled.',
    ],
    warnings,
  };
}

function shopify(ctx: TemplateContext, warnings: string[]): GeneratedIntegration {
  const { cap } = ctx;
  warnings.push(
    'Shopify only lets approved payment apps into checkout (custom payment extensions are Shopify Plus only), and Shopify Payments is not available to India-based stores. You cannot connect this SDK or your own server to Shopify checkout; install the gateway\'s official Shopify app instead.',
  );
  if (!cap.platformPlugins.shopify) {
    warnings.push(`${cap.displayName} has no verified official Shopify payments app. Choose a gateway that has one (Razorpay, PayU, PhonePe, Cashfree) for Shopify.`);
  }
  warnings.push('Issue refunds from Shopify Admin so Shopify and the gateway stay in sync; the generated server only reconciles.');
  const files: GeneratedFile[] = [{ path: 'docs/SHOPIFY_PAYMENTS.md', language: 'markdown', contents: shopifyGuide(ctx) }];
  if (cap.features.paymentStatus.support !== 'unsupported') {
    files.push({ path: 'src/shopify-reconcile.ts', language: 'typescript', contents: shopifyReconcileServer(ctx) });
    const env = envFile(ctx);
    env.contents += '\n# Shopify webhook signing secret (Settings > Notifications > Webhooks, or your custom app\'s API secret).\nSHOPIFY_WEBHOOK_SECRET=\n';
    files.push(env);
  }
  return {
    provider: cap.provider,
    framework: 'shopify',
    summary: `Shopify guide for ${cap.displayName}: install the official app (${cap.platformPlugins.shopify ? 'available' : 'none verified'}), plus an optional reconciliation server that checks Shopify "orders/paid" against the gateway with india-payments-mcp.`,
    files,
    envVars: files.length > 1 ? [...envVarsFor(ctx), 'SHOPIFY_WEBHOOK_SECRET'] : [],
    dashboardSteps: [
      cap.platformPlugins.shopify
        ? `Shopify Admin > Settings > Payments: add ${cap.displayName} (${oneLine(cap.platformPlugins.shopify)}).`
        : `No official ${cap.displayName} Shopify app was verified: pick another gateway for Shopify checkout.`,
      `Turn on ${cap.displayName}'s test mode in its own dashboard and place a test order in Shopify.`,
      'Shopify Admin > Settings > Notifications > Webhooks: subscribe orders/paid and refunds/create to https://YOUR_DOMAIN/webhooks/shopify (only if you run the reconciliation server).',
      ...dashboardStepsFor(cap, new Set(['checkout'])).filter((s) => /API Keys|credentials|Key and Salt|MID/i.test(s)),
    ],
    testChecklist: [
      'Place a Shopify test order with the gateway in test mode and confirm it is marked Paid in Shopify.',
      'Refund it from Shopify Admin and confirm the refund appears in the gateway dashboard.',
      'Reconciliation server (optional): run it with PAYMENTS_MODE=sandbox, send a test orders/paid webhook from Shopify, and confirm no mismatch is logged for a real test order.',
      'Adapt gatewayRefFor() after inspecting one real test order\'s transactions.',
    ],
    warnings,
  };
}

/** Convenience for docs/tests: which browser SDK branch a provider's generated client contains. */
export function browserSdkFor(provider: ProviderId) {
  return jsSdkFor(PROVIDERS[provider].capabilities);
}
