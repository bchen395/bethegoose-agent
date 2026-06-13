import { defineConfig } from "drizzle-kit";

// drizzle-kit doesn't auto-load .env.local; load it so DATABASE_URL is available
// for `db:push` / `db:generate`. (Node 20.12+/22 ships process.loadEnvFile.)
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local may be absent in CI; env may already be set.
}

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Migrations use the direct connection (the transaction pooler is unreliable
  // for DDL); fall back to DATABASE_URL if DIRECT_URL isn't set.
  dbCredentials: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL! },
});
