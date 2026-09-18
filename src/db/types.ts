import type { Prisma } from '../generated/prisma/client';

/**
 * Anything that can run queries: the process-wide client, or an
 * interactive-transaction client.
 *
 * `Prisma.TransactionClient` is `Omit<PrismaClient, ITXClientDenyList>`, so a
 * full client structurally satisfies it too. One parameter type therefore covers
 * both call styles, which is what lets a function be called standalone *or*
 * composed inside a caller's transaction — the property the outbox depends on.
 */
export type Db = Prisma.TransactionClient;
