/**
 * End-to-end proof of the whole backend pipeline, with no Agnic credentials and
 * no payment account.
 *
 * Seeds an approved order, then drains the real worker loop until nothing is
 * left to do, asserting what the fan's money ends up as. The worker, outbox,
 * dispatcher, reconciler and ledger are all the real implementations; only the
 * two external providers are fakes.
 *
 * The assertion worth reading closely is the captured amount on the happy path.
 * The fan is charged what the MERCHANT actually took plus the fee they were
 * shown -- NOT the ceiling they approved. The quote carries headroom for tax the
 * merchant often does not apply, so the two figures legitimately differ, and the
 * difference stays with the fan.
 */
import { chaos } from '../src/agnic/fake';
import type { FakeAgnic } from '../src/agnic/fake';
import { toShipTo } from '../src/agnic/port';
import { prisma } from '../src/db/client';
import { writeCreatorAddress } from '../src/fulfillment/address-store';
import {
  computeRequestDigest,
  computeShipToDigest,
  type BoundRequest,
} from '../src/fulfillment/binding';
import { FakePaymentProvider } from '../src/payments/port';
import { drainOnce, type TaskReport } from '../src/orders/worker';
import { enqueue, OUTBOX_TOPICS } from '../src/orders/outbox';

const ADDRESS = {
  fullName: 'Creator Example',
  streetAddress: '1 Test Street',
  addressLocality: 'Toronto',
  addressRegion: 'ON',
  postalCode: 'M5H 1A1',
  addressCountry: 'CA',
  phone: null,
};

const MERCHANT_AMOUNT = 1000;
const MARKUP = 200;
const FAN_TOTAL = MERCHANT_AMOUNT + MARKUP;
/**
 * What `chaos.success()` reports the merchant actually took, against its own
 * 1000 ceiling. Deliberately below, because that is what the live sandbox did:
 * the quote carried headroom for tax the merchant never applied.
 */
const MERCHANT_CHARGED_LESS = 950;
/** Merchant's real charge plus the fee the fan was shown. */
const EXPECTED_CAPTURE = MERCHANT_CHARGED_LESS + MARKUP;
const CURRENCY = 'CAD';

let slugCounter = 0;

