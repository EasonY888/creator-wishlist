'use client';

import { useState } from 'react';

import { refundOrder } from './actions';

/**
 * The operator's refund control.
 *
 * Two deliberate speed bumps, because this moves real money and there is no undo
 * from here:
 *
 *   1. The merchant refund reference is required by the form AND re-checked
 *      before submitting. An operator has to have actually seen the out-of-band
 *      refund, so the field is a record of a real event rather than a formality.
 *   2. An explicit confirmation names the amount.
 *
 * The order is only marked refunded after the payment rail confirms money moved,
 * so a failed attempt leaves the order exactly as it was.
 */
export default function RefundForm({
  fanOrderId,
  amountLabel,
}: {
  fanOrderId: string;
  amountLabel: string;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <form
      action={refundOrder}
      onSubmit={(event) => {
        const entered = String(
          new FormData(event.currentTarget).get('reference') ?? '',
        ).trim();

        if (entered.length < 4) {
          event.preventDefault();
          return;
        }

        const confirmed = window.confirm(
          `Refund ${amountLabel} to the fan?\n\n` +
            'This returns money through the payment rail and moves the order to ' +
            '"refunded". It cannot be undone from here.',
        );

        if (!confirmed) {
          event.preventDefault();
          return;
        }

        setBusy(true);
      }}
    >
      <input type="hidden" name="fanOrderId" value={fanOrderId} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
        <input
          name="reference"
          placeholder="Merchant refund reference"
          aria-label={`Merchant refund reference for order ${fanOrderId}`}
          required
          minLength={4}
          maxLength={200}
          autoComplete="off"
          style={{ minWidth: '14rem' }}
        />

        <button type="submit" disabled={busy}>
          {busy ? 'Refunding…' : 'Refund'}
        </button>
      </div>
    </form>
  );
}
