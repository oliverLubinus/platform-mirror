// Prisma 7 removed automatic .env loading from the CLI: this config file is
// now the single place that wires DATABASE_URL for DB-touching commands
// (migrate/dev/studio). The schema keeps env("DATABASE_URL").
// Pattern mirrors auth-provider/backend/prisma.config.ts. `dotenv` is a
// devDependency (installed by the scaffold).
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "server/prisma/schema.prisma",
  migrations: {
    path: "server/prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
