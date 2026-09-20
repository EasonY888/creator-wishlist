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

describe('what the queue calls paid', () => {
  /**
   * Found on the live instance. A settled order whose shop charged less than it
   * quoted read as "Fan paid $17.94" in the queue, while the ledger had captured
   * $15.99 -- and `/ops/evidence`, on the same instance, said the code decides
   * $15.99. The page that checks our arithmetic disagreed with the one doing it.
   *
   * `fanTotalMinor` is the ceiling the fan authorised, and it has to stay that:
   * it is what the refund path validates against. It is simply not what they
   * paid, and a queue headed "Fan paid" must not print it as though it were.
   */
  function settled() {
    return operatorOrderView({
      orderId: 'ord_live',
      fanId: 'fan_live',
      creator: { id: 'c1', displayName: 'Test Creator', publicSlug: 'test-creator' },
      state: 'succeeded',
      fanTotalMinor: 1794,
      markupMinor: 299,
      merchantCapMinor: 1495,
      currency: 'CAD',
      createdAt: new Date(),
      merchantOrder: {
        providerOrderId: 'af_ord_test',
        statusRaw: 'succeeded',
        retryable: false,
        retryAction: 'none',
        action: null,
        amountApprovedMinor: 1495,
        amountChargedMinor: 1300,
        pollCount: 15,
        lastPolledAt: null,
        dispatchClaimedAt: null,
        dispatchedAt: null,
        evidence: null,
      },
      ledger: [
        { type: 'authorized', amountMinor: 1794, providerRef: 'pi_test', at: '2026-09-20T11:07:36Z' },
        { type: 'captured', amountMinor: 1599, providerRef: 'pi_test', at: '2026-09-20T11:13:33Z' },
      ],
    });
  }

  it('reports what was captured, not the ceiling the fan approved', () => {
    const { money } = settled();

    expect(money.capturedMinor).toBe(1599);
    expect(money.capturedMinor).not.toBe(money.fanTotalMinor);
  });

  it('reports what the shop charged, not its cap', () => {
    const { money } = settled();

    expect(money.chargedMinor).toBe(1300);
    expect(money.chargedMinor).not.toBe(money.merchantCapMinor);
  });

  it('keeps the approved ceiling, because authorisation is not payment', () => {
    expect(settled().money.fanTotalMinor).toBe(1794);
  });

  it('is null before anything is captured, so nothing can be called paid early', () => {
    const pending = operatorViewInputWithoutCapture();

    // Null rather than the ceiling: the queue needs to be able to say "held"
    // instead of claiming a payment that has not happened.
    expect(pending.money.capturedMinor).toBeNull();
    expect(pending.money.chargedMinor).toBeNull();
  });

  function operatorViewInputWithoutCapture() {
    return operatorOrderView({
      orderId: 'ord_pending',
      fanId: 'fan_live',
      creator: { id: 'c1', displayName: 'Test Creator', publicSlug: 'test-creator' },
      state: 'authorized',
      fanTotalMinor: 1794,
      markupMinor: 299,
      merchantCapMinor: 1495,
      currency: 'CAD',
      createdAt: new Date(),
      ledger: [
        { type: 'authorized', amountMinor: 1794, providerRef: 'pi_test', at: '2026-09-20T11:07:36Z' },
      ],
    });
  }
});

describe("the provider's own account", () => {
  /**
   * The only part of the record that is not ours. It was written to a jsonb
   * column at dispatch and read by nothing, so the strongest evidence the
   * product holds -- the shop's own total, and a screenshot run that ends after
   * the order is submitted -- was invisible on every screen.
   */
  function withEvidence(evidence: unknown) {
    return operatorOrderView({
      orderId: 'ord_evidence',
      fanId: 'fan_live',
      creator: { id: 'c1', displayName: 'Test Creator', publicSlug: 'test-creator' },
      state: 'succeeded',
      fanTotalMinor: 1794,
      markupMinor: 299,
      merchantCapMinor: 1495,
      currency: 'CAD',
      createdAt: new Date(),
      merchantOrder: {
        providerOrderId: 'af_ord_test',
        statusRaw: 'succeeded',
        retryable: false,
        retryAction: 'none',
        action: null,
        amountApprovedMinor: 1495,
        amountChargedMinor: 1300,
        pollCount: 15,
        lastPolledAt: null,
        dispatchClaimedAt: null,
        dispatchedAt: null,
        evidence,
      },
    });
  }

  it('reads the settlement facts the provider reported', () => {
    const view = withEvidence({
      observed_total_minor: 1300,
      price_drift_minor: -195,
      charge_state: 'confirmed',
      ship_to_verified: true,
      vgs_request_id: '8fb705cedf84642bdc59613485b03cef',
      screenshots: [
        { idx: 0, stage: 'checkout-loaded' },
        { idx: 3, stage: 'post-submit' },
      ],
    });

    expect(view.providerEvidence?.observedTotalMinor).toBe(1300);
    expect(view.providerEvidence?.priceDriftMinor).toBe(-195);
    expect(view.providerEvidence?.shipToVerified).toBe(true);
    expect(view.providerEvidence?.screenshotStages).toEqual(['checkout-loaded', 'post-submit']);
  });

  it('reads an absent or unrecognisable bundle as nothing at all', () => {
    // The fake rail writes a different shape, and a provider may rename a key.
    // Null, rather than a panel headed "provider evidence" with nothing in it --
    // that reads as proof of absence rather than absence of proof.
    expect(withEvidence(null).providerEvidence).toBeNull();
    expect(withEvidence(undefined).providerEvidence).toBeNull();
    expect(withEvidence({ something: 'else' }).providerEvidence).toBeNull();
    expect(withEvidence('not an object').providerEvidence).toBeNull();
  });

  it('keeps only screenshots that name their stage', () => {
    const view = withEvidence({ screenshots: [{ idx: 0 }, { idx: 1, stage: 'post-submit' }] });

    expect(view.providerEvidence?.screenshotStages).toEqual(['post-submit']);
  });
});
