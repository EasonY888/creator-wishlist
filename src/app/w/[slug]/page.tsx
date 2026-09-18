import Link from 'next/link';
import { notFound } from 'next/navigation';
import { startCheckout } from '@/app/checkout/actions';
import { prisma } from '@/db/client';
import { formatMoney, relativeTime } from '@/presentation/money';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, { text: string; tone: string }> = {
  active: { text: 'Available', tone: 'badge-ok' },
  quote_required: { text: 'Price being checked', tone: 'badge-warn' },
  unavailable: { text: 'Temporarily unavailable', tone: 'badge-warn' },
  undeliverable: { text: 'Cannot ship to the creator', tone: 'badge-bad' },
  removed: { text: 'Removed', tone: 'badge-bad' },
  merchant_unsupported: { text: 'Shop not supported', tone: 'badge-bad' },
};

export default async function WishlistPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ note?: string }>;
}) {
  const { slug } = await params;
  const { note } = await searchParams;

  const creator = await prisma.creator.findUnique({
    where: { publicSlug: slug },
    include: {
      wishlistItems: { orderBy: { createdAt: 'asc' } },
    },
  });

  if (!creator) notFound();

  return (
    <main>
      <p className="small">
        <Link href="/">&larr; All creators</Link>
      </p>

      <div className="hero">
        <h1>{creator.displayName}</h1>
        {creator.raisingFor ? (
          <p className="muted">{creator.raisingFor}</p>
        ) : null}

        {/* The privacy promise, stated where it matters rather than in a policy page. */}
        <div className="notice notice-info" style={{ marginTop: '1.25rem' }}>
          Gifts ship to {creator.displayName}. Their address is never shown to you,
          and never appears on anything you can see.
        </div>
      </div>

      {note ? (
        <div className="notice notice-warn" style={{ marginBottom: '1.5rem' }}>
          {note}
        </div>
      ) : null}

      <h2>Wishlist</h2>

      {creator.wishlistItems.length === 0 ? (
        <div className="empty">Nothing on the wishlist yet.</div>
      ) : (
        <div className="list">
          {creator.wishlistItems.map((item) => {
            const status = STATUS_LABEL[item.status] ?? {
              text: item.status,
              tone: '',
            };
            const addable = item.status === 'active';

            return (
              <div key={item.id} className="list-row item-row">
                <div>
                  <div className="row" style={{ justifyContent: 'flex-start', gap: '0.75rem' }}>
                    <strong className="title-lg">{item.title}</strong>
                    <span className={`badge ${status.tone}`}>{status.text}</span>
                  </div>
                  <div className="muted small mono">
                    {item.merchantName ?? item.merchantId}
                  </div>
                </div>

                <div>
                  {/* Labelled indicative, because a browse price is not a quote. */}
                  <div className="price-lg money">
                    {formatMoney(item.lastPriceMinor, item.currency)}{' '}
                    <span className="tag-indicative">indicative</span>
                  </div>
                  <div className="muted small">
                    {/* Do NOT claim a "final total" here. On tax-added markets the
                        figure the fan approves is a CEILING, not a final total —
                        presenting it as one is the mistake the design plan names
                        explicitly. The footnote below carries the accurate version. */}
                    Last checked {relativeTime(item.lastCheckedAt)}
                  </div>
                </div>

                {addable ? (
                  <form action={startCheckout}>
                    <input type="hidden" name="wishlistItemId" value={item.id} />
                    <input type="hidden" name="creatorId" value={creator.id} />
                    <input type="hidden" name="slug" value={creator.publicSlug} />
                    <button className="primary" type="submit">
                      Send this gift
                    </button>
                  </form>
                ) : (
                  <span className="muted small">Not available to send</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="muted small" style={{ marginTop: '2.5rem' }}>
        The price shown here is what the shop last reported. The amount you
        actually pay is quoted fresh when you check out, and you approve it
        explicitly before anything happens.
      </p>
    </main>
  );
}
