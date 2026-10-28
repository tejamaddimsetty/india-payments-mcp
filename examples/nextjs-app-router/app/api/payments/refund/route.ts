/** POST /api/payments/refund: admin only. Replace assertAdmin with your real auth (e.g. NextAuth session + role). */
import { assertAdmin, refundPayment, toHttpError } from '@/lib/payments';

// Node runtime: the SDK uses node:crypto. Never cache payment routes.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  try {
    assertAdmin(req.headers.get('authorization'));
    return Response.json(await refundPayment(await req.json().catch(() => null)));
  } catch (err) {
    return fail(err);
  }
}

function fail(err: unknown): Response {
  const { status, body } = toHttpError(err);
  return Response.json(body, { status });
}
