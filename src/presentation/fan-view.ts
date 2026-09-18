import type { FanOrderState } from '../domain/order-fsm';
import { nextOrderAction } from '../domain/order-action';
import { presentOrder, type PaymentState } from '../domain/presentation';
import { type ProviderOrder, isPurchaseSuccess } from '../domain/provider-status';
import { assertNoSensitiveFields } from './sensitive';

/**
 * What a fan is allowed to see — and, structurally, nothing else.
 *
 * The input to this module is a **narrow, explicit set of fields**, never a
 * database row. That is the whole point: a function that accepts a row can leak
 * by accident when somebody spreads it, whereas a function that accepts
 * `{ fanTotalMinor, creatorDisplayName }` cannot leak the address even if the
 * caller wanted it to.
 *
 * Compare with `operator-view.ts`, which takes the same underlying order and
 * deliberately returns the sensitive fields an operator needs. Two projections,
 * two audiences, no shared serializer. Filtering one serializer by audience is
 * the version of this that eventually leaks.
 */

export interface FanOrderView {
  orderId: string;
  creator: string;
  /**
   * What the fan is actually charged once we know, and the approved total until
   * then.
   *
   * These differ on purpose. The fan approves a CEILING; the charge is the
   * merchant's real figure plus the fee they were shown, which is usually less.
   */
  totalMinor: number;
  /** The ceiling the fan agreed to. Displayed next to the charge when they differ. */
  approvedMinor: number;
  /** True when the final charge came in below what was approved. */
  chargedLessThanApproved: boolean;
  currency: string;
  status: {
    title: string;
    explanation: string;
    payment: PaymentState;
    /** Whether the fan may start again from a fresh quote. */
    canReapprove: boolean;
    /** Safe, non-imperative hint. Never a raw provider instruction. */
    isSettled: boolean;
  };
  placedAt: string;
}

export interface FanOrderViewInput {
  orderId: string;
  creatorDisplayName: string;
  /**
   * The ceiling the fan approved, saved at approval time.
   *
   * This is what they agreed to pay AT MOST. It is not necessarily what they were
   * charged -- see `chargedMinor`.
   */
  fanTotalMinor: number;
  /**
   * What was actually taken, read from the payment ledger.
   *
   * Null until a capture is recorded, at which point this becomes the figure the
   * fan should see. The merchant routinely charges less than the approved
   * ceiling, and the difference stays with the fan rather than with us.
   */
  chargedMinor?: number | null;
  currency: string;
  /** The fan order's own state. Always present. */
  localState: FanOrderState;
  /**
   * The provider's record, once one exists.
   *
   * When present it wins: it is the authoritative account of what happened, and
   * a local state that disagrees with it is the local state being stale.
   */
  providerOrder?: ProviderOrder | null;
  placedAt: Date;
}

const TERMINAL_STATES: readonly FanOrderState[] = [
  'succeeded',
  'failed',
  'refunded',
  'partially_fulfilled',
];

/**
 * Copy for the states that exist before anything is dispatched.
 *
 * `presentOrder` is keyed on a dispatch *action*, which only exists once the
 * provider has an order. Everything before that needs its own wording.
 */
const PRE_DISPATCH_COPY: Record<
  FanOrderState,
  { title: string; explanation: string; payment: PaymentState }
> = {
  draft: {
    title: 'Almost there',
    explanation: 'Check the total, then approve to send your gift.',
    payment: 'none',
  },
  approved: {
    title: 'Confirming your payment',
    explanation: 'Your card is being authorized. Nothing has been charged yet.',
    payment: 'none',
  },
  authorized: {
    title: 'Preparing your gift',
    explanation:
      'Your payment is held, not charged. We are placing the order with the shop now.',
    payment: 'held',
  },
  dispatching: {
    title: 'Preparing your gift',
    explanation: 'We are placing the order with the shop now.',
    payment: 'held',
  },
  approval_required: {
    title: 'A quick check is needed',
    explanation:
      'The shop needs one confirmation before we can finish. It is with our team, and you do not need to do anything.',
    payment: 'held',
  },
  processing: {
    title: 'Confirming the merchant order',
    explanation:
      'The shop is working on it. This normally takes about a minute and needs nothing from you.',
    payment: 'held',
  },
  uncertain: {
    title: 'We are confirming what happened',
    explanation:
      'Please do not submit again \u2014 we are checking with the shop and will update you as soon as we know.',
    payment: 'unknown',
  },
  succeeded: {
    title: 'Your gift is ordered',
    explanation:
      'The shop accepted the order. We will update you when it ships \u2014 ordering and delivering are different stages.',
    payment: 'captured',
  },
  failed: {
    title: 'You were not charged',
    explanation:
      'The order could not be completed, and it stopped before any payment was taken. Any hold on your card has been released.',
    payment: 'released',
  },
  refunded: {
    title: 'Payment refunded',
    explanation: 'This payment has been refunded.',
    payment: 'released',
  },
  partially_fulfilled: {
    title: 'Part of your gift is on the way',
    explanation:
      'One shop could not complete its part of the order, so the rest is proceeding separately.',
    payment: 'captured',
  },
};

/**
 * Build the fan-facing view.
 *
 * Asserts before returning, so a leak throws here rather than reaching a
 * browser. The assertion is cheap and this is the last point at which the
 * mistake is still ours.
 */
export function fanOrderView(input: FanOrderViewInput): FanOrderView {
  const derived = input.providerOrder
    ? (() => {
        const presentation = presentOrder(nextOrderAction(input.providerOrder!));
        return {
          title: presentation.title,
          explanation: presentation.explanation,
          payment: presentation.payment,
          canReapprove: presentation.fanMayReapprove,
        };
      })()
    : (() => {
        const copy = PRE_DISPATCH_COPY[input.localState];
        return { ...copy, canReapprove: input.localState === 'failed' };
      })();

  const charged = input.chargedMinor ?? null;

  const view: FanOrderView = {
    orderId: input.orderId,
    creator: input.creatorDisplayName,
    // Once money has moved, that is the number the fan cares about. Before then,
    // the approved total is the honest thing to show -- it is what they agreed to.
    totalMinor: charged ?? input.fanTotalMinor,
    approvedMinor: input.fanTotalMinor,
    chargedLessThanApproved: charged !== null && charged < input.fanTotalMinor,
    currency: input.currency,
    status: {
      ...derived,
      // A settled order is one whose outcome will not change again. The fan uses
      // this to decide whether to keep watching, so it must not be optimistic:
      // `uncertain` is deliberately not settled.
      isSettled: TERMINAL_STATES.includes(input.localState),
    },
    placedAt: input.placedAt.toISOString(),
  };

  assertNoSensitiveFields(view, 'fanOrderView');
  return view;
}

/** Whether the fan should keep polling. Separate from the copy, on purpose. */
export function fanOrderIsSettled(state: FanOrderState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** A completed purchase, for the small "did it work" badge. */
export function fanOrderSucceeded(state: FanOrderState): boolean {
  return state === 'succeeded' || isPurchaseSuccess(state);
}
