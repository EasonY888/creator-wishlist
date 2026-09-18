import { describe, expect, it } from 'vitest';

import { canonicalize, computeRequestDigest, computeShipToDigest, type BoundRequest } from './binding';
import { toShipTo } from '../agnic/port';

/**
 * The digest that decides whether an approved purchase may still be dispatched.
 *
 * The reason this needs testing at all is `jsonb`. Postgres does not preserve
 * object key order, and Prisma's `Json` type maps to `jsonb`. A digest taken over
 * a naive `JSON.stringify` would therefore change every time the request made a
 * round trip through the database — and every dispatch would fail its own binding
 * check while looking exactly like "the creator changed their address".
 */

const ADDRESS = {
  fullName: 'Creator Example',
  streetAddress: '1 Test Street',
  addressLocality: 'Toronto',
  addressRegion: 'ON',
  postalCode: 'M5H 1A1',
  addressCountry: 'CA',
  phone: null,
};

function bound(overrides: Partial<BoundRequest> = {}): BoundRequest {
  return {
    merchant_id: 'merchant_a',
    items: [{ sku: 'sku-1', quantity: 1 }],
    ship_to: toShipTo(ADDRESS),
    currency: 'CAD',
    amount_minor: 1000,
    ...overrides,
  };
}

describe('canonicalisation', () => {
  it('sorts keys so reordering cannot change the result', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('sorts nested keys too', () => {
    expect(canonicalize({ x: { b: 1, a: 2 } })).toBe(canonicalize({ x: { a: 2, b: 1 } }));
  });

  it('preserves array order, because item order is meaningful', () => {
    expect(canonicalize([{ sku: 'a' }, { sku: 'b' }])).not.toBe(
      canonicalize([{ sku: 'b' }, { sku: 'a' }]),
    );
  });

  it('treats an absent optional field and an undefined one identically', () => {
    // Otherwise a field surviving a round trip as `undefined` rather than absent
    // would break the binding for no real reason.
    expect(canonicalize({ a: 1 })).toBe(canonicalize({ a: 1, b: undefined }));
  });

  it('still distinguishes null from absent', () => {
    // null is a value someone chose; absent is not.
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
  });
});

describe('the request digest survives a database round trip', () => {
  it('is unchanged when the same request is rebuilt with reordered keys', () => {
    // This is the jsonb case, simulated: same data, different insertion order.
    const original: BoundRequest = {
      merchant_id: 'merchant_a',
      items: [{ sku: 'sku-1', quantity: 1 }],
      ship_to: toShipTo(ADDRESS),
      currency: 'CAD',
      amount_minor: 1000,
      fulfillment_option_id: 'ship-standard',
    };

    const roundTripped = JSON.parse(JSON.stringify(original)) as BoundRequest;

    // Rebuild with the keys in a different order, as jsonb may hand them back.
    const reordered = {
      fulfillment_option_id: roundTripped.fulfillment_option_id,
      amount_minor: roundTripped.amount_minor,
      currency: roundTripped.currency,
      ship_to: roundTripped.ship_to,
      items: roundTripped.items,
      merchant_id: roundTripped.merchant_id,
    } as BoundRequest;

    expect(computeRequestDigest(reordered)).toBe(computeRequestDigest(original));
  });

  it('is stable across repeated calls', () => {
    const request = bound();
    expect(computeRequestDigest(request)).toBe(computeRequestDigest(request));
  });
});

describe('the digest notices every material change', () => {
  const base = bound();

  const changes: Array<[string, Partial<BoundRequest>]> = [
    ['amount', { amount_minor: 1001 }],
    ['currency', { currency: 'USD' }],
    ['merchant', { merchant_id: 'merchant_b' }],
    ['items', { items: [{ sku: 'sku-1', quantity: 2 }] }],
    ['sku', { items: [{ sku: 'sku-2', quantity: 1 }] }],
    ['fulfillment option', { fulfillment_option_id: 'ship-express' }],
  ];

  for (const [label, change] of changes) {
    it(`changes when the ${label} changes`, () => {
      expect(computeRequestDigest(bound(change))).not.toBe(computeRequestDigest(base));
    });
  }

  it('changes when the destination changes', () => {
    const moved = toShipTo({ ...ADDRESS, streetAddress: '2 Other Street' });

    expect(computeRequestDigest(bound({ ship_to: moved }))).not.toBe(computeRequestDigest(base));
  });

  it('changes when constraints change', () => {
    // The cap is part of what the fan approved, so altering it must break the
    // binding rather than silently raising the ceiling.
    expect(computeRequestDigest(bound({ constraints: { max_total_minor: 2000 } }))).not.toBe(
      computeRequestDigest(bound({ constraints: { max_total_minor: 1000 } })),
    );
  });
});

describe('the destination digest', () => {
  it('is equal for the same address', () => {
    expect(computeShipToDigest(toShipTo(ADDRESS))).toBe(computeShipToDigest(toShipTo(ADDRESS)));
  });

  it('differs when any field that affects price changes', () => {
    // Shipping and tax are priced against the destination, so each of these
    // invalidates the quote the fan agreed to.
    for (const change of [
      { streetAddress: '2 Other Street' },
      { postalCode: 'M5H 1A2' },
      { addressLocality: 'Ottawa' },
      { addressRegion: 'BC' },
      { addressCountry: 'US' },
    ]) {
      expect(computeShipToDigest(toShipTo({ ...ADDRESS, ...change }))).not.toBe(
        computeShipToDigest(toShipTo(ADDRESS)),
      );
    }
  });

  it('changes when the recipient name changes', () => {
    // Not a pricing field, so it is tempting to exclude -- but the binding asks
    // "does what we are about to dispatch match what was approved?", not "is the
    // price the same?". The name is part of the request that gets sent, so a
    // change to it means dispatching a body the fan never approved.
    expect(computeShipToDigest(toShipTo({ ...ADDRESS, fullName: 'Someone Else' }))).not.toBe(
      computeShipToDigest(toShipTo(ADDRESS)),
    );
  });

  it('treats every field of the destination as material', () => {
    // Recorded as a blanket assertion on purpose: if a field is ever added to
    // ShipTo, this fails and forces a decision about whether it binds, rather
    // than the new field being silently ignored.
    const keys = Object.keys(ADDRESS) as Array<keyof typeof ADDRESS>;

    for (const key of keys) {
      expect(computeShipToDigest(toShipTo({ ...ADDRESS, [key]: 'something-different' }))).not.toBe(
        computeShipToDigest(toShipTo(ADDRESS)),
      );
    }
  });
});
