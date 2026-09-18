import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OPS_SESSION_SECONDS,
  checkPassword,
  opsConfigured,
  opsCookieOptions,
  opsPassword,
  readOpsSession,
  signOpsSession,
} from './auth';

/**
 * Operator access control.
 *
 * The tests that matter most are the fail-closed ones. A password gate that
 * breaks open when misconfigured is indistinguishable from no gate at all until
 * the moment it counts, so "no password set" is asserted to mean *nobody* gets
 * in, not everybody.
 */

const ORIGINAL = { ...process.env };

const GOOD_SECRET = 'a'.repeat(32);
const GOOD_PASSWORD = 'correct-horse-battery-staple';

beforeEach(() => {
  process.env.SESSION_SECRET = GOOD_SECRET;
  process.env.OPS_PASSWORD = GOOD_PASSWORD;
  delete process.env.APP_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('configuration', () => {
  it('reports the password when it is long enough', () => {
    expect(opsPassword()).toBe(GOOD_PASSWORD);
    expect(opsConfigured()).toBe(true);
  });

  it('treats an absent password as unconfigured', () => {
    delete process.env.OPS_PASSWORD;
    expect(opsPassword()).toBeNull();
    expect(opsConfigured()).toBe(false);
  });

  it('treats a too-short password as unconfigured rather than weak-but-usable', () => {
    process.env.OPS_PASSWORD = 'short';
    expect(opsPassword()).toBeNull();
    expect(opsConfigured()).toBe(false);
  });

  it('treats an empty password as unconfigured', () => {
    process.env.OPS_PASSWORD = '';
    expect(opsConfigured()).toBe(false);
  });
});

describe('password check', () => {
  it('accepts the configured password', () => {
    expect(checkPassword(GOOD_PASSWORD)).toBe(true);
  });

  it('rejects a wrong password', () => {
    expect(checkPassword('not-the-password')).toBe(false);
  });

  it('rejects a prefix of the password', () => {
    expect(checkPassword(GOOD_PASSWORD.slice(0, -1))).toBe(false);
  });

  it('rejects a password of a different length without throwing', () => {
    // timingSafeEqual throws on a length mismatch; that must be caught, not
    // surfaced as a 500 that tells an attacker they found the right length.
    expect(() => checkPassword('x')).not.toThrow();
    expect(checkPassword('x')).toBe(false);
  });

  it('rejects everything when no password is configured', () => {
    delete process.env.OPS_PASSWORD;
    expect(checkPassword('')).toBe(false);
    expect(checkPassword(GOOD_PASSWORD)).toBe(false);
    expect(checkPassword('anything at all')).toBe(false);
  });
});

describe('session cookie', () => {
  it('round-trips a freshly signed session', () => {
    expect(readOpsSession(signOpsSession())).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const cookie = signOpsSession();
    const parts = cookie.split('.');
    const forged = `${parts[0]}.${parts[1]}.${'A'.repeat(43)}`;
    expect(readOpsSession(forged)).toBe(false);
  });

  it('rejects an extended expiry with the original signature', () => {
    // The payload is inside the signature, so moving the expiry forward must
    // invalidate it. If this passes, the session is forgeable.
    const cookie = signOpsSession();
    const parts = cookie.split('.');
    const future = Math.floor(Date.now() / 1000) + OPS_SESSION_SECONDS * 100;
    expect(readOpsSession(`${future}.${parts[1]}.${parts[2]}`)).toBe(false);
  });

  it('rejects an expired session', () => {
    const past = new Date(Date.now() - (OPS_SESSION_SECONDS + 60) * 1000);
    expect(readOpsSession(signOpsSession(past))).toBe(false);
  });

  it('rejects null, empty and malformed values without throwing', () => {
    for (const value of [null, undefined, '', 'nonsense', 'a.b', 'a.b.c.d', '...']) {
      expect(() => readOpsSession(value)).not.toThrow();
      expect(readOpsSession(value)).toBe(false);
    }
  });

  it('rejects a session signed with a different secret', () => {
    const cookie = signOpsSession();
    process.env.SESSION_SECRET = 'b'.repeat(32);
    expect(readOpsSession(cookie)).toBe(false);
  });

  it('fails closed when SESSION_SECRET is missing', () => {
    const cookie = signOpsSession();
    delete process.env.SESSION_SECRET;
    expect(readOpsSession(cookie)).toBe(false);
    // Signing cannot work either, and must not silently produce something that
    // verifies against an empty key.
    expect(() => signOpsSession()).toThrow();
  });

  it('issues a distinct signature each time, so one cookie is not a template', () => {
    expect(signOpsSession()).not.toBe(signOpsSession());
  });
});

describe('cookie options', () => {
  it('is httpOnly and not Secure over plain http', () => {
    const options = opsCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.secure).toBe(false);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
  });

  it('sets Secure when the app is served over TLS', () => {
    process.env.APP_URL = 'https://example.test';
    expect(opsCookieOptions().secure).toBe(true);
  });

  it('expires within a working shift', () => {
    expect(opsCookieOptions().maxAge).toBe(OPS_SESSION_SECONDS);
    expect(OPS_SESSION_SECONDS).toBeLessThanOrEqual(12 * 60 * 60);
  });
});
