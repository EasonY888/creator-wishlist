/**
 * Operator actions.
 *
 * Some outcomes cannot be automated. The provider holds no funds and exposes no
 * refund operation, so a merchant refund happens out-of-band and only a person
 * can witness it (FR-5.7). What matters is that recording it is *honest*: the
 * danger is not an unhandled refund, it is a ledger that says a fan was refunded
 * when their money never came back.
 *
 * ## Why this touches the fan rail at all
 *
 * `PaymentEvent` is the FAN rail's ledger -- the thing that answers "was I
 * charged?". Writing `refunded` into it asserts that the fan's money was
 * returned. But FR-5.7 describes a *merchant-side* refund, which is a different
 * rail entirely.
 *
 * So recording a merchant refund as a fan refund would be a lie of exactly the
 * kind the rest of this system refuses to tell. If a merchant refund is recorded
 * while the fan's card still holds the money, someone has paid for nothing. This
 * therefore reverses the fan's charge through the payment rail, and refuses to
 * mark the order refunded if that fails.
 */
import type { Db } from '../db/types';
import { fanChargeFor } from '../domain/charge';
import { assertTransition, type FanOrderState } from '../domain/order-fsm';
import { recordPaymentOnce } from '../payments/ledger';
import { idempotencyKeyFor, type PaymentPort } from '../payments/port';

export interface OperatorDeps {
  db: Db;
  payments: PaymentPort;
}

export type OperatorOutcome =
  | { state: 'recorded'; fanOrderId: string; amountMinor: number; reference: string }
  | { state: 'order_not_found' }
  /** Nothing was ever captured, so there is no money to give back. */
  | { state: 'nothing_to_refund'; reason: string }
  /** This state has no path to `refunded`. */
  | { state: 'not_refundable'; currentState: string }
  /** The merchant reference is the guard on the transition, so it must be real. */
  | { state: 'invalid_reference'; reason: string }
  | { state: 'already_refunded' }
  /** The rail refused. The order is deliberately left untouched. */
  | { state: 'rail_failed'; code: string; message: string };

/** States with an edge to `refunded` in the FSM. */
const REFUNDABLE_STATES: readonly FanOrderState[] = [
  'succeeded',
  'partially_fulfilled',
  'failed',
];

const MIN_REFERENCE_LENGTH = 4;
const MAX_REFERENCE_LENGTH = 200;

/**
 * Record an out-of-band merchant refund and reverse the fan's charge.
 *
 * Order of operations is deliberate: the rail is asked FIRST, and the order is
 * only marked refunded once money has actually moved. The reverse -- mark it,
 * then try to refund -- would leave a fan marked as refunded with their money
 * still held if the rail call failed, which is the one outcome that must never
 * be reachable.
 */
export async function recordRefund(
  deps: OperatorDeps,
  input: {
    fanOrderId: string;
    /** Evidence of the merchant-side refund. Required, and not invented here. */
    reference: string;
    actor: string;
    note?: string;
  },
): Promise<OperatorOutcome> {
  const order = await deps.db.fanOrder.findUnique({
    where: { id: input.fanOrderId },
    include: { paymentEvents: { orderBy: { createdAt: 'asc' } } },
  });

  if (!order) return { state: 'order_not_found' };

  const reference = input.reference.trim();
  if (reference.length < MIN_REFERENCE_LENGTH) {
    return {
      state: 'invalid_reference',
      reason: 'A merchant refund reference is required. It is the only evidence this happened.',
    };
  }
  if (reference.length > MAX_REFERENCE_LENGTH) {
    return { state: 'invalid_reference', reason: 'That reference is implausibly long.' };
  }

  const current = order.state as FanOrderState;

  if (order.paymentEvents.some((event) => event.type === 'refunded')) {
    return { state: 'already_refunded' };
  }

  if (!REFUNDABLE_STATES.includes(current)) {
    return { state: 'not_refundable', currentState: current };
  }

  // Only money that actually settled can be given back. A capture that never
  // happened means the transaction was a hold, and holds are released, not
  // refunded -- conflating the two would misreport whether the fan was charged.
  const captured = order.paymentEvents.find((event) => event.type === 'captured');

  if (!captured) {
    return {
      state: 'nothing_to_refund',
      reason:
        'No captured payment exists on this order. If money is still held, it is a hold to release, not a charge to refund.',
    };
  }

  const refund = await deps.payments.refund({
    fanOrderId: order.id,
    idempotencyKey: idempotencyKeyFor('refund', order.id),
    amountMinor: captured.amountMinor,
    currency: order.currency,
  });

  if (refund.state === 'failed') {
    // Left exactly as it was. An order that is still marked refunded after a
    // failed rail call is worse than one that is still marked succeeded.
    return { state: 'rail_failed', code: refund.code, message: refund.message ?? '' };
  }

  await deps.db.$transaction(async (tx) => {
    await recordPaymentOnce(tx, {
      fanOrderId: order.id,
      type: 'refunded',
      amountMinor: refund.amountMinor,
      currency: order.currency,
      providerRef: refund.reference,
    });

    // The guard on every edge into `refunded` is this reference, so the
    // transition cannot be taken without evidence attached.
    assertTransition(current, 'refunded', { refundReference: reference });

    await tx.fanOrder.update({ where: { id: order.id }, data: { state: 'refunded' } });

    await tx.orderEvent.create({
      data: {
        fanOrderId: order.id,
        fromState: current,
        toState: 'refunded',
        // Both halves recorded: the rail reference Stripe gave us, and the
        // merchant reference the operator supplied. They are different events on
        // different rails and a support query may need either.
        note: `refunded ${refund.amountMinor} ${order.currency} on the fan rail (${refund.reference}); merchant refund reference ${reference}${input.note ? `; ${input.note}` : ''}`,
        actor: input.actor,
      },
    });
  });

  return {
    state: 'recorded',
    fanOrderId: order.id,
    amountMinor: refund.amountMinor,
    reference: refund.reference,
  };
}

