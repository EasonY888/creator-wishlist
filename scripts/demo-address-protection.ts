/**
 * The address-protection demo, as a runbook.
 *
 * Track 01's promise is one sentence — "the creator's home address never reaches
 * the fan" — and the mistake would be to *say* that. This makes it visible at
 * every layer, in the order a judge can follow: what the creator typed, what the
 * database actually holds, what the fan's screen is built from, what the frozen
 * approval keeps, what an operator sees, and what happens when she moves house.
 *
 * Run it once before Demo Day. Nothing here spends money or touches the merchant
 * rail — it writes one address for a creator of its own and reads it back.
 *
 *   npx tsx scripts/demo-address-protection.ts
 */
import 'dotenv/config';

import { prisma } from '../src/db/client';
import {
  ADDRESS_READER_ROLES,
  AddressAccessError,
  loadShipToForFulfillment,
  writeCreatorAddress,
} from '../src/fulfillment/address-store';
import {
  RequestBindingError,
  assertRequestBinding,
  changedShipToFields,
  computeRequestDigest,
  computeShipToDigest,
  type BoundRequest,
} from '../src/fulfillment/binding';
import { findSensitiveFields } from '../src/presentation/sensitive';

const SLUG = 'maya-demo';

/** What Maya types into the form. This is the only place it exists in the clear. */
const MAYA_TYPED = {
  fullName: 'Maya Chen',
  streetAddress: '12 Studio Lane, Unit 4',
  addressLocality: 'Toronto',
  addressRegion: 'ON',
  postalCode: 'M5V 2T6',
  addressCountry: 'CA',
  phone: null,
};

/** Same person, new flat. One field changes and one field is added. */
const MAYA_MOVED = {
  ...MAYA_TYPED,
  streetAddress: '88 Harbour Street, Apt 1901',
  postalCode: 'M5J 2K8',
};

function heading(step: string, title: string): void {
  console.log('');
  console.log('='.repeat(78));
  console.log(`STEP ${step}  ${title}`);
  console.log('='.repeat(78));
}

function say(...lines: string[]): void {
  for (const line of lines) console.log(`  ${line}`);
}

// ---------------------------------------------------------------------------
// Clean up a previous run
// ---------------------------------------------------------------------------

const stale = await prisma.creator.findUnique({ where: { publicSlug: SLUG } });
if (stale) {
  await prisma.creatorAddress.deleteMany({ where: { creatorId: stale.id } });
  await prisma.creator.delete({ where: { id: stale.id } });
}

const creator = await prisma.creator.create({
  data: { displayName: 'Maya Chen', publicSlug: SLUG },
});

// ---------------------------------------------------------------------------
// 1
// ---------------------------------------------------------------------------

heading('1', 'Maya saves her address — the only plaintext in the system');

const written = await writeCreatorAddress(prisma, {
  creatorId: creator.id,
  ...MAYA_TYPED,
  consentPolicyVersion: 'v1',
});

say(`what she typed     ${MAYA_TYPED.streetAddress}`);
say(`                   ${MAYA_TYPED.addressLocality} ${MAYA_TYPED.addressRegion} ${MAYA_TYPED.postalCode} ${MAYA_TYPED.addressCountry}`);
say('');
say('This request is the last moment the address exists in the clear. It is');
say('encrypted inside the write path, so there is no code path that can store it');
say('unencrypted — not "we remembered to encrypt", but "there is nowhere else to put it".');

// ---------------------------------------------------------------------------
// 2
// ---------------------------------------------------------------------------

heading('2', 'What Postgres actually holds');

const raw = await prisma.$queryRaw<
  Array<{
    fullName: string;
    streetAddress: string;
    postalCode: string;
    addressCountry: string;
    digest: string;
  }>
>`
  select "fullName", "streetAddress", "postalCode", "addressCountry", digest
  from "CreatorAddress" where "creatorId" = ${creator.id}
`;

