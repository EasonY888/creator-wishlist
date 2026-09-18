/**
 * Wishlist curation.
 *
 * The point of these checks is that curation refuses to store anything it has not
 * verified. A wishlist item is a promise that a fan can buy this, so an
 * unverifiable link, a shop that cannot be ordered from, or an ambiguous
 * resolution must all be refused at the point a creator pastes them -- not
 * discovered by a fan at checkout.
 */
import { FakeAgnic } from '../src/agnic/fake';
import { prisma } from '../src/db/client';
import { addWishlistItemByUrl, removeWishlistItem } from '../src/wishlist/curation';

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass, detail });
}

let counter = 0;

async function seedCreator() {
  counter += 1;
  const creator = await prisma.creator.create({
    data: {
      displayName: 'Curation Creator',
      publicSlug: `curation-${Date.now()}-${counter}`,
    },
  });
  return creator.id;
}

async function reset(creatorId: string): Promise<void> {
  await prisma.outboxEvent.deleteMany({});
  await prisma.fanOrder.deleteMany({ where: { creatorId } });
  await prisma.quote.deleteMany({ where: { wishlistItem: { creatorId } } });
  await prisma.wishlistItem.deleteMany({ where: { creatorId } });
  await prisma.creatorAddress.deleteMany({ where: { creatorId } });
  await prisma.creator.delete({ where: { id: creatorId } });
}

const PRODUCT_URL = 'https://shop.example.com/products/hex-fidget?variant=123';

await prisma.outboxEvent.deleteMany({});

// ---------------------------------------------------------------------------
// 1. The happy path
// ---------------------------------------------------------------------------

{
  const creatorId = await seedCreator();

  const agnic = new FakeAgnic({
    lookup: {
      state: 'ok',
      sku: 'gid://shopify/ProductVariant/43945235349570',
      merchantId: 'merchant_fidget',
      merchantName: 'untitled-fidget.shop',
      title: 'Hex Token Fidget',
      variantTitle: 'Matte Black',
      priceMinor: 100,
      currency: 'CAD',
      available: true,
    },
  });

  const result = await addWishlistItemByUrl({ db: prisma, agnic }, { creatorId, url: PRODUCT_URL });

  check('curation: added', result.state === 'added', result.state);

  if (result.state === 'added') {
    check('curation: took the provider name', result.title === 'Hex Token Fidget', result.title);
    check(
      'curation: kept the merchant name for display',
      result.merchantName === 'untitled-fidget.shop',
      String(result.merchantName),
    );
    check(
      'curation: price is a hint, not a quote',
      result.indicativePriceMinor === 100,
      String(result.indicativePriceMinor),
    );
  }

  const stored = await prisma.wishlistItem.findFirstOrThrow({ where: { creatorId } });

  check(
    'curation: identity is the provider pair, not the URL',
    stored.merchantId === 'merchant_fidget' &&
      stored.sku === 'gid://shopify/ProductVariant/43945235349570',
    `${stored.merchantId} / ${stored.sku}`,
  );

  // The honest bit: nothing has been quoted, so it must not claim to be verified.
  check(
    'curation: does NOT claim the item was quoted',
    stored.status === 'quote_required',
    stored.status,
  );

  check(
    'curation: no URL is stored',
    !JSON.stringify(stored).includes('shop.example.com'),
    'the link was a means, not the identity',
  );

  await reset(creatorId);
}

// ---------------------------------------------------------------------------
// 2. The same product twice
// ---------------------------------------------------------------------------

{
  const creatorId = await seedCreator();

  const agnic = new FakeAgnic({
    lookup: {
      state: 'ok',
      sku: 'sku-1',
      merchantId: 'merchant_a',
      title: 'Thing',
      currency: 'CAD',
    },
  });

  const first = await addWishlistItemByUrl({ db: prisma, agnic }, { creatorId, url: PRODUCT_URL });
  const second = await addWishlistItemByUrl(
    { db: prisma, agnic },
    { creatorId, url: 'https://shop.example.com/products/thing?variant=999' },
  );

  check('curation: first add succeeds', first.state === 'added', first.state);

  check(
    'curation: the same product is refused the second time',
    second.state === 'already_listed',
    second.state,
  );

  check(
    'curation: only one row exists',
    (await prisma.wishlistItem.count({ where: { creatorId } })) === 1,
    'one item',
  );

  await reset(creatorId);
}

