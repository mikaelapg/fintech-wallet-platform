import { describe, expect, it } from "vitest";
import { formatBRL, parseBRLToCents } from "./money";

describe("parseBRLToCents", () => {
  it.each([
    ["10", 1000],
    ["10,5", 1050],
    ["10,05", 1005],
    ["1.234,56", 123456],
    ["R$ 0,01", 1],
    [" 7,90 ", 790],
  ])("parses %s as %i cents", (input, expected) => {
    expect(parseBRLToCents(input)).toBe(expected);
  });

  it.each(["", "0", "0,00", "abc", "10,555", "-5", "10.5"])("rejects %s", (input) => {
    expect(parseBRLToCents(input)).toBeNull();
  });

  it("avoids floating point errors that 0.1 + 0.2 style math would cause", () => {
    expect(parseBRLToCents("0,29")).toBe(29);
    expect(parseBRLToCents("1.000.000,07")).toBe(100000007);
  });
});

describe("formatBRL", () => {
  it("formats cents as Brazilian reais", () => {
    expect(formatBRL(123456).replace(/\s/g, " ")).toBe("R$ 1.234,56");
  });
});
