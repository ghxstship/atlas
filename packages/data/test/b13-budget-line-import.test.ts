import { describe, expect, it } from "vitest";
import {
  markInFileDuplicates,
  runImportJobs,
  validateRow,
  type ImportDestination,
  type ImportJobKind,
  type ImportStore,
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
const COLUMNS = NAMES.map((fieldName, index) => ({
  index,
  fieldName,
})) as unknown as MappedColumn[];
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

  it.each(["Unpriced", "unpriced"])("reads the word %j as a NULL price, never zero", async (price) => {
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

  it("reads a blank cell as saying nothing, so an update leaves the value alone", async () => {
    const v = await check({ description: "Deck", urid: "5000.04.02" });
    expect(v.state).toBe("Valid");
    expect(v.values).not.toHaveProperty("line_type");
    expect(v.values).not.toHaveProperty("quantity");
    expect(v.values).not.toHaveProperty("unit_price_minor");
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

/** A budget line import through validate and commit, over memory. Line 2 exists, with a declared tag. */
function memoryImport(csv: string, headers: readonly (keyof typeof HEADER_FIELD)[]) {
  const writes: Record<string, unknown>[] = [];
  const queue: { kind: ImportJobKind; jobId: string; subjectId: string }[] = [
    { kind: "import.validate", jobId: "q1", subjectId: "j1" },
  ];
  const rows: { id: string; rowNumber: number; state: string; match: string | null }[] = [];
  const job = {
    id: "j1",
    orgId: "o1",
    targetCode: "budget_lines",
    source: "CSV",
    path: "p/u.csv",
    filename: "lines.csv",
    status: "Mapped",
    profileId: null,
    sheetName: null,
    runOfShowId: null,
    projectId: null,
    budgetId: "b1",
  };
  const store = {
    lookups: {
      ...lookups,
      strongKeyMatch: async () => null,
      budgetDestination: async () => ({ id: "b1", exponent: 2, maxLineNumber: 3 + writes.length }),
      destinationKeyMatch: async (_job: unknown, keys: Record<string, string>) =>
        keys["line_number"] === "2" ? "line2" : null,
      budgetLineTag: async () => ({ urid: "5000.04.02", xyzBasis: "Declared" }),
      async create(_org: string, target: string, values: Record<string, unknown>) {
        writes.push({ op: "create", target, ...values });
        return `new-${writes.length}`;
      },
      async update(target: string, id: string, values: Record<string, unknown>) {
        writes.push({ op: "update", target, id, ...values });
        return { id };
      },
    },
    async claim(kind: ImportJobKind) {
      const mine = queue.filter((q) => q.kind === kind);
      for (const m of mine) queue.splice(queue.indexOf(m), 1);
      return mine.map((m) => ({ jobId: m.jobId, subjectId: m.subjectId }));
    },
    finishJob: async (_id: string, ok: boolean) => (ok ? "Succeeded" : "Failed"),
    job: async () => ({ ...job }),
    batchJob: async () => "j1",
    scanStatus: async () => "Clean",
    download: async () => new TextEncoder().encode(csv),
    targetFields: async () => FIELDS,
    profileMapping: async () => new Map(),
    setStatus: async (_id: string, status: string) => {
      job.status = status;
    },
    mappedColumns: async () =>
      headers.map((h, index) => ({ index, fieldName: HEADER_FIELD[h] })) as MappedColumn[],
    async recordRow(input: { rowNumber: number; state: string }) {
      const id = `r${input.rowNumber}`;
      rows.push({ id, rowNumber: input.rowNumber, state: input.state, match: null });
      return id;
    },
    recordCellIssues: async () => {},
    async recordMatch(rowId: string, targetId: string) {
      const r = rows.find((x) => x.id === rowId);
      if (r) r.match = targetId;
    },
    validRows: async () =>
      rows
        .filter((r) => r.state === "Valid")
        .map((r) => ({ id: r.id, rowNumber: r.rowNumber, matchedId: r.match, mergeInto: null })),
    commitWrite: async () => {},
    refuseRow: async () => {},
    finishBatch: async () => {
      job.status = "Committed";
    },
    orgSlug: async () => "northwind-live",
    notifyFinished: async () => {},
  } as unknown as ImportStore;
  return {
    writes,
    rows,
    async validateAndCommit() {
      await runImportJobs(store, "w");
      job.status = "Committing";
      queue.push({ kind: "import.commit", jobId: "q2", subjectId: "batch" });
      await runImportJobs(store, "w");
    },
  };
}

const HEADER_FIELD = {
  number: "line_number",
  description: "description",
  urid: "urid",
  quantity: "quantity",
  price: "unit_price",
} as const;

describe("committing budget lines", () => {
  it("updates a numbered line with only the cells the sheet supplied", async () => {
    const run = memoryImport("number,description,urid\n2,New words,5000.04.02\n", [
      "number",
      "description",
      "urid",
    ]);
    await run.validateAndCommit();
    expect(run.writes).toEqual([
      {
        op: "update",
        target: "budget_lines",
        id: "line2",
        description: "New words",
        urid: "5000.04.02",
      },
    ]);
  });

  it("clears a price only for the word Unpriced, and writes a supplied quantity", async () => {
    const run = memoryImport(
      "number,description,urid,quantity,price\n2,Deck,5000.04.02,4,Unpriced\n",
      ["number", "description", "urid", "quantity", "price"],
    );
    await run.validateAndCommit();
    expect(run.writes[0]).toMatchObject({ op: "update", quantity: 4, unit_price_minor: null });
  });

  it("creates a new line with the defaults, its price NULL, after writing numbered rows", async () => {
    const run = memoryImport(
      "number,description,urid\n,Appended first,5000.04.02\n9,Numbered,5000.04.02\n,Appended last,5000.04.02\n",
      ["number", "description", "urid"],
    );
    await run.validateAndCommit();
    expect(run.writes.map((w) => [w["description"], w["line_number"]])).toEqual([
      ["Numbered", 9],
      ["Appended first", 5],
      ["Appended last", 6],
    ]);
    expect(run.writes[1]).toMatchObject({
      budget_id: "b1",
      quantity: 1,
      line_type: "Cost",
      unit_price_minor: null,
    });
  });
});
