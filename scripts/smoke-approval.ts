/**
 * Proves the approval-continuation path, including the two cases that must
 * behave differently from each other.
 *
 * The important assertions here are not "it retried" but:
 *
 *   1. A CVV refresh DOES resume, and dispatches a second time — the single
 *      sanctioned exception to the dispatch-once rule.
 *   2. A currency mismatch does NOT resume and does NOT queue a poll. Waiting
 *      cannot fix it, so polling would present a configuration fault as a stuck
 *      order.
 *   3. An expired approval releases the hold, because a 202 means nothing was
 *      ever placed.
 */
import { FakeAgnic } from '../src/agnic/fake';
import { toShipTo } from '../src/agnic/port';
import { prisma } from '../src/db/client';
import { computeRequestDigest, computeShipToDigest, type BoundRequest } from '../src/fulfillment/binding';
import { writeCreatorAddress } from '../src/fulfillment/address-store';
import { drainOnce, type TaskReport } from '../src/orders/worker';
import { enqueue, OUTBOX_TOPICS } from '../src/orders/outbox';
import { FakePaymentProvider } from '../src/payments/port';

const ADDRESS = {
  fullName: 'Creator Example',
  streetAddress: '1 Test Street',
  addressLocality: 'Toronto',
  addressRegion: 'ON',
  postalCode: 'M5H 1A1',
  addressCountry: 'CA',
  phone: null,
};

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass, detail });
}

async function makeAllTasksDue(): Promise<void> {
  await prisma.$executeRaw`update "OutboxEvent" set "availableAt" = now() where status = 'pending'`;
}

async function drainToQuiescence(
  deps: Parameters<typeof drainOnce>[0],
  maxRounds = 20,
): Promise<TaskReport[]> {
  const reports: TaskReport[] = [];
  for (let round = 0; round < maxRounds; round += 1) {
    await makeAllTasksDue();
    const result = await drainOnce(deps, { limit: 10 });
    reports.push(...result.reports);
    if (result.claimed === 0) break;
  }
  return reports;
}

let counter = 0;

async function seedAuthorizedOrder(): Promise<{ creatorId: string; fanOrderId: string }> {
  counter += 1;
  const creator = await prisma.creator.create({
    data: { displayName: 'Approval Creator', publicSlug: `approval-${Date.now()}-${counter}` },
  });

  const shipTo = toShipTo(ADDRESS);
  // Written through the store so the address is encrypted at rest (NFR-2.2).
  const address = await writeCreatorAddress(prisma, {
    creatorId: creator.id,
    ...ADDRESS,
    consentPolicyVersion: 'v1',
  });

  const bound: BoundRequest = {
    merchant_id: 'merchant_approval',
    items: [{ sku: 'sku-approval', quantity: 1 }],
    ship_to: shipTo,
    currency: 'CAD',
    amount_minor: 1000,
    fulfillment_option_id: 'ship-standard',
  };

  const fanOrder = await prisma.fanOrder.create({
    data: {
      fanId: 'fan_approval',
      creatorId: creator.id,
      state: 'authorized',
      fanTotalMinor: 1200,
      markupMinor: 200,
      merchantCapMinor: 1000,
      currency: 'CAD',
      approvedAt: new Date(),
      approvedRequest: {
        create: {
          creatorAddressId: address.id,
          merchantId: 'merchant_approval',
          items: bound.items,
          currency: 'CAD',
          amountMinor: 1000,
          fulfillmentOptionId: 'ship-standard',
          shipToDigest: computeShipToDigest(shipTo),
          requestDigest: computeRequestDigest(bound),
          fanApprovalText: 'yes please',
          fanApprovedAtIso: new Date(),
        },
      },
    },
  });

  await prisma.$transaction((tx) =>
    enqueue(tx, OUTBOX_TOPICS.DISPATCH_MERCHANT_ORDER, { fanOrderId: fanOrder.id }),
  );

  return { creatorId: creator.id, fanOrderId: fanOrder.id };
}

async function reset(creatorId: string): Promise<void> {
  await prisma.outboxEvent.deleteMany({});
  await prisma.fanOrder.deleteMany({ where: { creatorId } });
  await prisma.creatorAddress.deleteMany({ where: { creatorId } });
  await prisma.creator.delete({ where: { id: creatorId } });
}

await prisma.outboxEvent.deleteMany({});

// ---------------------------------------------------------------------------
// 1. CVV refresh: pending, then approved, then resumed
// ---------------------------------------------------------------------------

