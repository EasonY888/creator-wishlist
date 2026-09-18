/**
 * Seeds a demo creator with a real sandbox item, so the UI has something true
 * to render.
 *
 * Uses the actual sandbox merchant and SKU rather than invented ones, because
 * the sandbox shop is deliberately NOT in the product-search index — it is only
 * reachable by quoting its SKU directly. See the setup checklist.
 *
 * Safe to run repeatedly: it clears the demo creator and rebuilds it.
 */
import { toShipTo } from '../src/agnic/port';
import { prisma } from '../src/db/client';
import { writeCreatorAddress } from '../src/fulfillment/address-store';
import { computeShipToDigest } from '../src/fulfillment/binding';

const DEMO_SLUG = 'demo-creator';

const ADDRESS = {
  fullName: 'Demo Creator',
  streetAddress: '1 Test Street',
  addressLocality: 'Toronto',
  addressRegion: 'ON',
  postalCode: 'M5H 1A1',
  addressCountry: 'CA',
  phone: null,
};

const SANDBOX_MERCHANT_ID = 'merchant_untitled_fidget_shop';

const SANDBOX_ITEMS = [
  {
    sku: 'gid://shopify/ProductVariant/43945235349570',
    title: 'Hex Token Fidget',
    lastPriceMinor: 100,
  },
  {
    sku: 'gid://shopify/ProductVariant/43945255567426',
    title: 'Paw Print Charm',
    lastPriceMinor: 100,
  },
];

// ---------------------------------------------------------------------------

const existing = await prisma.creator.findUnique({
  where: { publicSlug: DEMO_SLUG },
  select: { id: true },
});

if (existing) {
  await prisma.fanOrder.deleteMany({ where: { creatorId: existing.id } });
  await prisma.wishlistItem.deleteMany({ where: { creatorId: existing.id } });
  await prisma.creatorAddress.deleteMany({ where: { creatorId: existing.id } });
  await prisma.creator.delete({ where: { id: existing.id } });
  console.log('removed the previous demo creator');
}

const creator = await prisma.creator.create({
  data: {
    displayName: 'Demo Creator',
    raisingFor: 'a new streaming setup for late-night builds',
    publicSlug: DEMO_SLUG,
  },
});

const shipTo = toShipTo(ADDRESS);

await writeCreatorAddress(prisma, {
  creatorId: creator.id,
  ...ADDRESS,
  consentPolicyVersion: 'v1',
});

for (const item of SANDBOX_ITEMS) {
  await prisma.wishlistItem.create({
    data: {
      creatorId: creator.id,
      merchantId: SANDBOX_MERCHANT_ID,
      merchantName: 'untitled-fidget.shop',
      sku: item.sku,
      title: item.title,
      currency: 'CAD',
      lastPriceMinor: item.lastPriceMinor,
      lastCheckedAt: new Date(),
      status: 'active',
    },
  });
}

console.log(`seeded creator "${DEMO_SLUG}" with ${SANDBOX_ITEMS.length} items`);
console.log(`  wishlist:  /w/${DEMO_SLUG}`);
console.log('  reminder:  the sandbox is CAD, so the mandate must be CAD too');

await prisma.$disconnect();
