import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { CREATOR_SESSION_COOKIE, readCreatorSession } from '@/creators/auth';
import { prisma } from '@/db/client';
import { formatMoney, relativeTime } from '@/presentation/money';
import { addItem, removeItem, saveAddress } from './actions';

export const dynamic = 'force-dynamic';

interface AddressField {
  name: string;
  label: string;
  autoComplete: string;
  maxLength: number;
  required: boolean;
  placeholder?: string;
}

/**
 * The address fields, declared once and rendered in a loop.
 *
 * Declared rather than hand-written so the labels, the required/optional split
 * and the autocomplete hints cannot drift from one another. A form that labels a
 * field one way and requires it another is how a creator ends up unable to save
 * the address they just typed.
 */
const ADDRESS_FIELDS: readonly AddressField[] = [
  { name: 'fullName', label: 'Full name', autoComplete: 'name', maxLength: 120, required: true },
  {
    name: 'streetAddress',
    label: 'Street address',
    autoComplete: 'street-address',
    maxLength: 200,
    required: true,
  },
  {
    name: 'addressLocality',
    label: 'City',
    autoComplete: 'address-level2',
    maxLength: 120,
    required: true,
  },
  {
    name: 'addressRegion',
    label: 'State or province',
    autoComplete: 'address-level1',
    maxLength: 120,
    required: false,
  },
  {
    name: 'postalCode',
    label: 'Postal code',
    autoComplete: 'postal-code',
    maxLength: 24,
    required: true,
  },
  {
    name: 'addressCountry',
    label: 'Country',
    autoComplete: 'country',
    maxLength: 2,
    required: true,
    placeholder: 'CA',
  },
  { name: 'phone', label: 'Phone', autoComplete: 'tel', maxLength: 40, required: false },
];

/**
 * A creator's own view of their wishlist.
 *
 * Two things it is careful about:
 *
 *   1. **The indicative price is labelled as indicative.** It came from a
 *      browse-time lookup, not a quote, so presenting it as the price would be
 *      showing a number nothing stands behind. The fan-facing page says the same.
 *   2. **Items with orders cannot be removed.** Orders are financial records, so
 *      deleting the item they reference would destroy history.
 */
