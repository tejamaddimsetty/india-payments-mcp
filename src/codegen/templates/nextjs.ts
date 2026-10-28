import { startCheckoutModule } from './browser.js';
import { has, lines, type GeneratedFile, type TemplateContext } from './shared.js';

const ROUTE_HEADER = [
  `// Node runtime: the SDK uses node:crypto. Never cache payment routes.`,
  `export const runtime = 'nodejs';`,
  `export const dynamic = 'force-dynamic';`,
].join('\n');

/**
 * Next.js App Router route handlers. They use only the Web Request/Response API, so they need
 * nothing from 'next/server' and work on Next 13.4+.
 */
export function nextjsFiles(ctx: TemplateContext): GeneratedFile[] {
  const name = ctx.cap.displayName;
  const files: GeneratedFile[] = [];
  const route = (path: string, contents: string) => files.push({ path: `app/api/payments/${path}/route.ts`, language: 'typescript', contents });

  const errorHelper = lines(
    `function fail(err: unknown): Response {`,
    `  const { status, body } = toHttpError(err);`,
    `  return Response.json(body, { status });`,
    `}`,
  );

  route(
    'create',
    lines(
      `/** POST /api/payments/create: { orderId } -> CheckoutAction for ${name}. The server prices the order. */`,
      `import { createCheckout, toHttpError } from '@/lib/payments';`,
      ``,
      ROUTE_HEADER,
      ``,
      `export async function POST(req: Request): Promise<Response> {`,
      `  try {`,
      `    const body: unknown = await req.json().catch(() => null);`,
      `    return Response.json(await createCheckout(body), { status: 201 });`,
      `  } catch (err) {`,
      `    return fail(err);`,
      `  }`,
      `}`,
      ``,
      errorHelper,
      ``,
    ),
  );

  route(
    'callback',
    lines(
      `/**`,
      ` * Return URL for ${name}. Arrives as a form POST (PayU, CCAvenue, Paytm, Razorpay redirect mode),`,
      ` * a GET redirect (Cashfree, PhonePe, Stripe) or JSON from our own JS (Razorpay modal handler).`,
      ` */`,
      `import { confirmPayment, toHttpError } from '@/lib/payments';`,
      ``,
      ROUTE_HEADER,
      ``,
      `const RESULT_PATH = '/checkout';`,
      ``,
      `async function handle(req: Request): Promise<Response> {`,
      `  try {`,
      `    const url = new URL(req.url);`,
      `    const query = Object.fromEntries(url.searchParams);`,
      `    const contentType = req.headers.get('content-type') ?? '';`,
      `    let body: Record<string, string> = {};`,
      `    if (req.method === 'POST') {`,
      `      if (contentType.includes('application/json')) {`,
      `        const json = (await req.json().catch(() => ({}))) as Record<string, unknown>;`,
      `        body = Object.fromEntries(Object.entries(json).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v)]));`,
      `      } else {`,
      `        // application/x-www-form-urlencoded (or multipart): keep string fields only.`,
      `        const form = await req.formData();`,
      `        for (const [k, v] of form.entries()) if (typeof v === 'string') body[k] = v;`,
      `      }`,
      `    }`,
      `    const result = await confirmPayment(query, body);`,
      `    if (contentType.includes('application/json')) return Response.json(result, { status: result.orderRef ? 200 : 400 });`,
      `    // 303 turns the gateway's POST into a GET of the result page.`,
      `    const target = new URL(RESULT_PATH, process.env.PUBLIC_BASE_URL ?? url.origin);`,
      `    target.searchParams.set('orderRef', result.orderRef ?? '');`,
      `    target.searchParams.set('status', result.status);`,
      `    return Response.redirect(target, 303);`,
      `  } catch (err) {`,
      `    return fail(err);`,
      `  }`,
      `}`,
      ``,
      `export const GET = handle;`,
      `export const POST = handle;`,
      ``,
      errorHelper,
      ``,
    ),
  );

  route(
    'webhook',
    lines(
      `/**`,
      ` * ${name} webhooks. req.text() returns the exact bytes; NEVER verify against JSON.stringify(await req.json()).`,
      ` */`,
      `import { handleWebhook } from '@/lib/payments';`,
      ``,
      ROUTE_HEADER,
      ``,
      `export async function POST(req: Request): Promise<Response> {`,
      `  const rawBody = await req.text();`,
      `  const headers: Record<string, string> = {};`,
      `  req.headers.forEach((value, key) => {`,
      `    headers[key] = value;`,
      `  });`,
      `  const result = await handleWebhook({ headers, rawBody });`,
      `  return Response.json(result.body, { status: result.status });`,
      `}`,
      ``,
    ),
  );

  if (has(ctx, 'refunds')) {
    route(
      'refund',
      lines(
        `/** POST /api/payments/refund: admin only. Replace assertAdmin with your real auth (e.g. NextAuth session + role). */`,
        `import { assertAdmin, refundPayment, toHttpError } from '@/lib/payments';`,
        ``,
        ROUTE_HEADER,
        ``,
        `export async function POST(req: Request): Promise<Response> {`,
        `  try {`,
        `    assertAdmin(req.headers.get('authorization'));`,
        `    return Response.json(await refundPayment(await req.json().catch(() => null)));`,
        `  } catch (err) {`,
        `    return fail(err);`,
        `  }`,
        `}`,
        ``,
        errorHelper,
        ``,
      ),
    );
  }

  if (has(ctx, 'subscriptions')) {
    route(
      'subscription',
      lines(
        `/** POST /api/payments/subscription. TODO: require a logged-in customer. */`,
        `import { startSubscription, toHttpError } from '@/lib/payments';`,
        ``,
        ROUTE_HEADER,
        ``,
        `export async function POST(req: Request): Promise<Response> {`,
        `  try {`,
        `    return Response.json(await startSubscription(await req.json().catch(() => null)), { status: 201 });`,
        `  } catch (err) {`,
        `    return fail(err);`,
        `  }`,
        `}`,
        ``,
        errorHelper,
        ``,
      ),
    );
  }

  route(
    'mock-complete',
    lines(
      `/** Dev only: finish a payment in PAYMENTS_MODE=mock. Returns 404 in sandbox/live. */`,
      `import { mockComplete, toHttpError } from '@/lib/payments';`,
      ``,
      ROUTE_HEADER,
      ``,
      `export async function POST(req: Request): Promise<Response> {`,
      `  try {`,
      `    return Response.json(await mockComplete(await req.json().catch(() => null)));`,
      `  } catch (err) {`,
      `    return fail(err);`,
      `  }`,
      `}`,
      ``,
      errorHelper,
      ``,
    ),
  );

  files.push({ path: 'lib/start-checkout.ts', language: 'typescript', contents: startCheckoutModule(ctx.cap, { typescript: true, resultPath: '/checkout' }) });
  files.push({ path: 'components/CheckoutButton.tsx', language: 'tsx', contents: checkoutButton(name, '@/lib/start-checkout', true) });
  files.push({
    path: 'app/checkout/page.tsx',
    language: 'tsx',
    contents: lines(
      `/** Checkout + result page. The callback redirects here with ?orderRef=...&status=... */`,
      `import { CheckoutButton } from '@/components/CheckoutButton';`,
      ``,
      `export default async function CheckoutPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {`,
      `  // Next 15: searchParams is a Promise. (On Next 14, drop the await.)`,
      `  const { status, orderRef } = await searchParams;`,
      `  return (`,
      `    <main style={{ maxWidth: 480, margin: '4rem auto', fontFamily: 'system-ui' }}>`,
      `      <h1>Checkout</h1>`,
      `      {status && (`,
      `        // Display only. The order is fulfilled server-side by the callback/webhook, never by this page.`,
      `        <p role="status">`,
      `          Payment {orderRef}: <strong>{status === 'captured' ? 'successful' : status}</strong>`,
      `        </p>`,
      `      )}`,
      `      <CheckoutButton orderId="demo-order-1" />`,
      `    </main>`,
      `  );`,
      `}`,
      ``,
    ),
  });
  return files;
}

