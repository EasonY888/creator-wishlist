/**
 * A guard against the one leak this product cannot survive.
 *
 * "Never send the creator's address to a fan" is easy to state and easy to break
 * — one spread of a database row into a response and it is gone. Type-checking
 * gets most of the way there, because the fan projection does not accept a row
 * that could contain an address. This catches what types cannot: a field
 * smuggled in through a nested object, a JSON blob, or an untyped provider
 * response.
 *
 * Used in two places: a runtime assertion before anything fan-facing is
 * serialized, and a test that scans every fan payload we build.
 */

/**
 * Key names that must never appear in a fan-facing payload.
 *
 * Includes both `snake_case` (the provider's field names, which arrive in raw
 * responses) and `camelCase` (ours), because either spelling could be the one
 * that gets copied across.
 *
 * Deliberately excludes generic names like `name`, which appear legitimately —
 * a creator's display name is fan-facing. Over-broad bans get switched off.
 */
export const FORBIDDEN_FAN_KEYS: readonly string[] = [
  'ship_to',
  'shipTo',
  'street_address',
  'streetAddress',
  'address_locality',
  'addressLocality',
  'address_region',
  'addressRegion',
  'postal_code',
  'postalCode',
  'address_country',
  'addressCountry',
  'ship_to_sha256',
  'shipToSha256',
  // Operator-only evidence and live views. The evidence bundle contains the
  // delivery address in full, and the live view streamed the checkout.
  'evidence',
  'order_url',
  'orderUrl',
  'live_view_url',
  'liveViewUrl',
  'approval_url',
  'approvalUrl',
  'basket_url',
  'basketUrl',
];

/**
 * Every path in `value` whose key is forbidden.
 *
 * Returns paths rather than a boolean so a failure names the offending field
 * instead of just asserting something is wrong.
 */
export function findSensitiveFields(
  value: unknown,
  path = '$',
  found: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      findSensitiveFields(item, `${path}[${index}]`, found),
    );
    return found;
  }

  if (value === null || typeof value !== 'object') return found;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_FAN_KEYS.includes(key)) found.push(childPath);
    findSensitiveFields(child, childPath, found);
  }

  return found;
}

export class SensitiveFieldLeakError extends Error {
  constructor(
    readonly context: string,
    readonly paths: string[],
  ) {
    super(
      `Fan-facing payload "${context}" contains ${paths.length} forbidden field(s): ${paths.join(', ')}`,
    );
    this.name = 'SensitiveFieldLeakError';
  }
}

/**
 * Throw if a payload destined for a fan carries anything it must not.
 *
 * Call this immediately before serializing a fan response, so a leak fails
 * loudly in development and staging rather than reaching someone's browser.
 */
export function assertNoSensitiveFields(value: unknown, context: string): void {
  const paths = findSensitiveFields(value);
  if (paths.length > 0) throw new SensitiveFieldLeakError(context, paths);
}
