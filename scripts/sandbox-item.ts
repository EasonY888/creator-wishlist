/**
 * Resolve an item the sandbox shop can actually fulfil.
 *
 * NOT a runnable script — a helper the demo scripts import.
 *
 * The sandbox shop's stock changes. On 2026-09-19 the Hex Token Fidget sold out,
 * and every script that hardcoded its SKU died at the *first* quote: the scored
 * cap-refusal demo, the ceiling-order park, and the preflight check that reads it.
 * Nothing was wrong with those scripts — a real shop's inventory simply
 * invalidated a constant.
 *
 * The provider will tell us what is buyable. Quoting a SKU that matches nothing
 * returns its closest real alternatives, each carrying an `available` flag, so
 * this picks one that is genuinely purchasable rather than trusting a fixture
 * that can go stale between builds.
 */
import type { AgnicPort } from '../src/agnic/port';
import type { ShipTo } from '../src/agnic/types';

export const SANDBOX_MERCHANT_ID = 'merchant_untitled_fidget_shop';
export const SANDBOX_MERCHANT_NAME = 'untitled-fidget.shop';

/** Deliberately not a real variant, so the provider answers with suggestions. */
const UNMATCHABLE_SKU = 'gid://shopify/ProductVariant/1';

export interface SandboxItem {
  sku: string;
  title: string;
  priceMinor: number | null;
}

/**
 * Ask the provider which of the shop's items are buyable, and return the first
 * that is. Throws rather than returning a guess: a script that quotes a
 * sold-out item reports a misleading failure, which is exactly what happened.
 */
export async function resolveSandboxItem(
  agnic: AgnicPort,
  shipTo: ShipTo,
): Promise<SandboxItem> {
  const outcome = await agnic.quoteGift({
    merchant_id: SANDBOX_MERCHANT_ID,
    items: [{ sku: UNMATCHABLE_SKU, quantity: 1 }],
    ship_to: shipTo,
  });

  if (outcome.state !== 'unknown_sku') {
    throw new Error(
      `expected ${SANDBOX_MERCHANT_NAME} to return its closest matches; got "${outcome.state}"`,
    );
  }

  const buyable = outcome.suggestions.find((suggestion) => suggestion.available === true);

  if (buyable === undefined) {
    throw new Error(
      `no item at ${SANDBOX_MERCHANT_NAME} is currently available — the sandbox shop is sold out`,
    );
  }

  return {
    sku: buyable.sku,
    title: buyable.name ?? buyable.sku,
    priceMinor: buyable.priceMinor,
  };
}