for (const row of raw) {
  say(`fullName        ${row.fullName}`);
  say(`streetAddress   ${row.streetAddress}`);
  say(`postalCode      ${row.postalCode}`);
  say(`addressCountry  ${row.addressCountry}`);
  say('');
  say(`digest          ${row.digest}`);
}

say('');
say('That is a `psql` shell reading the raw column — not an API, not a view. A');
say('leaked dump is a leaked set of ciphertexts. AES-256-GCM, so a tampered value');
say('fails to decrypt rather than decrypting to a different address, which would');
say('be a parcel sent to the wrong place.');
say('');
say('Note what is NOT encrypted, on purpose: the digest. It is over the PLAINTEXT,');
say('so rotating the encryption key cannot change it. If it moved with the key, a');
say('key rotation would silently invalidate every outstanding approval.');

// ---------------------------------------------------------------------------
// 3
// ---------------------------------------------------------------------------

heading('3', 'What the fan can see');

const fanPayload = {
  state: 'dispatched',
  amountMinor: 1794,
  currency: 'CAD',
  creator: { displayName: creator.displayName },
};

const operatorPayload = {
  ...fanPayload,
  evidence: { ship_to: MAYA_TYPED },
  orderUrl: 'https://example.invalid/live',
  liveViewUrl: 'https://example.invalid/stream',
};

const fanLeaks = findSensitiveFields(fanPayload);
const operatorLeaks = findSensitiveFields(operatorPayload);

say(`fan payload leaks         ${fanLeaks.length === 0 ? 'none' : fanLeaks.join(', ')}`);
say(`operator payload leaks    ${operatorLeaks.length === 0 ? 'none' : operatorLeaks.join(', ')}`);
say('');
say('The second line is the important one. A guard that finds nothing proves');
say('nothing on its own — it might just be broken. It is non-vacuous: hand it an');
say('operator payload and it names the address-bearing fields immediately.');
say('');
say('And the reason the fan payload never had an address to begin with: the address');
say('lives in its own table, not as columns on `Creator`. If it were columns, the');
say('boundary would be "which queries remember not to select them" — and a boundary');
say('enforced by memory is not a boundary.');

// ---------------------------------------------------------------------------
// 4
// ---------------------------------------------------------------------------

heading('4', 'What the frozen approval keeps');

say('The fan approved a specific destination. We store proof of WHICH destination');
say('without storing the destination itself:');
say('');
say(`  ApprovedRequest.creatorAddressId   ${written.id}`);
say(`  ApprovedRequest.shipToDigest       ${written.digest}`);
say('');
say('A pointer and a fingerprint. Dispatch re-reads the address, recomputes the');
say('digest, and compares. So the same digest comparison enforces two requirements');
say('at once: the address cannot change after approval, and the approved request');
say('cannot be altered — without keeping a second copy of the address anywhere.');

// ---------------------------------------------------------------------------
// 5
// ---------------------------------------------------------------------------

heading('5', 'What an operator sees, and what the role gate does');

const loaded = await loadShipToForFulfillment(prisma, {
  creatorAddressId: written.id,
});

say(`reader roles allowed  ${ADDRESS_READER_ROLES.join(', ')}`);
say(`audit rows written    ${await prisma.addressAccessAudit.count({ where: { creatorAddressId: written.id } })}`);
say('');
say('Every read goes through one function that checks the caller\'s role and writes');
say('an audit row BEFORE decrypting — so a read that fails to decrypt is still');
say('recorded as an attempt. Nothing else in the codebase may query');
say('`CreatorAddress`, and the decryption helper is not exported, so there is no');
say('way to ask for a plaintext address and be given one.');

try {
  await loadShipToForFulfillment(prisma, {
    creatorAddressId: written.id,
    actor: { id: 'curious', role: 'fan', reason: 'just checking' },
  });
  say('');
  say('!! a fan role was allowed to read the address — this should never happen');
} catch (error) {
  if (!(error instanceof AddressAccessError)) throw error;
  say('');
  say(`a fan role asking for it:  ${error.message}`);
  say('Denied by an allowlist, so a new role is refused until somebody deliberately');
  say('adds it — rather than being permitted until somebody remembers to remove it.');
}

