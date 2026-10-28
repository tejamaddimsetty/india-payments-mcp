/**
 * Razorpay webhooks. req.text() returns the exact bytes; NEVER verify against JSON.stringify(await req.json()).
 */
import { handleWebhook } from '@/lib/payments';

// Node runtime: the SDK uses node:crypto. Never cache payment routes.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const result = await handleWebhook({ headers, rawBody });
  return Response.json(result.body, { status: result.status });
}
