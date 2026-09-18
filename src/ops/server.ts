import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { OPS_SESSION_COOKIE, opsConfigured, readOpsSession } from './auth';

/**
 * Server-side operator gate.
 *
 * Deliberately NOT middleware. Middleware can redirect a page render, but it
 * cannot make a server action safe: an action is addressable by its own id and a
 * crafted POST never has to render a page first. Since the things `/ops` can do
 * include moving money, the check has to sit where the money is, which means at
 * the top of every action as well as on the page.
 *
 * (Middleware would also drag this file onto the Edge runtime, where `node:crypto`
 * HMAC is not dependable. Not the reason for the design, but a fair bonus.)
 */

export async function isOperator(): Promise<boolean> {
  // No configured password means no operators. Not "everyone is an operator".
  if (!opsConfigured()) return false;

  const jar = await cookies();
  return readOpsSession(jar.get(OPS_SESSION_COOKIE)?.value);
}

/**
 * Redirect an unauthenticated caller to the sign-in page.
 *
 * Used by the page and by every mutating action, so a new action added later
 * fails closed by default: forgetting to call this is a visible omission at the
 * top of an action, rather than a silently public endpoint.
 */
export async function requireOperator(): Promise<void> {
  if (!(await isOperator())) {
    redirect('/ops/login');
  }
}
