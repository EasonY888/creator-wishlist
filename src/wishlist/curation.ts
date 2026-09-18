/**
 * Wishlist curation.
 *
 * A creator pastes a product link and it lands on their wishlist. The whole
 * value of this module is that it does not trust the link: the provider is asked
 * what the URL actually resolves to, and only a real, buyable product is stored.
 *
 * Copying the title and price out of the page would be the easy version and the
 * wrong one -- a screenshot of a price is not a quote, and a title scraped from a
 * page cannot be re-derived later. So the identity stored here is the provider's
 * (`merchantId` + `sku`), and the price is explicitly a hint.
 */
import type { AgnicPort } from '../agnic/port';
import type { Db } from '../db/types';

export interface CurationDeps {
  db: Db;
  agnic: AgnicPort;
}

export type AddItemOutcome =
  | {
      state: 'added';
      itemId: string;
      title: string;
      merchantName: string | null;
      /** Browse-time hint only. The real figure comes from a quote at checkout. */
      indicativePriceMinor: number | null;
      currency: string | null;
      /** The provider already knows it cannot be bought. Worth saying up front. */
      available: boolean | null;
      variantNote: string | null;
    }
  | { state: 'already_listed'; title: string }
  | { state: 'creator_not_found' }
  /** A shop or collection link, not an item. */
  | { state: 'not_a_product_url'; detail: string }
  /** The page resolved, but to nothing buyable. Usually a missing `?variant=`. */
  | { state: 'variant_not_found'; detail: string }
  /** The shop is not yet a merchant, so it cannot be quoted or ordered. */
  | { state: 'needs_onboarding'; merchantUrl: string }
  | { state: 'transport_error'; code: string; detail?: string };

/**
 * Resolve a product URL and add it to a creator's wishlist.
 *
 * Idempotent by the schema's own `@@unique([creatorId, merchantId, sku])`: the
 * same product cannot be listed twice, and a second attempt reports the existing
 * one rather than failing.
 */
export async function addWishlistItemByUrl(
  deps: CurationDeps,
  input: { creatorId: string; url: string },
): Promise<AddItemOutcome> {
  const url = input.url.trim();

  const creator = await deps.db.creator.findUnique({
    where: { id: input.creatorId },
    select: { id: true },
  });

  if (!creator) return { state: 'creator_not_found' };

  const lookup = await deps.agnic.lookupProduct({ url });

  switch (lookup.state) {
    case 'not_a_product_url':
      return { state: 'not_a_product_url', detail: lookup.detail };
    case 'variant_not_found':
      return { state: 'variant_not_found', detail: lookup.detail };
    case 'transport_error':
      return {
        state: 'transport_error',
        code: lookup.code,
        ...(lookup.detail === undefined ? {} : { detail: lookup.detail }),
      };
    case 'ok':
      break;
  }

  // A shop that has not been onboarded cannot be quoted or ordered, so listing it
  // would create an item that fails at checkout with no explanation.
  if (!lookup.merchantId) {
    if (lookup.onboardUrl) {
      return { state: 'needs_onboarding', merchantUrl: lookup.onboardUrl };
    }
    return {
      state: 'transport_error',
      code: 'merchant_unresolved',
      detail: 'The provider could not tell us which shop this product belongs to.',
    };
  }

  const merchantId = lookup.merchantId;
  const existing = await deps.db.wishlistItem.findUnique({
    where: { creatorId_merchantId_sku: { creatorId: creator.id, merchantId, sku: lookup.sku } },
    select: { id: true, title: true },
  });

  if (existing) return { state: 'already_listed', title: existing.title };

  // The provider's name for the product. Falling back to the SKU rather than
  // inventing a title -- an ugly-but-true name beats a plausible-but-false one.
  const title = lookup.title?.trim() || lookup.sku;

  const item = await deps.db.wishlistItem.create({
    data: {
      creatorId: creator.id,
      merchantId,
      merchantName: lookup.merchantName ?? null,
      sku: lookup.sku,
      title,
      variantTitle: lookup.variantTitle ?? null,
      // Provisional. The stored currency is a display default; every figure a fan
      // sees comes from a live quote, which carries its own currency and wins.
      currency: lookup.currency ?? 'CAD',
      lastPriceMinor: lookup.priceMinor ?? null,
      // Deliberately left as `quote_required`: nothing here has been quoted, and
      // marking it verified would claim a check this function did not perform.
      status: 'quote_required',
    },
    select: { id: true },
  });

  return {
    state: 'added',
    itemId: item.id,
    title,
    merchantName: lookup.merchantName ?? null,
    indicativePriceMinor: lookup.priceMinor ?? null,
    currency: lookup.currency ?? null,
    available: lookup.available ?? null,
    variantNote: lookup.variantNote ?? null,
  };
}

/** Remove an item, unless a fan already has an order against it. */
export async function removeWishlistItem(
  deps: CurationDeps,
  input: { creatorId: string; itemId: string },
): Promise<{ state: 'removed' } | { state: 'not_found' } | { state: 'has_orders' }> {
  const item = await deps.db.wishlistItem.findUnique({
    where: { id: input.itemId },
    select: { id: true, creatorId: true, quotes: { select: { id: true }, take: 1 } },
  });

  if (!item || item.creatorId !== input.creatorId) return { state: 'not_found' };

  // Orders are financial records with no cascade, on purpose. An item a fan has
  // already bought is history, not a draft, so it is not deletable.
  if (item.quotes.length > 0) return { state: 'has_orders' };

  await deps.db.wishlistItem.delete({ where: { id: item.id } });
  return { state: 'removed' };
}
