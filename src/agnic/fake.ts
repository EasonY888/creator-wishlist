import type {
  AgnicPort,
  ApprovalOutcome,
  DispatchInput,
  DispatchOutcome,
  ExploreOutcome,
  LookupOutcome,
  QuoteOutcome,
  SearchOutcome,
  SearchProductsInput,
  VaultedCard,
} from './port';
import type {
  FulfillmentOption,
  Merchant,
  OrderResponse,
  QuoteRequest,
  QuoteResponse,
} from './types';

/**
 * A scriptable stand-in for the provider.
 *
 * This exists because most of what decides whether this product is correct is a
 * failure we cannot summon on demand: a lost dispatch response, a security-code
 * expiry, a spending-cap refusal, a refusal that still names an order. The guide
 * is blunt that "the failure paths are where an agent product is actually
 * judged", and this is the only way to exercise them deterministically.
 *
 * It also records every call, which is what lets a test assert the thing that
 * matters most: that dispatch was issued EXACTLY ONCE for an approved order.
 */

type Scripted<T> = T | T[];

export interface FakeScript {
  search?: Scripted<SearchOutcome>;
  lookup?: Scripted<LookupOutcome>;
  merchants?: Merchant[];
  merchant?: Merchant | null;
  explore?: Scripted<ExploreOutcome>;
  quote?: Scripted<QuoteOutcome>;
  dispatch?: Scripted<DispatchOutcome>;
  /**
   * Keyed by order id. The last entry repeats, so `[pending, succeeded]` reports
   * pending once and then succeeded forever.
   */
  orders?: Record<string, Scripted<Partial<OrderResponse>>>;
  approvals?: Record<string, Scripted<ApprovalOutcome>>;
  /**
   * Scripted quota, so the worker's throttle can be tested. Absent means the
   * rail does not report quota, which is also a legitimate state.
   */
  quota?: { remaining: number | null; resetSeconds: number | null };
}

export interface RecordedCall {
  method: keyof AgnicPort;
  args: unknown;
}

/**
 * Statuses where the merchant's own checkout has finished, so it knows what it
 * charged. Mirrors `isPurchaseSuccess` without importing it, so a change to one
 * cannot silently alter the other's meaning.
 */
const SETTLED_STATUSES = new Set(['succeeded', 'delivered']);

/**
 * The last element of a queue repeats, so a one-element array means "always this"
 * and `[a, b]` means "a once, then b forever".
 */
function next<T>(queue: T[]): T | undefined {
  if (queue.length === 0) return undefined;
  if (queue.length === 1) return queue[0];
  return queue.shift();
}

function toQueue<T>(value: Scripted<T> | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value];
}

/**
 * Order ids must be unique per call, exactly as a real provider's are.
 *
 * `MerchantOrder.providerOrderId` is uniquely constrained, so reusing an id
 * across two fan orders is correctly rejected by the database — a fixture that
 * hard-codes one id per scenario would collide the moment two orders exist.
 */
let orderSequence = 0;
function newOrderId(prefix: string): string {
  orderSequence += 1;
  return `${prefix}_${Date.now().toString(36)}_${orderSequence}`;
}

const DEFAULT_OPTION: FulfillmentOption = {
  id: 'ship-standard',
  type: 'shipping',
  title: 'Standard shipping',
  price_minor: 0,
};

export class FakeAgnic implements AgnicPort {
  readonly calls: RecordedCall[] = [];

  /** The exact body sent on the last dispatch — used to assert body binding. */
  lastDispatchRequest: DispatchInput['request'] | null = null;

  private readonly quoteQueue: QuoteOutcome[];
  private readonly dispatchQueue: DispatchOutcome[];
  private readonly searchQueue: SearchOutcome[];
  private readonly lookupQueue: LookupOutcome[];
  private readonly exploreQueue: ExploreOutcome[];
  private readonly orderQueues = new Map<string, Partial<OrderResponse>[]>();
  private readonly approvalQueues = new Map<string, ApprovalOutcome[]>();
  private readonly merchants: Merchant[];
  private readonly singleMerchant: Merchant | null;
  private readonly quota: { remaining: number | null; resetSeconds: number | null } | null;