export default async function CreatorPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ note?: string; problem?: string }>;
}) {
  const { slug } = await params;
  const { note, problem } = await searchParams;

  const creator = await prisma.creator.findUnique({
    where: { publicSlug: slug },
    include: {
      wishlistItems: {
        orderBy: { createdAt: 'desc' },
        include: { quotes: { select: { id: true }, take: 1 } },
      },
      address: { select: { id: true } },
    },
    // The key is a credential, not page data. Prisma selects every scalar by
    // default, so without this it would be in scope of the render -- one stray
    // interpolation away from being printed into the page.
    omit: { accessKey: true },
  });

  if (!creator) notFound();

  /**
   * A creator has no password and no email on file, so the credential is the key
   * in their private link -- exchanged for this cookie at `/creator/{slug}/enter`.
   *
   * A screen rather than `notFound()`, unlike `/orders`: a fan who loses an order
   * link is confused, but a creator who loses this one has lost the only way to
   * manage their wishlist, and a 404 would not say so.
   */
  const session = readCreatorSession((await cookies()).get(CREATOR_SESSION_COOKIE)?.value);

  if (session?.creatorId !== creator.id) {
    return (
      <main>
        <p className="small">
          <Link href="/">&larr; All creators</Link>
        </p>

        <div className="hero">
          <h1>This wishlist is managed privately</h1>
        </div>

        <div className="notice notice-info">
          Managing {creator.displayName}&apos;s gifts needs the private link they were given. It
          opens with <code>/creator/{creator.publicSlug}/enter?key=&hellip;</code>, and holding that
          link is what proves who you are &mdash; there is no password to reset.
        </div>

        <p style={{ marginTop: '1rem' }}>
          <Link href={`/w/${creator.publicSlug}`}>View this wishlist as a fan</Link>
        </p>
      </main>
    );
  }

  const hasAddress = creator.address !== null;

  return (
    <main>
      <p className="small">
        <Link href="/">&larr; All creators</Link>
      </p>

      <div className="hero">
        <h1>{creator.displayName}</h1>
        <p className="muted small">
          Your wishlist · <Link href={`/w/${creator.publicSlug}`}>view as a fan</Link>
        </p>
      </div>

      {problem ? (
        <div className="notice notice-warn" style={{ marginBottom: '1.5rem' }}>
          <strong>Could not add that.</strong> {problem}
        </div>
      ) : null}

      {note ? (
        <div className="notice notice-info" style={{ marginBottom: '1.5rem' }}>
          {note}
        </div>
      ) : null}

      {hasAddress ? null : (
        <div className="notice notice-warn" style={{ marginBottom: '1.5rem' }}>
          <strong>No delivery address on file.</strong> Fans cannot check out until
          one exists, because every price is quoted against it.
        </div>
      )}

      <h2>Add a gift</h2>
      <div className="card">
        <form action={addItem}>
          <input type="hidden" name="creatorId" value={creator.id} />
          <input type="hidden" name="slug" value={creator.publicSlug} />

          <div className="field">
            <label htmlFor="url">
              Paste a product link. We check it with the provider rather than
              trusting the page, so a dead or unbuyable link is refused here
              instead of failing for a fan later.
            </label>
            <input
              id="url"
              name="url"
              type="url"
              placeholder="https://shop.example.com/products/thing?variant=123"
              autoComplete="off"
              required
            />
          </div>

          <button className="primary" type="submit">
            Add to wishlist
          </button>
        </form>
      </div>

      <h2>Wishlist ({creator.wishlistItems.length})</h2>

      {creator.wishlistItems.length === 0 ? (
        <div className="empty">Nothing here yet. Add your first gift above.</div>
      ) : (
        <div className="stack">
          {creator.wishlistItems.map((item) => {
            const ordered = item.quotes.length > 0;

            return (
              <div key={item.id} className="card">
                <div className="row">
                  <div>
                    <strong>{item.title}</strong>
                    {item.variantTitle ? (
                      <span className="muted"> · {item.variantTitle}</span>
                    ) : null}
                    <div className="muted small">
                      {item.merchantName ?? item.merchantId}
                    </div>
                  </div>
                  <span className="badge">{item.status}</span>
                </div>

                <div className="muted small" style={{ marginTop: '0.6rem' }}>
                  {/* Labelled, because it is not a price we will honour. */}
                  {item.lastPriceMinor === null ? (
                    'No indicative price yet'
                  ) : (
                    <span className="money">
                      {formatMoney(item.lastPriceMinor, item.currency)} indicative
                    </span>
                  )}{' '}
                  · checked {relativeTime(item.lastCheckedAt ?? item.createdAt)}
                </div>

                <div style={{ marginTop: '0.85rem' }}>
                  {ordered ? (
                    <span className="muted small">
                      A fan has ordered this, so it stays on record.
                    </span>
                  ) : (
                    <form action={removeItem}>
                      <input type="hidden" name="creatorId" value={creator.id} />
                      <input type="hidden" name="slug" value={creator.publicSlug} />
                      <input type="hidden" name="itemId" value={item.id} />
                      <button type="submit">Remove</button>
                    </form>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <h2>Delivery address</h2>
      <div className="card">
        <p className="muted small">
          {hasAddress ? (
            <>
              An address is on file, and quoting, checkout and dispatch all use it.
              It is stored encrypted: this page cannot read it back either. Save a
              replacement below whenever you move.
            </>
          ) : (
            <>
              No address on file yet, so nothing can be quoted and fans cannot
              order. Add one to open the wishlist for business.
            </>
          )}
        </p>

        <form action={saveAddress} style={{ marginTop: '1rem' }}>
          <input type="hidden" name="creatorId" value={creator.id} />
          <input type="hidden" name="slug" value={creator.publicSlug} />

          {ADDRESS_FIELDS.map((field) => (
            <div className="field" key={field.name}>
              <label htmlFor={field.name}>
                {field.label}
                {field.required ? null : <span className="muted small"> · optional</span>}
              </label>
              <input
                id={field.name}
                name={field.name}
                autoComplete={field.autoComplete}
                maxLength={field.maxLength}
                placeholder={field.placeholder ?? undefined}
                required={field.required}
              />
            </div>
          ))}

          <button className="primary" type="submit">
            {hasAddress ? 'Replace address' : 'Save address'}
          </button>
        </form>

        <p className="muted small" style={{ marginTop: '1rem' }}>
          Saving a new address invalidates approvals already given against the old
          one. Dispatch re-checks the destination against the address the fan’s
          quote was priced on, and refuses if it has moved.
        </p>
      </div>
    </main>
  );
}
