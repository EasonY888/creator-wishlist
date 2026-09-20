import { nextOrderAction, type OrderAction } from '../domain/order-action';
import type { FanOrderState } from '../domain/order-fsm';
import { presentOrder } from '../domain/presentation';
import { type ProviderOrder, isTerminalStatus } from '../domain/provider-status';

/**
 * The operator's view of the same order.
 *
 * Deliberately a separate projection from `fan-view.ts`, with a separate
 * audience. An operator legitimately needs the live checkout URL and the
 * evidence bundle — both of which contain the delivery address in full — because
 * they are the person who resolves a stuck order. A fan never does.
 *
 * The sensitive fields are **gated on a capability**, not just included, so
 * "which role can see this" is answered by the projection rather than by each
 * caller remembering to check first.
 */

export interface OperatorTimelineEntry {
  at: string;
  fromState: string | null;
  toState: string | null;
  action: string | null;
  rawStatus: string | null;
  note: string | null;
  actor: string | null;
}

export interface OperatorLedgerEntry {
  type: string;
  amountMinor: number;
  providerRef: string | null;
  at: string;
}

/**
 * What the fan was actually charged, read from the ledger rather than a column.
 *
 * The ledger is the append-only record of what moved, so it is the only thing
 * that can answer "paid" honestly. A ceiling is a different number the moment a
 * shop charges less than it quoted -- which is the common case, and the entire
 * reason this product authorises a maximum instead of a total.
 *
 * Summed rather than "the latest entry": a second capture would be a bug, and
 * summing makes it show up as a wrong total rather than hiding behind the last
 * one.
 */
function capturedFrom(ledger: OperatorLedgerEntry[]): number | null {
  const captured = ledger.filter((entry) => entry.type === 'captured');
  if (captured.length === 0) return null;

  return captured.reduce((total, entry) => total + entry.amountMinor, 0);
}

export interface OperatorOrderView {
  orderId: string;
  fanId: string;
  creator: { id: string; displayName: string; publicSlug: string };

  state: FanOrderState;

  /** The provider's record, verbatim. Never overwritten by a local projection. */
  provider: {
    orderId: string | null;
    statusRaw: string | null;
    retryable: boolean | null;
    retryAction: string | null;
    action: OrderAction | null;
    amountApprovedMinor: number | null;
    amountChargedMinor: number | null;
    pollCount: number;
    lastPolledAt: string | null;
    dispatchClaimedAt: string | null;
    dispatchedAt: string | null;
  } | null;

  money: {
    /**
     * The ceiling the fan approved: merchant amount plus markup.
     *
     * Still the number that governs authorisation -- nothing may charge above
     * it, whatever actually moved -- which is exactly why it must not be shown
     * as what the fan "paid". See `capturedMinor`.
     */
    fanTotalMinor: number;
    markupMinor: number;
    merchantCapMinor: number;
    currency: string;
    /** What the fan was actually charged, from the ledger. Null until captured. */
    capturedMinor: number | null;
    /**
     * What the shop actually charged us. Null while the merchant's figure is
     * unknown, which is not the same thing as its cap.
     */
    chargedMinor: number | null;
    ledger: OperatorLedgerEntry[];
  };

  approval: {
    merchantId: string;
    amountMinor: number;
    requestDigest: string;
    shipToDigest: string;
    approvalText: string;
    approvedAt: string;
  } | null;

  timeline: OperatorTimelineEntry[];

  /** One line telling an operator what to do, derived from the current action. */
  recommendedAction: string;
  /** Why this order is in the queue. Null when it needs no attention. */
  attentionReason: string | null;
  ageSeconds: number;

  /**
   * OPERATOR ONLY. Streams the checkout and retains the receipt and evidence.
   * Null unless the viewer holds the capability.
   */
  liveViewUrl: string | null;
  /**
   * OPERATOR ONLY. Contains the delivery address in full.
   * Null unless the viewer holds the capability.
   */
  evidence: unknown | null;
  /** Whether the sensitive fields above were withheld. */
  sensitiveDataRedacted: boolean;
}

