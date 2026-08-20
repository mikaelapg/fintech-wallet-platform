import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { hashRequest } from "../src/modules/ledger/idempotency.js";
import { amountCentsSchema, formatBRL, MAX_TRANSFER_CENTS } from "../src/shared/money.js";
import { hasPgErrorCode } from "../src/shared/pg-errors.js";

describe("hashRequest", () => {
  it("is independent of key order", () => {
    expect(hashRequest({ a: 1, b: "x" })).toBe(hashRequest({ b: "x", a: 1 }));
  });

  it("changes when any value changes", () => {
    expect(hashRequest({ amountCents: 100 })).not.toBe(hashRequest({ amountCents: 101 }));
  });
});

describe("money", () => {
  it.each([1, 100, MAX_TRANSFER_CENTS])("accepts %i cents", (value) => {
    expect(amountCentsSchema.safeParse(value).success).toBe(true);
  });

  it.each([0, -1, 10.5, MAX_TRANSFER_CENTS + 1, Number.NaN])("rejects %s", (value) => {
    expect(amountCentsSchema.safeParse(value).success).toBe(false);
  });

  it("formats cents as BRL", () => {
    expect(formatBRL(123456).replace(/\s/g, " ")).toBe("R$ 1.234,56");
  });
});

describe("hasPgErrorCode", () => {
  it("finds a driver error code nested in the cause chain", () => {
    const wrapped = new Error("query failed", { cause: Object.assign(new Error("dup"), { code: "23505" }) });
    expect(hasPgErrorCode(wrapped, "23505")).toBe(true);
    expect(hasPgErrorCode(new Error("other"), "23505")).toBe(false);
  });
});

describe("loadEnv", () => {
  it("fails fast with a readable message when configuration is invalid", () => {
    expect(() => loadEnv({ DATABASE_URL: "nope", REDIS_URL: "redis://x", JWT_SECRET: "short" })).toThrow(
      /Invalid environment/,
    );
  });
});
