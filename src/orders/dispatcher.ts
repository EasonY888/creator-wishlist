import type { AgnicPort, DispatchOutcome } from '../agnic/port';
import type { DispatchRequest } from '../agnic/types';
import { APPROVAL_REASONS } from '../agnic/types';
import type { Db } from '../db/types';
import { assertTransition, type FanOrderState } from '../domain/order-fsm';
import {
  FULFILLMENT_ACTOR,
  loadShipToForFulfillment,
} from '../fulfillment/address-store';
import {
  assertRequestBinding,
  rebuildBoundRequest,
  RequestBindingError,
  type BoundRequest,
} from '../fulfillment/binding';
import { enqueue, OUTBOX_TOPICS, type OutboxEventRecord } from './outbox';

/**
 * The dispatcher — the only code path that spends money.
 *
 * Everything in this file exists to make one guarantee true: **for a given fan
 * order, the provider is asked to place a purchase exactly once.** Every check
 * before the call is about avoiding a second attempt; every branch after it is
 * about never losing the result of the first.
 *
 * The ordering that makes this work, and which must not be rearranged:
 *
 *   1. Verify the request still matches what the fan approved.
 *   2. Write a durable claim on the order — BEFORE the network call.
 *   3. Call the provider once.
 *   4. Record what came back, or record that we do not know.
 *
 * If a worker dies between 2 and 4, the claim is already on disk, so a
 * replacement worker will see `dispatchClaimedAt` set and refuse to call again.
 * That is precisely why the claim is written before the call rather than after.
 */

export interface DispatcherDeps {
  db: Db;
  agnic: AgnicPort;
  workerId: string;
}

export interface DispatchPayload {
  fanOrderId: string;
}

