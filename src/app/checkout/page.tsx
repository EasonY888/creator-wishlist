import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { chooseDelivery } from '@/app/checkout/actions';
import { prisma } from '@/db/client';
import { priceWishlistItem } from '@/orders/checkout';
import { formatMoney } from '@/presentation/money';
import { checkoutDeps } from '@/services';

export const dynamic = 'force-dynamic';

/**
 * The delivery-choice step.
 *
 * This page exists because the provider can genuinely refuse to give a total: when
 * more than one delivery method is available and none has been chosen,
 * `expected_amount_minor` comes back null. There is no honest number to display
 * in that state, so this screen shows no number at all — not zero, and not a
 * stale figure from somewhere else.
 */
export default async function ChooseDeliveryPage({
  searchParams,
}: {
  searchParams: Promise<{
    item?: string;
    creator?: string;
    slug?: string;
    unknown?: string;
  }>;
}) {
  const { item, creator, slug, unknown } = await searchParams;

  if (!item || !creator || !slug) redirect(`/w/${slug ?? 'demo-creator'}`);

  const itemRecord = await prisma.wishlistItem.findUnique({ where: { id: item } });
  if (!itemRecord) notFound();

  // A quote, not a persisted order: this page must not create anything until the
  // fan has seen a total they can agree to.
  const priced = await priceWishlistItem(checkoutDeps(), {
    creatorId: creator,
    wishlistItemId: item,
  });

  if (priced.state === 'ready') {
    // A single option, or the shop resolved it for us. Nothing to choose.
    redirect(`/w/${slug}`);
  }

  return (
    <main>
      <p className="small">
        <Link href={`/w/${slug}`}>&larr; Back to the wishlist</Link>
      </p>

      <div className="hero">
        <h1>{itemRecord.title}</h1>
        <p className="muted small">
          {itemRecord.merchantName ?? itemRecord.merchantId}
        </p>
      </div>

      {priced.state === 'choose_delivery' ? (
        <>
          <div className="notice notice-info">
            This shop offers more than one delivery method, so we cannot show a
            total until you pick one. The price depends on it.
          </div>

          <h2>Choose delivery</h2>

          <div className="stack">
            {priced.deliveryOptions.map((option) => (
              <form key={option.id} action={chooseDelivery} className="card row">
                <input type="hidden" name="wishlistItemId" value={item} />
                <input type="hidden" name="creatorId" value={creator} />
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="deliveryOptionId" value={option.id} />

                <div>
                  <strong>{option.title ?? 'Delivery'}</strong>
                  <div className="muted small money">
                    {formatMoney(option.price_minor, option.currency ?? itemRecord.currency)}
                  </div>
                </div>

                <button className="primary" type="submit">
                  Choose
                </button>
              </form>
            ))}
          </div>

          <p className="muted small" style={{ marginTop: '1.5rem' }}>
            Delivery cost is set by the shop, not by us, and is charged on top of
            the item price.
          </p>
        </>
      ) : priced.state === 'unknown_sku' ? (
        <>
          <div className="notice notice-warn">
            This exact item is no longer listed at the shop. These are the closest
            matches &mdash; we have not substituted anything for you.
          </div>

          <h2>Closest matches</h2>
          <div className="stack">
            {priced.suggestions.map((suggestion) => (
              <div key={suggestion.sku} className="card row">
                <div>
                  <strong>{suggestion.name ?? 'Unnamed item'}</strong>
                  <div className="muted small money">
                    {formatMoney(suggestion.priceMinor, suggestion.currency ?? 'CAD')}
                    {suggestion.available === false ? ' · out of stock' : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="muted small">
            A creator needs to re-add the item for it to be sendable.
          </p>
        </>
      ) : (
        <>
          <div className="notice notice-warn">
            {priced.state === 'unfulfillable'
              ? 'This gift cannot be delivered to the creator \u2014 try another one.'
              : priced.state === 'missing_address'
                ? 'The creator has not saved a delivery address yet.'
                : `We could not price this item (${priced.state}).`}
          </div>
          <p className="small" style={{ marginTop: '1.25rem' }}>
            <Link href={`/w/${slug}`}>Back to the wishlist</Link>
          </p>
        </>
      )}

      {unknown ? null : null}
    </main>
  );
}
