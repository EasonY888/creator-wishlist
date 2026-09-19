import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CREATOR_SESSION_SECONDS,
  CreatorAuthError,
  creatorKeyMatches,
  readCreatorSession,
  signCreatorSession,
} from './auth';

const SECRET = 'test-secret-long-enough-to-pass';
const original = process.env.SESSION_SECRET;

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
});

afterEach(() => {
  if (original === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = original;
});

describe('creatorKeyMatches', () => {
  it('accepts the key it was given', () => {
    expect(creatorKeyMatches('abc-123', 'abc-123')).toBe(true);
  });

  it('rejects a different key of the same length', () => {
    expect(creatorKeyMatches('abc-124', 'abc-123')).toBe(false);
  });

  it('rejects a missing key', () => {
    expect(creatorKeyMatches(undefined, 'abc-123')).toBe(false);
    expect(creatorKeyMatches(null, 'abc-123')).toBe(false);
    expect(creatorKeyMatches('', 'abc-123')).toBe(false);
  });

  it('rejects a prefix of the real key', () => {
    // A truncation must not read as a match -- it is the shape a naive
    // `startsWith` check would let through.
    expect(creatorKeyMatches('abc-12', 'abc-123')).toBe(false);
  });

  it('rejects an empty stored key rather than treating it as open', () => {
    // A creator row with no key must never be enterable by sending no key.
    expect(creatorKeyMatches('', '')).toBe(false);
  });
});

describe('creator sessions', () => {
  it('round-trips the creator it was signed for', () => {
    const cookie = signCreatorSession('creator_1');
    expect(readCreatorSession(cookie)).toEqual({ creatorId: 'creator_1' });
  });

  it('survives an id containing dots', () => {
    // The payload is split on '.', so an id with one in it must not be able to
    // shift the parts and land on a different creator.
    const cookie = signCreatorSession('creator.with.dots');
    expect(readCreatorSession(cookie)).toEqual({ creatorId: 'creator.with.dots' });
  });

  it('rejects a tampered signature', () => {
    const cookie = signCreatorSession('creator_1');
    const [expiry, nonce, id] = cookie.split('.');
    expect(readCreatorSession(`${expiry}.${nonce}.${id}.not-a-signature`)).toBeNull();
  });

  it('rejects an edited creator id, because the id is inside the signature', () => {
    const cookie = signCreatorSession('creator_1');
    const [, nonce, , signature] = cookie.split('.');
    const expiry = Math.floor(Date.now() / 1000) + 60;
    // Same signature, different id -- the forged-cookie case.
    expect(
      readCreatorSession(`${expiry}.${nonce}.creator_2.${signature}`),
    ).toBeNull();
  });

  it('rejects an expired session', () => {
    const past = new Date(Date.now() - (CREATOR_SESSION_SECONDS + 60) * 1000);
    expect(readCreatorSession(signCreatorSession('creator_1', past))).toBeNull();
  });

  it('rejects a malformed cookie', () => {
    expect(readCreatorSession('')).toBeNull();
    expect(readCreatorSession(undefined)).toBeNull();
    expect(readCreatorSession('nonsense')).toBeNull();
    expect(readCreatorSession('a.b.c')).toBeNull();
  });

  it('rejects an operator cookie', () => {
    // Domain separation. Both are HMACs over SESSION_SECRET; only the separator
    // stops one being replayed as the other.
    const opsLike = `${Math.floor(Date.now() / 1000) + 60}.nonce`;
    expect(readCreatorSession(`${opsLike}.signature`)).toBeNull();
  });

  it('refuses to sign without a usable secret', () => {
    delete process.env.SESSION_SECRET;
    expect(() => signCreatorSession('creator_1')).toThrow(CreatorAuthError);
  });

  it('fails closed on read without a usable secret', () => {
    const cookie = signCreatorSession('creator_1');
    delete process.env.SESSION_SECRET;
    expect(readCreatorSession(cookie)).toBeNull();
  });

  it('rejects a short secret rather than signing with it', () => {
    process.env.SESSION_SECRET = 'too-short';
    expect(() => signCreatorSession('creator_1')).toThrow(CreatorAuthError);
  });
});
