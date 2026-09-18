/**
 * Proves a spending-cap breach is handled safely at both points it can occur.
 *
 * The cap can bite in two different places, and they need different handling:
 *
 *   - At PRICING. Nothing exists yet, so the honest response is to say so and
 *     create no order at all.
 *   - At DISPATCH, after the fan already approved and we already hold their
 *     money. Now there is a hold to unwind, and the danger is releasing it on an
 *     order that actually charged.
 *
 * The second case is the one worth testing hardest, because an order refused
 * after approval is indistinguishable from an order refused before it unless
 * the evidence is read correctly.
 *
 * Also checks the pairing that makes the refusal safe: a cap breach is only
 * releasable when nothing was charged.
 */
import { chaos, FakeAgnic } from '../src/agnic/fake';
import { toShipTo } from '../src/agnic/port';
import { prisma } from '../src/db/client';
import { computeRequestDigest, computeShipToDigest, type BoundRequest } from '../src/fulfillment/binding';
import { writeCreatorAddress } from '../src/fulfillment/address-store';
import { priceWishlistItem } from '../src/orders/checkout';
import { enqueue, OUTBOX_TOPICS } from '../src/orders/outbox';
import { drainOnce, type TaskReport } from '../src/orders/worker';
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

async function seedCreatorWithItem() {
  counter += 1;
  const creator = await prisma.creator.create({
    data: { displayName: 'Cap Creator', publicSlug: `cap-${Date.now()}-${counter}` },
  });

  const shipTo = toShipTo(ADDRESS);
  // Written through the store so the address is encrypted at rest (NFR-2.2).
  const address = await writeCreatorAddress(prisma, {
    creatorId: creator.id,
    ...ADDRESS,
    consentPolicyVersion: 'v1',
  });

  const item = await prisma.wishlistItem.create({
    data: {
      creatorId: creator.id,
      merchantId: 'merchant_cap',
      merchantName: 'Cap Shop',
      sku: 'sku-cap',
      title: 'Capped Item',
      currency: 'CAD',
    },
  });

  return { creatorId: creator.id, addressId: address.id, itemId: item.id };
}

async function seedAuthorizedOrder(creatorId: string) {
  const bound: BoundRequest = {
    merchant_id: 'merchant_cap',
    items: [{ sku: 'sku-cap', quantity: 1 }],
    ship_to: toShipTo(ADDRESS),
    currency: 'CAD',
    amount_minor: 1000,
    // Must be on `bound` as well as the row: the digest covers the whole
    // request, and `rebuildBoundRequest` reads constraints back out of the row.
    // Omitting it here makes the bind guard refuse the order before dispatch.
    constraints: { max_total_minor: 1000 },
    fulfillment_option_id: 'ship-standard',
  };

  const address = await prisma.creatorAddress.findFirstOrThrow({ where: { creatorId } });

  const fanOrder = await prisma.fanOrder.create({
    data: {
      fanId: 'fan_cap',
      creatorId,
      state: 'authorized',
      fanTotalMinor: 1200,
      markupMinor: 200,
      merchantCapMinor: 1000,
      currency: 'CAD',
      approvedAt: new Date(),
      approvedRequest: {
        create: {
          creatorAddressId: address.id,
          merchantId: 'merchant_cap',
          items: bound.items,
          currency: 'CAD',
          amountMinor: 1000,
          fulfillmentOptionId: 'ship-standard',
          shipToDigest: computeShipToDigest(bound.ship_to),
          requestDigest: computeRequestDigest(bound),
          fanApprovalText: 'yes please',
          fanApprovedAtIso: new Date(),
          // The production cap: the approved amount, so a rise is refused.
          constraints: { max_total_minor: 1000 },
        },
      },
    },
  });

  await prisma.$transaction((tx) =>
    enqueue(tx, OUTBOX_TOPICS.DISPATCH_MERCHANT_ORDER, { fanOrderId: fanOrder.id }),
  );

  return fanOrder.id;
}

