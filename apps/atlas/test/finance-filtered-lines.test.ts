import { describe, expect, it } from "vitest";
import { clearConditions, filterBudgetLines, hasConditions } from "@/lib/finance/filtered-lines";

const lines = [
  { id: "l1", extendedMinor: 30000 },
  { id: "l2", extendedMinor: null },
  { id: "l3", extendedMinor: 40000 },
  { id: "l4", extendedMinor: 12500 },
];

describe("budget lines under custom field conditions (P10)", () => {
  it("keeps every line and its whole total without conditions", () => {
    const all = filterBudgetLines(lines, () => false, false);
    expect(all.shown).toHaveLength(4);
    expect(all).toMatchObject({ total: 4, filtered: false });
    expect(all.subtotal).toEqual({ total: null, priced: 82500, unpricedCount: 1 });
  });

  it("keeps the matching lines in order and totals only them", () => {
    const rental = new Set(["l1", "l4"]);
    const shown = filterBudgetLines(lines, (id) => rental.has(id), true);
    expect(shown.shown.map((l) => l.id)).toEqual(["l1", "l4"]);
    expect(shown).toMatchObject({ total: 4, filtered: true });
    expect(shown.subtotal).toEqual({ total: 42500, priced: 42500, unpricedCount: 0 });
  });

  it("stays NULL-aware: an unpriced shown line blanks the subtotal, never zero", () => {
    const shown = filterBudgetLines(lines, (id) => id === "l2" || id === "l3", true);
    expect(shown.subtotal).toEqual({ total: null, priced: 40000, unpricedCount: 1 });
  });

  it("reads no lines as no total", () => {
    const none = filterBudgetLines(lines, () => false, true);
    expect(none.shown).toHaveLength(0);
    expect(none.subtotal.total).toBeNull();
  });

  it("finds and clears only the Add filter conditions", () => {
    const search = { budget: "b1", view: "matrix", "cf.tag": "rental", "f.urid.contains": "5000" };
    expect(hasConditions(search)).toBe(true);
    expect(hasConditions({ budget: "b1", in: "EUR" })).toBe(false);
    expect(clearConditions(search)).toEqual({ "cf.tag": null, "f.urid.contains": null });
  });
});
