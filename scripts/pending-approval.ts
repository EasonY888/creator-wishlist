/**
 * Print any step-up the shop is currently waiting on, and how long is left.
 *
 * A dispatch can come back `cvv_refresh_required`: the shop will not finish the
 * purchase until the platform's own card is refreshed. The window is short
 * (about five minutes), and once it lapses the order fails and the fan's hold is
 * released — correct behaviour, and not what you want mid-rehearsal.
 *
 * The URL lives on the order's `ApprovalWindow` row, which is why the first time
 * this happened it took a hand-written SQL query to find. This says it out loud,
 * with a countdown, and exits non-zero when there is nothing waiting so it can be
 * used as a gate.
 *
 *   npx tsx scripts/pending-approval.ts
 */
import 'dotenv/config';

import { prisma } from '../src/db/client';

const open = await prisma.approvalWindow.findMany({
  where: { consumedAt: null, expiresAt: { gt: new Date() } },
  orderBy: { expiresAt: 'asc' },
  include: {
    fanOrder: {
      select: { id: true, state: true, fanTotalMinor: true, currency: true },
    },
  },
});

if (open.length === 0) {
  const lapsed = await prisma.approvalWindow.count({
    where: { consumedAt: null, expiresAt: { lte: new Date() } },
  });

  console.log('nothing waiting on a step-up right now.');
  if (lapsed > 0) {
    console.log(
      `${lapsed} window(s) have already lapsed — those orders will fail and their holds release.`,
    );
  }

  await prisma.$disconnect();
  process.exit(0);
}

console.log('');
console.log(`${open.length} step-up(s) waiting. The shop will not finish until these are done.`);
console.log('');

for (const window of open) {
  const seconds = Math.max(0, Math.round((window.expiresAt.getTime() - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  console.log(`  order     ${window.fanOrder.id}  (${window.fanOrder.state})`);
  console.log(`  reason    ${window.reason}`);
  console.log(
    `  fan pays  ${window.fanOrder.fanTotalMinor} ${window.fanOrder.currency}, held not charged`,
  );
  console.log(`  expires   in ${minutes}m ${String(rest).padStart(2, '0')}s`);
  console.log(`  do it at  ${window.approvalUrl}`);
  console.log('');
}

console.log('Complete it before the window lapses. The worker is polling, so the');
console.log('order resumes on its own once the shop reports the approval.');
console.log('Let it lapse and the order fails and the fan\'s hold is released.');
console.log('');

await prisma.$disconnect();
