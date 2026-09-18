import { describe, expect, it } from 'vitest';

import { fanChargeFor } from './charge';

/**
 * The policy that decides how much a fan is charged.
 *
 * These are the live sandbox's own figures. The quote returned an estimate of
 * 1300 with a cap of 1495; the merchant charged 1300; we held 1794 (cap + our 299
 * fee) and used to capture all of it — so the fee we KEPT was 494 while the
 * receipt said 299.
 */
const LIVE = { merchantChargedMinor: 1300, markupMinor: 299, authorizedMinor: 1794 };

describe('the merchant charged less than the ceiling', () => {
  it('charges the real cost plus the fee the fan was shown', () => {
    const decision = fanChargeFor(LIVE);

    expect(decision.state).toBe('charge');
    expect(decision.state === 'charge' && decision.amountMinor).toBe(1599);
  });

  it('keeps only the displayed fee', () => {
    const decision = fanChargeFor(LIVE);
    const charged = decision.state === 'charge' ? decision.amountMinor : 0;

    expect(charged - LIVE.merchantChargedMinor).toBe(LIVE.markupMinor);
  });

  it('leaves the unused headroom with the fan', () => {
    const decision = fanChargeFor(LIVE);
    const charged = decision.state === 'charge' ? decision.amountMinor : 0;

    expect(LIVE.authorizedMinor - charged).toBe(195);
  });
});

describe('the merchant used the whole ceiling', () => {
  it('charges exactly what was authorized', () => {
    const decision = fanChargeFor({ ...LIVE, merchantChargedMinor: 1495 });

    expect(decision.state === 'charge' && decision.amountMinor).toBe(1794);
  });
});

describe('an unknown charge is never guessed', () => {
  /**
   * The whole point of the change. Falling back to the authorized total would
   * take money the fan may not owe — the exact behaviour being removed.
   */
  it('blocks when the amount is null', () => {
    const decision = fanChargeFor({ ...LIVE, merchantChargedMinor: null });

    expect(decision.state).toBe('blocked');
    expect(decision.state === 'blocked' && decision.code).toBe('merchant_amount_unknown');
  });

  it('blocks when the amount is undefined', () => {
    expect(fanChargeFor({ ...LIVE, merchantChargedMinor: undefined }).state).toBe('blocked');
  });

  it('never returns a chargeable amount when blocked', () => {
    const decision = fanChargeFor({ ...LIVE, merchantChargedMinor: null });

    expect(decision).not.toHaveProperty('amountMinor');
  });
});

describe('the cap is an assertion, not a hope', () => {
  it('blocks rather than charging above the authorization', () => {
    const decision = fanChargeFor({ ...LIVE, merchantChargedMinor: 5000 });

    expect(decision.state).toBe('blocked');
    expect(decision.state === 'blocked' && decision.code).toBe('exceeds_authorization');
  });

  it('blocks one minor unit above the line', () => {
    // authorized 1794, fee 299 => merchant may reach 1495 and not a penny more.
    expect(fanChargeFor({ ...LIVE, merchantChargedMinor: 1496 }).state).toBe('blocked');
    expect(fanChargeFor({ ...LIVE, merchantChargedMinor: 1495 }).state).toBe('charge');
  });
});

describe('impossible inputs', () => {
  it('blocks a negative merchant amount', () => {
    const decision = fanChargeFor({ ...LIVE, merchantChargedMinor: -100 });

    expect(decision.state).toBe('blocked');
    expect(decision.state === 'blocked' && decision.code).toBe('merchant_amount_invalid');
  });

  it('blocks a non-finite merchant amount', () => {
    expect(fanChargeFor({ ...LIVE, merchantChargedMinor: Number.NaN }).state).toBe('blocked');
    expect(
      fanChargeFor({ ...LIVE, merchantChargedMinor: Number.POSITIVE_INFINITY }).state,
    ).toBe('blocked');
  });

  it('blocks a negative fee, which would mean charging below cost', () => {
    const decision = fanChargeFor({ ...LIVE, markupMinor: -50 });

    expect(decision.state).toBe('blocked');
    expect(decision.state === 'blocked' && decision.code).toBe('negative_markup');
  });

  it('blocks a non-positive total', () => {
    expect(
      fanChargeFor({ merchantChargedMinor: 0, markupMinor: 0, authorizedMinor: 0 }).state,
    ).toBe('blocked');
  });
});

describe('a free platform tier', () => {
  it('allows a zero fee', () => {
    const decision = fanChargeFor({
      merchantChargedMinor: 1300,
      markupMinor: 0,
      authorizedMinor: 1300,
    });

    expect(decision.state === 'charge' && decision.amountMinor).toBe(1300);
  });
});
