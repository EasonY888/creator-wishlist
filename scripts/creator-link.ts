/**
 * Print a creator's private manage link.
 *
 * The link **is** the credential. Creators have no password and no email on file,
 * so whoever holds this can curate the wishlist and replace the delivery address.
 * There is nothing to reset and nothing to recover — if it is lost, you run this
 * again against the database.
 *
 * Treat the output like a password: it is intentionally not printed anywhere the
 * app can read back, and it should not go on a shared screen.
 *
 *   npx tsx scripts/creator-link.ts demo-creator
 *   npx tsx scripts/creator-link.ts --all
 */

import 'dotenv/config';

import { prisma } from '../src/db/client';

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';

const all = process.argv.includes('--all');
const slug = process.argv.find((arg) => !arg.startsWith('-') && arg !== process.argv[1]);

if (!all && slug === undefined) {
  console.error('Usage:');
  console.error('  npx tsx scripts/creator-link.ts <slug>');
  console.error('  npx tsx scripts/creator-link.ts --all');
  process.exit(1);
}

const creators = await prisma.creator.findMany({
  where: all ? {} : { publicSlug: slug },
  orderBy: { createdAt: 'asc' },
  select: { displayName: true, publicSlug: true, accessKey: true },
});

if (creators.length === 0) {
  console.error(all ? 'No creators exist yet.' : `No creator with slug "${slug}".`);
  await prisma.$disconnect();
  process.exit(1);
}

console.log('');
console.log(creators.length === 1 ? 'creator manage link' : `${creators.length} creator manage links`);
console.log('');

for (const creator of creators) {
  console.log(`  ${creator.displayName}  (${creator.publicSlug})`);
  console.log(`    ${APP_URL}/creator/${creator.publicSlug}/enter?key=${creator.accessKey}`);
  console.log('');
}

console.log('This link is a credential. Opening it once is enough — it exchanges the key');
console.log('for a 90-day session cookie and redirects to the clean URL, so it leaves the');
console.log('address bar straight away.');
console.log('');
console.log('To rotate it: the key is a column, so replace it and every issued link dies.');
console.log('');

await prisma.$disconnect();
