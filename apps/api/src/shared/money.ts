import { z } from "zod";

/**
 * Money is always handled as an integer number of cents. Floating point is
 * never used for amounts. In Postgres the columns are BIGINT; in TypeScript we
 * keep values inside Number.MAX_SAFE_INTEGER, which is far above any amount
 * this product allows (see MAX_TRANSFER_CENTS).
 */
export const MAX_TRANSFER_CENTS = 100_000_000; // R$ 1.000.000,00

export const amountCentsSchema = z
  .number()
  .int("Amount must be an integer number of cents")
  .positive("Amount must be greater than zero")
  .max(MAX_TRANSFER_CENTS, `Amount must be at most ${MAX_TRANSFER_CENTS} cents`);

export function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    cents / 100,
  );
}
