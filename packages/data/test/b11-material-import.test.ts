import { describe, expect, it } from "vitest";
import {
  markInFileDuplicates,
  validateRow,
  zonedInstant,
  type ImportDestination,
  type MappedColumn,
  type MaterialMatch,
  type TargetLookups,
} from "../src/import-worker.ts";

/** Material import (B11, RRR-235, G-106): needs and order lines as targets, with catalogue matching. */

const NEED_FIELDS = [
  { name: "description", required: true, strongKey: true },
  { name: "quantity", required: true, strongKey: false },
  { name: "asset_class_id", required: false, strongKey: false },
  { name: "unit_basis", required: false, strongKey: false },
  { name: "needed_from", required: false, strongKey: false },
  { name: "needed_to", required: false, strongKey: false },
  { name: "note", required: false, strongKey: false },
];
const LINE_FIELDS = [
  { name: "line_number", required: false, strongKey: true },
  { name: "description", required: true, strongKey: false },
  { name: "quantity", required: true, strongKey: false },
  { name: "vendor_sku", required: false, strongKey: false },
  { name: "element_id", required: false, strongKey: false },
  { name: "unit_basis", required: false, strongKey: false },
  { name: "unit_price_minor", required: false, strongKey: false },
];

const columns = (fields: readonly string[]): MappedColumn[] =>
  fields.map((fieldName, index) => ({ index, fieldName }));

const ELEMENT = "3000.05.01-GHXST-014";

function lookups(match: MaterialMatch | null = null): TargetLookups {
  const refused = async () => {
    throw new Error("not used");
  };
  return {
    counterpartyTypeExists: async () => false,
    jurisdictionExists: async () => false,
    vendorIdByName: async () => null,
    elementExists: async (id) => id === ELEMENT,
    assetClassId: async (_o, name) => (name === "Truss" ? "class1" : null),
    venueId: async () => null,
    strongKeyMatch: async () => null,
    create: refused,
    update: refused,
    runOfShow: async () => null,
    spaceId: async () => null,
    scopeNodeId: async () => null,
    counterpartyIdByName: async () => null,
    destinationKeyMatch: async () => null,
    nextCuePosition: async () => 1,
    cueCalled: async () => false,
    canonCodeExists: async () => true,
    unitExists: async (u) => u === "each",
    materialMatch: async () => match,
    projectTimeZone: async () => "America/New_York",
    purchaseOrderState: async () => "Proposed",
    nextPoLineNumber: async () => 3,
  };
}

const NEED_DESTINATION: ImportDestination = { project: { id: "prj1" }, jobId: "j1" };
const LINE_DESTINATION: ImportDestination = { jobId: "j1" };

const need = (
  cells: readonly string[],
  fields: readonly string[],
  match: MaterialMatch | null = null,
) =>
  validateRow(
    "o",
    "procurement_needs",
    NEED_FIELDS,
    columns(fields),
    { rowNumber: 2, cells: [...cells] },
    lookups(match),
    NEED_DESTINATION,
  );
const line = (
  cells: readonly string[],
  fields: readonly string[],
  match: MaterialMatch | null = null,
) =>
  validateRow(
    "o",
    "po_lines",
    LINE_FIELDS,
    columns(fields),
    { rowNumber: 2, cells: [...cells] },
    lookups(match),
    LINE_DESTINATION,
  );

const skuMatch: MaterialMatch = {
  source: "vendor_sku",
  elementId: ELEMENT,
  assetClassId: null,
  unitPriceMinor: 4200,
  currencyCode: "USD",
  orderCurrencyCode: "USD",
};

describe("zonedInstant", () => {
  it("reads a date in the project's time zone, not UTC", () => {
    expect(zonedInstant("2027-06-01", "America/New_York")).toBe("2027-06-01T04:00:00.000Z");
    expect(zonedInstant("2027-01-15 09:30", "America/New_York")).toBe("2027-01-15T14:30:00.000Z");
  });

  it("refuses what it cannot read", () => {
    expect(zonedInstant("next week", "UTC")).toBeNull();
    expect(zonedInstant("2027-13-45", "UTC")).toBeNull();
  });
});

