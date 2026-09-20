/**
 * One pass of the background worker, for hosts that cannot run a long-lived process.
 *
 * `npm run worker` is a loop: it claims a batch, processes it, sleeps a second, and
 * repeats. Serverless platforms have no room for that loop — but they do not need
 * one. Every call the worker makes is short: `POST /dispatch` starts a merchant
 * order, and the ~60s it takes to settle is spread across many separate status
 * polls, each a fast request. So the work is naturally resumable: a tick that
 * stops early loses nothing, and the next one carries on from where it stopped.
 *
 * This matters because the worker is the only thing that calls the provider with
 * money attached. Without it a deployed instance can browse and quote, but a fan
 * who taps "Send this gift" leaves an order sitting at `authorized` forever, held
 * but never placed.
 *
 * Closed when the secret is unset, which is the same rule the operator queue
 * follows: a missing credential means closed, not open. The endpoint spends money
 * and must not be callable by anyone who guesses the path.
 *
 *   GET /api/worker/tick
 *   Authorization: Bearer $CRON_SECRET
 */
import { NextResponse } from 'next/server';

import { runWorkerLoop, type DrainResult } from '@/orders/worker';
import { workerDeps } from '@/services';

export const dynamic = 'force-dynamic';

/**
 * Deliberately below any platform default. `maxDuration` only ever raises a
 * limit; the batch is kept small so one tick cannot outrun the request budget and
 * leave a claim stranded mid-flight.
 */
export const maxDuration = 30;

/**
 * How long one tick may work for.
 *
 * Under `maxDuration`, so the response is never the thing that runs out of time.
 * A single pass would be almost useless on a scheduler: `drainOnce` claims only
 * what is due now, and a settlement re-queues each status poll a few seconds out,
 * so one pass advances one step of a twenty-step wait. A budget lets the tick
 * cover several steps per call, which is the difference between an order settling
 * in minutes and in hours.
 */
const TICK_BUDGET_MS = 25_000;

/** Per pass, not per tick. Small for the same reason as `maxDuration`. */
const TICK_BATCH = 4;

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  return request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!authorised(request)) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  }

  const drains: DrainResult[] = [];
  const claimedTotal = (): number =>
    drains.reduce((total, drain) => total + drain.claimed, 0);

  try {
    await runWorkerLoop(workerDeps('cron'), {
      batchSize: TICK_BATCH,
      budgetMs: TICK_BUDGET_MS,
      onDrain: (result) => drains.push(result),
    });
  } catch (cause) {
    // A failed tick is not a failed order: the claim is durable, so the next tick
    // picks the work back up. Say so rather than returning a bare 500.
    return NextResponse.json(
      { error: 'tick_failed', detail: String(cause), passes: drains.length, claimed: claimedTotal() },
      { status: 500 },
    );
  }

  return NextResponse.json({
    passes: drains.length,
    claimed: claimedTotal(),
    reports: drains.flatMap((drain) =>
      drain.reports.map((report) => ({
        topic: report.topic,
        action: report.action,
        result: report.result,
      })),
    ),
  });
}
