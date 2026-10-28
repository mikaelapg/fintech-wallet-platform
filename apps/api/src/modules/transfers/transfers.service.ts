import { eq, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { accounts, ledgerEntries, transactions, users } from "../../db/schema.js";
import { Errors } from "../../shared/errors.js";
import { amountCentsSchema } from "../../shared/money.js";
import type { AccountsService } from "../accounts/accounts.service.js";
import { hashRequest, runIdempotent } from "../ledger/idempotency.js";
import { postTransaction } from "../ledger/ledger.service.js";

export const createTransferSchema = z.object({
  recipientEmail: z.email().transform((e) => e.toLowerCase()),
  amountCents: amountCentsSchema,
  description: z.string().trim().max(140).optional(),
});

export interface TransferView {
  id: string;
  amountCents: number;
  fromAccountId: string;
  toAccountId: string;
  description: string | null;
  createdAt: string;
}

export class TransfersService {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly accountsService: AccountsService,
  ) {}

  async create(params: {
    userId: string;
    accountId: string;
    idempotencyKey: string;
    input: z.infer<typeof createTransferSchema>;
  }): Promise<{ transfer: TransferView; replayed: boolean }> {
    const { input } = params;
    const requestHash = hashRequest({
      op: "transfer",
      recipientEmail: input.recipientEmail,
      amountCents: input.amountCents,
      description: input.description ?? null,
    });

    const recipientAccountId = await this.findAccountIdByEmail(input.recipientEmail);
    if (recipientAccountId === params.accountId) throw Errors.selfTransfer();

    const outcome = await runIdempotent(
      { db: this.db, redis: this.redis },
      { userId: params.userId, key: params.idempotencyKey, requestHash },
      () =>
        this.db.transaction((tx) =>
          postTransaction(tx, {
            type: "transfer",
            debitAccountId: params.accountId,
            creditAccountId: recipientAccountId,
            amountCents: input.amountCents,
            initiatorUserId: params.userId,
            idempotencyKey: params.idempotencyKey,
            requestHash,
            description: input.description,
          }),
        ),
    );

    if (outcome.replayed) {
      return { transfer: await this.getById(outcome.transactionId), replayed: true };
    }

    // Invalidate only after commit; a reader may briefly see the old cached
    // balance, never a balance that was rolled back.
    await this.accountsService.invalidateBalances(params.accountId, recipientAccountId);
    const posted = outcome.value;
    return {
      replayed: false,
      transfer: {
        id: posted.transactionId,
        amountCents: posted.amountCents,
        fromAccountId: posted.debitAccountId,
        toAccountId: posted.creditAccountId,
        description: posted.description,
        createdAt: posted.createdAt.toISOString(),
      },
    };
  }

  async getById(transactionId: string): Promise<TransferView> {
    const rows = await this.db
      .select({
        id: transactions.id,
        amountCents: transactions.amountCents,
        description: transactions.description,
        createdAt: transactions.createdAt,
        accountId: ledgerEntries.accountId,
        direction: ledgerEntries.direction,
      })
      .from(transactions)
      .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, transactions.id))
      .where(eq(transactions.id, transactionId));

    const debit = rows.find((r) => r.direction === "debit");
    const credit = rows.find((r) => r.direction === "credit");
    if (!debit || !credit) throw Errors.notFound("Transfer");
    return {
      id: debit.id,
      amountCents: debit.amountCents,
      fromAccountId: debit.accountId,
      toAccountId: credit.accountId,
      description: debit.description,
      createdAt: debit.createdAt.toISOString(),
    };
  }

  private async findAccountIdByEmail(email: string): Promise<string> {
    const [row] = await this.db
      .select({ accountId: accounts.id })
      .from(users)
      .innerJoin(accounts, eq(accounts.userId, users.id))
      .where(eq(sql`lower(${users.email})`, email))
      .limit(1);
    if (!row) throw Errors.notFound("Recipient");
    return row.accountId;
  }
}
