/**
 * Fan identity.
 *
 * FR-7.1 lets anyone browse a wishlist but requires a fan to authenticate before
 * paying. FR-7.3 has us tell them if a gift becomes unavailable. Both need an
 * address we have actually verified, and an email typed into a form verifies
 * nothing — anyone can type someone else's.
 *
 * So the fan proves control of the address by returning a code sent to it. The
 * code is hashed at rest, single-use, short-lived, and attempt-limited; those are
 * not embellishments, they are what makes a six-digit secret safe.
 *
 * ## What is real and what is stubbed
 *
 * The verification is real. The **delivery channel is stubbed** — `deliver` logs
 * the code instead of emailing it — because sending mail needs a provider and a
 * key, which is a deployment decision rather than a code one. Swapping the log
 * for a transport is the single change needed to make this production-ready, and
 * it is the only fake in this file.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import type { Db } from '../db/types';
import { sendLoginCode } from './email';

export const SESSION_COOKIE = 'fan_session';

/** Ten minutes: long enough to switch to an inbox, short enough to matter. */
const CODE_TTL_SECONDS = 600;

/**
 * Five attempts against a six-digit code. The odds of guessing inside five tries
 * are about one in 200,000, and the code dies on the sixth regardless.
 */
const MAX_ATTEMPTS = 5;

/**
 * How long a session lasts once established.
 *
 * Not short: a fan buying a gift and then checking its status should not have to
 * prove themselves again mid-flow.
 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface FanSession {
  /** The normalised email. Also the `fanId` recorded on orders. */
  fanId: string;
  expiresAt: Date;
}

// ---------------------------------------------------------------------------
// The secret
// ---------------------------------------------------------------------------

/**
 * Read at call time rather than module load, so a missing value surfaces as a
 * request error rather than a build failure.
 */
