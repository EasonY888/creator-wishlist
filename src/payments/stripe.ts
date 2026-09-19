/**
 * The real implementation of the fan payment rail.
 *
 * Two things make this different from the in-memory double, and both are
 * correctness properties rather than features:
 *
 *   1. **Money actually moves, so every call carries an idempotency key.** The
 *      reconciler may run many times for one order. A capture that is not
 *      idempotent is a fan charged twice, and no amount of local bookkeeping
 *      can undo that -- the ledger can only stop us *recording* it twice.
 *
 *   2. **The processor's state is the truth, and it is re-read.** The double
 *      keys everything off the idempotency key, so it never has to ask what
 *      happened. Real payment intents have their own lifecycle, and some of the
 *      states are dangerous to guess at. Every operation here retrieves the
 *      intent first and decides from what it actually says.
 *
 * The dangerous states, explicitly:
 *
 *   - `succeeded` means the money is already taken. Releasing from here is
 *     impossible, and reporting a successful release would tell the reconciler a
 *     hold was dropped when the fan has in fact been charged.
 *   - `requires_action` means the fan must still do something (3DS). It is a
 *     step-up, not a failure -- R-8 expects this as routine.
 *   - `processing` means an async method is in flight. Not yet authorized, but
 *     retrying is the right move rather than failing the order.
 */
import Stripe from 'stripe';

import {
  type AuthorizeInput,
  type PaymentOpInput,
  type PaymentPort,
  type PaymentResult,
  type PrepareInput,
  type PrepareResult,
} from './port';

export interface StripePaymentProviderOptions {
  secretKey: string;
  /**
   * Looks up the processor reference for an order.
   *
   * Injected rather than read from a database here, because this adapter should
   * not know how we persist orders. The composition root supplies it.
   *
   * It must find the intent even when the fan abandoned the flow before
   * confirming, because that intent is what has to be cancelled.
   */
  resolveAuthorizationRef: (fanOrderId: string) => Promise<string | null>;
  /**
   * Where to send the browser if a confirmation needs a bank redirect.
   *
   * Only used on the server-side confirm path. The browser path supplies its own
   * through `confirmPayment`, but a server-side confirmation has nobody to ask
   * and Stripe needs an absolute URL up front.
   */
  returnUrl?: string;
}

/** Stripe reports its own error classes; translate rather than leak them. */
function failureFrom(error: unknown): Extract<PaymentResult, { state: 'failed' }> {
  if (error instanceof Stripe.errors.StripeError) {
    const raw = error as { type?: string; code?: string; decline_code?: string };

    // Whether trying the same call again could plausibly succeed. Getting this
    // wrong in the permissive direction causes retry storms; in the restrictive
    // direction it strands an order that would have worked.
    const retryable =
      raw.type === 'StripeAPIError' ||
      raw.type === 'StripeConnectionError' ||
      raw.type === 'StripeRateLimitError';

    return {
      state: 'failed',
      code: raw.decline_code ?? raw.code ?? raw.type ?? 'stripe_error',
      message: error.message,
      retryable,
    };
  }

  return {
    state: 'failed',
    code: 'unexpected_error',
    message: error instanceof Error ? error.message : String(error),
    // Unrecognised, so assume it could be transient rather than dead-ending it.
    retryable: true,
  };
}

export class StripePaymentProvider implements PaymentPort {
  private readonly stripe: Stripe;
  private readonly resolveRef: (fanOrderId: string) => Promise<string | null>;
  private readonly returnUrl: string | undefined;

  constructor(options: StripePaymentProviderOptions) {
    // `apiVersion` is deliberately not pinned. The SDK's default is the version
    // it was built against, which is the only pairing Stripe tests; pinning a
    // literal here would silently drift from the installed SDK's types.
    this.stripe = new Stripe(options.secretKey);
    this.resolveRef = options.resolveAuthorizationRef;
    this.returnUrl = options.returnUrl;
  }

