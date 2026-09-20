import Link from 'next/link';
import { cookies } from 'next/headers';

import { CREATOR_SESSION_COOKIE, readCreatorSession } from '@/creators/auth';
import { prisma } from '@/db/client';

export const dynamic = 'force-dynamic';

/**
 * Which creators the index is allowed to list.
 *
 * The database carries fixtures as well as the demo wishlist: a reference
 * creator whose orders are what `/ops/evidence` reads, and a couple of
 * throwaways from exercising the card flow. Locally they are the point. On a
 * public deployment they are a reviewer's first impression, and "Reference
 * Order — do not delete" is not the thing this project is about.
 *
 * An allowlist rather than a denylist, deliberately: a fixture added later
 * cannot reach a public index just because nobody remembered to hide it.
 * Unset means "list everything", which is what a local checkout wants.
 */
function listedSlugs(): string[] | null {
  const raw = process.env.PUBLIC_WISHLIST_SLUGS?.trim();
  if (!raw) return null;
  return raw
    .split(',')
    .map((slug) => slug.trim())
    .filter((slug) => slug.length > 0);
}

/**
 * A plain index of creators, so the demo has an honest entry point rather than
 * a hardcoded redirect.
 */
export default async function HomePage() {
  const listed = listedSlugs();

  const rows = await prisma.creator.findMany({
    where: listed === null ? {} : { publicSlug: { in: listed } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      displayName: true,
      publicSlug: true,
      raisingFor: true,
      _count: { select: { wishlistItems: true } },
    },
  });

  // Ordered as the allowlist asks rather than by createdAt, so whoever sets it
  // decides what a visitor sees first.
  const creators =
    listed === null
      ? rows
      : listed.flatMap((slug) => rows.filter((row) => row.publicSlug === slug));

  /**
   * `manage` is only offered for the creator whose link this browser has already
   * used. Showing it to everyone is how the gap stayed invisible: the link read
   * as ordinary navigation, and the page behind it had no gate at all.
   */
  const session = readCreatorSession((await cookies()).get(CREATOR_SESSION_COOKIE)?.value);

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
          {listed === null ? (
            <p className="small">
              Run <code>npx tsx scripts/seed.ts</code> to create a demo creator.
            </p>
          ) : null}
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
                {session?.creatorId === creator.id ? (
                  <Link className="small muted link-tap" href={`/creator/${creator.publicSlug}`}>
                    manage
                  </Link>
                ) : null}
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
