/**
 * @file server/src/db.ts
 * @description
 *   Prisma client singleton on the PrismaPg DRIVER ADAPTER (Prisma 7 - the
 *   same drilled pattern as auth-provider: no Rust query engine, the
 *   connection string rides the adapter). The import is LAZY: unit tests
 *   must not require a generated client or a reachable database (the
 *   platform CI runs DB-free; integration tests against the compose
 *   Postgres come with the contract CI job, R-PKG-11).
 *   Generated client lives at src/generated/prisma (gitignored; regenerated
 *   by postinstall/build - the schema is at server/prisma/, non-default,
 *   so generation must be explicit).
 */
import type { PrismaClient } from './generated/prisma/client.js';

let client: PrismaClient | null = null;

export async function getPrisma(): Promise<PrismaClient> {
  if (client === null) {
    if (!process.env.DATABASE_URL) {
      throw new Error('CONFIG_INVALID: DATABASE_URL is required (Prisma adapter cannot start without it)');
    }
    const [{ PrismaClient }, { PrismaPg }] = await Promise.all([
      import('./generated/prisma/client.js'),
      import('@prisma/adapter-pg'),
    ]);
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    client = new PrismaClient({ adapter });
  }
  return client;
}