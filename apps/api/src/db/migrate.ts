import { loadEnv } from "../config/env.js";
import { createDatabase } from "./client.js";
import { runMigrations } from "./migrator.js";

const env = loadEnv();
const { pool } = createDatabase(env.DATABASE_URL);

try {
  const applied = await runMigrations(pool);
  process.stdout.write(
    applied.length ? `Applied: ${applied.join(", ")}\n` : "Database is up to date\n",
  );
} finally {
  await pool.end();
}
