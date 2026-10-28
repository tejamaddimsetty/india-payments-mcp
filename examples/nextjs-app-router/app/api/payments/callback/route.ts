/**
 * Return URL for Razorpay. Arrives as a form POST (PayU, CCAvenue, Paytm, Razorpay redirect mode),
 * a GET redirect (Cashfree, PhonePe, Stripe) or JSON from our own JS (Razorpay modal handler).
 */
import { confirmPayment, toHttpError } from '@/lib/payments';

// Node runtime: the SDK uses node:crypto. Never cache payment routes.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESULT_PATH = '/checkout';

async function handle(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const query = Object.fromEntries(url.searchParams);
    const contentType = req.headers.get('content-type') ?? '';
    let body: Record<string, string> = {};
    if (req.method === 'POST') {
      if (contentType.includes('application/json')) {
        const json = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        body = Object.fromEntries(Object.entries(json).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v)]));
      } else {
        // application/x-www-form-urlencoded (or multipart): keep string fields only.
        const form = await req.formData();
        for (const [k, v] of form.entries()) if (typeof v === 'string') body[k] = v;
      }
    }
    const result = await confirmPayment(query, body);
    if (contentType.includes('application/json')) return Response.json(result, { status: result.orderRef ? 200 : 400 });
    // 303 turns the gateway's POST into a GET of the result page.
    const target = new URL(RESULT_PATH, process.env.PUBLIC_BASE_URL ?? url.origin);
    target.searchParams.set('orderRef', result.orderRef ?? '');
    target.searchParams.set('status', result.status);
    return Response.redirect(target, 303);
  } catch (err) {
    return fail(err);
  }
}

export const GET = handle;
export const POST = handle;

function fail(err: unknown): Response {
  const { status, body } = toHttpError(err);
  return Response.json(body, { status });
}
