import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  drainImportJobs,
  ImportWriteError,
  readSheet,
  runImportJobs,
  UnreadableUploadError,
  validateRow,
  type ImportJobKind,
  type ImportStore,
  type TargetLookups,
} from "../src/import-worker.ts";

type Row = Record<string, unknown>;

const FIELDS: Record<string, { name: string; required: boolean; strongKey: boolean }[]> = {
  counterparties: [
    { name: "name", required: true, strongKey: false },
    { name: "counterparty_type", required: false, strongKey: false },
  ],
  venues: [
    { name: "name", required: true, strongKey: false },
    { name: "street_address", required: false, strongKey: false },
    { name: "locality", required: false, strongKey: false },
    { name: "postal_code", required: false, strongKey: false },
    { name: "jurisdiction_id", required: true, strongKey: false },
    { name: "time_zone", required: true, strongKey: false },
  ],
  vendor_products: [
    { name: "vendor_sku", required: true, strongKey: true },
    { name: "vendor_name", required: true, strongKey: false },
    { name: "element_id", required: false, strongKey: false },
    { name: "unit_price_minor", required: false, strongKey: false },
    { name: "currency_code", required: false, strongKey: false },
    { name: "lead_time_days", required: false, strongKey: false },
  ],
  asset_units: [
    { name: "asset_tag", required: true, strongKey: true },
    { name: "asset_class_id", required: true, strongKey: false },
    { name: "home_venue_id", required: false, strongKey: false },
  ],
};

function lookups(writes: Row[]): TargetLookups {
  return {
    counterpartyTypeExists: async (t) => t === "Sponsor",
    jurisdictionExists: async (id) => id === "US-FL-MIAMI-DADE",
    vendorIdByName: async (_o, n) => (n === "Harborline" ? "ven1" : null),
    elementExists: async (id) => id === "0000.01.01-XOS-001",
    assetClassId: async (_o, v) => (v === "Truss" ? "ac1" : null),
    venueId: async (_o, v) => (v === "Pier 9" ? "v9" : null),
    strongKeyMatch: async (_o, _t, values) => (values["asset_tag"] === "A-1" ? "unit1" : null),
    async create(_o, target, values) {
      if (values["name"] === "Explodes") throw new ImportWriteError("duplicate key value");
      writes.push({ op: "create", target, ...values });
      return `new-${writes.length}`;
    },
    async update(target, id, values) {
      writes.push({ op: "update", target, id, ...values });
      return { id };
    },
  };
}

function memoryStore(csv: string, targetCode = "counterparties", source = "CSV") {
  const writes: Row[] = [];
  const queue: { kind: ImportJobKind; jobId: string; subjectId: string; attempts: number }[] = [
    { kind: "import.detect", jobId: "q1", subjectId: "j1", attempts: 0 },
  ];
  const job = {
    id: "j1",
    orgId: "o",
    targetCode,
    source,
    path: "p/u.csv",
    filename: "c.csv",
    status: "Uploaded",
    profileId: null as string | null,
  };
  const columns: {
    index: number;
    header: string;
    suggested: string | null;
    fieldName: string | null;
  }[] = [];
  const rows: {
    id: string;
    rowNumber: number;
    state: string;
    reason: string | null;
    match: string | null;
    merge: { table: string; id: string } | null;
    written?: Row;
  }[] = [];
  const issues: { rowId: string; issue: string }[] = [];
  const finished: { jobId: string; ok: boolean }[] = [];
  let batchDone = false;
  const store: ImportStore = {
    lookups: lookups(writes),
    async claim(kind) {
      const mine = queue.filter((q) => q.kind === kind);
      for (const m of mine) queue.splice(queue.indexOf(m), 1);
      return mine.map((m) => ({ jobId: m.jobId, subjectId: m.subjectId }));
    },
    async finishJob(jobId, ok) {
      finished.push({ jobId, ok });
      return ok ? "Succeeded" : "Failed";
    },
    job: async (id) => (id === job.id ? { ...job } : null),
    batchJob: async (id) => (id === "b1" ? "j1" : null),
    download: async () => new TextEncoder().encode(csv),
    targetFields: async (t) => FIELDS[t] ?? [],
    profileMapping: async () => new Map(),
    async setStatus(_id, status) {
      job.status = status;
    },
    async insertColumns(_id, _sheet, cols) {
      cols.forEach((c, i) =>
        columns.push({ index: i, header: c.header, suggested: c.suggested, fieldName: null }),
      );
    },
    mappedColumns: async () => columns.map((c) => ({ index: c.index, fieldName: c.fieldName })),
    async recordRow(input) {
      const id = `r${input.rowNumber}`;
      rows.push({
        id,
        rowNumber: input.rowNumber,
        state: input.state,
        reason: input.reason,
        match: null,
        merge:
          input.matchName === "Harbor Sound Rental"
            ? { table: "app.counterparties", id: "cp1" }
            : null,
      });
      return id;
    },
    async recordCellIssues(rowId, list) {
      for (const i of list) issues.push({ rowId, issue: i.issue });
    },
    async recordMatch(rowId, targetId) {
      const r = rows.find((x) => x.id === rowId);
      if (r) r.match = targetId;
    },
    validRows: async () =>
      rows
        .filter((r) => r.state === "Valid")
        .map((r) => ({ id: r.id, rowNumber: r.rowNumber, matchedId: r.match, mergeInto: r.merge })),
    async commitWrite(input) {
      const r = rows.find((x) => x.id === input.rowId);
      if (r) r.written = { action: input.action, target: input.targetId, before: input.before };
    },
    async refuseRow(rowId, reason) {
      const r = rows.find((x) => x.id === rowId);
      if (r) {
        r.state = "Refused";
        r.reason = reason;
      }
    },
    async finishBatch() {
      batchDone = true;
      job.status = "Committed";
    },
  };
  return {
    store,
    job,
    columns,
    rows,
    issues,
    writes,
    finished,
    queue,
    batchDone: () => batchDone,
    confirm(map: Record<string, string>) {
      for (const c of columns) c.fieldName = map[c.header] ?? c.suggested;
      queue.push({ kind: "import.validate", jobId: "q2", subjectId: "j1", attempts: 0 });
    },
    commit() {
      job.status = "Committing";
      queue.push({ kind: "import.commit", jobId: "q3", subjectId: "b1", attempts: 0 });
    },
  };
}

