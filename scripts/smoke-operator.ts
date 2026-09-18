/**
 * Operator refund recording.
 *
 * The interesting cases are not the happy path. They are:
 *
 *   1. **A rail failure must not mark the order refunded.** The order is only
 *      moved once money has actually gone back, because an order marked refunded
 *      with the fan's money still held is the worst state this system can reach.
 *   2. **A hold is not a charge.** An order with no captured payment has nothing
 *      to refund, and conflating release with refund misreports whether the fan
 *      was ever charged.
 *   3. **The merchant reference is the guard on the transition.** Without it the
 *      FSM edge does not exist, so it cannot be taken by accident.
 */
import { prisma } from '../src/db/client';
import { recordRefund, resolveOrder } from '../src/orders/operator';
import { idempotencyKeyFor, FakePaymentProvider } from '../src/payments/port';

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass, detail });
}

let counter = 0;

type LedgerType = 'authorized' | 'captured' | 'released' | 'refunded';

/** An order already sitting in the state the refund logic has to reason about. */
async function seedOrder(state: string, ledger: LedgerType[]) {
  counter += 1;

  const creator = await prisma.creator.create({
    data: { displayName: 'Operator Creator', publicSlug: `operator-${Date.now()}-${counter}` },
  });

  const order = await prisma.fanOrder.create({
    data: {
      fanId: 'fan_operator',
      creatorId: creator.id,
      state: state as never,
      fanTotalMinor: 1200,
      markupMinor: 200,
      merchantCapMinor: 1000,
      currency: 'CAD',
    },
  });

  for (const type of ledger) {
    await prisma.paymentEvent.create({
      data: {
        fanOrderId: order.id,
        type,
        amountMinor: 1200,
        currency: 'CAD',
        providerRef: `ref_${type}_${counter}`,
      },
    });
  }

  return { creatorId: creator.id, fanOrderId: order.id };
}

async function reset(creatorId: string): Promise<void> {
  await prisma.outboxEvent.deleteMany({});
  await prisma.fanOrder.deleteMany({ where: { creatorId } });
  await prisma.creatorAddress.deleteMany({ where: { creatorId } });
  await prisma.wishlistItem.deleteMany({ where: { creatorId } });
  await prisma.creator.delete({ where: { id: creatorId } });
}

async function stateOf(fanOrderId: string): Promise<string> {
  const order = await prisma.fanOrder.findUniqueOrThrow({
    where: { id: fanOrderId },
    select: { state: true },
  });
  return order.state;
}

await prisma.outboxEvent.deleteMany({});

// ---------------------------------------------------------------------------
// 1. The happy path: captured money comes back
// ---------------------------------------------------------------------------

{
  const seed = await seedOrder('succeeded', ['authorized', 'captured']);
  const payments = new FakePaymentProvider();

  const result = await recordRefund(
    { db: prisma, payments },
    {
      fanOrderId: seed.fanOrderId,
      reference: 'SHOP-REF-88213',
      actor: 'operator',
      note: 'merchant refunded out of band',
    },
  );

  check('refund: recorded', result.state === 'recorded', result.state);

  check(
    'refund: order is refunded',
    (await stateOf(seed.fanOrderId)) === 'refunded',
    await stateOf(seed.fanOrderId),
  );

  const events = await prisma.paymentEvent.findMany({
    where: { fanOrderId: seed.fanOrderId },
    orderBy: { createdAt: 'asc' },
  });

  check(
    'refund: ledgered as refunded',
    events.some((e) => e.type === 'refunded'),
    events.map((e) => e.type).join(' -> '),
  );

  check(
    'refund: refunded the captured amount, not the fan total',
    events.find((e) => e.type === 'refunded')?.amountMinor === 1200,
    String(events.find((e) => e.type === 'refunded')?.amountMinor),
  );

  check(
    'refund: the rail was actually asked',
    payments.countOf('refund') === 1,
    `${payments.countOf('refund')} refund calls`,
  );

  const timeline = await prisma.orderEvent.findMany({
    where: { fanOrderId: seed.fanOrderId },
  });

  const note = timeline.find((e) => e.toState === 'refunded')?.note ?? '';
  const railRef = events.find((e) => e.type === 'refunded')?.providerRef;

  // Two different events on two different rails, both worth keeping: the
  // operator's merchant-side evidence, and the processor's fan-side reference.
  check(
    'refund: both references recorded',
    note.includes('SHOP-REF-88213') && typeof railRef === 'string' && railRef.length > 0,
    `merchant ref in timeline: ${note.includes('SHOP-REF-88213')}; rail ref in ledger: ${railRef ?? '(none)'}`,
  );

  await reset(seed.creatorId);
}

