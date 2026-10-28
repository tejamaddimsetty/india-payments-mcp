import { has, lines, type GeneratedFile, type TemplateContext } from './shared.js';

/** Fastify (v4/v5) plugin. The webhook lives in its own encapsulated scope with a raw-string parser. */
export function fastifyFiles(ctx: TemplateContext, base = 'src'): GeneratedFile[] {
  const refunds = has(ctx, 'refunds');
  const subs = has(ctx, 'subscriptions');
  const svcImports = ['confirmPayment', 'createCheckout', 'handleWebhook', 'mockComplete', 'toHttpError', ...(refunds ? ['assertAdmin', 'refundPayment'] : []), ...(subs ? ['startSubscription'] : [])];

  const plugin = lines(
    `/**`,
    ` * ${ctx.cap.displayName} payment routes as a Fastify plugin.`,
    ` * Requires @fastify/formbody for gateways that POST form fields back to the callback.`,
    ` */`,
    `import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';`,
    `import formbody from '@fastify/formbody';`,
    `import { ${svcImports.sort().join(', ')} } from './service.js';`,
    ``,
    `const RESULT_PATH = '/checkout.html';`,
    ``,
    `function flatten(input: unknown): Record<string, string> {`,
    `  const out: Record<string, string> = {};`,
    `  if (!input || typeof input !== 'object') return out;`,
    `  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {`,
    `    const first = Array.isArray(v) ? v[0] : v;`,
    `    if (first !== undefined && first !== null && typeof first !== 'object') out[k] = String(first);`,
    `  }`,
    `  return out;`,
    `}`,
    ``,
    `export async function paymentsPlugin(app: FastifyInstance): Promise<void> {`,
    `  app.setErrorHandler((err, _req, reply) => {`,
    `    const { status, body } = toHttpError(err);`,
    `    void reply.status(status).send(body);`,
    `  });`,
    ``,
    `  // Webhook in an encapsulated child scope: here (and only here) every body stays a raw string,`,
    `  // because signatures are computed over the exact bytes the gateway sent.`,
    `  await app.register(async (scope) => {`,
    `    scope.removeAllContentTypeParsers();`,
    `    scope.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));`,
    `    scope.post('/api/payments/webhook', async (req, reply) => {`,
    `      const result = await handleWebhook({ headers: req.headers, rawBody: req.body as string });`,
    `      return reply.status(result.status).send(result.body);`,
    `    });`,
    `  });`,
    ``,
    `  // Everything else: JSON (built in) and application/x-www-form-urlencoded (gateway returns).`,
    `  await app.register(async (scope) => {`,
    `    await scope.register(formbody);`,
    ``,
    `    scope.post('/api/payments/create', async (req, reply) => reply.status(201).send(await createCheckout(req.body)));`,
    ``,
    `    // Return URL: form POST (PayU, CCAvenue, Paytm, Razorpay redirect), GET redirect (Cashfree, PhonePe, Stripe),`,
    `    // or JSON from our own JS (Razorpay modal handler).`,
    `    const callback = async (req: FastifyRequest, reply: FastifyReply) => {`,
    `      const result = await confirmPayment(flatten(req.query), req.method === 'POST' ? flatten(req.body) : {});`,
    `      const wantsJson = (req.headers['content-type'] ?? '').includes('application/json') || (req.headers.accept ?? '').startsWith('application/json');`,
    `      if (wantsJson) return reply.status(result.orderRef ? 200 : 400).send(result);`,
    `      const q = new URLSearchParams({ orderRef: result.orderRef ?? '', status: result.status });`,
    `      return reply.redirect(\`\${RESULT_PATH}?\${q}\`, 303);`,
    `    };`,
    `    scope.post('/api/payments/callback', callback);`,
    `    scope.get('/api/payments/callback', callback);`,
    refunds
      ? lines(
          ``,
          `    // Admin only. Replace assertAdmin with your real auth (session + role).`,
          `    scope.post('/api/payments/refund', async (req) => {`,
          `      assertAdmin(req.headers.authorization);`,
          `      return refundPayment(req.body);`,
          `    });`,
        )
      : false,
    subs
      ? lines(
          ``,
          `    // TODO: require a logged-in customer here.`,
          `    scope.post('/api/payments/subscription', async (req, reply) => reply.status(201).send(await startSubscription(req.body)));`,
        )
      : false,
    ``,
    `    // Dev only: 404 unless PAYMENTS_MODE=mock.`,
    `    scope.post('/api/payments/mock-complete', async (req) => mockComplete(req.body));`,
    `  });`,
    `}`,
    ``,
  );

  const server = lines(
    `/**`,
    ` * Minimal Fastify server. Run: npx tsx ${base}/server.ts`,
    ` * Dependencies: fastify @fastify/formbody @fastify/static ${'india-payments-mcp'}`,
    ` */`,
    `import Fastify from 'fastify';`,
    `import fastifyStatic from '@fastify/static';`,
    `import { resolve } from 'node:path';`,
    `import { paymentsPlugin } from './payments/plugin.js';`,
    ``,
    `const app = Fastify({ logger: true, trustProxy: true });`,
    `await app.register(paymentsPlugin);`,
    `await app.register(fastifyStatic, { root: resolve('public') });`,
    ``,
    `await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });`,
    ``,
  );

  return [
    { path: `${base}/payments/plugin.ts`, language: 'typescript', contents: plugin },
    { path: `${base}/server.ts`, language: 'typescript', contents: server },
  ];
}
