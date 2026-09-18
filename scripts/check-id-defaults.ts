/**
 * Checks what Prisma's `@default(cuid())` actually generates.
 *
 * This matters beyond aesthetics: fan order ids are user-facing, and a request
 * for another fan's order must be rejected by an ownership check rather than by
 * the id being unguessable. But an id that leaks creation time and increments is
 * a weak second line of defence for a product whose whole premise is that one
 * party must never see another's data.
 */
import { prisma } from '../src/db/client';

const made: Array<{ id: string; createdAt: Date }> = [];

for (let i = 0; i < 4; i += 1) {
  made.push(
    await prisma.outboxEvent.create({
      data: { topic: 'probe', payload: {} },
      select: { id: true, createdAt: true },
    }),
  );
}

const ids = made.map((m) => m.id);
console.log('ids:');
for (const id of ids) console.log('  ', id, `(len ${id.length})`);

/** Longest prefix shared by every id. */
function sharedPrefix(values: string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0]!;
  for (const v of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < v.length && prefix[i] === v[i]) i += 1;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

const shared = sharedPrefix(ids);
console.log('\nshared prefix across all ids:', JSON.stringify(shared), `(${shared.length} chars)`);
console.log('sorted lexically same as sorted by creation?', ids.join() === [...ids].sort().join());
console.log(
  '\nverdict:',
  shared.length >= 5
    ? 'TIME-PREFIXED - ids created together are correlated and roughly sortable by time'
    : 'random - no shared structure',
);

await prisma.outboxEvent.deleteMany({ where: { topic: 'probe' } });
await prisma.$disconnect();
