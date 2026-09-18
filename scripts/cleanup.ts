/**
 * Housekeeping: report on order outcomes, then remove smoke-test debris.
 *
 * The smoke scripts tear down after themselves, but a failing run leaves the
 * creator behind, and those stray rows clutter the operator queue during a demo.
 *
 * Read the summary before the cleanup — it prints the provider's own error code
 * for the most recent real order, which is the fastest way to see why a live
 * dispatch did not complete.
 */
import { prisma } from '../src/db/client';

// ---------------------------------------------------------------------------
// 1. What actually happened
// ---------------------------------------------------------------------------

const byState = await prisma.fanOrder.groupBy({
  by: ['state'],
  _count: { _all: true },
});

console.log('orders by state:');
for (const row of byState) {
  console.log(`  ${row.state.padEnd(20)} ${row._count._all}`);
}

const latest = await prisma.fanOrder.findFirst({
  orderBy: { createdAt: 'desc' },
  include: { merchantOrder: true, creator: { select: { publicSlug: true } } },
});

if (latest) {
  console.log('\nmost recent order:');
  console.log(`  creator        : ${latest.creator.publicSlug}`);
  console.log(`  state          : ${latest.state}`);
  console.log(`  fan total      : ${latest.fanTotalMinor} ${latest.currency}`);
  console.log(`  merchant cap   : ${latest.merchantCapMinor}`);
  console.log(`  provider order : ${latest.merchantOrder?.providerOrderId ?? '—'}`);
  console.log(`  provider status: ${latest.merchantOrder?.statusRaw ?? '—'}`);
  console.log(`  error code     : ${latest.merchantOrder?.errorCode ?? '—'}`);
  console.log(`  retryable      : ${String(latest.merchantOrder?.retryable)}`);
  console.log(`  retry action   : ${latest.merchantOrder?.retryAction ?? '—'}`);
  console.log(`  decision       : ${latest.merchantOrder?.action ?? '—'}`);
  console.log(`  polls          : ${latest.merchantOrder?.pollCount ?? 0}`);

  const evidence = latest.merchantOrder?.evidence as Record<string, unknown> | null;
  if (evidence) {
    console.log(`  charge state   : ${String(evidence.charge_state ?? '—')}`);
  }
}

const ledger = latest
  ? await prisma.paymentEvent.findMany({
      where: { fanOrderId: latest.id },
      orderBy: { createdAt: 'asc' },
    })
  : [];

console.log(
  `  ledger         : ${ledger.map((e) => e.type).join(' -> ') || '(nothing — no money moved)'}`,
);

// ---------------------------------------------------------------------------
// 2. Remove the debris
// ---------------------------------------------------------------------------

/**
 * Slug prefixes used by the scratch scripts. A crashed run leaves its creator
 * behind, so anything a test creates has to be listed here or it clutters the
 * wishlist index and the operator queue during a demo.
 *
 * One line per creating script -- keep it that way, because the failure mode is
 * silent: a missing prefix does not error, it just leaves a row called
 * "Smoke Creator" sitting in the queue while somebody is presenting.
 */
const DEBRIS_PREFIXES = [
  'smoke-', // smoke-dispatcher
  'checkout-', // smoke-checkout
  'pipeline-', // smoke-pipeline
  'cap-', // smoke-cap-refusal
  'stripe-', // smoke-stripe
  'approval-', // smoke-approval
  'charge-', // smoke-charge
  'curation-', // smoke-curation
  'operator-', // smoke-operator
  'webhook-', // smoke-webhook
  'card-step-', // live-card-step
  'rehearsal-', // live-order --slug=rehearsal-... (fallback recording)
  'maya-demo', // demo-address-protection (removes itself unless it crashed)
];

/**
 * The curated rows the demo is *about*. Protected by default, not by a flag:
 * the one time this script is run is minutes before a demo, and a default that
 * deletes `demo-creator` makes the safe invocation the one nobody remembers.
 *
 * `live-creator` matters most -- it holds the real order that `/ops/evidence`
 * reads, and it is the reason this list exists at all.
 */
const DEMO_SLUGS = ['demo-creator', 'live-creator'];

/** Escape hatch for deliberately wiping the demo data too. */
const includeDemo = process.argv.includes('--include-demo');

/** Show what would go, change nothing. */
const dryRun = process.argv.includes('--dry-run');

const all = await prisma.creator.findMany({
  select: { id: true, publicSlug: true },
});

const doomed = all.filter((creator) => {
  if (!includeDemo && DEMO_SLUGS.includes(creator.publicSlug)) return false;
  return DEBRIS_PREFIXES.some((p) => creator.publicSlug.startsWith(p));
});

if (includeDemo) {
  console.log('--include-demo: curated demo creators are NOT protected\n');
}

for (const creator of doomed) {
  const orders = await prisma.fanOrder.findMany({
    where: { creatorId: creator.id },
    select: { id: true },
  });

  if (dryRun) {
    console.log(`would remove ${creator.publicSlug}  (${orders.length} order(s))`);
    continue;
  }

  // Scoped to these orders, not the whole table. Wiping the outbox wholesale
  // also destroys live work for orders that have nothing to do with the debris --
  // an in-flight approval poll, say -- which is how an order silently stops
  // progressing with nothing in the logs to explain it.
  for (const order of orders) {
    await prisma.outboxEvent.deleteMany({
      where: { payload: { path: ['fanOrderId'], equals: order.id } },
    });
  }

  await prisma.fanOrder.deleteMany({ where: { creatorId: creator.id } });
  await prisma.creatorAddress.deleteMany({ where: { creatorId: creator.id } });
  await prisma.wishlistItem.deleteMany({ where: { creatorId: creator.id } });
  await prisma.creator.delete({ where: { id: creator.id } });
  console.log(`removed ${creator.publicSlug}`);
}

if (dryRun) {
  console.log(`\n${doomed.length} creator(s) would be removed -- nothing was changed`);
} else {
  console.log(`\nremoved ${doomed.length} test creator(s)`);
}

// Named explicitly rather than summarised: before a demo the question is not
// "how many rows went" but "is the order the evidence page reads still here".
const survivors = all.filter((creator) => !doomed.includes(creator));
console.log(`kept: ${survivors.map((c) => c.publicSlug).join(', ') || '(nothing)'}`);
console.log(`outbox: ${JSON.stringify(await prisma.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } }))}`);

await prisma.$disconnect();
