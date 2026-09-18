import type { AgnicPort } from '../agnic/port';
import { toProviderOrder } from '../agnic/port';
import type { Db } from '../db/types';
import { fanChargeFor } from '../domain/charge';
import { nextOrderAction, type OrderAction } from '../domain/order-action';
import {
  assertTransition,
  type FanOrderState,
  type TransitionGuardContext,
} from '../domain/order-fsm';
import { idempotencyKeyFor, type PaymentPort } from '../payments/port';
import { recordPaymentOnce } from '../payments/ledger';
import { enqueue, OUTBOX_TOPICS, type OutboxEventRecord } from './outbox';

/**
 * The reconciler.
 *
 * A dispatched order is never finished just because we sent it. It takes the
 * provider sixty to seventy seconds to settle, and it can settle badly. This is
 * the code that watches it to a terminal state and makes sure the fan's payment
 * ends up matching what actually happened at the merchant.
 *
 * The design rule throughout: **the provider's own fields decide.** We branch on
 * `retry_action`, and only then on `retryable` — never on an error string, and
 * never on how long the order has been running. Duration tells you nothing about
 * whether money moved.
 */

export interface ReconcileDeps {
  db: Db;
  agnic: AgnicPort;
  payments: PaymentPort;
  workerId: string;
}

export interface ReconcilePayload {
  fanOrderId: string;
}

export type ReconcileOutcome =
  | { kind: 'captured'; fanOrderId: string; amountMinor: number }
  | { kind: 'released'; fanOrderId: string; reason: string }
  | { kind: 'still_processing'; fanOrderId: string; providerStatus: string }
  | { kind: 'handed_off'; fanOrderId: string; providerStatus: string }
  | { kind: 'needs_human'; fanOrderId: string; providerStatus: string }
  | { kind: 'skipped'; fanOrderId: string; reason: string }
  | { kind: 'retryable_error'; fanOrderId: string; code: string };

/** Terminal states need no further watching. */
const TERMINAL: readonly FanOrderState[] = [
  'succeeded',
  'failed',
  'refunded',
  'partially_fulfilled',
];

function guardContextFor(to: FanOrderState): TransitionGuardContext {
  if (to === 'succeeded') {
    // Reaching here means we read the provider's own record, which is the
    // evidence the uncertain -> succeeded edge is guarded on.
    return { hasReconciliationEvidence: true };
  }
  if (to === 'failed') {
    // Only ever passed for an action that proves nothing was charged.
    return { hasNoChargeEvidence: true };
  }
  return {};
}

/**
 * Record why an otherwise-successful order was not charged.
 *
 * A timeline entry rather than a log line, because the order stays in
 * `processing` and a person looking at it has to be able to see that the machine
 * stopped on purpose rather than silently failing.
 */
async function recordBlockedCapture(
  deps: ReconcileDeps,
  fanOrderId: string,
  currentState: FanOrderState,
  decision: Extract<ReturnType<typeof fanChargeFor>, { state: 'blocked' }>,
): Promise<void> {
  await deps.db.orderEvent.create({
    data: {
      fanOrderId,
      fromState: currentState,
      toState: currentState,
      note: `capture blocked (${decision.code}): ${decision.reason}`,
      actor: deps.workerId,
    },
  });
}

async function transition(
  tx: Db,
  fanOrderId: string,
  to: FanOrderState,
  note: string,
  actor: string,
  action?: OrderAction,
): Promise<FanOrderState> {
  const current = await tx.fanOrder.findUnique({
    where: { id: fanOrderId },
    select: { state: true },
  });

  if (!current) throw new Error(`Fan order ${fanOrderId} not found.`);

  const from = current.state as FanOrderState;
  assertTransition(from, to, guardContextFor(to));

  await tx.fanOrder.update({ where: { id: fanOrderId }, data: { state: to } });
  await tx.orderEvent.create({
    data: {
      fanOrderId,
      fromState: from,
      toState: to,
      note,
      actor,
      ...(action ? { action } : {}),
    },
  });

  return from;
}