export interface OperatorOrderViewInput {
  orderId: string;
  fanId: string;
  creator: { id: string; displayName: string; publicSlug: string };
  state: FanOrderState;
  fanTotalMinor: number;
  markupMinor: number;
  merchantCapMinor: number;
  currency: string;
  createdAt: Date;
  providerOrder?: ProviderOrder | null;
  merchantOrder?: {
    providerOrderId: string | null;
    statusRaw: string | null;
    retryable: boolean | null;
    retryAction: string | null;
    action: OrderAction | null;
    amountApprovedMinor: number | null;
    amountChargedMinor: number | null;
    pollCount: number;
    lastPolledAt: Date | null;
    dispatchClaimedAt: Date | null;
    dispatchedAt: Date | null;
    evidence: unknown;
    liveViewUrl?: string | null;
  } | null;
  approvedRequest?: {
    merchantId: string;
    amountMinor: number;
    requestDigest: string;
    shipToDigest: string;
    fanApprovalText: string;
    fanApprovedAtIso: Date;
  } | null;
  ledger?: OperatorLedgerEntry[];
  timeline?: OperatorTimelineEntry[];
  /** Reason from a pending approval window, when one is open. */
  approvalReason?: string | null;
  /**
   * Whether this viewer may see the address-bearing fields. Defaults to false,
   * so forgetting to pass it withholds rather than exposes.
   */
  canViewSensitiveData?: boolean;
}

/** An order that has been waiting longer than this needs an operator's eyes. */
const STALE_POLLING_SECONDS = 300;

/**
 * How long a handoff may sit before the queue stops merely naming it.
 *
 * A handoff polls indefinitely and CORRECTLY -- the guide says keep polling and
 * never re-place -- so nothing about the order looks wrong at any point. That is
 * exactly why age is the only signal available: an order nobody has picked up is
 * indistinguishable from one being worked on, unless you count the minutes.
 */
const STALE_HANDOFF_SECONDS = 900;

function attentionFor(args: {
  state: FanOrderState;
  action: OrderAction | null;
  approvalReason: string | null | undefined;
  ageSeconds: number;
}): string | null {
  // The order's own STATE is read before the derived action, because a state is
  // specific evidence and a null field is not.
  //
  // A live step-up is the case that forced this. The real provider returns
  // `retryable: null` with no `retry_action` for `approval_required` -- verified
  // against the sandbox -- which the action logic correctly reads as `reconcile`,
  // since a null with no instruction really does mean "nobody knows" for an
  // ordinary order. But this order is not unknown: it is waiting on a
  // confirmation, the worker is polling for it, and it expires on its own.
  // Reporting "outcome unknown, reconcile" sent an operator to investigate a
  // healthy order and, worse, invited them to act on it.
  if (args.state === 'uncertain') {
    return 'Outcome unknown. Reconcile before acting \u2014 do not re-place, and do not release blindly.';
  }
  if (args.approvalReason === 'currency_mismatch') {
    return 'Configuration fault: the spending mandate is not in the store\u2019s currency. Reissue it \u2014 retrying will never succeed.';
  }
  if (args.state === 'approval_required') {
    return 'Waiting on a step-up approval. Confirm the approval completed, then resume once.';
  }
  if (args.action === 'reconcile') {
    return 'Outcome unknown. Reconcile before acting \u2014 do not re-place, and do not release blindly.';
  }
  if (args.action === 'human_handoff') {
    if (args.ageSeconds > STALE_HANDOFF_SECONDS) {
      // Same facts, escalated. The wording stays non-imperative about re-placing,
      // because that is never the right answer however long it has waited.
      return `A person has been needed at the merchant for ${Math.round(args.ageSeconds / 60)} minutes and nothing has moved. Open the live view; never re-place the order.`;
    }
    return 'A person is required at the merchant. Open the live view; never re-place the order.';
  }
  // The merchant is done and the fan has not been charged. The reconciler captures
  // the moment it sees success, so an order still sitting here means something
  // stopped it -- most often that the provider never reported what was charged,
  // in which case any capture would have been a guess.
  if (args.action === 'capture_once' && args.state === 'processing') {
    return 'The shop completed this order but the fan has not been charged. Open the order timeline to see why capture stopped.';
  }
  if (args.action === 'poll_later' && args.ageSeconds > STALE_POLLING_SECONDS) {
    return `Still running after ${Math.round(args.ageSeconds / 60)} minutes. Check the provider directly.`;
  }
  return null;
}

