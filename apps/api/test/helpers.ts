import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import { TREASURY_ACCOUNT_ID } from "../src/db/schema.js";
import { createRedis, type Redis } from "../src/infra/redis.js";

export interface TestContext extends DatabaseHandle {
  app: FastifyInstance;
  redis: Redis;
  close(): Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const env = loadEnv();
  const { db, pool } = createDatabase(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL);
  const app = await buildApp({ env, db, pool, redis, bcryptCost: 4 });
  await app.ready();
  return {
    app,
    db,
    pool,
    redis,
    async close() {
      await app.close();
      await Promise.allSettled([pool.end(), redis.quit()]);
    },
  };
}

/** Wipes all data between tests and restores the treasury system account. */
export async function resetState(ctx: TestContext): Promise<void> {
  await ctx.pool.query(
    "TRUNCATE users, accounts, transactions, ledger_entries, outbox_events RESTART IDENTITY CASCADE",
  );
  await ctx.pool.query("INSERT INTO accounts (id, kind) VALUES ($1, 'system')", [TREASURY_ACCOUNT_ID]);
  await ctx.redis.flushdb();
}

export interface TestUser {
  id: string;
  email: string;
  accountId: string;
  token: string;
}

let counter = 0;

export async function registerUser(ctx: TestContext, name = "Test User"): Promise<TestUser> {
  counter++;
  const email = `user${counter}-${randomUUID().slice(0, 8)}@example.com`;
  const response = await ctx.app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name, email, password: "s3cure-password" },
  });
  if (response.statusCode !== 201) throw new Error(`register failed: ${response.body}`);
  const body = response.json();
  return { id: body.user.id, email, accountId: body.user.accountId, token: body.accessToken };
}

export async function deposit(ctx: TestContext, user: TestUser, amountCents: number) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/accounts/me/deposits",
    headers: { authorization: `Bearer ${user.token}`, "idempotency-key": randomUUID() },
    payload: { amountCents },
  });
  if (response.statusCode !== 201) throw new Error(`deposit failed: ${response.body}`);
  return response.json();
}

export function transfer(
  ctx: TestContext,
  from: TestUser,
  to: TestUser,
  amountCents: number,
  idempotencyKey: string = randomUUID(),
  description?: string,
) {
  return ctx.app.inject({
    method: "POST",
    url: "/transfers",
    headers: { authorization: `Bearer ${from.token}`, "idempotency-key": idempotencyKey },
    payload: { recipientEmail: to.email, amountCents, ...(description ? { description } : {}) },
  });
}

export async function balanceOf(ctx: TestContext, accountId: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ balance_cents: string }>(
    "SELECT balance_cents FROM accounts WHERE id = $1",
    [accountId],
  );
  return Number(rows[0]?.balance_cents);
}
