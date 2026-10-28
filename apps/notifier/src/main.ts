import amqp, { type ConsumeMessage } from "amqplib";
import { Redis } from "ioredis";
import pino from "pino";
import { z } from "zod";
import { handleMessage, type NotificationChannel, PermanentError, type ProcessedEventStore } from "./handler.js";

const env = z
  .object({
    RABBITMQ_URL: z.url().default("amqp://guest:guest@localhost:5672"),
    REDIS_URL: z.url().default("redis://localhost:6379"),
    LOG_LEVEL: z.string().default("info"),
    MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  })
  .parse(process.env);

const logger = pino({ level: env.LOG_LEVEL, name: "notifier" });

const EXCHANGE = "wallet.events";
const QUEUE = "notifier.transfer-completed";
const RETRY_QUEUE = `${QUEUE}.retry`;
const DEAD_LETTER_QUEUE = `${QUEUE}.dlq`;

const redis = new Redis(env.REDIS_URL);
const store: ProcessedEventStore = {
  async markIfNew(eventId) {
    return (await redis.set(`notifier:processed:${eventId}`, "1", "EX", 7 * 24 * 3600, "NX")) === "OK";
  },
  async forget(eventId) {
    await redis.del(`notifier:processed:${eventId}`);
  },
};

// Stand-in for a real push/e-mail provider.
const channel: NotificationChannel = {
  async send(notification) {
    logger.info({ notification }, "Notification sent");
  },
};

const connection = await amqp.connect(env.RABBITMQ_URL);
const ch = await connection.createChannel();

await ch.assertExchange(EXCHANGE, "topic", { durable: true });
await ch.assertQueue(QUEUE, { durable: true });
await ch.bindQueue(QUEUE, EXCHANGE, "transfer.completed");
// Messages wait here for their TTL, then are dead-lettered straight back to the main queue.
await ch.assertQueue(RETRY_QUEUE, {
  durable: true,
  deadLetterExchange: "",
  deadLetterRoutingKey: QUEUE,
});
await ch.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
await ch.prefetch(10);

/** Exponential backoff: 1s, 2s, 4s, 8s... capped at 60s. */
const backoffMs = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 60_000);

async function onMessage(message: ConsumeMessage | null) {
  if (!message) return;
  const attempt = Number(message.properties.headers?.["x-attempt"] ?? 1);

  try {
    const body: unknown = JSON.parse(message.content.toString());
    const result = await handleMessage(body, { channel, store });
    logger.debug({ messageId: message.properties.messageId, result }, "Message handled");
    ch.ack(message);
  } catch (error) {
    const permanent = error instanceof PermanentError || error instanceof SyntaxError;
    if (permanent || attempt >= env.MAX_ATTEMPTS) {
      logger.error({ err: error, attempt }, "Moving message to dead-letter queue");
      ch.sendToQueue(DEAD_LETTER_QUEUE, message.content, {
        ...message.properties,
        headers: { ...message.properties.headers, "x-error": String((error as Error).message) },
      });
    } else {
      logger.warn({ err: error, attempt }, "Scheduling retry");
      ch.sendToQueue(RETRY_QUEUE, message.content, {
        ...message.properties,
        expiration: String(backoffMs(attempt)),
        headers: { ...message.properties.headers, "x-attempt": attempt + 1 },
      });
    }
    ch.ack(message);
  }
}

await ch.consume(QUEUE, (message) => void onMessage(message));
logger.info({ queue: QUEUE }, "Notifier consuming");

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, "Stopping notifier");
    await ch.close().catch(() => {});
    await connection.close().catch(() => {});
    await redis.quit();
    process.exit(0);
  });
}