async function reset(creatorId: string): Promise<void> {
  await prisma.outboxEvent.deleteMany({});
  await prisma.fanOrder.deleteMany({ where: { creatorId } });
  await prisma.quote.deleteMany({ where: { wishlistItem: { creatorId } } });
  await prisma.wishlistItem.deleteMany({ where: { creatorId } });
  await prisma.creatorAddress.deleteMany({ where: { creatorId } });
  await prisma.creator.delete({ where: { id: creatorId } });
}

await prisma.outboxEvent.deleteMany({});

// ---------------------------------------------------------------------------
// 1. Cap breached at pricing: no order should exist afterwards
// ---------------------------------------------------------------------------

{
  const seed = await seedCreatorWithItem();
  const agnic = chaos.capExceeded();

  const outcome = await priceWishlistItem(
    { db: prisma, agnic, markupPercent: 20 },
    { creatorId: seed.creatorId, wishlistItemId: seed.itemId },
  );

  check(
    'pricing: cap breach surfaces as a refusal',
    outcome.state === 'refused',
    outcome.state,
  );

  check(
    'pricing: refusal carries the provider code',
    outcome.state === 'refused' && outcome.code === 'constraint_violated',
    outcome.state === 'refused' ? outcome.code : '(not refused)',
  );

  check(
    'pricing: no order was created',
    (await prisma.fanOrder.count({ where: { creatorId: seed.creatorId } })) === 0,
    'zero orders',
  );

  await reset(seed.creatorId);
}

// ---------------------------------------------------------------------------
// 2. Cap breached after approval: the hold must come back, exactly once
// ---------------------------------------------------------------------------

{
  const seed = await seedCreatorWithItem();
  await seedAuthorizedOrder(seed.creatorId);
  const payments = new FakePaymentProvider();

  // Approved at 1000; by dispatch the shop wants more, so it refuses the
  // freshly built cart. The refusal still carries an order id, so the outcome
  // is knowable rather than a guess.
  const agnic = chaos.priceChanged();

  const deps = { db: prisma, agnic, payments, workerId: 'cap-worker' };
  const reports = await drainToQuiescence(deps);

  const order = await prisma.fanOrder.findFirstOrThrow({
    where: { creatorId: seed.creatorId },
    include: { paymentEvents: true, merchantOrder: true },
  });

  check(
    'dispatch: order ends failed, not stuck',
    order.state === 'failed',
    `${order.state} (${reports.map((r) => r.result).join(' -> ')})`,
  );

  check(
    'dispatch: the hold was released',
    order.paymentEvents.some((e) => e.type === 'released'),
    order.paymentEvents.map((e) => e.type).join(',') || '(empty)',
  );

  check(
    'dispatch: released exactly once',
    payments.countOf('release') === 1,
    `${payments.countOf('release')} release calls`,
  );

  check(
    'dispatch: never captured',
    payments.countOf('capture') === 0,
    `${payments.countOf('capture')} capture calls`,
  );

  check(
    'dispatch: never retried against the same cap',
    agnic.countCalls('dispatch') === 1,
    `${agnic.countCalls('dispatch')} dispatch calls`,
  );

  check(
    'dispatch: the refusal reason was recorded',
    order.merchantOrder?.errorCode === 'shopify_amount_changed',
    order.merchantOrder?.errorCode ?? '(none)',
  );

  await reset(seed.creatorId);
}

// ---------------------------------------------------------------------------
// 3. The asymmetry: a refusal WITHOUT clean evidence must not release
// ---------------------------------------------------------------------------

{
  const seed = await seedCreatorWithItem();
  await seedAuthorizedOrder(seed.creatorId);
  const payments = new FakePaymentProvider();

  // The order reports an unreadable money state. This is the dangerous case:
  // if we released here and the charge had actually gone through, the fan would
  // have both paid and had their hold returned.
  const agnic = chaos.unknownMoneyState();

  const deps = { db: prisma, agnic, payments, workerId: 'cap-worker' };
  await drainToQuiescence(deps);

  check(
    'unreadable money state: nothing was released',
    payments.countOf('release') === 0,
    `${payments.countOf('release')} release calls`,
  );

  check(
    'unreadable money state: nothing was captured',
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
