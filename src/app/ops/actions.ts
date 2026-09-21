'use server';

import { redirect } from 'next/navigation';

import { recordRefund, resolveOrder, type OperatorOutcome, type ResolutionOutcome } from '@/orders/operator';
import { runWorkerLoop } from '@/orders/worker';
import { requireOperator } from '@/ops/server';
import { services, workerDeps } from '@/services';

/**
 * Operator actions.
 *
 * Both of these move money, so both call `requireOperator()` as their first
 * statement. That is not belt-and-braces: a server action is addressable by its
 * own id, so a crafted POST can invoke one without ever rendering the page that
 * guards it. The page-level redirect protects the rendering, and these calls
 * protect the money.
 *
 * The actor is still a constant. A shared password proves *that* someone is an
 * operator, never *which* operator, so attributing an action to a person still
 * needs real accounts. Recorded here so the constant is not mistaken for a
 * finished identity story.
 */
const OPERATOR_ACTOR = 'operator';

function field(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

/** Turn an outcome into something an operator can read and act on. */
function reasonFor(result: OperatorOutcome): string {
  switch (result.state) {
    case 'recorded':
      return 'Refund recorded.';
    case 'order_not_found':
      return 'That order no longer exists.';
    case 'already_refunded':
      return 'This order has already been refunded.';
    case 'not_refundable':
      return `An order in state "${result.currentState}" cannot be refunded.`;
    case 'invalid_reference':
      return result.reason;
    case 'nothing_to_refund':
      return result.reason;
    case 'rail_failed':
      return `The payment rail refused the refund (${result.code}). Nothing was changed.`;
  }
}

export async function refundOrder(form: FormData): Promise<void> {
  await requireOperator();

  const fanOrderId = field(form, 'fanOrderId');
  const reference = field(form, 'reference');
  const note = field(form, 'note');

  const { db, payments } = services();

  const result = await recordRefund(
    { db, payments },
    {
      fanOrderId,
      reference,
      actor: OPERATOR_ACTOR,
      ...(note.length === 0 ? {} : { note }),
    },
  );

  const flag = result.state === 'recorded' ? 'note' : 'problem';
  redirect(`/ops?${flag}=${encodeURIComponent(reasonFor(result))}&order=${encodeURIComponent(fanOrderId)}`);
}

/** Turn a resolution outcome into something an operator can read. */
function resolutionReason(result: ResolutionOutcome): string {
  switch (result.state) {
    case 'resolved':
      return result.decision === 'succeeded'
        ? `Confirmed. The fan was charged ${result.amountMinor} (minor units).`
        : 'Marked as never completed. The hold has been released.';
    case 'order_not_found':
      return 'That order no longer exists.';
    case 'not_resolvable':
      return result.reason;
    case 'invalid_reference':
      return result.reason;
    case 'amount_required':
      return result.reason;
    case 'amount_invalid':
      return result.reason;
    case 'refused':
      return `Refused (${result.code}). ${result.reason} Nothing was changed.`;
  }
}

/**
 * Declare the outcome of an order nothing could resolve automatically.
 *
 * The amount is entered in the units the operator sees on the merchant's page
 * (dollars), and converted to minor units here, because asking a person to type
 * "1599" for $15.99 is how a misplaced decimal becomes a real charge.
 */
export async function resolveStuckOrder(form: FormData): Promise<void> {
  await requireOperator();

  const fanOrderId = field(form, 'fanOrderId');

  // An explicit decision or nothing.
  //
  // This used to fall through to `failed` when the field was absent, which made
  // a missing field indistinguishable from a deliberate release -- and one way
  // to lose the field is a React quirk that overrides a submit button's `name`,
  // so the default was reachable by clicking "charge". A money decision is never
  // a safe default, so an unrecognised value now refuses the whole operation.
  const decisionRaw = field(form, 'decision');
  if (decisionRaw !== 'succeeded' && decisionRaw !== 'failed') {
    redirect(
      `/ops?problem=${encodeURIComponent('Missing or unrecognised decision. Nothing was changed.')}&order=${encodeURIComponent(fanOrderId)}`,
    );
  }
  const decision = decisionRaw;

  const reference = field(form, 'reference');
  const note = field(form, 'note');
  const amountRaw = field(form, 'merchantCharged');

  // A success needs the merchant's figure; a failure does not.
  let merchantChargedMinor: number | null = null;
  if (decision === 'succeeded' && amountRaw.length > 0) {
    const major = Number(amountRaw);
    merchantChargedMinor = Number.isFinite(major) && major >= 0 ? Math.round(major * 100) : null;
  }

  const { db, payments } = services();

  const result = await resolveOrder(
    { db, payments },
    {
      fanOrderId,
      decision,
      reference,
      merchantChargedMinor,
      actor: OPERATOR_ACTOR,
      ...(note.length === 0 ? {} : { note }),
    },
  );

  const flag = result.state === 'resolved' ? 'note' : 'problem';
  redirect(
    `/ops?${flag}=${encodeURIComponent(resolutionReason(result))}&order=${encodeURIComponent(fanOrderId)}`,
  );
}

/**
 * Run one bounded pass of the worker now, on the operator's click.
 *
 * The queue names problems; this is how an operator advances them without
 * waiting for the next scheduled tick. A short budget keeps the click snappy —
 * the work is resumable, so whatever this pass does not finish, the next tick
 * (scheduled, or another click) picks up.
 */
export async function pollNow(): Promise<void> {
  await requireOperator();

  await runWorkerLoop(workerDeps('operator-click'), {
    batchSize: 4,
    budgetMs: 3_000,
  });

  redirect('/ops?note=Worker pass complete.');
}
