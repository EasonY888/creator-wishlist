import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * The single PrismaClient for the process.
 *
 * Prisma 7 has no Rust query engine, so the client is constructed with a driver
 * adapter rather than reading a connection string out of the schema. The
 * connection therefore has to be supplied here, which is also why it can be
 * swapped for a different provider without touching `schema.prisma`.
 */
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Start the database with `docker compose up -d --wait` ' +
      'and ensure a .env file exists in the project root.',
  );
}

const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });
