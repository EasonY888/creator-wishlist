import Link from 'next/link';
import { notFound } from 'next/navigation';
import { startPayment } from '@/app/checkout/actions';
import { prisma } from '@/db/client';
import { durationWords, formatMoney, relativeTime } from '@/presentation/money';

export const dynamic = 'force-dynamic';

/**
 * The approval screen — the strongest consent step in the product.
 *
 * Two rules shape it, both from the design plan:
 *
 *   1. If the quote is a ceiling rather than a final figure, say so. Presenting a
 *      ceiling as a total is showing the fan a number we cannot stand behind.
 *   2. The fan pay is OUR total, including our fee. The merchant's figure is
 *      never the price shown.
 */
export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ fanOrderId: string }>;
  searchParams: Promise<{ note?: string }>;
}) {
  const { fanOrderId } = await params;
  const { note } = await searchParams;

  const order = await prisma.fanOrder.findUnique({
    where: { id: fanOrderId },
    include: {
      quote: true,
      creator: true,
      approvedRequest: true,
      merchantOrder: true,
    },
  });

  if (!order) notFound();

  // `approved` is not a dead end: it means the fan agreed and the card step is
  // open, which is exactly where a reload should return them. Anything past
  // that has money behind it and belongs on the status page.
  const awaitingCard = order.state === 'approved';
  const alreadyStarted = order.state !== 'draft' && !awaitingCard;
  const final = formatMoney(order.fanTotalMinor, order.currency);
  const amountIsFinal = order.quote?.amountIsFinal ?? false;

  /**
   * Read from the quote, not from the configured TTL. Those are the same number
   * for anything the app priced itself, but printing a constant here would state
   * a figure the row does not actually carry -- on the one screen whose entire
   * purpose is not doing that.
   */
  const remainingSeconds = order.quote?.expiresAt
    ? Math.round((order.quote.expiresAt.getTime() - Date.now()) / 1000)
    : null;

  return (
    <main>
      <p className="small">
        <Link href={`/w/${order.creator.publicSlug}`}>&larr; Back to the wishlist</Link>
      </p>

      <div className="hero">
        <h1>Review your gift</h1>
      </div>

      {note ? (
        <div className="notice notice-warn" style={{ marginBottom: '1.5rem' }}>
          {note}
        </div>
      ) : null}

      <div className="card">
        <div className="row">
          <div>
            <strong className="title-lg">{order.creator.displayName}</strong>
            <div className="muted small">receives this gift</div>
          </div>
          <span className="badge">Not yet paid</span>
        </div>
      </div>

      {/*
        The single riskiest number on the site. When the quote isn't final,
        the figure is styled in --warn rather than plain text and the
        "maximum, not a total" notice is glued directly under it — the same
        colour on the number and the caveat, so the two read as one claim.
        No new words, no symbol standing in for a word: just colour, weight
        and adjacency doing the work.
      */}
      <div className="card">
        <table>
          <tbody>
            <tr>
              <td>Item and delivery</td>
              <td className="money" style={{ textAlign: 'right' }}>
                {formatMoney(order.merchantCapMinor, order.currency)}
              </td>
            </tr>
            <tr>
              <td>Platform service fee</td>
              <td className="money" style={{ textAlign: 'right' }}>
                {formatMoney(order.markupMinor, order.currency)}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="row" style={{ marginTop: '1.25rem' }}>
          <strong>You pay</strong>
          <span
            className={`total total-lg money${amountIsFinal ? '' : ' total-ceiling'}`}
          >
            {final}
          </span>
        </div>

        {amountIsFinal ? null : (
          <div className="notice notice-warn" style={{ marginTop: '0.85rem' }}>
            <strong>This is a maximum, not an exact total.</strong> This shop adds
            tax at its own checkout. If it comes in lower than its estimate &mdash;
            which it often does &mdash; you are charged less and keep the
            difference. Never more, because we cap it at the amount you approve.
          </div>
        )}
      </div>

      {/* Trust moment, stated plainly where the fan is about to spend money. */}
      <div className="notice notice-info">
        Ships to {order.creator.displayName}. Their address is never shown to you,
        is not on your receipt, and is never included in anything you receive.
      </div>

      <div className="small muted" style={{ marginTop: '0.85rem' }}>
        Quoted {relativeTime(order.quote?.createdAt)}
        {remainingSeconds === null
          ? null
          : remainingSeconds > 0
            ? ` · this price holds for another ${durationWords(remainingSeconds)}`
            : ' · this price is past its window and will need re-quoting'}
      </div>

      {alreadyStarted ? (
        <div className="notice notice-warn" style={{ marginTop: '1.5rem' }}>
          This order has already been approved. <Link href={`/orders/${order.id}`}>View its status</Link>.
        </div>
      ) : awaitingCard ? (
        <div style={{ marginTop: '1.5rem' }}>
          <Link className="button primary" href={`/checkout/${order.id}/pay`}>
            Continue to payment &mdash; {final}
          </Link>
          <p className="muted small" style={{ marginTop: '0.85rem' }}>
            You have already approved this total. Nothing has been charged, and
            nothing will be until the shop confirms the order.
          </p>
        </div>
      ) : (
        <form action={startPayment} style={{ marginTop: '1.5rem' }}>
          <input type="hidden" name="fanOrderId" value={order.id} />

          <div className="field">
            <label htmlFor="confirmation">
              Type anything to record your approval (this is saved as evidence of
              what you agreed to)
            </label>
            <input
              id="confirmation"
              name="confirmation"
              defaultValue="Yes, send this gift"
              autoComplete="off"
            />
          </div>

          <button className="primary" type="submit">
            Continue to payment &mdash; {final}
          </button>

          <p className="muted small" style={{ marginTop: '0.85rem' }}>
            Next you enter your card. That places a hold for {final}; you are
            charged only once the shop confirms the order. If it cannot be
            completed, the hold is released and you are not charged.
          </p>
        </form>
      )}
    </main>
  );
}
