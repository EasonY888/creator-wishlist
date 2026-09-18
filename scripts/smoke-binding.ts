/**
 * Proves the request-binding mechanism works, and why it needs a canonical form.
 *
 * The important claim being tested is not "hashing works" — it is that a digest
 * taken over a naive `JSON.stringify` would break on every single order, because
 * Postgres `jsonb` reorders object keys and Prisma's `Json` type maps to
 * `jsonb`. That failure would present as "the creator changed their address"
 * every time, which is the most misleading possible symptom.
 *
 * So this round-trips a real request through the real database and compares.
 */
import { prisma } from '../src/db/client';
import {
  assertRequestBinding,
  canonicalize,
  changedShipToFields,
  computeRequestDigest,
  computeShipToDigest,
  RequestBindingError,
  sha256Hex,
  type BoundRequest,
} from '../src/fulfillment/binding';

const sample: BoundRequest = {
  merchant_id: 'merchant_1',
  items: [{ sku: 'sku-1', quantity: 1 }],
  ship_to: {
    name: 'Creator Example',
    street_address: '1 Test Street',
    address_locality: 'Toronto',
    address_region: 'ON',
    postal_code: 'M5H 1A1',
    address_country: 'CA',
  },
  currency: 'CAD',
  amount_minor: 1000,
  constraints: { max_total_minor: 1500, max_shipping_minor: 2000 },
  fulfillment_option_id: 'ship-standard',
};

// ---------------------------------------------------------------------------
// 1. The jsonb round trip
// ---------------------------------------------------------------------------

const rows = await prisma.$queryRaw<Array<{ v: BoundRequest }>>`
  select ${JSON.stringify(sample)}::jsonb as v
`;
const roundTripped = rows[0]!.v;

const originalKeys = Object.keys(sample).join(',');
const returnedKeys = Object.keys(roundTripped).join(',');

console.log('1. jsonb round trip');
console.log('   keys sent   :', originalKeys);
console.log('   keys back   :', returnedKeys);
console.log('   reordered?  :', originalKeys !== returnedKeys ? 'YES' : 'no');

const naiveBefore = sha256Hex(JSON.stringify(sample));
const naiveAfter = sha256Hex(JSON.stringify(roundTripped));
console.log(
  '   naive digest stable?  :',
  naiveBefore === naiveAfter ? 'yes' : 'NO  <- would fail every order',
);

const canonicalBefore = computeRequestDigest(sample);
const canonicalAfter = computeRequestDigest(roundTripped);
console.log(
  '   canonical digest stable?:',
  canonicalBefore === canonicalAfter ? 'yes' : 'NO',
);
console.log('   sample canonical form  :', canonicalize({ b: 1, a: 2 }).slice(0, 40));

// ---------------------------------------------------------------------------
// 2. A bound request dispatches cleanly
// ---------------------------------------------------------------------------

console.log('\n2. binding holds for an unchanged request');

try {
  assertRequestBinding({
    approvedRequestDigest: computeRequestDigest(sample),
    approvedShipToDigest: computeShipToDigest(sample.ship_to),
    current: roundTripped, // note: round-tripped, so key order differs
    approved: sample,
  });
  console.log('   OK - round-tripped request still binds');
} catch (error) {
  console.log('   FAIL:', (error as Error).message);
}

// ---------------------------------------------------------------------------
// 3. The creator moves house
// ---------------------------------------------------------------------------

console.log('\n3. creator changes their address after approval');

const moved: BoundRequest = {
  ...roundTripped,
  ship_to: { ...sample.ship_to, postal_code: 'M5H 9Z9' },
};

try {
  assertRequestBinding({
    approvedRequestDigest: computeRequestDigest(sample),
    approvedShipToDigest: computeShipToDigest(sample.ship_to),
    current: moved,
    approved: sample,
    approvedShipTo: sample.ship_to,
  });
  console.log('   FAIL - address change was not caught');
} catch (error) {
  const err = error as RequestBindingError;
  console.log('   caught:', err.code);
  console.log('   fields :', err.changedFields.join(', '));
}

console.log(
  '   changed fields between two addresses:',
  changedShipToFields(sample.ship_to, {
    ...sample.ship_to,
    postal_code: 'X',
    address_locality: 'Y',
  }).join(', '),
);

// ---------------------------------------------------------------------------
// 4. Someone tampers with the amount
// ---------------------------------------------------------------------------

console.log('\n4. approved amount is altered before dispatch');

try {
  assertRequestBinding({
    approvedRequestDigest: computeRequestDigest(sample),
    approvedShipToDigest: computeShipToDigest(sample.ship_to),
    current: { ...roundTripped, amount_minor: 999_999 },
    approved: sample,
  });
  console.log('   FAIL - amount change was not caught');
} catch (error) {
  console.log('   caught:', (error as RequestBindingError).code);
}

await prisma.$disconnect();