// ---------------------------------------------------------------------------
// Resolving a stuck order
// ---------------------------------------------------------------------------

/** States an operator may resolve. Mid-flight orders are not theirs to call. */
const RESOLVABLE_STATES: readonly FanOrderState[] = ['processing', 'uncertain'];

export type ResolutionOutcome =
  | { state: 'resolved'; fanOrderId: string; decision: ResolutionDecision; amountMinor: number }
  | { state: 'order_not_found' }
  /** Already moving, or already settled, so there is nothing to resolve. */
  | { state: 'not_resolvable'; currentState: string; reason: string }
  | { state: 'invalid_reference'; reason: string }
  /** A success needs the figure the merchant actually took. */
  | { state: 'amount_required'; reason: string }
  | { state: 'amount_invalid'; reason: string }
  /** The rail refused, or the books disagree with the operator. Order untouched. */
  | { state: 'refused'; code: string; reason: string };

export type ResolutionDecision = 'succeeded' | 'failed';

/**
 * Declare the outcome of an order nobody could determine automatically.
 *
 * This is the last resort, and it exists because some orders have no automatic
 * exit: `human_handoff` polls indefinitely and correctly, so an order whose
 * merchant never resolves will sit in `processing` forever. Somebody has to be
 * able to say what happened.
 *
 * Everything here rests on an operator having actually looked. That is why the
 * reference is mandatory — the same reasoning as `recordRefund`, and for the same
 * reason: the guard on the transition, and the only evidence the change was based
 * on anything at all.
 *
 * What it deliberately will NOT do is contradict the books. Refusing to fail an
 * order that has already been captured is not bureaucracy; it is the difference
 * between a refundable mistake and an order the fan paid for and was told failed.
 */
