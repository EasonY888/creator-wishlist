/**
 * One pass of the background worker, for hosts that cannot run a long-lived process.
 *
 * `npm run worker` is a loop: it claims a batch, processes it, sleeps a second, and
 * repeats. Serverless platforms have no room for that loop — but they do not need
 * one. Every call the worker makes is short: `POST /dispatch` starts a merchant
 * order, and the ~60s it takes to settle is spread across many separate status
 * polls, each a fast request. So the work is naturally resumable, and one pass per
 * tick is enough to move an order forward.
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

import { drainOnce } from '@/orders/worker';
import { workerDeps } from '@/services';

export const dynamic = 'force-dynamic';

/**
 * Deliberately below any platform default. `maxDuration` only ever raises a
 * limit; the batch is kept small so one tick cannot outrun the request budget and
 * leave a claim stranded mid-flight.
 */
export const maxDuration = 30;

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  return request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!authorised(request)) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  }

  try {
    const result = await drainOnce(workerDeps('cron'), { limit: 4 });

    return NextResponse.json({
      claimed: result.claimed,
      reports: result.reports.map((report) => ({
        topic: report.topic,
        action: report.action,
        result: report.result,
      })),
    });
  } catch (cause) {
    // A failed tick is not a failed order: the claim is durable, so the next tick
    // picks the work back up. Say so rather than returning a bare 500.
    return NextResponse.json(
      { error: 'tick_failed', detail: String(cause) },
      { status: 500 },
    );
  }
}
