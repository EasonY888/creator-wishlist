/**
 * Sync a shop's visible items onto a creator's wishlist.
 *
 * The sandbox shop is not in the product search index, so its items cannot be
 * found by search. The provider *will* tell us about them though: quoting a SKU
 * that does not exist returns the closest real matches, each with a name, a
 * price and an availability flag.
 *
 * Availability is written into the item's `status`, so a sold-out item is shown
 * as `Temporarily unavailable` and the wishlist stops offering a "Send this gift"
 * button that could only fail at checkout.
 *
 * The provider is explicit that this list is the closest matches, NOT the
 * merchant's full range — so this is a partial sync, and it says so.
 *
 *   npx tsx scripts/sync-shop-items.ts
 *   npx tsx scripts/sync-shop-items.ts --slug=live-creator
 */
import 'dotenv/config';

import { prisma } from '../src/db/client';
import { FULFILLMENT_ACTOR, loadShipToForFulfillment } from '../src/fulfillment/address-store';
import { services } from '../src/services';

const slugArg = process.argv.find((arg) => arg.startsWith('--slug='));
const SLUG = slugArg === undefined ? 'demo-creator' : slugArg.slice('--slug='.length);

const MERCHANT_ID = 'merchant_untitled_fidget_shop';
const MERCHANT_NAME = 'untitled-fidget.shop';

/** Deliberately not a real variant, so the provider answers with suggestions. */
const BOGUS_SKU = 'gid://shopify/ProductVariant/1';

const creator = await prisma.creator.findUniqueOrThrow({ where: { publicSlug: SLUG } });

const address = await prisma.creatorAddress.findUniqueOrThrow({
  where: { creatorId: creator.id },
});

// The real destination, read through the audited path rather than hardcoded.
const { shipTo } = await loadShipToForFulfillment(prisma, {
  creatorAddressId: address.id,
  actor: FULFILLMENT_ACTOR,
});

const outcome = await services().agnic.quoteGift({
  merchant_id: MERCHANT_ID,
  items: [{ sku: BOGUS_SKU, quantity: 1 }],
  ship_to: shipTo,
});

if (outcome.state !== 'unknown_sku') {
  console.error(`expected the provider to return suggestions; got "${outcome.state}"`);
  await prisma.$disconnect();
  process.exit(1);
}

console.log(`\n${SLUG}: ${outcome.suggestions.length} item(s) visible at ${MERCHANT_NAME}`);
console.log('(the provider says these are the closest matches, not the full range)\n');

let added = 0;
let updated = 0;
let unavailable = 0;

for (const suggestion of outcome.suggestions) {
  // Annotated so it stays a literal union: an object property would widen
  // `string`, which Prisma's `WishlistItemStatus` correctly refuses.
  const status: 'active' | 'unavailable' = suggestion.available ? 'active' : 'unavailable';
  if (status === 'unavailable') unavailable += 1;

  const key = {
    creatorId_merchantId_sku: {
      creatorId: creator.id,
      merchantId: MERCHANT_ID,
      sku: suggestion.sku,
    },
  };

  const existing = await prisma.wishlistItem.findUnique({ where: key, select: { id: true } });

  const data = {
    title: suggestion.name ?? suggestion.sku,
    merchantName: MERCHANT_NAME,
    currency: suggestion.currency ?? 'CAD',
    lastPriceMinor: suggestion.priceMinor ?? null,
    lastCheckedAt: new Date(),
    status,
  };

  if (existing) {
    await prisma.wishlistItem.update({ where: key, data });
    updated += 1;
  } else {
    await prisma.wishlistItem.create({
      data: { creatorId: creator.id, merchantId: MERCHANT_ID, sku: suggestion.sku, ...data },
    });
    added += 1;
  }

  const price = suggestion.priceMinor === null || suggestion.priceMinor === undefined
    ? '?'
    : `$${(suggestion.priceMinor / 100).toFixed(2)}`;

  console.log(
    `  ${status === 'active' ? 'available  ' : 'UNAVAILABLE'}  ${(suggestion.name ?? suggestion.sku).padEnd(32)} ${price.padStart(7)}`,
  );
}

console.log(`\nadded ${added}, refreshed ${updated}, unavailable ${unavailable}`);
console.log(`https://localhost:3000/w/${SLUG}`);

await prisma.$disconnect();