  constructor(script: FakeScript = {}) {
    this.quoteQueue = toQueue(script.quote);
    this.dispatchQueue = toQueue(script.dispatch);
    this.searchQueue = toQueue(script.search);
    this.lookupQueue = toQueue(script.lookup);
    this.exploreQueue = toQueue(script.explore);
    this.merchants = script.merchants ?? [];
    this.singleMerchant = script.merchant ?? null;
    this.quota = script.quota ?? null;

    for (const [id, value] of Object.entries(script.orders ?? {})) {
      this.orderQueues.set(id, toQueue(value));
    }
    for (const [token, value] of Object.entries(script.approvals ?? {})) {
      this.approvalQueues.set(token, toQueue(value));
    }
  }

  // -------------------------------------------------------------------------
  // Observations
  // -------------------------------------------------------------------------

  callsTo(method: keyof AgnicPort): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  countCalls(method: keyof AgnicPort): number {
    return this.callsTo(method).length;
  }

  private record(method: keyof AgnicPort, args: unknown): void {
    this.calls.push({ method, args });
  }

  // -------------------------------------------------------------------------
  // Port
  // -------------------------------------------------------------------------

  async searchProducts(input: SearchProductsInput): Promise<SearchOutcome> {
    this.record('searchProducts', input);
    return (
      next(this.searchQueue) ?? {
        state: 'ok',
        products: [],
        currency: null,
        shopsSearched: 0,
        chunks: 1,
      }
    );
  }

  async lookupProduct(input: { url: string }): Promise<LookupOutcome> {
    this.record('lookupProduct', input);
    return next(this.lookupQueue) ?? { state: 'variant_not_found', detail: 'not scripted' };
  }

  /**
   * Scripted quota. Absent is a legitimate state and means the same thing as a
   * rail that is not metered at all.
   */
  quotaStatus(): { remaining: number | null; resetSeconds: number | null } | null {
    return this.quota;
  }

  async listMerchants(input?: { query?: string }): Promise<Merchant[]> {
    this.record('listMerchants', input ?? {});
    return this.merchants;
  }

  async getMerchant(merchantId: string): Promise<Merchant | null> {
    this.record('getMerchant', merchantId);
    return this.singleMerchant ?? this.merchants.find((m) => m.id === merchantId) ?? null;
  }

  async exploreMerchant(input: {
    merchantUrl: string;
    goal: string;
    prefs?: string;
    currency?: string;
  }): Promise<ExploreOutcome> {
    this.record('exploreMerchant', input);
    return next(this.exploreQueue) ?? { state: 'refused', httpStatus: 500, code: 'not_scripted' };
  }