{
  const seed = await seedAuthorizedOrder();
  const payments = new FakePaymentProvider();

  const agnic = new FakeAgnic({
    dispatch: [
      {
        state: 'approval_required',
        token: 'tok_cvv',
        approvalUrl: 'https://example.invalid/approve',
        expiresInSeconds: 300,
        reason: 'cvv_refresh_required',
      },
      // The resumption. Only reachable because an approval was granted.
      { state: 'poll', orderId: 'ord_cvv' },
    ],
    approvals: { tok_cvv: [{ state: 'pending' }, { state: 'approved' }] },
    orders: {
      ord_cvv: [
        { status: 'dispatched', retryable: null, retry_action: 'poll' },
        {
          status: 'succeeded',
          retryable: false,
          retry_action: 'none',
          evidence: { charge_state: 'captured' },
        },
      ],
    },
  });

  const deps = { db: prisma, agnic, payments, workerId: 'approval-worker' };
  const reports = await drainToQuiescence(deps);

  const order = await prisma.fanOrder.findUniqueOrThrow({
    where: { id: seed.fanOrderId },
    include: { merchantOrder: true, paymentEvents: true },
  });

  check(
    'cvv refresh: order succeeds',
    order.state === 'succeeded',
    `${order.state} (${reports.map((r) => r.result).join(' -> ')})`,
  );

  check(
    'cvv refresh: dispatched a second time (the sanctioned exception)',
    agnic.countCalls('dispatch') === 2,
    `${agnic.countCalls('dispatch')} dispatch calls`,
  );

  check(
    'cvv refresh: approval window consumed exactly once',
    (await prisma.approvalWindow.count({
      where: { fanOrderId: seed.fanOrderId, consumedAt: { not: null } },
    })) === 1,
    'consumedAt set on exactly one window',
  );

  check(
    'cvv refresh: charged our total, not the merchant figure',
    payments.calls.find((c) => c.op === 'capture')?.input.amountMinor === 1200,
    `captured ${payments.calls.find((c) => c.op === 'capture')?.input.amountMinor}`,
  );

  await reset(seed.creatorId);
}

// ---------------------------------------------------------------------------
// 2. Currency mismatch: permanent, must not poll
// ---------------------------------------------------------------------------

{
  const seed = await seedAuthorizedOrder();
  const payments = new FakePaymentProvider();

  const agnic = new FakeAgnic({
    dispatch: {
      state: 'approval_required',
      token: 'tok_fx',
      approvalUrl: 'https://example.invalid/approve',
      expiresInSeconds: 300,
      reason: 'currency_mismatch',
    },
  });

  const deps = { db: prisma, agnic, payments, workerId: 'approval-worker' };
  await drainToQuiescence(deps, 8);

  const order = await prisma.fanOrder.findUniqueOrThrow({
    where: { id: seed.fanOrderId },
    select: { state: true },
  });

  const queued = await prisma.outboxEvent.groupBy({
    by: ['topic'],
    _count: { _all: true },
  });
  const polled = queued.some((row) => row.topic === OUTBOX_TOPICS.POLL_APPROVAL);

  check(
    'currency mismatch: order stays awaiting approval',
    order.state === 'approval_required',
    order.state,
  );

  check(
    'currency mismatch: NO approval poll queued',
    !polled,
    polled ? 'a poll was queued - it would hang forever' : 'none queued',
  );

  check(
    'currency mismatch: dispatched exactly once',
    agnic.countCalls('dispatch') === 1,
    `${agnic.countCalls('dispatch')} dispatch calls`,
  );

  check(
    'currency mismatch: no money moved',
    payments.calls.length === 0,
    `${payments.calls.length} payment calls`,
  );

  await reset(seed.creatorId);
}

// ---------------------------------------------------------------------------
// 3. Expired approval: nothing was placed, so release the hold
// ---------------------------------------------------------------------------

{
  const seed = await seedAuthorizedOrder();
  const payments = new FakePaymentProvider();

  const agnic = new FakeAgnic({
    dispatch: [
      {
        state: 'approval_required',
        token: 'tok_exp',
        approvalUrl: 'https://example.invalid/approve',
        expiresInSeconds: 300,
        reason: 'cvv_refresh_required',
      },
    ],
    approvals: { tok_exp: { state: 'pending' } },
  });

  const deps = { db: prisma, agnic, payments, workerId: 'approval-worker' };

  // First pass: dispatch, then the approval poll runs and re-queues itself.
  await drainToQuiescence(deps, 4);

  // Now let the window lapse the way it would if nobody acted.
  await prisma.approvalWindow.updateMany({
    where: { fanOrderId: seed.fanOrderId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  await drainToQuiescence(deps, 6);

  const order = await prisma.fanOrder.findUniqueOrThrow({
    where: { id: seed.fanOrderId },
    include: { paymentEvents: true },
  });

  check(
    'expired approval: order fails',
    order.state === 'failed',
    order.state,
  );

  check(
    'expired approval: hold released',
    order.paymentEvents.some((e) => e.type === 'released'),
    order.paymentEvents.map((e) => e.type).join(',') || '(empty)',
  );

  check(
    'expired approval: never dispatched twice',
    agnic.countCalls('dispatch') === 1,
    `${agnic.countCalls('dispatch')} dispatch calls`,
  );

  check(
    'expired approval: never captured',
    payments.countOf('capture') === 0,
    `${payments.countOf('capture')} capture calls`,
  );

  await reset(seed.creatorId);
}

// ---------------------------------------------------------------------------

const width = Math.max(...checks.map((c) => c.name.length));
console.log('');
for (const c of checks) {
  console.log(`${c.name.padEnd(width)}  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.detail}`);
}

const failures = checks.filter((c) => !c.pass);
await prisma.outboxEvent.deleteMany({});
await prisma.$disconnect();

console.log(
  `\n${failures.length === 0 ? `All ${checks.length} checks passed.` : `${failures.length} of ${checks.length} FAILED.`}`,
);
