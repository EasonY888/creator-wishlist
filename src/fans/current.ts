import { cookies } from 'next/headers';

import { readSession, SESSION_COOKIE, type FanSession } from './auth';

/**
 * The signed-in fan, or null.
 *
 * Read on the server only. The cookie is httpOnly, so no client code can see it,
 * and nothing about the session is passed into a page's props — a page asks who
 * the fan is and decides for itself what to do about it.
 */
export async function currentFan(): Promise<FanSession | null> {
  const store = await cookies();
  return readSession(store.get(SESSION_COOKIE)?.value);
}

/** Where to send a fan to prove themselves, returning them afterwards. */
export function loginPathFor(returnTo: string): string {
  return `/fan/login?${new URLSearchParams({ next: returnTo }).toString()}`;
}
