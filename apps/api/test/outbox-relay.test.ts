import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventPublisher, OutgoingMessage } from "../src/infra/broker.js";
import { OutboxRelay } from "../src/modules/outbox/outbox-relay.js";
import {
  createTestContext,
  deposit,
  registerUser,
  resetState,
  transfer,
  type TestContext,
} from "./helpers.js";

const silentLogger = { info: () => {}, error: () => {} };

class InMemoryPublisher implements EventPublisher {
  readonly messages: OutgoingMessage[] = [];
  failNext = false;

  async publish(message: OutgoingMessage) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("broker unavailable");
    }
    this.messages.push(message);
  }
  async close() {}
}

describe("outbox relay", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  beforeEach(() => resetState(ctx));
  afterAll(() => ctx.close());

  async function seedEvents() {
    const alice = await registerUser(ctx);
    const bob = await registerUser(ctx);
    await deposit(ctx, alice, 1_000);
    await transfer(ctx, alice, bob, 250);
  }

  it("publishes pending events in order and marks them as published", async () => {
    await seedEvents();
    const publisher = new InMemoryPublisher();
    const relay = new OutboxRelay(ctx.db, publisher, silentLogger);

    expect(await relay.processBatch()).toBe(2);
    expect(publisher.messages.map((m) => m.type)).toEqual(["deposit.completed", "transfer.completed"]);
    // Nothing left to publish on the next tick.
    expect(await relay.processBatch()).toBe(0);

    const { rows } = await ctx.pool.query("SELECT 1 FROM outbox_events WHERE published_at IS NULL");
    expect(rows).toHaveLength(0);
  });

  it("keeps events pending and records the error when the broker fails", async () => {
    await seedEvents();
    const publisher = new InMemoryPublisher();
    publisher.failNext = true;
    const relay = new OutboxRelay(ctx.db, publisher, silentLogger);

    expect(await relay.processBatch()).toBe(0);
    const { rows } = await ctx.pool.query(
      "SELECT attempts, last_error FROM outbox_events WHERE published_at IS NULL ORDER BY created_at",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ attempts: 1, last_error: "broker unavailable" });

    // The next run succeeds and delivers everything.
    expect(await relay.processBatch()).toBe(2);
  });

  it("lets two relay replicas share the work without double publishing", async () => {
    await seedEvents();
    const publisher = new InMemoryPublisher();
    const replicaA = new OutboxRelay(ctx.db, publisher, silentLogger, 1);
    const replicaB = new OutboxRelay(ctx.db, publisher, silentLogger, 1);

    await Promise.all([replicaA.processBatch(), replicaB.processBatch()]);
    await Promise.all([replicaA.processBatch(), replicaB.processBatch()]);

    const ids = publisher.messages.map((m) => m.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