// ---------------------------------------------------------------------------
// 2. The rail refuses -- the order must NOT be marked refunded
// ---------------------------------------------------------------------------

{
  const seed = await seedOrder('succeeded', ['authorized', 'captured']);
  const payments = new FakePaymentProvider();

  // Stop the rail from giving the money back.
  payments.failures.set(idempotencyKeyFor('refund', seed.fanOrderId), {
    code: 'card_declined',
  });

  const result = await recordRefund(
    { db: prisma, payments },
    { fanOrderId: seed.fanOrderId, reference: 'SHOP-REF-99999', actor: 'operator' },
  );

  check('rail refused: reported as a failure', result.state === 'rail_failed', result.state);

  check(
    'rail refused: order is still succeeded, NOT refunded',
    (await stateOf(seed.fanOrderId)) === 'succeeded',
    await stateOf(seed.fanOrderId),
  );

  check(
    'rail refused: no refunded entry was written',
    (await prisma.paymentEvent.count({
      where: { fanOrderId: seed.fanOrderId, type: 'refunded' },
    })) === 0,
    'ledger untouched',
  );

  await reset(seed.creatorId);
}

// ---------------------------------------------------------------------------
// 3. A hold is not a charge
// ---------------------------------------------------------------------------

{
  const seed = await seedOrder('failed', ['authorized', 'released']);
  const payments = new FakePaymentProvider();

  const result = await recordRefund(
    { db: prisma, payments },
    { fanOrderId: seed.fanOrderId, reference: 'SHOP-REF-11111', actor: 'operator' },
  );

  check(
    'hold only: nothing to refund',
    result.state === 'nothing_to_refund',
    result.state,
  );

  check(
    'hold only: the rail was never asked to refund',
    payments.countOf('refund') === 0,
    `${payments.countOf('refund')} refund calls`,
  );

  check(
    'hold only: state unchanged',
    (await stateOf(seed.fanOrderId)) === 'failed',
    await stateOf(seed.fanOrderId),
  );

  await reset(seed.creatorId);
}

// ---------------------------------------------------------------------------
// 4. The reference is the guard, so it must be real
// ---------------------------------------------------------------------------

{
  const seed = await seedOrder('succeeded', ['authorized', 'captured']);
  const payments = new FakePaymentProvider();

  for (const [label, reference] of [
    ['empty', ''],
    ['whitespace', '   '],
    ['too short', 'ab'],
  ] as const) {
    const result = await recordRefund(
      { db: prisma, payments },
      { fanOrderId: seed.fanOrderId, reference, actor: 'operator' },
    );

    check(
      `reference ${label}: refused`,
      result.state === 'invalid_reference',
      result.state,
    );
  }

  check(
    'reference: nothing moved',
    (await stateOf(seed.fanOrderId)) === 'succeeded' && payments.countOf('refund') === 0,
    'state and rail untouched',
  );

  await reset(seed.creatorId);
}

// ---------------------------------------------------------------------------
// 5. States with no edge to `refunded`
// ---------------------------------------------------------------------------

{
  for (const state of ['processing', 'dispatching', 'authorized', 'draft']) {
    const seed = await seedOrder(state, ['authorized']);
    const payments = new FakePaymentProvider();

    const result = await recordRefund(
      { db: prisma, payments },
      { fanOrderId: seed.fanOrderId, reference: 'SHOP-REF-22222', actor: 'operator' },
    );

    check(
      `state ${state}: not refundable`,
      result.state === 'not_refundable' || result.state === 'nothing_to_refund',
      result.state,
    );

    await reset(seed.creatorId);
  }
}

// ---------------------------------------------------------------------------
// 6. Refunding twice
// ---------------------------------------------------------------------------

