import type { Db } from '../db/types';
import type { Prisma } from '../generated/prisma/client';

/**
 * The transactional outbox.
 *
 * The problem it solves: a fan approves an order, and the work to actually place
 * it has to happen somewhere. If that intent lives only in memory, a crash
 * between "approved" and "dispatched" loses the order silently — the fan has a
 * payment hold, the creator gets nothing, and nobody knows. So the intent is
 * written in the SAME transaction as the approval. It is durable before anything
 * touches the network.
 *
 * The claim is the other half. Workers take work with
 * `SELECT ... FOR UPDATE SKIP LOCKED`, which is why this project targets Postgres
 * and not SQLite: row-level locking is what makes "claimed exactly once" true
 * under concurrency, rather than true in a single-threaded test.
 */

/** Both a PrismaClient and an interactive-transaction client satisfy this. */
export type OutboxDb = Db;

/** Topic strings. A worker claims only the topics it has a handler for. */
export const OUTBOX_TOPICS = {
  DISPATCH_MERCHANT_ORDER: 'dispatch.merchant_order',
  POLL_ORDER_STATUS: 'poll.order_status',
  POLL_APPROVAL: 'approval.poll',
  RELEASE_HOLD: 'payment.release_hold',
  REFRESH_WISHLIST_ITEM: 'wishlist.refresh_item',
} as const;

export type OutboxTopic = (typeof OUTBOX_TOPICS)[keyof typeof OUTBOX_TOPICS];

export type OutboxStatus = 'pending' | 'processing' | 'done' | 'dead';

