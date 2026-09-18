import type { AgnicPort, SkuSuggestion } from '../agnic/port';
import type {
  Constraints,
  FulfillmentOption,
  QuoteRequest,
  QuoteResponse,
} from '../agnic/types';
import type { Db } from '../db/types';
import { assertTransition } from '../domain/order-fsm';
import { priceForFan, type FanPrice } from '../domain/pricing';
import {
  currentAddressIdFor,
  FULFILLMENT_ACTOR,
  loadShipToForFulfillment,
  type AddressActor,
} from '../fulfillment/address-store';
import {
  computeRequestDigest,
  computeShipToDigest,
  type BoundRequest,
} from '../fulfillment/binding';
import { recordPaymentOnce } from '../payments/ledger';
import { idempotencyKeyFor, type PaymentPort } from '../payments/port';
import { enqueue, OUTBOX_TOPICS } from './outbox';

/**
 * The checkout service: everything that happens before an order exists.
 *
 * Pricing a wishlist item, quoting it against the creator's address, producing a
 * total the fan can agree to, then turning that agreement into an authorized
 * order that the dispatcher will spend against.
 *
 * The shape of the flow is deliberate: **pricing and approval are separate
 * steps, and approval re-checks everything pricing assumed.** Time passes and
 * the world moves between a fan seeing a total and agreeing to it, so the second
 * step cannot trust the first.
 */

/**
 * How long a quote is treated as current.
 *
 * Five minutes, matching the provider's own confirmation-token lifetime. Over
 * HTTP there is no token to expire, which is exactly why we have to impose one
 * ourselves — an unbounded quote is a price the fan agreed to at a moment that
 * may no longer exist.
 */
export const QUOTE_TTL_SECONDS = 300;

export interface CheckoutDeps {
  db: Db;
  agnic: AgnicPort;
  payments: PaymentPort;
  markupPercent: number;
  addressActor?: AddressActor;
}

/**
 * The part of the checkout dependencies that pricing uses.
 *
 * Narrowed on purpose. Pricing must not be able to reach the payment rail, and a
 * type that says otherwise is a type that lies: it forced callers who only
 * wanted a quote to construct a payment provider they would never touch. Every
 * existing `CheckoutDeps` value still satisfies this, so nothing else changes --
 * but an edit that tries to charge during pricing now fails to compile.
 */
export type PriceDeps = Omit<CheckoutDeps, 'payments'>;

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export type PriceOutcome =
  | {
      state: 'ready';
      wishlistItemId: string;
      price: FanPrice;
      quote: QuoteResponse;
      /** The exact request that was priced, to be replayed at approval. */
      request: QuoteRequest;
      deliveryOptions: FulfillmentOption[];
      shipToDigest: string;
    }
  | { state: 'choose_delivery'; deliveryOptions: FulfillmentOption[] }
  /** The merchant cannot fulfil this buyer at all. */
  | { state: 'unfulfillable' }
  /**
   * The SKU matched nothing at this merchant, but the provider returned the
   * closest real products with SKUs that are ready to re-quote. Recoverable —
   * never present this as "that item does not exist".
   */
  | { state: 'unknown_sku'; suggestions: SkuSuggestion[]; detail: string }
  | { state: 'refused'; code: string; httpStatus: number }
  | { state: 'transport_error'; code: string }
  | { state: 'item_not_found' }
  /** No address on file, so nothing can be quoted. */
  | { state: 'missing_address' };

/**
 * Quote a wishlist item against the creator's current address and price it.
 *
 * The address is read through the audited gate, and only here — this is the one
 * place a destination enters the pricing path.
 */
