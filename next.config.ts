import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * Keep the database driver out of the bundler.
   *
   * The Prisma client talks to Postgres through a native driver adapter. Letting
   * the bundler try to trace and inline it produces confusing failures at
   * runtime rather than at build time, so it is resolved from node_modules
   * instead.
   */
  serverExternalPackages: ['@prisma/adapter-pg', 'pg'],
};

export default nextConfig;
