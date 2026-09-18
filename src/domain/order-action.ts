import {
  isPurchaseSuccess,
  type ProviderOrder,
} from './provider-status';

/**
 * The five things the platform may do next about a dispatched order.
 *
 * Every surface — fan order page, operator queue, reconciler, payment adapter —
 * branches on *this* vocabulary and nothing else. Deriving behaviour from a raw
 * status string or an error code is how a UI ends up recommending something
 * dangerous, because those fields say what happened rather than what is safe.
 *
 * Note what is absent: there is no `retry_place`. Re-placing is never an
 * automatic action, because the amount may have moved since approval and a
 * purchase must not be re-attempted against a stale total. Where a retry is
 * genuinely safe, the route back is `release_hold_once` plus a fresh quote and a
 * renewed approval, which produces a new order rather than repeating this one.
 */
export const ORDER_ACTIONS = [
  'capture_once',
  'poll_later',
  'human_handoff',
  'release_hold_once',
  'reconcile',
] as const;

export type OrderAction = (typeof ORDER_ACTIONS)[number];

/**
 * Compute the next safe action for an order.
 *
 * Pure and total: it never throws and always returns an action. An unrecognized
 * status is not an error to handle, it is a reason to reconcile.
 *
 * The evaluation order is the substance of this function, not an implementation
 * detail. See the numbered steps below.
 */
export function nextOrderAction(order: ProviderOrder): OrderAction {
  // 1. A finished purchase is the only thing that authorizes a capture, so it is
  //    decided first and unambiguously.
  if (isPurchaseSuccess(order.status)) return 'capture_once';

  // 2. `retry_action` is evaluated BEFORE `retryable`, and this ordering is the
  //    single most important line in the file.
  //
  //    `retryable` is `null` for every healthy in-flight order. Checking it
  //    first would route normal, working purchases into `reconcile`, so every
  //    fan waiting on a checkout that is proceeding exactly as expected would be
  //    shown "we're confirming what happened" instead of "the shop is preparing
  //    it". The order has to be: ask what to do next, then ask whether the
  //    outcome is known.
  if (order.retry_action === 'poll') return 'poll_later';
  if (order.retry_action === 'handoff') return 'human_handoff';

  // 3. Now — and only now — `null` carries its alarming meaning: nobody knows,
  //    and money may have moved. Stop automating. Never report this as a
  //    failure, and never offer a retry.
  if (order.retryable == null) return 'reconcile';

  // 4. A refusal that provably never reached the card is safe to release the
  //    fan's hold against. This is the only path that releases money.
  if (refusedBeforeCard(order)) {
    const action = order.retry_action ?? null;
    if (action === 're_preview' || action === 'none') return 'release_hold_once';
  }

  // 5. Anything left is undetermined locally. Reconcile rather than guess — the
  //    cost of guessing wrong here is a fan charged for nothing, or released
  //    against a charge that already exists.
  return 'reconcile';
}

/**
 * True only when evidence proves the card was never submitted.
 *
 * Two shapes of evidence mean that:
 *
 *   - evidence states it explicitly (`charge_state: 'none'`), or
 *   - there is no evidence at all *and* the next call is a re-quote. No evidence
 *     means the order never reached the checkout worker, and the provider only
 *     refuses orders before the card — a spending-cap breach and a price change
 *     both arrive this way.
 *
 * Everything else is treated as "possibly charged", including a charge state we
 * do not recognize. That asymmetry is deliberate: releasing a hold on an order
 * that actually charged is far worse than reconciling one that did not.
 */
export function refusedBeforeCard(order: ProviderOrder): boolean {
  const chargeState = order.evidence?.charge_state ?? null;

  if (chargeState === 'none') return true;
  if (chargeState != null) return false;

  return order.evidence == null && order.retry_action === 're_preview';
}
