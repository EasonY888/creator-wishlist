import type { AddressForQuote } from '../agnic/port';
import { toShipTo } from '../agnic/port';
import type { ShipTo } from '../agnic/types';
import type { Db } from '../db/types';
import {
  decryptAddress,
  decryptOptional,
  encryptAddress,
  encryptOptional,
  keysFromEnv,
  type AddressKeys,
} from './address-crypto';
import { computeShipToDigest } from './binding';

/**
 * The only module permitted to read a creator's delivery address.
 *
 * The address is the one thing this product promises never to leak, so access to
 * it is a grant rather than a convention: this module is the gate, it checks the
 * caller's role, and it writes an audit row every single time. Nothing else in
 * the codebase should query `CreatorAddress` directly.
 *
 * This is why the address lives in its own table. If it were columns on
 * `Creator`, the boundary would instead be a rule about which queries remember
 * to select them — and a boundary enforced by memory is not a boundary.
 */

export interface AddressActor {
  id: string;
  role: string;
  /** Recorded verbatim. An operator reading an address should say why. */
  reason: string;
}

/** The service identity used by the fulfillment path. */
export const FULFILLMENT_ACTOR: AddressActor = {
  id: 'fulfillment-service',
  role: 'service',
  reason: 'attach the delivery destination to a provider quote or dispatch',
};

/**
 * Roles that may read a creator address.
 *
 * Deliberately a small allowlist rather than a denylist: a new role should be
 * denied by default until somebody consciously adds it.
 */
export const ADDRESS_READER_ROLES: readonly string[] = ['service', 'support'];

export class AddressAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressAccessError';
  }
}

export interface LoadedAddress {
  shipTo: ShipTo;
  /** Digest of the destination as it stands right now. */
  digest: string;
  /**
   * Whether the address still matches the digest stored on the row.
   *
   * False means the row and its own digest disagree, which would indicate the
   * row was written without recomputing the digest. Surfaced rather than thrown
   * so the caller can decide; the binding check downstream is the real gate.
   */
  digestMatchesStored: boolean;
}

export async function loadShipToForFulfillment(
  db: Db,
  args: { creatorAddressId: string; actor?: AddressActor; keys?: AddressKeys },
): Promise<LoadedAddress> {
  const actor = args.actor ?? FULFILLMENT_ACTOR;

  if (!ADDRESS_READER_ROLES.includes(actor.role)) {
    throw new AddressAccessError(
      `Role "${actor.role}" may not read creator addresses.`,
    );
  }

  const address = await db.creatorAddress.findUnique({
    where: { id: args.creatorAddressId },
  });

  if (!address) {
    throw new AddressAccessError(
      `Creator address ${args.creatorAddressId} not found.`,
    );
  }

  // Audited before the data is returned, so a read that throws afterwards is
  // still recorded as an attempt.
  await db.addressAccessAudit.create({
    data: {
      creatorAddressId: address.id,
      actorId: actor.id,
      actorRole: actor.role,
      reason: actor.reason,
    },
  });

  // Decryption happens after the audit row, not before: an audit that is skipped
  // because the row failed to decrypt is an access nobody can see.
  const keys = args.keys ?? keysFromEnv();
  const plaintext = decryptAddressRow(address, keys);

  const shipTo = toShipTo(plaintext);
  const digest = computeShipToDigest(shipTo);

  return {
    shipTo,
    digest,
    digestMatchesStored: digest === address.digest,
  };
}

/** The stored shape, all of it ciphertext apart from the digest. */
interface StoredAddressRow {
  fullName: string;
  streetAddress: string;
  addressLocality: string;
  addressRegion: string | null;
  postalCode: string;
  addressCountry: string;
  phone: string | null;
}

/**
 * Decrypt a stored row into the shape the rest of the application expects.
 *
 * Private to this module on purpose. Nothing outside the address store should
 * ever hold a decrypted address, so there is no exported way to ask for one.
 */
