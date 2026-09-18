/**
 * Connectivity smoke test for the local Postgres container.
 *
 * Deliberately proves two things rather than one:
 *
 *   1. The client can reach the database at all.
 *   2. `SELECT ... FOR UPDATE SKIP LOCKED` actually executes on this server.
 *
 * The second is the whole reason this project targets Postgres rather than
 * SQLite: it is the primitive the outbox worker uses to claim work exactly once,
 * which is what stands between a double-click and a double-charge. If this query
 * ever stops working, the architecture's central guarantee is gone -- so it is
 * worth asserting early and cheaply rather than discovering it mid-dispatch.
 */
import { prisma } from '../src/db/client';

const tables = await prisma.$queryRaw<{ count: bigint }[]>`
  select count(*)::bigint as count
  from information_schema.tables
  where table_schema = 'public'
`;

const enums = await prisma.$queryRaw<{ count: bigint }[]>`
  select count(*)::bigint as count
  from pg_type
  where typtype = 'e'
`;

console.log('public tables:', tables[0]?.count?.toString() ?? '?');
console.log('enums        :', enums[0]?.count?.toString() ?? '?');

// Claimed inside a transaction, exactly as the outbox worker will.
const claimed = await prisma.$transaction(async (tx) => {
  return tx.$queryRaw<{ id: string }[]>`
    select id
    from "OutboxEvent"
    where status = 'pending' and "availableAt" <= now()
    order by "createdAt"
    limit 5
    for update skip locked
  `;
});

console.log('SKIP LOCKED  : ok (claimed', claimed.length, 'rows)');

const creators = await prisma.creator.count();
console.log('creators     :', creators);

await prisma.$disconnect();
console.log('\nDatabase stack is working.');