export async function priceWishlistItem(
  deps: PriceDeps,
  input: {
    creatorId: string;
    wishlistItemId: string;
    quantity?: number;
    /** Supply after the fan has chosen, to get a final amount. */
    deliveryOptionId?: string;
  },
): Promise<PriceOutcome> {
  const item = await deps.db.wishlistItem.findUnique({
    where: { id: input.wishlistItemId },
  });

  if (!item) return { state: 'item_not_found' };

  const addressId = await currentAddressIdFor(deps.db, input.creatorId);
  if (!addressId) return { state: 'missing_address' };

  const { shipTo, digest } = await loadShipToForFulfillment(deps.db, {
    creatorAddressId: addressId,
    actor: deps.addressActor ?? FULFILLMENT_ACTOR,
  });

  const request: QuoteRequest = {
    merchant_id: item.merchantId,
    items: [{ sku: item.sku, quantity: input.quantity ?? 1 }],
    ship_to: shipTo,
    ...(input.deliveryOptionId === undefined
      ? {}
      : { fulfillment_option_id: input.deliveryOptionId }),
  };

  const outcome = await deps.agnic.quoteGift(request);

  switch (outcome.state) {
    case 'ready': {
      const price = priceForFan({
        expectedAmountMinor: outcome.quote.expected_amount_minor,
        currency: outcome.quote.currency ?? item.currency,
        amountIsFinal: outcome.quote.amount_is_final ?? false,
        markupPercent: deps.markupPercent,
      });

      return {
        state: 'ready',
        wishlistItemId: item.id,
        price,
        quote: outcome.quote,
        request: outcome.request,
        deliveryOptions: outcome.deliveryOptions,
        shipToDigest: digest,
      };
    }

    case 'choose_delivery':
      return { state: 'choose_delivery', deliveryOptions: outcome.deliveryOptions };

    case 'unfulfillable':
      return { state: 'unfulfillable' };

    case 'unknown_sku':
      return {
        state: 'unknown_sku',
        suggestions: outcome.suggestions,
        detail: outcome.detail,
      };

    case 'refused':
      return { state: 'refused', code: outcome.code, httpStatus: outcome.httpStatus };

    case 'transport_error':
      return { state: 'transport_error', code: outcome.code };
  }
}

// ---------------------------------------------------------------------------
// Draft order
// ---------------------------------------------------------------------------

export interface DraftOrderSummary {
  fanOrderId: string;
  fanTotalMinor: number;
  markupMinor: number;
  merchantCapMinor: number;
  currency: string;
  amountIsFinal: boolean;
  quoteExpiresAt: Date | null;
  deliveryOptionId: string | null;
}

export type CreateDraftOutcome =
  | { state: 'created'; order: DraftOrderSummary }
  | { state: 'choose_delivery'; deliveryOptions: FulfillmentOption[] }
  | { state: 'unfulfillable' }
  | { state: 'unknown_sku'; suggestions: SkuSuggestion[]; detail: string }
  | { state: 'refused'; code: string }
  | { state: 'transport_error'; code: string }
  | { state: 'item_not_found' }
  | { state: 'missing_address' };

/**
 * Price an item and persist a draft order the fan can approve.
 *
 * A draft holds money for nobody: no authorization, no dispatch intent. It is
 * the fan's view of a price, and nothing else. Only approval moves it.
 */
export async function createDraftOrder(
  deps: CheckoutDeps,
  input: {
    fanId: string;
    creatorId: string;
    wishlistItemId: string;
    quantity?: number;
    deliveryOptionId?: string;
  },
): Promise<CreateDraftOutcome> {
  const priced = await priceWishlistItem(deps, input);

  if (priced.state !== 'ready') return priced;

  const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000);
  const deliveryOptionId =
    priced.request.fulfillment_option_id ?? priced.quote.selected_option_id ?? null;

  const fanOrder = await deps.db.$transaction(async (tx) => {
    const quote = await tx.quote.create({
      data: {
        wishlistItemId: priced.wishlistItemId,
        merchantId: priced.request.merchant_id,
        state: priced.price.amountIsFinal ? 'valid_final' : 'valid_provisional',
        amountIsFinal: priced.price.amountIsFinal,
        expectedAmountMinor: priced.price.merchantAmountMinor,
        chargeCapMinor: priced.quote.charge_cap_minor ?? priced.price.merchantAmountMinor,
        currency: priced.price.currency,
        fulfillmentOptions: priced.deliveryOptions as unknown as object[],
        selectedOptionId: deliveryOptionId,
        items: priced.request.items as unknown as object[],
        shipToDigest: priced.shipToDigest,
        expiresAt,
        raw: priced.quote as unknown as object,
      },
      select: { id: true },
    });

    return tx.fanOrder.create({
      data: {
        fanId: input.fanId,
        creatorId: input.creatorId,
        quoteId: quote.id,
        state: 'draft',
        fanTotalMinor: priced.price.fanTotalMinor,
        markupMinor: priced.price.markupMinor,
        merchantCapMinor: priced.price.merchantAmountMinor,
        currency: priced.price.currency,
      },
      select: { id: true },
    });
  });

  return {
    state: 'created',
    order: {
      fanOrderId: fanOrder.id,
      fanTotalMinor: priced.price.fanTotalMinor,
      markupMinor: priced.price.markupMinor,
      merchantCapMinor: priced.price.merchantAmountMinor,
      currency: priced.price.currency,
      amountIsFinal: priced.price.amountIsFinal,
      quoteExpiresAt: expiresAt,
      deliveryOptionId,
    },
  };
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export type ApproveOutcome =
  | { state: 'authorized'; fanOrderId: string }
  | { state: 'not_draft'; currentState: string }
  /** The fan took too long. A fresh quote and a fresh approval are required. */
  | { state: 'quote_expired' }
  /** The creator moved house between pricing and approval. */
  | { state: 'address_changed'; changedFields: string[] }
  | { state: 'invalid_confirmation'; reason: string }
  /**
   * `retryable` distinguishes "the card was declined" from "the fan still has
   * something to do". A step-up is not a dead order, so it must not be reported
   * the same way as a decline.
   */
  | { state: 'payment_failed'; code: string; retryable?: boolean }
  | { state: 'order_not_found' };

