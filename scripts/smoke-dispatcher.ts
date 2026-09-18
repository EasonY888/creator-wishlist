/**
 * Proves the dispatcher's central guarantee against a real database:
 *
 *   for one approved fan order, the provider is asked to place the purchase
 *   exactly once, no matter how many times the task is run.
 *
 * Each scenario seeds a real order, runs the dispatch task, and then re-runs the
 * SAME task to confirm nothing happens the second time. The re-run is the part
 * that matters: it is a stand-in for a worker dying after the provider accepted
 * the order and the task being redelivered.
 */
import { chaos } from '../src/agnic/fake';
import type { FakeAgnic } from '../src/agnic/fake';
import { toShipTo } from '../src/agnic/port';
import { prisma } from '../src/db/client';
import { computeRequestDigest, computeShipToDigest, type BoundRequest } from '../src/fulfillment/binding';
import { writeCreatorAddress } from '../src/fulfillment/address-store';
import { runDispatchTask } from '../src/orders/dispatcher';
import {
  claim,
  enqueue,
  OUTBOX_TOPICS,
  type OutboxEventRecord,
} from '../src/orders/outbox';

const ADDRESS = {
  fullName: 'Creator Example',
  streetAddress: '1 Test Street',
  addressLocality: 'Toronto',
  addressRegion: 'ON',
  postalCode: 'M5H 1A1',
  addressCountry: 'CA',
  phone: null,
};

const MERCHANT_ID = 'merchant_smoke';
const ITEMS = [{ sku: 'sku-smoke', quantity: 1 }];
const AMOUNT_MINOR = 1000;
const CURRENCY = 'CAD';

let slugCounter = 0;

interface Seeded {
  creatorId: string;
  fanOrderId: string;
  /** Re-quote the order against a different address, simulating a house move. */
  moveCreator: (postalCode: string) => Promise<void>;
}

async function seed(): Promise<Seeded> {
  slugCounter += 1;
  const creator = await prisma.creator.create({
    data: {
      displayName: 'Smoke Creator',
      publicSlug: `smoke-${Date.now()}-${slugCounter}`,
    },
  });

  const shipTo = toShipTo(ADDRESS);
  // Written through the store so the address is encrypted at rest (NFR-2.2).
  const address = await writeCreatorAddress(prisma, {
    creatorId: creator.id,
    ...ADDRESS,
    consentPolicyVersion: 'v1',
  });

  const bound: BoundRequest = {
    merchant_id: MERCHANT_ID,
    items: ITEMS,
    ship_to: shipTo,
    currency: CURRENCY,
    amount_minor: AMOUNT_MINOR,
    fulfillment_option_id: 'ship-standard',
  };

  const fanOrder = await prisma.fanOrder.create({
    data: {
      fanId: 'fan_smoke',
      creatorId: creator.id,
      state: 'authorized',
      fanTotalMinor: 1200,
      markupMinor: 200,
      merchantCapMinor: AMOUNT_MINOR,
      currency: CURRENCY,
      approvedAt: new Date(),
      approvedRequest: {
        create: {
          creatorAddressId: address.id,
          merchantId: MERCHANT_ID,
          items: ITEMS,
          currency: CURRENCY,
          amountMinor: AMOUNT_MINOR,
          fulfillmentOptionId: 'ship-standard',
          shipToDigest: computeShipToDigest(shipTo),
          requestDigest: computeRequestDigest(bound),
          fanApprovalText: 'yes, buy it',
          fanApprovedAtIso: new Date(),
        },
      },
    },
  });

  return {
    creatorId: creator.id,
    fanOrderId: fanOrder.id,
    moveCreator: async (postalCode: string) => {
      // Through the store, exactly as the creator's settings form would. A raw
      // update would write the new postal code unencrypted.
      await writeCreatorAddress(prisma, {
        creatorId: creator.id,
        ...ADDRESS,
        postalCode,
        consentPolicyVersion: 'v1',
      });
    },
  };
}

async function nextDispatchTask(fanOrderId: string): Promise<OutboxEventRecord> {
  const id = await prisma.$transaction((tx) =>
    enqueue(tx, OUTBOX_TOPICS.DISPATCH_MERCHANT_ORDER, { fanOrderId }),
  );
  const [claimed] = await claim(prisma, {
    workerId: 'smoke',
    limit: 1,
    topics: [OUTBOX_TOPICS.DISPATCH_MERCHANT_ORDER],
  });
  if (!claimed || claimed.id !== id) throw new Error('failed to claim the dispatch task');
  return claimed;
}

async function reset(creatorId: string): Promise<void> {
  await prisma.outboxEvent.deleteMany({});

  // Order matters here, and the foreign key is doing its job rather than getting
  // in the way: a creator with orders cannot be deleted, because their orders are
  // financial records. So tear down the orders first — which cascades to the
  // approved request, merchant order, payment ledger and timeline — then the
  // address (which the approved request referenced), then the creator.
  await prisma.fanOrder.deleteMany({ where: { creatorId } });
  await prisma.creatorAddress.deleteMany({ where: { creatorId } });
  await prisma.creator.delete({ where: { id: creatorId } });
}