async function seedAuthorizedOrder(): Promise<{ creatorId: string; fanOrderId: string }> {
  slugCounter += 1;
  const creator = await prisma.creator.create({
    data: {
      displayName: 'Pipeline Creator',
      publicSlug: `pipeline-${Date.now()}-${slugCounter}`,
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
    merchant_id: 'merchant_pipeline',
    items: [{ sku: 'sku-pipeline', quantity: 1 }],
    ship_to: shipTo,
    currency: CURRENCY,
    amount_minor: MERCHANT_AMOUNT,
    fulfillment_option_id: 'ship-standard',
  };

  const fanOrder = await prisma.fanOrder.create({
    data: {
      fanId: 'fan_pipeline',
      creatorId: creator.id,
      state: 'authorized',
      fanTotalMinor: FAN_TOTAL,
      markupMinor: MARKUP,
      merchantCapMinor: MERCHANT_AMOUNT,
      currency: CURRENCY,
      approvedAt: new Date(),
      approvedRequest: {
        create: {
          creatorAddressId: address.id,
          merchantId: 'merchant_pipeline',
          items: bound.items,
          currency: CURRENCY,
          amountMinor: MERCHANT_AMOUNT,
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

/**
 * Make every scheduled task due now.
 *
 * A real worker waits for backoff. The pipeline polls on a ~3s delay so an order
 * can settle, and honouring that here would make the suite take minutes. This
 * compresses time without changing the logic under test — the delays themselves
 * are verified separately in the outbox smoke.
 */
async function makeAllTasksDue(): Promise<void> {
  await prisma.$executeRaw`update "OutboxEvent" set "availableAt" = now() where status = 'pending'`;
}

async function runToQuiescence(deps: Parameters<typeof drainOnce>[0]): Promise<TaskReport[]> {
  const reports: TaskReport[] = [];

  for (let round = 0; round < 25; round += 1) {
    await makeAllTasksDue();
    const result = await drainOnce(deps, { limit: 10 });
    reports.push(...result.reports);
    if (result.claimed === 0) break;
  }

  return reports;
}

interface Check {
  name: string;
  expectation: string;
  actual: string;
  pass: boolean;
}

const allChecks: Check[] = [];

async function scenario(
  name: string,
  fake: FakeAgnic,
  expect: {
    state: string;
    captured?: number;
    released?: number;
    action?: string;
  },
): Promise<void> {
  const seedResult = await seedAuthorizedOrder();
  const payments = new FakePaymentProvider();

  const reports = await runToQuiescence({
    db: prisma,
    agnic: fake,
    payments,
    workerId: 'pipeline-worker',
  });

  const order = await prisma.fanOrder.findUniqueOrThrow({
    where: { id: seedResult.fanOrderId },
    include: { merchantOrder: true, paymentEvents: true },
  });

  const ledger = order.paymentEvents.map((e) => e.type).sort();
  const captured = payments.countOf('capture');
  const released = payments.countOf('release');

  // Normalise once, so the comparison and the message cannot disagree about what
  // an empty ledger looks like.
  const actualLedger = ledger.join(',') || '(empty)';
  const expectedLedger = ledgerString(expect);

  const checks: Check[] = [
    {
      name: `${name}: final state`,
      expectation: expect.state,
      actual: order.state,
      pass: order.state === expect.state,
    },
    {
      name: `${name}: capture calls`,
      expectation: String(expect.captured ?? 0),
      actual: String(captured),
      pass: captured === (expect.captured ?? 0),
    },
    {
      name: `${name}: release calls`,
      expectation: String(expect.released ?? 0),
      actual: String(released),
      pass: released === (expect.released ?? 0),
    },
    {
      name: `${name}: ledger`,
      expectation: expectedLedger,
      actual: actualLedger,
      pass: actualLedger === expectedLedger,
    },
  ];

  if (expect.action) {
    checks.push({
      name: `${name}: operator action`,
      expectation: expect.action,
      actual: String(order.merchantOrder?.action),
      pass: order.merchantOrder?.action === expect.action,
    });
  }

  allChecks.push(...checks);

  // The amount assertion, only where a capture was expected.
  if ((expect.captured ?? 0) > 0) {
    const captureCall = payments.calls.find((c) => c.op === 'capture');
    const amount = captureCall?.input.amountMinor;
    allChecks.push({
      name: `${name}: captured amount`,
      expectation: `${EXPECTED_CAPTURE} (merchant's real ${MERCHANT_CHARGED_LESS} + fee ${MARKUP})`,
      actual: String(amount),
      pass: amount === EXPECTED_CAPTURE,
    });

    // And explicitly not the ceiling. Asserted separately so a regression that
    // restored the old behaviour names itself rather than showing a bare number
    // mismatch.
    allChecks.push({
      name: `${name}: did NOT charge the approved ceiling`,
      expectation: `anything but ${FAN_TOTAL}`,
      actual: String(amount),
      pass: amount !== FAN_TOTAL,
    });
  }

  // A handoff order keeps polling by design, so the same result repeats. Collapse
  // it rather than printing twenty-five identical entries.
  const summary: string[] = [];
  for (const r of reports) {
    const entry = `${r.topic.split('.')[0]}=${r.result}`;
    if (summary[summary.length - 1] !== entry) summary.push(entry);
  }
  console.log(`  ${name}: ${summary.join(' ')}`);

  await reset(seedResult.creatorId);
}

function ledgerString(expect: { captured?: number; released?: number }): string {
  const entries: string[] = [];
  if ((expect.captured ?? 0) > 0) entries.push('captured');
  if ((expect.released ?? 0) > 0) entries.push('released');
  return entries.sort().join(',') || '(empty)';
}

// ---------------------------------------------------------------------------

await prisma.outboxEvent.deleteMany({});

console.log('running scenarios...');

await scenario('happy path', chaos.success(), {
  state: 'succeeded',
  captured: 1,
});

await scenario('out of stock', chaos.outOfStock(), {
  state: 'failed',
  released: 1,
});

await scenario('handoff needed', chaos.handoffRequired(), {
  state: 'processing',
  action: 'human_handoff',
});

await scenario('unknown money state', chaos.unknownMoneyState(), {
  state: 'uncertain',
});

await scenario('lost response', chaos.lostResponse(), {
  state: 'uncertain',
});

// ---------------------------------------------------------------------------

const width = Math.max(...allChecks.map((c) => c.name.length));
console.log('');
for (const check of allChecks) {
  console.log(
    `${check.name.padEnd(width)}  ${check.pass ? 'ok  ' : 'FAIL'}  expected ${check.expectation}, got ${check.actual}`,
  );
}

const failures = allChecks.filter((c) => !c.pass);
await prisma.outboxEvent.deleteMany({});
await prisma.$disconnect();

console.log(
  `\n${failures.length === 0 ? `All ${allChecks.length} checks passed.` : `${failures.length} of ${allChecks.length} checks FAILED.`}`,
);