/**
 * What the browser needs to collect a card, once the request is frozen.
 *
 * Money is not held at this point and no dispatch is queued. The order sits in
 * `approved` with an unconfirmed intent, which is inert.
 */
export type BeginPaymentOutcome =
  | {
      state: 'ready';
      fanOrderId: string;
      /** The processor's intent, recorded on the order. */
      reference: string;
      /**
       * Handed to the browser so the card is entered against the processor
       * directly, never through us (NFR-2.1). Null when the rail has no
       * browser step.
       */
      clientSecret: string | null;
    }
  | { state: 'not_draft'; currentState: string }
  | { state: 'quote_expired' }
  | { state: 'address_changed'; changedFields: string[] }
  | { state: 'invalid_confirmation'; reason: string }
  | { state: 'payment_failed'; code: string }
  | { state: 'order_not_found' };

const MAX_CONFIRMATION_LENGTH = 500;

/**
 * Load the order together with the quote the approval is priced against.
 *
 * Also the single definition of the shape both approval entry points accept, so
 * the helper below cannot drift from what they actually pass.
 */
async function loadOrderForApproval(deps: CheckoutDeps, fanOrderId: string) {
  return deps.db.fanOrder.findUnique({
    where: { id: fanOrderId },
    include: { quote: true },
  });
}

type OrderForApproval = NonNullable<Awaited<ReturnType<typeof loadOrderForApproval>>>;

type PreparationOutcome =
  | { state: 'ok'; addressId: string; bound: BoundRequest }
  | { state: 'quote_expired' }
  | { state: 'address_changed'; changedFields: string[] }
  | { state: 'invalid_confirmation'; reason: string };

/**
 * Everything that must be true before a hold is attempted, plus the freeze.
 *
 * Shared by both entry points deliberately. The browser flow validates here
 * before the card form is shown, then `approveAndAuthorize` validates again
 * before money is held -- time passes between the two, and a creator can move
 * house in the middle of it.
 *
 * `freeze` is what keeps the ordering guarantee: the request is frozen *before*
 * any hold exists, so we never hold a fan's money against a request we have not
 * committed to. Re-running with `freeze: false` re-checks without rewriting a
 * row the processor may already be holding funds against.
 */
