import { opsConfigured } from '@/ops/auth';

import { signIn } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Operator sign-in.
 *
 * The unconfigured case is rendered as an explanation rather than redirecting
 * onwards, because a redirect loop between "not signed in" and "cannot sign in"
 * tells an operator nothing and looks like a bug in the app rather than a gap in
 * the deployment.
 */
export default async function OpsLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string }>;
}) {
  const { problem } = await searchParams;
  const configured = opsConfigured();

  return (
    <main>
      <div className="hero">
        <h1>Operator sign-in</h1>
        <p className="muted">
          This queue can refund a fan, charge a merchant and close an order. It is
          not for fans.
        </p>
      </div>

      {problem ? (
        <div className="notice notice-warn" style={{ marginBottom: '1.5rem' }}>
          {problem}
        </div>
      ) : null}

      {configured ? (
        <div className="card">
          <form action={signIn}>
            <div className="field">
              <label htmlFor="password">Operator password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                autoFocus
              />
            </div>

            <button className="primary" type="submit">
              Sign in
            </button>
          </form>
        </div>
      ) : (
        <div className="notice notice-warn">
          <strong>Operator access is not configured.</strong> Set{' '}
          <code>OPS_PASSWORD</code> to at least 16 characters and restart the app.
          Until then this queue is closed to everyone, including you &mdash; a
          missing password means closed, not open.
        </div>
      )}
    </main>
  );
}
