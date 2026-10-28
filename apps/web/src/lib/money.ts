const formatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export const formatBRL = (cents: number) => formatter.format(cents / 100);

/**
 * Converts what a Brazilian user types ("1.234,56", "12,5", "10") into
 * integer cents without ever going through floating point arithmetic.
 * Returns null for anything that is not a valid positive amount.
 */
export function parseBRLToCents(input: string): number | null {
  const value = input.trim().replace(/^R\$\s?/, "");
  // Either plain digits ("1234,56") or correctly grouped thousands ("1.234,56").
  // "10.5" is rejected instead of being silently read as 105 reais.
  const match = /^(\d{1,9}|\d{1,3}(?:\.\d{3}){1,2})(?:,(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const reais = Number(match[1]!.replace(/\./g, ""));
  const cents = Number((match[2] ?? "0").padEnd(2, "0"));
  const total = reais * 100 + cents;
  return total > 0 ? total : null;
}
