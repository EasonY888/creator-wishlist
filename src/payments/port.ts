/**
 * The fan payment rail.
 *
 * Deliberately a separate port from `AgnicPort`, because these are genuinely two
 * different money flows with two different lifecycles:
 *
 *   - this one collects from the FAN, on our own processor
 *   - `AgnicPort` pays the MERCHANT, using our vaulted business card
 *
 * They must be reconciled against each other, never conflated. A merchant-side
 * failure has to release the fan's hold; a merchant-side success has to capture
 * it — and the amount captured is our approved total, never the merchant's.
 *
 * Every operation carries an idempotency key. That is not decoration: the
 * reconciler may run many times for one order, and a capture that is not
 * idempotent is a customer charged twice.
 */

export interface PaymentOpInput {
  fanOrderId: string;
  /** Stable per (operation, order). Retries must reuse the same key. */
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
}

export interface AuthorizeInput extends PaymentOpInput {
  /**
   * Opaque reference to the fan's saved payment method.
   *
   * Supply this when the processor places the hold directly with no browser
   * step -- server-side tests, and any rail that needs no confirmation. Omit it
   * when the fan already confirmed a prepared intent in the browser, because
   * there the method is attached to the intent and all we can do is verify the
   * hold it produced.
   */
  paymentMethodRef?: string;
}

/** Input for creating the intent the browser will confirm. */
export interface PrepareInput extends PaymentOpInput {
  /** Shown to the fan on their statement, and in the processor's dashboard. */
  description?: string;
  /**
   * Name a payment method and confirm in the same call, skipping the browser
   * step. Used by server-side tests and by rails that need no confirmation.
   * Production checkout leaves this out so the card never reaches our server.
   */
  paymentMethod?: string;
}

export type PrepareResult =
  | {
      state: 'ok';
      reference: string;
      /**
       * Handed to the browser so the card is entered against the processor
       * directly, never through our server (NFR-2.1).
       *
       * `null` when the rail needs no browser step at all, which is the case for
       * the in-memory double -- there is no card form to drive.
       */
      clientSecret: string | null;
    }
  | { state: 'failed'; code: string; message?: string; retryable?: boolean };

export type PaymentResult =
  | { state: 'ok'; reference: string; amountMinor: number }
  /** The processor recognised the idempotency key. Not an error, and not new work. */
  | { state: 'already_done'; reference: string; amountMinor: number }
  | { state: 'failed'; code: string; message?: string; retryable?: boolean };

export interface PaymentPort {
  /**
   * Create the intent the browser will confirm, at a point when no hold exists.
   *
   * Split from `authorize` because the fan has to enter a card before anything
   * can be held, and the card must reach the processor without passing through
   * our server. This call is what makes that possible; `authorize` subsequently
   * *verifies* the hold rather than attempting to create one.
   *
   * Idempotent per order: calling it again must return the same intent, never a
   * second one, or a fan who reloads the page gets two holds.
   */
  prepareAuthorization(input: PrepareInput): Promise<PrepareResult>;
  /**
   * Recover the client secret for an already-prepared intent.
   *
   * Needed because reloading the card form loses the secret that
   * `prepareAuthorization` handed out, and re-preparing would create a SECOND
   * intent -- an idempotency key only replays for 24 hours, after which the same
   * call places a fresh hold. Retrieving the existing intent is the only way
   * back to the same one.
   *
   * Returns null when there is nothing left to confirm: no intent, one that is
   * already confirmed or cancelled, or a rail with no browser step at all.
   */
  clientSecretFor(fanOrderId: string): Promise<string | null>;
  /** Place a hold. The fan is not charged yet. */
  authorize(input: AuthorizeInput): Promise<PaymentResult>;
  /** Take the money. Only ever called after a confirmed merchant success. */
  capture(input: PaymentOpInput): Promise<PaymentResult>;
  /** Drop the hold. Only ever called when no purchase exists. */
  release(input: PaymentOpInput): Promise<PaymentResult>;
  /**
   * Give captured money back.
   *
   * Distinct from `release`: a release drops a hold that was never taken, while
   * this returns money that WAS taken. They are not interchangeable, and using
   * the wrong one misreports whether the fan has been charged.
   *
   * Reachable only from an operator action, because the merchant refund that
   * triggers it happens out-of-band and no code can observe it (FR-5.7).
   */
  refund(input: PaymentOpInput): Promise<PaymentResult>;
}

/** Stable key for a single logical operation on one order. */
export function idempotencyKeyFor(
  operation: 'prepare' | 'authorize' | 'capture' | 'release' | 'refund',
  fanOrderId: string,
): string {
  return `${operation}:${fanOrderId}`;
}

// ---------------------------------------------------------------------------
// Test double
// ---------------------------------------------------------------------------

interface Recorded {
  reference: string;
  amountMinor: number;
}

/**
 * In-memory payment processor.
 *
 * Models the one behaviour that matters for correctness — that repeating an
 * operation with the same idempotency key returns the original result rather
 * than moving money again — so the reconciler can be tested without a Stripe
 * account.
 */
export class FakePaymentProvider implements PaymentPort {
  readonly calls: Array<{ op: string; input: PaymentOpInput }> = [];

  /** Operations to fail, by idempotency key. */
  failures = new Map<string, { code: string; retryable?: boolean }>();

  private readonly results = new Map<string, Recorded>();
  private sequence = 0;

  private perform(op: string, input: PaymentOpInput): PaymentResult {
    this.calls.push({ op, input });

    const configured = this.failures.get(input.idempotencyKey);
    if (configured) {
      return {
        state: 'failed',
        code: configured.code,
        ...(configured.retryable === undefined ? {} : { retryable: configured.retryable }),
      };
    }

    const existing = this.results.get(input.idempotencyKey);
    if (existing) {
      // The processor has seen this key before, so it reports the original
      // outcome instead of acting twice.
      return { state: 'already_done', ...existing };
    }

    this.sequence += 1;
    const recorded: Recorded = {
      reference: `pay_${op}_${this.sequence}`,
      amountMinor: input.amountMinor,
    };
    this.results.set(input.idempotencyKey, recorded);

    return { state: 'ok', ...recorded };
  }

  async authorize(input: AuthorizeInput): Promise<PaymentResult> {
    return this.perform('authorize', input);
  }

  async capture(input: PaymentOpInput): Promise<PaymentResult> {
    return this.perform('capture', input);
  }

  async release(input: PaymentOpInput): Promise<PaymentResult> {
    return this.perform('release', input);
  }

  async refund(input: PaymentOpInput): Promise<PaymentResult> {
    return this.perform('refund', input);
  }

  /**
   * Records the call and returns an intent with no browser step, because the
   * double has no card form to drive and no client secret to hand out.
   */
  async prepareAuthorization(input: PrepareInput): Promise<PrepareResult> {
    this.calls.push({ op: 'prepare', input });

    const configured = this.failures.get(input.idempotencyKey);
    if (configured) {
      return {
        state: 'failed',
        code: configured.code,
        ...(configured.retryable === undefined ? {} : { retryable: configured.retryable }),
      };
    }

    return { state: 'ok', reference: `pi_fake_${input.fanOrderId}`, clientSecret: null };
  }

  /** Nothing to confirm on a rail with no browser step. */
  async clientSecretFor(): Promise<string | null> {
    return null;
  }

  countOf(op: string): number {
    return this.calls.filter((call) => call.op === op).length;
  }
}
