import type { Db } from '../db/types';

/**
 * Append to the payment ledger, exactly once per (order, event type).
 *
 * The ledger is append-only and is what makes "was I charged?" answerable in a
 * single query — the first question every fan asks, and the one an asynchronous
 * checkout is most likely to leave ambiguous.
 *
 * Idempotent by inspection rather than by constraint, because the caller may
 * legitimately retry after a crash. The processor's own idempotency key is the
 * real guard against moving money twice; this stops us recording it twice.
 */
export async function recordPaymentOnce(
  tx: Db,
  args: {
    fanOrderId: string;
    type: 'authorized' | 'captured' | 'released' | 'refunded';
    amountMinor: number;
    currency: string;
    providerRef: string;
  },
): Promise<boolean> {
  const existing = await tx.paymentEvent.findFirst({
    where: { fanOrderId: args.fanOrderId, type: args.type },
    select: { id: true },
  });

  if (existing) return false;

  await tx.paymentEvent.create({
    data: {
      fanOrderId: args.fanOrderId,
      type: args.type,
      amountMinor: args.amountMinor,
      currency: args.currency,
      providerRef: args.providerRef,
    },
  });

  return true;
}

/** Every ledger entry for an order, oldest first. */
export async function ledgerFor(tx: Db, fanOrderId: string) {
  return tx.paymentEvent.findMany({
    where: { fanOrderId },
    orderBy: { createdAt: 'asc' },
  });
}