async function validateAndFreeze(
  deps: CheckoutDeps,
  order: OrderForApproval,
  input: { fanConfirmationText?: string; approvedAt: Date; freeze: boolean },
): Promise<PreparationOutcome> {
  if (!order.quote) {
    return { state: 'invalid_confirmation', reason: 'order has no quote' };
  }

  if (order.quote.expiresAt && order.quote.expiresAt.getTime() < Date.now()) {
    return { state: 'quote_expired' };
  }

  // Only validated when freezing. A verification pass is not the fan re-typing
  // anything -- the text stored on the frozen request is the record of what they
  // agreed to, so re-checking a value nobody re-entered would be theatre.
  let confirmation = '';
  if (input.freeze) {
    confirmation = (input.fanConfirmationText ?? '').trim();

    if (confirmation.length === 0) {
      return { state: 'invalid_confirmation', reason: 'confirmation text is empty' };
    }
    if (confirmation.length > MAX_CONFIRMATION_LENGTH) {
      return {
        state: 'invalid_confirmation',
        reason: `confirmation text exceeds ${MAX_CONFIRMATION_LENGTH} characters`,
      };
    }
    if (Number.isNaN(input.approvedAt.getTime())) {
      return { state: 'invalid_confirmation', reason: 'approval timestamp is not a date' };
    }
  }

  // Re-read the destination. An address change invalidates the quote, because the
  // shipping and tax the fan agreed to were priced for the old one.
  const addressId = await currentAddressIdFor(deps.db, order.creatorId);
  if (!addressId) return { state: 'address_changed', changedFields: [] };

  const { shipTo, digest } = await loadShipToForFulfillment(deps.db, {
    creatorAddressId: addressId,
    actor: deps.addressActor ?? FULFILLMENT_ACTOR,
  });

  if (digest !== order.quote.shipToDigest) {
    return { state: 'address_changed', changedFields: ['destination'] };
  }

  const items = (order.quote.items ?? []) as BoundRequest['items'];
  if (items.length === 0) {
    return { state: 'invalid_confirmation', reason: 'quote recorded no items' };
  }

  const amountMinor = order.quote.expectedAmountMinor ?? order.merchantCapMinor;

  const bound: BoundRequest = {
    merchant_id: order.quote.merchantId,
    items,
    ship_to: shipTo,
    currency: order.quote.currency,
    amount_minor: amountMinor,
    // Cap the purchase at the figure the fan approved, so a price rise between
    // approval and dispatch is refused rather than charged. Deliberately no
    // shipping cap: on a rail that cannot price shipping before checkout, one
    // returns `constraint_unverifiable` and blocks the order outright.
    constraints: { max_total_minor: amountMinor } satisfies Constraints,
    ...(order.quote.selectedOptionId === null
      ? {}
      : { fulfillment_option_id: order.quote.selectedOptionId }),
  };

  if (!input.freeze) return { state: 'ok', addressId, bound };

  // Freeze the request and mark it approved, together.
  await deps.db.$transaction(async (tx) => {
    assertTransition('draft', 'approved');

    await tx.approvedRequest.create({
      data: {
        fanOrderId: order.id,
        creatorAddressId: addressId,
        merchantId: bound.merchant_id,
        items: bound.items as unknown as object[],
        currency: bound.currency,
        amountMinor: bound.amount_minor,
        constraints: bound.constraints as unknown as object,
        fulfillmentOptionId: bound.fulfillment_option_id ?? null,
        shipToDigest: computeShipToDigest(shipTo),
        requestDigest: computeRequestDigest(bound),
        fanApprovalText: confirmation,
        fanApprovedAtIso: input.approvedAt,
      },
    });

    await tx.fanOrder.update({
      where: { id: order.id },
      data: { state: 'approved', approvedAt: input.approvedAt },
    });

    await tx.orderEvent.create({
      data: {
        fanOrderId: order.id,
        fromState: 'draft',
        toState: 'approved',
        note: `fan approved ${order.fanTotalMinor} ${order.currency}`,
        actor: 'checkout',
      },
    });
  });

  return { state: 'ok', addressId, bound };
}

/** Mark an order dead for a payment reason, proving nothing was ever charged. */
async function failApprovedOrder(
  deps: CheckoutDeps,
  fanOrderId: string,
  code: string,
): Promise<void> {
  await deps.db.$transaction(async (tx) => {
    assertTransition('approved', 'failed', { hasNoChargeEvidence: true });
    await tx.fanOrder.update({ where: { id: fanOrderId }, data: { state: 'failed' } });
    await tx.orderEvent.create({
      data: {
        fanOrderId,
        fromState: 'approved',
        toState: 'failed',
        note: `payment authorization declined: ${code}`,
        actor: 'checkout',
      },
    });
  });
}

/**
 * Record the fan's approval, hold their money, and queue the purchase.
 *
 * Re-checks everything pricing assumed, because time has passed:
 *
 *   1. the order has not already moved past approval
 *   2. the quote has not expired
 *   3. the destination is still the one that was priced
 *   4. the confirmation is real, and in the fan's own words
 *
 * Only then is the payment held and the dispatch queued together, so the intent
 * is durable before anything touches the provider.
 *
 * Two legitimate entry points:
 *
 *   - **From `draft`.** Everything above runs, the request is frozen, and the
 *     hold is placed in the same call. This is the rail-with-no-browser-step
 *     path, and it needs `paymentMethodRef`.
 *   - **From `approved`.** `beginPayment` already froze the request and the
 *     browser already confirmed. This verifies the hold exists rather than
 *     creating one, and the destination is re-checked because the fan could
 *     have taken minutes over the card form.
 */
