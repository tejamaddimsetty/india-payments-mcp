/** Checkout + result page. The callback redirects here with ?orderRef=...&status=... */
import { CheckoutButton } from '@/components/CheckoutButton';

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  // Next 15: searchParams is a Promise. (On Next 14, drop the await.)
  const { status, orderRef } = await searchParams;
  return (
    <main style={{ maxWidth: 480, margin: '4rem auto', fontFamily: 'system-ui' }}>
      <h1>Checkout</h1>
      {status && (
        // Display only. The order is fulfilled server-side by the callback/webhook, never by this page.
        <p role="status">
          Payment {orderRef}: <strong>{status === 'captured' ? 'successful' : status}</strong>
        </p>
      )}
      <CheckoutButton orderId="demo-order-1" />
    </main>
  );
}
