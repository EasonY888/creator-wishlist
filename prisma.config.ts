import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved database connection configuration out of `schema.prisma`.
 *
 * The schema no longer accepts a `url`, so the CLI reads the connection from
 * here instead, and the runtime client takes a driver adapter. That split is
 * deliberate on Prisma's side: it keeps credentials out of a file that is
 * commonly committed.
 *
 * This file is only read by the Prisma CLI (`db push`, `migrate`, `studio`).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // Read via `process.env` rather than Prisma's `env()` helper on purpose.
    // Every Prisma CLI command loads this file, including `prisma generate`,
    // which needs no database at all -- and `env()` throws when the variable is
    // missing. Using process.env keeps `generate` working in CI and on a fresh
    // clone where no `.env` exists yet.
    url: process.env.DATABASE_URL ?? '',
  },
});
