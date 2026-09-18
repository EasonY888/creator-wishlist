/**
 * Proves the outbox claim primitive under real concurrency.
 *
 * The claim being tested is not "does it return rows" — it is that two workers
 * racing for work NEVER receive the same task. That property is what stands
 * between a retried dispatch and a double charge, and it can only be shown
 * against a real database holding real row locks.
 */
import { prisma } from '../src/db/client';
import {
  backoffSeconds,
  claim,
  complete,
  enqueue,
  isSafeToRequeueAfterCrash,
  markDead,
  OUTBOX_TOPICS,
  reapStalled,
  retryLater,
  stats,
  type OutboxEventRecord,
} from '../src/orders/outbox';

const ROLLBACK = new Error('rollback-probe');

await prisma.outboxEvent.deleteMany({});

// ---------------------------------------------------------------------------
// Produce
// ---------------------------------------------------------------------------

await prisma.$transaction(async (tx) => {
  for (let i = 0; i < 4; i += 1) {
    await enqueue(tx, OUTBOX_TOPICS.POLL_ORDER_STATUS, { seq: i });
  }
});

console.log('1. enqueued inside a transaction :', (await stats(prisma)).pending, 'pending');

// ---------------------------------------------------------------------------
// Concurrency: worker B cannot take what worker A holds
// ---------------------------------------------------------------------------

let heldByA: OutboxEventRecord[] = [];
let seenByB: OutboxEventRecord[] = [];

try {
  await prisma.$transaction(async (tx) => {
    heldByA = await claim(tx, { workerId: 'worker-A', limit: 10 });
    // A different connection, while A's transaction still holds the row locks.
    seenByB = await claim(prisma, { workerId: 'worker-B', limit: 10 });
    throw ROLLBACK;
  });
} catch (error) {
  if (error !== ROLLBACK) throw error;
}

console.log('\n2. concurrent claim');
console.log('   worker A claimed :', heldByA.length);
console.log('   worker B saw     :', seenByB.length, seenByB.length === 0 ? '(skipped locked rows)' : '(OVERLAP!)');
console.log('   overlap          :', heldByA.some((a) => seenByB.some((b) => b.id === a.id)) ? 'YES - BROKEN' : 'none');

const overlap = heldByA.some((a) => seenByB.some((b) => b.id === a.id));

// ---------------------------------------------------------------------------
// Claim marks state and counts the attempt
// ---------------------------------------------------------------------------

const firstBatch = await claim(prisma, { workerId: 'worker-A', limit: 2 });
const secondBatch = await claim(prisma, { workerId: 'worker-B', limit: 10 });

console.log('\n3. sequential claims');
console.log('   A took           :', firstBatch.length);
console.log('   B took the rest  :', secondBatch.length);
console.log('   attempts on first:', firstBatch[0]?.attempts, '| status:', firstBatch[0]?.status);
console.log(
  '   all four distinct:',
  new Set([...firstBatch, ...secondBatch].map((r) => r.id)).size === 4 ? 'yes' : 'NO',
);

// ---------------------------------------------------------------------------
// Terminal transitions
// ---------------------------------------------------------------------------

const toComplete = firstBatch[0]!;
const toRetry = firstBatch[1] ?? secondBatch[0]!;
const toKill = secondBatch[0] ?? secondBatch[1]!;

await complete(prisma, toComplete.id);
const retryResult = await retryLater(prisma, toRetry.id, 'transient network error', 1, toRetry.topic);
await markDead(prisma, toKill.id, 'permanent failure');

console.log('\n4. transitions');
console.log('   completed        :', toComplete.id.slice(0, 8));
console.log('   retried          :', retryResult, `(waits ${backoffSeconds(1)}s)`);
console.log('   dead             :', toKill.id.slice(0, 8));

// The retried task is in the future, so it must not be claimable yet.
const immediate = await claim(prisma, { workerId: 'worker-C', limit: 10 });
console.log(
  '   retried row claimable immediately?:',
  immediate.some((r) => r.id === toRetry.id) ? 'YES - backoff broken' : 'no (correct)',
);

// ---------------------------------------------------------------------------
// The safety rule: dispatch is never requeued after a crash
// ---------------------------------------------------------------------------

console.log('\n5. crash recovery');
console.log(
  '   poll.     safe to requeue:',
  isSafeToRequeueAfterCrash(OUTBOX_TOPICS.POLL_ORDER_STATUS),
);
console.log(
  '   dispatch  safe to requeue:',
  isSafeToRequeueAfterCrash(OUTBOX_TOPICS.DISPATCH_MERCHANT_ORDER),
  '  <- must be false',
);

// Enqueue one of each, claim them so they look like a dead worker's leftovers,
// then reap. The read comes back; the spend does not.
const dispatchId = await prisma.$transaction((tx) =>
  enqueue(tx, OUTBOX_TOPICS.DISPATCH_MERCHANT_ORDER, { fanOrderId: 'fo_1' }),
);
const pollId = await prisma.$transaction((tx) =>
  enqueue(tx, OUTBOX_TOPICS.POLL_ORDER_STATUS, { fanOrderId: 'fo_1' }),
);

await claim(prisma, { workerId: 'worker-D', limit: 50 });

const reaped = await reapStalled(prisma, { olderThanSeconds: 0, limit: 50 });

console.log('   requeued         :', reaped.requeued.map((r) => r.topic));
console.log('   stalled          :', reaped.stalled.map((r) => r.topic), '<- needs reconciliation, not a retry');

console.log('\n6. final state');
console.log('  ', await stats(prisma));

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

await prisma.outboxEvent.deleteMany({});
await prisma.$disconnect();

const failures = [
  overlap ? 'worker overlap in concurrent claim' : null,
  reaped.requeued.some((r) => r.id === dispatchId) ? 'dispatch was requeued' : null,
  !reaped.stalled.some((r) => r.id === dispatchId) ? 'dispatch was not reported stalled' : null,
  !reaped.requeued.some((r) => r.id === pollId) ? 'poll was not requeued' : null,
].filter(Boolean);

console.log(
  `\n${failures.length === 0 ? 'All outbox invariants held.' : `FAILURES: ${failures.join('; ')}`}`,
);
