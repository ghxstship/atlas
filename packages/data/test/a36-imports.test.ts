import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  cancelImport,
  confirmMapping,
  createImport,
  decideMergeReview,
  getImport,
  importObjectPath,
  importSourceOf,
  listImports,
  listImportTargets,
  requestImportCommit,
  similarityPercent,
  undoImportBatch,
} from "../src/imports.ts";
import {
  dataRows,
  headerRowNumber,
  headers,
  parseCsv,
  suggestMapping,
} from "../src/import-parse.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const ok = (data: unknown) => ({ data, error: null });
const refused = (rule: string) => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});

function withStorage(db: XosClient, uploadError: string | null = null) {
  const uploads: { path: string; type: string }[] = [];
  const storage = {
    from: () => ({
      async upload(path: string, _body: unknown, opts: { contentType: string }) {
        uploads.push({ path, type: opts.contentType });
        return {
          data: uploadError ? null : { path },
          error: uploadError ? { message: uploadError } : null,
        };
      },
    }),
  };
  return { db: Object.assign(db, { storage }) as XosClient, uploads };
}

describe("spreadsheet reading", () => {
  it("reads quoted CSV with commas, quotes, CRLF and a byte order mark", () => {
    const rows = parseCsv(
      '﻿Name,"Notes, long"\r\n"Bayfront ""BC"" Catering","a\nb"\r\n\r\nHarbor,\n',
    );
    expect(rows).toEqual([
      ["Name", "Notes, long"],
      ['Bayfront "BC" Catering', "a\nb"],
      [""],
      ["Harbor", ""],
    ]);
  });

  it("finds the header row and data rows by spreadsheet row number", () => {
    const sheet = {
      name: "s.csv",
      rows: [[""], ["Company", "City"], ["Bayfront", "Miami"], ["", ""], ["Harbor", " Tampa "]],
    };
    expect(headerRowNumber(sheet)).toBe(2);
    expect(headers(sheet)).toEqual(["Company", "City"]);
    expect(dataRows(sheet)).toEqual([
      { rowNumber: 3, cells: ["Bayfront", "Miami"] },
      { rowNumber: 5, cells: ["Harbor", "Tampa"] },
    ]);
    expect(headerRowNumber({ name: "e", rows: [[" "]] })).toBeNull();
    expect(dataRows({ name: "e", rows: [] })).toEqual([]);
    expect(headers({ name: "e", rows: [] })).toEqual([]);
  });

  it("suggests fields from a profile, exact names and synonyms, each field once", () => {
    const fields = ["name", "counterparty_type", "locality"];
    expect(suggestMapping(["Company", "Type", "Customer", "Notes"], fields)).toEqual([
      "name",
      "counterparty_type",
      null,
      null,
    ]);
    expect(
      suggestMapping(["Client Name", "name"], fields, new Map([["client name", "name"]])),
    ).toEqual(["name", null]);
  });
});

