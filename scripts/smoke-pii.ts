/**
 * The privacy boundary, as it applies to things that get written down.
 *
 * R-14 asks that address and payment data be scrubbed from fan-facing *and
 * general-purpose* logs. The DTO split already handles what a fan can see, and is
 * covered elsewhere. This covers the other direction: what ends up in an error
 * message or a log line, which is reachable by operators, support tooling and
 * whoever reads the terminal.
 *
 * The current code is clean by construction rather than by filtering -- error
 * messages name the FIELD that changed, never its value. That is the property
 * worth pinning, because the tempting way to write a better error message is to
 * include the two values being compared, and for `ship_to` that means writing a
 * creator's home address into a log.
 */
import { computeRequestDigest, computeShipToDigest, type BoundRequest } from '../src/fulfillment/binding';
import { assertRequestBinding, RequestBindingError } from '../src/fulfillment/binding';
import { toShipTo } from '../src/agnic/port';
import { findSensitiveFields } from '../src/presentation/sensitive';

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass, detail });
}

/**
 * Values chosen to be unmistakable. If any of these appears in a message, a
 * creator's real address would appear in the same position.
 */
const SECRET_STREET = 'ZZTOP-SECRET-STREET-9911';
const SECRET_POSTAL = 'ZZ9Z9Z';
const SECRET_PHONE = '+1-555-0000-SECRET';

const APPROVED = {
  fullName: 'Creator Example',
  streetAddress: SECRET_STREET,
  addressLocality: 'Toronto',
  addressRegion: 'ON',
  postalCode: SECRET_POSTAL,
  addressCountry: 'CA',
  phone: SECRET_PHONE,
};

const MOVED = { ...APPROVED, streetAddress: 'ZZBOTTOM-OTHER-STREET-2200', postalCode: 'ZZ1Z1Z' };

function bound(shipTo: ReturnType<typeof toShipTo>): BoundRequest {
  return {
    merchant_id: 'merchant_pii',
    items: [{ sku: 'sku-pii', quantity: 1 }],
    ship_to: shipTo,
    currency: 'CAD',
    amount_minor: 1000,
  };
}

const approvedShipTo = toShipTo(APPROVED);
const approved = bound(approvedShipTo);
const movedShipTo = toShipTo(MOVED);
const current = bound(movedShipTo);

// ---------------------------------------------------------------------------
// 1. A changed address must not be quoted back in the error
// ---------------------------------------------------------------------------

{
  let caught: unknown = null;

  try {
    assertRequestBinding({
      approvedRequestDigest: computeRequestDigest(approved),
      approvedShipToDigest: computeShipToDigest(approvedShipTo),
      current,
      approved: { ...approved, ship_to: undefined } as unknown as Omit<BoundRequest, 'ship_to'>,
      approvedShipTo,
    });
  } catch (error) {
    caught = error;
  }

  check('binding: the change is caught at all', caught instanceof RequestBindingError, String(caught));

  if (caught instanceof RequestBindingError) {
    const message = caught.message;

    check(
      'binding: the OLD street is not in the message',
      !message.includes(SECRET_STREET),
      message.includes(SECRET_STREET) ? 'LEAKED' : 'absent',
    );

    check(
      'binding: the NEW street is not in the message',
      !message.includes('ZZBOTTOM-OTHER-STREET-2200'),
      message.includes('ZZBOTTOM-OTHER-STREET-2200') ? 'LEAKED' : 'absent',
    );

    check(
      'binding: no postal code is in the message',
      !message.includes(SECRET_POSTAL) && !message.includes('ZZ1Z1Z'),
      'absent',
    );

    check(
      'binding: no phone number is in the message',
      !message.includes(SECRET_PHONE),
      message.includes(SECRET_PHONE) ? 'LEAKED' : 'absent',
    );

    // It should still be *useful*. A message that says nothing leaks nothing and
    // helps nobody.
    check(
      'binding: but it does name the fields that changed',
      caught.changedFields.includes('street_address') ||
        caught.changedFields.includes('postal_code'),
      caught.changedFields.join(', ') || '(none)',
    );

    check(
      'binding: and the error code is machine-readable',
      caught.code === 'ship_to_changed',
      caught.code,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. The same check over every string in the error object
// ---------------------------------------------------------------------------

{
  let caught: unknown = null;

  try {
    assertRequestBinding({
      approvedRequestDigest: computeRequestDigest(approved),
      approvedShipToDigest: computeShipToDigest(approvedShipTo),
      current,
      approved: { ...approved, ship_to: undefined } as unknown as Omit<BoundRequest, 'ship_to'>,
      approvedShipTo,
    });
  } catch (error) {
    caught = error;
  }

  // Not just `.message` -- own enumerable properties are what a structured
  // logger serialises, so anything reachable there is effectively logged.
  const serialised = caught instanceof Error
    ? `${caught.message} ${caught.name} ${JSON.stringify(caught, Object.getOwnPropertyNames(caught))}`
    : String(caught);

  const leaks = [SECRET_STREET, SECRET_POSTAL, SECRET_PHONE, 'ZZBOTTOM-OTHER-STREET-2200'].filter(
    (value) => serialised.includes(value),
  );

  check(
    'errors: nothing sensitive survives serialisation',
    leaks.length === 0,
    leaks.length === 0 ? 'clean' : `LEAKED: ${leaks.join(', ')}`,
  );

  // The failure detector itself must not be vacuous.
  check(
    'errors: the detector would notice a leak',
    findSensitiveFields({ streetAddress: SECRET_STREET }).length > 0,
    'findSensitiveFields flags a raw address key',
  );
}

// ---------------------------------------------------------------------------

const width = Math.max(...checks.map((c) => c.name.length));
console.log('');
for (const c of checks) {
  console.log(`${c.name.padEnd(width)}  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.detail}`);
}

const failures = checks.filter((c) => !c.pass);

console.log(
  `\n${failures.length === 0 ? `All ${checks.length} checks passed.` : `${failures.length} of ${checks.length} FAILED.`}`,
);
