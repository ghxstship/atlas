import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  drainImportJobs,
  importReviewUrl,
  ImportWriteError,
  readSheet,
  runImportJobs,
  UnreadableUploadError,
  validateRow,
  type DetectedSheet,
  type ImportJobKind,
  type ImportStore,
  type TargetLookups,
} from "../src/import-worker.ts";
import type { SheetsFetch } from "../src/import-sheets.ts";

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
    // Cue and guest list lookups (P3); the org-wide targets here never reach them.
    runOfShow: async () => null,
    spaceId: async () => null,
    scopeNodeId: async () => null,
    counterpartyIdByName: async () => null,
    destinationKeyMatch: async () => null,
    nextCuePosition: async () => 1,
    cueCalled: async () => false,
  };
}

const PLAYBOOK = {
  columns: [
    { sheet: "Vendor Directory", header: "COMPANY", target: "app.organizations.name" },
    {
      sheet: "Vendor Directory",
      header: "COUNTERPARTY TYPE",
      target: "app.counterparties.counterparty_type",
    },
    { sheet: "Asset Inventory", header: "RECORD ID", target: "app.asset_units.asset_tag" },
    { sheet: "Asset Inventory", header: "LOCATION ID", target: "app.asset_units.home_venue_id" },
  ],
  sheets: [
    { sheet: "Vendor Directory", entity: "app.vendors" },
    { sheet: "Asset Inventory", entity: "app.asset_units" },
  ],
};

