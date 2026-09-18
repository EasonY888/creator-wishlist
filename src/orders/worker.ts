import type { AgnicPort } from '../agnic/port';
import type { Db } from '../db/types';
import { assertTransition, type FanOrderState } from '../domain/order-fsm';
import { recordPaymentOnce } from '../payments/ledger';
import { idempotencyKeyFor, type PaymentPort } from '../payments/port';
import { runDispatchTask } from './dispatcher';
import { runApprovalTask } from './approval';
import {
  claim,
  complete,
  OUTBOX_TOPICS,
  reapStalled,
  retryLater,
  type OutboxEventRecord,
} from './outbox';
import { runReconcileTask } from './reconciler';

/**
 * The worker loop: claim work, run it, then record whether it succeeded.
 *
 * This is the piece that makes the outbox real. `runDispatchTask` handles one
 * task and returns an outcome; without this, a claimed row stays in `processing`
 * forever and the pipeline stalls after a single order.
 *
 * The lifecycle is deliberately boring: a task is completed unless its handler
 * says it should be retried, or it throws. Retry policy — including the rule
 * that dispatch work is never requeued — lives in `outbox.retryLater`, so it
 * applies no matter which handler failed.
 */

export interface WorkerDeps {
  db: Db;
  agnic: AgnicPort;
  payments: PaymentPort;
  workerId: string;
}

/**
 * Topics this worker has a handler for.
 *
 * `POLL_APPROVAL` is now handled, so an order waiting on a step-up approval
 * progresses instead of sitting there. Claiming a task with no handler would
 * wedge it in `processing` or mark it dead, and either way the work is lost — so
 * the claim filter means a topic is only ever claimed by a worker that can
 * actually do it.
 */
export const HANDLED_TOPICS = [
  OUTBOX_TOPICS.DISPATCH_MERCHANT_ORDER,
  OUTBOX_TOPICS.POLL_ORDER_STATUS,
  OUTBOX_TOPICS.POLL_APPROVAL,
  OUTBOX_TOPICS.RELEASE_HOLD,
] as const;

interface HandlerResult {
  note: string;
  /** Set when the task should be attempted again rather than completed. */
  retryable?: boolean;
}

export interface TaskReport {
  taskId: string;
  topic: string;
  result: string;
  action: 'completed' | 'retried' | 'dead';
}

