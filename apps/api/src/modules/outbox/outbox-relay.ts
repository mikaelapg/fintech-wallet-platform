import { asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { outboxEvents } from "../../db/schema.js";
import type { EventPublisher } from "../../infra/broker.js";

export interface RelayLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Moves committed events from the outbox table to the message broker.
 *
 * - FOR UPDATE SKIP LOCKED lets several relay replicas run side by side: each
 *   one claims a different batch instead of blocking or double-publishing.
 * - Delivery is at-least-once (a crash after publish but before commit
 *   re-sends the event), so consumers deduplicate by event id.
 */
export class OutboxRelay {
  constructor(
    private readonly db: Database,
    private readonly publisher: EventPublisher,
    private readonly logger: RelayLogger,
    private readonly batchSize = 50,
  ) {}

  /** Publishes one batch. Returns how many events were published. */
  async processBatch(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const batch = await tx
        .select()
        .from(outboxEvents)
        .where(isNull(outboxEvents.publishedAt))
        .orderBy(asc(outboxEvents.createdAt))
        .limit(this.batchSize)
        .for("update", { skipLocked: true });

      let published = 0;
      for (const event of batch) {
        try {
          await this.publisher.publish({
            id: event.id,
            type: event.eventType,
            occurredAt: event.createdAt.toISOString(),
            payload: event.payload,
          });
          await tx
            .update(outboxEvents)
            .set({ publishedAt: sql`now()`, attempts: sql`${outboxEvents.attempts} + 1` })
            .where(eq(outboxEvents.id, event.id));
          published++;
        } catch (error) {
          await tx
            .update(outboxEvents)
            .set({
              attempts: sql`${outboxEvents.attempts} + 1`,
              lastError: (error as Error).message.slice(0, 500),
            })
            .where(eq(outboxEvents.id, event.id));
          this.logger.error({ eventId: event.id, err: error }, "Failed to publish outbox event");
          // Stop here to preserve ordering; the rest of the batch is retried next tick.
          break;
        }
      }
      if (published) this.logger.info({ published }, "Outbox events published");
      return published;
    });
  }

  /** Polls until the signal is aborted, backing off while the outbox is empty. */
  async run(signal: AbortSignal, idleDelayMs = 500, maxDelayMs = 5_000): Promise<void> {
    let delay = idleDelayMs;
    while (!signal.aborted) {
      let published = 0;
      try {
        published = await this.processBatch();
      } catch (error) {
        this.logger.error({ err: error }, "Outbox relay iteration failed");
      }
      delay = published > 0 ? 0 : Math.min(Math.max(delay * 2, idleDelayMs), maxDelayMs);
      if (delay > 0) await sleep(delay, signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
