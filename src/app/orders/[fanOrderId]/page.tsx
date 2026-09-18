import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutoRefresh } from './AutoRefresh';
import { prisma } from '@/db/client';
import { toProviderOrder } from '@/agnic/port';
import type { FanOrderState } from '@/domain/order-fsm';
import { currentFan } from '@/fans/current';
import { fanOrderIsSettled, fanOrderView } from '@/presentation/fan-view';
import { formatMoney } from '@/presentation/money';

export const dynamic = 'force-dynamic';

/**
 * What the fan sees.
 *
 * The payload is built by `fanOrderView`, which takes a narrow set of scalars and
 * asserts that nothing sensitive is present before returning. This page cannot
 * leak the creator's address because it is never handed one — the projection
 * would have thrown first.
 */
export default async function OrderStatusPage({
  params,
}: {
  params: Promise<{ fanOrderId: string }>;
}) {
  const { fanOrderId } = await params;

  const order = await prisma.fanOrder.findUnique({
    where: { id: fanOrderId },
    include: {
      creator: true,
      merchantOrder: true,
      // The captured figure comes from the ledger, not from a column, because the
      // ledger is the append-only record of what actually moved.
      paymentEvents: { orderBy: { createdAt: 'asc' } },
    },
  });

  if (!order) notFound();

  // Ownership. Until now any holder of this link could read the order, because
  // nothing tied it to a person. `notFound` rather than a 403 on purpose: an
  // error page would confirm the order exists to whoever guessed the id.
  const fan = await currentFan();
  if (!fan || fan.fanId !== order.fanId) notFound();

  const capturedMinor =
    order.paymentEvents.find((event) => event.type === 'captured')?.amountMinor ?? null;

  const view = fanOrderView({
    orderId: order.id,
    creatorDisplayName: order.creator.displayName,
    fanTotalMinor: order.fanTotalMinor,
    chargedMinor: capturedMinor,
    currency: order.currency,
    localState: order.state as FanOrderState,
    providerOrder: order.merchantOrder?.statusRaw
      ? toProviderOrder({
          id: order.merchantOrder.providerOrderId ?? order.id,
          status: order.merchantOrder.statusRaw,
          retryable: order.merchantOrder.retryable,
          retry_action: order.merchantOrder.retryAction,
          amount_charged_minor: order.merchantOrder.amountChargedMinor,
          evidence: (order.merchantOrder.evidence ?? null) as Record<string, unknown> | null,
        })
      : null,
    placedAt: order.createdAt,
  });

  const settled = fanOrderIsSettled(order.state as FanOrderState);
  const tone =
    view.status.payment === 'released'
      ? 'badge-ok'
      : view.status.payment === 'unknown'
        ? 'badge-warn'
        : view.status.payment === 'captured'
          ? 'badge-ok'
          : '';

  return (
    <main>
      <AutoRefresh enabled={!settled} />

      <p className="small">
        <Link href={`/w/${order.creator.publicSlug}`}>&larr; {order.creator.displayName}&apos;s wishlist</Link>
      </p>

      <div className="hero">
        <h1>{order.creator.displayName}</h1>
        <p className="muted small">Gift order</p>
      </div>

      {/* The fan's first question is always whether they were charged, so the
          status card leads the page — no icons, no progress bar. A placed
          order is not a shipped one, and this page never implies otherwise. */}
      <div className="card">
        <div className="row">
          <span className={`badge ${tone}`}>Status</span>
          {!settled ? <span className="muted small">refreshing&hellip;</span> : null}
        </div>

        <h2 style={{ marginTop: '0.85rem' }}>{view.status.title}</h2>
        <p style={{ margin: 0 }}>{view.status.explanation}</p>
      </div>

      <div className="card">
        <table>
          <tbody>
            <tr>
              <th>Order</th>
              <td className="mono">{view.orderId}</td>
            </tr>
            <tr>
              <th>You paid</th>
              <td className="money" style={{ textAlign: 'right' }}>
                {formatMoney(view.totalMinor, view.currency)}
              </td>
            </tr>
            {view.chargedLessThanApproved ? (
              <tr>
                <th>You approved up to</th>
                <td className="money" style={{ textAlign: 'right' }}>
                  {formatMoney(view.approvedMinor, view.currency)}
                </td>
              </tr>
            ) : null}
            <tr>
              <th>Payment</th>
              <td>{paymentWords(view.status.payment)}</td>
            </tr>
            <tr>
              <th>Created</th>
              <td>{new Date(view.placedAt).toLocaleString()}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        className={
          view.status.payment === 'unknown'
            ? 'notice notice-warn'
            : 'notice notice-info'
        }
      >
        {paymentWords(view.status.payment)}
        {view.status.payment === 'unknown'
          ? ' — please do not submit again. We are checking and will update this page.'
          : ''}
      </div>

      {/*
        Said plainly, because it is the fan's money and they will notice the
        difference from the number they approved. The gap is the shop's tax
        allowance coming in lower than estimated, and it stays with the fan.

        Deliberately does NOT claim the fee went down. The fee is exactly what was
        shown; the difference is the shop's unused estimate.
      */}
      {view.chargedLessThanApproved ? (
        <div className="notice notice-info">
          The shop charged less than it estimated, so you were charged{' '}
          <strong>{formatMoney(view.totalMinor, view.currency)}</strong> rather than
          the {formatMoney(view.approvedMinor, view.currency)} you approved. That{' '}
          {formatMoney(view.approvedMinor - view.totalMinor, view.currency)}{' '}
          difference is yours &mdash; our fee is unchanged.
        </div>
      ) : null}

      <p className="muted small" style={{ marginTop: '1.5rem' }}>
        This page shows only what is yours: the order reference, the amount you
        approved, and its status. The creator&apos;s delivery details are never
        part of it.
      </p>
    </main>
  );
}

function paymentWords(state: string): string {
  switch (state) {
    case 'none':
      return 'No payment has been taken yet.';
    case 'held':
      return 'Your payment is held but not charged. It is captured only once the shop confirms the order.';
    case 'captured':
      return 'Your payment has been taken.';
    case 'released':
      return 'You were not charged. Any hold on your card has been released.';
    default:
      return 'We are confirming the payment state.';
  }
}
