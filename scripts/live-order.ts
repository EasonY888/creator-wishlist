/**
 * One real order, end to end, against the live API.
 *
 * No fakes: the quote is a live merchant quote, the dispatch spends against the
 * vaulted card, and the worker polls the provider until the order settles.
 *
 * The thing this is really testing is the spending mandate's currency. There is
 * no API to read it, and if it is not CAD then every dispatch returns
 * `currency_mismatch` forever — which would present as a mysteriously stuck
 * order rather than a configuration fault. Running one order is the only way to
 * find out.
 */
import { prisma } from '../src/db/client';
import {
  approveAndAuthorize,
  createDraftOrder,
  priceWishlistItem,
} from '../src/orders/checkout';
import { drainOnce } from '../src/orders/worker';
import { toShipTo } from '../src/agnic/port';
import { checkSetup, describeSetup } from '../src/agnic/setup-check';
import { writeCreatorAddress } from '../src/fulfillment/address-store';
import { computeShipToDigest } from '../src/fulfillment/binding';
import { checkoutDeps, workerDeps } from '../src/services';

/**
 * Which creator to run as.
 *
 * Overridable because recording the fallback dispatch is the one thing that MUST
 * happen before the demo -- 60-70 seconds of live traffic is not something to
 * gamble on in front of judges -- and running that recording against
 * `live-creator` would delete the real settled order `/ops/evidence` reads. The
 * two jobs need different creators.
 */
const slugArg = process.argv.find((arg) => arg.startsWith('--slug='));
const SLUG = slugArg === undefined ? 'live-creator' : slugArg.slice('--slug='.length);

const SANDBOX_MERCHANT_ID = 'merchant_untitled_fidget_shop';
const SANDBOX_SKU = 'gid://shopify/ProductVariant/43945235349570'; // Hex Token Fidget, 100 CAD

