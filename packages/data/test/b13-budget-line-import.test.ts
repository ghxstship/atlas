import { describe, expect, it } from "vitest";
import {
  markInFileDuplicates,
  validateRow,
  type ImportDestination,
  type MappedColumn,
  type TargetLookups,
} from "../src/import-worker.ts";

/** B13 (RRR-237, G-214): budget lines as an import target, per-cell reasons and NULL-aware prices. */

const FIELDS = [
  { name: "line_number", required: false, strongKey: true },
  { name: "description", required: true, strongKey: false },
  { name: "urid", required: true, strongKey: false },
  { name: "quantity", required: false, strongKey: false },
  { name: "unit_price", required: false, strongKey: false },
  { name: "line_type", required: false, strongKey: false },
  { name: "cost_center", required: false, strongKey: false },
  { name: "xyz", required: false, strongKey: false },
  { name: "markup_percent", required: false, strongKey: false },
  { name: "client_unit_price", required: false, strongKey: false },
  { name: "excluded_from_quote", required: false, strongKey: false },
];
const NAMES = FIELDS.map((f) => f.name);
const COLUMNS = NAMES.map((fieldName, index) => ({ index, fieldName })) as unknown as MappedColumn[];
const BUDGET: ImportDestination = { budget: { id: "b1", exponent: 2, maxLineNumber: 3 } };

const lookups = {
  uridExists: async (v: string) => v === "5000.04.02" || v === "5000",
  uridXyz: async (v: string) => (v === "5000.04.02" ? "Y" : null),
  costCenterId: async (_o: string, v: string) => (v === "CC1" ? "cc1" : null),
} as unknown as TargetLookups;

function row(values: Partial<Record<(typeof NAMES)[number], string>>) {
  return {
    rowNumber: 2,
    cells: NAMES.map((n) => values[n] ?? ""),
  };
}

const check = (values: Partial<Record<string, string>>, destination = BUDGET) =>
  validateRow("o1", "budget_lines", FIELDS, COLUMNS, row(values), lookups, destination);

describe("validateRow budget_lines", () => {
  it("reads a full row", async () => {
    const v = await check({
      line_number: "4",
      description: "Stage deck",
      urid: "5000.04.02",
      quantity: "2",
      unit_price: "1,250.50",
      line_type: "labor",
      cost_center: "CC1",
      markup_percent: "25",
      client_unit_price: "1600",
      excluded_from_quote: "yes",
    });
    expect(v.state).toBe("Valid");
    expect(v.values).toMatchObject({
      line_number: 4,
      description: "Stage deck",
      urid: "5000.04.02",
      quantity: 2,
      unit_price_minor: 125050,
      line_type: "Labor",
      cost_center_id: "cc1",
      xyz: "Y",
      xyz_basis: "Category",
      markup_bp: 2500,
      client_unit_price_minor: 160000,
      excluded_from_quote: true,
    });
    expect(v.strongKeys).toEqual({ line_number: "4" });
  });

  it.each(["", "Unpriced", "unpriced"])("reads the price %j as NULL, never zero", async (price) => {
    const v = await check({ description: "Deck", urid: "5000.04.02", unit_price: price });
    expect(v.state).toBe("Valid");
    expect(v.values["unit_price_minor"]).toBeNull();
  });

  it("uses the budget currency's exponent", async () => {
    const v = await check(
      { description: "Deck", urid: "5000.04.02", unit_price: "1500" },
      { budget: { id: "b1", exponent: 0, maxLineNumber: 0 } },
    );
    expect(v.values["unit_price_minor"]).toBe(1500);
  });

  it("defaults the type to Cost and the quantity to 1", async () => {
    const v = await check({ description: "Deck", urid: "5000.04.02" });
    expect(v.values["line_type"]).toBe("Cost");
    expect(v.values["quantity"]).toBe(1);
  });

  it("declares a tag when given", async () => {
    const v = await check({ description: "Deck", urid: "5000", xyz: "z" });
    expect(v.values).toMatchObject({ xyz: "Z", xyz_basis: "Declared" });
  });

  it.each([
    ["urid", "9999.99", "unknown_urid"],
    ["line_number", "two", "invalid_line_number"],
    ["quantity", "-1", "invalid_quantity"],
    ["unit_price", "a lot", "invalid_price"],
    ["line_type", "Other", "invalid_line_type"],
    ["cost_center", "NOPE", "unknown_cost_center"],
    ["xyz", "Q", "invalid_xyz"],
    ["markup_percent", "1001", "invalid_markup"],
    ["client_unit_price", "x", "invalid_price"],
    ["excluded_from_quote", "maybe", "invalid_boolean"],
  ])("gives %s a per-cell reason for %j", async (field, value, issue) => {
    const v = await check({ description: "Deck", urid: "5000.04.02", [field]: value });
    expect(v.state).toBe("Invalid");
    expect(v.issues).toContainEqual({ columnIndex: NAMES.indexOf(field), issue });
  });

  it("needs a tag for a discipline, which has none of its own", async () => {
    const v = await check({ description: "Deck", urid: "5000" });
    expect(v.issues).toContainEqual({ columnIndex: NAMES.indexOf("urid"), issue: "xyz_required" });
  });

  it("marks a repeated line number within the file", async () => {
    const a = await check({ line_number: "4", description: "One", urid: "5000.04.02" });
    const b = await check({ line_number: "4", description: "Two", urid: "5000.04.02" });
    const marked = markInFileDuplicates("budget_lines", COLUMNS, [a, b]);
    expect(marked[0]?.state).toBe("Valid");
    expect(marked[1]?.issues).toContainEqual({
      columnIndex: NAMES.indexOf("line_number"),
      issue: "duplicate_in_file",
    });
  });
});
