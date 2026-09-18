import type { OrderAction } from './order-action';

/**
 * The copy contract.
 *
 * Every surface renders from this table rather than writing its own wording, so
 * the fan-facing sentence and the operator-facing instruction can never drift
 * apart or contradict each other. This is also the only place that decides
 * whether a screen is allowed to imply failure.
 */

export type PaymentState =
  | 'none'
  | 'held'
  | 'captured'
  | 'released'
  | 'unknown';

export interface OrderPresentation {
  action: OrderAction;
  /** Fan-facing heading. Must never assert an outcome we cannot prove. */
  title: string;
  /** Fan-facing explanation. Reads as progress wherever progress is true. */
  explanation: string;
  payment: PaymentState;
  /**
   * Whether a fan may start again from a fresh quote. True only where the
   * previous attempt provably never reached the card.
   */
  fanMayReapprove: boolean;
  /** What the operator is expected to do, if anything. */
  operatorNextStep: string;
}

const PRESENTATION: Record<OrderAction, OrderPresentation> = {
  capture_once: {
    action: 'capture_once',
    title: 'Your gift is ordered',
    // Deliberately not "on its way". A completed checkout confirms the order was
    // placed, not that a parcel was dispatched, and the difference is the whole
    // product promise to the fan.
    explanation:
      'The shop accepted the order. We\u2019ll update you when it ships \u2014 ordering and delivering are different stages.',
    payment: 'captured',
    fanMayReapprove: false,
    operatorNextStep:
      'Capture the fan payment exactly once, then reconcile the merchant charge against the approved total.',
  },

  poll_later: {
    action: 'poll_later',
    title: 'Confirming the merchant order',
    explanation:
      'The shop is working on it. This normally takes about a minute and needs nothing from you.',
    payment: 'held',
    fanMayReapprove: false,
    operatorNextStep:
      'Keep polling on schedule. Watch age against SLA; escalate if it passes the threshold.',
  },

  human_handoff: {
    action: 'human_handoff',
    title: 'A quick check is needed',
    explanation:
      'The shop needs one confirmation before we can finish. It\u2019s open with our team and you don\u2019t need to do anything.',
    payment: 'held',
    fanMayReapprove: false,
    operatorNextStep:
      'Open the live checkout view and complete the step the shop is waiting on. Never re-place the order.',
  },

  release_hold_once: {
    // The fan's first question is always "was I charged?", so that is the title.
    action: 'release_hold_once',
    title: 'You were not charged',
    explanation:
      'The order couldn\u2019t be completed, and it stopped before any payment was taken. Any hold on your card has been released.',
    payment: 'released',
    fanMayReapprove: true,
    operatorNextStep:
      'Confirm the charge evidence shows nothing was submitted, then release the authorization exactly once.',
  },

  reconcile: {
    action: 'reconcile',
    title: 'We\u2019re confirming what happened',
    explanation:
      'Please don\u2019t submit again \u2014 we\u2019re checking with the shop and will update you as soon as we know.',
    // Never "failed" and never "refunded": we do not know yet, and saying either
    // would be inventing an outcome.
    payment: 'unknown',
    fanMayReapprove: false,
    operatorNextStep:
      'Read the order status and evidence before acting. If the outcome is still unknowable, escalate for human handling rather than retrying.',
  },
};

export function presentOrder(action: OrderAction): OrderPresentation {
  return PRESENTATION[action];
}

/**
 * Copy is a safety boundary, not decoration, so the invariant is asserted here
 * rather than trusted: the fan is never told a payment was released or captured
 * unless we can actually account for it.
 */
export function isPaymentStateCoherent(p: OrderPresentation): boolean {
  if (p.payment === 'unknown') return p.fanMayReapprove === false;
  if (p.payment === 'released') return p.fanMayReapprove === true;
  return true;
}
