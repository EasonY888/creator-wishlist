import { describe, expect, it } from 'vitest';

import { assertTransition, canTransition, FAN_ORDER_STATES } from './order-fsm';

/**
 * The FSM exists because money states have to be unambiguous: "was this fan
 * charged?" must have exactly one answer at any instant, and the legal paths
 * between states have to be knowable without reading the whole codebase.
 *
 * An illegal transition throws rather than being written and repaired later,
 * because by then the fan has already been shown something untrue. So the guards
 * below are the assertion that the rules cannot be bypassed by a caller that
 * forgets to pass the evidence.
 */

describe('the legal spine', () => {
  it('walks approval through to dispatch', () => {
    expect(() => assertTransition('draft', 'approved')).not.toThrow();
    expect(() => assertTransition('approved', 'authorized')).not.toThrow();
    expect(() => assertTransition('authorized', 'dispatching')).not.toThrow();
    expect(() => assertTransition('dispatching', 'processing')).not.toThrow();
  });

  it('allows the reconciler to finish an order it has been watching', () => {
    // Driven directly by the reconciler when the provider reports success.
    expect(canTransition('processing', 'succeeded', { hasReconciliationEvidence: true })).toBe(true);
  });

  it('allows a step-up to resume exactly where it left off', () => {
    expect(canTransition('approval_required', 'dispatching', { hasValidApprovalToken: true })).toBe(
      true,
    );
  });
});

describe('transitions that must be impossible', () => {
  /**
   * The category errors. Each one would report something to a fan that never
   * happened: a draft order that paid, an order that succeeded without a
   * merchant, a refund of money that was never taken.
   */
  const illegal: Array<[string, string]> = [
    ['draft', 'succeeded'],
    ['draft', 'authorized'],
    ['draft', 'refunded'],
    ['approved', 'succeeded'],
    ['authorized', 'succeeded'],
    ['authorized', 'refunded'],
    ['processing', 'refunded'],
    ['approval_required', 'succeeded'],
    ['succeeded', 'failed'],
    ['failed', 'succeeded'],
  ];

  for (const [from, to] of illegal) {
    it(`refuses ${from} -> ${to}`, () => {
      expect(canTransition(from as never, to as never, {
        hasNoChargeEvidence: true,
        hasReconciliationEvidence: true,
        hasValidApprovalToken: true,
        refundReference: 'REF-1',
      })).toBe(false);
    });
  }
});

describe('guards cannot be bypassed by omitting evidence', () => {
  it('refuses to release a hold without proof nothing was charged', () => {
    expect(() => assertTransition('authorized', 'failed')).toThrow();
    expect(canTransition('authorized', 'failed')).toBe(false);
  });

  it('allows it once the evidence is supplied', () => {
    expect(() => assertTransition('authorized', 'failed', { hasNoChargeEvidence: true })).not.toThrow();
  });

  it('refuses a payment failure without proof nothing was charged', () => {
    expect(canTransition('approved', 'failed')).toBe(false);
    expect(canTransition('approved', 'failed', { hasNoChargeEvidence: true })).toBe(true);
  });

  it('refuses to resume an approval with no valid token', () => {
    // The token is state, not a flag: an expired one needs a fresh quote and a
    // fresh approval, never a resume.
    expect(canTransition('approval_required', 'dispatching')).toBe(false);
    expect(canTransition('approval_required', 'dispatching', { hasValidApprovalToken: false })).toBe(
      false,
    );
  });

  it('refuses to call an outcome known without reconciliation evidence', () => {
    expect(canTransition('uncertain', 'succeeded')).toBe(false);
    expect(canTransition('uncertain', 'succeeded', { hasReconciliationEvidence: true })).toBe(true);
  });
});

describe('refunds require an operator reference', () => {
  /**
   * The reference is the guard on every edge into `refunded`, which is what makes
   * the state reachable only from a person who actually witnessed the refund.
   * Without it, a refund is a claim with no evidence behind it.
   */
  const refundable = ['succeeded', 'failed', 'partially_fulfilled'] as const;

  for (const from of refundable) {
    it(`refuses ${from} -> refunded with no reference`, () => {
      expect(canTransition(from, 'refunded')).toBe(false);
      expect(canTransition(from, 'refunded', { refundReference: null })).toBe(false);
      expect(canTransition(from, 'refunded', { refundReference: '' })).toBe(false);
    });

    it(`allows ${from} -> refunded with a reference`, () => {
      expect(canTransition(from, 'refunded', { refundReference: 'SHOP-REF-88213' })).toBe(true);
    });
  }
});

describe('the vocabulary', () => {
  it('lists every state exactly once', () => {
    expect(new Set(FAN_ORDER_STATES).size).toBe(FAN_ORDER_STATES.length);
  });

  it('includes the terminal states the operator queue depends on', () => {
    for (const state of ['succeeded', 'failed', 'refunded', 'partially_fulfilled']) {
      expect(FAN_ORDER_STATES).toContain(state);
    }
  });
});