// ---------------------------------------------------------------------------
// 6
// ---------------------------------------------------------------------------

heading('6', 'Maya moves house — the promise, tested');

// The order she approved, assembled exactly as dispatch would assemble it.
const MERCHANT_ID = 'merchant_untitled_fidget_shop';
const ITEMS = [{ sku: 'gid://shopify/ProductVariant/43945235349570', quantity: 1 }];
const AMOUNT_MINOR = 1794;
const CURRENCY = 'CAD';

const approvedFor = loaded.shipTo;

const approvedRequest: BoundRequest = {
  merchant_id: MERCHANT_ID,
  items: ITEMS,
  ship_to: approvedFor,
  currency: CURRENCY,
  amount_minor: AMOUNT_MINOR,
};

await writeCreatorAddress(prisma, {
  creatorId: creator.id,
  ...MAYA_MOVED,
  consentPolicyVersion: 'v1',
});

const afterMove = await loadShipToForFulfillment(prisma, {
  creatorAddressId: written.id,
});

say(`approved against   ${approvedFor.street_address}, ${approvedFor.postal_code}`);
say(`now on file        ${afterMove.shipTo.street_address}, ${afterMove.shipTo.postal_code}`);
say(`fields changed     ${changedShipToFields(approvedFor, afterMove.shipTo).join(', ')}`);
say('');
try {
  // Dispatch rebuilds the request from the creator's CURRENT address and asks the
  // gate whether it still matches what the fan approved.
  assertRequestBinding({
    approvedRequestDigest: computeRequestDigest(approvedRequest),
    approvedShipToDigest: computeShipToDigest(approvedFor),
    current: { ...approvedRequest, ship_to: afterMove.shipTo },
    approved: {
      merchant_id: MERCHANT_ID,
      items: ITEMS,
      currency: CURRENCY,
      amount_minor: AMOUNT_MINOR,
    },
    approvedShipTo: approvedFor,
  });
  say('!! the binding check passed — it should have refused');
} catch (error) {
  if (!(error instanceof RequestBindingError)) throw error;
  say('dispatch refuses, with this reason:');
  say('');
  for (const line of error.message.match(/.{1,70}(\s|$)/g) ?? [error.message]) {
    say(`  "${line.trim()}"`);
  }
}

say('');
say('This matters because the fan\'s price was computed for a destination. If the');
say('destination moves between approval and payment, the shipping and tax the fan');
say('agreed to are no longer the ones that apply — so the order stops and asks for a');
say('fresh approval instead of quietly shipping somewhere the fan never agreed to.');
say('');
say('And the same check is what proves the request was not tampered with, because');
say('the digest covers the whole frozen request, not just the address.');

// ---------------------------------------------------------------------------
// The one-liner
// ---------------------------------------------------------------------------

console.log('');
console.log('='.repeat(78));
console.log('THE SENTENCE TO SAY');
console.log('='.repeat(78));
console.log('');
console.log('  "Maya\'s address is encrypted before it is stored, in the only function');
console.log('   that can write it. It lives in its own table, so no query can leak it by');
console.log('   forgetting to exclude it. Reading it needs a role and writes an audit');
console.log('   row. The approval keeps a digest of the destination rather than the');
console.log('   destination, so if she moves house the order refuses rather than ships');
console.log('   to the wrong place. And no fan-facing screen has ever had the field."');
console.log('');

// Clean up so the demo can be run again.
await prisma.creatorAddress.deleteMany({ where: { creatorId: creator.id } });
await prisma.creator.delete({ where: { id: creator.id } });
await prisma.$disconnect();

console.log(`(cleaned up ${SLUG}; safe to run again)`);
console.log('');
