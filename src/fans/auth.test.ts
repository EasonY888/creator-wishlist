import { beforeAll, describe, expect, it } from 'vitest';

import {
  looksLikeEmail,
  normalizeEmail,
  readSession,
  signSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from './auth';

/**
 * Session signing, which is the part of fan auth that is pure and therefore worth
 * testing here. The code-issuing flow needs a database and lives in
 * `scripts/smoke-fan-auth.ts`.
 *
 * A session cookie is a bearer token: whoever holds a valid one is that fan. So
 * the entire security property is that it cannot be forged or edited, and these
 * tests are all variations on exactly that.
 */

beforeAll(() => {
  // 32 chars, comfortably over the 16 minimum the module enforces.
  process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-ok';
});

describe('email normalisation', () => {
  it('folds case, so one address is one identity', () => {
    // Otherwise a fan cannot find their own order because they capitalised a
    // letter the second time.
    expect(normalizeEmail('Fan@Example.COM')).toBe('fan@example.com');
    expect(normalizeEmail('fan@example.com')).toBe(normalizeEmail('FAN@EXAMPLE.COM'));
  });

  it('trims, because a pasted address carries whitespace', () => {
    expect(normalizeEmail('  fan@example.com  ')).toBe('fan@example.com');
  });

  it('accepts the shapes people actually type', () => {
    for (const value of ['a@b.co', 'first.last+tag@sub.example.co.uk']) {
      expect(looksLikeEmail(value)).toBe(true);
    }
  });

  it('rejects the ones that cannot be delivered to', () => {
    for (const value of ['', 'fan', 'fan@', '@example.com', 'fan@example', 'a b@c.com']) {
      expect(looksLikeEmail(value)).toBe(false);
    }
  });
});

describe('a signed session round trips', () => {
  it('returns the fan it was signed for', () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const session = readSession(signSession('fan@example.com', expiresAt));

    expect(session?.fanId).toBe('fan@example.com');
  });

  it('preserves an address that needs encoding', () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const weird = 'a+b.c@example.com';

    expect(readSession(signSession(weird, expiresAt))?.fanId).toBe(weird);
  });
});

describe('a session cannot be forged or edited', () => {
  it('rejects a value signed with a different secret', () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const original = process.env.SESSION_SECRET;

    const forged = signSession('attacker@example.com', expiresAt);
    process.env.SESSION_SECRET = 'a-completely-different-secret-value';

    expect(readSession(forged)).toBeNull();

    process.env.SESSION_SECRET = original;
  });

  it('rejects an edited identity', () => {
    // The signature covers the payload, so swapping the address invalidates it.
    const expiresAt = new Date(Date.now() + 60_000);
    const signed = signSession('fan@example.com', expiresAt);
    const [, expiry, signature] = signed.split('.');

    const swapped = `${Buffer.from('attacker@example.com').toString('base64url')}.${expiry}.${signature}`;

    expect(readSession(swapped)).toBeNull();
  });

  it('rejects an extended expiry', () => {
    const signed = signSession('fan@example.com', new Date(Date.now() + 60_000));
    const [encoded, , signature] = signed.split('.');

    const extended = `${encoded}.${Math.floor(Date.now() / 1000) + 999_999}.${signature}`;

    expect(readSession(extended)).toBeNull();
  });

  it('rejects an expired session even though it is correctly signed', () => {
    const past = new Date(Date.now() - 1000);

    expect(readSession(signSession('fan@example.com', past))).toBeNull();
  });

  it('rejects malformed values without throwing', () => {
    // Total on purpose: nothing useful distinguishes these, and guessing is not
    // an option.
    for (const value of [
      undefined,
      null,
      '',
      'garbage',
      'a.b',
      'a.b.c.d',
      '..',
      'not-base64.not-a-number.sig',
    ]) {
      expect(readSession(value as string | null | undefined)).toBeNull();
    }
  });

  it('rejects an empty identity', () => {
    const signed = signSession('', new Date(Date.now() + 60_000));

    expect(readSession(signed)).toBeNull();
  });
});

describe('the refusal to guess when unconfigured', () => {
  it('trusts nothing without a secret', () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const signed = signSession('fan@example.com', expiresAt);
    const original = process.env.SESSION_SECRET;

    process.env.SESSION_SECRET = '';

    // A missing secret must not mean "no verification" -- that would be the worst
    // possible failure mode.
    expect(readSession(signed)).toBeNull();

    process.env.SESSION_SECRET = original;
  });
});

describe('cookie attributes', () => {
  it('is httpOnly and lax, and not secure over plain HTTP', () => {
    const options = sessionCookieOptions(new Date(Date.now() + 60_000));

    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
  });

  it('sets secure when the app is served over HTTPS', () => {
    const original = process.env.APP_URL;
    process.env.APP_URL = 'https://wishlist.example.com';

    expect(sessionCookieOptions(new Date()).secure).toBe(true);

    process.env.APP_URL = original;
  });
});

describe('the cookie name', () => {
  it('is stable, because changing it silently signs everyone out', () => {
    expect(SESSION_COOKIE).toBe('fan_session');
  });
});
