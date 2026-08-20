import {
  bigint,
  char,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Mirrors src/db/migrations. SQL migrations are the source of truth; this file
// gives the application type-safe queries over the same tables.

export const accountKind = pgEnum("account_kind", ["user", "system"]);
export const transactionType = pgEnum("transaction_type", ["deposit", "transfer"]);
export const entryDirection = pgEnum("entry_direction", ["debit", "credit"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  kind: accountKind("kind").notNull().default("user"),
  currency: char("currency", { length: 3 }).notNull().default("BRL"),
  balanceCents: bigint("balance_cents", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: transactionType("type").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  initiatorUserId: uuid("initiator_user_id")
    .notNull()
    .references(() => users.id),
  idempotencyKey: uuid("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ledgerEntries = pgTable("ledger_entries", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  transactionId: uuid("transaction_id")
    .notNull()
    .references(() => transactions.id),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  direction: entryDirection("direction").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  balanceAfterCents: bigint("balance_after_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
});

export const TREASURY_ACCOUNT_ID = "00000000-0000-0000-0000-000000000001";
