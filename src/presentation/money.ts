/**
 * Formatting money for humans.
 *
 * Amounts are stored as integer minor units everywhere — never floats — because
 * a rounding error in a price is a charge that does not match what the fan
 * approved. The only place they become decimal is here, for display.
 */

export function formatMoney(minor: number | null | undefined, currency: string): string {
  if (minor === null || minor === undefined) return '—';

  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
  }).format(minor / 100);
}

/** "3 minutes ago", for a price's freshness indicator. */
export function relativeTime(from: Date | null | undefined, now = new Date()): string {
  if (!from) return 'never';

  const seconds = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
  if (seconds < 60) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * A bare duration, for "how long has this been in this state".
 *
 * Distinct from `relativeTime`, which needs a timestamp. An operator cares how
 * long an order has been stuck, not when it was created.
 */
export function durationWords(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;

  const days = Math.round(hours / 24);
  return `${days} d`;
}
