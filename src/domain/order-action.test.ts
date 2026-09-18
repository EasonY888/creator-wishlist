import { describe, expect, it } from 'vitest';

import { nextOrderAction } from './order-action';
import type { ProviderOrder } from './provider-status';

/**
 * The single most valuable thing to test in this codebase.
 *
 * `nextOrderAction` decides what happens to a fan's money, and its substance is
 * the ORDER of its checks rather than any individual branch. Every case below
 * exists because a plausible-looking reordering breaks it silently: the code
 * still compiles, still returns an action, and just recommends the wrong one.
 */

function order(overrides: Partial<ProviderOrder>): ProviderOrder {
  return {
    id: 'ord_test',
    status: 'dispatched',
    retryable: null,
    retry_action: 'poll',
    ...overrides,
  };
}

describe('a finished purchase', () => {
  it('authorizes a capture on succeeded', () => {
    expect(nextOrderAction(order({ status: 'succeeded' }))).toBe('capture_once');
  });

  it('authorizes a capture on delivered', () => {
    // Not in the published terminal list, but the build guide treats it
    // alongside succeeded, and being conservative would leave a real purchase
    // uncaptured.
    expect(nextOrderAction(order({ status: 'delivered' }))).toBe('capture_once');
  });

  it('captures even when retryable is null', () => {
    // Success is decided first and unambiguously. If the null-check ran earlier
    // it would route a completed purchase into reconciliation, and the fan's
    // money would never be taken.
    expect(
      nextOrderAction(order({ status: 'succeeded', retryable: null, retry_action: null })),
    ).toBe('capture_once');
  });

  it('captures even when the provider says to contact support', () => {
    expect(
      nextOrderAction(
        order({ status: 'succeeded', retryable: null, retry_action: 'contact_support' }),
      ),
    ).toBe('capture_once');
  });
});

describe('an order still in flight', () => {
  /**
   * The trap this whole function is arranged around.
   *
   * `retryable` is null for every healthy in-flight order too. A naive reading
   * treats null as "unknown, be careful" and reconciles — which would tell every
   * fan waiting on a perfectly normal checkout that we are "confirming what
   * happened" instead of "the shop is preparing it".
   */
  it('keeps polling when retryable is null but retry_action says poll', () => {
    expect(
      nextOrderAction(order({ status: 'dispatched', retryable: null, retry_action: 'poll' })),
    ).toBe('poll_later');
  });

  it('keeps polling for pending orders with no evidence', () => {
    expect(
      nextOrderAction(order({ status: 'pending', retryable: null, retry_action: 'poll' })),
    ).toBe('poll_later');
  });

  it('never reports a healthy in-flight order as uncertain', () => {
    for (const status of ['pending', 'dispatched']) {
      expect(nextOrderAction(order({ status, retryable: null, retry_action: 'poll' }))).not.toBe(
        'reconcile',
      );
    }
  });
});

describe('a handoff', () => {
  it('routes to a person', () => {
    expect(
      nextOrderAction(order({ status: 'dispatched', retryable: null, retry_action: 'handoff' })),
    ).toBe('human_handoff');
  });
});

describe('an unknown outcome', () => {
  it('reconciles when retryable is null and nothing says what to do', () => {
    expect(
      nextOrderAction(order({ status: 'pending', retryable: null, retry_action: null })),
    ).toBe('reconcile');
  });

  it('reconciles for an unrecognized status rather than throwing', () => {
    // Pure and total: an unknown status is a reason to look, not a crash.
    expect(
      nextOrderAction(order({ status: 'some_status_we_have_never_seen', retry_action: null })),
    ).toBe('reconcile');
  });

  it('reconciles on a lost response', () => {
    expect(
      nextOrderAction(order({ status: 'reconcile', retry_action: null, retryable: null })),
    ).toBe('reconcile');
  });
});

describe('a refusal that never reached the card', () => {
  it('releases on a price change with clean evidence', () => {
    expect(
      nextOrderAction(
        order({
          status: 'price_changed',
          retryable: false,
          retry_action: 're_preview',
          evidence: { charge_state: 'none' },
        }),
      ),
    ).toBe('release_hold_once');
  });

  it('releases on out of stock with clean evidence', () => {
    expect(
      nextOrderAction(
        order({
          status: 'out_of_stock',
          retryable: false,
          retry_action: 're_preview',
          evidence: { charge_state: 'none' },
        }),
      ),
    ).toBe('release_hold_once');
  });

  it('releases when there is no evidence at all and a re-quote follows', () => {
    // No evidence means the order never reached the checkout worker, and the
    // provider only refuses before the card.
    expect(
      nextOrderAction(
        order({ status: 'price_changed', retryable: false, retry_action: 're_preview' }),
      ),
    ).toBe('release_hold_once');
  });

  it('does NOT release when the charge state is unreadable', () => {
    // The asymmetry that keeps the release path safe. Releasing a hold on an
    // order that actually charged is far worse than reconciling one that did not.
    expect(
      nextOrderAction(
        order({
          status: 'price_changed',
          retryable: false,
          retry_action: 're_preview',
          evidence: { charge_state: 'unknown' },
        }),
      ),
    ).toBe('reconcile');
  });

  it('does NOT release when the charge was attempted', () => {
    expect(
      nextOrderAction(
        order({
          status: 'worker_error',
          retryable: false,
          retry_action: 're_preview',
          evidence: { charge_state: 'attempted' },
        }),
      ),
    ).toBe('reconcile');
  });

  it('releases on a retryable refusal when the evidence is clean', () => {
    // `retryable` means "placing again would be safe", NOT "this attempt is still
    // live". With proof the card was never submitted and an instruction to
    // re-quote, this attempt is finished -- and the documented route back is
    // release plus a fresh quote, which produces a NEW order rather than
    // repeating this one. So this releases despite retryable being true.
    expect(
      nextOrderAction(
        order({
          status: 'merchant_error',
          retryable: true,
          retry_action: 're_preview',
          evidence: { charge_state: 'none' },
        }),
      ),
    ).toBe('release_hold_once');
  });

  it('does NOT release a retryable refusal with unclean evidence', () => {
    // Same refusal, but the charge state is unreadable, so nothing is proven.
    expect(
      nextOrderAction(
        order({
          status: 'merchant_error',
          retryable: true,
          retry_action: 're_preview',
          evidence: { charge_state: 'attempted' },
        }),
      ),
    ).toBe('reconcile');
  });
});

describe('the vocabulary itself', () => {
  it('never offers a way to re-place an order', () => {
    // Re-placing is never automatic: the amount may have moved since approval,
    // and a purchase must not be re-attempted against a stale total. The route
    // back is release plus a fresh quote, which produces a NEW order.
    const everyAction = [
      nextOrderAction(order({ status: 'succeeded' })),
      nextOrderAction(order({ status: 'merchant_error', retryable: false })),
      nextOrderAction(order({ status: 'pending', retry_action: null })),
    ];

    expect(everyAction).not.toContain('retry_place');
  });
});
