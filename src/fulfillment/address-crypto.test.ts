import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  AddressCryptoError,
  decryptAddress,
  decryptOptional,
  encryptAddress,
  encryptOptional,
  isEncrypted,
  keyId,
  keysFromEnv,
  type AddressKeys,
} from './address-crypto';

/**
 * The address at rest.
 *
 * Every failure here is silent in production unless it is loud here: an address
 * that decrypts to the wrong thing gets dispatched to the wrong person, and an
 * unencrypted row looks identical to an encrypted one until somebody opens the
 * database.
 */

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

const keysA: AddressKeys = { current: KEY_A, previous: [] };

const STREET = '1 Test Street, Apt 4';

describe('a round trip', () => {
  it('returns what went in', () => {
    expect(decryptAddress(encryptAddress(STREET, keysA), keysA)).toBe(STREET);
  });

  it('survives unicode, because addresses have accents', () => {
    const address = '12 Rue de la République, Québec';

    expect(decryptAddress(encryptAddress(address, keysA), keysA)).toBe(address);
  });

  it('survives an empty string', () => {
    expect(decryptAddress(encryptAddress('', keysA), keysA)).toBe('');
  });

  it('produces different ciphertext each time', () => {
    // A deterministic cipher would let anyone holding the database tell which two
    // fans live at the same address, by looking for identical values.
    const one = encryptAddress(STREET, keysA);
    const two = encryptAddress(STREET, keysA);

    expect(one).not.toBe(two);
    expect(decryptAddress(one, keysA)).toBe(decryptAddress(two, keysA));
  });

  it('does not contain the plaintext', () => {
    expect(encryptAddress(STREET, keysA)).not.toContain('Test Street');
  });
});

describe('the format', () => {
  it('is recognisable as ours', () => {
    expect(isEncrypted(encryptAddress(STREET, keysA))).toBe(true);
    expect(isEncrypted(STREET)).toBe(false);
  });

  it('records which key encrypted it, so rotation is possible', () => {
    const payload = encryptAddress(STREET, keysA);

    expect(payload.split('.')[1]).toBe(keyId(KEY_A));
    expect(payload.startsWith('v1.')).toBe(true);
  });

  it('gives different keys different ids', () => {
    expect(keyId(KEY_A)).not.toBe(keyId(KEY_B));
  });
});

describe('tampering is detected', () => {
  /**
   * Flip one bit of one real byte, via a decode/re-encode round trip.
   *
   * This deliberately does NOT rewrite a character in place. In a base64 group
   * that encodes a single trailing byte, the last character's low four bits are
   * padding and carry nothing -- so `A`, `B`, `C` and `D` all decode to the same
   * byte. Swapping one for another produces an identical tag, nothing has been
   * tampered with, and the decryption that "should" fail correctly succeeds.
   *
   * That is how these tests were flaky: roughly a 1-in-20 chance of hitting a
   * padding character and passing for the wrong reason. Working on the decoded
   * bytes removes the whole class of problem.
   */
  function flipOneBit(encoded: string): string {
    const bytes = Buffer.from(encoded, 'base64url');
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    return bytes.toString('base64url');
  }

  /**
   * GCM authenticates as well as encrypts, so a modified value fails loudly
   * instead of decrypting to something else. For an address, "something else" is
   * a parcel sent to the wrong place.
   */
  it('rejects a flipped byte in the ciphertext', () => {
    const parts = encryptAddress(STREET, keysA).split('.');

    expect(() =>
      decryptAddress([...parts.slice(0, 4), flipOneBit(parts[4] as string)].join('.'), keysA),
    ).toThrow(AddressCryptoError);
  });

  it('rejects a modified auth tag', () => {
    const parts = encryptAddress(STREET, keysA).split('.');

    expect(() =>
      decryptAddress(
        [...parts.slice(0, 3), flipOneBit(parts[3] as string), parts[4]].join('.'),
        keysA,
      ),
    ).toThrow(AddressCryptoError);
  });

  it('rejects a swapped key id', () => {
    const parts = encryptAddress(STREET, keysA).split('.');

    expect(() => decryptAddress([parts[0], keyId(KEY_B), ...parts.slice(2)].join('.'), keysA)).toThrow(
      /No key available/,
    );
  });
});