export interface DrainResult {
  claimed: number;
  reports: TaskReport[];
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Drop the fan's authorization after a failure that was proven to happen before
 * the card was used.
 *
 * Both the dispatcher and the reconciler can reach a refusal, so this may run for
 * an order whose hold was already released. The processor's idempotency key and
 * the ledger's duplicate check make that harmless.
 */
async function runReleaseHoldTask(
  deps: WorkerDeps,
  task: OutboxEventRecord,
): Promise<HandlerResult> {
  const fanOrderId = (task.payload as { fanOrderId?: string } | null)?.fanOrderId;
  if (!fanOrderId) {
    throw new Error(`Release task ${task.id} has no fanOrderId in its payload.`);
  }

  const order = await deps.db.fanOrder.findUnique({
    where: { id: fanOrderId },
    select: { id: true, state: true, fanTotalMinor: true, currency: true },
  });

  if (!order) return { note: 'order not found' };

  // Releasing is only correct for an order that failed. Releasing against a live
  // or succeeded order would hand the fan their money back for a gift that is
  // already on its way.
  if (order.state !== 'failed') {
    return { note: `not released: order is ${order.state}` };
  }

  const result = await deps.payments.release({
    fanOrderId,
    idempotencyKey: idempotencyKeyFor('release', fanOrderId),
    amountMinor: order.fanTotalMinor,
    currency: order.currency,
  });

  if (result.state === 'failed') {
    return {
      note: `release failed: ${result.code}`,
      retryable: result.retryable ?? false,
    };
  }

  await deps.db.$transaction(async (tx) => {
    await recordPaymentOnce(tx, {
      fanOrderId,
      type: 'released',
      amountMinor: result.amountMinor,
      currency: order.currency,
      providerRef: result.reference,
    });
  });

  return { note: `hold released (${result.state})` };
}

async function handle(
  deps: WorkerDeps,
  task: OutboxEventRecord,
): Promise<HandlerResult> {
  switch (task.topic) {
    case OUTBOX_TOPICS.DISPATCH_MERCHANT_ORDER: {
      const outcome = await runDispatchTask(deps, task);
      // Every dispatch outcome completes the task, including "we do not know".
      // The dispatcher already recorded what happened, and retrying a dispatch
      // is how a fan gets charged twice — `retryLater` refuses to requeue this
      // topic regardless of what it is told.
      return {
        note:
          outcome.kind === 'binding_failed'
            ? `binding_failed:${outcome.code}`
            : outcome.kind,
      };
    }

    case OUTBOX_TOPICS.POLL_ORDER_STATUS: {
      const outcome = await runReconcileTask(deps, task);
      if (outcome.kind === 'retryable_error') {
        // A read that failed says nothing about the order, so trying again is
        // safe by definition. Contrast a dispatch failure, which is not.
        return { note: `reconcile error: ${outcome.code}`, retryable: true };
      }
      return { note: outcome.kind };
    }

    case OUTBOX_TOPICS.RELEASE_HOLD:
      return runReleaseHoldTask(deps, task);

    case OUTBOX_TOPICS.POLL_APPROVAL: {
      const outcome = await runApprovalTask(deps, task);
      if (outcome.kind === 'retryable_error') {
        // Reading an approval says nothing about the order, so retrying is safe.
        return { note: `approval poll error: ${outcome.code}`, retryable: true };
      }
      return { note: outcome.kind === 'permanent_fault' ? `permanent:${outcome.reason}` : outcome.kind };
    }

    default:
      throw new Error(`No handler registered for topic "${task.topic}".`);
  }
}

async function processTask(
  deps: WorkerDeps,
  task: OutboxEventRecord,
): Promise<TaskReport> {
  try {
    const result = await handle(deps, task);

    if (result.retryable) {
      const state = await retryLater(
        deps.db,
        task.id,
        result.note,
        task.attempts,
        task.topic,
      );
      return {
        taskId: task.id,
        topic: task.topic,
        result: result.note,
        action: state === 'dead' ? 'dead' : 'retried',
      };
    }

    await complete(deps.db, task.id);
    return {
      taskId: task.id,
      topic: task.topic,
      result: result.note,
      action: 'completed',
    };
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    const state = await retryLater(
      deps.db,
      task.id,
      message,
      task.attempts,
      task.topic,
    );

    return {
      taskId: task.id,
      topic: task.topic,
      result: message,
      action: state === 'dead' ? 'dead' : 'retried',
    };
  }
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export async function drainOnce(
  deps: WorkerDeps,
  options: { limit?: number; topics?: readonly string[] } = {},
): Promise<DrainResult> {
  const tasks = await claim(deps.db, {
    workerId: deps.workerId,
    limit: options.limit ?? 10,
    topics: options.topics ?? HANDLED_TOPICS,
  });

  const reports: TaskReport[] = [];
  for (const task of tasks) {
    reports.push(await processTask(deps, task));
  }

  return { claimed: tasks.length, reports };
}

export interface RecoverResult {
  requeued: number;
  /** Orders moved to `uncertain` because their dispatch may already have happened. */
  markedUncertain: string[];
}

/**
 * Recover work abandoned by a worker that died.
 *
 * Requeueing is handled per-topic by the outbox. What is left to do here is the
 * consequence for the order: a stalled dispatch means we may have placed a
 * purchase and lost the answer, so the order must be marked `uncertain` and
 * escalated rather than quietly retried.
 */
export async function recoverStalled(
  deps: WorkerDeps,
  options: { olderThanSeconds?: number; limit?: number } = {},
): Promise<RecoverResult> {
  const { requeued, stalled } = await reapStalled(deps.db, options);
  const markedUncertain: string[] = [];

  for (const task of stalled) {
    const fanOrderId = (task.payload as { fanOrderId?: string } | null)?.fanOrderId;
    if (!fanOrderId) continue;

    const order = await deps.db.fanOrder.findUnique({
      where: { id: fanOrderId },
      select: { state: true },
    });
    if (!order) continue;

    const from = order.state as FanOrderState;

    // Only an in-flight order can become uncertain. Anything terminal is left
    // alone, because we would be overwriting a known outcome with a guess.
    if (from !== 'dispatching') continue;

    await deps.db.$transaction(async (tx) => {
      assertTransition(from, 'uncertain');
      await tx.fanOrder.update({
        where: { id: fanOrderId },
        data: { state: 'uncertain' },
      });
      await tx.orderEvent.create({
        data: {
          fanOrderId,
          fromState: from,
          toState: 'uncertain',
          note: 'worker died mid-dispatch; the purchase may exist, so this needs reconciliation rather than a retry',
          actor: deps.workerId,
        },
      });
    });

    markedUncertain.push(fanOrderId);
  }

  return { requeued: requeued.length, markedUncertain };
}

/**
 * Used when the provider says we are out of quota but not when it resets.
 *
 * Clamped at both ends on purpose: a zero would spin the loop, and a hostile or
 * buggy header must not be able to park the worker indefinitely.
 */
const DEFAULT_QUOTA_RESET_SECONDS = 30;
const MAX_QUOTA_RESET_SECONDS = 300;

/**
 * How long to hold off when the provider reports no quota remaining.
 *
 * Counted from the provider's own headers rather than a local request tally: the
 * limits are keyed to the API key, so another process or a teammate consumes the
 * same budget and a local counter cannot see that.
 *
 * Returns null when there is quota, or when the rail reports none -- an unmetered
 * rail must not be throttled by a guess.
 */
function throttleDelayMs(agnic: WorkerDeps['agnic']): number | null {
  const status = agnic.quotaStatus?.();
  if (!status || status.remaining === null || status.remaining > 0) return null;

  const seconds = status.resetSeconds ?? DEFAULT_QUOTA_RESET_SECONDS;
  return Math.min(Math.max(seconds, 1), MAX_QUOTA_RESET_SECONDS) * 1000;
}

/**
 * Run until stopped.
 *
 * Sequential rather than concurrent on purpose: a single worker taking a batch
 * and finishing it is easier to reason about than a pool, and the per-merchant
 * isolation this product needs comes from bounded claim sizes rather than from
 * parallelism inside one process.
 */
export async function runWorkerLoop(
  deps: WorkerDeps,
  options: {
    intervalMs?: number;
    batchSize?: number;
    signal?: AbortSignal;
    onDrain?: (result: DrainResult) => void;
    /** How often to sweep for tasks abandoned by a dead worker. */
    recoverEveryMs?: number;
  } = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 1000;
  const recoverEveryMs = options.recoverEveryMs ?? 60_000;
  let lastRecovery = Date.now();

  while (!options.signal?.aborted) {
    // Out of quota. Claiming work now would burn an attempt on a call the
    // provider is going to refuse, and leave the task sitting out its backoff
    // afterwards -- strictly worse than simply waiting.
    const throttledMs = throttleDelayMs(deps.agnic);
    if (throttledMs !== null) {
      await new Promise((resolve) => setTimeout(resolve, throttledMs));
      continue;
    }

    if (Date.now() - lastRecovery >= recoverEveryMs) {
      await recoverStalled(deps);
      lastRecovery = Date.now();
    }

    const result = await drainOnce(deps, { limit: options.batchSize ?? 10 });
    options.onDrain?.(result);

    if (result.claimed === 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
