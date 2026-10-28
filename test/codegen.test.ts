import { describe, expect, it } from 'vitest';
import { FRAMEWORKS, generateIntegration } from '../src/codegen/index.js';
import { PROVIDER_IDS } from '../src/core/types.js';
import { PROVIDERS } from '../src/providers/index.js';

const ALL_FEATURES = ['checkout', 'webhooks', 'refunds', 'subscriptions'] as const;
const SERVER_FRAMEWORKS = ['express', 'nextjs', 'fastify', 'react', 'html', 'react-native', 'flutter'] as const;

/** Things that look like real credentials. Generated code must only ever contain placeholders. */
const SECRET_PATTERNS: RegExp[] = [
  /rzp_(test|live)_[A-Za-z0-9]{8,}/,
  /\b[sr]k_(test|live)_[A-Za-z0-9]{8,}/,
  /\bpk_live_[A-Za-z0-9]{8,}/,
  /whsec_[A-Za-z0-9]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(secret|salt|password|api[_-]?key|merchant[_-]?key|working[_-]?key)\s*[:=]\s*['"][A-Za-z0-9+/_=-]{12,}['"]/i,
];

/** Source without comments, so assertions are about code, not about the explanations in it. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
}

const combos = PROVIDER_IDS.flatMap((provider) => FRAMEWORKS.map((framework) => ({ provider, framework })));

describe('generateIntegration: every provider x framework', () => {
  it.each(combos)('$provider / $framework returns files and a complete plan', ({ provider, framework }) => {
    for (const features of [undefined, [...ALL_FEATURES]]) {
      const r = generateIntegration({ provider, framework, features });
      expect(r.provider).toBe(provider);
      expect(r.framework).toBe(framework);
      expect(r.files.length).toBeGreaterThanOrEqual(1);
      expect(r.summary.length).toBeGreaterThan(20);
      expect(r.dashboardSteps.length).toBeGreaterThan(0);
      expect(r.testChecklist.length).toBeGreaterThan(0);
      const paths = r.files.map((f) => f.path);
      expect(new Set(paths).size).toBe(paths.length);
      for (const f of r.files) {
        expect(f.path).not.toMatch(/^\/|\.\./);
        expect(f.contents.trim().length).toBeGreaterThan(0);
        // Template leakage: generator-side expressions or dropped optional sections rendered as text.
        expect(f.contents).not.toMatch(/\$\{(cap|ctx|opts|profile|sdk)\b|\[object Object\]|^(undefined|false|null)$/m);
      }
    }
  });

  it.each(combos)('$provider / $framework contains no secret-looking values', ({ provider, framework }) => {
    const r = generateIntegration({ provider, framework, features: [...ALL_FEATURES] });
    for (const f of r.files) {
      for (const re of SECRET_PATTERNS) expect(f.contents, `${f.path} matches ${re}`).not.toMatch(re);
    }
    const env = r.files.find((f) => f.path === '.env.example');
    if (env) {
      const secretEnvs = new Set(PROVIDERS[provider].capabilities.credentials.filter((c) => c.secret).map((c) => c.env));
      for (const line of env.contents.split('\n')) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
        if (m && secretEnvs.has(m[1]!)) expect(m[2], `${m[1]} must be empty in .env.example`).toBe('');
      }
    }
  });
});

describe('server code', () => {
  const serverCombos = PROVIDER_IDS.filter((p) => p !== 'skydo').flatMap((provider) => SERVER_FRAMEWORKS.map((framework) => ({ provider, framework })));

  it.each(serverCombos)('$provider / $framework imports the SDK and never trusts a client amount', ({ provider, framework }) => {
    const r = generateIntegration({ provider, framework, features: [...ALL_FEATURES] });
    const service = r.files.find((f) => /(^|\/)(payments\/service|lib\/payments)\.ts$/.test(f.path));
    expect(service, 'service module').toBeDefined();
    expect(service!.contents).toMatch(/from 'india-payments-mcp'/);
    expect(service!.contents).toContain(`PROVIDER = '${provider}'`);
    expect(service!.contents).toContain('getOrderAmount(orderId)');
    expect(service!.contents).not.toMatch(/body\??\.amount|\.amount\s*=\s*req/);
    expect(service!.contents).toMatch(/verifyPayment\(PROVIDER, \{ payload, orderRef, expectedAmount: attempt\.amount \}\)/);
    expect(service!.contents).toContain('createWebhookHandler({ client: payments, provider: PROVIDER');

    // Every server-side route file goes through the service (and so through the SDK).
    const routeFiles = r.files.filter((f) => /payments\/(routes|plugin)\.ts$|app\/api\/payments\/.+\/route\.ts$/.test(f.path));
    expect(routeFiles.length).toBeGreaterThan(0);
    for (const f of routeFiles) expect(f.contents).toMatch(/from '(\.\/service\.js|@\/lib\/payments)'/);

    // env template lists exactly what the provider's capability map reads.
    for (const c of PROVIDERS[provider].capabilities.credentials) expect(r.envVars).toContain(c.env);
  });

  it.each(serverCombos)('$provider / $framework webhook route uses the raw body', ({ provider, framework }) => {
    const r = generateIntegration({ provider, framework });
    const get = (re: RegExp) => code(r.files.find((f) => re.test(f.path))?.contents ?? '');
    if (framework === 'nextjs') {
      const hook = get(/app\/api\/payments\/webhook\/route\.ts$/);
      expect(hook).toContain('await req.text()');
      expect(hook).not.toContain('req.json()');
      expect(hook).toContain("runtime = 'nodejs'");
    } else if (framework === 'fastify') {
      const plugin = get(/payments\/plugin\.ts$/);
      expect(plugin).toContain("parseAs: 'string'");
      expect(plugin).toContain('removeAllContentTypeParsers');
      expect(plugin).toContain('rawBody: req.body as string');
    } else {
      const routes = get(/payments\/routes\.ts$/);
      const raw = routes.indexOf('express.raw(');
      const json = routes.indexOf('express.json(');
      expect(raw).toBeGreaterThan(-1);
      expect(json).toBeGreaterThan(raw); // raw parser registered before any JSON parser
      expect(routes).toContain("rawBody: req.body.toString('utf8')");
      const server = get(/server\.ts$/);
      expect(server.indexOf('paymentsRouter()')).toBeLessThan(server.indexOf('express.json()'));
    }
  });

  it('refund route is admin-gated (app auth, not the MCP live rail)', () => {
    const r = generateIntegration({ provider: 'razorpay', framework: 'express', features: ['checkout', 'refunds'] });
    const service = r.files.find((f) => f.path === 'src/payments/service.ts')!.contents;
    const routes = r.files.find((f) => f.path === 'src/payments/routes.ts')!.contents;
    expect(routes).toMatch(/assertAdmin\(req\.get\('authorization'\)\);\s*res\.json\(await refundPayment/);
    expect(service).not.toContain('confirm: true');
    expect(service).toContain('timingSafeEqual');
    expect(r.envVars).toContain('ADMIN_API_TOKEN');
  });

  it('omits refund/subscription routes unless requested, and skips unsupported features with a warning', () => {
    const plain = generateIntegration({ provider: 'razorpay', framework: 'nextjs' });
    expect(plain.files.some((f) => f.path.includes('/refund/'))).toBe(false);
    const phonepe = generateIntegration({ provider: 'phonepe', framework: 'express', features: ['checkout', 'subscriptions'] });
    expect(phonepe.files.find((f) => f.path.endsWith('service.ts'))!.contents).not.toContain('startSubscription');
    expect(phonepe.warnings.some((w) => w.startsWith('subscriptions skipped'))).toBe(true);
  });
});

describe('browser checkout', () => {
  it.each([
    ['razorpay', 'new Razorpay(options)'],
    ['cashfree', "redirectTarget: '_self'"],
    ['paytm', 'Paytm.CheckoutJS.init'],
    ['stripe', 'stripe.confirmPayment'],
  ] as const)('%s gets its own JS SDK branch', (provider, needle) => {
    const r = generateIntegration({ provider, framework: 'html' });
    const js = r.files.find((f) => f.path === 'public/start-checkout.js')!.contents;
    expect(js).toContain(needle);
    expect(js).toContain("case 'form_post'");
    expect(js).toContain("case 'redirect'");
    expect(js).toContain("case 'manual'");
  });

  it('plain JS output has no TypeScript syntax left in it', () => {
    for (const provider of PROVIDER_IDS.filter((p) => p !== 'skydo')) {
      const js = code(generateIntegration({ provider, framework: 'html' }).files.find((f) => f.path.endsWith('.js'))!.contents);
      expect(js, provider).not.toMatch(/\bas (any|[A-Z]\w*)\b|<CheckoutOutcome>|<void>|: (string|unknown|Record<)|\binterface\b|^type /m);
    }
  });

  it('react output is a hook + component', () => {
    const r = generateIntegration({ provider: 'cashfree', framework: 'react' });
    const button = r.files.find((f) => f.path.endsWith('CheckoutButton.tsx'))!.contents;
    expect(button).toContain('export function useCheckout()');
    expect(button).toContain('export function CheckoutButton');
  });
});

describe('honest special cases', () => {
  it.each(FRAMEWORKS)('skydo / %s is a guide with a warning and no code', (framework) => {
    const r = generateIntegration({ provider: 'skydo', framework });
    expect(r.warnings.join(' ')).toMatch(/no public developer API/i);
    expect(r.files.every((f) => f.language === 'markdown')).toBe(true);
    expect(r.files.map((f) => f.contents).join('')).not.toContain('india-payments-mcp\'');
  });

  it.each(PROVIDER_IDS.filter((p) => p !== 'skydo'))('shopify / %s warns about approved apps and Shopify Payments in India', (provider) => {
    const r = generateIntegration({ provider, framework: 'shopify' });
    const w = r.warnings.join(' ');
    expect(w).toMatch(/approved payment apps/);
    expect(w).toMatch(/Shopify Payments is not available to India-based stores/);
    const guide = r.files.find((f) => f.path === 'docs/SHOPIFY_PAYMENTS.md')!.contents;
    if (PROVIDERS[provider].capabilities.platformPlugins.shopify) expect(guide).not.toContain('no official Shopify payments app');
    else {
      expect(guide).toContain('no official Shopify payments app');
      expect(w).toMatch(/no verified official Shopify payments app/);
    }
    const reconcile = r.files.find((f) => f.path === 'src/shopify-reconcile.ts');
    if (reconcile) {
      expect(reconcile.contents).toContain("express.raw({ type: '*/*'");
      expect(reconcile.contents).toContain('timingSafeEqual');
    }
  });

  it.each(['react-native', 'flutter'] as const)('%s ships a server plus a mobile guide that keeps secrets server-side', (framework) => {
    const r = generateIntegration({ provider: 'razorpay', framework });
    expect(r.files.some((f) => f.path === 'server/payments/service.ts')).toBe(true);
    const guide = r.files.find((f) => f.path === 'docs/MOBILE_PAYMENTS.md')!.contents;
    expect(guide).toMatch(/live ONLY on your server/);
    expect(guide).toContain(PROVIDERS.razorpay.capabilities.officialSdks[framework === 'flutter' ? 'flutter' : 'reactNative']!);
  });

  it('other produces a language-agnostic spec', () => {
    const r = generateIntegration({ provider: 'payu', framework: 'other', features: ['checkout', 'refunds'] });
    const spec = r.files.find((f) => f.path === 'docs/PAYMENTS_INTEGRATION_SPEC.md')!.contents;
    expect(spec).toContain('payments_simulate_webhook');
    expect(spec).toContain('/api/payments/refund');
    expect(spec).toContain('raw request bytes');
  });

  it('dashboard steps carry provider specifics', () => {
    expect(generateIntegration({ provider: 'ccavenue', framework: 'express' }).dashboardSteps.join(' ')).toMatch(/[Ww]hitelist your server's public egress IP/);
    expect(generateIntegration({ provider: 'payu', framework: 'express' }).dashboardSteps.join(' ')).toMatch(/surl\/furl/);
    expect(generateIntegration({ provider: 'cashfree', framework: 'express' }).dashboardSteps.join(' ')).toMatch(/Whitelisting/);
    expect(generateIntegration({ provider: 'razorpay', framework: 'express' }).dashboardSteps.join(' ')).toMatch(/payment\.captured/);
  });

  it('test checklist walks mock -> sandbox -> simulated webhook -> go-live', () => {
    const list = generateIntegration({ provider: 'razorpay', framework: 'express', features: ['checkout', 'refunds'] }).testChecklist.join('\n');
    const order = ['PAYMENTS_MODE=mock', 'PAYMENTS_MODE=sandbox', 'payments_simulate_webhook', 'target_url', 'Refund', 'Go-live'].map((s) => list.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