describe("import repository", () => {
  it("lists targets with their fields", async () => {
    const { db } = moduleClient({
      "from:import_targets": [
        ok([
          {
            code: "venues",
            write_capability: "places.venue.write",
            fuzzy_match: true,
            sort_order: 1,
          },
        ]),
      ],
      "from:import_target_fields": [
        ok([{ target_code: "venues", field_name: "name", required: true, strong_key: false }]),
      ],
    });
    expect(await listImportTargets(db)).toEqual({
      ok: true,
      data: [
        {
          code: "venues",
          writeCapability: "places.venue.write",
          fuzzyMatch: true,
          fields: [{ name: "name", required: true, strongKey: false }],
        },
      ],
    });
  });

  it("names uploads by source and stores them in the person's folder", () => {
    expect(importSourceOf("Customers.CSV")).toEqual({ source: "CSV", ext: "csv" });
    expect(importSourceOf("a.xlsx")?.source).toBe("XLSX");
    expect(importSourceOf("a.xls")?.source).toBe("XLS");
    expect(importSourceOf("a.pdf")).toBeNull();
    expect(importObjectPath("p", "u", "csv")).toBe("p/u.csv");
    expect(similarityPercent(0.874)).toBe(87);
    expect(similarityPercent(null)).toBeNull();
  });

  it("uploads, then creates the import; an upload failure stops it", async () => {
    const base = moduleClient({ "from:import_jobs": [ok([{ id: "j1" }])] });
    const { db, uploads } = withStorage(base.db);
    const input = {
      orgId: "o",
      targetCode: "counterparties",
      filename: "c.csv",
      objectPath: "p/u.csv",
      source: "CSV" as const,
      body: new Uint8Array([1]),
      contentType: "text/csv",
    };
    expect(await createImport(db, input)).toEqual({ ok: true, data: "j1" });
    expect(uploads).toEqual([{ path: "p/u.csv", type: "text/csv" }]);
    expect(stepsOf(base.calls[0], "insert")[0]?.[0]).toMatchObject({
      storage_object_path: "p/u.csv",
      source: "CSV",
    });
    const failing = withStorage(moduleClient({}).db, "Bucket refused the type.");
    const result = await createImport(failing.db, input);
    expect(result.ok === false && result.error.kind).toBe("unexpected");
  });

  it("lists imports and reads one with columns, issues, reviews, dry run and batches", async () => {
    const { db } = moduleClient({
      "from:import_jobs": [
        ok([
          {
            id: "j1",
            target_code: "counterparties",
            original_filename: "c.csv",
            import_status: "Validated",
            created_at: "t",
          },
        ]),
        ok([
          {
            id: "j1",
            target_code: "counterparties",
            original_filename: "c.csv",
            import_status: "Committed",
            created_at: "t",
            mapping_confirmed_at: "t2",
          },
        ]),
        ok([]),
      ],
      "from:import_job_columns": [
        ok([
          {
            id: "c0",
            sheet_name: "c.csv",
            column_index: 0,
            header: "Company",
            field_name: "name",
            suggested_field_name: "name",
          },
        ]),
      ],
      "from:import_row_results": [
        ok([
          {
            id: "r2",
            sheet_name: "c.csv",
            row_number: 2,
            row_state: "Written",
            reason: null,
            import_batch_id: "b1",
            undo_outcome: "Reverted",
            undo_reason: null,
            import_cell_issues: [],
          },
          {
            id: "r3",
            sheet_name: "c.csv",
            row_number: 3,
            row_state: "Written",
            reason: null,
            import_batch_id: "b1",
            undo_outcome: "Kept",
            undo_reason: "The row was edited after the import.",
            import_cell_issues: [],
          },
          {
            id: "r4",
            sheet_name: "c.csv",
            row_number: 4,
            row_state: "Invalid",
            reason: "required",
            import_batch_id: null,
            undo_outcome: null,
            undo_reason: null,
            import_cell_issues: [{ column_index: 0, issue_code: "required" }],
          },
        ]),
      ],
      "from:merge_reviews": [
        ok([
          {
            id: "m1",
            import_row_result_id: "r3",
            candidate_table: "app.counterparties",
            candidate_id: "cp1",
            similarity: 0.9,
            decision: "Merged",
            import_row_results: { row_number: 3, import_job_id: "j1" },
          },
          {
            id: "m2",
            import_row_result_id: "r2",
            candidate_table: "app.venues",
            candidate_id: "v1",
            similarity: 0.88,
            decision: "Pending",
            import_row_results: { row_number: 2, import_job_id: "j1" },
          },
        ]),
      ],
      "rpc:import_dry_run": [
        ok([{ creates: 1, updates: 0, merges: 1, refusals: 1, skipped: 0, pending_reviews: 0 }]),
      ],
      "from:import_batches": [
        ok([{ id: "b1", committed_at: "t3", undone_at: "t4", undo_reason: "Wrong file." }]),
      ],
      "from:counterparties": [ok([{ id: "cp1", counterparty_name: "Harbor Sound Rentals" }])],
      "from:venues": [ok([{ id: "v1", name: "Pier 9" }])],
    });
    const list = await listImports(db, "o");
    expect(list.ok && list.data[0]?.status).toBe("Validated");
    const detail = await getImport(db, "j1");
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.issues).toEqual([
      {
        id: "r4",
        sheet: "c.csv",
        rowNumber: 4,
        state: "Invalid",
        reason: "required",
        cells: [{ columnIndex: 0, issue: "required" }],
      },
    ]);
    expect(detail.data.reviews.map((r) => r.candidateName)).toEqual([
      "Harbor Sound Rentals",
      "Pier 9",
    ]);
    expect(detail.data.dryRun?.merges).toBe(1);
    expect(detail.data.batches[0]).toMatchObject({
      written: 2,
      reverted: 1,
      kept: [{ rowNumber: 3, reason: "The row was edited after the import." }],
    });
    const missing = await getImport(db, "nope");
    expect(missing.ok === false && missing.error.kind).toBe("not-found");
  });

  it("confirms a mapping, decides reviews, commits, undoes and cancels", async () => {
    const { db, calls } = moduleClient({
      "from:import_job_columns": [ok(null), ok(null)],
      "from:import_jobs": [ok([{ id: "j1" }]), ok([{ id: "j1" }])],
      "from:merge_reviews": [ok([{ id: "m1" }])],
      "rpc:request_import_commit": [ok("b1"), refused("import_merge_reviews_pending")],
      "rpc:undo_import_batch": [ok([{ reverted: 3, kept: 1 }])],
    });
    expect(
      await confirmMapping(db, {
        importId: "j1",
        mapping: [
          { columnId: "c0", fieldName: "name" },
          { columnId: "c1", fieldName: null },
        ],
      }),
    ).toEqual({ ok: true, data: "j1" });
    expect(stepsOf(calls[1], "update")[0]).toEqual([{ field_name: null }]);
    expect(await decideMergeReview(db, { id: "m1", decision: "Merged" })).toEqual({
      ok: true,
      data: "m1",
    });
    expect(await requestImportCommit(db, "j1")).toEqual({ ok: true, data: "b1" });
    const pending = await requestImportCommit(db, "j1");
    expect(pending.ok === false && pending.error.kind === "refusal" && pending.error.rule).toBe(
      "import_merge_reviews_pending",
    );
    expect(await undoImportBatch(db, { batchId: "b1", reason: "Wrong file." })).toEqual({
      ok: true,
      data: { reverted: 3, kept: 1 },
    });
    expect(await cancelImport(db, "j1")).toEqual({ ok: true, data: "j1" });
  });

  it("stops confirming at the first column the database refuses", async () => {
    const { db } = moduleClient({ "from:import_job_columns": [refused("import_field_unknown")] });
    const result = await confirmMapping(db, {
      importId: "j1",
      mapping: [{ columnId: "c0", fieldName: "tax_id" }],
    });
    expect(result.ok === false && result.error.kind).toBe("refusal");
  });
});
