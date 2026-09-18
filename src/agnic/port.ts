import type { ProviderOrder } from '../domain/provider-status';
import type {
  FulfillmentOption,
  Merchant,
  OrderResponse,
  QuoteRequest,
  QuoteResponse,
  SearchProduct,
  ShipTo,
} from './types';

/**
 * The provider contract.
 *
 * Every method returns a *domain-shaped outcome*, not a raw response. Callers
 * branch on `state`, never on an HTTP status or an error string, which is what
 * lets the same code run against the real API and against a fake that injects
 * failures we cannot summon on demand.
 *
 * Two naming rules exist because the provider uses two names for one identity:
 * the merchants route returns `id`, while product search exposes
 * `merchant.merchant_id`. Normalisation happens in the adapter so no caller has
 * to know which route it came from.
 */
export interface AgnicPort {
  searchProducts(input: SearchProductsInput): Promise<SearchOutcome>;
  lookupProduct(input: { url: string }): Promise<LookupOutcome>;
  /**
   * The provider's own view of our remaining quota, if it reports one.
   *
   * Optional because not every rail is metered. Where it IS metered, read it
   * rather than counting requests locally: the limits are keyed to the API key,
   * so another process or a teammate consumes the same budget and a local tally
   * cannot see that.
   */
  quotaStatus?(): { remaining: number | null; resetSeconds: number | null } | null;

  listMerchants(input?: { query?: string }): Promise<Merchant[]>;
  getMerchant(merchantId: string): Promise<Merchant | null>;

  /**
   * Onboards a shop nobody has bought from before. Slow — up to two minutes — so
   * it returns an id to poll and must never be awaited inside a fan-facing
   * request. Note it can report `exploring` even for a Shopify shop.
   */
  exploreMerchant(input: { merchantUrl: string; goal: string; prefs?: string; currency?: string }): Promise<ExploreOutcome>;

  quoteGift(request: QuoteRequest): Promise<QuoteOutcome>;

  /**
   * THE call that spends money. Must be issued at most once per fan order, with
   * the exception of a single resumption carrying an unexpired approval token.
   */
  dispatch(request: DispatchInput): Promise<DispatchOutcome>;

  /**
   * Read the provider's own record of an order.
   *
   * Returns the full wire response rather than the narrowed domain subset,
   * because operators need `live_view_url` and the reconciler needs the evidence
   * bundle. Use `toProviderOrder` when only the decision fields matter. This
   * object is private backend data — never forward it to a fan.
   */
  getOrder(orderId: string): Promise<OrderResponse>;
  getApproval(token: string): Promise<ApprovalOutcome>;

  /**
   * Cards on file for this account.
   *
   * For verifying setup, not for moving money — dispatch uses the default card.
   * Card numbers never reach application code, so this returns display data
   * only. An empty list is a meaningful answer, not an error: it means no
   * purchase on the card rail can succeed yet.
   */
  listCards(): Promise<VaultedCard[]>;
}

/** Display data for a vaulted card. Never a number, never a vault alias. */
export interface VaultedCard {
  id: string;
  brand: string | null;
  /** The provider returns this as `last_four`. */
  lastFour: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  isDefault: boolean;
}

export interface SearchProductsInput {
  query: string;
  /**
   * The market the parcel is going TO, not where the buyer banks. The four
   * supported markets have hand-vetted shop pools; anything else is an answer
   * rather than a retryable error.
   */
  country: 'US' | 'GB' | 'CA' | 'AU';
  limit?: number;
}

