import Link from 'next/link';

/**
 * The 404 page — an app-level one, because Next's built-in default is unstyled
 * and renders as a bare black page with no layout. That is a bad thing to land
 * on mid-demo, and it is reachable by accident: the order pages call `notFound()`
 * when the browser has no fan session for that order, so any order URL opened
 * while signed out lands here.
 *
 * **The wording is deliberately identical for both cases** — a URL that matches
 * nothing, and an order that exists but is not yours. Distinguishing them would
 * turn this page into a way to confirm an order exists by guessing its id, which
 * is the exact thing the ownership check is there to prevent. So it says the same
 * sentence either way, and offers the one action that resolves the second case.
 */
export default function NotFound() {
  return (
    <main>
      <p className="small">
        <Link href="/">&larr; All creators</Link>
      </p>

      <div className="hero">
        <h1>We couldn&rsquo;t find that page</h1>
        <p className="muted lede">
          The link may be out of date, or it may be an order you are not signed in to.
        </p>
      </div>

      <div className="notice notice-info">
        If a gift was sent to you, <Link href="/fan/login">sign in with the email address</Link>{' '}
        you used and the order will appear. Nothing has been charged or lost — this is only a
        page we could not open for you.
      </div>

      <p style={{ marginTop: '1.5rem' }}>
        <Link className="button primary" href="/">
          Back to the wishlists
        </Link>
      </p>
    </main>
  );
}