function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 16) {
    throw new Error(
      'SESSION_SECRET must be set to at least 16 characters. It signs fan sessions and peppers login codes.',
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Email and codes
// ---------------------------------------------------------------------------

/**
 * Normalise before anything else touches it.
 *
 * Two spellings of one address must be one identity, or a fan cannot find their
 * own order because they capitalised a letter the second time.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Deliberately permissive: the code is what proves the address, not the shape. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function codeHash(email: string, code: string): string {
  // The secret is a pepper, so a leaked table alone does not allow offline
  // guessing. The email binds the hash to one address.
  return createHmac('sha256', secret()).update(`${email}:${code}`).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Length is not secret, but timingSafeEqual throws on a mismatch, so guard it.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Where a code goes.
 *
 * Now delegates to `fans/email.ts`, which sends through the provider when one is
 * configured and falls back to logging in development. Checked in rather than
 * left as a local stub because the fallback has a rule attached: it refuses to
 * log a login code when `NODE_ENV=production`, since a credential in a log file
 * is an account for anyone who can read one.
 *
 * Kept as a named export with this signature so `requestLoginCode`'s `send` seam
 * is unchanged -- that is what let the stubbed version and the real one be
 * swapped without touching the flow.
 */
export async function deliver(args: {
  email: string;
  code: string;
  expiresAt: Date;
}): Promise<void> {
  await sendLoginCode(args);
}

export type RequestCodeOutcome =
  | { state: 'sent'; email: string; expiresAt: Date }
  | { state: 'invalid_email'; reason: string };

/**
 * Issue a code for an address, invalidating any earlier one.
 *
 * Issuing a fresh code retires the previous one rather than leaving several live
 * at once: a fan who requests twice should not have two ways in.
 *
 * `send` is injectable so the flow can be exercised without an email provider.
 * That is the same seam a test would need and a deployment would use, rather than
 * a hook that exists only for tests.
 */
export async function requestLoginCode(
  db: Db,
  rawEmail: string,
  options: { send?: typeof deliver } = {},
): Promise<RequestCodeOutcome> {
  const email = normalizeEmail(rawEmail);

  if (!looksLikeEmail(email)) {
    return { state: 'invalid_email', reason: 'That does not look like an email address.' };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000);

  await db.$transaction(async (tx) => {
    // Retire anything still outstanding, so exactly one code is ever live.
    await tx.fanLoginCode.updateMany({
      where: { email, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await tx.fanLoginCode.create({
      data: { email, codeHash: codeHash(email, code), expiresAt },
    });
  });

  await (options.send ?? deliver)({ email, code, expiresAt });

  return { state: 'sent', email, expiresAt };
}

export type VerifyOutcome =
  | { state: 'verified'; fanId: string }
  | { state: 'no_code'; reason: string }
  | { state: 'expired'; reason: string }
  | { state: 'too_many_attempts'; reason: string }
  | { state: 'wrong_code'; reason: string; attemptsRemaining: number };

/**
 * Check a code and, on success, consume it.
 *
 * The failure reasons are deliberately distinguishable to the SERVER and not to
 * the fan beyond "that code is not right". Telling a caller whether an address
 * has a pending code would turn this into an account-enumeration oracle.
 */
export async function verifyLoginCode(
  db: Db,
  rawEmail: string,
  rawCode: string,
): Promise<VerifyOutcome> {
  const email = normalizeEmail(rawEmail);
  const code = rawCode.trim();

  const record = await db.fanLoginCode.findFirst({
    where: { email, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) {
    return { state: 'no_code', reason: 'Request a code first.' };
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    return { state: 'too_many_attempts', reason: 'Too many attempts. Request a new code.' };
  }

  if (record.expiresAt.getTime() < Date.now()) {
    return { state: 'expired', reason: 'That code has expired. Request a new one.' };
  }

  if (!safeEqual(record.codeHash, codeHash(email, code))) {
    const attempts = record.attempts + 1;

    await db.fanLoginCode.update({
      where: { id: record.id },
      data: { attempts },
    });

    return {
      state: 'wrong_code',
      reason: 'That code is not right.',
      attemptsRemaining: Math.max(0, MAX_ATTEMPTS - attempts),
    };
  }

  // Consumed in the same breath as being accepted, so a replayed code cannot
  // establish a second session.
  await db.fanLoginCode.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  });

  return { state: 'verified', fanId: email };
}

// ---------------------------------------------------------------------------
// The session cookie
// ---------------------------------------------------------------------------

/**
 * Sign a session value as `email.expiry.signature`.
 *
 * The signature covers both parts, so neither the identity nor the expiry can be
 * edited by whoever holds the cookie.
 */
export function signSession(fanId: string, expiresAt: Date): string {
  const payload = `${Buffer.from(fanId, 'utf8').toString('base64url')}.${Math.floor(
    expiresAt.getTime() / 1000,
  )}`;

  const signature = createHmac('sha256', secret()).update(payload).digest('base64url');

  return `${payload}.${signature}`;
}

/**
 * Read a session, or return null.
 *
 * Total: every malformed, tampered or expired value is simply "not signed in",
 * because there is nothing useful a caller can do with the distinction and
 * nothing safe about guessing.
 */
export function readSession(value: string | undefined | null): FanSession | null {
  if (!value) return null;

  const parts = value.split('.');
  if (parts.length !== 3) return null;

  const [encoded, expiry, signature] = parts as [string, string, string];
  const payload = `${encoded}.${expiry}`;

  let expected: string;
  try {
    expected = createHmac('sha256', secret()).update(payload).digest('base64url');
  } catch {
    // No secret configured. Nothing can be verified, so nothing is trusted.
    return null;
  }

  if (!safeEqual(expected, signature)) return null;

  const expiresAtSeconds = Number(expiry);
  if (!Number.isFinite(expiresAtSeconds)) return null;

  const expiresAt = new Date(expiresAtSeconds * 1000);
  if (expiresAt.getTime() <= Date.now()) return null;

  let fanId: string;
  try {
    fanId = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  if (fanId.length === 0) return null;

  return { fanId, expiresAt };
}

/** Cookie attributes, in one place so a route cannot weaken them by accident. */
export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    // `secure` would break plain-HTTP localhost, so it follows the protocol in
    // use rather than being hardcoded either way.
    secure: (process.env.APP_URL ?? '').startsWith('https://'),
    path: '/',
    expires: expiresAt,
  };
}
