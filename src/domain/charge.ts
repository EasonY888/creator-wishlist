/**
 * How much to charge the fan, once the merchant's real figure is known.
 *
 * ## The problem this solves
 *
 * A fan approves a CEILING, not a price (FR-3.8). On the live sandbox the quote
 * came back as:
 *
 *     charge_estimate_minor  1300   <- what it expected to cost
 *     charge_cap_minor       1495   <- the most it could take (estimate + 15%)
 *     amount_is_final        false
 *
 * The merchant charged 1300. We held 1794 (cap + our fee) and — until this
 * existed — captured all 1794. So the fan paid the worst case every time, and the
 * fee line on their receipt said $2.99 while we actually kept $4.94.
 *
 * ## The rule
 *
 * Charge the merchant's real figure plus the fee we displayed. The fee is the fee
 * the fan agreed to, not a percentage recomputed from the final number: the fan
 * was shown "$2.99", and a receipt that says $2.99 should mean $2.99.
 *
 * This is a PARTIAL CAPTURE, not a capture-then-refund. We authorised the ceiling
 * precisely so we could capture any amount up to it, so the fan is charged the
 * right figure once rather than being charged the maximum and refunded the
 * difference — which would show as two lines on their statement and cost a refund
 * fee to fix a number we already knew.
 *
 * ## Why it refuses rather than guesses
 *
 * When the merchant does not report what it charged, there is no correct amount
 * to capture. Falling back to the authorised total would take money the fan may
 * not owe, which is the exact behaviour being fixed. So this blocks and hands the
 * order to a person, who can capture it once the figure is known — the hold is
 * still there, so nothing is lost by waiting.
 */

export interface ChargeInput {
  /** What the merchant's own checkout actually took. Null when unreported. */
  merchantChargedMinor: number | null | undefined;
  /** The platform fee as displayed to the fan at approval. */
  markupMinor: number;
  /** The total the fan authorised. Nothing may ever exceed this. */
  authorizedMinor: number;
}

export type ChargeDecision =
  | { state: 'charge'; amountMinor: number }
  /** Not chargeable without a guess. A person decides. */
  | { state: 'blocked'; code: string; reason: string };

export function fanChargeFor(input: ChargeInput): ChargeDecision {
  const charged = input.merchantChargedMinor;

  if (charged === null || charged === undefined) {
    return {
      state: 'blocked',
      code: 'merchant_amount_unknown',
      reason:
        'The merchant order completed but the provider did not report what was charged. ' +
        'Any capture now would be a guess, and guessing high takes money the fan does not owe.',
    };
  }

  if (!Number.isFinite(charged) || charged < 0) {
    return {
      state: 'blocked',
      code: 'merchant_amount_invalid',
      reason: `The provider reported an impossible charged amount (${charged}).`,
    };
  }

  if (input.markupMinor < 0) {
    // A negative fee would mean charging below cost, which is a configuration
    // fault rather than a discount.
    return {
      state: 'blocked',
      code: 'negative_markup',
      reason: `The recorded platform fee is negative (${input.markupMinor}).`,
    };
  }

  const amountMinor = charged + input.markupMinor;

  if (amountMinor <= 0) {
    return {
      state: 'blocked',
      code: 'non_positive_charge',
      reason: `A charge of ${amountMinor} is not something to send to a processor.`,
    };
  }

  // Should be unreachable: the merchant is capped at the figure the fan approved,
  // and the fee was already part of that total. Asserted anyway, because the
  // consequence of being wrong here is charging more than the fan agreed to.
  if (amountMinor > input.authorizedMinor) {
    return {
      state: 'blocked',
      code: 'exceeds_authorization',
      reason:
        `Charging ${amountMinor} would exceed the ${input.authorizedMinor} the fan authorised. ` +
        'The cap did not hold, so this needs a person rather than an automatic capture.',
    };
  }

  return { state: 'charge', amountMinor };
}
