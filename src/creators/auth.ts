import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Creator access to `/creator/{slug}`.
 *
 * Why this exists: that page can add and remove gifts and, more seriously,
 * **replace the creator's delivery address**. Until now it had no gate at all —
 * the creator id simply travelled in the form, which the actions said out loud:
 *
 *   "There is no creator authentication yet, so the creator id travels in the
 *    form. That is a known gap, not a finished access-control story."
 *
 * The gap was reachable without credentials: open the manage page, type your own
 * address, buy a gift, and it ships to you. Not a leak — the address is
 * write-only and never readable back — but a redirected delivery, which is the
 * one thing this product promises cannot happen.
 *
 * The credential is a **key in a private link**, not a password, because a
 * creator has no email on file and no account to recover. Holding the link is
 * being the creator. That is the same shape as the fan's checkout link, and it
 * is deliberately the *only* shape available: recovering a lost password needs an
 * email, and inventing an email on file is an onboarding story, not an auth one.
 *
 * Failure mode: with no `SESSION_SECRET`, nothing verifies, so `/creator/{slug}`
 * is **closed**. Same rule as `/ops` — an access control whose absence means
 * "allow everyone" is a doorman who went home.
 */

export const CREATOR_SESSION_COOKIE = 'creator_session';

/**
 * Ninety days.
 *
 * Longer than an operator's eight-hour shift, and longer than a fan's month. A
 * creator curates a wishlist occasionally over a season, and the cost of an
 * expired session is that they must find their link again — which is precisely
 * the artefact they are most likely to have lost.
 */
export const CREATOR_SESSION_SECONDS = 90 * 24 * 60 * 60;

export class CreatorAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreatorAuthError';
  }
}

/**
 * The signing key.
 *
 * Derived from `SESSION_SECRET` with its own domain separator, so a creator
 * cookie can never be valid as an operator cookie or a fan cookie even though
 * all three are HMACs over a similar payload. Sharing a key without a separator
 * is how one system's token becomes another system's credential.
 */
function signingKey(): Buffer {
  const base = process.env.SESSION_SECRET;
  if (!base || base.length < 16) {
    throw new CreatorAuthError(
      'SESSION_SECRET must be set to at least 16 characters. It signs creator sessions.',
    );
  }
  return createHmac('sha256', base).update('creator-session-v1').digest();
}

function signatureFor(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Compare the key from a link against the one on the row.
 *
 * Constant time, for the same reason the operator password is: the cost of doing
 * it right is one line, and the cost of doing it wrong is a key recovered one
 * character at a time.
 */
export function creatorKeyMatches(
  provided: string | undefined | null,
  expected: string,
): boolean {
  if (!provided) return false;
  return safeEqual(provided, expected);
}

/**
 * A session is bound to one creator.
 *
 * The id rides inside the signed payload rather than in a separate cookie, so
 * holding creator A's cookie cannot be replayed against creator B's page — the
 * page compares the id it reads against the id it is rendering.
 */
export function signCreatorSession(creatorId: string, now = new Date()): string {
  const expiresAt = Math.floor(now.getTime() / 1000) + CREATOR_SESSION_SECONDS;
  const nonce = randomBytes(12).toString('base64url');
  const payload = `${expiresAt}.${nonce}.${creatorId}`;
  return `${payload}.${signatureFor(payload)}`;
}

/**
 * Verify a session cookie and return whose it is.
 *
 * Fails closed on every branch: a malformed cookie, a missing secret and an
 * expired token are all "not a creator" rather than an error a caller might be
 * tempted to treat as retryable.
 */
export function readCreatorSession(
  value: string | undefined | null,
): { creatorId: string } | null {
  if (!value) return null;

  const parts = value.split('.');
  // Four at minimum: expiry, nonce, id, signature. The check is `< 4` and not
  // `!== 4` because the id is joined back up below -- an id that itself contains
  // a dot would otherwise shift every part along and, worse, still verify.
  if (parts.length < 4) return null;

  const signature = parts[parts.length - 1] as string;
  const expiry = parts[0] as string;
  const nonce = parts[1] as string;
  /** Everything between the nonce and the signature, reassembled. */
  const creatorId = parts.slice(2, -1).join('.');

  const payload = `${expiry}.${nonce}.${creatorId}`;

  let expected: string;
  try {
    expected = signatureFor(payload);
  } catch {
    return null;
  }

  if (!safeEqual(expected, signature)) return null;

  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt)) return null;
  if (expiresAt * 1000 <= Date.now()) return null;

  if (creatorId.length === 0) return null;

  return { creatorId };
}

export function creatorCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // Only over TLS when the app itself is served over TLS. `localhost` over
    // http is not a threat model a Secure flag improves.
    secure: process.env.APP_URL?.startsWith('https://') ?? false,
    path: '/',
    maxAge: CREATOR_SESSION_SECONDS,
  };
}
