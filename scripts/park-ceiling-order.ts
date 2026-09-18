/**
 * Park an order at the approval screen, showing a CEILING rather than a total.
 *
 * The one demo beat nothing else can produce. Every other script either ends up
 * with a final price (`live-card-step` seeds `amountIsFinal: true`) or runs the
 * order all the way to settlement (`live-order`). Neither leaves an order sitting
 * in `draft` against a non-final quote, so "the fan approves a maximum, not a
 * total" — the disclosure the whole product turns on — was the one claim the
 * demo could not actually make.
 *
 * The quote is REAL: it comes from the live merchant through the same pricing
 * path the app uses, so `amount_is_final` is the shop's answer, not ours. If the
 * shop ever returns a final price this script fails loudly rather than quietly
 * parking a normal total and letting the demo claim a ceiling it is not showing.
 *
 * It does NOT approve, hold, or dispatch. Nothing here spends money.
 *
 *   npx tsx scripts/park-ceiling-order.ts
 *   npx tsx scripts/park-ceiling-order.ts --hours 36
 *
 * Safe to re-run: it removes only its own previous order (tagged by fan id) and
 * never deletes the creator.
 *
 * Run it AFTER `scripts/seed.ts`. That script rebuilds the demo creator from
 * scratch and drops its orders, so parking first would lose the parked order
 * with no error at all.
 */
import 'dotenv/config';

import { prisma } from '../src/db/client';
import { createDraftOrder, priceWishlistItem } from '../src/orders/checkout';
import { writeCreatorAddress } from '../src/fulfillment/address-store';
import { checkoutDeps } from '../src/services';

/**
 * The creator the fan journey is walked as, so the parked order lands on the
 * same screen §2 of the demo script describes -- and under the same name the
 * fan-facing copy renders. Override with `--slug=`.
 */
const slugArg = process.argv.find((arg) => arg.startsWith('--slug='));
const SLUG = slugArg === undefined ? 'demo-creator' : slugArg.slice('--slug='.length);

/**
 * Marks the orders this script owns, so a re-run can clear its own previous work
 * without touching anything else on the creator.
 *
 * This is NOT the order's owner -- see `ownerFanId` below. The two are different
 * things and conflating them is how the first version of this script parked an
 * order nobody could approve.
 */
const PARK_MARKER = 'fan-ceiling-demo';

/**
 * Who will be allowed to approve the parked order.
 *
 * It has to be the fan you are signed in as. `startPayment` refuses an order
 * whose `fanId` is not the session's, so an order parked under some other fan
 * can be *shown* but never *approved* -- and the approval act is the half of the
 * beat that matters.
 *
 * `fanId` IS the fan's email (`verifyLoginCode` returns the normalised email).
 * Defaulting to the most recent login code means this just works straight after
 * the sign-in §5 already tells you to do first; `--fan=` overrides it.
 */
const fanArg = process.argv.find((arg) => arg.startsWith('--fan='));

const SANDBOX_MERCHANT_ID = 'merchant_untitled_fidget_shop';
const SANDBOX_SKU = 'gid://shopify/ProductVariant/43945235349570'; // Hex Token Fidget

const ADDRESS = {
  fullName: 'Demo Creator',
  streetAddress: '1 Test Street',
  addressLocality: 'Toronto',
  addressRegion: 'ON',
  postalCode: 'M5H 1A1',
  addressCountry: 'CA',
  phone: null,
};

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';

// ---------------------------------------------------------------------------
// How long the parked quote stays good for
//
// A real quote lives five minutes (`QUOTE_TTL_SECONDS`). That is the honest
// number and it is useless here: an expired quote refuses at approval, so the
// demo would refuse in front of judges for reasons that are entirely correct and
// look like a bug. The approval screen reads this expiry and reports what it
// actually is, so extending it here does not put a false claim on the page.
// ---------------------------------------------------------------------------

