import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createDatabase } from "./db/client.js";
import { runMigrations } from "./db/migrator.js";
import { createRedis } from "./infra/redis.js";

const env = loadEnv();
const { db, pool } = createDatabase(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);

await runMigrations(pool);
const app = await buildApp({ env, db, pool, redis });

// Graceful shutdown: stop accepting requests, finish in-flight ones, then
// release connections. Kubernetes sends SIGTERM before killing the pod.
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "Shutting down");
    await app.close();
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
