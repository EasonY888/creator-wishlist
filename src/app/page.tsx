import Link from 'next/link';
import { prisma } from '@/db/client';

export const dynamic = 'force-dynamic';

/**
 * A plain index of creators, so the demo has an honest entry point rather than
 * a hardcoded redirect.
 */
export default async function HomePage() {
  const creators = await prisma.creator.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      displayName: true,
      publicSlug: true,
      raisingFor: true,
      _count: { select: { wishlistItems: true } },
    },
  });

  return (
    <main>
      <div className="hero">
        <h1>Creator Wishlist</h1>
        <p className="muted lede">
          Fans send gifts. The platform buys them and ships them to the creator.
          The creator&apos;s address is never shown to a fan.
        </p>
      </div>

      {creators.length === 0 ? (
        <div className="empty">
          <p>No creators yet.</p>
          <p className="small">
            Run <code>npx tsx scripts/seed.ts</code> to create a demo creator.
          </p>
        </div>
      ) : (
        <div className="list">
          {creators.map((creator) => (
            <div key={creator.id} className="list-row">
              <div>
                <strong className="title-lg">{creator.displayName}</strong>
                {creator.raisingFor ? (
                  <div className="muted small">{creator.raisingFor}</div>
                ) : null}
              </div>
              <div className="row" style={{ flex: '0 0 auto', width: 'auto', justifyContent: 'flex-end', gap: '1.25rem' }}>
                <Link className="button primary" href={`/w/${creator.publicSlug}`}>
                  View wishlist
                </Link>
                <Link className="small muted link-tap" href={`/creator/${creator.publicSlug}`}>
                  manage
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2>Operator</h2>
      <p className="small">
        <Link href="/ops">Order queue</Link> — orders needing attention, with the
        full merchant lifecycle. Refunds are recorded here.
      </p>
    </main>
  );
}