function memoryStore(csv: string | Uint8Array, targetCode = "counterparties", source = "CSV") {
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
    sheetName: null as string | null,
    sourceUrl: null as string | null,
    failureCode: null as string | null,
  };
  const sheets: DetectedSheet[] = [];
  const saved: { path: string; bytes: Uint8Array }[] = [];
  const drive = { credential: null as string | null };
  const columns: {
    index: number;
    header: string;
    suggested: string | null;
    source: string | null;
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
  const notices: { jobId: string; batchId: string | null; url: string }[] = [];
  const notice = { error: null as string | null, slug: "northwind-live" as string | null };
  let batchDone = false;
  const scan = { status: "Clean" as string | null, downloads: 0 };
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
    scanStatus: async () => scan.status,
    async download() {
      scan.downloads += 1;
      return typeof csv === "string" ? new TextEncoder().encode(csv) : csv;
    },
    targetFields: async (t) => FIELDS[t] ?? [],
    profileMapping: async () => new Map(),
    async setStatus(_id, status) {
      job.status = status;
    },
    async insertColumns(_id, _sheet, cols) {
      cols.forEach((c, i) =>
        columns.push({
          index: i,
          header: c.header,
          suggested: c.suggested,
          source: c.source ?? null,
          fieldName: null,
        }),
      );
      return cols.map((_c, i) => `col${i}`);
    },
    async recordColumnSamples() {},
    async insertSheets(_id, list) {
      sheets.push(...list);
    },
    async setSheet(_id, name) {
      job.sheetName = name;
    },
    playbook: async () => PLAYBOOK,
    importTargets: async () =>
      Object.entries(FIELDS).map(([code, f]) => ({
        code,
        fields: f.map((x) => x.name),
        required: f.filter((x) => x.required).map((x) => x.name),
      })),
    driveCredential: async () => drive.credential,
    async saveUpload(path, bytes) {
      saved.push({ path, bytes });
    },
    async failImport(_id, code) {
      job.status = "Failed";
      job.failureCode = code;
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
    orgSlug: async (orgId) => (orgId === job.orgId ? notice.slug : null),
    async notifyFinished(input) {
      if (notice.error) throw new Error(notice.error);
      notices.push(input);
    },
  };
  return {
    store,
    notices,
    notice,
    scan,
    job,
    sheets,
    saved,
    drive,
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

  it("reads a spreadsheet only once its virus scan is Clean", async () => {
    const s = memoryStore("Company\nBayfront Catering\n");
    s.scan.status = "Scanning";
    const waiting = await runImportJobs(s.store, "w");
    expect(waiting[0]?.error).toContain("not scanned yet");
    expect(s.scan.downloads).toBe(0);
    expect(s.job.status).not.toBe("Mapped");
  });

  it("fails an import whose spreadsheet is infected, without reading it or retrying", async () => {
    for (const status of ["Infected", "Scan Failed"]) {
      const s = memoryStore("Company\nBayfront Catering\n");
      s.scan.status = status;
      const results = await runImportJobs(s.store, "w");
      expect(results[0]?.status).toBe("Succeeded");
      expect(s.job.status).toBe("Failed");
      expect(s.scan.downloads).toBe(0);
      expect(s.columns).toHaveLength(0);
    }
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

describe("import.finished (A104)", () => {
  const appUrl = "https://atlas.example";
  const review = "https://atlas.example/northwind-live/import?import=j1";

  it("links to the import in the Atlas import wizard", () => {
    expect(importReviewUrl(appUrl, "northwind-live", "j1")).toBe(review);
    expect(importReviewUrl("https://atlas.example/", "acme & co", "j 2")).toBe(
      "https://atlas.example/acme%20%26%20co/import?import=j+2",
    );
  });

  it("tells the person once when validation finishes and once when the commit finishes", async () => {
    const s = memoryStore("Company\nBayfront Catering\n,\n");
    await runImportJobs(s.store, "w", 10, { appUrl });
    expect(s.notices).toEqual([]);
    s.confirm({});
    await runImportJobs(s.store, "w", 10, { appUrl });
    expect(s.job.status).toBe("Validated");
    expect(s.notices).toEqual([{ jobId: "j1", batchId: null, url: review }]);
    s.commit();
    const results = await drainImportJobs(s.store, "w", 5, { appUrl });
    expect(results.map((r) => r.status)).toEqual(["Succeeded"]);
    expect(s.notices).toEqual([
      { jobId: "j1", batchId: null, url: review },
      { jobId: "j1", batchId: "b1", url: review },
    ]);
  });

  it("tells nobody when the worker has no Atlas address, or a step has nothing to do", async () => {
    const s = memoryStore("Company\nBayfront Catering\n");
    await runImportJobs(s.store, "w");
    s.confirm({});
    await runImportJobs(s.store, "w");
    expect(s.job.status).toBe("Validated");
    expect(s.notices).toEqual([]);
    s.queue.push({ kind: "import.validate", jobId: "q4", subjectId: "j1", attempts: 0 });
    await runImportJobs(s.store, "w", 10, { appUrl });
    expect(s.notices).toEqual([]);
  });

  it("keeps a finished step when the notice cannot be sent, and says why", async () => {
    const s = memoryStore("Company\nBayfront Catering\n");
    await runImportJobs(s.store, "w", 10, { appUrl });
    s.confirm({});
    s.notice.error = "notify_import_finished: permission denied";
    const results = await runImportJobs(s.store, "w", 10, { appUrl });
    expect(results).toEqual([
      expect.objectContaining({
        kind: "import.validate",
        status: "Succeeded",
        noticeError: "notify_import_finished: permission denied",
      }),
    ]);
    expect(s.job.status).toBe("Validated");
    expect(s.finished.at(-1)).toEqual({ jobId: "q2", ok: true });
    s.notice.error = null;
    s.notice.slug = null;
    s.commit();
    const committed = await runImportJobs(s.store, "w", 10, { appUrl });
    expect(committed[0]).toMatchObject({
      status: "Succeeded",
      noticeError: "The org of import j1 has no slug.",
    });
    expect(s.notices).toEqual([]);
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
    await expect(readSheet("XLS", "x", new Uint8Array())).rejects.toBeInstanceOf(
      UnreadableUploadError,
    );
  });
});

async function playbookWorkbook(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Cover Page").addRow([]);
  const vendors = workbook.addWorksheet("Vendor Directory");
  vendors.addRow(["VENDOR ID", "COMPANY", "COUNTERPARTY TYPE"]);
  vendors.addRow(["V-1", "Harbor Sound Rental", "Sponsor"]);
  vendors.addRow(["V-2", "Bayfront Catering", ""]);
  const assets = workbook.addWorksheet("Asset Inventory");
  assets.addRow(["RECORD ID", "CLASS", "LOCATION ID"]);
  assets.addRow(["A-9", "Truss", "Pier 9"]);
  const notes = workbook.addWorksheet("Notes");
  notes.addRow(["Anything", "Else"]);
  notes.addRow(["x", "y"]);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

describe("every sheet of a workbook (A65-025)", () => {
  it("records each sheet with its range and proposed target, and maps the first sheet with data", async () => {
    const s = memoryStore(await playbookWorkbook(), "counterparties", "XLSX");
    await runImportJobs(s.store, "w");
    expect(s.job.status).toBe("Mapped");
    expect(s.job.sheetName).toBe("Vendor Directory");
    expect(
      s.sheets.map((x) => [
        x.name,
        x.index,
        x.headerRow,
        x.dataRowCount,
        x.proposedTarget,
        x.proposedFromPlaybook,
      ]),
    ).toEqual([
      ["Cover Page", 0, null, 0, null, false],
      ["Vendor Directory", 1, 1, 2, "counterparties", true],
      ["Asset Inventory", 2, 1, 1, "asset_units", true],
      ["Notes", 3, 1, 1, null, false],
    ]);
    expect(s.columns.map((c) => [c.header, c.suggested, c.source])).toEqual([
      ["VENDOR ID", null, null],
      ["COMPANY", "name", "Playbook"],
      ["COUNTERPARTY TYPE", "counterparty_type", "Playbook"],
    ]);
    s.confirm({});
    await runImportJobs(s.store, "w");
    expect(s.rows.map((r) => `${r.rowNumber}:${r.state}`)).toEqual(["2:Valid", "3:Valid"]);
  });

  it("reads the sheet an import started from a detected sheet names, without listing sheets again", async () => {
    const s = memoryStore(await playbookWorkbook(), "asset_units", "XLSX");
    s.job.sheetName = "Asset Inventory";
    await runImportJobs(s.store, "w");
    expect(s.sheets).toEqual([]);
    expect(s.columns.map((c) => [c.header, c.suggested, c.source])).toEqual([
      ["RECORD ID", "asset_tag", "Playbook"],
      ["CLASS", "asset_class_id", "Header"],
      ["LOCATION ID", "home_venue_id", "Playbook"],
    ]);
    s.confirm({});
    await runImportJobs(s.store, "w");
    expect(s.rows.map((r) => `${r.rowNumber}:${r.state}`)).toEqual(["2:Valid"]);
  });

  it("fails a step whose sheet is no longer in the file", async () => {
    const s = memoryStore(await playbookWorkbook(), "asset_units", "XLSX");
    s.job.sheetName = "Gone";
    s.job.status = "Mapped";
    s.queue.push({ kind: "import.validate", jobId: "q9", subjectId: "j1", attempts: 0 });
    s.queue.splice(0, 1);
    const results = await runImportJobs(s.store, "w");
    expect(results[0]?.error).toContain("no longer in the file");
  });
});

describe("Google Sheets links (A65-025)", () => {
  const link = "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit";
  const fake = (routes: Record<string, { status: number; body: unknown }>) => {
    const calls: { url: string; auth: string | undefined }[] = [];
    const sheetsFetch: SheetsFetch = async (url, init) => {
      calls.push({ url, auth: init.headers["authorization"] });
      const key = Object.keys(routes).find((k) => url.includes(k));
      const route = key === undefined ? { status: 599, body: {} } : routes[key];
      return { status: route?.status ?? 599, json: async () => route?.body };
    };
    return { sheetsFetch, calls };
  };
  function sheetsJob() {
    const s = memoryStore("", "venues", "Google Sheets");
    s.job.sourceUrl = link;
    s.job.path = "p/u.xlsx";
    s.scan.status = null;
    s.queue.splice(0, s.queue.length, {
      kind: "import.fetch",
      jobId: "q1",
      subjectId: "j1",
      attempts: 0,
    });
    return s;
  }

  it("reads every sheet through the Drive connection and saves it for scanning", async () => {
    const s = sheetsJob();
    s.drive.credential = JSON.stringify({ access_token: "ya29-fixture" });
    const f = fake({
      "?fields=": {
        status: 200,
        body: {
          properties: { title: "Tour" },
          sheets: [
            { properties: { title: "Venues", index: 0 } },
            { properties: { title: "Chart", index: 1, sheetType: "OBJECT" } },
          ],
        },
      },
      "values:batchGet": {
        status: 200,
        body: {
          valueRanges: [
            {
              values: [
                ["Venue", "City"],
                ["Pier 9", "Miami"],
              ],
            },
          ],
        },
      },
    });
    const results = await runImportJobs(s.store, "w", 10, { sheetsFetch: f.sheetsFetch });
    expect(results[0]?.status).toBe("Succeeded");
    expect(f.calls.every((c) => c.auth === "Bearer ya29-fixture")).toBe(true);
    expect(f.calls[1]?.url).toContain("ranges=%27Venues%27");
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0]?.path).toBe("p/u.xlsx");
    const read = await readSheet("Google Sheets", "Tour", s.saved[0]?.bytes ?? new Uint8Array());
    expect(read).toEqual({
      name: "Venues",
      rows: [
        ["Venue", "City"],
        ["Pier 9", "Miami"],
      ],
    });
    expect(s.job.status).toBe("Uploaded");
  });

  it("fails the import with a reason when the sheet is not shared, missing or Drive is not connected", async () => {
    const notConnected = sheetsJob();
    await runImportJobs(notConnected.store, "w", 10, { sheetsFetch: fake({}).sheetsFetch });
    expect(notConnected.job).toMatchObject({
      status: "Failed",
      failureCode: "google_drive_not_connected",
    });

    for (const [status, code] of [
      [403, "google_sheet_not_shared"],
      [404, "google_sheet_not_found"],
      [401, "google_drive_credential_refused"],
    ] as const) {
      const s = sheetsJob();
      s.drive.credential = "ya29-plain-token";
      await runImportJobs(s.store, "w", 10, {
        sheetsFetch: fake({ "?fields=": { status, body: {} } }).sheetsFetch,
      });
      expect(s.job).toMatchObject({ status: "Failed", failureCode: code });
      expect(s.saved).toHaveLength(0);
    }
    const empty = sheetsJob();
    empty.drive.credential = "ya29-plain-token";
    await runImportJobs(empty.store, "w", 10, {
      sheetsFetch: fake({ "?fields=": { status: 200, body: { sheets: [] } } }).sheetsFetch,
    });
    expect(empty.job.failureCode).toBe("google_sheet_empty");
  });

  it("retries an outage and records the reason once attempts are used up", async () => {
    const s = sheetsJob();
    s.drive.credential = "ya29-plain-token";
    const results = await runImportJobs(s.store, "w", 10, {
      sheetsFetch: fake({ "?fields=": { status: 503, body: {} } }).sheetsFetch,
    });
    expect(results[0]).toMatchObject({ status: "Failed" });
    expect(s.job).toMatchObject({ status: "Failed", failureCode: "google_sheet_unavailable" });
  });

  it("does nothing for a link already saved, or for a job that is not a waiting link", async () => {
    const saved = sheetsJob();
    saved.scan.status = "Scanning";
    await runImportJobs(saved.store, "w", 10, { sheetsFetch: fake({}).sheetsFetch });
    expect(saved.saved).toHaveLength(0);
    const upload = sheetsJob();
    upload.job.source = "CSV";
    expect((await runImportJobs(upload.store, "w"))[0]?.status).toBe("Succeeded");
    const noReader = sheetsJob();
    expect((await runImportJobs(noReader.store, "w"))[0]?.error).toContain(
      "no Google Sheets reader",
    );
  });
});
