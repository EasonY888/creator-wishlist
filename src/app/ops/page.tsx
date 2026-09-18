import Link from 'next/link';
import { prisma } from '@/db/client';
import { toProviderOrder } from '@/agnic/port';
import type { FanOrderState } from '@/domain/order-fsm';
import { durationWords, formatMoney } from '@/presentation/money';
import { operatorOrderView, type OperatorOrderView } from '@/presentation/operator-view';
import { requireOperator } from '@/ops/server';
import { signOut } from './login/actions';
import RefundForm from './RefundForm';
import ResolveForm from './ResolveForm';

export const dynamic = 'force-dynamic';

/** States with an edge to `refunded`. Mirrors the guard list in `orders/operator.ts`. */
const REFUNDABLE_STATES = new Set<string>(['succeeded', 'partially_fulfilled', 'failed']);

/**
 * States an operator may declare an outcome for.
 *
 * Deliberately the two the machine has stopped on: `processing` (where a handoff
 * polls forever) and `uncertain` (where reconciliation could not decide).
 * Everything else is either still moving or already settled, and neither is the
 * operator's to call.
 */
const RESOLVABLE_STATES = new Set<string>(['processing', 'uncertain']);

/**
 * Whether an order can be refunded, and if not, what is stopping it.
 *
 * Returned as a reason rather than a boolean because "why can't I refund this?"
 * is the operator's actual question. An order with no captured payment is the
 * one worth naming: money may still be held, and that is a release, not a
 * refund -- two different operations that are easy to conflate.
 */
function refundability(
  view: OperatorOrderView,
): { ok: true } | { ok: false; reason: string } {
  if (view.money.ledger.some((entry) => entry.type === 'refunded')) {
    return { ok: false, reason: 'already refunded' };
  }
  if (!REFUNDABLE_STATES.has(view.state)) {
    return { ok: false, reason: 'not refundable in this state' };
  }
  if (!view.money.ledger.some((entry) => entry.type === 'captured')) {
    return { ok: false, reason: 'nothing captured — release the hold instead' };
  }
  return { ok: true };
}

/** The refund control, or the reason there isn't one. */
function RefundCell({ view }: { view: OperatorOrderView }) {
  const status = refundability(view);

  if (!status.ok) {
    return <span className="muted small">{status.reason}</span>;
  }

  return (
    <RefundForm
      fanOrderId={view.orderId}
      amountLabel={formatMoney(view.money.fanTotalMinor, view.money.currency)}
    />
  );
}

/**
 * The operator queue.
 *
 * One page, three filters. The important column is `attentionReason`: it is
 * derived from the same decision logic the reconciler uses, so an order that is
 * surfaced here is one the machine has already concluded needs a person — not one
 * that merely looks old.
 *
 * Address-bearing fields (evidence, live view URL) are withheld unless
 * `canViewSensitiveData` is passed. They stay withheld even now that sign-in
 * exists, because a shared operator password proves only that the caller is an
 * operator -- not that this particular person should see a fan's address. The
 * redaction is the default; turning it on should be a per-person decision that
 * does not exist yet.
 */
