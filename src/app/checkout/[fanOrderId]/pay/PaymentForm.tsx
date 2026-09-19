'use client';

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { verifyPayment } from '@/app/checkout/actions';

/**
 * The card step.
 *
 * The card is entered into a Stripe iframe and posted to Stripe directly, so no
 * card data reaches this application or its server (NFR-2.1). All we ever hold
 * is a reference to the resulting intent.
 *
 * Two paths exist because 3DS exists:
 *
 *   - Ordinary card: `redirect: 'if_required'` keeps the fan on this page, and
 *     we verify immediately.
 *   - Step-up required: Stripe redirects to `return_url`, and the fan comes back
 *     to this same page with `?finish=1`.
 *
 * In BOTH cases the browser's word is not taken for anything. A browser can
 * report success for a flow that was then abandoned, and `return_url` is
 * reachable by anyone who types it -- so the server re-reads the intent from the
 * processor before anything is queued.
 */

// Built once per key. `loadStripe` injects a script tag, so calling it per
// render would re-inject on every state change.
let cached: Promise<Stripe | null> | null = null;
function getStripe(publishableKey: string): Promise<Stripe | null> {
  cached ??= loadStripe(publishableKey);
  return cached;
}

interface Props {
  fanOrderId: string;
  clientSecret: string;
  publishableKey: string;
  amountLabel: string;
}

export default function PaymentForm({
  fanOrderId,
  clientSecret,
  publishableKey,
  amountLabel,
}: Props) {
  return (
    <Elements
      stripe={getStripe(publishableKey)}
      options={{ clientSecret, appearance: { theme: 'stripe' } }}
    >
      <CardForm fanOrderId={fanOrderId} amountLabel={amountLabel} />
    </Elements>
  );
}

function CardForm({ fanOrderId, amountLabel }: { fanOrderId: string; amountLabel: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!stripe || !elements) return;

    setBusy(true);
    setMessage(null);

    let error;
    let paymentIntent;

    try {
      ({ error, paymentIntent } = await stripe.confirmPayment({
        elements,
        // Stay on the page unless the bank insists on a redirect.
        redirect: 'if_required',
        confirmParams: {
          return_url: `${window.location.origin}/checkout/${fanOrderId}/pay?finish=1`,
        },
      }));
    } catch {
      // `confirmPayment` can *reject* rather than resolve with `{ error }`, and
      // there was no catch here -- so an interrupted confirm left the button
      // reading "Confirming…", disabled, with no message and no way back except
      // reloading the page. Observed against a PaymentElement that had collapsed
      // to 2px, where the confirm never settles.
      //
      // The card is still on the page, so this is a message, not a dead end.
      setMessage(
        'Something interrupted the card step. Nothing has been charged — please try again.',
      );
      setBusy(false);
      return;
    }

    if (error) {
      // The card is still on the page, so this is a message, not a dead end.
      setMessage(error.message ?? 'That card could not be used.');
      setBusy(false);
      return;
    }

    if (paymentIntent && paymentIntent.status !== 'requires_payment_method') {
      // `settle` owns `busy` from here, because it navigates on success.
      await settle(fanOrderId, router, setMessage, setBusy);
      return;
    }

    setMessage('Your payment was not completed. Nothing has been charged.');
    setBusy(false);
  }

  return (
    // className="card" only adds a border/padding/radius to this element — the
    // one ancestor PaymentElement actually has. No overflow, height, max-height,
    // transform, zoom or scale here or anywhere above it: that's what collapses
    // the Stripe iframe. The container only gets room to grow, never a cap.
    <form onSubmit={submit} className="card" style={{ marginTop: '1.25rem' }}>
      <PaymentElement />

      {message ? (
        <div className="notice notice-warn" style={{ marginTop: '1.1rem' }}>
          {message}
        </div>
      ) : null}

      <button className="primary" type="submit" disabled={!stripe || busy} style={{ marginTop: '1.1rem' }}>
        {busy ? 'Confirming…' : `Pay ${amountLabel}`}
      </button>

      <p className="muted small" style={{ marginTop: '0.85rem' }}>
        This places a hold for {amountLabel}. You are charged only once the shop
        confirms the order &mdash; and never more than this amount.
      </p>
    </form>
  );
}

/**
 * The landing point after a bank redirect.
 *
 * Runs once on mount and deliberately does not trust the query string. The
 * parameters say what the *browser* was told; the server asks the processor
 * instead.
 */
export function FinishPayment({ fanOrderId }: { fanOrderId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>('Confirming with your bank…');
  // React 18+ runs effects twice in development, and this one spends money.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void settle(fanOrderId, router, setMessage, () => undefined);
  }, [fanOrderId, router]);

  return (
    <div className="notice notice-info" style={{ marginTop: '1.25rem' }}>
      {message}
    </div>
  );
}

/** In fake mode there is no card to collect, just the same server-side check. */
export function ConfirmWithoutCard({ fanOrderId }: { fanOrderId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div style={{ marginTop: '1.25rem' }}>
      <button
        className="primary"
        type="button"
        disabled={busy}
        onClick={() => void settle(fanOrderId, router, setMessage, setBusy)}
      >
        {busy ? 'Confirming…' : 'Confirm payment'}
      </button>

      {message ? (
        <div className="notice notice-warn" style={{ marginTop: '1rem' }}>
          {message}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Ask the server what actually happened, then go where the answer implies.
 *
 * Shared by all three entry points so the success and failure wording cannot
 * drift between the card path, the bank-redirect path and test mode.
 */
async function settle(
  fanOrderId: string,
  router: ReturnType<typeof useRouter>,
  setMessage: (value: string | null) => void,
  setBusy: (value: boolean) => void,
): Promise<void> {
  const result = await verifyPayment(fanOrderId);

  if (result.state === 'authorized') {
    router.push(`/orders/${fanOrderId}`);
    return;
  }

  setMessage(result.message);
  setBusy(false);
}
