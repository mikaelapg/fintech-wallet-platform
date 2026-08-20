-- Core schema for the wallet: users, accounts, a double-entry ledger and a
-- transactional outbox. Integrity rules live in the database, not only in code.

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TYPE account_kind AS ENUM ('user', 'system');

CREATE TABLE accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users (id) ON DELETE RESTRICT,
  kind          account_kind NOT NULL DEFAULT 'user',
  currency      CHAR(3)      NOT NULL DEFAULT 'BRL',
  balance_cents BIGINT       NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Customer accounts can never go negative, even if application code has a bug.
  CONSTRAINT accounts_user_balance_non_negative CHECK (kind = 'system' OR balance_cents >= 0),
  CONSTRAINT accounts_user_has_owner CHECK ((kind = 'user') = (user_id IS NOT NULL))
);
CREATE UNIQUE INDEX accounts_user_id_uq ON accounts (user_id) WHERE user_id IS NOT NULL;

-- The "treasury" system account is the counterparty of cash-in operations.
INSERT INTO accounts (id, kind) VALUES ('00000000-0000-0000-0000-000000000001', 'system');

CREATE TYPE transaction_type AS ENUM ('deposit', 'transfer');

CREATE TABLE transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type              transaction_type NOT NULL,
  amount_cents      BIGINT      NOT NULL CHECK (amount_cents > 0),
  initiator_user_id UUID        NOT NULL REFERENCES users (id),
  idempotency_key   UUID        NOT NULL,
  request_hash      TEXT        NOT NULL,
  description       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Durable idempotency guarantee: the same user can't execute the same key twice.
  CONSTRAINT transactions_idempotency_uq UNIQUE (initiator_user_id, idempotency_key)
);

CREATE TYPE entry_direction AS ENUM ('debit', 'credit');

CREATE TABLE ledger_entries (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id      UUID            NOT NULL REFERENCES transactions (id),
  account_id          UUID            NOT NULL REFERENCES accounts (id),
  direction           entry_direction NOT NULL,
  amount_cents        BIGINT          NOT NULL CHECK (amount_cents > 0),
  balance_after_cents BIGINT          NOT NULL,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);
-- Supports keyset pagination of an account statement (newest first).
CREATE INDEX ledger_entries_account_id_id_idx ON ledger_entries (account_id, id DESC);
CREATE INDEX ledger_entries_transaction_id_idx ON ledger_entries (transaction_id);

-- Ledger entries are append-only: corrections are new transactions, never edits.
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TABLE outbox_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type TEXT        NOT NULL,
  aggregate_id   UUID        NOT NULL,
  event_type     TEXT        NOT NULL,
  payload        JSONB       NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ,
  attempts       INT         NOT NULL DEFAULT 0,
  last_error     TEXT
);
-- The relay only ever scans pending events, so keep that index tiny.
CREATE INDEX outbox_events_pending_idx ON outbox_events (created_at) WHERE published_at IS NULL;