/** A small client component + hook. Shared by the Next.js and React generators. */
export function checkoutButton(displayName: string, importPath: string, useClientDirective: boolean): string {
  return lines(
    useClientDirective ? `'use client';\n` : false,
    `/**`,
    ` * Pay button for ${displayName}. Sends only the order id; the server prices it and returns the`,
    ` * CheckoutAction, which startCheckout() renders (redirect / form POST / SDK modal / instructions).`,
    ` */`,
    `import { useCallback, useRef, useState } from 'react';`,
    `import { payForOrder, type CheckoutOutcome } from '${importPath}';`,
    ``,
    `export function useCheckout() {`,
    `  const [busy, setBusy] = useState(false);`,
    `  const [outcome, setOutcome] = useState<CheckoutOutcome | null>(null);`,
    `  const containerRef = useRef<HTMLDivElement>(null);`,
    ``,
    `  const pay = useCallback(async (orderId: string) => {`,
    `    setBusy(true);`,
    `    setOutcome(null);`,
    `    try {`,
    `      const result = await payForOrder(orderId, { container: containerRef.current ?? undefined });`,
    `      setOutcome(result);`,
    `    } catch (err) {`,
    `      setOutcome({ kind: 'error', message: err instanceof Error ? err.message : String(err) });`,
    `    } finally {`,
    `      setBusy(false);`,
    `    }`,
    `  }, []);`,
    ``,
    `  return { pay, busy, outcome, containerRef };`,
    `}`,
    ``,
    `export function CheckoutButton({ orderId, label = 'Pay now' }: { orderId: string; label?: string }) {`,
    `  const { pay, busy, outcome, containerRef } = useCheckout();`,
    `  return (`,
    `    <div>`,
    `      <button type="button" onClick={() => pay(orderId)} disabled={busy}>`,
    `        {busy ? 'Starting checkout...' : label}`,
    `      </button>`,
    `      {/* Stripe Payment Element mounts here (payment_intent flow only). */}`,
    `      <div ref={containerRef} />`,
    `      {outcome?.kind === 'manual' && (`,
    `        <p>`,
    `          {outcome.instructions}`,
    `          {outcome.url && (`,
    `            <>`,
    `              {' '}`,
    `              <a href={outcome.url}>Continue</a>`,
    `            </>`,
    `          )}`,
    `        </p>`,
    `      )}`,
    `      {outcome?.kind === 'dismissed' && <p>Checkout closed. You have not been charged.</p>}`,
    `      {outcome?.kind === 'error' && <p role="alert">{outcome.message}</p>}`,
    `    </div>`,
    `  );`,
    `}`,
    ``,
  );
}

/** lib/payments.ts for Next.js = the shared service with a globalThis singleton. */
export const NEXT_SERVICE_PATH = 'lib/payments.ts';
