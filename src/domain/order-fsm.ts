/**
 * The fan order lifecycle.
 *
 * This is a state machine rather than a set of nullable columns because money
 * states have to be unambiguous: "was this fan charged?" must have exactly one
 * answer at any instant, and the legal paths between states have to be knowable
 * without reading the whole codebase.
 *
 * An illegal transition throws. It is never written and repaired later, because
 * by then the fan has been shown something that was not true.
 */

export const FAN_ORDER_STATES = [
  'draft',
  'approved',
  'authorized',
  'dispatching',
  'approval_required',
  'processing',
  'uncertain',
  'succeeded',
  'failed',
  'partially_fulfilled',
  'refunded',
] as const;

export type FanOrderState = (typeof FAN_ORDER_STATES)[number];

export interface TransitionGuardContext {
  /**
   * Whether an unexpired approval token is held for this order. The provider's
   * approval window is short (~5 minutes), so the token is state, not a flag —
   * an expired token needs a fresh quote and a fresh approval, never a resume.
   */
  hasValidApprovalToken?: boolean;
  /**
   * Proof that the card was never submitted. Required before any release of the
   * fan's authorization.
   */
  hasNoChargeEvidence?: boolean;
  /**
   * An operator-recorded reference for an out-of-band refund. Refunds are
   * merchant-side and manual, so this is a human artifact, not a provider call.
   */
  refundReference?: string | null;
  /** Reconciliation found charge evidence, so the outcome is known. */
  hasReconciliationEvidence?: boolean;
}

interface Transition {
  from: FanOrderState;
  to: FanOrderState;
  /** Why this edge exists at all, in one line. */
  reason: string;
  guard?: (ctx: TransitionGuardContext) => boolean;
}

const TRANSITIONS: readonly Transition[] = [
  {
    from: 'draft',
    to: 'approved',
    reason: 'Fan confirmed a specific displayed total.',
  },
  {
    from: 'approved',
    to: 'authorized',
    reason: 'Fan payment authorized (held, not captured).',
  },
  {
    from: 'approved',
    to: 'failed',
    reason:
      'Payment authorization failed, so there is nothing to dispatch and nothing was ever sent to a merchant.',
    guard: (ctx) => ctx.hasNoChargeEvidence === true,
  },
  {
    from: 'authorized',
    to: 'failed',
    reason:
      'Refused before dispatch — the approved destination no longer matches, the item became unavailable, or a cap was breached. The hold is released, because nothing was ever placed with a merchant.',
    guard: (ctx) => ctx.hasNoChargeEvidence === true,
  },
  {
    from: 'authorized',
    to: 'dispatching',
    reason: 'Claimed for dispatch exactly once.',
  },
  {
    from: 'dispatching',
    to: 'processing',
    reason: 'Provider accepted the dispatch; an order id exists.',
  },
  {
    from: 'dispatching',
    to: 'approval_required',
    reason: 'Provider returned approval-required with a token and a deadline.',
  },
  {
    from: 'dispatching',
    to: 'uncertain',
    reason:
      'Response lost or unreadable. Not a failure — the purchase may exist.',
  },
  {
    from: 'dispatching',
    to: 'failed',
    reason: 'Refused outright, with proof the card was never submitted.',
    guard: (ctx) => ctx.hasNoChargeEvidence === true,
  },
  {
    from: 'approval_required',
    to: 'dispatching',
    reason: 'Approval completed; resuming the same saved request.',
    guard: (ctx) => ctx.hasValidApprovalToken === true,
  },
  {
    from: 'approval_required',
    to: 'failed',
    reason: 'Approval window expired. Requires a fresh quote and approval.',
    guard: (ctx) => ctx.hasValidApprovalToken === false,
  },
  {
    from: 'processing',
    to: 'succeeded',
    reason: 'Provider reports a completed checkout.',
  },
  {
    from: 'processing',
    to: 'failed',
    reason: 'Terminal refusal with no charge.',
    guard: (ctx) => ctx.hasNoChargeEvidence === true,
  },
  {
    from: 'processing',
    to: 'uncertain',
    reason: 'Provider reports an outcome it cannot confirm.',
  },
  {
    from: 'uncertain',
    to: 'succeeded',
    reason: 'Reconciliation established that the purchase completed.',
    guard: (ctx) => ctx.hasReconciliationEvidence === true,
  },
  {
    from: 'uncertain',
    to: 'failed',
    reason: 'Reconciliation established the card was never submitted.',
    guard: (ctx) => ctx.hasNoChargeEvidence === true,
  },
  {
    from: 'succeeded',
    to: 'partially_fulfilled',
    reason:
      'Part of a multi-merchant cart failed while this merchant order succeeded.',
  },
  {
    from: 'succeeded',
    to: 'refunded',
    reason: 'Operator recorded an out-of-band merchant refund.',
    guard: (ctx) => Boolean(ctx.refundReference),
  },
  {
    from: 'failed',
    to: 'refunded',
    reason:
      'Operator recorded a refund for a charge that had already been captured.',
    guard: (ctx) => Boolean(ctx.refundReference),
  },
  {
    from: 'partially_fulfilled',
    to: 'refunded',
    reason: 'Operator recorded a refund for the failed portion.',
    guard: (ctx) => Boolean(ctx.refundReference),
  },
];

export function canTransition(
  from: FanOrderState,
  to: FanOrderState,
  ctx: TransitionGuardContext = {},
): boolean {
  return TRANSITIONS.some(
    (t) =>
      t.from === from &&
      t.to === to &&
      (t.guard === undefined || t.guard(ctx)),
  );
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: FanOrderState,
    readonly to: FanOrderState,
    reason: string,
  ) {
    super(`Illegal order transition ${from} -> ${to}: ${reason}`);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Throw unless the transition is legal.
 *
 * Callers persist only after this returns, so an illegal move can never reach
 * the database or a screen. The error message names the guard that failed,
 * because "illegal transition" alone sends people to the wrong place.
 */
export function assertTransition(
  from: FanOrderState,
  to: FanOrderState,
  ctx: TransitionGuardContext = {},
): void {
  const edge = TRANSITIONS.find((t) => t.from === from && t.to === to);

  if (!edge) {
    throw new IllegalTransitionError(
      from,
      to,
      `no such edge exists from "${from}"`,
    );
  }

  if (edge.guard && !edge.guard(ctx)) {
    throw new IllegalTransitionError(
      from,
      to,
      `guard not satisfied (${edge.reason})`,
    );
  }
}

export function transitionsFrom(from: FanOrderState): FanOrderState[] {
  return TRANSITIONS.filter((t) => t.from === from).map((t) => t.to);
}
