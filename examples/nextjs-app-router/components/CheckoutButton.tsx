'use client';

/**
 * Pay button for Razorpay. Sends only the order id; the server prices it and returns the
 * CheckoutAction, which startCheckout() renders (redirect / form POST / SDK modal / instructions).
 */
import { useCallback, useRef, useState } from 'react';
import { payForOrder, type CheckoutOutcome } from '@/lib/start-checkout';

export function useCheckout() {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CheckoutOutcome | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const pay = useCallback(async (orderId: string) => {
    setBusy(true);
    setOutcome(null);
    try {
      const result = await payForOrder(orderId, { container: containerRef.current ?? undefined });
      setOutcome(result);
    } catch (err) {
      setOutcome({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, []);

  return { pay, busy, outcome, containerRef };
}

export function CheckoutButton({ orderId, label = 'Pay now' }: { orderId: string; label?: string }) {
  const { pay, busy, outcome, containerRef } = useCheckout();
  return (
    <div>
      <button type="button" onClick={() => pay(orderId)} disabled={busy}>
        {busy ? 'Starting checkout...' : label}
      </button>
      {/* Stripe Payment Element mounts here (payment_intent flow only). */}
      <div ref={containerRef} />
      {outcome?.kind === 'manual' && (
        <p>
          {outcome.instructions}
          {outcome.url && (
            <>
              {' '}
              <a href={outcome.url}>Continue</a>
            </>
          )}
        </p>
      )}
      {outcome?.kind === 'dismissed' && <p>Checkout closed. You have not been charged.</p>}
      {outcome?.kind === 'error' && <p role="alert">{outcome.message}</p>}
    </div>
  );
}
