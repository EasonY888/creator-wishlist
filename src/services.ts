import { FakeAgnic } from './agnic/fake';
import { AgnicHttpClient } from './agnic/http';
import type { AgnicPort } from './agnic/port';
import { prisma } from './db/client';
import { markupPercentFromEnv } from './domain/pricing';
import { FakePaymentProvider, type PaymentPort } from './payments/port';
import { StripePaymentProvider } from './payments/stripe';

/**
 * One place that decides which implementations the app is running against.
 *
 * The point is that the UI, the checkout service and the worker all get their
 * dependencies from here rather than each constructing their own. Swapping the
 * provider for a fake is then one environment variable instead of a code change,
 * which is what makes the failure paths demonstrable without a live account.
 */

export type AgnicMode = 'live' | 'fake';

function agnicMode(): AgnicMode {
  const raw = (process.env.AGNIC_MODE ?? 'live').toLowerCase();
  return raw === 'fake' ? 'fake' : 'live';
}

function buildAgnic(): AgnicPort {
  if (agnicMode() === 'fake') {
    // Deterministic, no network, and able to summon failures on demand.
    return new FakeAgnic();
  }

  const token = process.env.AGNIC_TOKEN;
  if (!token) {
    throw new Error(
      'AGNIC_TOKEN is required when AGNIC_MODE is live. Set AGNIC_MODE=fake to run without one.',
    );
  }

  return new AgnicHttpClient({ token });
}

/**
 * The fan payment rail.
 *
 * Two modes, because the rail has a real processor and the failure paths still
 * need to be demonstrable without one:
 *
 *   - `fake`   -- the in-memory double. Models idempotency, so the capture logic
 *                 it exercises is the real capture logic.
 *   - `stripe` -- real PaymentIntents against Stripe. Test keys move no money,
 *                 but every call, error and idempotency semantic is genuine.
 */
export type PaymentsMode = 'fake' | 'stripe';

function paymentsMode(): PaymentsMode {
  const raw = (process.env.PAYMENTS_MODE ?? 'fake').toLowerCase();
  return raw === 'stripe' ? 'stripe' : 'fake';
}

/**
 * Resolves an order to its processor intent.
 *
 * Prefers the CONFIRMED reference in the ledger, because that is the record of
 * what the fan actually agreed to. Falls back to the intent created before
 * confirmation -- that intent is the one that has to be cancelled when a fan
 * abandons the card form, and it is also the only handle we have if the
 * authorization never completed.
 */
async function resolveAuthorizationRef(fanOrderId: string): Promise<string | null> {
  const authorized = await prisma.paymentEvent.findFirst({
    where: { fanOrderId, type: 'authorized' },
    select: { providerRef: true },
    orderBy: { createdAt: 'desc' },
  });

  if (authorized) return authorized.providerRef;

  const order = await prisma.fanOrder.findUnique({
    where: { id: fanOrderId },
    select: { paymentIntentRef: true },
  });

  return order?.paymentIntentRef ?? null;
}

function buildPayments(): PaymentPort {
  if (paymentsMode() === 'fake') {
    return new FakePaymentProvider();
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      'STRIPE_SECRET_KEY is required when PAYMENTS_MODE=stripe. Set PAYMENTS_MODE=fake to run without one.',
    );
  }

  return new StripePaymentProvider({
    secretKey,
    resolveAuthorizationRef,
    // Only needed for a confirmation that lands on a bank redirect, which the
    // browser flow handles itself. Derived from the app URL so a deployment does
    // not have to name its own domain twice.
    ...(process.env.APP_URL === undefined
      ? {}
      : { returnUrl: `${process.env.APP_URL}/checkout` }),
  });
}

/**
 * The browser-side key. Publishable, so safe to hand out, and read at request
 * time rather than module load so a missing value surfaces as a render error
 * rather than a build failure.
 */
export function stripePublishableKey(): string | null {
  return process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null;
}

let cached: { agnic: AgnicPort; payments: PaymentPort } | null = null;

/** Lazily built so a missing token throws on first use, not at import time. */
export function services(): {
  db: typeof prisma;
  agnic: AgnicPort;
  payments: PaymentPort;
  markupPercent: number;
  mode: AgnicMode;
  paymentsMode: PaymentsMode;
} {
  cached ??= { agnic: buildAgnic(), payments: buildPayments() };

  return {
    db: prisma,
    agnic: cached.agnic,
    payments: cached.payments,
    markupPercent: markupPercentFromEnv(process.env.MARKUP_PERCENT),
    mode: agnicMode(),
    paymentsMode: paymentsMode(),
  };
}

/** Dependencies shaped for the checkout service. */
export function checkoutDeps() {
  const { db, agnic, payments, markupPercent } = services();
  return { db, agnic, payments, markupPercent };
}

/** Dependencies shaped for the worker. */
export function workerDeps(workerId = 'worker-1') {
  const { db, agnic, payments } = services();
  return { db, agnic, payments, workerId };
}