export async function approveAndAuthorize(
  deps: CheckoutDeps,
  input: {
    fanOrderId: string;
    /**
     * The fan's literal affirmative words. Dispute evidence.
     *
     * Required when this call freezes the request, ignored when it verifies an
     * already-frozen one.
     */
    fanConfirmationText?: string;
    approvedAt: Date;
    /**
     * Only for rails that place the hold directly. Omit it when the browser
     * already confirmed a prepared intent.
     */
    paymentMethodRef?: string;
  },
): Promise<ApproveOutcome> {
  const order = await loadOrderForApproval(deps, input.fanOrderId);

  if (!order) return { state: 'order_not_found' };
  if (order.state !== 'draft' && order.state !== 'approved') {
    return { state: 'not_draft', currentState: order.state };
  }

  const prep = await validateAndFreeze(deps, order, {
    fanConfirmationText: input.fanConfirmationText,
    approvedAt: input.approvedAt,
    // Never re-freeze: a browser may already be holding funds against the
    // frozen row, and rewriting it would move the request out from under them.
    freeze: order.state === 'draft',
  });

  if (prep.state !== 'ok') return prep;

  // Hold the money. Outside the transaction: an external call inside one holds a
  // connection for a network round trip and cannot be rolled back anyway.
  const authorization = await deps.payments.authorize({
    fanOrderId: order.id,
    idempotencyKey: idempotencyKeyFor('authorize', order.id),
    amountMinor: order.fanTotalMinor,
    currency: order.currency,
    ...(input.paymentMethodRef === undefined
      ? {}
      : { paymentMethodRef: input.paymentMethodRef }),
  });

  if (authorization.state === 'failed') {
    // A step-up or an in-flight async method is not a dead order. Leaving it
    // approved lets the fan finish or retry, rather than failing something that
    // may still succeed (R-8).
    if (authorization.retryable === true) {
      return { state: 'payment_failed', code: authorization.code, retryable: true };
    }

    await failApprovedOrder(deps, order.id, authorization.code);

    return { state: 'payment_failed', code: authorization.code };
  }

  // Authorized: ledger it, mark it, and queue the dispatch in one transaction so
  // the intent is durable before anything touches the provider.
  await deps.db.$transaction(async (tx) => {
    await recordPaymentOnce(tx, {
      fanOrderId: order.id,
      type: 'authorized',
      amountMinor: authorization.amountMinor,
      currency: order.currency,
      providerRef: authorization.reference,
    });

    assertTransition('approved', 'authorized');

    await tx.fanOrder.update({
      where: { id: order.id },
      data: { state: 'authorized' },
    });

    await tx.orderEvent.create({
      data: {
        fanOrderId: order.id,
        fromState: 'approved',
        toState: 'authorized',
        note: `payment held (${authorization.state})`,
        actor: 'checkout',
      },
    });

    await enqueue(tx, OUTBOX_TOPICS.DISPATCH_MERCHANT_ORDER, {
      fanOrderId: order.id,
    });
  });

  return { state: 'authorized', fanOrderId: order.id };
}

/**
 * Freeze the fan's agreement and prepare the instrument they will pay with.
 *
 * This is the first half of a two-step approval, split out because the fan has to
 * enter a card *before* anything can be held, and the card must reach the
 * processor without passing through our server (NFR-2.1). The order therefore
 * spends time in `approved` with an unconfirmed intent, which holds nothing and
 * queues nothing.
 *
 * The ordering here is the point: **the request is frozen before the intent
 * exists.** A hold must never exist against a request we have not committed to,
 * because then there would be money in flight and nothing fixed to spend it on.
 *
 * On failure the order is deliberately left `approved` rather than failed. No
 * money was touched, and the usual cause is a correctable one -- a mistyped card,
 * a missing key -- so failing it would report a dead order for what is often a
 * typo the fan can fix by trying again.
 */