describe("import worker", () => {
  it("detects, validates and commits a customer spreadsheet", async () => {
    const csv =
      "Company,Type\nBayfront Catering,\nHarbor Sound Rental,Sponsor\n,Sponsor\nBad Type,Wizards\nExplodes,\n";
    const s = memoryStore(csv);
    await runImportJobs(s.store, "w");
    expect(s.job.status).toBe("Mapped");
    expect(s.columns.map((c) => c.suggested)).toEqual(["name", "counterparty_type"]);
    s.confirm({});
    await runImportJobs(s.store, "w");
    expect(s.job.status).toBe("Validated");
    expect(s.rows.map((r) => `${r.rowNumber}:${r.state}`)).toEqual([
      "2:Valid",
      "3:Valid",
      "4:Invalid",
      "5:Invalid",
      "6:Valid",
    ]);
    expect(s.issues).toEqual([
      { rowId: "r4", issue: "required" },
      { rowId: "r5", issue: "unknown_counterparty_type" },
    ]);
    s.commit();
    const results = await drainImportJobs(s.store, "w");
    expect(results.map((r) => r.status)).toEqual(["Succeeded"]);
    expect(s.batchDone()).toBe(true);
    expect(s.rows.find((r) => r.rowNumber === 2)?.written).toMatchObject({ action: "Created" });
    expect(s.rows.find((r) => r.rowNumber === 3)?.written).toMatchObject({
      action: "Merged",
      target: "cp1",
      before: { id: "cp1" },
    });
    expect(s.writes.find((w) => w["op"] === "update")).toEqual({
      op: "update",
      target: "counterparties",
      id: "cp1",
      counterparty_type: "Sponsor",
    });
    expect(s.rows.find((r) => r.rowNumber === 6)).toMatchObject({
      state: "Refused",
      reason: "duplicate key value",
    });
  });

  it("refuses at commit a row that is no longer in the file", async () => {
    const s = memoryStore("Company\nBayfront Catering\n");
    await runImportJobs(s.store, "w");
    s.confirm({});
    await runImportJobs(s.store, "w");
    s.rows.push({ id: "r9", rowNumber: 9, state: "Valid", reason: null, match: null, merge: null });
    s.commit();
    await runImportJobs(s.store, "w");
    expect(s.rows.find((r) => r.id === "r9")).toMatchObject({
      state: "Refused",
      reason: "The row is no longer in the uploaded file.",
    });
  });

  it("skips jobs not in the state their step expects", async () => {
    const s = memoryStore("Company\nA\n");
    s.job.status = "Canceled";
    expect((await runImportJobs(s.store, "w"))[0]?.status).toBe("Succeeded");
    expect(s.columns).toHaveLength(0);
  });

  it("marks the import Failed once the job runs out of attempts", async () => {
    const s = memoryStore("Company\nA\n", "counterparties", "XLS");
    const results = await runImportJobs(s.store, "w");
    expect(results[0]).toMatchObject({ status: "Failed" });
    expect(results[0]?.error).toContain("not read by the import worker");
    expect(s.job.status).toBe("Failed");
  });

  it("validates venues, vendor products and asset units against their references", async () => {
    const l = lookups([]);
    const venue = await validateRow(
      "o",
      "venues",
      FIELDS["venues"] ?? [],
      [0, 1, 2, 3, 4, 5].map((index) => ({
        index,
        fieldName:
          ["name", "street_address", "locality", "postal_code", "jurisdiction_id", "time_zone"][
            index
          ] ?? null,
      })),
      {
        rowNumber: 2,
        cells: ["Pier 9", "9 Bay Rd", "Miami", "33101", "US-FL-MIAMI-DADE", "America/New_York"],
      },
      l,
    );
    expect(venue).toMatchObject({
      state: "Valid",
      matchName: "Pier 9",
      matchAddress: "9 Bay Rd Miami 33101",
    });
    const badVenue = await validateRow(
      "o",
      "venues",
      FIELDS["venues"] ?? [],
      [
        { index: 0, fieldName: "name" },
        { index: 1, fieldName: "jurisdiction_id" },
        { index: 2, fieldName: "time_zone" },
      ],
      { rowNumber: 3, cells: ["Pier 10", "XX", "Mars/Olympus"] },
      l,
    );
    expect(badVenue.issues.map((i) => i.issue)).toEqual([
      "unknown_jurisdiction",
      "unknown_time_zone",
    ]);
    const product = await validateRow(
      "o",
      "vendor_products",
      FIELDS["vendor_products"] ?? [],
      [
        "vendor_sku",
        "vendor_name",
        "element_id",
        "unit_price_minor",
        "currency_code",
        "lead_time_days",
      ].map((fieldName, index) => ({ index, fieldName })),
      { rowNumber: 2, cells: ["SKU-1", "Harborline", "0000.01.01-XOS-001", "12500", "usd", "3"] },
      l,
    );
    expect(product).toMatchObject({
      state: "Valid",
      values: {
        vendor_id: "ven1",
        unit_price_minor: 12500,
        currency_code: "USD",
        lead_time_days: 3,
      },
      strongKeys: { vendor_sku: "SKU-1", vendor_id: "ven1" },
    });
    const badProduct = await validateRow(
      "o",
      "vendor_products",
      FIELDS["vendor_products"] ?? [],
      ["vendor_sku", "vendor_name", "element_id", "unit_price_minor", "lead_time_days"].map(
        (fieldName, index) => ({ index, fieldName }),
      ),
      { rowNumber: 3, cells: ["SKU-2", "Nobody", "nope", "12.50", "-1"] },
      l,
    );
    expect(badProduct.issues.map((i) => i.issue)).toEqual([
      "unknown_vendor",
      "unknown_element",
      "invalid_amount",
      "invalid_number",
    ]);
    const priceless = await validateRow(
      "o",
      "vendor_products",
      FIELDS["vendor_products"] ?? [],
      ["vendor_sku", "vendor_name", "unit_price_minor"].map((fieldName, index) => ({
        index,
        fieldName,
      })),
      { rowNumber: 4, cells: ["SKU-3", "Harborline", "100"] },
      l,
    );
    expect(priceless.issues.map((i) => i.issue)).toEqual(["currency_required"]);
    const unit = await validateRow(
      "o",
      "asset_units",
      FIELDS["asset_units"] ?? [],
      ["asset_tag", "asset_class_id", "home_venue_id"].map((fieldName, index) => ({
        index,
        fieldName,
      })),
      { rowNumber: 2, cells: ["A-1", "Truss", "Pier 9"] },
      l,
    );
    expect(unit).toMatchObject({
      state: "Valid",
      values: { asset_class_id: "ac1", home_venue_id: "v9" },
      matchName: null,
    });
    const badUnit = await validateRow(
      "o",
      "asset_units",
      FIELDS["asset_units"] ?? [],
      ["asset_tag", "asset_class_id", "home_venue_id"].map((fieldName, index) => ({
        index,
        fieldName,
      })),
      { rowNumber: 3, cells: ["A-2", "Speakers", "Moon"] },
      l,
    );
    expect(badUnit.issues.map((i) => i.issue)).toEqual(["unknown_asset_class", "unknown_venue"]);
    const unknown = await validateRow("o", "invoices", [], [], { rowNumber: 2, cells: [] }, l);
    expect(unknown.issues.map((i) => i.issue)).toEqual(["target_not_importable"]);
  });

  it("updates a strong key match instead of creating", async () => {
    const s = memoryStore("Tag,Class\nA-1,Truss\nA-2,Truss\n", "asset_units");
    await runImportJobs(s.store, "w");
    s.confirm({ Tag: "asset_tag", Class: "asset_class_id" });
    await runImportJobs(s.store, "w");
    expect(s.rows.find((r) => r.rowNumber === 2)?.match).toBe("unit1");
    s.commit();
    await runImportJobs(s.store, "w");
    expect(s.rows.find((r) => r.rowNumber === 2)?.written).toMatchObject({
      action: "Updated",
      target: "unit1",
    });
    expect(s.rows.find((r) => r.rowNumber === 3)?.written).toMatchObject({ action: "Created" });
  });
});

describe("spreadsheet files", () => {
  it("reads the first sheet of an .xlsx workbook", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Customers");
    sheet.addRow(["Company", "City"]);
    sheet.addRow(["Bayfront Catering", "Miami"]);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    const read = await readSheet("XLSX", "c.xlsx", bytes);
    expect(read).toEqual({
      name: "Customers",
      rows: [
        ["Company", "City"],
        ["Bayfront Catering", "Miami"],
      ],
    });
    const empty = new ExcelJS.Workbook();
    const none = await readSheet("XLSX", "e.xlsx", new Uint8Array(await empty.xlsx.writeBuffer()));
    expect(none.rows).toEqual([]);
    await expect(readSheet("Google Sheets", "x", new Uint8Array())).rejects.toBeInstanceOf(
      UnreadableUploadError,
    );
  });
});
