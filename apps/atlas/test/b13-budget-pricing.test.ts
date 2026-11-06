import type { BudgetLine } from "@xos/data/finance";
import { describe, expect, it } from "vitest";
import { mergeLines, typedLine } from "../lib/finance/live-lines";

/** B13 (RRR-237): the new line fields merge live and show at once while their save is in flight. */

const line = (over: Partial<BudgetLine> = {}): BudgetLine =>
  ({
    id: "l1",
    quantity: 2,
    unitPriceMinor: 1000,
    extendedMinor: 2000,
    markupBp: null,
    clientUnitPriceMinor: null,
    excludedFromQuote: false,
    etcMinor: null,
    updatedAt: "2026-11-01T00:00:00Z",
    ...over,
  }) as BudgetLine;

describe("typedLine", () => {
  it("shows a typed markup, client price, exclusion and ETC at once", () => {
    const [typed] = typedLine([line()], "l1", {
      description: "x",
      lineType: "Cost",
      urid: "5000.04.02",
      costCenterId: null,
      gradeCode: null,
      elementId: null,
      quantity: 3,
      unitBasis: null,
      unitPriceMinor: 1000,
      xyz: "X",
      xyzBasis: "Declared",
      markupBp: 2500,
      clientUnitPriceMinor: 1500,
      excludedFromQuote: true,
      etcMinor: 7,
    });
    expect(typed).toMatchObject({
      markupBp: 2500,
      clientUnitPriceMinor: 1500,
      excludedFromQuote: true,
      etcMinor: 7,
      extendedMinor: 3000,
    });
  });
});

describe("mergeLines", () => {
  it("takes someone else's pricing for a line nobody here has open", () => {
    const theirs = line({ markupBp: 1000, etcMinor: 9, updatedAt: "2026-11-02T00:00:00Z" });
    const { lines } = mergeLines([line()], [theirs], new Set());
    expect(lines[0]).toMatchObject({ markupBp: 1000, etcMinor: 9 });
  });

  it("keeps what this person typed on a line they hold", () => {
    const mine = line({ markupBp: 500 });
    const theirs = line({ markupBp: 1000, updatedAt: "2026-11-02T00:00:00Z" });
    const { lines } = mergeLines([mine], [theirs], new Set(["l1"]));
    expect(lines[0]?.markupBp).toBe(500);
  });
});
