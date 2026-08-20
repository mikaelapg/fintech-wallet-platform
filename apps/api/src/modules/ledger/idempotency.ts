import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { transactions } from "../../db/schema.js";
import { Errors } from "../../shared/errors.js";
import { hasPgErrorCode, PG_UNIQUE_VIOLATION } from "../../shared/pg-errors.js";

const LOCK_TTL_MS = 30_000;

export const idempotencyKeySchema = z.uuid();

/** Stable hash of a request payload, independent of key order. */
export function hashRequest(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

export type IdempotentOutcome<T> = { replayed: false; value: T } | { replayed: true; transactionId: string };

/**
 * Two layers of idempotency:
 *  1. A short Redis lock rejects concurrent duplicates fast (double click, retry storm).
 *  2. The UNIQUE (initiator_user_id, idempotency_key) constraint is the durable
 *     guarantee: even if Redis is flushed, the same key can never move money twice.
 */
export async function runIdempotent<T>(
  deps: { db: Database; redis: Redis },
  params: { userId: string; key: string; requestHash: string },
  execute: () => Promise<T>,
): Promise<IdempotentOutcome<T>> {
  const replay = await findPrevious(deps.db, params);
  if (replay) return replay;

  const lockKey = `idem:lock:${params.userId}:${params.key}`;
  const acquired = await deps.redis.set(lockKey, "1", "PX", LOCK_TTL_MS, "NX");
  if (acquired !== "OK") throw Errors.requestInProgress();

  try {
    return { replayed: false, value: await execute() };
  } catch (error) {
    if (hasPgErrorCode(error, PG_UNIQUE_VIOLATION)) {
      const raced = await findPrevious(deps.db, params);
      if (raced) return raced;
    }
    throw error;
  } finally {
    await deps.redis.del(lockKey);
  }
}

async function findPrevious(
  db: Database,
  params: { userId: string; key: string; requestHash: string },
): Promise<{ replayed: true; transactionId: string } | null> {
  const [previous] = await db
    .select({ id: transactions.id, requestHash: transactions.requestHash })
    .from(transactions)
    .where(
      and(
        eq(transactions.initiatorUserId, params.userId),
        eq(transactions.idempotencyKey, params.key),
      ),
    )
    .limit(1);

  if (!previous) return null;
  if (previous.requestHash !== params.requestHash) throw Errors.idempotencyConflict();
  return { replayed: true, transactionId: previous.id };
}
