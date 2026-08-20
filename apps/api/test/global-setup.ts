import pg from "pg";
import { runMigrations } from "../src/db/migrator.js";

/** Recreates the test schema once per run so every run starts from the real migrations. */
export async function setup(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL_TEST ?? "postgres://postgres:postgres@localhost:5432/wallet_test";
  const pool = new pg.Pool({ connectionString });
  try {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
