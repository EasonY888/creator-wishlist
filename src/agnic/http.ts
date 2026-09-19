import {
  deliverableOptions,
  type AgnicPort,
  type ApprovalOutcome,
  type DispatchInput,
  type DispatchOutcome,
  type ExploreOutcome,
  type LookupOutcome,
  type QuoteOutcome,
  type SearchOutcome,
  type SearchProductsInput,
  type VaultedCard,
} from './port';
import type {
  ApprovalResponse,
  DispatchResponse,
  Merchant,
  OrderResponse,
  ProductLookupResponse,
  ProductSearchResponse,
  QuoteErrorBody,
  QuoteRequest,
  QuoteResponse,
} from './types';

/**
 * The real provider, over HTTP.
 *
 * Every method returns a domain-shaped outcome so callers never parse a status
 * code. The translation from HTTP to outcome happens here and nowhere else.
 */

export interface AgnicHttpOptions {
  token: string;
  /** Defaults to the provider's public API. Overridden in tests. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The provider's own view of our quota, read from its response headers.
 *
 * Read this rather than counting requests locally: the limits are keyed to the
 * API key, the provider is the authority on what remains, and a local counter
 * cannot see calls made by another process or a teammate.
 */
export interface RateLimitSnapshot {
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
  observedAt: number;
}

interface ErrorBody {
  error?: string;
  error_description?: string;
  detail?: string;
  message?: string;
}

const DEFAULT_BASE_URL = 'https://api.agnic.ai/api/autofill';

export class AgnicHttpClient implements AgnicPort {
  private readonly baseUrl: string;

  /**
   * The provider's API root -- the parent of the `/autofill` namespace.
   *
   * Not every route lives under `/autofill`. The approval endpoint is at
   * `/api/approvals/{token}`, and asking for it under the autofill prefix returns
   * Express's HTML 404 (`Cannot GET /api/autofill/approvals/...`). The defensive
   * JSON parse below turns that into `non_json_response`, which reads as a
   * transient network fault -- so the worker retried it forever while the order
   * sat in `approval_required` with nothing on screen saying why.
   */
  private readonly apiRoot: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  /** Updated after every call. Null until the first response arrives. */
  lastRateLimit: RateLimitSnapshot | null = null;