function decryptAddressRow(row: StoredAddressRow, keys: AddressKeys): AddressForQuote {
  return {
    fullName: decryptAddress(row.fullName, keys),
    streetAddress: decryptAddress(row.streetAddress, keys),
    addressLocality: decryptAddress(row.addressLocality, keys),
    addressRegion: decryptOptional(row.addressRegion, keys),
    postalCode: decryptAddress(row.postalCode, keys),
    addressCountry: decryptAddress(row.addressCountry, keys),
    phone: decryptOptional(row.phone, keys),
  };
}

/**
 * Compute the digest of a stored address without reading it out.
 *
 * Takes ciphertext and decrypts internally, so a caller that only needs to
 * compare a digest never receives the address itself.
 */
export function storedAddressDigest(
  address: StoredAddressRow,
  keys?: AddressKeys,
): string {
  return computeShipToDigest(toShipTo(decryptAddressRow(address, keys ?? keysFromEnv())));
}

export interface NewCreatorAddress {
  creatorId: string;
  fullName: string;
  streetAddress: string;
  addressLocality: string;
  addressRegion?: string | null;
  postalCode: string;
  addressCountry: string;
  phone?: string | null;
  consentPolicyVersion: string;
  consentAt?: Date;
}

/**
 * Create or replace a creator's address, encrypted at rest.
 *
 * The single write path, so there is no way to store an address in the clear by
 * forgetting to encrypt it. The digest is taken over the PLAINTEXT, because it is
 * what proves the fan's approved destination is unchanged and it must not move
 * when the encryption key does.
 */
export async function writeCreatorAddress(
  db: Db,
  input: NewCreatorAddress,
  keys?: AddressKeys,
): Promise<{ id: string; digest: string }> {
  const resolved = keys ?? keysFromEnv();

  const country = input.addressCountry.trim().toUpperCase();
  if (country.length !== 2) {
    // The column used to enforce this, and no longer can: it now holds
    // ciphertext. So the rule moves to the only place that can still apply it.
    throw new AddressAccessError(
      `addressCountry must be a two-letter code, got "${input.addressCountry}".`,
    );
  }

  const digest = storedDigestFromPlaintext({ ...input, addressCountry: country });

  const data = {
    fullName: encryptAddress(input.fullName, resolved),
    streetAddress: encryptAddress(input.streetAddress, resolved),
    addressLocality: encryptAddress(input.addressLocality, resolved),
    addressRegion: encryptOptional(input.addressRegion, resolved),
    postalCode: encryptAddress(input.postalCode, resolved),
    addressCountry: encryptAddress(country, resolved),
    phone: encryptOptional(input.phone, resolved),
    digest,
    consentPolicyVersion: input.consentPolicyVersion,
    consentAt: input.consentAt ?? new Date(),
  };

  const written = await db.creatorAddress.upsert({
    where: { creatorId: input.creatorId },
    create: { creatorId: input.creatorId, ...data },
    update: data,
    select: { id: true },
  });

  return { id: written.id, digest };
}

/**
 * The digest, computed from plaintext.
 *
 * Exported separately from the encrypting writer because the migration needs it
 * to re-derive digests without rewriting the addresses.
 */
export function storedDigestFromPlaintext(
  address: Pick<
    NewCreatorAddress,
    | 'fullName'
    | 'streetAddress'
    | 'addressLocality'
    | 'addressRegion'
    | 'postalCode'
    | 'addressCountry'
    | 'phone'
  >,
): string {
  return computeShipToDigest(toShipTo(address satisfies AddressForQuote));
}

/**
 * Resolve which address row belongs to a creator, without reading the address.
 *
 * Returns an id and nothing else, so a caller that only needs to know whether an
 * address exists does not have to touch this module's read gate or write an audit
 * row. Fetching the actual destination still goes through
 * `loadShipToForFulfillment`.
 */
export async function currentAddressIdFor(
  db: Db,
  creatorId: string,
): Promise<string | null> {
  const address = await db.creatorAddress.findUnique({
    where: { creatorId },
    select: { id: true },
  });

  return address?.id ?? null;
}
