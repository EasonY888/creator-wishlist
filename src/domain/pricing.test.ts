import { describe, expect, it } from 'vitest';

import { markupPercentFromEnv, priceForFan } from './pricing';

/**
 * The arithmetic the product's margin depends on.
 *
 * Worth testing directly because it is pure and the failure mode is quiet: a
 * wrong figure here reaches a fan's card without anything else noticing.
 */

const base = { currency: 'CAD', amountIsFinal: true, markupPercent: 20 };

describe('pricing a quote', () => {
  it('adds the markup and returns both figures', () => {
    const price = priceForFan({ ...base, expectedAmountMinor: 1000 });

    expect(price.merchantAmountMinor).toBe(1000);
    expect(price.markupMinor).toBe(200);
    expect(price.fanTotalMinor).toBe(1200);
  });

  it('matches the live order', () => {
    // Merchant 1495, 20% fee => fan pays 1794.
    const price = priceForFan({ ...base, expectedAmountMinor: 1495 });

    expect(price.markupMinor).toBe(299);
    expect(price.fanTotalMinor).toBe(1794);
  });

  it('rounds the markup to a whole minor unit', () => {
    const price = priceForFan({ ...base, expectedAmountMinor: 999 });

    expect(Number.isInteger(price.markupMinor)).toBe(true);
    expect(price.markupMinor).toBe(200); // 199.8 rounded
  });

  it('charges exactly the merchant figure at a zero markup', () => {
    const price = priceForFan({ ...base, markupPercent: 0, expectedAmountMinor: 1300 });

    expect(price.markupMinor).toBe(0);
    expect(price.fanTotalMinor).toBe(1300);
  });

  it('carries the finality flag through untouched', () => {
    // The caller branches on this to decide whether to show a ceiling notice,
    // so it must never be inferred or defaulted here.
    expect(priceForFan({ ...base, amountIsFinal: false, expectedAmountMinor: 100 }).amountIsFinal)
      .toBe(false);
    expect(priceForFan({ ...base, amountIsFinal: true, expectedAmountMinor: 100 }).amountIsFinal)
      .toBe(true);
  });

  it('the fan total is always merchant plus markup', () => {
    for (const amount of [1, 7, 100, 1495, 99_999]) {
      const price = priceForFan({ ...base, expectedAmountMinor: amount });
      expect(price.fanTotalMinor).toBe(price.merchantAmountMinor + price.markupMinor);
    }
  });
});

describe('quotes that must never be priced', () => {
  /**
   * A missing amount is not a free gift. Pricing it would show the fan a number
   * we invented, so the only honest response is to make the caller go and get a
   * delivery choice.
   */
  it('refuses a null amount', () => {
    expect(() => priceForFan({ ...base, expectedAmountMinor: null })).toThrow(/no usable amount/i);
  });

  it('refuses an undefined amount', () => {
    expect(() => priceForFan({ ...base, expectedAmountMinor: undefined })).toThrow(
      /no usable amount/i,
    );
  });

  it('refuses zero', () => {
    expect(() => priceForFan({ ...base, expectedAmountMinor: 0 })).toThrow(/no usable amount/i);
  });

  it('refuses a negative amount', () => {
    expect(() => priceForFan({ ...base, expectedAmountMinor: -100 })).toThrow(
      /no usable amount/i,
    );
  });

  it('refuses a fractional amount', () => {
    // Minor units are integers. Accepting 10.5 would put a fraction of a cent
    // into a digest and onto a card.
    expect(() => priceForFan({ ...base, expectedAmountMinor: 10.5 })).toThrow(
      /no usable amount/i,
    );
  });
});

describe('a bad markup is a configuration fault', () => {
  it('refuses a negative markup rather than pricing below cost', () => {
    expect(() => priceForFan({ ...base, markupPercent: -1, expectedAmountMinor: 1000 })).toThrow(
      /Invalid markup percentage/,
    );
  });

  it('refuses a non-numeric markup', () => {
    expect(() => priceForFan({ ...base, markupPercent: Number.NaN, expectedAmountMinor: 1000 }))
      .toThrow(/Invalid markup percentage/);
  });
});

describe('reading the markup from the environment', () => {
  it('defaults to 20 when unset', () => {
    expect(markupPercentFromEnv(undefined)).toBe(20);
  });

  it('reads a configured value', () => {
    expect(markupPercentFromEnv('15')).toBe(15);
    expect(markupPercentFromEnv('0')).toBe(0);
  });

  it('throws on a bad value rather than silently defaulting', () => {
    // Defaulting here would quietly change everyone's margin.
    expect(() => markupPercentFromEnv('abc')).toThrow(/MARKUP_PERCENT/);
    expect(() => markupPercentFromEnv('-5')).toThrow(/MARKUP_PERCENT/);
    expect(() => markupPercentFromEnv('')).not.toThrow(); // Number('') === 0
  });
});
