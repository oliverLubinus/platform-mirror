// The wrapper runs Prisma against the payload's schema in place (db:* scripts
// use --schema template/server/prisma/schema.prisma). Env comes from
// template/.env - the same file every wrapper script reads via --env-file -
// NOT from a wrapper-root .env. Prisma 7 requires this config file for any
// DB-touching command (generate works without it; migrate does not).
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

dotenv.config({ path: "template/.env" });

export default defineConfig({
  schema: "template/server/prisma/schema.prisma",
  migrations: {
    path: "template/server/prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
