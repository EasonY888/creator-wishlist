/**
 * What the fan is charged.
 *
 * A fan approves a CEILING (FR-3.8). On the live sandbox the quote returned
 * `charge_estimate_minor: 1300` and `charge_cap_minor: 1495`, and the merchant
 * charged 1300. We held 1794 and -- until this changed -- captured all 1794, so
 * the fan paid the worst case every time while the receipt showed a $2.99 fee we
 * did not actually keep.
 *
 * Two halves:
 *
 *   1. The decision itself, purely.
 *   2. The same decision driven through the real reconciler, because a pure
 *      function that the caller ignores is not a fix.
 */
import { FakeAgnic } from '../src/agnic/fake';
import { prisma } from '../src/db/client';
import { fanChargeFor } from '../src/domain/charge';
import { enqueue, OUTBOX_TOPICS, type OutboxEventRecord } from '../src/orders/outbox';
import { runReconcileTask } from '../src/orders/reconciler';
import { FakePaymentProvider } from '../src/payments/port';

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass, detail });
}

// ---------------------------------------------------------------------------
// 1. The decision, in isolation
// ---------------------------------------------------------------------------

{
  // The exact figures from the live order: ceiling 1495 + fee 299 = 1794
  // authorised; the merchant charged 1300.
  const live = fanChargeFor({
    merchantChargedMinor: 1300,
    markupMinor: 299,
    authorizedMinor: 1794,
  });

  check(
    'live figures: charges the real cost plus the fee shown',
    live.state === 'charge' && live.amountMinor === 1599,
    live.state === 'charge' ? String(live.amountMinor) : live.state,
  );

  check(
    'live figures: under-charges the fan by the unused headroom',
    live.state === 'charge' && 1794 - live.amountMinor === 195,
    live.state === 'charge' ? `saved ${1794 - live.amountMinor}` : '-',
  );

  // The merchant using its whole allowance is not a problem, and must not block.
  const full = fanChargeFor({
    merchantChargedMinor: 1495,
    markupMinor: 299,
    authorizedMinor: 1794,
  });

  check(
    'full allowance: charges exactly what was authorised',
    full.state === 'charge' && full.amountMinor === 1794,
    full.state === 'charge' ? String(full.amountMinor) : full.state,
  );

  // The honest refusal. Guessing here is the exact behaviour being removed.
  const unknown = fanChargeFor({
    merchantChargedMinor: null,
    markupMinor: 299,
    authorizedMinor: 1794,
  });

  check(
    'unknown charged amount: blocks rather than guessing',
    unknown.state === 'blocked' && unknown.code === 'merchant_amount_unknown',
    unknown.state === 'blocked' ? unknown.code : `state ${unknown.state}`,
  );

  const undefinedAmount = fanChargeFor({
    merchantChargedMinor: undefined,
    markupMinor: 299,
    authorizedMinor: 1794,
  });

  check(
    'undefined charged amount: blocks too',
    undefinedAmount.state === 'blocked',
    undefinedAmount.state,
  );

  // The cap assertion. Should be unreachable, asserted because the consequence is
  // charging more than the fan agreed to.
  const over = fanChargeFor({
    merchantChargedMinor: 5000,
    markupMinor: 299,
    authorizedMinor: 1794,
  });

  check(
    'cap breached: blocks rather than over-charging',
    over.state === 'blocked' && over.code === 'exceeds_authorization',
    over.state === 'blocked' ? over.code : `charged ${over.state === 'charge' ? over.amountMinor : '?'}`,
  );

  const negatives: Array<[string, number, number]> = [
    ['negative merchant amount', -100, 299],
    ['negative fee', 1300, -50],
  ];

  for (const [label, charged, markup] of negatives) {
    const result = fanChargeFor({
      merchantChargedMinor: charged,
      markupMinor: markup,
      authorizedMinor: 1794,
    });

    check(
      `${label}: blocks`,
      result.state === 'blocked',
      result.state === 'blocked' ? result.code : `charged ${result.state === 'charge' ? result.amountMinor : '?'}`,
    );
  }

  // A zero fee is legitimate -- a free platform tier.
  const noFee = fanChargeFor({
    merchantChargedMinor: 1300,
    markupMinor: 0,
    authorizedMinor: 1300,
  });

  check(
    'zero fee: allowed',
    noFee.state === 'charge' && noFee.amountMinor === 1300,
    noFee.state === 'charge' ? String(noFee.amountMinor) : noFee.state,
  );
}

// ---------------------------------------------------------------------------
// 2. Through the real reconciler
// ---------------------------------------------------------------------------

let counter = 0;

/**
 * An order that already reached the merchant, so the reconciler owns it.
 *
 * Deliberately matches the live figures: authorised 1794, of which 299 is our fee.
 */