const ADDRESS = {
  fullName: 'Live Test Creator',
  streetAddress: '1 Test Street',
  addressLocality: 'Toronto',
  addressRegion: 'ON',
  postalCode: 'M5H 1A1',
  addressCountry: 'CA',
  phone: null,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 0. Preflight
//
// Over HTTP the provider will accept a dispatch from an account with no card and
// an empty profile, then fail at the merchant. That failure looks like a shop
// problem, so check the prerequisites ourselves first.
// ---------------------------------------------------------------------------

const token = process.env.AGNIC_TOKEN;
if (!token) {
  console.error('AGNIC_TOKEN is not set.');
  process.exit(1);
}

console.log('0. checking setup...');
const setup = await checkSetup(token);
console.log(describeSetup(setup));

if (!setup.ready) {
  console.log('\nNot ready to dispatch. Fix the above, then re-run.');
  await prisma.$disconnect();
  process.exit(1);
}

console.log('   ready.\n');

async function makeAllTasksDue(): Promise<void> {
  await prisma.$executeRaw`update "OutboxEvent" set "availableAt" = now() where status = 'pending'`;
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

const existing = await prisma.creator.findUnique({
  where: { publicSlug: SLUG },
  select: { id: true },
});

if (existing) {
  /**
   * This deletes every order on the creator -- including a real one that settled
   * against the live merchant. `/ops/evidence` reads that order's ledger, the
   * merchant's figure and the fee comparison, so running this casually does not
   * merely drop a test row: it empties the page that demonstrates the product
   * works, and a settled order cannot be recreated without spending real money
   * again. The destructive path therefore has to be asked for by name.
   */
  const settled = await prisma.fanOrder.findMany({
    where: {
      creatorId: existing.id,
      state: { in: ['succeeded', 'refunded', 'partially_fulfilled'] },
    },
    select: { id: true, state: true, fanTotalMinor: true, currency: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  if (settled.length > 0 && !process.argv.includes('--reset')) {
    console.error(`\n"${SLUG}" holds ${settled.length} settled order(s):\n`);
    for (const order of settled) {
      console.error(
        `  ${order.id}  ${order.state}  ${order.fanTotalMinor} ${order.currency}  ` +
          `${order.createdAt.toISOString().slice(0, 10)}`,
      );
    }
    console.error('');
    console.error('Refusing to delete them -- this run would empty /ops/evidence, which');
    console.error('reads exactly these rows.');
    console.error('');
    console.error('To park a ceiling order without touching them:');
    console.error('  npx tsx scripts/park-ceiling-order.ts');
    console.error('');
    console.error('To overwrite them anyway:');
    console.error('  npx tsx scripts/live-order.ts --reset');
    console.error('');
    await prisma.$disconnect();
    process.exit(1);
  }

  await prisma.outboxEvent.deleteMany({});
  await prisma.fanOrder.deleteMany({ where: { creatorId: existing.id } });
  await prisma.wishlistItem.deleteMany({ where: { creatorId: existing.id } });
  await prisma.creatorAddress.deleteMany({ where: { creatorId: existing.id } });
  await prisma.creator.delete({ where: { id: existing.id } });
}

const creator = await prisma.creator.create({
  data: { displayName: 'Live Test Creator', publicSlug: SLUG },
});

await writeCreatorAddress(prisma, {
  creatorId: creator.id,
  ...ADDRESS,
  consentPolicyVersion: 'v1',
});

const item = await prisma.wishlistItem.create({
  data: {
    creatorId: creator.id,
    merchantId: SANDBOX_MERCHANT_ID,
    merchantName: 'untitled-fidget.shop',
    sku: SANDBOX_SKU,
    title: 'Hex Token Fidget',
    currency: 'CAD',
    lastPriceMinor: 100,
    lastCheckedAt: new Date(),
    status: 'active',
  },
});

const deps = checkoutDeps();

// ---------------------------------------------------------------------------
// 1. Live quote
// ---------------------------------------------------------------------------

console.log('1. quoting live...');
const firstQuote = await priceWishlistItem(deps, {
  creatorId: creator.id,
  wishlistItemId: item.id,
});

let deliveryOptionId: string | undefined;

if (firstQuote.state === 'choose_delivery') {
  const option = firstQuote.deliveryOptions[0];
  console.log(
    `   the shop needs a delivery choice: ${firstQuote.deliveryOptions
      .map((o) => `${o.title} ${o.price_minor}`)
      .join(', ')}`,
  );
  deliveryOptionId = option?.id;
} else if (firstQuote.state !== 'ready') {
  console.log(`   quote failed: ${firstQuote.state}`);
  await prisma.$disconnect();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Draft with a real total
// ---------------------------------------------------------------------------

console.log('2. pricing the fan total...');
const draft = await createDraftOrder(deps, {
  fanId: 'fan-live',
  creatorId: creator.id,
  wishlistItemId: item.id,
  ...(deliveryOptionId ? { deliveryOptionId } : {}),
});

if (draft.state !== 'created') {
  console.log(`   draft failed: ${JSON.stringify(draft)}`);
  await prisma.$disconnect();
  process.exit(1);
}

console.log(
  `   merchant ${draft.order.merchantCapMinor} + fee ${draft.order.markupMinor} = fan pays ${draft.order.fanTotalMinor} ${draft.order.currency}`,
);
console.log(`   amount_is_final: ${draft.order.amountIsFinal} ${draft.order.amountIsFinal ? '' : '(a ceiling, not a total)'}`);

// ---------------------------------------------------------------------------
// 3. Approve and hold
// ---------------------------------------------------------------------------

console.log('3. approving and holding payment...');
const approved = await approveAndAuthorize(deps, {
  fanOrderId: draft.order.fanOrderId,
  fanConfirmationText: 'yes, send this gift',
  approvedAt: new Date(),
  paymentMethodRef: 'pm_test',
});

console.log(`   ${approved.state}`);
if (approved.state !== 'authorized') {
  console.log('   stopping: nothing was dispatched');
  await prisma.$disconnect();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. Run the worker until the order settles
// ---------------------------------------------------------------------------

console.log('4. dispatching (this spends money)...');

const worker = workerDeps('live-runner');
let settled = false;

for (let round = 0; round < 45 && !settled; round += 1) {
  await makeAllTasksDue();
  const result = await drainOnce(worker, { limit: 5 });

  for (const report of result.reports) {
    console.log(`   [${round}] ${report.action.padEnd(9)} ${report.topic} -> ${report.result}`);
  }

  const order = await prisma.fanOrder.findUnique({
    where: { id: draft.order.fanOrderId },
    select: { state: true },
  });

  settled = order !== null && ['succeeded', 'failed', 'refunded', 'uncertain'].includes(order.state);

  if (result.claimed === 0 && !settled) await sleep(4000);
}

// ---------------------------------------------------------------------------
// 5. What actually happened
// ---------------------------------------------------------------------------

const final = await prisma.fanOrder.findUniqueOrThrow({
  where: { id: draft.order.fanOrderId },
  include: {
    merchantOrder: true,
    paymentEvents: { orderBy: { createdAt: 'asc' } },
  },
});

console.log('\n--- result ---');
console.log(`fan order state   : ${final.state}`);
console.log(`fan total         : ${final.fanTotalMinor} ${final.currency}`);
console.log(`provider order    : ${final.merchantOrder?.providerOrderId ?? '—'}`);
console.log(`provider status   : ${final.merchantOrder?.statusRaw ?? '—'}`);
console.log(`retryable         : ${String(final.merchantOrder?.retryable)}`);
console.log(`retry action      : ${final.merchantOrder?.retryAction ?? '—'}`);
console.log(`error code        : ${final.merchantOrder?.errorCode ?? '—'}`);
console.log(`decision          : ${final.merchantOrder?.action ?? '—'}`);
console.log(`polls             : ${final.merchantOrder?.pollCount ?? 0}`);
console.log(`ledger            : ${final.paymentEvents.map((e) => e.type).join(' -> ') || '(nothing)'}`);

const evidence = final.merchantOrder?.evidence as Record<string, unknown> | null;
if (evidence) {
  console.log(`charge state      : ${String(evidence.charge_state ?? '—')}`);
  const keys = Object.keys(evidence).slice(0, 8);
  console.log(`evidence fields   : ${keys.join(', ')}`);
}

console.log('\n--- verdict ---');
if (final.state === 'succeeded') {
  console.log('IT WORKS. A real merchant order was placed and the fan payment was captured.');
} else if (final.merchantOrder?.errorCode === 'currency_mismatch') {
  console.log('MANDATE CURRENCY IS WRONG. Reissue the spending mandate in CAD.');
} else if (final.state === 'uncertain') {
  console.log('UNKNOWN OUTCOME - correctly escalated rather than guessed. Read the status above.');
} else {
  console.log(`Did not complete. Provider said: ${final.merchantOrder?.statusRaw ?? 'nothing'}`);
}

// Note: the outbox is deliberately NOT cleared here. An order that has not
// settled still has a poll queued, and deleting it would strand the order
// mid-flight — which is exactly what happened on the first live run.
// `scripts/cleanup.ts` clears it when the run is finished with.

await prisma.$disconnect();
