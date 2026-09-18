/**
 * The provider's order vocabulary, stored verbatim.
 *
 * We never overwrite or reinterpret these values. The fan-facing status is a
 * *derived projection* (see `presentation.ts`), while the operator timeline and
 * the reconciler read the raw value. Collapsing one into the other loses the
 * information reconciliation depends on.
 */

export const LIVE_STATUSES = [
  'pending',
  /**
   * Live, not terminal, despite reading like an outcome. An order in this state
   * has been submitted but is still running — it typically settles in 60-70s.
   * Treating it as finished is how an integration reports a purchase that has
   * not happened yet.
   */
  'dispatched',
  'approval_required',
] as const;

export const TERMINAL_STATUSES = [
  'succeeded',
  'delivered',
  'merchant_error',
  'worker_error',
  'price_changed',
  'out_of_stock',
  'payment_unconfirmed',
  'payment_gate_hit',
  'timeout',
  'explored',
] as const;

export type LiveStatus = (typeof LIVE_STATUSES)[number];
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type ProviderOrderStatus = LiveStatus | TerminalStatus;

export function isLiveStatus(status: string): status is LiveStatus {
  return (LIVE_STATUSES as readonly string[]).includes(status);
}

export function isTerminalStatus(status: string): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * `explored` is terminal, but it is the end of a *merchant-discovery* run, not a
 * purchase outcome. Treating it as a successful order would report a purchase
 * that never happened, so discovery orders must be tracked with their own kind
 * rather than being inferred from the status.
 */
export function isDiscoveryStatus(status: string): boolean {
  return status === 'explored';
}

/**
 * The only statuses that authorize capturing the fan's payment.
 *
 * `delivered` is included deliberately. It is not in the published terminal list
 * we derived from the API reference, but the build guide's own decision logic
 * treats it alongside `succeeded`, and being conservative here would leave a
 * genuine success uncaptured.
 *
 * Note what this does *not* mean: a successful checkout confirms the order was
 * placed, never that a parcel was delivered. Do not use this to drive delivery
 * copy.
 */
export function isPurchaseSuccess(status: string): boolean {
  return status === 'succeeded' || status === 'delivered';
}

/** The provider's own next-call vocabulary, as returned on the order. */
export const RETRY_ACTIONS = [
  're_preview',
  'poll',
  'handoff',
  'contact_support',
  'none',
] as const;

export type RetryAction = (typeof RETRY_ACTIONS)[number];

/**
 * Tri-state, and the third value is the trap.
 *
 * `null` does **not** mean failure. It is also what a perfectly healthy
 * in-flight order reports, which is why it must never be evaluated before
 * `retry_action`. See `order-action.ts` for the required precedence.
 */
export type Retryable = boolean | null;

/**
 * Charge evidence attached to a finished order.
 *
 * Treated as sensitive: the provider's evidence payload can carry the delivery
 * address in full, so this must never be serialized toward a fan or a
 * general-purpose log. Only `charge_state` is read here.
 */
export interface OrderEvidence {
  charge_state?: string | null;
  [key: string]: unknown;
}

/**
 * The subset of a provider order our decision logic depends on.
 *
 * `status` is typed as a plain string on purpose. A status we do not recognize
 * must not throw inside the reconciler — it must fall through to `reconcile`,
 * which is the safe answer for an unknown state.
 */
export interface ProviderOrder {
  id: string;
  status: string;
  amount_minor?: number | null;
  amount_charged_minor?: number | null;
  currency?: string | null;
  retryable?: Retryable;
  retry_action?: RetryAction | string | null;
  error_code?: string | null;
  evidence?: OrderEvidence | null;
}
