import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestContext,
  deposit,
  registerUser,
  resetState,
  transfer,
  type TestContext,
} from "./helpers.js";

describe("accounts", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  beforeEach(() => resetState(ctx));
  afterAll(() => ctx.close());

  const getBalance = (token: string) =>
    ctx.app.inject({
      method: "GET",
      url: "/accounts/me/balance",
      headers: { authorization: `Bearer ${token}` },
    });

  it("serves the balance from Redis and invalidates it after a transfer", async () => {
    const alice = await registerUser(ctx);
    const bob = await registerUser(ctx);
    await deposit(ctx, alice, 3_000);

    const miss = await getBalance(alice.token);
    const hit = await getBalance(alice.token);
    expect(miss.headers["x-cache"]).toBe("MISS");
    expect(hit.headers["x-cache"]).toBe("HIT");
    expect(hit.json()).toMatchObject({ balanceCents: 3_000, currency: "BRL" });

    await transfer(ctx, alice, bob, 1_000);

    const afterTransfer = await getBalance(alice.token);
    expect(afterTransfer.headers["x-cache"]).toBe("MISS");
    expect(afterTransfer.json().balanceCents).toBe(2_000);
  });

  it("deposits are idempotent too", async () => {
    const alice = await registerUser(ctx);
    const key = randomUUID();
    const request = () =>
      ctx.app.inject({
        method: "POST",
        url: "/accounts/me/deposits",
        headers: { authorization: `Bearer ${alice.token}`, "idempotency-key": key },
        payload: { amountCents: 500 },
      });

    expect((await request()).statusCode).toBe(201);
    expect((await request()).statusCode).toBe(200);
    expect((await getBalance(alice.token)).json().balanceCents).toBe(500);
  });

  it("paginates the statement with a cursor, newest first, without gaps", async () => {
    const alice = await registerUser(ctx);
    const bob = await registerUser(ctx);
    await deposit(ctx, alice, 10_000);
    for (const amount of [100, 200, 300, 400, 500]) await transfer(ctx, alice, bob, amount);

    const page = (cursor?: number) =>
      ctx.app.inject({
        method: "GET",
        url: `/accounts/me/statement?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        headers: { authorization: `Bearer ${alice.token}` },
      });

    const seen: number[] = [];
    let cursor: number | undefined;
    let pages = 0;
    do {
      const body = (await page(cursor)).json();
      seen.push(...body.items.map((i: { amountCents: number }) => i.amountCents));
      cursor = body.nextCursor ?? undefined;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toEqual([500, 400, 300, 200, 100, 10_000]);
  });

  it("validates statement query parameters", async () => {
    const alice = await registerUser(ctx);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/accounts/me/statement?limit=500",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(response.statusCode).toBe(400);
  });

  it("reports readiness of its dependencies", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json().checks).toEqual({ database: "fulfilled", redis: "fulfilled" });
  });
});