{
  const seed = await seedOrder('succeeded', ['authorized', 'captured']);
  const payments = new FakePaymentProvider();

  const first = await recordRefund(
    { db: prisma, payments },
    { fanOrderId: seed.fanOrderId, reference: 'SHOP-REF-33333', actor: 'operator' },
  );

  const second = await recordRefund(
    { db: prisma, payments },
    { fanOrderId: seed.fanOrderId, reference: 'SHOP-REF-33333', actor: 'operator' },
  );

  check('first refund recorded', first.state === 'recorded', first.state);
  check('second refund refused', second.state === 'already_refunded', second.state);

  check(
    'refunded exactly once on the rail',
    payments.countOf('refund') === 1,
    `${payments.countOf('refund')} refund calls`,
  );

  check(
    'exactly one refunded ledger entry',
    (await prisma.paymentEvent.count({
      where: { fanOrderId: seed.fanOrderId, type: 'refunded' },
    })) === 1,
    'one entry',
  );

  await reset(seed.creatorId);
}

// ---------------------------------------------------------------------------
// 7. Partially fulfilled also refunds, and a missing order is handled
// ---------------------------------------------------------------------------

{
  const seed = await seedOrder('partially_fulfilled', ['authorized', 'captured']);
  const payments = new FakePaymentProvider();

  const result = await recordRefund(
    { db: prisma, payments },
    { fanOrderId: seed.fanOrderId, reference: 'SHOP-REF-44444', actor: 'operator' },
  );

  check(
    'partially fulfilled: refunds the failed portion',
    result.state === 'recorded' && (await stateOf(seed.fanOrderId)) === 'refunded',
    result.state,
  );

  await reset(seed.creatorId);

  const missing = await recordRefund(
    { db: prisma, payments },
    { fanOrderId: 'does-not-exist', reference: 'SHOP-REF-55555', actor: 'operator' },
  );

  check('unknown order: handled', missing.state === 'order_not_found', missing.state);
}

// ---------------------------------------------------------------------------
// 8. Declaring an outcome the machine could not determine
// ---------------------------------------------------------------------------

// The fixture is authorized 1200 with a 200 fee, so the merchant may take up to
// 1000. A capture of merchant + fee must never exceed 1200.
{
  const seed = await seedOrder('processing', ['authorized']);
  const payments = new FakePaymentProvider();

  const result = await resolveOrder(
    { db: prisma, payments },
    {
      fanOrderId: seed.fanOrderId,
      decision: 'succeeded',
      reference: 'MERCHANT-DASH-4410',
      merchantChargedMinor: 950,
      actor: 'operator',
    },
  );

  check('resolve success: recorded', result.state === 'resolved', result.state);

  check(
    'resolve success: charged merchant figure plus the fee',
    result.state === 'resolved' && result.amountMinor === 1150,
    result.state === 'resolved' ? String(result.amountMinor) : result.state,
  );

  check(
    'resolve success: order is succeeded',
    (await stateOf(seed.fanOrderId)) === 'succeeded',
    await stateOf(seed.fanOrderId),
  );

  check(
    'resolve success: marked as operator-determined',
    (await prisma.orderEvent.findFirst({
      where: { fanOrderId: seed.fanOrderId, toState: 'succeeded' },
    }))?.note?.includes('MERCHANT-DASH-4410') === true,
    'evidence reference on the timeline',
  );

  await reset(seed.creatorId);
}

// --- a success needs the merchant's figure ---------------------------------

{
  const seed = await seedOrder('processing', ['authorized']);
  const payments = new FakePaymentProvider();

  const result = await resolveOrder(
    { db: prisma, payments },
    {
      fanOrderId: seed.fanOrderId,
      decision: 'succeeded',
      reference: 'MERCHANT-DASH-4411',
      merchantChargedMinor: null,
      actor: 'operator',
    },
  );

  check('resolve without amount: refused', result.state === 'amount_required', result.state);

  check(
    'resolve without amount: nothing was charged',
    payments.countOf('capture') === 0,
    `${payments.countOf('capture')} capture calls`,
  );

  check(
    'resolve without amount: order left alone',
    (await stateOf(seed.fanOrderId)) === 'processing',
    await stateOf(seed.fanOrderId),
  );

  await reset(seed.creatorId);
}

// --- and the cap still holds ------------------------------------------------

{
  const seed = await seedOrder('processing', ['authorized']);
  const payments = new FakePaymentProvider();

  // 1001 + 200 fee = 1201, one minor unit above what the fan authorised.
  const result = await resolveOrder(
    { db: prisma, payments },
    {
      fanOrderId: seed.fanOrderId,
      decision: 'succeeded',
      reference: 'MERCHANT-DASH-4412',
      merchantChargedMinor: 1001,
      actor: 'operator',
    },
  );

  check(
    'resolve above the cap: refused rather than over-charging',
    result.state === 'amount_invalid',
    result.state,
  );

  check(
    'resolve above the cap: the rail was never called',
    payments.countOf('capture') === 0,
    `${payments.countOf('capture')} capture calls`,
  );

  await reset(seed.creatorId);
}

