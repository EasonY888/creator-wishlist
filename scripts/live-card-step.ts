/**
 * Park an order at the card step, against the REAL payment rail.
 *
 * Every other script either stops short of the card step or drives it headlessly.
 * This one deliberately does the opposite: it makes the server-side state an order
 * needs to be *payable*, then stops and prints a URL.
 *
 * The point is the one thing a script has never been able to prove -- that the
 * Stripe Elements form renders in a browser and that the client secret we minted
 * is one Stripe will actually accept. `PAYMENTS_MODE=fake` means the no-card
 * branch is the only one that had ever executed, so the entire card UI was
 * unverified.
 *
 * The merchant rail is a fake here on purpose. The card step does not touch it,
 * and involving a live provider would make this fail for reasons that have
 * nothing to do with the thing under test.
 *
 *   npx tsx scripts/live-card-step.ts
 *
 * Always re-runnable: it clears its own previous run first. There used to be a
 * `--keep` flag, and it was worse than useless -- skipping the cleanup meant the
 * next `creator.create` hit the unique slug and the script died with a Prisma
 * error, so it only ever worked on a fresh database.
 */
import 'dotenv/config';

import { FakeAgnic } from '../src/agnic/fake';
import { toShipTo } from '../src/agnic/port';
import { prisma } from '../src/db/client';
import { computeShipToDigest } from '../src/fulfillment/binding';
import { writeCreatorAddress } from '../src/fulfillment/address-store';
import { beginPayment } from '../src/orders/checkout';
import { services } from '../src/services';

const ADDRESS = {
  fullName: 'Creator Example',
  streetAddress: '1 Test Street',
  addressLocality: 'Toronto',
  addressRegion: 'ON',
  postalCode: 'M5H 1A1',
  addressCountry: 'CA',
  phone: null,
};

const MARKUP_MINOR = 200;
const MERCHANT_CAP_MINOR = 1000;
const FAN_TOTAL_MINOR = MERCHANT_CAP_MINOR + MARKUP_MINOR;

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const SLUG = 'card-step-demo';

const { payments, paymentsMode } = services();

if (paymentsMode !== 'stripe') {
  console.error(
    `PAYMENTS_MODE is "${paymentsMode}". This script exists to exercise the real card form,\n` +
      'so set PAYMENTS_MODE=stripe in .env. Running it against the fake would only render\n' +
      'the no-card branch, which is the branch that already worked.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Clear a previous run
// ---------------------------------------------------------------------------

const stale = await prisma.creator.findUnique({ where: { publicSlug: SLUG } });

if (stale) {
  // Order matters: the address is referenced by orders, so it goes last-ish
  // along with the creator.
  await prisma.outboxEvent.deleteMany({});
  const orders = await prisma.fanOrder.findMany({
    where: { creatorId: stale.id },
    select: { id: true },
  });
  const ids = orders.map((o) => o.id);
  await prisma.paymentEvent.deleteMany({ where: { fanOrderId: { in: ids } } });
  await prisma.orderEvent.deleteMany({ where: { fanOrderId: { in: ids } } });
  await prisma.approvalWindow.deleteMany({ where: { fanOrderId: { in: ids } } });
  await prisma.approvedRequest.deleteMany({ where: { fanOrderId: { in: ids } } });
  await prisma.fanOrder.deleteMany({ where: { creatorId: stale.id } });
  await prisma.quote.deleteMany({ where: { wishlistItem: { creatorId: stale.id } } });
  await prisma.wishlistItem.deleteMany({ where: { creatorId: stale.id } });
  await prisma.creatorAddress.deleteMany({ where: { creatorId: stale.id } });
  await prisma.creator.delete({ where: { id: stale.id } });
  console.log('cleared the previous run');
}

// ---------------------------------------------------------------------------
// Seed exactly the state pricing would have left behind
// ---------------------------------------------------------------------------

const shipTo = toShipTo(ADDRESS);

const creator = await prisma.creator.create({
  data: { displayName: 'Card Step Demo', publicSlug: SLUG },
});

const address = await writeCreatorAddress(prisma, {
  creatorId: creator.id,
  ...ADDRESS,
  consentPolicyVersion: 'v1',
});

const item = await prisma.wishlistItem.create({
  data: {
    creatorId: creator.id,
    merchantId: 'merchant_card_step',
    sku: 'sku-card-step',
    title: 'Card Step Demo Item',
    currency: 'CAD',
  },
});

const quote = await prisma.quote.create({
  data: {
    wishlistItemId: item.id,
    merchantId: 'merchant_card_step',
    state: 'valid_final',
    amountIsFinal: true,
    expectedAmountMinor: MERCHANT_CAP_MINOR,
    chargeCapMinor: MERCHANT_CAP_MINOR,
    currency: 'CAD',
    items: [{ sku: 'sku-card-step', quantity: 1 }],
    shipToDigest: computeShipToDigest(shipTo),
    selectedOptionId: null,
    // An hour, not the five minutes a real quote lives for. A real quote would
    // have expired while somebody clicked around the demo, and an expired quote
    // refuses at approval -- which is correct behaviour and a confusing demo.
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  },
});

const order = await prisma.fanOrder.create({
  data: {
    fanId: 'fan_card_step',
    creatorId: creator.id,
    quoteId: quote.id,
    state: 'draft',
    fanTotalMinor: FAN_TOTAL_MINOR,
    markupMinor: MARKUP_MINOR,
    merchantCapMinor: MERCHANT_CAP_MINOR,
    currency: 'CAD',
  },
});

// ---------------------------------------------------------------------------
// Freeze, then prepare -- the same two-phase order the real checkout uses
// ---------------------------------------------------------------------------

const deps = {
  db: prisma,
  agnic: new FakeAgnic(),
  payments,
  markupPercent: 20,
};

const begun = await beginPayment(deps, {
  fanOrderId: order.id,
  fanConfirmationText: 'Yes, send this gift',
  approvedAt: new Date(),
});

if (begun.state !== 'ready') {
  console.error(`beginPayment did not reach the card step: ${begun.state}`);
  console.error(begun);
  await prisma.$disconnect();
  process.exit(1);
}

const parked = await prisma.fanOrder.findUniqueOrThrow({
  where: { id: order.id },
  include: { approvedRequest: true, paymentEvents: true },
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const url = `${APP_URL}/checkout/${order.id}/pay`;

console.log('');
console.log('order parked at the card step');
console.log(`  fanOrderId        ${order.id}`);
console.log(`  state             ${parked.state}`);
console.log(`  intent ref        ${parked.paymentIntentRef ?? '(none)'}`);
console.log(`  holds             ${parked.paymentEvents.length}  <- must be 0: an intent exists, no money is held`);
console.log(`  frozen request    ${parked.approvedRequest === null ? 'MISSING' : 'written'}`);
console.log(`  fan total         ${FAN_TOTAL_MINOR} minor ${parked.currency}`);
console.log('');
console.log(`  open:  ${url}`);
console.log('');
console.log('The card form should render a Stripe iframe. Test card 4242 4242 4242 4242,');
console.log('any future expiry, any CVC, any postal code.');
console.log('');

await prisma.$disconnect();
