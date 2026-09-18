/**
 * Stripe's authoritative statements about the fan rail.
 *
 * The fan's payment and the merchant's purchase are separate rails with separate
 * lifecycles (FR-3.7, R-19), and this endpoint is how the fan rail reports in.
 * It matters most for the outcomes we cannot see synchronously: a card that is
 * declined *after* the fan's browser has already gone, or an authorization that
 * lapses on its own.
 *
 * ## What this deliberately does not do
 *
 * It does not transition order state. The reconciler is the single writer that
 * decides whether an order succeeded, failed or is uncertain, because that
 * decision depends on the MERCHANT rail as well as this one. A second writer
 * would let the two rails disagree about the same order, which is precisely the
 * failure R-19 exists to prevent.
 *
 * So this records what the processor said, and pokes reconciliation. The
 * reconciler still decides.
 *
 * ## Retry semantics
 *
 * Stripe retries on any non-2xx, so anything we understand returns 200 even when
 * we choose to do nothing with it. Only a signature we cannot verify is a 400 --
 * and that is not a retryable condition either, it is a misconfiguration.
 */
import { NextResponse } from 'next/server';
import Stripe from 'stripe';

import { prisma } from '@/db/client';
import { sha256Hex } from '@/fulfillment/binding';
import { enqueue, OUTBOX_TOPICS } from '@/orders/outbox';
import { recordPaymentOnce } from '@/payments/ledger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Events we act on.
 *
 * `amount_capturable_updated` is the hold landing, `succeeded` the money moving,
 * `canceled` the hold dropping, and `payment_failed` the asynchronous decline
 * that the browser can no longer see.
 */
const HANDLED_EVENTS = new Set([
  'payment_intent.amount_capturable_updated',
  'payment_intent.succeeded',
  'payment_intent.canceled',
  'payment_intent.payment_failed',
]);

export async function POST(request: Request): Promise<NextResponse> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secretKey || !webhookSecret) {
    // A configuration gap. Returning 500 makes Stripe retry, which is what we
    // want: the events are not lost while the secret is fixed.
    return NextResponse.json(
      { error: 'Stripe is not configured on this server.' },
      { status: 500 },
    );
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature.' }, { status: 400 });
  }

  // The RAW body, before any parsing. The signature covers the exact bytes
  // Stripe sent, so re-serialising the parsed object would invalidate it.
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    const stripe = new Stripe(secretKey);
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    // Unverified, so it is not from Stripe and must not be acted on.
    return NextResponse.json(
      { error: `Invalid signature: ${error instanceof Error ? error.message : 'unknown'}` },
      { status: 400 },
    );
  }

  const dedupeKey = `stripe_event:${event.id}`;

  // Fast path. The real guard against double-acting is that everything below is
  // already idempotent; this is a cheap way to skip the work on a replay.
  const seen = await prisma.idempotencyKey.findUnique({
    where: { key: dedupeKey },
    select: { id: true },
  });

  if (seen) {
    return NextResponse.json({ received: true, replayed: true });
  }

  if (HANDLED_EVENTS.has(event.type)) {
    await handlePaymentIntent(event);
  }

  // Recorded AFTER the work, deliberately. The other order would poison the key
  // on a thrown error: Stripe would retry, we would see the key, and we would
  // report success for work that never happened.
  await prisma.idempotencyKey
    .create({
      data: {
        key: dedupeKey,
        scope: 'stripe_webhook',
        requestHash: sha256Hex(rawBody),
        responseJson: { type: event.type },
      },
    })
    // A concurrent delivery won the race. It is doing the same idempotent work,
    // so there is nothing to reconcile.
    .catch(() => undefined);

  return NextResponse.json({ received: true });
}

async function handlePaymentIntent(event: Stripe.Event): Promise<void> {
  const intent = event.data.object as Stripe.PaymentIntent;
  const fanOrderId = intent.metadata?.fanOrderId;

  // Not an order of ours. Acknowledge rather than 400, or Stripe retries forever.
  if (typeof fanOrderId !== 'string' || fanOrderId.length === 0) return;

  switch (event.type) {
    case 'payment_intent.succeeded': {
      // The money moved. `amount_received` is what actually settled, which is
      // the figure the ledger should carry rather than what we asked for.
      await prisma.$transaction(async (tx) => {
        await recordPaymentOnce(tx, {
          fanOrderId,
          type: 'captured',
          amountMinor: intent.amount_received,
          currency: intent.currency.toUpperCase(),
          providerRef: intent.id,
        });
      });
      break;
    }

    case 'payment_intent.canceled': {
      // The hold is gone. Recorded, but NOT treated as authority to move the
      // order -- that depends on whether a merchant purchase exists.
      await prisma.$transaction(async (tx) => {
        await recordPaymentOnce(tx, {
          fanOrderId,
          type: 'released',
          amountMinor: intent.amount,
          currency: intent.currency.toUpperCase(),
          providerRef: intent.id,
        });
      });
      break;
    }

    case 'payment_intent.payment_failed': {
      // Declined asynchronously, after the fan's browser had already moved on.
      // No ledger type fits -- nothing was ever held -- but this is exactly the
      // event that would otherwise go unnoticed, so it is logged for operators.
      const reason = intent.last_payment_error?.code ?? 'unknown';
      console.warn(
        `[stripe.webhook] payment failed for order ${fanOrderId} (${reason}); no funds were held`,
      );
      break;
    }

    case 'payment_intent.amount_capturable_updated': {
      // The hold landed. Recorded so the fan's "was I charged?" answer comes from
      // the processor rather than from our belief about it.
      if (intent.status !== 'requires_capture') break;

      await prisma.$transaction(async (tx) => {
        await recordPaymentOnce(tx, {
          fanOrderId,
          type: 'authorized',
          amountMinor: intent.amount,
          currency: intent.currency.toUpperCase(),
          providerRef: intent.id,
        });
      });
      break;
    }
  }

  // Poke reconciliation for orders that already reached a merchant. Guarded on a
  // merchant order existing, because polling the merchant for an order that was
  // never dispatched has nothing to ask about.
  if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.canceled') {
    const dispatched = await prisma.merchantOrder.findUnique({
      where: { fanOrderId },
      select: { id: true },
    });

    if (dispatched) {
      await prisma.$transaction((tx) =>
        enqueue(tx, OUTBOX_TOPICS.POLL_ORDER_STATUS, { fanOrderId }),
      );
    }
  }
}