export interface OutboxEventRecord {
  id: string;
  topic: string;
  payload: unknown;
  status: string;
  attempts: number;
  availableAt: Date;
  claimedAt: Date | null;
  claimedBy: string | null;
  completedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export const MAX_ATTEMPTS = 5;

/**
 * Whether a task whose worker died mid-flight may be put back in the queue.
 *
 * **This is the single most important function in the file.**
 *
 * A dispatch task must NEVER be requeued automatically. The dispatcher writes a
 * durable claim on the order *before* it calls the provider, so a worker that
 * died mid-call may well have already spent money — it simply never got to
 * record the result. Requeueing would then dispatch a second time and charge the
 * fan twice. The correct response to a stalled dispatch is reconciliation, not
 * retry.
 *
 * Reads and idempotency-keyed writes are different. Polling an order is a pure
 * read, and releasing an authorization carries a processor idempotency key, so
 * both are safe to repeat.
 */
export function isSafeToRequeueAfterCrash(topic: string): boolean {
  return topic !== OUTBOX_TOPICS.DISPATCH_MERCHANT_ORDER;
}

/**
 * Exponential backoff, capped.
 *
 * Deterministic rather than jittered: with `SKIP LOCKED`, two workers racing for
 * the same row simply take different rows, so there is no thundering herd to
 * spread out. Compare with a naive polling queue over shared rows, where jitter
 * would matter.
 */
export function backoffSeconds(attempts: number, base = 5, cap = 300): number {
  const exponential = base * 2 ** Math.max(0, attempts - 1);
  return Math.min(cap, exponential);
}

// ---------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------

export interface EnqueueOptions {
  delaySeconds?: number;
}

/**
 * Record work to be done, inside the caller's transaction.
 *
 * Takes a transaction client rather than the global one on purpose. Callers must
 * be able to write the state change and the intent atomically — if these were
 * separate transactions, the gap between them is exactly where an order gets
 * lost.
 */
export async function enqueue(
  tx: OutboxDb,
  topic: OutboxTopic,
  payload: unknown,
  options: EnqueueOptions = {},
): Promise<string> {
  const availableAt =
    options.delaySeconds === undefined
      ? new Date()
      : new Date(Date.now() + options.delaySeconds * 1000);

  const created = await tx.outboxEvent.create({
    data: {
      topic,
      payload: payload as Prisma.InputJsonValue,
      status: 'pending',
      availableAt,
    },
    select: { id: true },
  });

  return created.id;
}

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

/**
 * Atomically claim up to `limit` due tasks for this worker.
 *
 * Claim and mark happen in a single statement: the CTE locks candidate rows with
 * `SKIP LOCKED` and the UPDATE stamps them in the same breath. Because it is one
 * statement there is no window between "chose this row" and "marked it mine", so
 * two workers cannot both take the same task.
 *
 * `SKIP LOCKED` means a worker never blocks on another worker's row — it moves on
 * to the next available one. Without it, concurrent dispatchers would serialise
 * behind each other; with it, a slow merchant call cannot stall an unrelated
 * order.
 *
 * `attempts` is incremented here, so an attempt is counted the moment it is
 * taken rather than when it fails. A worker that dies mid-task has still used
 * one, which is what stops a crash loop from retrying forever.
 */
export async function claim(
  db: OutboxDb,
  options: { workerId: string; limit?: number; topics?: readonly string[] },
): Promise<OutboxEventRecord[]> {
  const limit = options.limit ?? 5;

  // A worker must not claim work it has no handler for. Without this filter an
  // approval-polling task would be taken by the dispatcher and either wedge or
  // be wrongly marked dead, which is how a queue quietly loses work.
  const topics =
    options.topics && options.topics.length > 0 ? [...options.topics] : null;

  return db.$queryRaw<OutboxEventRecord[]>`
    with claimed as (
      select id
      from "OutboxEvent"
      where status = 'pending'
        and "availableAt" <= now()
        and (${topics}::text[] is null or topic = any(${topics}::text[]))
      order by "availableAt", "createdAt"
      limit ${limit}
      for update skip locked
    )
    update "OutboxEvent" as e
    set status      = 'processing',
        "claimedAt" = now(),
        "claimedBy" = ${options.workerId},
        attempts    = e.attempts + 1
    from claimed
    where e.id = claimed.id
    returning e.id,
              e.topic,
              e.payload,
              e.status::text as status,
              e.attempts,
              e."availableAt",
              e."claimedAt",
              e."claimedBy",
              e."completedAt",
              e."lastError",
              e."createdAt"
  `;
}

export async function complete(db: OutboxDb, id: string): Promise<void> {
  await db.outboxEvent.update({
    where: { id },
    data: { status: 'done', completedAt: new Date(), lastError: null },
  });
}

/**
 * Reschedule a task that failed for a reason that may not repeat.
 *
 * Returns which state it landed in so the caller can log or alert on dead
 * letters rather than discovering them later.
 */
export async function retryLater(
  db: OutboxDb,
  id: string,
  error: string,
  attempts: number,
  topic: string,
): Promise<'pending' | 'dead'> {
  if (attempts >= MAX_ATTEMPTS) {
    await markDead(db, id, `exhausted ${attempts} attempts: ${error}`);
    return 'dead';
  }

  // A task that is not safe to repeat must not be requeued even on an ordinary
  // failure. The dispatcher decides what happens to the order instead.
  if (!isSafeToRequeueAfterCrash(topic)) {
    await markDead(db, id, `not retryable by policy: ${error}`);
    return 'dead';
  }

  const wait = backoffSeconds(attempts);

  // `updateMany` rather than `update`: the row can legitimately be gone by now.
  // Housekeeping purges finished tasks, and another worker's crash recovery can
  // reap this one while we are still finishing it. `update` throws P2025 on a
  // missing row, which would kill the worker over a condition it cannot act on.
  const updated = await db.outboxEvent.updateMany({
    where: { id },
    data: {
      status: 'pending',
      availableAt: new Date(Date.now() + wait * 1000),
      lastError: error,
      claimedAt: null,
      claimedBy: null,
    },
  });

  // Gone means it will never run again, which is what 'dead' tells the caller.
  // Reporting 'pending' would claim a task is waiting when it no longer exists.
  return updated.count === 0 ? 'dead' : 'pending';
}

export async function markDead(
  db: OutboxDb,
  id: string,
  error: string,
): Promise<void> {
  // Tolerant for the same reason as `retryLater`: the row may already be gone,
  // and there is nothing useful to do about that.
  await db.outboxEvent.updateMany({
    where: { id },
    data: { status: 'dead', completedAt: new Date(), lastError: error },
  });
}

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

export interface ReapResult {
  /**
   * Tasks put back in the queue. Safe to retry: reads and idempotent writes.
   */
  requeued: OutboxEventRecord[];
  /**
   * Tasks that must NOT be retried. For these the caller has to reconcile the
   * associated order, because the work may already have happened.
   */
  stalled: OutboxEventRecord[];
}

/**
 * Recover tasks abandoned by a worker that died.
 *
 * Without this, a crash mid-task leaves a row in `processing` forever and the
 * order wedges with no operator-visible reason. With it, the row is either
 * retried — if retrying is provably safe — or surfaced as stalled, which means
 * "go and find out what actually happened".
 *
 * The split is by topic, not by how long it has been stalled, because duration
 * says nothing about whether money moved.
 */
export async function reapStalled(
  db: OutboxDb,
  options: { olderThanSeconds?: number; limit?: number },
): Promise<ReapResult> {
  const olderThanSeconds = options.olderThanSeconds ?? 120;
  const limit = options.limit ?? 50;

  return db.$transaction(async (tx) => {
    const abandoned = await tx.$queryRaw<OutboxEventRecord[]>`
      select id,
             topic,
             payload,
             status::text as status,
             attempts,
             "availableAt",
             "claimedAt",
             "claimedBy",
             "completedAt",
             "lastError",
             "createdAt"
      from "OutboxEvent"
      where status = 'processing'
        and "claimedAt" < now() - make_interval(secs => ${olderThanSeconds})
      order by "claimedAt"
      limit ${limit}
      for update skip locked
    `;

    const requeued: OutboxEventRecord[] = [];
    const stalled: OutboxEventRecord[] = [];

    for (const task of abandoned) {
      if (isSafeToRequeueAfterCrash(task.topic)) {
        await tx.outboxEvent.update({
          where: { id: task.id },
          data: {
            status: 'pending',
            availableAt: new Date(),
            claimedAt: null,
            claimedBy: null,
            lastError: 'recovered from a stalled worker',
          },
        });
        requeued.push(task);
      } else {
        await markDead(
          tx,
          task.id,
          'worker died mid-task and this work is not safe to repeat; reconcile the order',
        );
        stalled.push(task);
      }
    }

    return { requeued, stalled };
  });
}

/** Housekeeping for tests and the operator console. */
export async function stats(db: OutboxDb): Promise<Record<string, number>> {
  const rows = await db.$queryRaw<Array<{ status: string; count: bigint }>>`
    select status::text as status, count(*)::bigint as count
    from "OutboxEvent"
    group by status
  `;

  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
}
