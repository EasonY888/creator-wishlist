/**
 * Read-only snapshot of what the system currently thinks is going on.
 *
 * Deliberately does not write anything: the previous diagnostic ran a cleanup
 * that deleted queued poll tasks and stranded an in-flight order, which is the
 * last thing you want while watching an order settle.
 */
import { prisma } from '../src/db/client';

const orders = await prisma.fanOrder.findMany({
  orderBy: { createdAt: 'desc' },
  take: 5,
  include: {
    merchantOrder: true,
    creator: { select: { publicSlug: true } },
    paymentEvents: { orderBy: { createdAt: 'asc' } },
    orderEvents: { orderBy: { createdAt: 'asc' } },
  },
});

console.log('=== recent orders ===\n');

for (const order of orders) {
  console.log(`${order.creator.publicSlug}  state=${order.state}`);
  console.log(`  fan pays      : ${order.fanTotalMinor} ${order.currency}`);
  console.log(`  merchant cap  : ${order.merchantCapMinor}`);
  console.log(`  provider order: ${order.merchantOrder?.providerOrderId ?? '—'}`);
  console.log(`  provider stat : ${order.merchantOrder?.statusRaw ?? '—'}`);
  console.log(`  retryable     : ${String(order.merchantOrder?.retryable)}`);
  console.log(`  retry action  : ${order.merchantOrder?.retryAction ?? '—'}`);
  console.log(`  error code    : ${order.merchantOrder?.errorCode ?? '—'}`);
  console.log(`  decision      : ${order.merchantOrder?.action ?? '—'}`);
  console.log(`  polls         : ${order.merchantOrder?.pollCount ?? 0}`);
  console.log(`  ledger        : ${order.paymentEvents.map((e) => e.type).join(' -> ') || '(nothing)'}`);

  const evidence = order.merchantOrder?.evidence as Record<string, unknown> | null;
  if (evidence) console.log(`  charge state  : ${String(evidence.charge_state ?? '—')}`);

  const path = order.orderEvents
    .map((e) => `${e.toState ?? e.note ?? '?'}`)
    .join(' -> ');
  console.log(`  timeline      : ${path}`);
  console.log('');
}

const outbox = await prisma.outboxEvent.findMany({
  orderBy: { createdAt: 'asc' },
  select: {
    id: true,
    topic: true,
    status: true,
    attempts: true,
    availableAt: true,
    lastError: true,
  },
});

console.log('=== outbox ===');
if (outbox.length === 0) {
  console.log('(empty — nothing queued, so nothing will progress on its own)');
}
for (const task of outbox) {
  const due = task.availableAt.getTime() <= Date.now() ? 'due' : `due in ${Math.round((task.availableAt.getTime() - Date.now()) / 1000)}s`;
  console.log(
    `  ${task.topic.padEnd(26)} ${task.status.padEnd(11)} attempts=${task.attempts} ${due}${task.lastError ? `  err=${task.lastError}` : ''}`,
  );
}

await prisma.$disconnect();
