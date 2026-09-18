/**
 * Encryption for the creator's delivery address.
 *
 * NFR-2.2 requires PII to be encrypted at rest. The schema already isolates the
 * address in its own table so exactly one module may read it, and that isolation
 * is the real protection against an application bug. This is the protection
 * against the other thing: a leaked database dump, a backup on a laptop, a
 * support engineer with a read replica.
 *
 * ## Why the digest stays over plaintext
 *
 * `CreatorAddress.digest` and every `requestDigest` are computed from the
 * *plaintext*, and deliberately so. Those digests are what prove the address the
 * fan approved is still the address we are about to dispatch to. If they were
 * taken over ciphertext, rotating the key would change every digest and refuse
 * every in-flight dispatch — reporting a security improvement as "the creator
 * changed their address". Encryption must not be visible to binding.
 *
 * ## Format
 *
 * `v1.<keyId>.<iv>.<tag>.<ciphertext>`, base64url throughout.
 *
 * The version prefix allows the scheme to change. The key id allows a rotation to
 * be rolled out gradually: new writes use the current key, old rows still decrypt
 * with the previous one, so nothing has to be re-encrypted in a single window.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12; // GCM's native size; longer is slower for no gain.
const KEY_BYTES = 32; // AES-256.

export class AddressCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressCryptoError';
  }
}

export interface AddressKeys {
  /** The key new writes use. */
  current: Buffer;
  /** Keys still accepted for READING, so a rotation does not break old rows. */
  previous: Buffer[];
}

/**
 * The identity of a key, without revealing it.
 *
 * Derived rather than configured, so a key cannot be given a misleading label and
 * a rotation cannot be applied to the wrong row.
 */
export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

function parseKey(raw: string | undefined, name: string): Buffer | null {
  if (!raw || raw.trim().length === 0) return null;

  const value = raw.trim();

  if (!/^[0-9a-fA-F]+$/.test(value)) {
    throw new AddressCryptoError(
      `${name} must be hex. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }

  const key = Buffer.from(value, 'hex');

  if (key.length !== KEY_BYTES) {
    throw new AddressCryptoError(
      `${name} must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex characters), got ${key.length}.`,
    );
  }

  return key;
}

/**
 * Read the keys from the environment.
 *
 * This is the seam. Swapping it for a KMS or a secrets manager means replacing
 * this one function — nothing below it knows where a key came from.
 *
 * Throws when the current key is missing rather than falling back to plaintext.
 * A missing key must never mean "store it readable", because that failure would
 * be silent and would look exactly like success.
 */
export function keysFromEnv(
  env: Record<string, string | undefined> = process.env,
): AddressKeys {
  const current = parseKey(env.ADDRESS_ENCRYPTION_KEY, 'ADDRESS_ENCRYPTION_KEY');

  if (!current) {
    throw new AddressCryptoError(
      'ADDRESS_ENCRYPTION_KEY is not set, so the delivery address cannot be encrypted. Refusing to store it in the clear.',
    );
  }

  const previous = parseKey(env.ADDRESS_ENCRYPTION_KEY_PREVIOUS, 'ADDRESS_ENCRYPTION_KEY_PREVIOUS');

  return { current, previous: previous ? [previous] : [] };
}

/**
 * Whether a value is already ciphertext from this scheme.
 *
 * Used by the migration and by the store's sanity checks. Deliberately not used to
 * decide how to READ: a value that fails to parse as ciphertext is an error, not
 * a plaintext address to be handed back.
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(`${VERSION}.`);
}

export function encryptAddress(plaintext: string, keys: AddressKeys): string {
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv('aes-256-gcm', keys.current, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Sealed with the auth tag, so tampering is detected at decrypt time rather
  // than silently yielding a different address.
  return [
    VERSION,
    keyId(keys.current),
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt, or throw.
 *
 * There is no plaintext fallback. A value that is not ciphertext from this scheme
 * is either a row the migration missed or something tampered with, and handing
 * either back as an address would defeat the point of encrypting it.
 */
export function decryptAddress(payload: string, keys: AddressKeys): string {
  const parts = payload.split('.');

  if (parts.length !== 5) {
    throw new AddressCryptoError(
      'Value is not in the expected encrypted form. If this predates encryption, run scripts/encrypt-existing-addresses.ts.',
    );
  }

  const [version, id, ivPart, tagPart, cipherPart] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (version !== VERSION) {
    throw new AddressCryptoError(`Unsupported encryption version "${version}".`);
  }

  const key = [keys.current, ...keys.previous].find((candidate) => keyId(candidate) === id);

  if (!key) {
    throw new AddressCryptoError(
      `No key available for id "${id}". It was probably rotated out without re-encrypting the rows that used it.`,
    );
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(cipherPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM verification failed, or the parts are not the shape they claim. Both
    // mean the same thing and neither should leak which.
    throw new AddressCryptoError('Address could not be decrypted. It may have been tampered with.');
  }
}

/** Null in, null out — so an optional field like `phone` survives a round trip. */
export function encryptOptional(value: string | null | undefined, keys: AddressKeys): string | null {
  if (value === null || value === undefined) return null;
  return encryptAddress(value, keys);
}

export function decryptOptional(
  value: string | null | undefined,
  keys: AddressKeys,
): string | null {
  if (value === null || value === undefined) return null;
  return decryptAddress(value, keys);
}
