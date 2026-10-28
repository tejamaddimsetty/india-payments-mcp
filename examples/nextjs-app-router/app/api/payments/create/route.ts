/** POST /api/payments/create: { orderId } -> CheckoutAction for Razorpay. The server prices the order. */
import { createCheckout, toHttpError } from '@/lib/payments';

// Node runtime: the SDK uses node:crypto. Never cache payment routes.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  try {
    const body: unknown = await req.json().catch(() => null);
    return Response.json(await createCheckout(body), { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

function fail(err: unknown): Response {
  const { status, body } = toHttpError(err);
  return Response.json(body, { status });
}
