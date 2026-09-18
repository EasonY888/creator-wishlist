/**
 * Turning a merchant's price into the fan's price.
 *
 * Kept pure and separate from the service that calls it, because this is the
 * arithmetic the whole product's margin depends on and it should be testable
 * without a database or a network.
 */

export interface FanPrice {
  /** The merchant-quoted figure. This is what we bind and send to the provider. */
  merchantAmountMinor: number;
  markupMinor: number;
  /** What the fan sees and is charged. Never the merchant's figure. */
  fanTotalMinor: number;
  currency: string;
  /**
   * False means the merchant adds tax at checkout and `merchantAmountMinor` is a
   * CEILING, not the charge. The fan must be told which one they are looking at.
   */
  amountIsFinal: boolean;
}

export function priceForFan(args: {
  expectedAmountMinor: number | null | undefined;
  currency: string;
  amountIsFinal: boolean;
  markupPercent: number;
}): FanPrice {
  if (!Number.isFinite(args.markupPercent) || args.markupPercent < 0) {
    throw new Error(
      `Invalid markup percentage: ${String(args.markupPercent)}. Refusing to price anything.`,
    );
  }

  // A quote with no usable amount must never be priced. Zero is not a free gift —
  // it is a missing quote, and rendering it would show the fan a number we made
  // up. The only honest response is to make the caller choose a delivery option.
  if (
    args.expectedAmountMinor === null ||
    args.expectedAmountMinor === undefined ||
    !Number.isInteger(args.expectedAmountMinor) ||
    args.expectedAmountMinor < 1
  ) {
    throw new Error(
      'Cannot price a quote with no usable amount. A delivery option must be chosen first.',
    );
  }

  const markupMinor = Math.round(
    (args.expectedAmountMinor * args.markupPercent) / 100,
  );

  return {
    merchantAmountMinor: args.expectedAmountMinor,
    markupMinor,
    fanTotalMinor: args.expectedAmountMinor + markupMinor,
    currency: args.currency,
    amountIsFinal: args.amountIsFinal,
  };
}

export function markupPercentFromEnv(raw: string | undefined): number {
  const parsed = Number(raw ?? '20');
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`MARKUP_PERCENT must be a non-negative number, got "${raw}".`);
  }
  return parsed;
}