// ---------------------------------------------------------------------------
// 3. Everything that must be refused
// ---------------------------------------------------------------------------

{
  const cases: Array<{
    label: string;
    lookup: NonNullable<ConstructorParameters<typeof FakeAgnic>[0]>['lookup'];
    expect: string;
  }> = [
    {
      label: 'a collection link',
      lookup: { state: 'not_a_product_url', detail: 'That link is a shop, not an item.' },
      expect: 'not_a_product_url',
    },
    {
      label: 'a page with no buyable variant',
      lookup: { state: 'variant_not_found', detail: 'Ask for a link with ?variant=.' },
      expect: 'variant_not_found',
    },
    {
      label: 'a shop that is not onboarded',
      lookup: {
        state: 'ok',
        sku: 'sku-x',
        merchantId: null,
        onboardUrl: 'https://shop.example.com',
      },
      expect: 'needs_onboarding',
    },
    {
      label: 'a resolution with no merchant at all',
      lookup: { state: 'ok', sku: 'sku-y', merchantId: null },
      expect: 'transport_error',
    },
    {
      label: 'a provider outage',
      lookup: { state: 'transport_error', code: 'request_failed' },
      expect: 'transport_error',
    },
  ];

  for (const testCase of cases) {
    const creatorId = await seedCreator();
    const agnic = new FakeAgnic({ lookup: testCase.lookup });

    const result = await addWishlistItemByUrl(
      { db: prisma, agnic },
      { creatorId, url: PRODUCT_URL },
    );

    check(
      `refused: ${testCase.label}`,
      result.state === testCase.expect,
      result.state,
    );

    check(
      `refused: ${testCase.label} stored nothing`,
      (await prisma.wishlistItem.count({ where: { creatorId } })) === 0,
      'no rows',
    );

    await reset(creatorId);
  }
}

// ---------------------------------------------------------------------------
// 4. Removal, and the history it must protect
// ---------------------------------------------------------------------------

{
  const creatorId = await seedCreator();
  const agnic = new FakeAgnic({
    lookup: { state: 'ok', sku: 'sku-1', merchantId: 'merchant_a', title: 'Thing' },
  });

  const added = await addWishlistItemByUrl({ db: prisma, agnic }, { creatorId, url: PRODUCT_URL });

  if (added.state === 'added') {
    const removed = await removeWishlistItem({ db: prisma, agnic }, { creatorId, itemId: added.itemId });
    check('removal: an unordered item goes', removed.state === 'removed', removed.state);
  }

  // Now one that a fan has already quoted against.
  const second = await addWishlistItemByUrl({ db: prisma, agnic }, { creatorId, url: PRODUCT_URL });

  if (second.state === 'added') {
    await prisma.quote.create({
      data: {
        wishlistItemId: second.itemId,
        merchantId: 'merchant_a',
        state: 'valid_final',
        amountIsFinal: true,
        expectedAmountMinor: 1000,
        currency: 'CAD',
        shipToDigest: 'digest-not-under-test',
      },
    });

    const blocked = await removeWishlistItem(
      { db: prisma, agnic },
      { creatorId, itemId: second.itemId },
    );

    check(
      'removal: an item a fan has ordered is kept',
      blocked.state === 'has_orders',
      blocked.state,
    );

    check(
      'removal: it still exists',
      (await prisma.wishlistItem.count({ where: { id: second.itemId } })) === 1,
      'row intact',
    );
  }

  // And one belonging to somebody else.
  const otherCreatorId = await seedCreator();

  if (second.state === 'added') {
    const wrongOwner = await removeWishlistItem(
      { db: prisma, agnic },
      { creatorId: otherCreatorId, itemId: second.itemId },
    );

    check(
      "removal: cannot touch another creator's item",
      wrongOwner.state === 'not_found',
      wrongOwner.state,
    );
  }

  await reset(creatorId);
  await reset(otherCreatorId);
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
