/**
 * Synthetic-data seed (R-ENV-01). Dev/staging data is NEVER real user data.
 * Run: pnpm db:seed
 */
import { PrismaClient } from '@prisma/client';

// Fail FAST with guidance instead of a cryptic PrismaClientInitializationError
// deep inside the first query. The quality gate is DB-free BY DESIGN, so
// runtime misconfiguration never reaches it - this guard is the seed's own
// gate (the typecheck catches compile-level drift, e.g. renamed models).
if (!process.env.DATABASE_URL) {
  console.error(
    'db:seed: DATABASE_URL is not set.\n' +
      '  1. cp .env.example .env\n' +
      '  2. pnpm db:up        (docker compose)\n' +
      '  3. pnpm db:migrate   (creates the schema)\n' +
      '  4. pnpm db:seed'
  );
  process.exit(1);
}

const prisma = new PrismaClient();

await prisma.note.deleteMany();
await prisma.note.createMany({
  data: [
    { title: 'Welcome', body: 'This note came from the synthetic seed (R-ENV-01).' },
    { title: 'Conventions', body: 'Migrations are the only path to a schema change — see schema.prisma.' },
    { title: 'Replace me', body: 'Delete this demo model with your first real migration.' },
  ],
});
console.log(`seeded ${await prisma.note.count()} notes`);
await prisma.$disconnect();