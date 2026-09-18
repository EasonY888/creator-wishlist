import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ConfirmWithoutCard, FinishPayment, default as PaymentForm } from './PaymentForm';
import { prisma } from '@/db/client';
import { formatMoney } from '@/presentation/money';
import { services, stripePublishableKey } from '@/services';

export const dynamic = 'force-dynamic';

/**
 * The card step, reached only after the fan approved a specific total.
 *
 * Two things make this page safe to reload:
 *
 *   1. The total shown is read from the ORDER, not from a query parameter. The
 *      figure the fan agreed to is the figure on the frozen request.
 *   2. The intent is recovered rather than recreated. Re-preparing would create
 *      a second hold once Stripe's idempotency window has passed.
 */
export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ fanOrderId: string }>;
  searchParams: Promise<{ finish?: string }>;
}) {
  const { fanOrderId } = await params;
  const { finish } = await searchParams;

  const order = await prisma.fanOrder.findUnique({
    where: { id: fanOrderId },
    include: { creator: true },
  });

  if (!order) notFound();

  // Past the card step already. Money is involved now, so the status page owns it.
  if (order.state !== 'draft' && order.state !== 'approved') {
    redirect(`/orders/${fanOrderId}`);
  }

  // Never approved, so there is no frozen request and nothing to hold money
  // against. Send them back to agree to the total first.
  if (order.state === 'draft') {
    redirect(`/checkout/${fanOrderId}`);
  }

  const total = formatMoney(order.fanTotalMinor, order.currency);
  const { payments, paymentsMode } = services();

  // The bank sent the fan back. Same page, different job.
  if (finish === '1') {
    return (
      <main>
        <div className="hero">
          <h1>Confirming your payment</h1>
        </div>
        <div className="card">
          <div className="row">
            <strong className="title-lg">{order.creator.displayName}</strong>
            <span className="total total-lg money">{total}</span>
          </div>
        </div>
        <FinishPayment fanOrderId={fanOrderId} />
        <p className="muted small" style={{ marginTop: '1rem' }}>
          Do not close this page. We are checking with your bank and the shop.
        </p>
      </main>
    );
  }

  // No real processor in this mode, so there is no card to collect. The server
  // still runs the identical verification, which is what is worth testing.
  if (paymentsMode !== 'stripe') {
    return (
      <main>
        <div className="hero">
          <h1>Confirm your payment</h1>
        </div>
        <div className="card">
          <div className="row">
            <strong className="title-lg">{order.creator.displayName}</strong>
            <span className="total total-lg money">{total}</span>
          </div>
        </div>
        <div className="notice notice-info" style={{ marginTop: '1.25rem' }}>
          Running against the in-memory payment rail, so there is no card to
          enter. The hold and the capture behave exactly as they do with a real
          processor.
        </div>
        <ConfirmWithoutCard fanOrderId={fanOrderId} />
      </main>
    );
  }

  const publishableKey = stripePublishableKey();
  if (!publishableKey) {
    return (
      <main>
        <div className="hero">
          <h1>Payment is unavailable</h1>
        </div>
        <div className="notice notice-warn">
          <strong>Stripe is not fully configured.</strong> Set{' '}
          <code>NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY</code>, or run with{' '}
          <code>PAYMENTS_MODE=fake</code>. Nothing has been charged.
        </div>
        <p className="small" style={{ marginTop: '1.25rem' }}>
          <Link href={`/orders/${fanOrderId}`}>&larr; View this order</Link>
        </p>
      </main>
    );
  }

  // Recovered rather than recreated, so a reload returns to the same intent.
  const clientSecret =
    order.paymentIntentRef === null ? null : await payments.clientSecretFor(fanOrderId);

  if (clientSecret === null) {
    return (
      <main>
        <div className="hero">
          <h1>We could not open the payment step</h1>
        </div>
        <div className="notice notice-warn">
          The payment could not be prepared. Nothing has been charged.
        </div>
        <p className="small" style={{ marginTop: '1.25rem' }}>
          <Link href={`/checkout/${fanOrderId}`}>&larr; Try again</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <div className="hero">
        <h1>Pay for your gift</h1>
      </div>

      <div className="card">
        <div className="row">
          <div>
            <strong className="title-lg">{order.creator.displayName}</strong>
            <div className="muted small">receives this gift</div>
          </div>
          <span className="total total-lg money">{total}</span>
        </div>
      </div>

      {/* The trust moment, restated at the point of spending. */}
      <div className="notice notice-info">
        Your card details go straight to our payment processor &mdash; they never
        reach this site. Ships to {order.creator.displayName}; their address is
        never shown to you.
      </div>

      <PaymentForm
        fanOrderId={fanOrderId}
        clientSecret={clientSecret}
        publishableKey={publishableKey}
        amountLabel={total}
      />

      <p className="small" style={{ marginTop: '1.25rem' }}>
        <Link href={`/checkout/${fanOrderId}`}>&larr; Back</Link>
      </p>
    </main>
  );
}