export async function beginPayment(
  deps: CheckoutDeps,
  input: {
    fanOrderId: string;
    /** The fan's literal affirmative words. Dispute evidence. */
    fanConfirmationText: string;
    approvedAt: Date;
    description?: string;
  },
): Promise<BeginPaymentOutcome> {
  const order = await loadOrderForApproval(deps, input.fanOrderId);

  if (!order) return { state: 'order_not_found' };
  if (order.state !== 'draft' && order.state !== 'approved') {
    return { state: 'not_draft', currentState: order.state };
  }

  const prep = await validateAndFreeze(deps, order, {
    fanConfirmationText: input.fanConfirmationText,
    approvedAt: input.approvedAt,
    freeze: order.state === 'draft',
  });

  if (prep.state !== 'ok') return prep;

  // Already prepared. Recovering the secret is essential rather than an
  // optimisation: preparing again would create a second intent once Stripe's
  // 24-hour idempotency window has passed, which is a second hold on the same
  // order. The browser may simply have reloaded the card form.
  if (order.paymentIntentRef !== null) {
    return {
      state: 'ready',
      fanOrderId: order.id,
      reference: order.paymentIntentRef,
      clientSecret: await deps.payments.clientSecretFor(order.id),
    };
  }

  const prepared = await deps.payments.prepareAuthorization({
    fanOrderId: order.id,
    idempotencyKey: idempotencyKeyFor('prepare', order.id),
    amountMinor: order.fanTotalMinor,
    currency: order.currency,
    ...(input.description === undefined ? {} : { description: input.description }),
  });

  if (prepared.state === 'failed') {
    return { state: 'payment_failed', code: prepared.code };
  }

  // Recorded so the intent can be found again -- both to verify the hold later
  // and to cancel it if the fan never comes back.
  await deps.db.fanOrder.update({
    where: { id: order.id },
    data: { paymentIntentRef: prepared.reference },
  });

  return {
    state: 'ready',
    fanOrderId: order.id,
    reference: prepared.reference,
    clientSecret: prepared.clientSecret,
  };
}

/**
 * Re-price an order whose quote died, without losing the fan's cart.
 *
 * Used when a quote expired or the destination changed. Deliberately returns to
 * `draft`: the previous approval is void, and a new one is required, because the
 * total may be different.
 */
export async function requoteOrder(
  deps: CheckoutDeps,
  input: { fanOrderId: string; deliveryOptionId?: string },
): Promise<CreateDraftOutcome> {
  const order = await deps.db.fanOrder.findUnique({
    where: { id: input.fanOrderId },
    include: { quote: { include: { wishlistItem: true } } },
  });

  if (!order?.quote) return { state: 'item_not_found' };

  const priced = await priceWishlistItem(deps, {
    creatorId: order.creatorId,
    wishlistItemId: order.quote.wishlistItemId,
    quantity: 1,
    deliveryOptionId: input.deliveryOptionId,
  });

  if (priced.state !== 'ready') return priced;

  const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000);

  const updated = await deps.db.$transaction(async (tx) => {
    await tx.quote.update({
      where: { id: order.quote!.id },
      data: { state: 'invalidated' },
    });

    const quote = await tx.quote.create({
      data: {
        wishlistItemId: priced.wishlistItemId,
        merchantId: priced.request.merchant_id,
        state: priced.price.amountIsFinal ? 'valid_final' : 'valid_provisional',
        amountIsFinal: priced.price.amountIsFinal,
        expectedAmountMinor: priced.price.merchantAmountMinor,
        chargeCapMinor: priced.quote.charge_cap_minor ?? priced.price.merchantAmountMinor,
        currency: priced.price.currency,
        fulfillmentOptions: priced.deliveryOptions as unknown as object[],
        selectedOptionId:
          priced.request.fulfillment_option_id ??
          priced.quote.selected_option_id ??
          null,
        items: priced.request.items as unknown as object[],
        shipToDigest: priced.shipToDigest,
        expiresAt,
        raw: priced.quote as unknown as object,
      },
      select: { id: true },
    });

    return tx.fanOrder.update({
      where: { id: order.id },
      data: {
        state: 'draft',
        quoteId: quote.id,
        fanTotalMinor: priced.price.fanTotalMinor,
        markupMinor: priced.price.markupMinor,
        merchantCapMinor: priced.price.merchantAmountMinor,
        currency: priced.price.currency,
      },
      select: { id: true },
    });
  });

  return {
    state: 'created',
    order: {
      fanOrderId: updated.id,
      fanTotalMinor: priced.price.fanTotalMinor,
      markupMinor: priced.price.markupMinor,
      merchantCapMinor: priced.price.merchantAmountMinor,
      currency: priced.price.currency,
      amountIsFinal: priced.price.amountIsFinal,
      quoteExpiresAt: expiresAt,
      deliveryOptionId:
        priced.request.fulfillment_option_id ??
        priced.quote.selected_option_id ??
        null,
    },
  };
}
