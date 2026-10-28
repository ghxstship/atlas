import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  cancelImport,
  confirmMapping,
  createImport,
  decideMergeReview,
  getImport,
  importObjectPath,
  checkImportUpload,
  IMPORT_MAX_BYTES,
  importSourceOf,
  listImports,
  listImportTargets,
  requestImportCommit,
  similarityPercent,
  undoImportBatch,
  createSheetsImport,
  googleSheetsLinkId,
  importDetectedSheet,
  importFlags,
  checkPastedRows,
  createPastedImport,
  importColumnSamples,
  listImportDestinations,
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
          destination: null,
          fields: [{ name: "name", required: true, strongKey: false }],
        },
      ],
    });
  });

  it("reads a target's destination (P3)", async () => {
    const { db } = moduleClient({
      "from:import_targets": [
        ok([
          {
            code: "cues",
            write_capability: "show.run_of_show.write",
            fuzzy_match: false,
            sort_order: 5,
            destination: "run_of_show_id",
          },
          {
            code: "guest_list_entries",
            write_capability: "advancing.rider.write",
            fuzzy_match: true,
            sort_order: 6,
            destination: "project_id",
          },
        ]),
      ],
      "from:import_target_fields": [ok([])],
    });
    const result = await listImportTargets(db);
    expect(result.ok && result.data.map((t) => [t.code, t.destination])).toEqual([
      ["cues", "run_of_show_id"],
      ["guest_list_entries", "project_id"],
    ]);
  });

  it("creates an import with its destination and lists destinations and samples (P3)", async () => {
    const base = moduleClient({
      "from:import_jobs": [ok([{ id: "j2" }])],
      "rpc:import_destinations": [
        ok([
          {
            destination_id: "ros1",
            project_id: "prj1",
            label: "NWL · Opening Night",
            show_date: "2026-11-14",
          },
        ]),
      ],
      "rpc:import_column_samples": [
        ok([{ import_job_column_id: "c1", sample_index: 1, sample_value: "Q1" }]),
      ],
      "rpc:import_detected_sheet": [ok("j3")],
    });
    const { db } = withStorage(base.db);
    await createImport(db, {
      orgId: "o",
      targetCode: "cues",
      filename: "r.csv",
      objectPath: "p/r.csv",
      source: "CSV",
      body: new Uint8Array([1]),
      contentType: "text/csv",
      runOfShowId: "ros1",
    });
    expect(stepsOf(base.calls[0], "insert")[0]?.[0]).toMatchObject({
      target_code: "cues",
      run_of_show_id: "ros1",
    });
    expect(stepsOf(base.calls[0], "insert")[0]?.[0]).not.toHaveProperty("project_id");
    expect(
      await listImportDestinations(db, { orgId: "o", targetCode: "cues", include: "ros1" }),
    ).toEqual({
      ok: true,
      data: [
        { id: "ros1", projectId: "prj1", label: "NWL · Opening Night", showDate: "2026-11-14" },
      ],
    });
    expect(stepsOf(base.calls[1], "args")[0]?.[0]).toEqual({
      p_org_id: "o",
      p_target_code: "cues",
      p_include: "ros1",
    });
    expect(await importColumnSamples(db, "j2")).toEqual({
      ok: true,
      data: [{ columnId: "c1", index: 1, value: "Q1" }],
    });
    await importDetectedSheet(db, {
      sheetId: "s1",
      targetCode: "guest_list_entries",
      projectId: "prj1",
    });
    expect(stepsOf(base.calls[3], "args")[0]?.[0]).toEqual({
      p_sheet_id: "s1",
      p_target_code: "guest_list_entries",
      p_project_id: "prj1",
      p_run_of_show_id: null,
    });
  });

  it("turns pasted rows into a CSV upload, refusing an empty or oversized paste (P3)", async () => {
    expect(checkPastedRows("Cue\tScene\n")).toEqual({ ok: false, rule: "import_paste_empty" });
    expect(checkPastedRows("   \n\n")).toEqual({ ok: false, rule: "import_paste_empty" });
    expect(checkPastedRows(`Cue\tScene\n1\t${"x".repeat(IMPORT_MAX_BYTES)}`)).toEqual({
      ok: false,
      rule: "import_file_size",
    });
    expect(checkPastedRows('Cue\tScene\n1\t"House\nto half"\n')).toEqual({
      ok: true,
      csv: 'Cue,Scene\r\n1,"House\nto half"',
    });
    const base = moduleClient({ "from:import_jobs": [ok([{ id: "j4" }])] });
    const { db, uploads } = withStorage(base.db);
    const input = {
      orgId: "o",
      targetCode: "guest_list_entries",
      projectId: "prj1",
      filename: "Pasted rows 2026-11-02",
      objectPath: "p/u.csv",
    };
    expect(
      await createPastedImport(db, { ...input, text: "Guest\tPlus\nJordan Pike\t1\n" }),
    ).toEqual({ ok: true, data: "j4" });
    expect(uploads).toEqual([{ path: "p/u.csv", type: "text/csv" }]);
    expect(stepsOf(base.calls[0], "insert")[0]?.[0]).toMatchObject({
      source: "CSV",
      original_filename: "Pasted rows 2026-11-02",
      project_id: "prj1",
    });
    const empty = await createPastedImport(db, { ...input, text: "Guest\n" });
    expect(empty.ok === false && empty.error).toMatchObject({
      kind: "refusal",
      rule: "import_paste_empty",
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

  it("accepts .csv and .xlsx and refuses a legacy .xls with its own message", () => {
    expect(checkImportUpload("crew.csv", 1024)).toEqual({
      ok: true,
      source: "CSV",
      ext: "csv",
      contentType: "text/csv",
    });
    expect(checkImportUpload("Vendors 2026.XLSX", 1024)).toEqual({
      ok: true,
      source: "XLSX",
      ext: "xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(checkImportUpload("old-vendors.xls", 1024)).toEqual({
      ok: false,
      rule: "import_xls_unsupported",
    });
    expect(checkImportUpload("rider.pdf", 1024)).toEqual({ ok: false, rule: "import_file_type" });
    expect(checkImportUpload("big.csv", IMPORT_MAX_BYTES + 1)).toEqual({
      ok: false,
      rule: "import_file_size",
    });
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
      "from:import_job_sheets": [ok([])],
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

describe("sheets and Google Sheets links (A83)", () => {
  it("reads every detected sheet with the import that reads it", async () => {
    const { db } = moduleClient({
      "from:import_jobs": [
        ok([
          {
            id: "j2",
            target_code: "asset_units",
            original_filename: "Playbook.xlsx",
            import_status: "Mapped",
            created_at: "t",
            source: "XLSX",
            sheet_name: "Asset Inventory",
            source_url: null,
            failure_code: null,
            import_job_sheet_id: "s2",
          },
        ]),
        ok([
          { id: "j3", import_job_sheet_id: "s1", import_status: "Mapped" },
          { id: "j4", import_job_sheet_id: "s3", import_status: "Canceled" },
        ]),
      ],
      "from:import_job_columns": [
        ok([
          {
            id: "c0",
            sheet_name: "Asset Inventory",
            column_index: 0,
            header: "RECORD ID",
            field_name: null,
            suggested_field_name: "asset_tag",
            suggestion_source: "Playbook",
          },
        ]),
      ],
      "from:import_job_sheets": [
        ok([{ import_job_id: "j1" }]),
        ok([
          {
            id: "s1",
            sheet_name: "Vendor Directory",
            sheet_index: 0,
            header_row: 1,
            first_data_row: 2,
            last_row: 9,
            column_count: 3,
            data_row_count: 8,
            proposed_target_code: "counterparties",
            proposed_from_playbook: true,
          },
          {
            id: "s2",
            sheet_name: "Asset Inventory",
            sheet_index: 1,
            header_row: 1,
            first_data_row: 2,
            last_row: 3,
            column_count: 3,
            data_row_count: 2,
            proposed_target_code: "asset_units",
            proposed_from_playbook: true,
          },
          {
            id: "s3",
            sheet_name: "Notes",
            sheet_index: 2,
            header_row: null,
            first_data_row: null,
            last_row: 0,
            column_count: 0,
            data_row_count: 0,
            proposed_target_code: null,
            proposed_from_playbook: false,
          },
        ]),
      ],
      "from:import_row_results": [ok([])],
      "from:merge_reviews": [ok([])],
      "rpc:import_dry_run": [ok([])],
      "from:import_batches": [ok([])],
    });
    const detail = await getImport(db, "j2");
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data).toMatchObject({
      source: "XLSX",
      sheetName: "Asset Inventory",
      failureCode: null,
    });
    expect(detail.data.columns[0]?.suggestionSource).toBe("Playbook");
    expect(detail.data.sheets.map((x) => [x.name, x.importId, x.proposedTargetCode])).toEqual([
      ["Vendor Directory", "j3", "counterparties"],
      ["Asset Inventory", "j2", "asset_units"],
      ["Notes", null, null],
    ]);
  });

  it("reads the wizard's feature flags", async () => {
    const { db } = moduleClient({
      "rpc:org_feature_flags": [
        ok([
          { flag_key: "imports.google_sheets", enabled: true },
          { flag_key: "imports.ai_mapping", enabled: false },
        ]),
      ],
    });
    expect(await importFlags(db, "o")).toEqual({
      ok: true,
      data: { googleSheets: true, aiMapping: false },
    });
  });

  it("offers Aurora's mapping step only while the org's own AI switch has mapping on", async () => {
    // imports.ai_mapping is on by default (1402); the org's AI Features setting still decides.
    const flagsOn = () =>
      ok([
        { flag_key: "imports.google_sheets", enabled: false },
        { flag_key: "imports.ai_mapping", enabled: true },
      ]);
    const on = moduleClient({
      "rpc:org_feature_flags": [flagsOn()],
      "rpc:ai_enabled_features": [ok(["drafting", "mapping"])],
    });
    expect(await importFlags(on.db, "o")).toEqual({
      ok: true,
      data: { googleSheets: false, aiMapping: true },
    });
    // AI turned off (no features, or aurora_ai not in the plan): no step, so no column names leave.
    const off = moduleClient({
      "rpc:org_feature_flags": [flagsOn()],
      "rpc:ai_enabled_features": [ok([])],
    });
    expect(await importFlags(off.db, "o")).toEqual({
      ok: true,
      data: { googleSheets: false, aiMapping: false },
    });
    const otherOnly = moduleClient({
      "rpc:org_feature_flags": [flagsOn()],
      "rpc:ai_enabled_features": [ok(["drafting"])],
    });
    expect(await importFlags(otherOnly.db, "o")).toEqual({
      ok: true,
      data: { googleSheets: false, aiMapping: false },
    });
    expect(otherOnly.calls.map((c) => c.target)).toEqual([
      "rpc:org_feature_flags",
      "rpc:ai_enabled_features",
    ]);
    expect(stepsOf(otherOnly.calls[1], "args")).toEqual([[{ p_org_id: "o" }]]);
    const broken = moduleClient({
      "rpc:org_feature_flags": [flagsOn()],
      "rpc:ai_enabled_features": [refused("aurora_not_in_plan")],
    });
    expect((await importFlags(broken.db, "o")).ok).toBe(false);
  });

  it("creates a Google Sheets import and imports a detected sheet", async () => {
    const link =
      "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit";
    expect(googleSheetsLinkId(link)).toBe("1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
    expect(
      googleSheetsLinkId(
        "https://example.test/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      ),
    ).toBeNull();
    expect(googleSheetsLinkId("nope")).toBeNull();
    const { db, calls } = moduleClient({
      "from:import_jobs": [ok([{ id: "j9" }])],
      "rpc:import_detected_sheet": [ok("j10")],
    });
    expect(
      await createSheetsImport(db, {
        orgId: "o",
        targetCode: "venues",
        link: ` ${link} `,
        objectPath: "p/u.xlsx",
      }),
    ).toEqual({
      ok: true,
      data: "j9",
    });
    expect(stepsOf(calls[0], "insert")).toEqual([
      [
        {
          org_id: "o",
          target_code: "venues",
          source: "Google Sheets",
          original_filename: "Google Sheets 1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
          storage_object_path: "p/u.xlsx",
          source_url: link,
        },
      ],
    ]);
    expect(await importDetectedSheet(db, { sheetId: "s1", targetCode: "counterparties" })).toEqual({
      ok: true,
      data: "j10",
    });
  });
});
