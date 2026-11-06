import { describe, expect, it } from "vitest";
import { EQUIPMENT_LINE_LIMIT, parseEquipmentBlock } from "@/lib/quick-add/equipment";

function lines(text: string) {
  const parsed = parseEquipmentBlock(text);
  if (!parsed.ok) throw new Error(parsed.code);
  return parsed.lines;
}

describe("parseEquipmentBlock (B11, G-107)", () => {
  it.each([
    ["12 x SM58", 12, "SM58"],
    ["12x SM58", 12, "SM58"],
    ["12 × SM58", 12, "SM58"],
    ["SM58 x 12", 12, "SM58"],
    ["12 SM58", 12, "SM58"],
    ["SM58 (12)", 12, "SM58"],
    ["qty 4 truss", 4, "truss"],
    ["Qty: 4 truss", 4, "truss"],
    ["SM58\t12", 12, "SM58"],
    ["12\tSM58", 12, "SM58"],
    ["12 ea SM58", 12, "SM58"],
    ["12 pcs of SM58", 12, "SM58"],
    ["12 unidades de SM58", 12, "SM58"],
    ["12 uds. SM58", 12, "SM58"],
    ["cantidad 4 truss", 4, "truss"],
    ["2,5 cable", 2.5, "cable"],
  ])("reads %s", (text, quantity, item) => {
    expect(lines(text)).toEqual([
      { lineNumber: 1, quantity, quantityAssumed: false, item, group: null },
    ]);
  });

  it("strips bullets", () => {
    expect(lines("- 12 x SM58\n* 2 x Truss\n• 3 x Clamp\n1. 4 x Rope\n2) 5 x Pin").map((l) => l.quantity)).toEqual([
      12, 2, 3, 4, 5,
    ]);
  });

  it("does not read a part number's digits as a bullet or a quantity", () => {
    expect(lines("SM58")[0]).toMatchObject({ item: "SM58", quantity: 1, quantityAssumed: true });
  });

  it("reads a line ending in a colon as a heading for what follows", () => {
    const read = lines("Audio:\n12 x SM58\n\nIluminación:\n4 x Par");
    expect(read.map((l) => [l.group, l.item])).toEqual([
      ["Audio", "SM58"],
      ["Iluminación", "Par"],
    ]);
  });

  it("skips blank lines and keeps the line numbers of the block", () => {
    expect(lines("\n\n2 x A\n\n3 x B").map((l) => l.lineNumber)).toEqual([3, 5]);
  });

  it("flags a quantity it assumed", () => {
    expect(lines("Fog machine")).toEqual([
      { lineNumber: 1, quantity: 1, quantityAssumed: true, item: "Fog machine", group: null },
    ]);
  });

  it("takes zero as no quantity, so the line is not lost", () => {
    expect(lines("0 x SM58")[0]).toMatchObject({ quantityAssumed: true, item: "0 x SM58" });
  });

  it("refuses above the limit, counting only lines with text", () => {
    const at = Array.from({ length: EQUIPMENT_LINE_LIMIT }, (_, i) => `1 x Item ${i}`).join("\n\n");
    expect(parseEquipmentBlock(at).ok).toBe(true);
    expect(parseEquipmentBlock(`${at}\n1 x One more`)).toEqual({
      ok: false,
      code: "equipment_too_many",
    });
  });

  it("reads Windows line ends", () => {
    expect(lines("2 x A\r\n3 x B").map((l) => l.item)).toEqual(["A", "B"]);
  });
});
