import { describe, expect, it } from "vitest";
import {
  cellFromDate,
  cellFromPrimitive,
  columnLetter,
  columnOrdinal,
  numberText,
} from "../src/cell.ts";
import { parseCsv, parseCsvRows } from "../src/csv.ts";
import { normalizeCell, normalizeNumber, normalizeText } from "../src/normalize.ts";

describe("column letters", () => {
  it("round-trips ordinals and letters", () => {
    for (const [n, l] of [
      [1, "A"],
      [26, "Z"],
      [27, "AA"],
      [48, "AV"],
      [702, "ZZ"],
      [703, "AAA"],
    ] as const) {
      expect(columnLetter(n)).toBe(l);
      expect(columnOrdinal(l)).toBe(n);
    }
  });

  it("refuses invalid input", () => {
    expect(() => columnLetter(0)).toThrow(RangeError);
    expect(() => columnLetter(1.5)).toThrow(RangeError);
    expect(() => columnOrdinal("a1")).toThrow(RangeError);
  });
});

describe("cells", () => {
  it("classifies primitives", () => {
    expect(cellFromPrimitive(null)).toEqual({ kind: "empty", text: "" });
    expect(cellFromPrimitive(undefined, "=A1")).toEqual({
      kind: "empty",
      text: "",
      formula: "=A1",
    });
    expect(cellFromPrimitive("x")).toEqual({ kind: "string", text: "x" });
    expect(cellFromPrimitive(1.5)).toEqual({ kind: "number", text: "1.5" });
    expect(cellFromPrimitive(true, "=TRUE()")).toEqual({
      kind: "boolean",
      text: "TRUE",
      formula: "=TRUE()",
    });
    expect(cellFromPrimitive(false)).toEqual({ kind: "boolean", text: "FALSE" });
    expect(() => cellFromPrimitive({})).toThrow(TypeError);
  });

  it("prints negative zero as zero and refuses non-finite numbers", () => {
    expect(numberText(-0)).toBe("0");
    expect(() => numberText(Number.NaN)).toThrow(RangeError);
  });

  it("reads wall-clock dates, date-times and times in UTC fields", () => {
    expect(cellFromDate(new Date(Date.UTC(2026, 8, 15)))).toEqual({
      kind: "date",
      text: "2026-09-15",
    });
    expect(cellFromDate(new Date(Date.UTC(2026, 8, 30, 13, 5, 0, 999)))).toEqual({
      kind: "datetime",
      text: "2026-09-30T13:05:01",
    });
    expect(cellFromDate(new Date(Date.UTC(1899, 11, 30, 18, 30)), "=A1")).toEqual({
      kind: "time",
      text: "18:30:00",
      formula: "=A1",
    });
  });
});

describe("normalization", () => {
  it("collapses whitespace including no-break spaces", () => {
    expect(normalizeText("  a \t b\n\u00a0c  ")).toBe("a b c");
  });

  it("prints numbers with ten decimals at most and no exponent", () => {
    expect(normalizeNumber(1800)).toBe("1800");
    expect(normalizeNumber(0.1 + 0.2)).toBe("0.3");
    expect(normalizeNumber(1 / 3)).toBe("0.3333333333");
    expect(normalizeNumber(1e-7)).toBe("0.0000001");
    expect(normalizeNumber(-0.00000000001)).toBe("0");
    expect(normalizeNumber(-2.5)).toBe("-2.5");
    expect(() => normalizeNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("normalizes every cell kind", () => {
    expect(normalizeCell({ kind: "empty", text: "" })).toBe("");
    expect(normalizeCell({ kind: "string", text: " a  b " })).toBe("a b");
    expect(normalizeCell({ kind: "error", text: "#N/A" })).toBe("#N/A");
    expect(normalizeCell({ kind: "number", text: "5000" })).toBe("5000");
    expect(normalizeCell({ kind: "boolean", text: "TRUE" })).toBe("TRUE");
    expect(normalizeCell({ kind: "date", text: "2026-09-15" })).toBe("2026-09-15");
    expect(normalizeCell({ kind: "time", text: "08:00:00" })).toBe("08:00:00");
  });
});

describe("csv", () => {
  it("reads quoted fields, escaped quotes, CRLF and a byte order mark", () => {
    const rows = parseCsvRows('\ufeffa,b\r\n"x, y","say ""hi"""\r\n"multi\nline",z\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "z"],
    ]);
  });

  it("keys records by header with line numbers", () => {
    const table = parseCsv("code,name\n1000,Cash\n1100,AR");
    expect(table.headers).toEqual(["code", "name"]);
    expect(table.records).toEqual([
      { line: 2, values: { code: "1000", name: "Cash" } },
      { line: 3, values: { code: "1100", name: "AR" } },
    ]);
  });

  it("refuses ragged rows, duplicate headers, stray and unterminated quotes", () => {
    expect(() => parseCsv("a,b\n1\n")).toThrow(/has 1 fields/);
    expect(() => parseCsv("a,a\n1,2\n")).toThrow(/appears twice/);
    expect(() => parseCsv("")).toThrow(/no header/);
    expect(() => parseCsvRows('a,b"c\n')).toThrow(/Stray quote/);
    expect(() => parseCsvRows('a,"b\n')).toThrow(/Unterminated/);
  });
});
