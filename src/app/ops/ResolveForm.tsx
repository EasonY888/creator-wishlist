'use client';

import { useRef, useState } from 'react';

import { resolveStuckOrder } from './actions';

/**
 * The operator's last resort for an order nothing could settle.
 *
 * A `human_handoff` polls indefinitely and correctly, so an order whose merchant
 * never resolves sits in `processing` forever. This is the only exit.
 *
 * Three deliberate frictions, because this declares a money state:
 *
 *   1. An evidence reference is required — the operator has to have actually
 *      looked at the merchant, and that reference is the only record of it.
 *   2. A confirmation names both what is being asserted and what will happen to
 *      the fan's money.
 *   3. The amount is asked for in dollars, matching what the operator is reading
 *      off the merchant's page. Typing "1599" for $15.99 is how a decimal point
 *      becomes a real charge.
 *
 * The failure button is styled as a normal button and the success one is not
 * emphasised either: neither is the safe default here, so neither should look
 * like one.
 *
 * One trap worth recording, because it silently inverted this form. A submit
 * button cannot carry the decision in `name`/`value` when `formAction` is a
 * server action: React needs the `name` for its own action encoding and
 * overrides it, so `<button name="decision" value="succeeded">` sends nothing.
 * The action then fell through to its default -- `failed` -- which meant an
 * operator clicking "It completed -- charge" would have RELEASED the hold
 * instead of charging the fan. The decision now travels in a hidden input that
 * the click handler sets, which is ordinary form data and cannot be hijacked by
 * the action encoder.
 */
export default function ResolveForm({
  fanOrderId,
  approvedLabel,
}: {
  fanOrderId: string;
  approvedLabel: string;
}) {
  const [busy, setBusy] = useState(false);
  const decisionRef = useRef<HTMLInputElement>(null);

  function guard(
    event: React.MouseEvent<HTMLButtonElement>,
    decision: 'succeeded' | 'failed',
  ): void {
    const form = event.currentTarget.form;
    if (!form) return;

    // Set the decision before anything can return early, so what is submitted
    // always matches the button that was pressed.
    if (decisionRef.current) decisionRef.current.value = decision;

    // Read from the FORM. `event.currentTarget` is the button, and `new
    // FormData(button)` throws -- which it did, so this confirmation never ran.
    const data = new FormData(form);
    const reference = String(data.get('reference') ?? '').trim();
    const amount = String(data.get('merchantCharged') ?? '').trim();

    if (reference.length < 4) {
      event.preventDefault();
      return;
    }

    const message =
      decision === 'succeeded'
        ? `Confirm this purchase completed?\n\n` +
          `The fan will be CHARGED immediately, and the order marked succeeded.\n` +
          (amount.length === 0
            ? `\nNo amount entered, so this will be refused — a success needs what the merchant actually took.`
            : `\nAmount entered: $${amount} (the merchant's figure, before our fee).`)
        : `Confirm this purchase never completed?\n\n` +
          `The fan's hold will be RELEASED and the order marked failed. ` +
          `Only do this if you have verified nothing was charged — releasing against a real charge ` +
          `leaves the fan paid up for nothing.`;

    if (!window.confirm(message)) {
      event.preventDefault();
      return;
    }

    setBusy(true);
  }

  return (
    <form>
      <input type="hidden" name="fanOrderId" value={fanOrderId} />
      {/* Set by whichever button is pressed. Never a button's own name/value. */}
      <input type="hidden" name="decision" ref={decisionRef} defaultValue="" />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
        <input
          name="reference"
          placeholder="Evidence reference"
          aria-label={`Evidence reference for order ${fanOrderId}`}
          required
          minLength={4}
          maxLength={200}
          autoComplete="off"
          style={{ minWidth: '13rem' }}
        />

        <input
          name="merchantCharged"
          type="number"
          step="0.01"
          min="0"
          placeholder="Charged (dollars)"
          aria-label={`Amount the merchant charged for order ${fanOrderId}`}
          autoComplete="off"
          style={{ width: '11rem' }}
        />

        <button
          type="submit"
          formAction={resolveStuckOrder}
          disabled={busy}
          onClick={(event) => guard(event, 'succeeded')}
        >
          It completed — charge
        </button>

        <button
          type="submit"
          formAction={resolveStuckOrder}
          disabled={busy}
          onClick={(event) => guard(event, 'failed')}
        >
          It never completed — release
        </button>
      </div>

      <p className="muted small" style={{ marginTop: '0.4rem' }}>
        Only if the machine could not settle it. The fan approved up to{' '}
        {approvedLabel}; a charge above that is refused.
      </p>
    </form>
  );
}
