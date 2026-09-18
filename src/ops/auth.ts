import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Operator access to `/ops`.
 *
 * Why this exists: `/ops` can refund a fan, charge a merchant and declare an order
 * terminally complete. It has no user model, so this is a **shared secret**, which
 * is a deliberately interim measure -- it proves *that* the caller is an operator,
 * not *which* operator. Recording who did what still depends on a real identity,
 * which is why the refund actor remains a constant string.
 *
 * The property that matters most here is the failure mode: with no password
 * configured, `/ops` is **closed**, not open. An access control whose absence
 * silently means "allow everyone" is worse than none, because it looks like a
 * control in the code and behaves like a doorman who went home.
 */

export const OPS_SESSION_COOKIE = 'ops_session';

/** Eight hours -- a working shift, not a month. Operators are not browsers. */
export const OPS_SESSION_SECONDS = 8 * 60 * 60;

export class OpsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpsAuthError';
  }
}

/**
 * The configured operator password, or null when unset.
 *
 * Read at call time rather than module load, so a missing value is a request
 * error rather than a build failure -- and so the middleware can distinguish
 * "misconfigured" from "wrong password".
 */
export function opsPassword(): string | null {
  const value = process.env.OPS_PASSWORD;
  if (!value || value.length < 16) return null;
  return value;
}

export function opsConfigured(): boolean {
  return opsPassword() !== null;
}

/**
 * The signing key.
 *
 * Derived from `SESSION_SECRET` with a domain separator rather than used raw, so
 * an ops cookie and a fan cookie can never be valid for each other's audience
 * even though both are HMACs over a similar payload shape. Sharing the key
 * without a prefix is how one system's token becomes another's credential.
 */
function signingKey(): Buffer {
  const base = process.env.SESSION_SECRET;
  if (!base || base.length < 16) {
    throw new OpsAuthError(
      'SESSION_SECRET must be set to at least 16 characters. It signs operator sessions.',
    );
  }
  return createHmac('sha256', base).update('ops-session-v1').digest();
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
 * Check a submitted password in constant time.
 *
 * Constant time matters less against a network attacker than against a local one,
 * but the cost of doing it right is one line and the cost of doing it wrong is a
 * password recoverable a character at a time.
 */
export function checkPassword(candidate: string): boolean {
  const expected = opsPassword();
  if (expected === null) return false;
  return safeEqual(candidate, expected);
}

export function signOpsSession(now = new Date()): string {
  const expiresAt = Math.floor(now.getTime() / 1000) + OPS_SESSION_SECONDS;
  const nonce = randomBytes(12).toString('base64url');
  const payload = `${expiresAt}.${nonce}`;
  return `${payload}.${signatureFor(payload)}`;
}

/**
 * Verify a session cookie.
 *
 * Fails closed on every branch. A malformed cookie, a missing secret and an
 * expired token are all "not an operator" -- never an error the caller might be
 * tempted to treat as a retry.
 */
export function readOpsSession(value: string | undefined | null): boolean {
  if (!value) return false;

  const parts = value.split('.');
  if (parts.length !== 3) return false;

  const [expiry, nonce, signature] = parts as [string, string, string];
  const payload = `${expiry}.${nonce}`;

  let expected: string;
  try {
    expected = signatureFor(payload);
  } catch {
    return false;
  }

  if (!safeEqual(expected, signature)) return false;

  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt)) return false;

  return expiresAt * 1000 > Date.now();
}

export function opsCookieOptions(): {
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
    // http is not a threat model that a Secure flag improves.
    secure: process.env.APP_URL?.startsWith('https://') ?? false,
    path: '/',
    maxAge: OPS_SESSION_SECONDS,
  };
}
