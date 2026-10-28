/** Dev only: finish a payment in PAYMENTS_MODE=mock. Returns 404 in sandbox/live. */
import { mockComplete, toHttpError } from '@/lib/payments';

// Node runtime: the SDK uses node:crypto. Never cache payment routes.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  try {
    return Response.json(await mockComplete(await req.json().catch(() => null)));
  } catch (err) {
    return fail(err);
  }
}

function fail(err: unknown): Response {
  const { status, body } = toHttpError(err);
  return Response.json(body, { status });
}
