import { Fragment } from 'react';
import Link from 'next/link';
import { prisma } from '@/db/client';
import { toProviderOrder } from '@/agnic/port';
import type { FanOrderState } from '@/domain/order-fsm';
import { durationWords, formatMoney } from '@/presentation/money';
import { operatorOrderView, type OperatorOrderView } from '@/presentation/operator-view';
import { requireOperator } from '@/ops/server';
import { signOut } from './login/actions';
import { pollNow } from './actions';
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
 * The provider's own account of placing the order.
 *
 * Everything else on this page is our record of our own actions. This is the
 * only part that is not — the shop's own total, whether it charged less than it
 * quoted, whether the delivery address survived the shop's checkout form, and
 * the stages of a screenshot run the provider made of that checkout. It is the
 * difference between "we say the order was placed" and "here is the account of
 * the party that placed it".
 *
 * Stages only, never the images: the frames show the shop's checkout with the
 * delivery address on it, which is why the whole bundle is operator-only.
 */
function providerAccount(view: OperatorOrderView): string | null {
  const evidence = view.providerEvidence;
  if (evidence === null) return null;

  const parts: string[] = [];

  if (evidence.observedTotalMinor !== null) {
    parts.push(`shop's own total ${formatMoney(evidence.observedTotalMinor, view.money.currency)}`);
  }

  if (evidence.priceDriftMinor !== null && evidence.priceDriftMinor !== 0) {
    // Signed explicitly: "1.95 under" and "1.95 over" are opposite facts and the
    // whole product turns on which one happened.
    const direction = evidence.priceDriftMinor < 0 ? 'under' : 'over';
    parts.push(`${formatMoney(Math.abs(evidence.priceDriftMinor), view.money.currency)} ${direction}`);
  }

  if (evidence.shipToVerified !== null) {
    parts.push(evidence.shipToVerified ? 'ship-to verified' : 'ship-to NOT verified');
  }

  if (evidence.chargeState !== null) parts.push(`charge ${evidence.chargeState}`);
  if (evidence.stockStatus !== null) parts.push(`stock ${evidence.stockStatus}`);
  if (evidence.billingMode !== null) parts.push(`billing ${evidence.billingMode}`);
  if (evidence.vgsRequestId !== null) parts.push(`vault ${evidence.vgsRequestId.slice(0, 8)}…`);

  if (evidence.screenshotStages.length > 0) {
    parts.push(
      `${evidence.screenshotStages.length} checkout screenshots (${evidence.screenshotStages.join(' → ')})`,
    );
  }

  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * What a step-up means, in the words of the next thing to do about it.
 *
 * The three reasons look alike and are not: one resolves by confirming a code,
 * one needs a passkey, and one never resolves at all until the spending mandate
 * is reissued in the shop's currency. An operator who treats the last as the
 * first will confirm codes until the window closes.
 */
function stepUpSentence(reason: string | null): string {
  switch (reason) {
    case 'cvv_refresh_required':
      return "The vault holds the platform card's security code for about fifty minutes and no longer, so the shop is asking for it again. Nothing was charged. Any three digits will do — the order resumes on its own.";
    case 'approval_not_ready':
      return 'This falls outside the signed mandate and needs a passkey approval before the shop will proceed.';
    case 'currency_mismatch':
      return 'The spending mandate is not in the shop’s currency. Confirming will not help — retrying never succeeds and the mandate has to be reissued.';
    default:
      return 'The shop is waiting on an approval before it will finish the order.';
  }
}

/**
 * How long the link stays usable.
 *
 * Short — minutes, not hours — which is the whole reason this is worth showing
 * rather than merely recording. A countdown that has already run out says so
 * instead of inviting a click that cannot work.
 */
function stepUpTimeLeft(expiresAtIso: string): string {
  const seconds = Math.round((new Date(expiresAtIso).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return 'this window has lapsed; a fresh dispatch opens a new one';

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${String(rest).padStart(2, '0')}s left` : `${rest}s left`;
}

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
      // The step-up the shop is waiting on, if there is one.
      //
      // Reached until now only by running `scripts/pending-approval.ts` against
      // the database, which meant a deployed instance had no way to tell a
      // person where to confirm the platform's card -- the step-up was visible
      // as a state and invisible as an action.
      approvalWindows: {
        where: { consumedAt: null },
        orderBy: { expiresAt: 'asc' },
        take: 1,
      },
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
      approvalReason: order.approvalWindows[0]?.reason ?? null,
      stepUp: order.approvalWindows[0] ?? null,
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
          <div className="row" style={{ gap: '0.5rem' }}>
            <form action={pollNow}>
              <button type="submit" title="Run one pass of the worker now">
                Poll now
              </button>
            </form>
            <form action={signOut}>
              <button type="submit">Sign out</button>
            </form>
          </div>
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

              {/* A step-up is the one thing on this page a person has to go
                  somewhere else to do. Naming it without the link is what made
                  a deployed order un-resumable by anyone at the keyboard. */}
              {view.stepUp === null ? null : (
                <div className="small" style={{ marginTop: '0.6rem' }}>
                  <strong>Waiting on a step-up.</strong> {stepUpSentence(view.stepUp.reason)}{' '}
                  <a href={view.stepUp.approvalUrl} target="_blank" rel="noreferrer">
                    Open the confirmation page
                  </a>{' '}
                  <span className="muted">— {stepUpTimeLeft(view.stepUp.expiresAtIso)}</span>
                </div>
              )}

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
            {rest.slice(0, 30).map((view) => {
              const account = providerAccount(view);

              return (
                <Fragment key={view.orderId}>
                  <tr>
                    <td>{view.creator.displayName}</td>
                    <td>
                      <code>{view.state}</code>
                    </td>
                    <td>
                      <code>{view.provider?.statusRaw ?? '—'}</code>
                    </td>
                    <td className="money" style={{ textAlign: 'right' }}>
                      {formatMoney(
                        view.money.capturedMinor ?? view.money.fanTotalMinor,
                        view.money.currency,
                      )}
                      {view.money.capturedMinor === null ? (
                        <span className="muted small"> held</span>
                      ) : null}
                    </td>
                    <td className="money" style={{ textAlign: 'right' }}>
                      {formatMoney(
                        view.money.chargedMinor ?? view.money.merchantCapMinor,
                        view.money.currency,
                      )}
                      {view.money.chargedMinor === null ? (
                        <span className="muted small"> cap</span>
                      ) : null}
                    </td>
                    <td>
                      <RefundCell view={view} />
                    </td>
                  </tr>
                  {account === null ? null : (
                    <tr>
                      <td colSpan={6} className="muted small" style={{ paddingTop: 0 }}>
                        <strong>provider:</strong> {account}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