const results: Array<{ scenario: string; outcome: string; dispatches: number; pass: boolean }> = [];

async function scenario(
  name: string,
  fake: FakeAgnic,
  options: {
    moveTo?: string;
    /**
     * How many times the provider SHOULD be asked to place the purchase.
     *
     * Not always 1: the whole point of the moved-house case is that the answer
     * is 0, because refusing to spend is the correct outcome there.
     */
    expectDispatches?: number;
    /** What a redelivered task should report the second time. */
    expectSecond?: 'already_claimed' | 'skipped';
  } = {},
): Promise<void> {
  const seeded = await seed();
  if (options.moveTo) await seeded.moveCreator(options.moveTo);

  const task = await nextDispatchTask(seeded.fanOrderId);
  const first = await runDispatchTask(
    { db: prisma, agnic: fake, workerId: 'worker-1' },
    task,
  );

  // Redeliver the identical task. This is the worker-died-after-the-call case.
  const second = await runDispatchTask(
    { db: prisma, agnic: fake, workerId: 'worker-2' },
    task,
  );

  const order = await prisma.fanOrder.findUniqueOrThrow({
    where: { id: seeded.fanOrderId },
    select: { state: true },
  });

  const dispatches = fake.countCalls('dispatch');
  const expectedDispatches = options.expectDispatches ?? 1;
  const expectedSecond = options.expectSecond ?? 'already_claimed';
  const pass = dispatches === expectedDispatches && second.kind === expectedSecond;

  results.push({
    scenario: name,
    outcome: `${first.kind} -> ${order.state} [redeliver: ${second.kind}]`,
    dispatches,
    pass,
  });

  await reset(seeded.creatorId);
}

await prisma.outboxEvent.deleteMany({});

await scenario('happy path', chaos.success());
await scenario('lost response', chaos.lostResponse());
await scenario('currency mismatch', chaos.currencyMismatch());
await scenario('creator moved house', chaos.success(), {
  moveTo: 'M5H 9Z9',
  // Nothing is spent: a destination that no longer matches what was approved
  // must stop the purchase, not be shipped to anyway.
  expectDispatches: 0,
  // And the order is already terminal, so a redelivery is simply skipped.
  expectSecond: 'skipped',
});

// ---------------------------------------------------------------------------
// Side effects the outcome should have produced
// ---------------------------------------------------------------------------

const seededPending = await seed();
const pendingTask = await nextDispatchTask(seededPending.fanOrderId);
await runDispatchTask(
  { db: prisma, agnic: chaos.success(), workerId: 'w' },
  pendingTask,
);
const pendingTopics = (
  await prisma.outboxEvent.findMany({ select: { topic: true } })
).map((r) => r.topic);
console.log('after a successful dispatch, queued:', pendingTopics);
const polled = pendingTopics.includes(OUTBOX_TOPICS.POLL_ORDER_STATUS);
await reset(seededPending.creatorId);

const seededFx = await seed();
const fxTask = await nextDispatchTask(seededFx.fanOrderId);
await runDispatchTask(
  { db: prisma, agnic: chaos.currencyMismatch(), workerId: 'w' },
  fxTask,
);
const fxTopics = (
  await prisma.outboxEvent.findMany({ select: { topic: true } })
).map((r) => r.topic);
// Only the claimed dispatch task should be present. Specifically, no approval
// poll: waiting cannot fix a mandate denominated in the wrong currency, so
// queueing one would leave the order looking stuck rather than misconfigured.
const fxQueuedPoll = fxTopics.includes(OUTBOX_TOPICS.POLL_APPROVAL);
console.log(
  'after a currency mismatch,     queued:',
  fxTopics,
  fxQueuedPoll ? '(APPROVAL POLL - wrong)' : '(no approval poll - correct)',
);
const fxStopped = !fxQueuedPoll;
await reset(seededFx.creatorId);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('\nscenario                outcome                                        dispatches  ok');
console.log('----------------------  ---------------------------------------------  ----------  --');
for (const r of results) {
  console.log(
    `${r.scenario.padEnd(22)}  ${r.outcome.padEnd(45)}  ${String(r.dispatches).padStart(10)}  ${r.pass ? 'yes' : 'NO'}`,
  );
}

const failures = [
  ...results.filter((r) => !r.pass).map((r) => `${r.scenario}: unexpected dispatch count or redelivery`),
  polled ? null : 'a successful dispatch did not queue a status poll',
  fxStopped ? null : 'a currency mismatch queued an approval poll (it would hang forever)',
].filter(Boolean);

await prisma.outboxEvent.deleteMany({});
await prisma.$disconnect();

console.log(
  `\n${failures.length === 0 ? 'Dispatch-once holds for every scenario.' : `FAILURES: ${failures.join('; ')}`}`,
);
