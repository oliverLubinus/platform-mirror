/**
 * @file server/src/db.ts
 * @description
 *   Prisma client singleton. The import is LAZY: unit tests must not require
 *   a generated client or a reachable database (the platform CI runs DB-free;
 *   integration tests against the compose Postgres come with the contract CI
 *   job, R-PKG-11). `@prisma/client` is type-only here.
 */
import type { PrismaClient } from '@prisma/client';

let client: PrismaClient | null = null;

export async function getPrisma(): Promise<PrismaClient> {
  if (client === null) {
    const mod = await import('@prisma/client');
    client = new mod.PrismaClient();
  }
  return client;
}