export type DispatchTaskOutcome =
  | { kind: 'dispatched'; fanOrderId: string; providerOrderId: string }
  | {
      kind: 'approval_required';
      fanOrderId: string;
      reason: string;
      /**
       * True when waiting will never help. A currency mismatch between the
       * mandate and the store is a configuration fault, not a pending step-up,
       * and polling it would hang the order forever.
       */
      permanent: boolean;
    }
  | { kind: 'refused'; fanOrderId: string; code: string }
  | { kind: 'uncertain'; fanOrderId: string; code: string }
  | { kind: 'binding_failed'; fanOrderId: string; code: string; fields: string[] }
  | { kind: 'already_claimed'; fanOrderId: string }
  | { kind: 'skipped'; fanOrderId: string; reason: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Move an order to a new state, refusing the move if the state machine forbids
 * it.
 *
 * Reads the current state inside the same transaction rather than trusting the
 * caller's belief about it. The extra read is cheap and it means an illegal move
 * cannot be committed on a stale assumption.
 */
async function transition(
  tx: Db,
  fanOrderId: string,
  to: FanOrderState,
  note: string,
  actor: string,
  ctx: Parameters<typeof assertTransition>[2] = {},
): Promise<FanOrderState> {
  const current = await tx.fanOrder.findUnique({
    where: { id: fanOrderId },
    select: { state: true },
  });

  if (!current) throw new Error(`Fan order ${fanOrderId} not found.`);

  const from = current.state as FanOrderState;
  assertTransition(from, to, ctx);

  await tx.fanOrder.update({ where: { id: fanOrderId }, data: { state: to } });
  await tx.orderEvent.create({
    data: { fanOrderId, fromState: from, toState: to, note, actor },
  });

  return from;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export async function runDispatchTask(
  deps: DispatcherDeps,
  task: OutboxEventRecord,
): Promise<DispatchTaskOutcome> {
  const payload = task.payload as DispatchPayload | null;
  const fanOrderId = payload?.fanOrderId;

  if (!fanOrderId) {
    throw new Error(`Dispatch task ${task.id} has no fanOrderId in its payload.`);
  }

  const order = await deps.db.fanOrder.findUnique({
    where: { id: fanOrderId },
    include: { approvedRequest: true, merchantOrder: true },
  });

  if (!order || !order.approvedRequest) {
    return { kind: 'skipped', fanOrderId, reason: 'no approved request' };
  }

  // Guard 1: has this order already been dispatched?
  //
  // This is the check that makes a redelivered task harmless. If a worker died
  // after the provider accepted the order, the claim is on disk and this short
  // circuit is what stops a second purchase.
  if (order.merchantOrder?.dispatchClaimedAt) {
    return { kind: 'already_claimed', fanOrderId };
  }

  // Guard 2: only an authorized order may be dispatched. An order whose payment
  // is not held must never be sent to a merchant.
  if (order.state !== 'authorized') {
    return { kind: 'skipped', fanOrderId, reason: `state is ${order.state}` };
  }

  const approved = order.approvedRequest;

  // Guard 3: does the request still match what the fan approved?
  //
  // Rebuilt from current state, so the creator having moved house since approval
  // is caught here rather than discovered by a merchant shipping to the wrong
  // address.
  const bound = await loadBoundRequest(deps, fanOrderId, approved);
  if (!bound.ok) return bound.failure;
  const request = bound.request;

  // Guard 4: take the durable claim.
  const claimed = await claimForDispatch(deps, fanOrderId);
  if (!claimed) return { kind: 'already_claimed', fanOrderId };

  // -------------------------------------------------------------------------
  // The call. Everything above was to make this happen exactly once.
  // -------------------------------------------------------------------------

  const dispatchRequest: DispatchRequest = {
    ...request,
    user_confirmation_text: approved.fanApprovalText,
    user_approved_at_iso: approved.fanApprovedAtIso.toISOString(),
  };

  const outcome = await deps.agnic.dispatch({ request: dispatchRequest });

  return recordDispatchOutcome(deps, fanOrderId, outcome);
}

interface ApprovedRequestForBinding {
  creatorAddressId: string;
  merchantId: string;
  items: unknown;
  currency: string;
  amountMinor: number;
  constraints: unknown;
  fulfillmentOptionId: string | null;
  requestDigest: string;
  shipToDigest: string;
}

/**
 * Load the request we would send, rebuilt from current state, and prove it still
 * matches what the fan approved.
 *
 * Extracted because the approval-resumption path needs precisely this check, and
 * needs it more rather than less: a second dispatch is where a stale destination
 * would be most damaging, since the first attempt already established the
 * request was good and it would be easy to assume it still is.
 */
export async function loadBoundRequest(
  deps: DispatcherDeps,
  fanOrderId: string,
  approved: ApprovedRequestForBinding,
): Promise<
  { ok: true; request: BoundRequest } | { ok: false; failure: DispatchTaskOutcome }
> {
  // The address is read through the audited gate, and only here.
  const { shipTo } = await loadShipToForFulfillment(deps.db, {
    creatorAddressId: approved.creatorAddressId,
    actor: FULFILLMENT_ACTOR,
  });

  const stored: Omit<BoundRequest, 'ship_to'> = {
    merchant_id: approved.merchantId,
    items: approved.items as BoundRequest['items'],
    currency: approved.currency,
    amount_minor: approved.amountMinor,
    ...(approved.constraints === null
      ? {}
      : { constraints: approved.constraints as BoundRequest['constraints'] }),
    ...(approved.fulfillmentOptionId === null
      ? {}
      : { fulfillment_option_id: approved.fulfillmentOptionId }),
  };

  try {
    const request = rebuildBoundRequest(stored, shipTo);
    assertRequestBinding({
      approvedRequestDigest: approved.requestDigest,
      approvedShipToDigest: approved.shipToDigest,
      current: request,
      approved: stored,
    });

    return { ok: true, request };
  } catch (error) {
    if (error instanceof RequestBindingError) {
      // Nothing has been spent, so this is a clean failure. The fan's hold is
      // released and the item needs re-quoting.
      await deps.db.$transaction(async (tx) => {
        await transition(
          tx,
          fanOrderId,
          'failed',
          `refused before dispatch: ${error.code}${
            error.changedFields.length ? ` (${error.changedFields.join(', ')})` : ''
          }`,
          deps.workerId,
          { hasNoChargeEvidence: true },
        );
        await enqueue(tx, OUTBOX_TOPICS.RELEASE_HOLD, { fanOrderId });
      });

      return {
        ok: false,
        failure: {
          kind: 'binding_failed',
          fanOrderId,
          code: error.code,
          fields: error.changedFields,
        },
      };
    }
    throw error;
  }
}

/**
 * Resume a dispatch that was waiting on a step-up approval.
 *
 * **This is the one sanctioned second call to the provider.** Everything else in
 * this file exists to prevent a second call; this one exists because the
 * provider explicitly documents it, and it is kept as narrow as possible:
 *
 *   - an approval window must exist, be unconsumed, and still be unexpired
 *   - it can be consumed exactly once, as a compare-and-swap
 *   - the request replayed is the frozen approved one, re-verified against the
 *     digest — not a rebuilt one
 *
 * Note the order claim on `dispatchClaimedAt` is deliberately NOT re-taken. The
 * first attempt still owns that; the consumed approval window is the claim for
 * this attempt, so the two cannot be confused with each other.
 */
export async function resumeDispatch(
  deps: DispatcherDeps,
  fanOrderId: string,
  token: string,
): Promise<DispatchTaskOutcome> {
  const order = await deps.db.fanOrder.findUnique({
    where: { id: fanOrderId },
    include: { approvedRequest: true },
  });

  if (!order || !order.approvedRequest) {
    return { kind: 'skipped', fanOrderId, reason: 'no approved request' };
  }

  if (order.state !== 'approval_required') {
    return { kind: 'skipped', fanOrderId, reason: `state is ${order.state}` };
  }

  const bound = await loadBoundRequest(deps, fanOrderId, order.approvedRequest);
  if (!bound.ok) return bound.failure;

  const consumed = await deps.db.approvalWindow.updateMany({
    where: {
      token,
      fanOrderId,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { consumedAt: new Date() },
  });

  if (consumed.count !== 1) {
    return { kind: 'already_claimed', fanOrderId };
  }

  await deps.db.$transaction(async (tx) => {
    await transition(
      tx,
      fanOrderId,
      'dispatching',
      'resuming dispatch after a step-up approval',
      deps.workerId,
      { hasValidApprovalToken: true },
    );
  });

  const outcome = await deps.agnic.dispatch({
    request: {
      ...bound.request,
      user_confirmation_text: order.approvedRequest.fanApprovalText,
      user_approved_at_iso: order.approvedRequest.fanApprovedAtIso.toISOString(),
      approval_token: token,
    },
  });

  return recordDispatchOutcome(deps, fanOrderId, outcome);
}

/**
 * Take the claim, or report that somebody else already did.
 *
 * The claim is a compare-and-swap on a null column rather than a read-then-write,
 * so two workers cannot both believe they won the race. The outbox lock already
 * prevents that in practice; this makes it true even if a task is ever
 * redelivered by some other route.
 */
async function claimForDispatch(
  deps: DispatcherDeps,
  fanOrderId: string,
): Promise<boolean> {
  return deps.db.$transaction(async (tx) => {
    // Read the approved merchant figure now, so the row records the ceiling it
    // was dispatched against at the moment it is created. It was previously left
    // null, which meant reconciliation later held the actual charge with nothing
    // to compare it to -- and the unused headroom was only discoverable from the
    // quote, not from the order.
    const order = await tx.fanOrder.findUniqueOrThrow({
      where: { id: fanOrderId },
      select: { merchantCapMinor: true },
    });

    // The row may not exist yet, so ensure it does before claiming.
    await tx.merchantOrder.upsert({
      where: { fanOrderId },
      create: { fanOrderId, amountApprovedMinor: order.merchantCapMinor },
      // Deliberately not overwritten on update: the approved figure is fixed at
      // dispatch and must not drift if something later touches the order.
      update: {},
    });

    const now = new Date();
    const claimed = await tx.merchantOrder.updateMany({
      where: { fanOrderId, dispatchClaimedAt: null },
      data: { dispatchClaimedAt: now },
    });

    if (claimed.count !== 1) return false;

    await transition(
      tx,
      fanOrderId,
      'dispatching',
      'dispatch claimed; the provider call is about to be issued',
      deps.workerId,
    );

    return true;
  });
}

export async function recordDispatchOutcome(
  deps: DispatcherDeps,
  fanOrderId: string,
  outcome: DispatchOutcome,
): Promise<DispatchTaskOutcome> {
  switch (outcome.state) {
    case 'poll': {
      await deps.db.$transaction(async (tx) => {
        await transition(
          tx,
          fanOrderId,
          'processing',
          `provider accepted the order${outcome.code ? ` (${outcome.code})` : ''}`,
          deps.workerId,
        );

        await tx.merchantOrder.update({
          where: { fanOrderId },
          data: {
            providerOrderId: outcome.orderId,
            statusRaw: 'dispatched',
            dispatchedAt: new Date(),
            retryAction: 'poll',
            ...(outcome.code ? { errorCode: outcome.code } : {}),
          },
        });

        // Poll on a delay rather than immediately: an order takes 60-70s to
        // settle, so asking sooner buys nothing and spends rate limit.
        await enqueue(
          tx,
          OUTBOX_TOPICS.POLL_ORDER_STATUS,
          { fanOrderId },
          { delaySeconds: 3 },
        );
      });

      return { kind: 'dispatched', fanOrderId, providerOrderId: outcome.orderId };
    }

    case 'approval_required': {
      // The currency case is permanent. Waiting cannot fix a mandate denominated
      // in the wrong currency, so it must not enter an approval-polling loop —
      // that would present as a stuck order instead of a configuration fault.
      const permanent = outcome.reason === APPROVAL_REASONS.CURRENCY_MISMATCH;

      await deps.db.$transaction(async (tx) => {
        await transition(
          tx,
          fanOrderId,
          'approval_required',
          `approval required: ${outcome.reason}`,
          deps.workerId,
        );

        await tx.approvalWindow.create({
          data: {
            fanOrderId,
            token: outcome.token,
            approvalUrl: outcome.approvalUrl,
            reason: outcome.reason,
            expiresAt: new Date(Date.now() + outcome.expiresInSeconds * 1000),
          },
        });

        await tx.merchantOrder.update({
          where: { fanOrderId },
          data: {
            errorCode: outcome.reason,
            ...(outcome.orderId ? { providerOrderId: outcome.orderId } : {}),
          },
        });

        if (!permanent) {
          // Poll the approval — never re-dispatch. One of the step-up paths
          // mints a brand-new token on every dispatch call, so a loop that
          // "waits" by dispatching again never terminates.
          await enqueue(
            tx,
            OUTBOX_TOPICS.POLL_APPROVAL,
            { fanOrderId, token: outcome.token },
            { delaySeconds: 5 },
          );
        }
      });

      return {
        kind: 'approval_required',
        fanOrderId,
        reason: outcome.reason,
        permanent,
      };
    }

    case 'refused': {
      // A 409 is documented as arriving before any card is used, which makes it
      // our evidence that nothing was charged.
      await deps.db.$transaction(async (tx) => {
        await transition(
          tx,
          fanOrderId,
          'failed',
          `refused by the provider before any charge: ${outcome.code}`,
          deps.workerId,
          { hasNoChargeEvidence: true },
        );

        await tx.merchantOrder.update({
          where: { fanOrderId },
          data: { statusRaw: outcome.code, errorCode: outcome.code },
        });

        await enqueue(tx, OUTBOX_TOPICS.RELEASE_HOLD, { fanOrderId });
      });

      return { kind: 'refused', fanOrderId, code: outcome.code };
    }

    case 'reconcile': {
      // A lost response is not a failure. The purchase may exist, so this is
      // recorded as unknown and handed to reconciliation — never retried here.
      await deps.db.$transaction(async (tx) => {
        await transition(
          tx,
          fanOrderId,
          'uncertain',
          `outcome unknown (${outcome.code}); reconcile rather than retry`,
          deps.workerId,
        );

        await tx.merchantOrder.update({
          where: { fanOrderId },
          data: {
            errorCode: outcome.code,
            ...(outcome.orderId ? { providerOrderId: outcome.orderId } : {}),
          },
        });
      });

      return { kind: 'uncertain', fanOrderId, code: outcome.code };
    }
  }
}