  async quoteGift(request: QuoteRequest): Promise<QuoteOutcome> {
    this.record('quoteGift', request);

    const scripted = next(this.quoteQueue);
    if (scripted) return scripted;

    // Default: a clean, final quote with one delivery option.
    const snapshot = structuredClone(request);
    snapshot.fulfillment_option_id ??= DEFAULT_OPTION.id;

    const quote: QuoteResponse = {
      rail: 'shopify',
      fulfillment_options: [DEFAULT_OPTION],
      selected_option_id: DEFAULT_OPTION.id,
      expected_amount_minor: 1000,
      amount_is_final: true,
      charge_cap_minor: 1000,
      currency: 'CAD',
      ship_to_sha256: 'fake-digest',
      billing_uses_ship_to: false,
    };

    return { state: 'ready', request: snapshot, quote, deliveryOptions: [DEFAULT_OPTION] };
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutcome> {
    this.record('dispatch', input);
    this.lastDispatchRequest = structuredClone(input.request);

    const scripted = next(this.dispatchQueue);
    if (scripted) return scripted;

    // Default: accepted, order exists, poll it.
    const orderId = newOrderId('ord');
    this.orderQueues.set(orderId, [{ status: 'succeeded' }]);
    return { state: 'poll', orderId };
  }

  async getOrder(orderId: string): Promise<OrderResponse> {
    this.record('getOrder', orderId);

    const queue = this.orderQueues.get(orderId);
    const patch = queue ? next(queue) : undefined;

    const order: OrderResponse = {
      id: orderId,
      status: 'dispatched',
      amount_minor: 1000,
      amount_charged_minor: null,
      currency: 'CAD',
      retryable: null,
      retry_action: 'poll',
      evidence: null,
      ...patch,
    };

    // A settled order reports what the merchant actually charged, and this fake
    // has to do the same or the capture logic meets an unknown figure where
    // production would meet a real one.
    //
    // A fixture that sets the field explicitly -- including to `null` -- always
    // wins, so the blocked path stays reachable on purpose rather than by
    // accident.
    const scripted = patch !== undefined && 'amount_charged_minor' in patch;

    if (!scripted && order.amount_charged_minor == null && SETTLED_STATUSES.has(order.status)) {
      order.amount_charged_minor = order.amount_minor ?? null;
    }

    return order;
  }

  async getApproval(token: string): Promise<ApprovalOutcome> {
    this.record('getApproval', token);
    const queue = this.approvalQueues.get(token);
    return (queue ? next(queue) : undefined) ?? { state: 'pending' };
  }

  /** Scriptable, because "is the card on file yet?" is the setup gate. */
  cards: VaultedCard[] = [];

  async listCards(): Promise<VaultedCard[]> {
    this.record('listCards', {});
    return this.cards;
  }
}

// ---------------------------------------------------------------------------
// Named scenarios
// ---------------------------------------------------------------------------

/**
 * The interruptions and refusals this product has to survive, as executable
 * fixtures.
 *
 * Drawn from the provider's own "deliberately breaking things" guidance plus the
 * routine interruptions it warns will happen in production — none of which are
 * failures, and all of which are otherwise very hard to reproduce on demand.
 */
export const chaos = {
  /** The happy path, for contrast. Charged below the ceiling. */
  success(orderId = newOrderId('ord_success')): FakeAgnic {
    return new FakeAgnic({
      dispatch: { state: 'poll', orderId },
      orders: {
        [orderId]: [
          { status: 'dispatched', retryable: null, retry_action: 'poll' },
          {
            status: 'succeeded',
            retryable: false,
            retry_action: 'none',
            amount_charged_minor: 950,
            amount_minor: 1000,
            evidence: { charge_state: 'captured' },
          },
        ],
      },
    });
  },

  /**
   * Vault holds a security code ~50 minutes, then refuses until it is re-entered.
   * Recurs roughly hourly and is routine, not a failure.
   */
  cvvRefreshRequired(orderId = newOrderId('ord_cvv')): FakeAgnic {
    return new FakeAgnic({
      dispatch: {
        state: 'approval_required',
        token: 'tok_cvv_1',
        approvalUrl: 'https://example.invalid/approve/cvv',
        expiresInSeconds: 300,
        reason: 'cvv_refresh_required',
      },
      approvals: { tok_cvv_1: [{ state: 'pending' }, { state: 'approved' }] },
      orders: { [orderId]: [{ status: 'succeeded' }] },
    });
  },

  /**
   * Mandate currency does not match the store's.
   *
   * Permanent, not transient: every dispatch returns this forever until the
   * mandate is reissued in the store's currency. The sandbox is a CAD shop, so a
   * GBP mandate lands here.
   */
  currencyMismatch(): FakeAgnic {
    return new FakeAgnic({
      dispatch: {
        state: 'approval_required',
        token: 'tok_fx',
        approvalUrl: 'https://example.invalid/approve/fx',
        expiresInSeconds: 300,
        reason: 'currency_mismatch',
      },
    });
  },

  /** Spending cap breached. Refused before the card; no order exists. */
  capExceeded(): FakeAgnic {
    return new FakeAgnic({
      quote: { state: 'refused', httpStatus: 409, code: 'constraint_violated' },
    });
  },

  /**
   * Price moved between approval and dispatch.
   *
   * The refusal still carries an order id, which makes the outcome knowable —
   * poll it rather than retrying. Needs a fresh quote and renewed approval.
   */
  priceChanged(orderId = newOrderId('ord_price')): FakeAgnic {
    return new FakeAgnic({
      dispatch: { state: 'poll', orderId, httpStatus: 409, code: 'shopify_amount_changed' },
      orders: {
        [orderId]: [
          {
            status: 'price_changed',
            retryable: false,
            retry_action: 're_preview',
            evidence: { charge_state: 'none' },
          },
        ],
      },
    });
  },

  /** Out of stock. Terminal failure, never charged, safe to release the hold. */
  outOfStock(orderId = newOrderId('ord_oos')): FakeAgnic {
    return new FakeAgnic({
      dispatch: { state: 'poll', orderId },
      orders: {
        [orderId]: [
          {
            status: 'out_of_stock',
            retryable: false,
            retry_action: 're_preview',
            evidence: { charge_state: 'none' },
          },
        ],
      },
    });
  },

  /**
   * Dispatch response lost. NOT a failure — the purchase may well have
   * completed — and exactly the case where a naive retry double-charges.
   */
  lostResponse(): FakeAgnic {
    return new FakeAgnic({
      dispatch: { state: 'reconcile', code: 'response_unknown' },
    });
  },

  /** A person has to act at the shop mid-checkout. Keep polling, never re-place. */
  handoffRequired(orderId = newOrderId('ord_handoff')): FakeAgnic {
    return new FakeAgnic({
      dispatch: { state: 'poll', orderId },
      orders: {
        [orderId]: [
          { status: 'dispatched', retryable: null, retry_action: 'handoff' },
        ],
      },
    });
  },

  /**
   * Genuinely unknown outcome: money may have moved and nobody can say.
   * The state where a UI most easily lies by rendering an ordinary failure.
   */
  unknownMoneyState(orderId = newOrderId('ord_unknown')): FakeAgnic {
    return new FakeAgnic({
      dispatch: { state: 'poll', orderId },
      orders: {
        [orderId]: [
          {
            status: 'pending',
            retryable: null,
            retry_action: 'contact_support',
            evidence: { charge_state: 'unknown' },
          },
        ],
      },
    });
  },

  /** Healthy in-flight order: `retryable` is null AND that means nothing bad. */
  inFlight(orderId = newOrderId('ord_flight')): FakeAgnic {
    return new FakeAgnic({
      dispatch: { state: 'poll', orderId },
      orders: {
        [orderId]: [{ status: 'dispatched', retryable: null, retry_action: 'poll' }],
      },
    });
  },

  /** Delivery choice outstanding, so the provider withholds the amount entirely. */
  deliveryChoiceRequired(): FakeAgnic {
    return new FakeAgnic({
      quote: [
        {
          state: 'choose_delivery',
          deliveryOptions: [
            { id: 'ship-standard', type: 'shipping', title: 'Standard', price_minor: 0 },
            { id: 'ship-express', type: 'shipping', title: 'Express', price_minor: 1500 },
          ],
        },
        // Second call, after a choice was made.
        {
          state: 'ready',
          request: {
            merchant_id: 'm1',
            items: [{ sku: 'sku-1', quantity: 1 }],
            ship_to: {
              name: 'A',
              street_address: '1',
              address_locality: 'L',
              postal_code: 'P',
              address_country: 'CA',
              address_region: 'ON',
            },
            fulfillment_option_id: 'ship-express',
          },
          quote: {
            expected_amount_minor: 2500,
            amount_is_final: true,
            currency: 'CAD',
            fulfillment_options: [],
          },
          deliveryOptions: [],
        },
      ],
    });
  },

  /** The merchant cannot fulfil this buyer at all. */
  unfulfillable(): FakeAgnic {
    return new FakeAgnic({
      quote: { state: 'unfulfillable', detail: { reason: 'no_delivery_options' } },
    });
  },

  /** Ceiling, not a total: the merchant adds tax at checkout. */
  provisionalCeiling(): FakeAgnic {
    return new FakeAgnic({
      quote: {
        state: 'ready',
        request: {
          merchant_id: 'm1',
          items: [{ sku: 'sku-1', quantity: 1 }],
          ship_to: {
            name: 'A',
            street_address: '1',
            address_locality: 'L',
            postal_code: 'P',
            address_country: 'CA',
            address_region: 'ON',
          },
        },
        quote: {
          expected_amount_minor: 1000,
          amount_is_final: false,
          charge_cap_minor: 1000,
          currency: 'CAD',
          fulfillment_options: [DEFAULT_OPTION],
        },
        deliveryOptions: [DEFAULT_OPTION],
      },
    });
  },
} as const;
