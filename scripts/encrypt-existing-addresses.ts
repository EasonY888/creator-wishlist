/**
 * One-off migration: encrypt addresses that predate encryption (NFR-2.2).
 *
 * Reads the columns directly rather than through `address-store`, because the
 * store now refuses to hand back anything it cannot decrypt — which is correct
 * everywhere except here, where the plaintext is exactly what we are converting.
 * This is the only code in the repository allowed to look at an unencrypted row.
 *
 * Idempotent: a row already in the encrypted form is left alone, so re-running
 * after a partial failure is safe.
 *
 *   npx tsx scripts/encrypt-existing-addresses.ts [--dry-run]
 */
import 'dotenv/config';

import { prisma } from '../src/db/client';
import { encryptAddress, encryptOptional, isEncrypted, keysFromEnv } from '../src/fulfillment/address-crypto';
import { computeShipToDigest } from '../src/fulfillment/binding';
import { toShipTo } from '../src/agnic/port';

const dryRun = process.argv.includes('--dry-run');

const keys = keysFromEnv();

const rows = await prisma.creatorAddress.findMany({
  include: { creator: { select: { publicSlug: true } } },
});

console.log(`${rows.length} address row(s) found${dryRun ? ' (dry run — nothing will be written)' : ''}\n`);

let converted = 0;
let alreadyDone = 0;
const digestMismatches: string[] = [];

for (const row of rows) {
  const encrypted = isEncrypted(row.streetAddress);

  if (encrypted) {
    alreadyDone += 1;
    continue;
  }

  // The digest was taken over plaintext, and still is, so converting the storage
  // must not change it. Verified rather than assumed: a mismatch here means the
  // row was written without recomputing its digest, which is worth knowing about
  // before it silently invalidates a live order.
  const expected = computeShipToDigest(
    toShipTo({
      fullName: row.fullName,
      streetAddress: row.streetAddress,
      addressLocality: row.addressLocality,
      addressRegion: row.addressRegion,
      postalCode: row.postalCode,
      addressCountry: row.addressCountry,
      phone: row.phone,
    }),
  );

  if (expected !== row.digest) {
    digestMismatches.push(
      `${row.creator.publicSlug}: stored ${row.digest.slice(0, 12)}… but the values hash to ${expected.slice(0, 12)}…`,
    );
  }

  console.log(
    `  ${dryRun ? 'would encrypt' : 'encrypting'} ${row.creator.publicSlug} (${row.id})`,
  );

  if (!dryRun) {
    await prisma.creatorAddress.update({
      where: { id: row.id },
      data: {
        fullName: encryptAddress(row.fullName, keys),
        streetAddress: encryptAddress(row.streetAddress, keys),
        addressLocality: encryptAddress(row.addressLocality, keys),
        addressRegion: encryptOptional(row.addressRegion, keys),
        postalCode: encryptAddress(row.postalCode, keys),
        addressCountry: encryptAddress(row.addressCountry, keys),
        phone: encryptOptional(row.phone, keys),
        // Unchanged, and deliberately so: it is computed from plaintext and must
        // not move when the storage format does.
        digest: expected,
      },
    });
  }

  converted += 1;
}

console.log(`\nconverted:      ${converted}`);
console.log(`already done:   ${alreadyDone}`);

if (digestMismatches.length > 0) {
  console.log(`\n!! ${digestMismatches.length} row(s) had a digest that did not match their values:`);
  for (const mismatch of digestMismatches) {
    console.log(`   ${mismatch}`);
  }
  console.log(
    '\n   Those rows have been written with the CORRECTED digest. Any order still\n' +
      '   holding the old digest will now fail its binding check, which is the right\n' +
      '   outcome — it means the row was wrong when the order was approved.',
  );
}

if (dryRun && converted > 0) {
  console.log('\nRe-run without --dry-run to apply.');
}

await prisma.$disconnect();