export interface DispatchInput {
  request: QuoteRequest & {
    amount_minor: number;
    currency?: string;
    user_confirmation_text: string;
    user_approved_at_iso: string;
    user_prompt?: string;
    approval_token?: string;
  };
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type SearchOutcome =
  | {
      state: 'ok';
      products: SearchProduct[];
      currency?: string | null;
      shopsSearched?: number | null;
      chunks?: number | null;
    }
  /** A market we do not serve. An answer, not a transient failure. */
  | { state: 'unsupported_country'; detail: string }
  /**
   * The catalogue did not answer. Distinct from an empty result on purpose:
   * reporting this as "the product does not exist" would be a lie.
   */
  | { state: 'catalog_unavailable'; detail: string }
  | { state: 'transport_error'; code: string; detail?: string };

export type LookupOutcome =
  | {
      state: 'ok';
      sku: string;
      merchantId?: string | null;
      merchantName?: string | null;
      onboardUrl?: string | null;
      variantNote?: string | null;
      /**
       * Carried through because curation cannot store a wishlist item without a
       * name, and the provider is the only party that knows what the product is
       * called. Discarding these would mean either inventing a title or asking a
       * creator to type one out for a product the API already described.
       *
       * `priceMinor` is browse-time and is NEVER a quote. It is a hint for
       * curation only, and must not reach a fan -- see `pricing.ts`.
       */
      title?: string | null;
      variantTitle?: string | null;
      priceMinor?: number | null;
      currency?: string | null;
      available?: boolean | null;
    }
  | { state: 'not_a_product_url'; detail: string }
  | { state: 'variant_not_found'; detail: string }
  | { state: 'transport_error'; code: string; detail?: string };

export type ExploreOutcome =
  | { state: 'poll'; orderId: string; merchantId?: string | null }
  | { state: 'refused'; httpStatus: number; code: string }
  | { state: 'transport_error'; code: string; detail?: string };

export type QuoteOutcome =
  /**
   * Priced and chargeable. `request` is the private snapshot to replay at
   * dispatch — it carries `ship_to`, which the quote response does NOT give
   * back, so this object is the only complete record of what was priced.
   */
  | {
      state: 'ready';
      request: QuoteRequest;
      quote: QuoteResponse;
      deliveryOptions: FulfillmentOption[];
    }
  /** A delivery choice is outstanding and the provider withheld the amount. */
  | { state: 'choose_delivery'; deliveryOptions: FulfillmentOption[] }
  /** The merchant cannot fulfil this buyer at all. */
  | { state: 'unfulfillable'; detail?: Record<string, unknown> }
  /**
   * The SKU matched nothing at this merchant.
   *
   * Deliberately its own outcome rather than folded into `refused`: the provider
   * returns the closest real products and states that their `sku` values are
   * ready to re-quote. Collapsing this to a refusal discards a recoverable
   * situation and produces the one thing the provider warns against — telling a
   * user an item does not exist.
   */
  | {
      state: 'unknown_sku';
      unknownSkus: string[];
      suggestions: SkuSuggestion[];
      detail: string;
    }
  /** Refused before anything was charged. */
  | { state: 'refused'; httpStatus: number; code: string; detail?: string }
  | { state: 'transport_error'; code: string; detail?: string };

/** A candidate the provider offers in place of a SKU that matched nothing. */
export interface SkuSuggestion {
  sku: string;
  name: string | null;
  priceMinor: number | null;
  currency: string | null;
  available: boolean | null;
}

export type DispatchOutcome =
  /**
   * An order id exists, so the outcome is knowable. Poll it.
   *
   * This variant deliberately absorbs refusals that still name an order, because
   * an order id is more actionable than the status code that came with it. The
   * original status travels along so callers can still tell a price change from
   * a plain acceptance.
   */
  | { state: 'poll'; orderId: string; httpStatus?: number; code?: string }
  /**
   * A step-up is required. Routine, not a failure — and bounded by a short
   * expiry, so an expired token means a fresh quote and a fresh approval rather
   * than a resumed attempt.
   */
  | {
      state: 'approval_required';
      token: string;
      approvalUrl: string;
      expiresInSeconds: number;
      reason: string;
      orderId?: string;
    }
  /** Refused before any card was used. */
  | { state: 'refused'; httpStatus: number; code: string; detail?: string }
  /**
   * The outcome cannot be determined locally.
   *
   * A lost response lands here, and it is emphatically not a failure: the
   * purchase may well have completed. Never auto-retry this.
   */
  | { state: 'reconcile'; code: string; httpStatus?: number; orderId?: string };

export type ApprovalOutcome =
  | { state: 'approved' }
  | { state: 'pending' }
  /** Expired or unusable. Requires a fresh quote and a fresh fan approval. */
  | { state: 'expired'; status: string }
  | { state: 'transport_error'; code: string; detail?: string };

// ---------------------------------------------------------------------------
// Helpers shared by every implementation
// ---------------------------------------------------------------------------

/**
 * Keep only options that actually deliver.
 *
 * Exclude by DENYlist — never include by allowlist. An allowlist of
 * `["shipping", "local"]` silently drops the `other` type the provider assigns
 * to any delivery method it does not recognise, and the fan would then see no
 * delivery choices at a shop that delivers perfectly well.
 */
export function deliverableOptions(
  options: FulfillmentOption[] | null | undefined,
): FulfillmentOption[] {
  return (options ?? []).filter(
    (option) => option.type !== 'pickup' && option.type !== 'none',
  );
}

/**
 * `GET /merchants` returns `id`; product search returns `merchant.merchant_id`.
 * One identity, two field names — normalised here so the trap lives in a single
 * place instead of in every caller.
 */
export function merchantIdOf(merchant: Merchant): string {
  return merchant.id;
}

export function merchantIdFromSearch(product: SearchProduct): string | null {
  return product.merchant?.merchant_id ?? null;
}

/** Whether a search result needs onboarding before it can be quoted. */
export function needsOnboarding(product: SearchProduct): boolean {
  return !merchantIdFromSearch(product) && Boolean(product.onboard?.merchant_url);
}

/** Build the destination payload the provider expects. */
export interface AddressForQuote {
  fullName: string;
  streetAddress: string;
  addressLocality: string;
  addressRegion?: string | null;
  postalCode: string;
  addressCountry: string;
  phone?: string | null;
}

export function toShipTo(address: AddressForQuote): ShipTo {
  const shipTo: ShipTo = {
    name: address.fullName,
    street_address: address.streetAddress,
    address_locality: address.addressLocality,
    postal_code: address.postalCode,
    address_country: address.addressCountry,
  };

  // A half-address is not an address: the provider refuses and names the missing
  // field. Only include what we actually hold so the refusal stays specific.
  if (address.addressRegion) shipTo.address_region = address.addressRegion;
  if (address.phone) shipTo.phone = address.phone;

  return shipTo;
}

/** Narrow the wire order response to the subset the domain reasons about. */
export function toProviderOrder(raw: OrderResponse): ProviderOrder {
  return {
    id: raw.id,
    status: raw.status,
    amount_minor: raw.amount_minor ?? null,
    amount_charged_minor: raw.amount_charged_minor ?? null,
    currency: raw.currency ?? null,
    retryable: raw.retryable ?? null,
    retry_action: raw.retry_action ?? null,
    error_code: raw.error_code ?? null,
    evidence: raw.evidence ?? null,
  };
}