const hoursArg = process.argv.indexOf('--hours');
const HOURS = hoursArg === -1 ? 12 : Number(process.argv[hoursArg + 1]);

if (!Number.isFinite(HOURS) || HOURS <= 0) {
  console.error('--hours needs a positive number, e.g. --hours 12');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. The creator and its wishlist item
// ---------------------------------------------------------------------------

let creator = await prisma.creator.findUnique({ where: { publicSlug: SLUG } });

if (creator === null) {
  console.log(`creating "${SLUG}" (it does not exist yet)`);
  creator = await prisma.creator.create({
    data: { displayName: 'Demo Creator', publicSlug: SLUG },
  });
  await writeCreatorAddress(prisma, {
    creatorId: creator.id,
    ...ADDRESS,
    consentPolicyVersion: 'v1',
  });
}

const existingAddress = await prisma.creatorAddress.findUnique({
  where: { creatorId: creator.id },
});

if (existingAddress === null) {
  console.log('the creator has no address; writing one (pricing needs a destination)');
  await writeCreatorAddress(prisma, {
    creatorId: creator.id,
    ...ADDRESS,
    consentPolicyVersion: 'v1',
  });
}

let item = await prisma.wishlistItem.findFirst({
  where: { creatorId: creator.id, merchantId: SANDBOX_MERCHANT_ID },
});

if (item === null) {
  console.log('adding the sandbox item to the wishlist');
  item = await prisma.wishlistItem.create({
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
}

// ---------------------------------------------------------------------------
// 2. Drop the previous parked order
//
// Quotes are not cascaded from FanOrder, so they are collected and removed
// explicitly -- otherwise every re-run leaves an orphan quote behind.
// ---------------------------------------------------------------------------

/**
 * Matched on the fan id alone, not on fan id *and* creator. The fan id belongs
 * exclusively to this script, and matching it across creators means changing
 * `--slug` clears the order parked under the previous one instead of leaving it
 * behind at a URL somebody might still open.
 */
const previous = await prisma.fanOrder.findMany({
  where: { fanId: PARK_MARKER },
  select: { id: true, quoteId: true, creator: { select: { publicSlug: true } } },
});

if (previous.length > 0) {
  for (const order of previous) {
    await prisma.outboxEvent.deleteMany({
      where: { payload: { path: ['fanOrderId'], equals: order.id } },
    });
  }

  await prisma.fanOrder.deleteMany({ where: { fanId: PARK_MARKER } });

  const quoteIds = previous
    .map((order) => order.quoteId)
    .filter((id): id is string => id !== null);
  await prisma.quote.deleteMany({ where: { id: { in: quoteIds } } });

  const where = previous.map((order) => order.creator.publicSlug).join(', ');
  console.log(`removed ${previous.length} previously parked order(s) on ${where}`);
} else {
  console.log('no previously parked order');
}

// ---------------------------------------------------------------------------
// 2b. Who can approve it
// ---------------------------------------------------------------------------

async function resolveOwnerFanId(): Promise<string> {
  if (fanArg !== undefined) return fanArg.slice('--fan='.length);

  const latest = await prisma.fanLoginCode.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { email: true },
  });

  if (latest === null) {
    console.error('\nNo fan has requested a login code yet, so there is nobody to own this');
    console.error('order. An order parked under the wrong fan can be shown but never');
    console.error('approved -- startPayment refuses it, with "That order is not yours."');
    console.error('');
    console.error('Sign in at /fan/login first, or name the fan explicitly:');
    console.error('  npx tsx scripts/park-ceiling-order.ts --fan=you@example.com');
    await prisma.$disconnect();
    process.exit(1);
  }

  return latest.email;
}

const ownerFanId = await resolveOwnerFanId();

// ---------------------------------------------------------------------------
// 3. A real quote, then a draft. Nothing is held.
// ---------------------------------------------------------------------------

const deps = checkoutDeps();

console.log(`\nquoting ${SLUG} live...`);

const priced = await priceWishlistItem(deps, {
  creatorId: creator.id,
  wishlistItemId: item.id,
});

let deliveryOptionId: string | undefined;

if (priced.state === 'choose_delivery') {
  deliveryOptionId = priced.deliveryOptions[0]?.id;
  console.log(
    `  the shop wants a delivery choice: ${priced.deliveryOptions
      .map((o) => `${o.title} ${o.price_minor}`)
      .join(', ')}`,
  );
} else if (priced.state !== 'ready') {
  console.error(`\nquoting failed: ${priced.state}`);
  console.error('Nothing was parked. Fix the quote, then re-run.');
  await prisma.$disconnect();
  process.exit(1);
}

const draft = await createDraftOrder(deps, {
  fanId: ownerFanId,
  creatorId: creator.id,
  wishlistItemId: item.id,
  ...(deliveryOptionId ? { deliveryOptionId } : {}),
});

if (draft.state !== 'created') {
  console.error(`\ndraft failed: ${JSON.stringify(draft)}`);
  await prisma.$disconnect();
  process.exit(1);
}

const order = draft.order;

// ---------------------------------------------------------------------------
// 4. Refuse to pretend
//
// A final price means the "maximum, not a total" notice will not render, so the
// order being parked would look identical to a normal total while the script's
// output implied otherwise. Better to fail than to hand over a demo beat that
// silently is not there.
// ---------------------------------------------------------------------------

if (order.amountIsFinal) {
  console.error('');
  console.error('The shop returned a FINAL price, so there is no ceiling to show.');
  console.error('This order would render as an ordinary total. Not parking it.');
  console.error('');
  console.error('The demo needs a shop that prices tax at its own checkout.');
  await prisma.$disconnect();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 5. Give the quote a life that outlasts the demo
// ---------------------------------------------------------------------------

const expiresAt = new Date(Date.now() + HOURS * 60 * 60 * 1000);

const stored = await prisma.fanOrder.findUniqueOrThrow({
  where: { id: order.fanOrderId },
  select: { quoteId: true },
});

// `createDraftOrder` always writes a quote, but the column is nullable. If that
// ever stops being true the expiry would go unset -- and an unset expiry is a
// quote that never goes stale, which reads as "fine" until the demo refuses.
if (stored.quoteId === null) {
  console.error('\nthe parked order has no quote, so its expiry cannot be set');
  await prisma.$disconnect();
  process.exit(1);
}

await prisma.quote.update({ where: { id: stored.quoteId }, data: { expiresAt } });

// ---------------------------------------------------------------------------
// 6. Report
// ---------------------------------------------------------------------------

const url = `${APP_URL}/checkout/${order.fanOrderId}`;

console.log('');
console.log('order parked at the approval screen');
console.log(`  fanOrderId     ${order.fanOrderId}`);
console.log(`  creator        ${SLUG}`);
console.log(`  owned by       ${ownerFanId}`);
console.log('                 ^ only this fan can approve it. Sign in as them.');
console.log(`  state          draft  <- nothing approved, nothing held`);
console.log(`  amountIsFinal  ${order.amountIsFinal}`);
console.log('');
console.log(`  item + delivery  ${order.merchantCapMinor}`);
console.log(`  platform fee     ${order.markupMinor}`);
console.log(`  fan approves up to ${order.fanTotalMinor} ${order.currency}`);
console.log('');
console.log(`  quote good for   ${HOURS} h  (the page reports this figure, not the 5 min default)`);
console.log('');
console.log(`  open:  ${url}`);
console.log('');
console.log('The screen should show the total in the warning colour with');
console.log('"This is a maximum, not an exact total." directly under it, and the');
console.log('approval field below. Approving it is the demo beat -- and it spends');
console.log('nothing until the shop confirms.');
console.log('');

await prisma.$disconnect();
