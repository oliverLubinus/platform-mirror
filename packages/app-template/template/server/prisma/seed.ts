/**
 * Synthetic-data seed (R-ENV-01). Dev/staging data is NEVER real user data.
 * Run: pnpm db:seed
 */
import { PrismaClient } from '@prisma/client';

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