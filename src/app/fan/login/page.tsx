import Link from 'next/link';

import { requestCode, verifyCode } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Where a fan proves they own the email address on their order.
 *
 * Two steps rather than one, because a code cannot be checked before it has been
 * requested. The address carries between them in a query parameter — it is not a
 * secret, and making the fan retype it would only introduce typos.
 *
 * The `next` destination is preserved throughout so a fan mid-checkout returns to
 * the exact place they left.
 */
export default async function FanLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; email?: string; sent?: string; problem?: string }>;
}) {
  const { next, email, sent, problem } = await searchParams;
  const destination = next ?? '/';
  const awaitingCode = sent === '1' && Boolean(email);

  return (
    <main>
      <p className="small">
        <Link href="/">&larr; Home</Link>
      </p>

      <div className="hero">
        <h1>{awaitingCode ? 'Enter your code' : 'Confirm your email'}</h1>

        <p className="muted">
          {awaitingCode ? (
            <>
              We sent a six-digit code to <strong>{email}</strong>. It expires in ten
              minutes.
            </>
          ) : (
            <>
              Fans pay without an account, so we confirm your email instead. Without
              it we cannot tell you if a gift becomes unavailable, or show you an
              order you placed.
            </>
          )}
        </p>
      </div>

      {problem ? (
        <div className="notice notice-warn" style={{ marginBottom: '1.5rem' }}>
          {problem}
        </div>
      ) : null}

      {awaitingCode ? (
        <div className="card">
          <form action={verifyCode}>
            <input type="hidden" name="next" value={destination} />
            <input type="hidden" name="email" value={email} />

            <div className="field">
              <label htmlFor="code">Six-digit code</label>
              <input
                id="code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                placeholder="000000"
                required
                autoFocus
              />
            </div>

            <button className="primary" type="submit">
              Confirm and continue
            </button>
          </form>

          <form action={requestCode} style={{ marginTop: '0.85rem' }}>
            <input type="hidden" name="next" value={destination} />
            <input type="hidden" name="email" value={email} />
            <button type="submit">Send a new code</button>
          </form>
        </div>
      ) : (
        <div className="card">
          <form action={requestCode}>
            <input type="hidden" name="next" value={destination} />

            <div className="field">
              <label htmlFor="email">Your email address</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                autoFocus
              />
            </div>

            <button className="primary" type="submit">
              Send me a code
            </button>
          </form>
        </div>
      )}

      <p className="muted small" style={{ marginTop: '1.5rem' }}>
        We only use this to reach you about your own orders. It is never shown to
        the creator, and never appears on anything they can see.
      </p>
    </main>
  );
}