// --- declaring a failure releases the hold ---------------------------------

{
  const seed = await seedOrder('uncertain', ['authorized']);
  const payments = new FakePaymentProvider();

  const result = await resolveOrder(
    { db: prisma, payments },
    {
      fanOrderId: seed.fanOrderId,
      decision: 'failed',
      reference: 'MERCHANT-DASH-4413',
      actor: 'operator',
      note: 'checked the dashboard: no order of ours',
    },
  );

  check('resolve failure: recorded', result.state === 'resolved', result.state);

  check(
    'resolve failure: order is failed',
    (await stateOf(seed.fanOrderId)) === 'failed',
    await stateOf(seed.fanOrderId),
  );

  check(
    'resolve failure: the hold was released',
    payments.countOf('release') === 1,
    `${payments.countOf('release')} release calls`,
  );

  check(
    'resolve failure: never captured',
    payments.countOf('capture') === 0,
    `${payments.countOf('capture')} capture calls`,
  );

  await reset(seed.creatorId);
}

// --- the books are not contradicted ----------------------------------------

{
  // Already charged. Marking this failed would tell the fan they were not
  // charged when they were; that is a refund, and a different action.
  const seed = await seedOrder('uncertain', ['authorized', 'captured']);
  const payments = new FakePaymentProvider();

  const result = await resolveOrder(
    { db: prisma, payments },
    {
      fanOrderId: seed.fanOrderId,
      decision: 'failed',
      reference: 'MERCHANT-DASH-4414',
      actor: 'operator',
    },
  );

  check(
    'an already-charged order cannot be failed',
    result.state === 'refused' && result.code === 'already_captured',
    result.state === 'refused' ? result.code : result.state,
  );

  check(
    'an already-charged order is not released',
    payments.countOf('release') === 0,
    `${payments.countOf('release')} release calls`,
  );

  await reset(seed.creatorId);
}

// --- and the rail refusing changes nothing ---------------------------------

{
  const seed = await seedOrder('processing', ['authorized']);
  const payments = new FakePaymentProvider();

  payments.failures.set(idempotencyKeyFor('capture', seed.fanOrderId), {
    code: 'card_declined',
  });

  const result = await resolveOrder(
    { db: prisma, payments },
    {
      fanOrderId: seed.fanOrderId,
      decision: 'succeeded',
      reference: 'MERCHANT-DASH-4415',
      merchantChargedMinor: 950,
      actor: 'operator',
    },
  );

  check('rail refuses the capture: reported', result.state === 'refused', result.state);

  check(
    'rail refuses the capture: order still processing, not succeeded',
    (await stateOf(seed.fanOrderId)) === 'processing',
    await stateOf(seed.fanOrderId),
  );

  check(
    'rail refuses the capture: no captured entry written',
    (await prisma.paymentEvent.count({
      where: { fanOrderId: seed.fanOrderId, type: 'captured' },
    })) === 0,
    'ledger untouched',
  );

  await reset(seed.creatorId);
}

// --- only the states the machine has stopped on ---------------------------

{
  for (const state of ['draft', 'succeeded', 'refunded', 'authorized']) {
    const seed = await seedOrder(state, ['authorized']);
    const payments = new FakePaymentProvider();

    const result = await resolveOrder(
      { db: prisma, payments },
      {
        fanOrderId: seed.fanOrderId,
        decision: 'failed',
        reference: 'MERCHANT-DASH-4416',
        actor: 'operator',
      },
    );

    check(
      `${state} cannot be resolved by an operator`,
      result.state === 'not_resolvable' || result.state === 'refused',
      result.state,
    );

    await reset(seed.creatorId);
  }

  // And the reference is still the guard.
  const seed = await seedOrder('processing', ['authorized']);
  const payments = new FakePaymentProvider();

  for (const reference of ['', '  ', 'ab']) {
    const result = await resolveOrder(
      { db: prisma, payments },
      {
        fanOrderId: seed.fanOrderId,
        decision: 'failed',
        reference,
        actor: 'operator',
      },
    );

    check(`resolve reference "${reference}": refused`, result.state === 'invalid_reference', result.state);
  }

  check(
    'resolve with no valid reference: nothing moved',
    payments.calls.length === 0,
    `${payments.calls.length} rail calls`,
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