export function operatorOrderView(
  input: OperatorOrderViewInput,
): OperatorOrderView {
  const providerOrder = input.providerOrder ?? null;
  const action = providerOrder ? nextOrderAction(providerOrder) : null;
  const ageSeconds = Math.max(
    0,
    Math.round((Date.now() - input.createdAt.getTime()) / 1000),
  );

  const canViewSensitive = input.canViewSensitiveData === true;

  const provider =
    input.merchantOrder === undefined || input.merchantOrder === null
      ? null
      : {
          orderId: input.merchantOrder.providerOrderId,
          statusRaw: input.merchantOrder.statusRaw,
          retryable: input.merchantOrder.retryable,
          retryAction: input.merchantOrder.retryAction,
          action: input.merchantOrder.action,
          amountApprovedMinor: input.merchantOrder.amountApprovedMinor,
          amountChargedMinor: input.merchantOrder.amountChargedMinor,
          pollCount: input.merchantOrder.pollCount,
          lastPolledAt: input.merchantOrder.lastPolledAt?.toISOString() ?? null,
          dispatchClaimedAt:
            input.merchantOrder.dispatchClaimedAt?.toISOString() ?? null,
          dispatchedAt: input.merchantOrder.dispatchedAt?.toISOString() ?? null,
        };

  return {
    orderId: input.orderId,
    fanId: input.fanId,
    creator: input.creator,
    state: input.state,

    provider,

    money: {
      fanTotalMinor: input.fanTotalMinor,
      markupMinor: input.markupMinor,
      merchantCapMinor: input.merchantCapMinor,
      currency: input.currency,
      capturedMinor: capturedFrom(input.ledger ?? []),
      chargedMinor: input.merchantOrder?.amountChargedMinor ?? null,
      ledger: input.ledger ?? [],
    },

    approval:
      input.approvedRequest === undefined || input.approvedRequest === null
        ? null
        : {
            merchantId: input.approvedRequest.merchantId,
            amountMinor: input.approvedRequest.amountMinor,
            requestDigest: input.approvedRequest.requestDigest,
            shipToDigest: input.approvedRequest.shipToDigest,
            approvalText: input.approvedRequest.fanApprovalText,
            approvedAt: input.approvedRequest.fanApprovedAtIso.toISOString(),
          },

    timeline: input.timeline ?? [],

    recommendedAction: action
      ? presentOrder(action).operatorNextStep
      : 'No provider order yet. Confirm the payment is held before dispatching.',

    attentionReason: attentionFor({
      state: input.state,
      action,
      approvalReason: input.approvalReason,
      ageSeconds,
    }),

    ageSeconds,

    // Both fields are withheld unless the capability was explicitly granted.
    liveViewUrl:
      canViewSensitive && input.merchantOrder
        ? (input.merchantOrder.liveViewUrl ?? null)
        : null,
    evidence:
      canViewSensitive && input.merchantOrder
        ? (input.merchantOrder.evidence ?? null)
        : null,
    sensitiveDataRedacted: !canViewSensitive,
  };
}

/** Whether the provider considers this order finished. */
export function operatorOrderIsTerminal(
  providerOrder: ProviderOrder | null,
): boolean {
  return providerOrder ? isTerminalStatus(providerOrder.status) : false;
}
