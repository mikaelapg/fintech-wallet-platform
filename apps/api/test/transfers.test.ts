import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  balanceOf,
  createTestContext,
  deposit,
  registerUser,
  resetState,
  transfer,
  type TestContext,
} from "./helpers.js";

describe("transfers", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  beforeEach(() => resetState(ctx));
  afterAll(() => ctx.close());

  it("moves money between accounts and writes a balanced double entry", async () => {
    const alice = await registerUser(ctx, "Alice");
    const bob = await registerUser(ctx, "Bob");
    await deposit(ctx, alice, 10_000);

    const response = await transfer(ctx, alice, bob, 2_550, randomUUID(), "Pizza");

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      amountCents: 2_550,
      fromAccountId: alice.accountId,
      toAccountId: bob.accountId,
      description: "Pizza",
    });
    expect(await balanceOf(ctx, alice.accountId)).toBe(7_450);
    expect(await balanceOf(ctx, bob.accountId)).toBe(2_550);

    const { rows } = await ctx.pool.query<{ direction: string; amount_cents: string }>(
      "SELECT direction, amount_cents FROM ledger_entries WHERE transaction_id = $1",
      [response.json().id],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.direction).sort()).toEqual(["credit", "debit"]);
  });

  it("rejects transfers above the balance without touching the ledger", async () => {
    const alice = await registerUser(ctx);
    const bob = await registerUser(ctx);
    await deposit(ctx, alice, 1_000);

    const response = await transfer(ctx, alice, bob, 1_001);

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("INSUFFICIENT_FUNDS");
    expect(await balanceOf(ctx, alice.accountId)).toBe(1_000);
    const { rows } = await ctx.pool.query("SELECT 1 FROM transactions WHERE type = 'transfer'");
    expect(rows).toHaveLength(0);
  });

  it("rejects transfers to yourself, unknown recipients and invalid amounts", async () => {
    const alice = await registerUser(ctx);
    await deposit(ctx, alice, 1_000);
    const ghost = { ...alice, email: "ghost@example.com" };

    expect((await transfer(ctx, alice, alice, 100)).json().code).toBe("SELF_TRANSFER");
    expect((await transfer(ctx, alice, ghost, 100)).statusCode).toBe(404);
    expect((await transfer(ctx, alice, ghost, 10.5)).statusCode).toBe(400);
    expect((await transfer(ctx, alice, ghost, -1)).statusCode).toBe(400);
  });

  it("requires an Idempotency-Key header", async () => {
    const alice = await registerUser(ctx);
    const bob = await registerUser(ctx);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/transfers",
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { recipientEmail: bob.email, amountCents: 100 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  describe("idempotency", () => {
    it("replays the original response when the same key is retried", async () => {
      const alice = await registerUser(ctx);
      const bob = await registerUser(ctx);
      await deposit(ctx, alice, 5_000);
      const key = randomUUID();

      const first = await transfer(ctx, alice, bob, 1_000, key);
      const retry = await transfer(ctx, alice, bob, 1_000, key);

      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(200);
      expect(retry.headers["idempotent-replayed"]).toBe("true");
      expect(retry.json().id).toBe(first.json().id);
      // Money moved exactly once.
      expect(await balanceOf(ctx, alice.accountId)).toBe(4_000);
      expect(await balanceOf(ctx, bob.accountId)).toBe(1_000);
    });

    it("rejects reusing a key with a different payload", async () => {
      const alice = await registerUser(ctx);
      const bob = await registerUser(ctx);
      await deposit(ctx, alice, 5_000);
      const key = randomUUID();

      await transfer(ctx, alice, bob, 1_000, key);
      const reused = await transfer(ctx, alice, bob, 2_000, key);

      expect(reused.statusCode).toBe(422);
      expect(reused.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(await balanceOf(ctx, alice.accountId)).toBe(4_000);
    });

    it("executes a burst of duplicated requests only once", async () => {
      const alice = await registerUser(ctx);
      const bob = await registerUser(ctx);
      await deposit(ctx, alice, 5_000);
      const key = randomUUID();

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => transfer(ctx, alice, bob, 1_000, key)),
      );

      const created = responses.filter((r) => r.statusCode === 201);
      expect(created).toHaveLength(1);
      // Every other attempt was either replayed (200) or told to retry (409).
      expect(responses.every((r) => [200, 201, 409].includes(r.statusCode))).toBe(true);
      expect(await balanceOf(ctx, alice.accountId)).toBe(4_000);
    });
  });

  describe("concurrency", () => {
    it("never overdraws an account under concurrent transfers", async () => {
      const alice = await registerUser(ctx);
      const bob = await registerUser(ctx);
      await deposit(ctx, alice, 1_000);

      // 20 concurrent transfers of R$ 1,00 from a balance of R$ 10,00.
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => transfer(ctx, alice, bob, 100)),
      );

      const succeeded = responses.filter((r) => r.statusCode === 201).length;
      const rejected = responses.filter((r) => r.json().code === "INSUFFICIENT_FUNDS").length;
      expect(succeeded).toBe(10);
      expect(rejected).toBe(10);
      expect(await balanceOf(ctx, alice.accountId)).toBe(0);
      expect(await balanceOf(ctx, bob.accountId)).toBe(1_000);
    });

    it("does not deadlock on simultaneous opposite transfers", async () => {
      const alice = await registerUser(ctx);
      const bob = await registerUser(ctx);
      await deposit(ctx, alice, 5_000);
      await deposit(ctx, bob, 5_000);

      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          i % 2 === 0 ? transfer(ctx, alice, bob, 100) : transfer(ctx, bob, alice, 100),
        ),
      );

      expect(responses.every((r) => r.statusCode === 201)).toBe(true);
      expect(await balanceOf(ctx, alice.accountId)).toBe(5_000);
      expect(await balanceOf(ctx, bob.accountId)).toBe(5_000);
    });
  });

  it("keeps the ledger balanced and consistent with account balances", async () => {
    const users = await Promise.all([registerUser(ctx), registerUser(ctx), registerUser(ctx)]);
    const [a, b, c] = users as [(typeof users)[0], (typeof users)[0], (typeof users)[0]];
    await deposit(ctx, a, 9_000);
    await transfer(ctx, a, b, 3_000);
    await transfer(ctx, b, c, 1_500);
    await transfer(ctx, c, a, 500);

    const unbalanced = await ctx.pool.query(`
      SELECT transaction_id FROM ledger_entries
      GROUP BY transaction_id
      HAVING SUM(CASE WHEN direction = 'debit' THEN amount_cents ELSE -amount_cents END) <> 0`);
    expect(unbalanced.rows).toHaveLength(0);

    const drift = await ctx.pool.query(`
      SELECT a.id FROM accounts a
      LEFT JOIN ledger_entries e ON e.account_id = a.id
      GROUP BY a.id, a.balance_cents
      HAVING a.balance_cents <>
        COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_cents ELSE -e.amount_cents END), 0)`);
    expect(drift.rows).toHaveLength(0);
  });

  it("writes an outbox event in the same transaction as the transfer", async () => {
    const alice = await registerUser(ctx);
    const bob = await registerUser(ctx);
    await deposit(ctx, alice, 1_000);

    const response = await transfer(ctx, alice, bob, 400);

    const { rows } = await ctx.pool.query(
      "SELECT event_type, payload, published_at FROM outbox_events WHERE aggregate_id = $1",
      [response.json().id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: "transfer.completed",
      published_at: null,
      payload: expect.objectContaining({ amountCents: 400, creditAccountId: bob.accountId }),
    });
  });

  it("refuses to edit or delete ledger entries", async () => {
    const alice = await registerUser(ctx);
    await deposit(ctx, alice, 1_000);

    await expect(ctx.pool.query("UPDATE ledger_entries SET amount_cents = 1")).rejects.toThrow(
      /append-only/,
    );
    await expect(ctx.pool.query("DELETE FROM ledger_entries")).rejects.toThrow(/append-only/);
  });
});
