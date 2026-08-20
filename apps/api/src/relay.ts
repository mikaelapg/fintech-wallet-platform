import pino from "pino";
import { loadEnv } from "./config/env.js";
import { createDatabase } from "./db/client.js";
import { createRabbitPublisher } from "./infra/broker.js";
import { OutboxRelay } from "./modules/outbox/outbox-relay.js";

const env = loadEnv();
const logger = pino({ level: env.LOG_LEVEL, name: "outbox-relay" });
const { db, pool } = createDatabase(env.DATABASE_URL);
const publisher = await createRabbitPublisher(env.RABBITMQ_URL);
const relay = new OutboxRelay(db, publisher, logger);

const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "Stopping outbox relay");
    controller.abort();
  });
}

logger.info("Outbox relay started");
await relay.run(controller.signal);
await Promise.allSettled([publisher.close(), pool.end()]);