describe('a value that is not ciphertext is refused, never passed through', () => {
  /**
   * The single most important property. A plaintext fallback would mean a row the
   * migration missed is silently served as an address — and then dispatched.
   */
  it('refuses a bare plaintext address', () => {
    expect(() => decryptAddress(STREET, keysA)).toThrow(AddressCryptoError);
  });

  it('refuses a value that is empty', () => {
    expect(() => decryptAddress('', keysA)).toThrow(AddressCryptoError);
  });

  it('refuses a value from an unknown scheme version', () => {
    const parts = encryptAddress(STREET, keysA).split('.');

    expect(() => decryptAddress(['v9', ...parts.slice(1)].join('.'), keysA)).toThrow(
      /Unsupported encryption version/,
    );
  });

  it('refuses a truncated value', () => {
    for (const bad of ['v1', 'v1.abc', 'v1.abc.def', 'v1.abc.def.ghi']) {
      expect(() => decryptAddress(bad, keysA)).toThrow(AddressCryptoError);
    }
  });
});

describe('rotation', () => {
  it('reads rows encrypted with a key that is now previous', () => {
    // What a rotation looks like: new writes use the new key, old rows still read
    // until they are re-encrypted.
    const old = encryptAddress(STREET, { current: KEY_A, previous: [] });
    const rotated: AddressKeys = { current: KEY_B, previous: [KEY_A] };

    expect(decryptAddress(old, rotated)).toBe(STREET);
  });

  it('writes with the current key after a rotation', () => {
    const rotated: AddressKeys = { current: KEY_B, previous: [KEY_A] };

    expect(encryptAddress(STREET, rotated).split('.')[1]).toBe(keyId(KEY_B));
  });

  it('refuses once the old key is finally dropped', () => {
    // The failure a rotation causes if the rows are not re-encrypted first. Loud,
    // and specific about why.
    const old = encryptAddress(STREET, { current: KEY_A, previous: [] });

    expect(() => decryptAddress(old, { current: KEY_B, previous: [] })).toThrow(
      /No key available for id/,
    );
  });
});

describe('optional fields', () => {
  it('carries null through as null', () => {
    expect(encryptOptional(null, keysA)).toBeNull();
    expect(encryptOptional(undefined, keysA)).toBeNull();
    expect(decryptOptional(null, keysA)).toBeNull();
    expect(decryptOptional(undefined, keysA)).toBeNull();
  });

  it('encrypts a value that is present', () => {
    const encrypted = encryptOptional('+1 555 0100', keysA);

    expect(encrypted).not.toBeNull();
    expect(decryptOptional(encrypted, keysA)).toBe('+1 555 0100');
  });
});

describe('reading the key from the environment', () => {
  const hex = randomBytes(32).toString('hex');

  it('accepts a 32-byte hex key', () => {
    const keys = keysFromEnv({ ADDRESS_ENCRYPTION_KEY: hex });

    expect(keys.current.length).toBe(32);
    expect(keys.previous).toHaveLength(0);
  });

  it('picks up a previous key when one is configured', () => {
    const keys = keysFromEnv({
      ADDRESS_ENCRYPTION_KEY: hex,
      ADDRESS_ENCRYPTION_KEY_PREVIOUS: randomBytes(32).toString('hex'),
    });

    expect(keys.previous).toHaveLength(1);
  });

  it('refuses to store anything when no key is configured', () => {
    // Must throw rather than fall back. A silent fallback would look exactly like
    // success while writing plaintext.
    expect(() => keysFromEnv({})).toThrow(/not set/);
  });

  it('refuses a key of the wrong length', () => {
    expect(() => keysFromEnv({ ADDRESS_ENCRYPTION_KEY: randomBytes(16).toString('hex') })).toThrow(
      /must be 32 bytes/,
    );
  });

  it('refuses a key that is not hex', () => {
    expect(() => keysFromEnv({ ADDRESS_ENCRYPTION_KEY: 'not-hex-not-hex' })).toThrow(/must be hex/);
  });
});
