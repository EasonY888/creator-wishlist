/**
 * Wire types for the provider's HTTP API.
 *
 * These mirror the API's own field names, including the places where it names
 * one thing two different ways. They are deliberately separate from the domain
 * types in `src/domain`: the adapters translate between the two, so a provider
 * field rename lands in one file rather than everywhere.
 *
 * Monetary values are always integer minor units in the quote's currency.
 */

// ---------------------------------------------------------------------------
// Destination
// ---------------------------------------------------------------------------

/** Where the parcel goes. Field names are the provider's, not ours. */
export interface ShipTo {
  name: string;
  street_address: string;
  address_locality: string;
  postal_code: string;
  /** ISO-3166-1 alpha-2. */
  address_country: string;
  /** Required for CA, US and AU — those checkouts will not complete without it. */
  address_region?: string;
  phone?: string;
}

/**
 * Spending limits, in minor units of the order currency.
 *
 * Over HTTP these are the caller's own caps and are re-checked before the card
 * is used. Unlike the tool layer they are not bound into a token, so the binding
 * is ours to enforce — see `ApprovedRequest.requestDigest`.
 */
export interface Constraints {
  max_total_minor?: number;
  max_shipping_minor?: number;
}

// ---------------------------------------------------------------------------
// Merchants
// ---------------------------------------------------------------------------

/** `shopify` merchants quote live prices and accept a delivery address. */
export type MerchantRail = 'shopify' | 'worker' | (string & {});

export interface Merchant {
  /** Route `GET /merchants` returns the id under `id`. */
  id: string;
  name?: string | null;
  domain?: string | null;
  rail?: MerchantRail | null;
  /** True for stores the provider runs for testing. See the note on orders' `test`. */
  is_test?: boolean | null;
}

// ---------------------------------------------------------------------------
// Product discovery
// ---------------------------------------------------------------------------

export interface SearchProduct {
  sku: string;
  title?: string | null;
  variant_title?: string | null;
  /** Browse-time only. Never a quote. */
  price_minor?: number | null;
  currency?: string | null;
  available?: boolean | null;
  /**
   * Search results expose the merchant id as `merchant_id`, NOT `id`.
   * Same identity as `Merchant.id`, different field name.
   */
  merchant?: {
    merchant_id?: string | null;
    name?: string | null;
    domain?: string | null;
  } | null;
  /**
   * Present when the shop is not yet a merchant. That is normal and is most of
   * the network: it needs `POST /explore` before it can be quoted.
   */
  onboard?: { merchant_url?: string | null } | null;
}

export interface ProductSearchResponse {
  query: string;
  country: string;
  currency?: string | null;
  shops_searched?: number | null;
  /** More than one means the pool exceeded the per-call ceiling and was chunked. */
  chunks?: number | null;
  products: SearchProduct[];
}

export interface ProductLookupResponse {
  sku: string;
  title?: string | null;
  variant_title?: string | null;
  price_minor?: number | null;
  currency?: string | null;
  available?: boolean | null;
  merchant?: { merchant_id?: string | null; name?: string | null } | null;
  onboard?: { merchant_url?: string | null } | null;
  variant_note?: string | null;
  price_note?: string | null;
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

export interface FulfillmentOption {
  id: string;
  /**
   * `shipping` | `local` | `pickup` | `none` | `other` | ...
   *
   * Kept as a loose string because the provider assigns `other` to any method it
   * does not recognise, and a closed union would tempt callers into an allowlist
   * that silently drops those.
   */
  type?: string | null;
  title?: string | null;
  price_minor?: number | null;
  /** Present on live responses, and needed to price the option correctly. */
  currency?: string | null;
  /** True when the option cannot be priced without a destination. */
  requires_address?: boolean | null;
}

export interface QuoteRequest {
  merchant_id: string;
  items: { sku: string; quantity: number }[];
  ship_to: ShipTo;
  constraints?: Constraints;
  /** Required once a delivery option has been chosen; omit on the first call. */
  fulfillment_option_id?: string;
}

export interface QuoteResponse {
  rail?: string | null;

  fulfillment_options?: FulfillmentOption[] | null;
  /** True when there is a real choice and none has been made. */
  requires_fulfillment_choice?: boolean | null;
  selected_option_id?: string | null;

  /**
   * `true`  — tax-inclusive and this IS the charge.
   * `false` — the merchant adds tax at checkout and this is a CEILING the real
   *           charge stays under. Never present a ceiling as the total.
   * `null`  — a delivery choice is outstanding; there is no honest amount yet.
   */
  expected_amount_minor?: number | null;
  amount_is_final?: boolean | null;
  subtotal_minor?: number | null;
  charge_estimate_minor?: number | null;
  charge_cap_minor?: number | null;

  currency?: string | null;
  basket_url?: string | null;
  lines?: unknown[] | null;

  /**
   * Echoed back REDACTED — the street is omitted, but the name, city and postal
   * code can remain. Still sensitive: never forward this object to a fan.
   */
  ship_to?: Partial<ShipTo> | null;
  /** Digest of the destination this quote was priced for. Our change detector. */
  ship_to_sha256?: string | null;
  /** When true the merchant also sees the delivery address on the card. */
  billing_uses_ship_to?: boolean | null;

  constraints?: Constraints | null;