describe("a need row", () => {
  it("is valid with a description and a quantity, and its strong key is trimmed lower case", async () => {
    const row = await need(["  Shure SM58 ", "12"], ["description", "quantity"]);
    expect(row).toMatchObject({
      state: "Valid",
      values: { description: "Shure SM58", quantity: 12 },
      strongKeys: { description: "shure sm58" },
      materialMatch: "Unmatched",
    });
  });

  it("refuses a missing or non-positive quantity", async () => {
    expect((await need(["SM58", ""], ["description", "quantity"])).state).toBe("Invalid");
    const zero = await need(["SM58", "0"], ["description", "quantity"]);
    expect(zero.issues[0]?.issue).toBe("invalid_quantity");
  });

  it("names a class by a column or by the catalogue, and says so", async () => {
    const named = await need(["SM58", "1", "Truss"], ["description", "quantity", "asset_class_id"]);
    expect(named).toMatchObject({ values: { asset_class_id: "class1" }, materialMatch: "Matched" });
    const matched = await need(["Truss sections", "1"], ["description", "quantity"], {
      ...skuMatch,
      source: "asset_class",
      assetClassId: "class2",
    });
    expect(matched).toMatchObject({
      values: { asset_class_id: "class2" },
      materialMatch: "Matched",
    });
  });

  it("refuses an unknown class and unit", async () => {
    const bad = await need(
      ["SM58", "1", "Fog", "yards"],
      ["description", "quantity", "asset_class_id", "unit_basis"],
    );
    expect(bad.issues.map((i) => i.issue).sort()).toEqual(["unknown_asset_class", "unknown_unit"]);
  });

  it("turns two dates into the need's window, in the project's zone", async () => {
    const row = await need(
      ["SM58", "1", "2027-06-01", "2027-06-03"],
      ["description", "quantity", "needed_from", "needed_to"],
    );
    expect(row.values["needed_during"]).toBe("[2027-06-01T04:00:00.000Z,2027-06-03T04:00:00.000Z)");
  });

  it("refuses one date alone, or dates out of order", async () => {
    const one = await need(["SM58", "1", "2027-06-01"], ["description", "quantity", "needed_from"]);
    expect(one.state).toBe("Invalid");
    const backwards = await need(
      ["SM58", "1", "2027-06-03", "2027-06-01"],
      ["description", "quantity", "needed_from", "needed_to"],
    );
    expect(backwards.issues[0]?.issue).toBe("invalid_time");
  });
});

describe("an order line row", () => {
  it("takes the element and a blank price from an exact SKU", async () => {
    const row = await line(
      ["SM58", "2", "SKU-1"],
      ["description", "quantity", "vendor_sku"],
      skuMatch,
    );
    expect(row).toMatchObject({
      state: "Valid",
      values: { element_id: ELEMENT, unit_price_minor: 4200, quantity: 2 },
      materialMatch: "Matched",
      matchNote: null,
    });
    expect(row.values["vendor_sku"]).toBeUndefined();
  });

  it("keeps a price the sheet gives", async () => {
    const row = await line(
      ["SM58", "2", "SKU-1", "999"],
      ["description", "quantity", "vendor_sku", "unit_price_minor"],
      skuMatch,
    );
    expect(row.values["unit_price_minor"]).toBe(999);
  });

  it("leaves the price blank, with a note, when the vendor's price is in another currency", async () => {
    const row = await line(["SM58", "2", "SKU-2"], ["description", "quantity", "vendor_sku"], {
      ...skuMatch,
      currencyCode: "EUR",
    });
    expect(row.values["unit_price_minor"]).toBeUndefined();
    expect(row).toMatchObject({ materialMatch: "Matched", matchNote: "price_currency_differs" });
  });

  it("writes an unmatched row as free text and says so", async () => {
    const row = await line(["Fog machine", "1"], ["description", "quantity"]);
    expect(row).toMatchObject({ state: "Valid", materialMatch: "Unmatched" });
    expect(row.values["element_id"]).toBeUndefined();
  });

  it("uses its line number as the strong key, when there is one", async () => {
    const row = await line(["4", "SM58", "1"], ["line_number", "description", "quantity"]);
    expect(row.strongKeys).toEqual({ line_number: "4" });
    expect((await line(["SM58", "1"], ["description", "quantity"])).strongKeys).toEqual({});
  });
});

describe("in-file duplicates", () => {
  it("marks a need that repeats an earlier row's description", async () => {
    const fields = ["description", "quantity"];
    const a = await need(["SM58", "1"], fields);
    const b = await need([" sm58 ", "2"], fields);
    const marked = markInFileDuplicates("procurement_needs", columns(fields), [a, b]);
    expect(marked.map((m) => m.state)).toEqual(["Valid", "Invalid"]);
    expect(marked[1]?.issues[0]?.issue).toBe("duplicate_in_file");
  });

  it("marks an order line that repeats a line number", async () => {
    const fields = ["line_number", "description", "quantity"];
    const a = await line(["1", "A", "1"], fields);
    const b = await line(["1", "B", "1"], fields);
    expect(markInFileDuplicates("po_lines", columns(fields), [a, b]).map((m) => m.state)).toEqual([
      "Valid",
      "Invalid",
    ]);
  });
});
