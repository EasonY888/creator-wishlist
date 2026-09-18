import { APPROVAL_REASONS } from '../agnic/types';
import { assertTransition } from '../domain/order-fsm';
import { resumeDispatch, type DispatcherDeps } from './dispatcher';
import { enqueue, OUTBOX_TOPICS, type OutboxEventRecord } from './outbox';

/**
 * Continuing an order that is waiting on a step-up approval.
 *
 * A `202` from dispatch is not a failure and not a success — it means the
 * purchase fell outside the signed spending policy and a person has to approve
 * it. There are three reasons, and they need three different responses:
 *
 *   - **security code refresh** — routine, recurs roughly hourly. Nothing was
 *     charged and nothing is broken. Re-enter the code at the approval URL, then
 *     dispatch the same saved request once with the token.
 *   - **mandate step-up** — resolved by the approval being granted.
 *   - **currency mismatch** — *never* resolves. The mandate is denominated in a
 *     different currency to the store, and the policy engine refuses to convert.
 *     Polling it would leave the order looking stuck rather than misconfigured.
 *
 * The distinction is the whole reason this file exists. One of these has an exit
 * condition and one does not.
 */

export interface ApprovalPayload {
  fanOrderId: string;
  token: string;
}

export type ApprovalOutcome =
  | { kind: 'resumed'; result: string }
  | { kind: 'still_pending' }
  | { kind: 'expired' }
  /** Waiting will never help. Needs a human, not another poll. */
  | { kind: 'permanent_fault'; reason: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'retryable_error'; code: string };

/**
 * The approval window closed without being granted.
 *
 * Nothing was charged — a `202` means the purchase was never placed — so the
 * fan's hold is released and the item has to be re-quoted. An approval is tied
 * to a specific total, so an expired one cannot simply be renewed.
 */
async function failExpiredApproval(
  deps: DispatcherDeps,
  fanOrderId: string,
  reason: string | null,
): Promise<void> {
  await deps.db.$transaction(async (tx) => {
    const current = await tx.fanOrder.findUnique({
      where: { id: fanOrderId },
      select: { state: true },
    });

    // Only an order still waiting on approval can fail this way. If something
    // else already moved it, leave it alone rather than overwriting an outcome.
    if (!current || current.state !== 'approval_required') return;

    assertTransition('approval_required', 'failed', { hasValidApprovalToken: false });

    await tx.fanOrder.update({
      where: { id: fanOrderId },
      data: { state: 'failed' },
    });

    await tx.orderEvent.create({
      data: {
        fanOrderId,
        fromState: 'approval_required',
        toState: 'failed',
        note: `approval window closed without being granted (${reason ?? 'unknown'}) \u2014 a fresh quote and a fresh approval are required`,
        actor: deps.workerId,
      },
    });

    await enqueue(tx, OUTBOX_TOPICS.RELEASE_HOLD, { fanOrderId });
  });
}

export async function runApprovalTask(
  deps: DispatcherDeps,
  task: OutboxEventRecord,
): Promise<ApprovalOutcome> {
  const payload = task.payload as ApprovalPayload | null;
  const fanOrderId = payload?.fanOrderId;
  const token = payload?.token;

  if (!fanOrderId || !token) {
    throw new Error(`Approval task ${task.id} is missing fanOrderId or token.`);
  }

  const window = await deps.db.approvalWindow.findUnique({ where: { token } });

  if (!window || window.fanOrderId !== fanOrderId) {
    return { kind: 'skipped', reason: 'no matching approval window' };
  }

  if (window.consumedAt) {
    return { kind: 'skipped', reason: 'approval already consumed' };
  }

  // Checked before the expiry test, because a currency fault does not expire —
  // it is a configuration problem, and no amount of waiting fixes it.
  if (window.reason === APPROVAL_REASONS.CURRENCY_MISMATCH) {
    return { kind: 'permanent_fault', reason: window.reason };
  }

  if (window.expiresAt.getTime() <= Date.now()) {
    await failExpiredApproval(deps, fanOrderId, window.reason);
    return { kind: 'expired' };
  }

  const approval = await deps.agnic.getApproval(token);

  switch (approval.state) {
    case 'approved': {
      const result = await resumeDispatch(deps, fanOrderId, token);
      return { kind: 'resumed', result: result.kind };
    }

    case 'pending': {
      // Poll — never re-dispatch to wait. One of the step-up paths mints a brand
      // new token on every dispatch call and does not report the pending one as
      // not-ready, so a loop that waits by dispatching again never terminates
      // and fills the approvals record with dead tokens.
      await enqueue(
        deps.db,
        OUTBOX_TOPICS.POLL_APPROVAL,
        { fanOrderId, token },
        { delaySeconds: 5 },
      );
      return { kind: 'still_pending' };
    }

    case 'expired': {
      await failExpiredApproval(deps, fanOrderId, window.reason);
      return { kind: 'expired' };
    }

    case 'transport_error':
      return { kind: 'retryable_error', code: approval.code };
  }
}
