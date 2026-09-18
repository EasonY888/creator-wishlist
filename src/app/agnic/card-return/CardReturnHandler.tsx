'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Handles both ways Agnic signals that a card was vaulted.
 *
 * Desktop opens the card form in a popup and sends a `postMessage`; mobile
 * redirects the whole page and appends `?card=success` to the return URL. Both
 * have to be handled, or the flow appears to do nothing on one of them.
 *
 * The origin check is not optional: without it, any page that can open a window
 * at us could claim a card was added. Only `https://app.agnic.ai` is trusted.
 *
 * The payload is display data only — `last4` and `brand`. No card numbers, no
 * vault aliases, nothing worth protecting passes through here.
 */
const AGNIC_ORIGIN = 'https://app.agnic.ai';

type Result =
  | { kind: 'added'; last4: string | null; brand: string | null }
  | { kind: 'cancelled' };

export function CardReturnHandler() {
  const router = useRouter();
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    // --- Mobile: the browser came back with a query parameter. ---
    const params = new URLSearchParams(window.location.search);
    const card = params.get('card');

    if (card === 'success') {
      setResult({ kind: 'added', last4: null, brand: null });
      router.refresh();
    } else if (card === 'cancelled') {
      setResult({ kind: 'cancelled' });
    }

    // --- Desktop: the popup posts a message. ---
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== AGNIC_ORIGIN) return;
      if (!event.data || typeof event.data !== 'object') return;

      const data = event.data as {
        type?: string;
        last4?: string;
        brand?: string | null;
      };

      if (data.type === 'agnic:card_added') {
        setResult({
          kind: 'added',
          last4: data.last4 ?? null,
          brand: data.brand ?? null,
        });
        // Re-render the server component so the card list reflects reality.
        router.refresh();
      }

      if (data.type === 'agnic:card_cancelled') {
        setResult({ kind: 'cancelled' });
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [router]);

  if (!result) return null;

  if (result.kind === 'added') {
    return (
      <div className="notice notice-info" style={{ marginBottom: '1rem' }}>
        <strong>
          Card added
          {result.last4 ? ` — ${result.brand ?? 'card'} •••• ${result.last4}` : ''}
        </strong>
        <div className="small">
          It went straight into the vault. Neither this app nor Agnic&apos;s
          JavaScript ever saw the number.
        </div>
      </div>
    );
  }

  return (
    <div className="notice notice-warn" style={{ marginBottom: '1rem' }}>
      <strong>Card entry was closed before finishing.</strong>
      <div className="small">Nothing was saved. You can open the form again.</div>
    </div>
  );
}