async function seedDispatchedOrder() {
  counter += 1;

  const creator = await prisma.creator.create({
    data: { displayName: 'Charge Creator', publicSlug: `charge-${Date.now()}-${counter}` },
  });

  const order = await prisma.fanOrder.create({
    data: {
      fanId: 'fan_charge',
      creatorId: creator.id,
      state: 'processing',
      fanTotalMinor: 1794,
      markupMinor: 299,
      merchantCapMinor: 1495,
      currency: 'CAD',
    },
  });

  const providerOrderId = `af_ord_charge_${counter}_${Date.now()}`;

  await prisma.merchantOrder.create({
    data: {
      fanOrderId: order.id,
      providerOrderId,
      statusRaw: 'dispatched',
      amountApprovedMinor: 1495,
    },
  });

  // The hold happened at approval, so the ledger already carries it.
  await prisma.paymentEvent.create({
    data: {
      fanOrderId: order.id,
      type: 'authorized',
      amountMinor: 1794,
      currency: 'CAD',
      providerRef: `pi_charge_${counter}`,
    },
  });

  await prisma.$transaction((tx) =>
    enqueue(tx, OUTBOX_TOPICS.POLL_ORDER_STATUS, { fanOrderId: order.id }),
  );

  // Read the row back: `enqueue` does not hand it over, and the reconciler wants
  // the persisted record rather than a hand-made shape.
  const task = await prisma.outboxEvent.findFirstOrThrow({
    where: { topic: OUTBOX_TOPICS.POLL_ORDER_STATUS },
    orderBy: { createdAt: 'desc' },
  });

  return { creatorId: creator.id, fanOrderId: order.id, providerOrderId, task };
}

async function reset(creatorId: string): Promise<void> {
  await prisma.outboxEvent.deleteMany({});
  await prisma.fanOrder.deleteMany({ where: { creatorId } });
  await prisma.creatorAddress.deleteMany({ where: { creatorId } });
  await prisma.wishlistItem.deleteMany({ where: { creatorId } });
  await prisma.creator.delete({ where: { id: creatorId } });
}

await prisma.outboxEvent.deleteMany({});

// --- the merchant charged less, so the fan pays less ------------------------

{
  const seed = await seedDispatchedOrder();
  const payments = new FakePaymentProvider();

  const agnic = new FakeAgnic({
    orders: {
      [seed.providerOrderId]: {
        status: 'succeeded',
        retryable: false,
        retry_action: 'none',
        amount_charged_minor: 1300,
        evidence: { charge_state: 'confirmed' },
      },
    },
  });

  const outcome = await runReconcileTask(
    { db: prisma, agnic, payments, workerId: 'charge-worker' },
    seed.task as unknown as OutboxEventRecord,
  );

  check(
    'reconciler: captures actual + fee, not the ceiling',
    outcome.kind === 'captured' && outcome.amountMinor === 1599,
    outcome.kind === 'captured' ? String(outcome.amountMinor) : outcome.kind,
  );

  check(
    'reconciler: the rail was asked for 1599',
    payments.calls.find((c) => c.op === 'capture')?.input.amountMinor === 1599,
    String(payments.calls.find((c) => c.op === 'capture')?.input.amountMinor),
  );

  const ledger = await prisma.paymentEvent.findMany({
    where: { fanOrderId: seed.fanOrderId },
    orderBy: { createdAt: 'asc' },
  });

  check(
    'reconciler: the ledger records the real charge',
    ledger.find((e) => e.type === 'captured')?.amountMinor === 1599,
    ledger.map((e) => `${e.type}:${e.amountMinor}`).join(' -> '),
  );

  const timeline = await prisma.orderEvent.findMany({ where: { fanOrderId: seed.fanOrderId } });
  const note = timeline.find((e) => e.toState === 'succeeded')?.note ?? '';

  check(
    'reconciler: the timeline explains both figures',
    note.includes('1300') && note.includes('1599'),
    note || '(no note)',
  );

  await reset(seed.creatorId);
}

// --- the provider never said what was charged, so nobody is charged ---------

{
  const seed = await seedDispatchedOrder();
  const payments = new FakePaymentProvider();

  const agnic = new FakeAgnic({
    orders: {
      [seed.providerOrderId]: {
        status: 'succeeded',
        retryable: false,
        retry_action: 'none',
        evidence: { charge_state: 'confirmed' },
        // Explicitly null, not merely absent: the fake reports a charged amount
        // on settled orders, so this has to be scripted to model a provider that
        // omitted it.
        amount_charged_minor: null,
      },
    },
  });

  const outcome = await runReconcileTask(
    { db: prisma, agnic, payments, workerId: 'charge-worker' },
    seed.task as unknown as OutboxEventRecord,
  );

  check(
    'unknown amount: handed to a person',
    outcome.kind === 'needs_human',
    outcome.kind,
  );

  check(
    'unknown amount: NOTHING was captured',
    payments.countOf('capture') === 0,
    `${payments.countOf('capture')} capture calls`,
  );

  const order = await prisma.fanOrder.findUniqueOrThrow({
    where: { id: seed.fanOrderId },
    select: { state: true },
  });

  check(
    'unknown amount: order left in processing, not marked succeeded',
    order.state === 'processing',
    order.state,
  );

  const timeline = await prisma.orderEvent.findMany({ where: { fanOrderId: seed.fanOrderId } });
  const blocked = timeline.find((e) => (e.note ?? '').includes('capture blocked'));

  check(
    'unknown amount: the reason is on the timeline for an operator',
    blocked !== undefined,
    blocked?.note?.slice(0, 80) ?? '(no entry)',
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