  /**
   * Create the intent, unconfirmed. The fan's card is entered against Stripe
   * directly, so no card data ever reaches this process (NFR-2.1).
   */
  async prepareAuthorization(input: PrepareInput): Promise<PrepareResult> {
    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: input.amountMinor,
          currency: input.currency.toLowerCase(),
          // The whole point of the rail: hold now, charge only once a merchant
          // order is confirmed successful (FR-3.6).
          capture_method: 'manual',
          metadata: { fanOrderId: input.fanOrderId },
          ...(input.description === undefined ? {} : { description: input.description }),
          // Only when we are not naming a method ourselves. With an explicit
          // `payment_method` this is rejected.
          ...(input.paymentMethod === undefined
            ? { automatic_payment_methods: { enabled: true } }
            : {
                payment_method: input.paymentMethod,
                confirm: true,
                ...(this.returnUrl === undefined ? {} : { return_url: this.returnUrl }),
              }),
        },
        { idempotencyKey: input.idempotencyKey },
      );

      if (intent.client_secret === null) {
        return {
          state: 'failed',
          code: 'missing_client_secret',
          message: 'Stripe returned an intent with no client secret.',
          retryable: false,
        };
      }

      return { state: 'ok', reference: intent.id, clientSecret: intent.client_secret };
    } catch (error) {
      const failure = failureFrom(error);
      return { ...failure, state: 'failed' };
    }
  }

  /**
   * Retrieve the intent and hand back its secret, if it is still confirmable.
   *
   * Only the pre-confirmation statuses qualify. Once a hold exists there is
   * nothing left to confirm, and returning a secret for a captured or cancelled
   * intent would let the browser attempt a payment against a dead one.
   */
  async clientSecretFor(fanOrderId: string): Promise<string | null> {
    const reference = await this.resolveRef(fanOrderId);
    if (reference === null) return null;

    try {
      const intent = await this.stripe.paymentIntents.retrieve(reference);

      if (intent.status !== 'requires_payment_method' && intent.status !== 'requires_confirmation') {
        return null;
      }

      return intent.client_secret;
    } catch {
      // Nothing recoverable -- a missing or deleted intent is not an error here,
      // it just means there is no secret to hand out.
      return null;
    }
  }

  /**
   * Confirm the hold exists.
   *
   * Always operates on the order's EXISTING intent when there is one. That is not
   * an optimisation -- it is the fix for a real double-hold bug. This previously
   * created a fresh intent whenever a payment method was named, using a
   * different idempotency key (`authorize:` rather than `prepare:`), so an order
   * that had already been prepared ended up with TWO holds on one card and only
   * the second ever captured. The live test caught it; the double could not,
   * because a double has no notion of a second intent existing.
   *
   * Three legitimate shapes:
   *
   *   - the browser already confirmed, so this only *verifies* the result
   *   - a server-side call names the payment method, so this confirms the
   *     prepared intent with it
   *   - no intent exists at all, so this creates and confirms in one step
   *
   * In every case the answer comes from retrieving the intent, never from the
   * fact that a call returned without throwing.
   */
  async authorize(input: AuthorizeInput): Promise<PaymentResult> {
    try {
      const existing = await this.resolveRef(input.fanOrderId);

      if (existing !== null) {
        // The browser path, or an already-confirmed intent. Nothing to do but
        // report what the processor says.
        if (input.paymentMethodRef === undefined) {
          return this.readHold(existing);
        }

        const intent = await this.stripe.paymentIntents.retrieve(existing);

        // Only a pre-confirmation intent can take a payment method. Anything
        // else has already settled, so report it as it is rather than trying to
        // confirm it a second time.
        if (
          intent.status !== 'requires_payment_method' &&
          intent.status !== 'requires_confirmation'
        ) {
          return this.readHold(existing);
        }

        const confirmed = await this.stripe.paymentIntents.confirm(
          existing,
          {
            payment_method: input.paymentMethodRef,
            ...(this.returnUrl === undefined ? {} : { return_url: this.returnUrl }),
          },
          { idempotencyKey: input.idempotencyKey },
        );

        return this.readHold(confirmed.id);
      }

      // No intent yet. A rail with no browser step places the hold outright.
      if (input.paymentMethodRef === undefined) {
        return {
          state: 'failed',
          code: 'no_intent',
          message: 'No payment intent exists for this order.',
          retryable: false,
        };
      }

      const created = await this.prepareAuthorization({
        fanOrderId: input.fanOrderId,
        idempotencyKey: input.idempotencyKey,
        amountMinor: input.amountMinor,
        currency: input.currency,
        paymentMethod: input.paymentMethodRef,
      });

      if (created.state === 'failed') {
        // The shapes match, so pass it through unchanged.
        return created;
      }

      return this.readHold(created.reference);
    } catch (error) {
      return failureFrom(error);
    }
  }

  /** Interpret an intent's status as a hold, without changing anything. */
  private async readHold(reference: string): Promise<PaymentResult> {
    const intent = await this.stripe.paymentIntents.retrieve(reference);

    switch (intent.status) {
      case 'requires_capture':
        // The hold exists and the fan has not been charged. This is the target.
        return { state: 'ok', reference: intent.id, amountMinor: intent.amount };

      case 'processing':
        // An async method is still settling. Not a failure, and not yet a hold.
        return {
          state: 'failed',
          code: 'processing',
          message: 'The payment is still being processed.',
          retryable: true,
        };

      case 'requires_action':
        // Step-up outstanding: the fan has something left to do. Expected as
        // routine (R-8), so it must not read as a decline.
        return {
          state: 'failed',
          code: 'requires_action',
          message: 'The fan still needs to complete a verification step.',
          retryable: true,
        };

      case 'requires_confirmation':
      case 'requires_payment_method':
        return {
          state: 'failed',
          code: 'not_confirmed',
          message: 'The payment method was never confirmed.',
          retryable: false,
        };

      case 'succeeded':
        // Manual capture means this should be unreachable at authorize time. If
        // it happens the money is already taken, so say so plainly rather than
        // reporting a hold that does not exist.
        return {
          state: 'failed',
          code: 'already_captured',
          message: 'The intent was already captured; there is no hold to rely on.',
          retryable: false,
        };

      case 'canceled':
        return {
          state: 'failed',
          code: 'canceled',
          message: 'The intent was cancelled.',
          retryable: false,
        };

      default:
        return {
          state: 'failed',
          code: `status_${intent.status}`,
          message: `Unhandled intent status: ${intent.status}`,
          retryable: false,
        };
    }
  }

  /**
   * Take the money, but only the amount we believe we are taking.
   *
   * The amount and currency are checked against the intent rather than trusted
   * from the caller. Capturing an amount that does not match what was authorized
   * would charge the fan something they never agreed to, and the caller passing a
   * stale figure is exactly the kind of bug that is invisible until it is real
   * money.
   */
  async capture(input: PaymentOpInput): Promise<PaymentResult> {
    try {
      const reference = await this.requireRef(input.fanOrderId);
      if (reference.state === 'failed') return reference;

      const intent = await this.stripe.paymentIntents.retrieve(reference.reference);

      if (intent.status === 'succeeded') {
        // Already done, most likely a replayed retry. Not an error, and not new
        // work -- the reconciler may run many times for one order.
        return { state: 'already_done', reference: intent.id, amountMinor: intent.amount };
      }

      if (intent.status === 'canceled') {
        return {
          state: 'failed',
          code: 'canceled',
          message: 'The hold was already released, so there is nothing to capture.',
          retryable: false,
        };
      }

      if (intent.status !== 'requires_capture') {
        return {
          state: 'failed',
          code: `not_capturable_${intent.status}`,
          message: `An intent in status ${intent.status} cannot be captured.`,
          retryable: intent.status === 'processing',
        };
      }

      // Capturing LESS than was authorised is the normal path, not an error.
      //
      // On a tax-added market the fan authorises a ceiling and must be charged
      // the merchant's actual figure -- the whole product is that refusal to
      // keep the difference. Comparing with `!==` treated that ordinary outcome
      // as a violation, so every live card payment whose merchant charged less
      // than the ceiling was refused at capture and sat in `processing` forever
      // with `amount_mismatch` and `retryable: false`. Stripe releases the
      // uncaptured remainder on its own.
      //
      // Capturing MORE is the thing that must never happen: it is the fan being
      // charged above what they approved.
      if (input.amountMinor > intent.amount) {
        return {
          state: 'failed',
          code: 'amount_mismatch',
          message: `Refusing to capture ${input.amountMinor} against an authorization for ${intent.amount}.`,
          retryable: false,
        };
      }

      if (intent.currency.toUpperCase() !== input.currency.toUpperCase()) {
        return {
          state: 'failed',
          code: 'currency_mismatch',
          message: `Refusing to capture ${input.currency} against a ${intent.currency} authorization.`,
          retryable: false,
        };
      }

      const captured = await this.stripe.paymentIntents.capture(
        reference.reference,
        // Omitted when it matches, so the common full-capture case sends no
        // amount at all rather than restating it.
        input.amountMinor === intent.amount
          ? {}
          : { amount_to_capture: input.amountMinor },
        { idempotencyKey: input.idempotencyKey },
      );

      if (captured.status !== 'succeeded') {
        return {
          state: 'failed',
          code: `capture_${captured.status}`,
          message: `Capture returned status ${captured.status}.`,
          retryable: true,
        };
      }

      return { state: 'ok', reference: captured.id, amountMinor: captured.amount_received };
    } catch (error) {
      return failureFrom(error);
    }
  }

  /**
   * Drop the hold.
   *
   * Refuses outright when the intent has already succeeded. Cancelling is
   * impossible there, and reporting success would tell the caller a hold was
   * released when the fan has actually been charged -- the one outcome the
   * release path exists to prevent.
   */
  async release(input: PaymentOpInput): Promise<PaymentResult> {
    try {
      const reference = await this.requireRef(input.fanOrderId);
      if (reference.state === 'failed') return reference;

      const intent = await this.stripe.paymentIntents.retrieve(reference.reference);

      if (intent.status === 'canceled') {
        return { state: 'already_done', reference: intent.id, amountMinor: intent.amount };
      }

      if (intent.status === 'succeeded') {
        return {
          state: 'failed',
          code: 'already_captured',
          message:
            'The intent has already been captured, so the money has moved. This is a refund, not a release.',
          retryable: false,
        };
      }

      const canceled = await this.stripe.paymentIntents.cancel(
        reference.reference,
        {},
        { idempotencyKey: input.idempotencyKey },
      );

      return { state: 'ok', reference: canceled.id, amountMinor: canceled.amount };
    } catch (error) {
      return failureFrom(error);
    }
  }

  /**
   * Give captured money back.
   *
   * Only valid against a captured intent. Refunding a mere hold is meaningless --
   * the hold has to be released instead -- and conflating the two would misreport
   * whether the fan was ever charged.
   *
   * The amount is checked against what actually settled rather than trusted, for
   * the same reason `capture` checks its own: a refund larger than the capture is
   * a bug that only becomes visible once it is real money.
   */
  async refund(input: PaymentOpInput): Promise<PaymentResult> {
    try {
      const reference = await this.requireRef(input.fanOrderId);
      if (reference.state === 'failed') return reference;

      const intent = await this.stripe.paymentIntents.retrieve(reference.reference);

      if (intent.status !== 'succeeded') {
        return {
          state: 'failed',
          code: intent.status === 'requires_capture' ? 'not_captured' : `refund_${intent.status}`,
          message:
            intent.status === 'requires_capture'
              ? 'The payment was never captured, so there is nothing to refund. Release the hold instead.'
              : `An intent in status ${intent.status} cannot be refunded.`,
          retryable: false,
        };
      }

      // How much has already gone back. Read from the refund list rather than the
      // intent: this API version exposes `amount_received` but not
      // `amount_refunded`, and asking the refunds endpoint directly is both
      // version-proof and the actual source of truth.
      const existing = await this.stripe.refunds.list({
        payment_intent: intent.id,
        limit: 100,
      });

      const alreadyRefunded = existing.data
        .filter((refund) => refund.status !== 'failed')
        .reduce((total, refund) => total + refund.amount, 0);

      const remaining = intent.amount_received - alreadyRefunded;

      if (remaining <= 0) {
        return {
          state: 'already_done',
          reference: intent.id,
          amountMinor: alreadyRefunded,
        };
      }

      if (input.amountMinor > remaining) {
        return {
          state: 'failed',
          code: 'refund_exceeds_captured',
          message: `Refusing to refund ${input.amountMinor} when only ${remaining} is still refundable.`,
          retryable: false,
        };
      }

      const refunded = await this.stripe.refunds.create(
        { payment_intent: intent.id, amount: input.amountMinor },
        { idempotencyKey: input.idempotencyKey },
      );

      return { state: 'ok', reference: refunded.id, amountMinor: refunded.amount };
    } catch (error) {
      return failureFrom(error);
    }
  }

  /** Resolve an order's intent, or explain that there is nothing to act on. */
  private async requireRef(
    fanOrderId: string,
  ): Promise<{ state: 'ok'; reference: string } | Extract<PaymentResult, { state: 'failed' }>> {
    const reference = await this.resolveRef(fanOrderId);
    if (reference === null) {
      return {
        state: 'failed',
        code: 'no_intent',
        message: 'No payment intent exists for this order.',
        retryable: false,
      };
    }
    return { state: 'ok', reference };
  }
}
