import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Transaction } from "../../db/client.js";
import { accounts, ledgerEntries, outboxEvents, transactions } from "../../db/schema.js";
import { AppError, Errors } from "../../shared/errors.js";

export interface PostingInput {
  type: "deposit" | "transfer";
  debitAccountId: string;
  creditAccountId: string;
  amountCents: number;
  initiatorUserId: string;
  idempotencyKey: string;
  requestHash: string;
  description?: string | undefined;
}

export interface PostingResult {
  transactionId: string;
  type: "deposit" | "transfer";
  amountCents: number;
  debitAccountId: string;
  creditAccountId: string;
  debitBalanceAfterCents: number;
  creditBalanceAfterCents: number;
  description: string | null;
  createdAt: Date;
}

/**
 * Posts a balanced double-entry transaction: one debit and one credit of the
 * same amount, written atomically together with an outbox event.
 *
 * Concurrency: both account rows are locked with SELECT ... FOR UPDATE in a
 * deterministic order (by id). Two opposite transfers A->B and B->A therefore
 * always lock in the same order and cannot deadlock.
 */
export async function postTransaction(tx: Transaction, input: PostingInput): Promise<PostingResult> {
  if (input.debitAccountId === input.creditAccountId) throw Errors.selfTransfer();

  const locked = await tx
    .select({ id: accounts.id, kind: accounts.kind, balanceCents: accounts.balanceCents })
    .from(accounts)
    .where(inArray(accounts.id, [input.debitAccountId, input.creditAccountId]))
    .orderBy(asc(accounts.id))
    .for("update");

  const debit = locked.find((a) => a.id === input.debitAccountId);
  const credit = locked.find((a) => a.id === input.creditAccountId);
  if (!debit || !credit) throw Errors.notFound("Account");

  if (debit.kind === "user" && debit.balanceCents < input.amountCents) {
    throw Errors.insufficientFunds();
  }

  const debitBalanceAfterCents = debit.balanceCents - input.amountCents;
  const creditBalanceAfterCents = credit.balanceCents + input.amountCents;

  const [created] = await tx
    .insert(transactions)
    .values({
      type: input.type,
      amountCents: input.amountCents,
      initiatorUserId: input.initiatorUserId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      description: input.description ?? null,
    })
    .returning();
  if (!created) throw new AppError("INTERNAL", "Failed to create transaction", 500);

  await tx
    .update(accounts)
    .set({ balanceCents: sql`${accounts.balanceCents} - ${input.amountCents}` })
    .where(eq(accounts.id, input.debitAccountId));
  await tx
    .update(accounts)
    .set({ balanceCents: sql`${accounts.balanceCents} + ${input.amountCents}` })
    .where(eq(accounts.id, input.creditAccountId));

  await tx.insert(ledgerEntries).values([
    {
      transactionId: created.id,
      accountId: input.debitAccountId,
      direction: "debit",
      amountCents: input.amountCents,
      balanceAfterCents: debitBalanceAfterCents,
    },
    {
      transactionId: created.id,
      accountId: input.creditAccountId,
      direction: "credit",
      amountCents: input.amountCents,
      balanceAfterCents: creditBalanceAfterCents,
    },
  ]);

  // Transactional outbox: the event is committed in the same DB transaction as
  // the money movement, so we never publish an event for a rolled-back
  // transfer and never lose an event for a committed one.
  await tx.insert(outboxEvents).values({
    aggregateType: "transaction",
    aggregateId: created.id,
    eventType: input.type === "transfer" ? "transfer.completed" : "deposit.completed",
    payload: {
      transactionId: created.id,
      amountCents: input.amountCents,
      debitAccountId: input.debitAccountId,
      creditAccountId: input.creditAccountId,
      initiatorUserId: input.initiatorUserId,
      description: input.description ?? null,
    },
  });

  return {
    transactionId: created.id,
    type: input.type,
    amountCents: input.amountCents,
    debitAccountId: input.debitAccountId,
    creditAccountId: input.creditAccountId,
    debitBalanceAfterCents,
    creditBalanceAfterCents,
    description: created.description,
    createdAt: created.createdAt,
  };
}