export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string; problem?: string; order?: string }>;
}) {
  await requireOperator();

  const { note, problem, order: flaggedOrder } = await searchParams;

  const orders = await prisma.fanOrder.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      creator: { select: { id: true, displayName: true, publicSlug: true } },
      merchantOrder: true,
      approvedRequest: true,
      paymentEvents: { orderBy: { createdAt: 'asc' } },
      orderEvents: { orderBy: { createdAt: 'asc' } },
    },
  });

  const views = orders.map((order) =>
    operatorOrderView({
      orderId: order.id,
      fanId: order.fanId,
      creator: order.creator,
      state: order.state as FanOrderState,
      fanTotalMinor: order.fanTotalMinor,
      markupMinor: order.markupMinor,
      merchantCapMinor: order.merchantCapMinor,
      currency: order.currency,
      createdAt: order.createdAt,
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
      merchantOrder: order.merchantOrder
        ? {
            providerOrderId: order.merchantOrder.providerOrderId,
            statusRaw: order.merchantOrder.statusRaw,
            retryable: order.merchantOrder.retryable,
            retryAction: order.merchantOrder.retryAction,
            action: order.merchantOrder.action,
            amountApprovedMinor: order.merchantOrder.amountApprovedMinor,
            amountChargedMinor: order.merchantOrder.amountChargedMinor,
            pollCount: order.merchantOrder.pollCount,
            lastPolledAt: order.merchantOrder.lastPolledAt,
            dispatchClaimedAt: order.merchantOrder.dispatchClaimedAt,
            dispatchedAt: order.merchantOrder.dispatchedAt,
            evidence: order.merchantOrder.evidence,
          }
        : null,
      approvedRequest: order.approvedRequest
        ? {
            merchantId: order.approvedRequest.merchantId,
            amountMinor: order.approvedRequest.amountMinor,
            requestDigest: order.approvedRequest.requestDigest,
            shipToDigest: order.approvedRequest.shipToDigest,
            fanApprovalText: order.approvedRequest.fanApprovalText,
            fanApprovedAtIso: order.approvedRequest.fanApprovedAtIso,
          }
        : null,
      ledger: order.paymentEvents.map((event) => ({
        type: event.type,
        amountMinor: event.amountMinor,
        providerRef: event.providerRef,
        at: event.createdAt.toISOString(),
      })),
      timeline: order.orderEvents.map((event) => ({
        at: event.createdAt.toISOString(),
        fromState: event.fromState,
        toState: event.toState,
        action: event.action,
        rawStatus: event.rawStatus,
        note: event.note,
        actor: event.actor,
      })),
      // No auth yet, so sensitive fields stay redacted by default.
    }),
  );

  const needing = views.filter((view) => view.attentionReason !== null);
  const rest = views.filter((view) => view.attentionReason === null);

  return (
    <main>
      <p className="small">
        <Link href="/">&larr; Home</Link>
      </p>

      <div className="hero">
        <div className="row">
          <h1>Order queue</h1>
          <form action={signOut}>
            <button type="submit">Sign out</button>
          </form>
        </div>
        <p className="small">
          <Link href="/ops/evidence">What the product does not show you &rarr;</Link>
        </p>
        <p className="muted small">
          {views.length} order{views.length === 1 ? '' : 's'} ·{' '}
          {needing.length} needing attention
        </p>
      </div>

      {problem ? (
        <div className="notice notice-warn">
          <strong>Refund not recorded.</strong> {problem}
          {flaggedOrder ? (
            <>
              {' '}
              <span className="muted small">order {flaggedOrder}</span>
            </>
          ) : null}
        </div>
      ) : null}

      {note ? (
        <div className="notice notice-info">
          {note}
          {flaggedOrder ? (
            <>
              {' '}
              <span className="muted small">order {flaggedOrder}</span>
            </>
          ) : null}
        </div>
      ) : null}

      <h2>Needs attention</h2>
      {needing.length === 0 ? (
        <div className="empty">Nothing needs a person right now.</div>
      ) : (
        <div className="stack">
          {needing.map((view) => (
            <div key={view.orderId} className="card">
              <div className="row">
                <div>
                  <strong>{view.creator.displayName}</strong>{' '}
                  <span className="muted small">
                    {formatMoney(view.money.fanTotalMinor, view.money.currency)}
                  </span>
                </div>
                <span className="badge badge-warn">{view.state}</span>
              </div>

              <div className="notice notice-warn" style={{ marginTop: '0.85rem' }}>
                {view.attentionReason}
              </div>

              <div className="muted small mono" style={{ marginTop: '0.75rem' }}>
                provider: <code>{view.provider?.statusRaw ?? '—'}</code> · action:{' '}
                <code>{view.provider?.action ?? '—'}</code> · retryable:{' '}
                <code>{view.provider?.retryable === null ? 'null (unknown)' : String(view.provider?.retryable)}</code> · polls:{' '}
                {view.provider?.pollCount ?? 0} · age {durationWords(view.ageSeconds)}
              </div>

              <div className="small" style={{ marginTop: '0.6rem' }}>
                <strong>Next:</strong> {view.recommendedAction}
              </div>

              <div className="muted small mono">
                ship_to digest <code>{view.approval?.shipToDigest.slice(0, 12)}…</code> ·
                address data {view.sensitiveDataRedacted ? 'redacted' : 'visible'}
              </div>

              {/* The actions an operator can actually take. Without these the
                  queue names problems and offers no way to resolve them. */}
              <div style={{ marginTop: '0.85rem' }}>
                <RefundCell view={view} />
              </div>

              {RESOLVABLE_STATES.has(view.state) ? (
                <div style={{ marginTop: '0.85rem' }}>
                  <ResolveForm
                    fanOrderId={view.orderId}
                    approvedLabel={formatMoney(view.money.fanTotalMinor, view.money.currency)}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <h2>Recent</h2>
      {rest.length === 0 ? (
        <div className="empty">No settled orders yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Creator</th>
              <th>State</th>
              <th>Provider</th>
              <th style={{ textAlign: 'right' }}>Fan paid</th>
              <th style={{ textAlign: 'right' }}>Merchant</th>
              <th>Refund</th>
            </tr>
          </thead>
          <tbody>
            {rest.slice(0, 30).map((view) => (
              <tr key={view.orderId}>
                <td>{view.creator.displayName}</td>
                <td>
                  <code>{view.state}</code>
                </td>
                <td>
                  <code>{view.provider?.statusRaw ?? '—'}</code>
                </td>
                <td className="money" style={{ textAlign: 'right' }}>
                  {formatMoney(view.money.fanTotalMinor, view.money.currency)}
                </td>
                <td className="money" style={{ textAlign: 'right' }}>
                  {formatMoney(view.money.merchantCapMinor, view.money.currency)}
                </td>
                <td>
                  <RefundCell view={view} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
