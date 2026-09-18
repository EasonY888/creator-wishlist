import { describe, expect, it } from 'vitest';

import { operatorOrderView } from './operator-view';
import type { ProviderOrder } from '../domain/provider-status';
import type { FanOrderState } from '../domain/order-fsm';

/**
 * The operator queue's judgement about what needs a person.
 *
 * `attentionFor` is private, so this goes through `operatorOrderView` — which is
 * the surface the queue actually renders. That is the right level anyway: the
 * question is what an operator is told, not which internal function decided it.
 */

function view(args: {
  state: FanOrderState;
  provider?: Partial<ProviderOrder> | null;
  ageSeconds?: number;
}) {
  const providerOrder: ProviderOrder | null =
    args.provider === null || args.provider === undefined
      ? null
      : {
          id: 'ord_test',
          status: 'dispatched',
          retryable: null,
          retry_action: 'poll',
          ...args.provider,
        };

  return operatorOrderView({
    orderId: 'ord_test',
    fanId: 'fan_test',
    creator: { id: 'c1', displayName: 'Test Creator', publicSlug: 'test-creator' },
    state: args.state,
    fanTotalMinor: 1794,
    markupMinor: 299,
    merchantCapMinor: 1495,
    currency: 'CAD',
    createdAt: new Date(Date.now() - (args.ageSeconds ?? 0) * 1000),
    providerOrder,
    merchantOrder: providerOrder === null ? null : undefined,
  });
}

describe('a healthy order needs nobody', () => {
  it('is not flagged while it is simply running', () => {
    // The whole point of the queue: if everything in flight were flagged, the
    // flags would mean nothing.
    expect(view({ state: 'processing', provider: { retry_action: 'poll' } }).attentionReason)
      .toBeNull();
  });

  it('is not flagged once it has settled', () => {
    for (const state of ['succeeded', 'failed', 'refunded', 'partially_fulfilled'] as const) {
      expect(view({ state, provider: { status: 'succeeded', retry_action: 'none' } }).attentionReason)
        .toBeNull();
    }
  });
});

describe('an unknown outcome', () => {
  it('stops the operator re-placing or releasing blindly', () => {
    const reason = view({
      state: 'uncertain',
      provider: { status: 'reconcile', retry_action: null, retryable: null },
    }).attentionReason;

    expect(reason).toMatch(/unknown/i);
    expect(reason).toMatch(/do not re-place/i);
  });
});

describe('a handoff', () => {
  it('asks for a person', () => {
    const reason = view({
      state: 'processing',
      provider: { retry_action: 'handoff' },
      ageSeconds: 60,
    }).attentionReason;

    expect(reason).toMatch(/person is required/i);
    expect(reason).toMatch(/never re-place/i);
  });

  /**
   * A handoff polls indefinitely and correctly, so nothing ever looks wrong. Age
   * is the only available signal that nobody has picked it up.
   */
  it('escalates once it has been waiting', () => {
    const reason = view({
      state: 'processing',
      provider: { retry_action: 'handoff' },
      ageSeconds: 3600, // an hour
    }).attentionReason;

    expect(reason).toMatch(/for 60 minutes/);
    expect(reason).toMatch(/nothing has moved/i);
  });

  it('still refuses to suggest re-placing, however long it has waited', () => {
    for (const ageSeconds of [60, 900, 86_400]) {
      expect(
        view({ state: 'processing', provider: { retry_action: 'handoff' }, ageSeconds })
          .attentionReason,
      ).toMatch(/never re-place/i);
    }
  });
});

describe('a slow order', () => {
  it('is left alone until it is genuinely slow', () => {
    expect(
      view({ state: 'processing', provider: { retry_action: 'poll' }, ageSeconds: 60 })
        .attentionReason,
    ).toBeNull();
  });

  it('is flagged once it has outrun the expected settle time', () => {
    expect(
      view({ state: 'processing', provider: { retry_action: 'poll' }, ageSeconds: 3600 })
        .attentionReason,
    ).toMatch(/Still running after/i);
  });
});

describe('capture that stopped', () => {
  /**
   * The reconciler captures the moment it sees success, so an order still
   * `processing` with a capture pending means something blocked it -- most often
   * that the provider never reported what the merchant charged.
   */
  it('tells the operator the shop finished but the fan has not been charged', () => {
    const reason = view({
      state: 'processing',
      provider: { status: 'succeeded', retry_action: 'none', retryable: false },
    }).attentionReason;

    expect(reason).toMatch(/has not been charged/i);
  });

  it('says nothing once the order is actually settled', () => {
    expect(
      view({ state: 'succeeded', provider: { status: 'succeeded', retry_action: 'none' } })
        .attentionReason,
    ).toBeNull();
  });
});

describe('a step-up awaiting the fan', () => {
  /**
   * The case that forced state to be read before the derived action.
   *
   * The real provider returns `retryable: null` with no `retry_action` for an
   * `approval_required` order — verified against the sandbox — which the action
   * logic reads as `reconcile`. That is right for an ordinary order, where a null
   * with no instruction really does mean nobody knows. But this order is not
   * unknown: it is waiting on a confirmation, being polled, and expires on its
   * own. Reading the action alone produced "Outcome unknown — reconcile", which
   * sent an operator to investigate a healthy order.
   */
  it('is reported as waiting, not as unknown', () => {
    const reason = view({
      state: 'approval_required',
      provider: { status: 'approval_required', retry_action: null, retryable: null },
    }).attentionReason;

    expect(reason).toMatch(/step-up/i);
    expect(reason).not.toMatch(/unknown/i);
  });

  it('never invites the operator to re-place or release', () => {
    const reason = view({
      state: 'approval_required',
      provider: { status: 'approval_required', retry_action: null, retryable: null },
    }).attentionReason;

    expect(reason).not.toMatch(/re-place|release blindly/i);
  });
});

describe('an unknown outcome on an ordinary order', () => {
  it('still stops the operator acting', () => {
    // The reordering must not have blunted the genuinely unknown case, which is
    // the one where acting does real damage.
    const reason = view({
      state: 'authorized',
      provider: { status: 'pending', retry_action: null, retryable: null },
    }).attentionReason;

    expect(reason).toMatch(/unknown/i);
    expect(reason).toMatch(/do not re-place/i);
  });
});
