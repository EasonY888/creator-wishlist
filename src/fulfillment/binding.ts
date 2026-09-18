import { createHash } from 'node:crypto';
import type { Constraints, QuoteRequest, ShipTo } from '../agnic/types';

/**
 * Binding over the request we are about to spend against.
 *
 * Over HTTP the provider does not bind the dispatch body to the quote it was
 * issued against — it rebuilds the cart and refuses on its own terms. The tool
 * layer gets a confirmation token for this; we do not. So the binding is ours to
 * enforce, immediately before the card is used.
 *
 * Two things are being defended against, with one mechanism:
 *
 *   1. The approved request being altered between approval and dispatch.
 *   2. The creator's address having changed since the quote was priced, which
 *      invalidates the shipping and tax the fan agreed to.
 *
 * Both reduce to: recompute the digest from current state and compare.
 */

/** The fields that were priced and approved. Everything else is presentation. */
export interface BoundRequest {
  merchant_id: string;
  items: { sku: string; quantity: number }[];
  ship_to: ShipTo;
  currency: string;
  amount_minor: number;
  constraints?: Constraints;
  fulfillment_option_id?: string;
}

/**
 * Serialize with recursively sorted object keys.
 *
 * This is not cosmetic. Postgres `jsonb` — which is what Prisma's `Json` type
 * maps to — does NOT preserve key order. A digest taken over a naive
 * `JSON.stringify` would therefore change every time the request made a round
 * trip through the database, and every dispatch would fail its own binding check
 * while looking exactly like "the creator changed their address".
 *
 * Array order IS preserved by `jsonb`, so arrays are left alone: item order is
 * meaningful and must survive unchanged.
 *
 * `undefined` members are dropped rather than serialized, so an absent optional
 * field and an explicitly-undefined one produce the same digest.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return Object.fromEntries(entries.map(([k, v]) => [k, sortDeep(v)]));
  }

  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Digest of the destination alone.
 *
 * Stored on quotes so an address change can be detected by comparison instead of
 * by timestamps, and so the address itself never has to be duplicated into a
 * quote row.
 */
export function computeShipToDigest(shipTo: ShipTo): string {
  return sha256Hex(canonicalize(shipTo));
}

/** Digest over every field that was priced. */
export function computeRequestDigest(request: BoundRequest): string {
  return sha256Hex(canonicalize(request));
}

/**
 * Read a field off a `ShipTo` by name.
 *
 * `ShipTo` has no index signature, so a direct cast to `Record<string, unknown>`
 * is rejected. Going through `unknown` states the intent honestly: we are
 * deliberately treating a known shape as an open bag of fields in order to
 * diff it.
 */
function fieldOf(shipTo: ShipTo, key: string): unknown {
  return (shipTo as unknown as Record<string, unknown>)[key];
}

/**
 * Which destination fields differ, by name.
 *
 * Mirrors the provider's own habit of naming the offending field rather than
 * making the caller guess: "the approved destination is not the one sent" is far
 * less useful than "postal_code changed".
 */
export function changedShipToFields(before: ShipTo, after: ShipTo): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];

  for (const key of keys) {
    if (fieldOf(before, key) !== fieldOf(after, key)) changed.push(key);
  }

  return changed.sort();
}

export class RequestBindingError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'ship_to_changed'
      | 'request_changed'
      | 'amount_changed'
      | 'currency_changed',
    readonly changedFields: string[] = [],
  ) {
    super(message);
    this.name = 'RequestBindingError';
  }
}

export interface VerifyBindingInput {
  /** Digest recorded when the fan approved. */
  approvedRequestDigest: string;
  approvedShipToDigest: string;
  /** The request as it would be sent right now, with the CURRENT address. */
  current: BoundRequest;
  /**
   * The request as approved, minus the destination. Used only to produce a
   * useful error message; the digests are the actual gate.
   */
  approved: Omit<BoundRequest, 'ship_to'>;
  /** The destination as approved, when we still hold it for diagnostics. */
  approvedShipTo?: ShipTo;
}

/**
 * Recompute both digests from current state and refuse to proceed on any
 * difference.
 *
 * Order matters for the quality of the error rather than for safety: the
 * destination is checked first, because an address change is the expected cause
 * and the one an operator can act on.
 */
export function assertRequestBinding(input: VerifyBindingInput): void {
  const currentShipToDigest = computeShipToDigest(input.current.ship_to);

  if (currentShipToDigest !== input.approvedShipToDigest) {
    const fields =
      input.approvedShipTo && input.approvedShipTo !== undefined
        ? changedShipToFields(input.approvedShipTo, input.current.ship_to)
        : [];

    throw new RequestBindingError(
      'The creator\u2019s delivery address changed after this order was approved, ' +
        'so the quoted shipping and tax no longer apply. A fresh quote and a ' +
        'renewed approval are required.' +
        (fields.length ? ` Changed: ${fields.join(', ')}.` : ''),
      'ship_to_changed',
      fields,
    );
  }

  if (input.current.currency !== input.approved.currency) {
    throw new RequestBindingError(
      `Currency changed from ${input.approved.currency} to ${input.current.currency}.`,
      'currency_changed',
      ['currency'],
    );
  }

  if (input.current.amount_minor !== input.approved.amount_minor) {
    throw new RequestBindingError(
      `Approved amount changed from ${input.approved.amount_minor} to ` +
        `${input.current.amount_minor}. Never dispatch a figure the fan did not approve.`,
      'amount_changed',
      ['amount_minor'],
    );
  }

  const currentDigest = computeRequestDigest(input.current);
  if (currentDigest !== input.approvedRequestDigest) {
    throw new RequestBindingError(
      'The approved request no longer matches what would be dispatched. ' +
        'Re-quote and obtain a fresh approval rather than sending the difference.',
      'request_changed',
    );
  }
}

/**
 * Rebuild the full request from stored fields plus the creator's CURRENT
 * address.
 *
 * The address is resolved here and nowhere else, which is what keeps it out of
 * every other row and out of every fan-facing path. If the creator has since
 * changed it, this produces a request whose digest will not match — which is
 * precisely the detection mechanism, not a bug.
 */
export function rebuildBoundRequest(
  stored: Omit<BoundRequest, 'ship_to'>,
  currentShipTo: ShipTo,
): BoundRequest {
  return {
    merchant_id: stored.merchant_id,
    items: stored.items,
    currency: stored.currency,
    amount_minor: stored.amount_minor,
    ...(stored.constraints === undefined ? {} : { constraints: stored.constraints }),
    ...(stored.fulfillment_option_id === undefined
      ? {}
      : { fulfillment_option_id: stored.fulfillment_option_id }),
    ship_to: currentShipTo,
  };
}

/** Narrow a quoted request into the bound subset. */
export function toBoundRequest(
  request: QuoteRequest,
  amountMinor: number,
  currency: string,
): BoundRequest {
  return {
    merchant_id: request.merchant_id,
    items: request.items,
    currency,
    amount_minor: amountMinor,
    ...(request.constraints === undefined ? {} : { constraints: request.constraints }),
    ...(request.fulfillment_option_id === undefined
      ? {}
      : { fulfillment_option_id: request.fulfillment_option_id }),
    ship_to: request.ship_to,
  };
}
