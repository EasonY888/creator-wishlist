/**
 * The background worker.
 *
 * Runs as its own process, beside the web app, and shares the same database. It
 * is the only thing that calls the provider with money attached, which is why it
 * is separate from the request path: an HTTP request must never wait on a
 * sixty-second merchant checkout, and a crash in a request must not lose a
 * dispatch that was already claimed.
 *
 *   npm run worker
 */
import { runWorkerLoop } from '@/orders/worker';
import { workerDeps } from '@/services';

const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
const controller = new AbortController();

function stop(signal: string): void {
  console.log(`\n${signal} received - finishing the current task and stopping.`);
  controller.abort();
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

console.log(`worker "${workerId}" started`);

await runWorkerLoop(workerDeps(workerId), {
  intervalMs: 1000,
  batchSize: 10,
  signal: controller.signal,
  onDrain: (result) => {
    if (result.claimed === 0) return;

    for (const report of result.reports) {
      const marker =
        report.action === 'dead' ? 'DEAD ' : report.action === 'retried' ? 'retry' : 'ok   ';
      console.log(`  ${marker} ${report.topic} -> ${report.result}`);
    }
  },
});

console.log('worker stopped');