  /**
   * The merchant cannot fulfil this buyer at all.
   *
   * An OBJECT, not a boolean — test for its presence, never for truthiness of a
   * flag. When present, `expected_amount_minor` is null and there are no options.
   */
  unfulfillable?: Record<string, unknown> | null;
  pickup_resolution?: Record<string, unknown> | null;
}

/**
 * A suggestion returned when a SKU matched nothing at a merchant.
 *
 * The `sku` is ready to hand straight back to another quote — the provider says
 * so explicitly. Treating these as a failed lookup rather than an answer is the
 * difference between a dead end and "did you mean the Paw Print Charm?".
 */
export interface SkuSuggestionWire {
  sku: string;
  name?: string | null;
  price_minor?: number | null;
  currency?: string | null;
  available?: boolean | null;
}

/** A refusal body that may still carry something actionable. */
export interface QuoteErrorBody {
  error?: string | null;
  code?: string | null;
  detail?: string | null;
  /** Present when the code is `unknown_sku`. */
  unknown_skus?: string[] | null;
  suggestions?: SkuSuggestionWire[] | null;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface DispatchRequest extends QuoteRequest {
  /** Must be the bound figure from the quote, not the figure originally asked for. */
  amount_minor: number;
  currency?: string;
  card_alias_id?: string;
  /** The fan's literal affirmative words. Dispute evidence; <= 500 chars. */
  user_confirmation_text: string;
  user_approved_at_iso: string;
  /** The fan's ORIGINAL request, not their yes. */
  user_prompt?: string;
  /** Present only when resuming after a step-up approval. */
  approval_token?: string;
}

export interface DispatchResponse {
  order_id?: string | null;
  status?: string | null;
  worker_job_id?: string | null;

  /**
   * Operator-only. This streams the checkout live and retains the receipt and
   * evidence afterwards — which contains the delivery address in full. Never
   * give either URL to a fan.
   */
  order_url?: string | null;
  live_view_url?: string | null;

  // Approval-required (HTTP 202)
  approval_required?: boolean | null;
  approval_token?: string | null;
  approval_url?: string | null;
  expires_in?: number | null;
  reason?: string | null;

  error?: string | null;
  error_description?: string | null;
  detail?: string | null;
}

/**
 * Why a dispatch was asked to wait for an approval.
 *
 * The distinction matters because two of the three are routine and one is
 * permanent. A security-code refresh recurs roughly hourly and is resolved by
 * re-entering digits. A mandate step-up is resolved by polling the approval. A
 * currency mismatch never resolves on its own — the mandate has to be reissued
 * in the store's currency.
 */
export const APPROVAL_REASONS = {
  /** Vault holds a card's security code ~50 minutes. Recurs roughly hourly. */
  CVV_REFRESH_REQUIRED: 'cvv_refresh_required',
  /** The purchase falls outside the signed mandate and needs a passkey approval. */
  APPROVAL_NOT_READY: 'approval_not_ready',
  /** Permanent until the mandate is reissued in the store's currency. */
  CURRENCY_MISMATCH: 'currency_mismatch',
} as const;

/** Pre-charge refusals. All arrive before any card is used, so all are safe. */
export const REFUSAL_CODES = {
  SHIP_TO_UNSUPPORTED: 'ship_to_unsupported',
  SHIP_TO_WITH_PICKUP: 'ship_to_with_pickup',
  SHIP_TO_MISMATCH: 'ship_to_mismatch',
  CONSTRAINT_VIOLATED: 'constraint_violated',
  /**
   * The live code for a spending-cap breach, observed against the sandbox:
   * a cap of 500 against a 1495 total returns 409 `constraint_total_exceeded`.
   *
   * `CONSTRAINT_VIOLATED` above is what the fake emits and what the provider
   * documents; this is what it actually returns. Both are listed because
   * nothing branches on the code — `refusedBeforeCard` keys off the evidence
   * and the retry action — so either spelling is handled safely.
   */
  CONSTRAINT_TOTAL_EXCEEDED: 'constraint_total_exceeded',
  SHOPIFY_AMOUNT_CHANGED: 'shopify_amount_changed',
  PICKUP_LOCATION_UNRESOLVED: 'pickup_location_unresolved',
} as const;

// ---------------------------------------------------------------------------
// Order status
// ---------------------------------------------------------------------------

export interface OrderResponse {
  id: string;
  status: string;
  /** The APPROVED figure — a ceiling on tax-added markets. */
  amount_minor?: number | null;
  /** What the merchant's own page said. May be below the approved figure. */
  amount_charged_minor?: number | null;
  currency?: string | null;
  retryable?: boolean | null;
  retry_action?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  constraints?: Constraints | null;

  /**
   * Describes whether the MERCHANT is a designated test merchant — not whether
   * this order was practice. Orders placed against the sandbox report
   * `test: false`, because that sandbox is an ordinary shop whose gateway is in
   * test mode. Do not branch on this field.
   */
  test?: boolean | null;

  /** CONTAINS THE DELIVERY ADDRESS IN FULL. Operator-only, never fan-facing. */
  evidence?: { charge_state?: string | null; [k: string]: unknown } | null;

  live_view_url?: string | null;
}

export interface ApprovalResponse {
  status: string;
  [k: string]: unknown;
}