/**
 * Record the fan's payment exactly once.
 *
 * The processor call happens OUTSIDE the transaction — an external call inside a
 * database transaction holds a connection for the duration of a network round
 * trip, and cannot be rolled back anyway. Safety comes from the processor's
 * idempotency key plus the ledger's own duplicate check, so this is safe to run
 * repeatedly.
 */
export async function runReconcileTask(
  deps: ReconcileDeps,
  task: OutboxEventRecord,
): Promise<ReconcileOutcome> {
  const payload = task.payload as ReconcilePayload | null;
  const fanOrderId = payload?.fanOrderId;

  if (!fanOrderId) {
    throw new Error(`Reconcile task ${task.id} has no fanOrderId in its payload.`);
  }

  const order = await deps.db.fanOrder.findUnique({
    where: { id: fanOrderId },
    include: { merchantOrder: true },
  });

  if (!order) return { kind: 'skipped', fanOrderId, reason: 'order not found' };

  if (TERMINAL.includes(order.state as FanOrderState)) {
    return { kind: 'skipped', fanOrderId, reason: `already ${order.state}` };
  }

  const providerOrderId = order.merchantOrder?.providerOrderId;
  if (!providerOrderId) {
    // Nothing was placed, so there is nothing to reconcile against. The
    // dispatcher owns this order's fate, not us.
    return { kind: 'skipped', fanOrderId, reason: 'no provider order id' };
  }

  // Read the provider's record. This is the ONLY way we ever learn an outcome —
  // never by re-dispatching.
  let raw;
  try {
    raw = await deps.agnic.getOrder(providerOrderId);
  } catch (error) {
    // A read failure says nothing about the order, so it is retryable by
    // definition. Contrast with a dispatch failure, which is not.
    return {
      kind: 'retryable_error',
      fanOrderId,
      code: String((error as Error).message ?? error),
    };
  }

  const providerOrder = toProviderOrder(raw);
  const action = nextOrderAction(providerOrder);

  // Record the observation before acting on it, so the operator timeline shows
  // what we saw even if the action below throws.
  await deps.db.merchantOrder.update({
    where: { fanOrderId },
    data: {
      statusRaw: providerOrder.status,
      retryable: providerOrder.retryable ?? null,
      retryAction: providerOrder.retry_action ?? null,
      action,
      lastPolledAt: new Date(),
      pollCount: { increment: 1 },
      ...(providerOrder.amount_charged_minor === null ||
      providerOrder.amount_charged_minor === undefined
        ? {}
        : { amountChargedMinor: providerOrder.amount_charged_minor }),
      ...(providerOrder.evidence === null || providerOrder.evidence === undefined
        ? {}
        : { evidence: providerOrder.evidence as object }),
    },
  });

  switch (action) {
    case 'capture_once': {
      // Charge the merchant's REAL figure plus the fee the fan was shown -- not
      // the approved ceiling.
      //
      // The quote carries headroom for tax the merchant often does not apply, so
      // it routinely charges less than the quote. Capturing the authorised total
      // regardless meant the fan paid the worst case every time and our displayed
      // fee understated what we actually kept. See `domain/charge.ts`.
      const decision = fanChargeFor({
        merchantChargedMinor: providerOrder.amount_charged_minor,
        markupMinor: order.markupMinor,
        authorizedMinor: order.fanTotalMinor,
      });

      if (decision.state === 'blocked') {
        // Deliberately not captured. The authorisation is still live, so waiting
        // costs nothing -- whereas guessing high takes money the fan may not owe,
        // which is the behaviour this replaced.
        await recordBlockedCapture(deps, fanOrderId, order.state as FanOrderState, decision);

        return { kind: 'needs_human', fanOrderId, providerStatus: providerOrder.status };
      }

      const result = await deps.payments.capture({
        fanOrderId,
        idempotencyKey: idempotencyKeyFor('capture', fanOrderId),
        amountMinor: decision.amountMinor,
        currency: order.currency,
      });

      if (result.state === 'failed') {
        return { kind: 'retryable_error', fanOrderId, code: result.code };
      }

      const merchantCharged = providerOrder.amount_charged_minor;

      await deps.db.$transaction(async (tx) => {
        await recordPaymentOnce(tx, {
          fanOrderId,
          type: 'captured',
          amountMinor: result.amountMinor,
          currency: order.currency,
          providerRef: result.reference,
        });

        await transition(
          tx,
          fanOrderId,
          'succeeded',
          // Both figures, so the receipt explains itself: what the merchant took
          // and what the fan was charged are different numbers on purpose.
          `merchant charged ${merchantCharged ?? 'unknown'}; charged the fan ${result.amountMinor} ${order.currency} (merchant ${merchantCharged ?? '?'} + fee ${order.markupMinor})`,
          deps.workerId,
          action,
        );
      });

      return { kind: 'captured', fanOrderId, amountMinor: result.amountMinor };
    }

    case 'release_hold_once': {
      const result = await deps.payments.release({
        fanOrderId,
        idempotencyKey: idempotencyKeyFor('release', fanOrderId),
        amountMinor: order.fanTotalMinor,
        currency: order.currency,
      });

      if (result.state === 'failed') {
        return { kind: 'retryable_error', fanOrderId, code: result.code };
      }

      await deps.db.$transaction(async (tx) => {
        await recordPaymentOnce(tx, {
          fanOrderId,
          type: 'released',
          amountMinor: result.amountMinor,
          currency: order.currency,
          providerRef: result.reference,
        });

        await transition(
          tx,
          fanOrderId,
          'failed',
          `refused before the card was used (${providerOrder.status}); hold released`,
          deps.workerId,
          action,
        );
      });

      return {
        kind: 'released',
        fanOrderId,
        reason: providerOrder.status,
      };
    }

    case 'human_handoff': {
      // A person has to act at the shop. The order is NOT failed and must not be
      // re-placed — keep watching it and surface it to an operator.
      await deps.db.$transaction(async (tx) => {
        await tx.orderEvent.create({
          data: {
            fanOrderId,
            action,
            rawStatus: providerOrder.status,
            note: 'a human step is required at the merchant; polling continues',
            actor: deps.workerId,
          },
        });

        await enqueue(
          tx,
          OUTBOX_TOPICS.POLL_ORDER_STATUS,
          { fanOrderId },
          { delaySeconds: 10 },
        );
      });

      return { kind: 'handed_off', fanOrderId, providerStatus: providerOrder.status };
    }

    case 'poll_later': {
      // Still running. Poll again on a delay — and note this never re-dispatches.
      const polls = (order.merchantOrder?.pollCount ?? 0) + 1;
      // An order settles in 60-70s, so roughly twenty polls covers the normal
      // case. Beyond that we back off rather than hammering the provider.
      const delaySeconds = polls < 20 ? 3 : 15;

      await enqueue(
        deps.db,
        OUTBOX_TOPICS.POLL_ORDER_STATUS,
        { fanOrderId },
        { delaySeconds },
      );

      return {
        kind: 'still_processing',
        fanOrderId,
        providerStatus: providerOrder.status,
      };
    }

    case 'reconcile':
    default: {
      // Genuinely unknown. Stop automating: no retry, no capture, no release,
      // and no claim that we know what happened.
      await deps.db.$transaction(async (tx) => {
        const current = await tx.fanOrder.findUnique({
          where: { id: fanOrderId },
          select: { state: true },
        });

        if (current && !TERMINAL.includes(current.state as FanOrderState)) {
          await transition(
            tx,
            fanOrderId,
            'uncertain',
            `outcome unknown (${providerOrder.status}); escalated rather than resolved locally`,
            deps.workerId,
            action,
          );
        }
      });

      return {
        kind: 'needs_human',
        fanOrderId,
        providerStatus: providerOrder.status,
      };
    }
  }
}