  constructor(options: AgnicHttpOptions) {
    if (!options.token) {
      throw new Error(
        'AGNIC_TOKEN is not set. It is server-side only — never expose it to client code.',
      );
    }
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    // Strip the namespace by name, not by counting characters, so a supplied base
    // URL (a staging host, a test double) still resolves to its own root.
    this.apiRoot = this.baseUrl.replace(/\/autofill$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * Issue a call and parse the body defensively.
   *
   * Not every failure is JSON. A proxy timeout or an edge error answers with
   * HTML or plain text, and calling `.json()` on that throws a SyntaxError that
   * looks nothing like the API problem it actually is. Converting it into a code
   * our own branches can read keeps a 502 from being reported as a product that
   * does not exist.
   */
  private async request<T extends object>(
    path: string,
    init?: { method?: string; body?: unknown; base?: string },
  ): Promise<{ httpStatus: number; data: T & ErrorBody }> {
    const response = await this.fetchImpl(`${init?.base ?? this.baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'X-Agnic-Token': this.token,
        ...(init?.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    this.captureRateLimit(response.headers);

    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: 'non_json_response', detail: text.slice(0, 200) };
    }

    return { httpStatus: response.status, data: data as T & ErrorBody };
  }

  private captureRateLimit(headers: Headers): void {
    const num = (name: string): number | undefined => {
      const raw = headers.get(name);
      if (raw == null) return undefined;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    };

    this.lastRateLimit = {
      limit: num('RateLimit-Limit'),
      remaining: num('RateLimit-Remaining'),
      resetSeconds: num('RateLimit-Reset'),
      observedAt: Date.now(),
    };
  }

  /** True when the provider has told us no quota remains. */
  isQuotaExhausted(): boolean {
    return this.lastRateLimit?.remaining === 0;
  }

  /** The same observation, in the shape the worker's throttle reads. */
  quotaStatus(): { remaining: number | null; resetSeconds: number | null } | null {
    if (!this.lastRateLimit) return null;
    return {
      remaining: this.lastRateLimit.remaining ?? null,
      resetSeconds: this.lastRateLimit.resetSeconds ?? null,
    };
  }

  private errorCode(data: ErrorBody): string {
    return data.error ?? data.error_description ?? 'unknown_error';
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  async searchProducts(input: SearchProductsInput): Promise<SearchOutcome> {
    const params = new URLSearchParams({
      q: input.query,
      country: input.country,
      limit: String(input.limit ?? 20),
    });

    let response: { httpStatus: number; data: ProductSearchResponse & ErrorBody };
    try {
      response = await this.request<ProductSearchResponse>(
        `/products/search?${params}`,
      );
    } catch (cause) {
      return { state: 'transport_error', code: 'request_failed', detail: String(cause) };
    }

    const { httpStatus, data } = response;

    if (httpStatus === 400 && data.error === 'unsupported_country') {
      // An answer about our market coverage, not a transient failure.
      return { state: 'unsupported_country', detail: data.detail ?? data.error_description ?? '' };
    }
    if (httpStatus === 400) {
      return { state: 'unsupported_country', detail: data.detail ?? this.errorCode(data) };
    }
    if (httpStatus === 502) {
      return {
        state: 'catalog_unavailable',
        detail: data.detail ?? 'The catalogue did not answer. Do not report this as "not found".',
      };
    }
    if (httpStatus !== 200) {
      return { state: 'transport_error', code: this.errorCode(data) };
    }

    return {
      state: 'ok',
      products: data.products ?? [],
      currency: data.currency ?? null,
      shopsSearched: data.shops_searched ?? null,
      chunks: data.chunks ?? null,
    };
  }

  async lookupProduct(input: { url: string }): Promise<LookupOutcome> {
    const params = new URLSearchParams({ url: input.url });
    let response: { httpStatus: number; data: ProductLookupResponse & ErrorBody };
    try {
      response = await this.request<ProductLookupResponse>(`/products/lookup?${params}`);
    } catch (cause) {
      return { state: 'transport_error', code: 'request_failed', detail: String(cause) };
    }

    const { httpStatus, data } = response;

    if (httpStatus === 404) {
      return {
        state: 'variant_not_found',
        detail: 'That page resolved to no buyable option. Ask for a link with ?variant=.',
      };
    }
    if (httpStatus === 400) {
      return {
        state: 'not_a_product_url',
        detail: data.detail ?? 'That link is a shop or a collection, not an item.',
      };
    }
    if (httpStatus !== 200) {
      return { state: 'transport_error', code: this.errorCode(data) };
    }

    return {
      state: 'ok',
      sku: data.sku,
      merchantId: data.merchant?.merchant_id ?? null,
      merchantName: data.merchant?.name ?? null,
      onboardUrl: data.onboard?.merchant_url ?? null,
      variantNote: data.variant_note ?? null,
      title: data.title ?? null,
      variantTitle: data.variant_title ?? null,
      priceMinor: data.price_minor ?? null,
      currency: data.currency ?? null,
      available: data.available ?? null,
    };
  }

  async listMerchants(input?: { query?: string }): Promise<Merchant[]> {
    const suffix = input?.query ? `?${new URLSearchParams({ q: input.query })}` : '';
    const { httpStatus, data } = await this.request<{ merchants: Merchant[] }>(
      `/merchants${suffix}`,
    );
    if (httpStatus !== 200) return [];
    return data.merchants ?? [];
  }

  async getMerchant(merchantId: string): Promise<Merchant | null> {
    const { httpStatus, data } = await this.request<Merchant>(
      `/merchants/${encodeURIComponent(merchantId)}`,
    );
    if (httpStatus !== 200) return null;
    return data;
  }

  async exploreMerchant(input: {
    merchantUrl: string;
    goal: string;
    prefs?: string;
    currency?: string;
  }): Promise<ExploreOutcome> {
    let response: {
      httpStatus: number;
      data: { order_id?: string; merchant_id?: string; status?: string } & ErrorBody;
    };
    try {
      response = await this.request('/explore', {
        method: 'POST',
        body: {
          merchant_url: input.merchantUrl,
          goal: input.goal,
          ...(input.prefs === undefined ? {} : { prefs: input.prefs }),
          ...(input.currency === undefined ? {} : { currency: input.currency }),
        },
      });
    } catch (cause) {
      return { state: 'transport_error', code: 'request_failed', detail: String(cause) };
    }

    const { httpStatus, data } = response;

    if (httpStatus !== 200 || !data.order_id) {
      return { state: 'refused', httpStatus, code: this.errorCode(data) };
    }

    // Even a Shopify shop can answer `exploring`. Do not assume it is ready.
    return { state: 'poll', orderId: data.order_id, merchantId: data.merchant_id ?? null };
  }

  // -------------------------------------------------------------------------
  // Quoting
  // -------------------------------------------------------------------------

  async quoteGift(request: QuoteRequest): Promise<QuoteOutcome> {
    // Snapshot first: the caller's object is never mutated, and this snapshot is
    // the private record of what was priced. The response redacts `ship_to`, so
    // without this copy there would be no complete record of the destination.
    const snapshot: QuoteRequest = structuredClone(request);

    if (!snapshot.ship_to) {
      throw new Error('ship_to is required. Load the creator address on the server.');
    }

    // A quote refusal can carry actionable detail, so the error fields are part
    // of the response type rather than being bolted on afterwards.
    let response: { httpStatus: number; data: QuoteResponse & QuoteErrorBody & ErrorBody };
    try {
      response = await this.request<QuoteResponse & QuoteErrorBody>('/shopify/quote', {
        method: 'POST',
        body: snapshot,
      });
    } catch (cause) {
      return { state: 'transport_error', code: 'request_failed', detail: String(cause) };
    }

    const { httpStatus, data } = response;

    // 422 carries something actionable for a bad SKU, so it is handled before
    // the generic refusal. The suggestions are real products with usable SKUs.
    if (httpStatus === 422 && (data.code === 'unknown_sku' || data.unknown_skus)) {
      return {
        state: 'unknown_sku',
        unknownSkus: data.unknown_skus ?? [],
        suggestions: (data.suggestions ?? []).map((s) => ({
          sku: s.sku,
          name: s.name ?? null,
          priceMinor: s.price_minor ?? null,
          currency: s.currency ?? null,
          available: s.available ?? null,
        })),
        detail:
          data.detail ??
          'No product matched at this merchant. The suggestions are the closest matches, not its full range.',
      };
    }

    if (httpStatus !== 200) {
      return { state: 'refused', httpStatus, code: this.errorCode(data), detail: data.detail ?? undefined };
    }

    // An OBJECT, not a boolean — test for presence.
    if (data.unfulfillable) {
      return { state: 'unfulfillable', detail: data.unfulfillable };
    }

    const deliveryOptions = deliverableOptions(data.fulfillment_options);

    // No honest amount to bind until a choice is made.
    if (
      data.requires_fulfillment_choice ||
      !Number.isInteger(data.expected_amount_minor)
    ) {
      return { state: 'choose_delivery', deliveryOptions };
    }

    const selected =
      deliveryOptions.find((o) => o.id === snapshot.fulfillment_option_id) ??
      deliveryOptions.find((o) => o.id === data.selected_option_id);

    if (!selected || (data.expected_amount_minor ?? 0) < 1) {
      return { state: 'choose_delivery', deliveryOptions };
    }

    snapshot.fulfillment_option_id = selected.id;

    return { state: 'ready', request: snapshot, quote: data, deliveryOptions };
  }

  // -------------------------------------------------------------------------
  // Dispatch — the call that spends money
  // -------------------------------------------------------------------------

  async dispatch(input: DispatchInput): Promise<DispatchOutcome> {
    let response: { httpStatus: number; data: DispatchResponse & ErrorBody };
    try {
      response = await this.request<DispatchResponse>('/dispatch', {
        method: 'POST',
        body: input.request,
      });
    } catch {
      // A lost response is NOT proof of a failed purchase. Do not auto-retry.
      return { state: 'reconcile', code: 'response_unknown' };
    }

    const { httpStatus, data } = response;

    if (httpStatus === 202 && data.approval_required) {
      return {
        state: 'approval_required',
        token: data.approval_token ?? '',
        approvalUrl: data.approval_url ?? '',
        expiresInSeconds: data.expires_in ?? 300,
        reason: data.reason ?? 'unknown',
        ...(data.order_id ? { orderId: data.order_id } : {}),
      };
    }

    // An error can still carry an order id — read it BEFORE deciding what to do.
    // An order id makes the outcome knowable, which beats any status code.
    if (data.order_id) {
      return {
        state: 'poll',
        orderId: data.order_id,
        httpStatus,
        ...(data.error ? { code: data.error } : {}),
      };
    }

    if (httpStatus === 409) {
      return {
        state: 'refused',
        httpStatus,
        code: this.errorCode(data),
        detail: data.detail ?? data.error_description,
      };
    }

    return { state: 'reconcile', code: this.errorCode(data), httpStatus };
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  async getOrder(orderId: string): Promise<OrderResponse> {
    const { httpStatus, data } = await this.request<OrderResponse>(
      `/orders/${encodeURIComponent(orderId)}`,
    );
    if (httpStatus !== 200) {
      throw new Error(`Order read failed: HTTP ${httpStatus}; ${this.errorCode(data)}`);
    }
    return data;
  }

  async getApproval(token: string): Promise<ApprovalOutcome> {
    let response: { httpStatus: number; data: ApprovalResponse & ErrorBody };
    try {
      response = await this.request<ApprovalResponse>(
        `/approvals/${encodeURIComponent(token)}`,
        { base: this.apiRoot },
      );
    } catch (cause) {
      return { state: 'transport_error', code: 'request_failed', detail: String(cause) };
    }

    const { httpStatus, data } = response;
    if (httpStatus !== 200) {
      return { state: 'transport_error', code: this.errorCode(data) };
    }

    if (data.status === 'approved') return { state: 'approved' };
    if (data.status === 'expired' || data.status === 'consumed') {
      return { state: 'expired', status: data.status };
    }
    return { state: 'pending' };
  }

  /**
   * Cards on file.
   *
   * Mapped defensively because the payload's exact field names are not
   * documented: only `last4` and `brand` are ever surfaced anywhere, so an
   * unrecognised shape degrades to "a card exists" rather than throwing during
   * a setup check.
   */
  async listCards(): Promise<VaultedCard[]> {
    const { httpStatus, data } = await this.request<{
      cards?: Array<Record<string, unknown>>;
    }>('/cards');

    if (httpStatus !== 200) return [];

    return (data.cards ?? []).map((raw, index) => ({
      id: String(raw.id ?? raw.card_id ?? raw.alias ?? `card_${index}`),
      brand: typeof raw.brand === 'string' ? raw.brand : null,
      // The provider calls it `last_four`; `last4` is accepted too so a rename
      // does not silently blank the display.
      lastFour:
        typeof raw.last_four === 'string'
          ? raw.last_four
          : typeof raw.last4 === 'string'
            ? raw.last4
            : null,
      expiryMonth: typeof raw.exp_month === 'number' ? raw.exp_month : null,
      expiryYear: typeof raw.exp_year === 'number' ? raw.exp_year : null,
      isDefault: raw.is_default === true || raw.default === true || index === 0,
    }));
  }
}
