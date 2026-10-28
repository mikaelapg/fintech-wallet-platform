import { and, desc, eq, lt } from "drizzle-orm";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { accounts, ledgerEntries, transactions, TREASURY_ACCOUNT_ID } from "../../db/schema.js";
import { Errors } from "../../shared/errors.js";
import { amountCentsSchema } from "../../shared/money.js";
import { hashRequest, runIdempotent } from "../ledger/idempotency.js";
import { postTransaction } from "../ledger/ledger.service.js";

export const statementQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().positive().optional(),
});

// Simulated cash-in (e.g. a PIX deposit confirmed by a payment provider).
export const depositSchema = z.object({
  amountCents: amountCentsSchema,
});

export interface Balance {
  accountId: string;
  currency: string;
  balanceCents: number;
}

export interface StatementEntry {
  id: number;
  transactionId: string;
  type: "deposit" | "transfer";
  direction: "debit" | "credit";
  amountCents: number;
  balanceAfterCents: number;
  description: string | null;
  createdAt: string;
}

export const balanceCacheKey = (accountId: string) => `balance:${accountId}`;

export class AccountsService {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly cacheTtlSeconds: number,
  ) {}

  /** Cache-aside read. Writes invalidate the key, so the cache is never the source of truth. */
  async getBalance(accountId: string): Promise<Balance & { cached: boolean }> {
    const cached = await this.redis.get(balanceCacheKey(accountId));
    if (cached) return { ...(JSON.parse(cached) as Balance), cached: true };

    const [row] = await this.db
      .select({
        accountId: accounts.id,
        currency: accounts.currency,
        balanceCents: accounts.balanceCents,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!row) throw Errors.notFound("Account");

    await this.redis.set(balanceCacheKey(accountId), JSON.stringify(row), "EX", this.cacheTtlSeconds);
    return { ...row, cached: false };
  }

  async invalidateBalances(...accountIds: string[]): Promise<void> {
    if (accountIds.length) await this.redis.del(...accountIds.map(balanceCacheKey));
  }

  /**
   * Keyset (cursor) pagination: `WHERE id < cursor ORDER BY id DESC`. Unlike
   * OFFSET it stays fast on long histories and never skips or repeats rows
   * when new entries arrive while the user is paging.
   */
  async getStatement(
    accountId: string,
    query: z.infer<typeof statementQuerySchema>,
  ): Promise<{ items: StatementEntry[]; nextCursor: number | null }> {
    const rows = await this.db
      .select({
        id: ledgerEntries.id,
        transactionId: ledgerEntries.transactionId,
        type: transactions.type,
        direction: ledgerEntries.direction,
        amountCents: ledgerEntries.amountCents,
        balanceAfterCents: ledgerEntries.balanceAfterCents,
        description: transactions.description,
        createdAt: ledgerEntries.createdAt,
      })
      .from(ledgerEntries)
      .innerJoin(transactions, eq(transactions.id, ledgerEntries.transactionId))
      .where(
        query.cursor
          ? and(eq(ledgerEntries.accountId, accountId), lt(ledgerEntries.id, query.cursor))
          : eq(ledgerEntries.accountId, accountId),
      )
      .orderBy(desc(ledgerEntries.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: page.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async deposit(params: {
    userId: string;
    accountId: string;
    idempotencyKey: string;
    input: z.infer<typeof depositSchema>;
  }) {
    const requestHash = hashRequest({ op: "deposit", ...params.input });
    const outcome = await runIdempotent(
      { db: this.db, redis: this.redis },
      { userId: params.userId, key: params.idempotencyKey, requestHash },
      () =>
        this.db.transaction((tx) =>
          postTransaction(tx, {
            type: "deposit",
            debitAccountId: TREASURY_ACCOUNT_ID,
            creditAccountId: params.accountId,
            amountCents: params.input.amountCents,
            initiatorUserId: params.userId,
            idempotencyKey: params.idempotencyKey,
            requestHash,
            description: "Depósito",
          }),
        ),
    );
    if (!outcome.replayed) await this.invalidateBalances(params.accountId);
    return outcome;
  }
}