export async function resolveOrder(
  deps: OperatorDeps,
  input: {
    fanOrderId: string;
    decision: ResolutionDecision;
    /** What the operator found at the merchant. Not invented here. */
    reference: string;
    /**
     * For a success: the figure the merchant's own checkout took, as observed.
     * Required, because there is no other source for it once reconciliation has
     * failed to establish one.
     */
    merchantChargedMinor?: number | null;
    actor: string;
    note?: string;
  },
): Promise<ResolutionOutcome> {
  const order = await deps.db.fanOrder.findUnique({
    where: { id: input.fanOrderId },
    include: { paymentEvents: { orderBy: { createdAt: 'asc' } } },
  });

  if (!order) return { state: 'order_not_found' };

  const reference = input.reference.trim();
  if (reference.length < MIN_REFERENCE_LENGTH) {
    return {
      state: 'invalid_reference',
      reason: 'An evidence reference is required. It is the only record of what was checked.',
    };
  }

  const current = order.state as FanOrderState;

  if (!RESOLVABLE_STATES.includes(current)) {
    return {
      state: 'not_resolvable',
      currentState: current,
      reason:
        current === 'succeeded' || current === 'refunded' || current === 'partially_fulfilled'
          ? 'This order is already settled.'
          : 'This order is still moving. Let it finish, or reconcile it instead.',
    };
  }

  const captured = order.paymentEvents.find((event) => event.type === 'captured');
  const released = order.paymentEvents.find((event) => event.type === 'released');

  if (input.decision === 'failed') {
    // Failing an order we already took money for would tell the fan they were not
    // charged when they were. That is a refund, and a different action.
    if (captured) {
      return {
        state: 'refused',
        code: 'already_captured',
        reason:
          'The fan has already been charged, so this cannot be marked as failed. Record a refund instead.',
      };
    }

    if (released) {
      return {
        state: 'refused',
        code: 'already_released',
        reason: 'The hold was already released. Nothing further to do.',
      };
    }

    const release = await deps.payments.release({
      fanOrderId: order.id,
      idempotencyKey: idempotencyKeyFor('release', order.id),
      amountMinor: order.fanTotalMinor,
      currency: order.currency,
    });

    if (release.state === 'failed') {
      return { state: 'refused', code: release.code, reason: release.message ?? '' };
    }

    await deps.db.$transaction(async (tx) => {
      await recordPaymentOnce(tx, {
        fanOrderId: order.id,
        type: 'released',
        amountMinor: release.amountMinor,
        currency: order.currency,
        providerRef: release.reference,
      });

      // The operator's own observation is the evidence that nothing was charged.
      // The guard demands proof; their reference is what stands in for it.
      assertTransition(current, 'failed', { hasNoChargeEvidence: true });

      await tx.fanOrder.update({ where: { id: order.id }, data: { state: 'failed' } });
      await tx.orderEvent.create({
        data: {
          fanOrderId: order.id,
          fromState: current,
          toState: 'failed',
          note: `operator determined this never completed (evidence ${reference})${input.note ? `; ${input.note}` : ''}; hold released`,
          actor: input.actor,
        },
      });
    });

    return {
      state: 'resolved',
      fanOrderId: order.id,
      decision: 'failed',
      amountMinor: release.amountMinor,
    };
  }

  // decision === 'succeeded'
  if (captured) {
    return {
      state: 'refused',
      code: 'already_captured',
      reason: 'The fan has already been charged for this order.',
    };
  }

  // The merchant's figure is required, and validated by the same function the
  // reconciler uses so the two paths cannot diverge on how much to charge.
  const charge = fanChargeFor({
    merchantChargedMinor: input.merchantChargedMinor ?? null,
    markupMinor: order.markupMinor,
    authorizedMinor: order.fanTotalMinor,
  });

  if (charge.state === 'blocked') {
    return charge.code === 'merchant_amount_unknown'
      ? { state: 'amount_required', reason: charge.reason }
      : { state: 'amount_invalid', reason: charge.reason };
  }

  // Same idempotency key as the reconciler on purpose: an operator resolving this
  // order is performing THE capture for it, so a later reconciliation pass cannot
  // turn it into a second charge.
  const capture = await deps.payments.capture({
    fanOrderId: order.id,
    idempotencyKey: idempotencyKeyFor('capture', order.id),
    amountMinor: charge.amountMinor,
    currency: order.currency,
  });

  if (capture.state === 'failed') {
    return { state: 'refused', code: capture.code, reason: capture.message ?? '' };
  }

  await deps.db.$transaction(async (tx) => {
    await recordPaymentOnce(tx, {
      fanOrderId: order.id,
      type: 'captured',
      amountMinor: capture.amountMinor,
      currency: order.currency,
      providerRef: capture.reference,
    });

    // Reaching here means a person read the provider's record, which is exactly
    // what this guard is for.
    assertTransition(current, 'succeeded', { hasReconciliationEvidence: true });

    await tx.fanOrder.update({ where: { id: order.id }, data: { state: 'succeeded' } });
    await tx.orderEvent.create({
      data: {
        fanOrderId: order.id,
        fromState: current,
        toState: 'succeeded',
        note: `operator confirmed the purchase completed (evidence ${reference}); charged the fan ${capture.amountMinor} ${order.currency}${input.note ? `; ${input.note}` : ''}`,
        actor: input.actor,
      },
    });
  });

  return {
    state: 'resolved',
    fanOrderId: order.id,
    decision: 'succeeded',
    amountMinor: capture.amountMinor,
  };
}
