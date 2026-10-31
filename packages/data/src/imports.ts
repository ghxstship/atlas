import type { CapabilityCode } from "@xos/schemas/capabilities/codes";
import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import {
  num,
  numOrNull,
  rows,
  rpc,
  str,
  strOrNull,
  writtenId,
  type Raw,
} from "./platform-common.ts";
import { untyped } from "./untyped.ts";
import type { Database } from "./database.types.ts";

/**
 * The import wizard's side of imports (A36 on A18's 0530 and A36's 1061; Section 4.6.2): upload a
 * spreadsheet, confirm the column mapping, decide fuzzy duplicates, read the dry run, request the commit
 * and undo a batch. Detection, validation and the writes run in the import worker (import-worker.ts,
 * service role); everything here runs as the signed-in person.
 */

export const IMPORT_BUCKET = "imports";

export type ImportSource = Database["app"]["Enums"]["import_source"];
export type ImportStatus = Database["app"]["Enums"]["import_status"];
export type RowState = Database["app"]["Enums"]["import_row_state"];
export type MergeDecision = Database["app"]["Enums"]["merge_decision"];

export interface ImportTargetField {
  readonly name: string;
  readonly required: boolean;
  readonly strongKey: boolean;
}

export interface ImportTarget {
  readonly code: string;
  /** Capability that authorizes importing into the target. */
  readonly writeCapability: CapabilityCode;
  readonly fuzzyMatch: boolean;
  readonly fields: readonly ImportTargetField[];
}

/** Targets the caller may know about, with their fields; the database decides who may import. */
export async function listImportTargets(db: XosClient): Promise<Result<ImportTarget[]>> {
  const [targets, fields] = await Promise.all([
    rows(
      untyped(db)
        .from("import_targets")
        .select("code, write_capability, fuzzy_match, sort_order")
        .order("sort_order"),
    ),
    rows(
      untyped(db)
        .from("import_target_fields")
        .select("target_code, field_name, required, strong_key"),
    ),
  ]);
  if (!targets.ok) return targets;
  if (!fields.ok) return fields;
  return ok(
    targets.data.map((t) => ({
      code: str(t["code"]),
      // write_capability references app.capabilities, seeded from the registry (migration 0530).
      writeCapability: str(t["write_capability"]) as CapabilityCode,
      fuzzyMatch: t["fuzzy_match"] === true,
      fields: fields.data
        .filter((f) => f["target_code"] === t["code"])
        .map((f) => ({
          name: str(f["field_name"]),
          required: f["required"] === true,
          strongKey: f["strong_key"] === true,
        })),
    })),
  );
}

/** The extension an upload is stored under, from its file name, or null when not a spreadsheet. */
export function importSourceOf(filename: string): { source: ImportSource; ext: string } | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "csv") return { source: "CSV", ext };
  if (ext === "xlsx") return { source: "XLSX", ext };
  if (ext === "xls") return { source: "XLS", ext };
  return null;
}

/** The largest spreadsheet the wizard uploads (the imports bucket's limit). */
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

const IMPORT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export type ImportUploadCheck =
  | {
      readonly ok: true;
      readonly source: ImportSource;
      readonly ext: string;
      readonly contentType: string;
    }
  | {
      readonly ok: false;
      readonly rule: "import_file_type" | "import_xls_unsupported" | "import_file_size";
    };

/**
 * Checks a spreadsheet before upload. Only .csv and .xlsx are read; a legacy binary .xls is refused
 * with its own plain-language rule (owner decision 28), as the database also does (1241).
 */
export function checkImportUpload(filename: string, size: number): ImportUploadCheck {
  const source = importSourceOf(filename);
  if (!source) return { ok: false, rule: "import_file_type" };
  if (source.source === "XLS") return { ok: false, rule: "import_xls_unsupported" };
  if (size > IMPORT_MAX_BYTES) return { ok: false, rule: "import_file_size" };
  const contentType = IMPORT_CONTENT_TYPES[source.ext];
  if (contentType === undefined) return { ok: false, rule: "import_file_type" };
  return { ok: true, source: source.source, ext: source.ext, contentType };
}

/** The object path of an upload: the person's own folder, a fresh id and the extension. */
export function importObjectPath(personId: string, uploadId: string, ext: string): string {
  return `${personId}/${uploadId}.${ext}`;
}

export interface NewImport {
  readonly orgId: string;
  readonly targetCode: string;
  readonly filename: string;
  readonly objectPath: string;
  readonly source: ImportSource;
  readonly body: Blob | ArrayBuffer | Uint8Array;
  readonly contentType: string;
}

/** Uploads the spreadsheet to the person's folder and creates the import, which queues detection. */
export async function createImport(db: XosClient, input: NewImport): Promise<Result<string>> {
  const { error: uploadError } = await db.storage
    .from(IMPORT_BUCKET)
    .upload(input.objectPath, input.body, { contentType: input.contentType, upsert: false });
  if (uploadError) {
    return fail({ kind: "unexpected", message: uploadError.message });
  }
  return writtenId(
    untyped(db)
      .from("import_jobs")
      .insert({
        org_id: input.orgId,
        target_code: input.targetCode,
        source: input.source,
        original_filename: input.filename,
        storage_object_path: input.objectPath,
      })
      .select("id"),
  );
}

/** A Google Sheets import: the link the worker reads through the org's Google Drive connection (A83). */
export interface NewSheetsImport {
  readonly orgId: string;
  readonly targetCode: string;
  readonly link: string;
  /** The person's own imports folder; the worker saves the fetched sheet here as .xlsx. */
  readonly objectPath: string;
}

/** The spreadsheet id of a Google Sheets link, or null when it is not one (the database checks again). */
export function googleSheetsLinkId(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null; // Not a URL at all.
  }
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com") return null;
  return /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})(?:\/|$)/.exec(url.pathname)?.[1] ?? null;
}

/** Starts an import of a Google Sheets link; nothing is uploaded, the worker fetches it (import.fetch). */
export function createSheetsImport(db: XosClient, input: NewSheetsImport): Promise<Result<string>> {
  const id = googleSheetsLinkId(input.link);
  return writtenId(
    untyped(db)
      .from("import_jobs")
      .insert({
        org_id: input.orgId,
        target_code: input.targetCode,
        source: "Google Sheets",
        original_filename: `Google Sheets ${id ?? ""}`.trim().slice(0, 255),
        storage_object_path: input.objectPath,
        source_url: input.link.trim(),
      })
      .select("id"),
  );
}

/** Starts the import of another detected sheet of a read workbook, into a target (app.import_detected_sheet). */
export function importDetectedSheet(
  db: XosClient,
  input: { sheetId: string; targetCode: string },
): Promise<Result<string>> {
  return rpc(
    db,
    "import_detected_sheet",
    { p_sheet_id: input.sheetId, p_target_code: input.targetCode },
    str,
  );
}

export interface ImportSummary {
  readonly id: string;
  readonly targetCode: string;
  readonly filename: string;
  readonly status: ImportStatus;
  readonly createdAt: string;
}

export async function listImports(db: XosClient, orgId: string): Promise<Result<ImportSummary[]>> {
  const result = await rows(
    untyped(db)
      .from("import_jobs")
      .select("id, target_code, original_filename, import_status, created_at")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(50),
  );
  if (!result.ok) return result;
  return ok(result.data.map(toSummary));
}

function toSummary(r: Raw): ImportSummary {
  return {
    id: str(r["id"]),
    targetCode: str(r["target_code"]),
    filename: str(r["original_filename"]),
    status: str(r["import_status"]) as ImportStatus,
    createdAt: str(r["created_at"]),
  };
}

export interface ImportColumn {
  readonly id: string;
  readonly sheet: string;
  readonly index: number;
  readonly header: string;
  readonly fieldName: string | null;
  readonly suggestedFieldName: string | null;
  /** Where the suggestion came from: a saved profile, the Playbook column map or header similarity. */
  readonly suggestionSource: Database["app"]["Enums"]["import_suggestion_source"] | null;
}

/** A sheet detection found in the workbook, with the proposed target and the import that reads it, if any. */
export interface ImportSheet {
  readonly id: string;
  readonly name: string;
  readonly index: number;
  readonly headerRow: number | null;
  readonly firstDataRow: number | null;
  readonly lastRow: number | null;
  readonly columnCount: number;
  readonly dataRowCount: number;
  readonly proposedTargetCode: string | null;
  readonly proposedFromPlaybook: boolean;
  /** The open import of this sheet (this import for the sheet it reads), or null. */
  readonly importId: string | null;
}

export interface RowIssue {
  readonly id: string;
  readonly sheet: string;
  readonly rowNumber: number;
  readonly state: RowState;
  readonly reason: string | null;
  readonly cells: readonly { columnIndex: number; issue: string }[];
}

export interface MergeReview {
  readonly id: string;
  readonly rowId: string;
  readonly rowNumber: number;
  readonly candidateTable: string;
  readonly candidateId: string;
  readonly candidateName: string | null;
  readonly similarity: number;
  readonly decision: MergeDecision;
}

export interface DryRun {
  readonly creates: number;
  readonly updates: number;
  readonly merges: number;
  readonly refusals: number;
  readonly skipped: number;
  readonly pendingReviews: number;
}

export interface ImportBatch {
  readonly id: string;
  readonly committedAt: string | null;
  readonly undoneAt: string | null;
  readonly undoReason: string | null;
  readonly written: number;
  readonly reverted: number;
  readonly kept: readonly { rowNumber: number; reason: string }[];
}

/** The uploader's view of their spreadsheet's virus scan (1240). */
export type UploadScanStatus = "Scanning" | "Clean" | "Infected" | "Scan Failed";

export interface ImportDetail extends ImportSummary {
  readonly mappingConfirmedAt: string | null;
  readonly source: ImportSource;
  /** The sheet of the workbook this import reads. */
  readonly sheetName: string | null;
  /** The Google Sheets link of a Google Sheets import. */
  readonly sourceUrl: string | null;
  /** Why the worker failed the import before reading it (google_sheet_not_shared and others). */
  readonly failureCode: string | null;
  /** Every sheet of the workbook, listed on the import detection read first. */
  readonly sheets: readonly ImportSheet[];
  /**
   * The spreadsheet's virus scan, while the import waits for it or after it failed; null once the file
   * was read, or for anyone but the uploader (app.my_upload_scan_status).
   */
  readonly scanStatus: UploadScanStatus | null;
  readonly columns: readonly ImportColumn[];
  readonly issues: readonly RowIssue[];
  readonly reviews: readonly MergeReview[];
  readonly dryRun: DryRun | null;
  readonly batches: readonly ImportBatch[];
}

const SCAN_STATUSES: readonly string[] = ["Scanning", "Clean", "Infected", "Scan Failed"];

/** The scan of the job's spreadsheet, asked only while the import waits on it or after it failed. */
async function uploadScanStatus(db: XosClient, job: Raw): Promise<Result<UploadScanStatus | null>> {
  const status = str(job["import_status"]);
  const path = strOrNull(job["storage_object_path"]);
  if ((status !== "Uploaded" && status !== "Failed") || path === null) return ok(null);
  return rpc(db, "my_upload_scan_status", { p_bucket_id: "imports", p_object_name: path }, (d) =>
    typeof d === "string" && SCAN_STATUSES.includes(d) ? (d as UploadScanStatus) : null,
  );
}

/** One import with everything the wizard shows; not-found when the caller may not see it. */
export async function getImport(db: XosClient, id: string): Promise<Result<ImportDetail>> {
  const job = await rows(
    untyped(db)
      .from("import_jobs")
      .select(
        "id, target_code, original_filename, import_status, created_at, mapping_confirmed_at, storage_object_path, source, sheet_name, source_url, failure_code, import_job_sheet_id",
      )
      .eq("id", id)
      .is("deleted_at", null)
      .limit(1),
  );
  if (!job.ok) return job;
  const head = job.data[0];
  if (!head) return fail({ kind: "not-found" });
  const sheetSource = strOrNull(head["import_job_sheet_id"]);
  const [columns, results, reviews, dry, batches, sheets] = await Promise.all([
    rows(
      untyped(db)
        .from("import_job_columns")
        .select(
          "id, sheet_name, column_index, header, field_name, suggested_field_name, suggestion_source",
        )
        .eq("import_job_id", id)
        .is("deleted_at", null)
        .order("column_index"),
    ),
    rows(
      untyped(db)
        .from("import_row_results")
        .select(
          "id, sheet_name, row_number, row_state, reason, import_batch_id, undo_outcome, undo_reason, import_cell_issues (column_index, issue_code)",
        )
        .eq("import_job_id", id)
        .is("deleted_at", null)
        .order("row_number")
        .limit(5000),
    ),
    rows(
      untyped(db)
        .from("merge_reviews")
        .select(
          "id, import_row_result_id, candidate_table, candidate_id, similarity, decision, import_row_results!inner (row_number, import_job_id)",
        )
        .eq("import_row_results.import_job_id", id)
        .is("deleted_at", null)
        .order("created_at"),
    ),
    rpc(
      db,
      "import_dry_run",
      { p_import_job_id: id },
      (d) => ((d as Raw[] | null) ?? [])[0] ?? null,
    ),
    rows(
      untyped(db)
        .from("import_batches")
        .select("id, committed_at, undone_at, undo_reason")
        .eq("import_job_id", id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
    ),
    importSheets(db, id, sheetSource),
  ]);
  if (!columns.ok) return columns;
  if (!sheets.ok) return sheets;
  if (!results.ok) return results;
  if (!reviews.ok) return reviews;
  if (!dry.ok) return dry;
  if (!batches.ok) return batches;

  const names = await candidateNames(db, reviews.data);
  if (!names.ok) return names;
  const scan = await uploadScanStatus(db, head);
  if (!scan.ok) return scan;

  return ok({
    ...toSummary(head),
    mappingConfirmedAt: strOrNull(head["mapping_confirmed_at"]),
    source: str(head["source"]) as ImportSource,
    sheetName: strOrNull(head["sheet_name"]),
    sourceUrl: strOrNull(head["source_url"]),
    failureCode: strOrNull(head["failure_code"]),
    sheets: sheets.data.map((sheet) =>
      sheet.name === strOrNull(head["sheet_name"]) && sheet.importId === null
        ? { ...sheet, importId: id }
        : sheet,
    ),
    scanStatus: scan.data,
    columns: columns.data.map((c) => ({
      id: str(c["id"]),
      sheet: str(c["sheet_name"]),
      index: num(c["column_index"]),
      header: str(c["header"]),
      fieldName: strOrNull(c["field_name"]),
      suggestedFieldName: strOrNull(c["suggested_field_name"]),
      suggestionSource: strOrNull(c["suggestion_source"]) as ImportColumn["suggestionSource"],
    })),
    issues: results.data
      .filter(
        (r) =>
          r["row_state"] === "Invalid" ||
          r["row_state"] === "Refused" ||
          r["row_state"] === "Skipped",
      )
      .map((r) => ({
        id: str(r["id"]),
        sheet: str(r["sheet_name"]),
        rowNumber: num(r["row_number"]),
        state: str(r["row_state"]) as RowState,
        reason: strOrNull(r["reason"]),
        cells: ((r["import_cell_issues"] as Raw[] | null) ?? []).map((c) => ({
          columnIndex: num(c["column_index"]),
          issue: str(c["issue_code"]),
        })),
      })),
    reviews: reviews.data.map((v) => {
      const row = (v["import_row_results"] as Raw | null) ?? {};
      return {
        id: str(v["id"]),
        rowId: str(v["import_row_result_id"]),
        rowNumber: num(row["row_number"]),
        candidateTable: str(v["candidate_table"]),
        candidateId: str(v["candidate_id"]),
        candidateName: names.data.get(str(v["candidate_id"])) ?? null,
        similarity: num(v["similarity"]),
        decision: str(v["decision"]) as MergeDecision,
      };
    }),
    dryRun: dry.data
      ? {
          creates: num(dry.data["creates"]),
          updates: num(dry.data["updates"]),
          merges: num(dry.data["merges"]),
          refusals: num(dry.data["refusals"]),
          skipped: num(dry.data["skipped"]),
          pendingReviews: num(dry.data["pending_reviews"]),
        }
      : null,
    batches: batches.data.map((b) => {
      const mine = results.data.filter((r) => r["import_batch_id"] === b["id"]);
      return {
        id: str(b["id"]),
        committedAt: strOrNull(b["committed_at"]),
        undoneAt: strOrNull(b["undone_at"]),
        undoReason: strOrNull(b["undo_reason"]),
        written: mine.length,
        reverted: mine.filter((r) => r["undo_outcome"] === "Reverted").length,
        kept: mine
          .filter((r) => r["undo_outcome"] === "Kept")
          .map((r) => ({ rowNumber: num(r["row_number"]), reason: str(r["undo_reason"]) })),
      };
    }),
  });
}

/**
 * The detected sheets of an import's workbook: its own list, or for an import started from a detected sheet,
 * the list of the import that read the workbook first. Each carries the open import that reads it.
 */
async function importSheets(
  db: XosClient,
  importId: string,
  sheetSource: string | null,
): Promise<Result<ImportSheet[]>> {
  let owner = importId;
  if (sheetSource !== null) {
    const parent = await rows(
      untyped(db).from("import_job_sheets").select("import_job_id").eq("id", sheetSource).limit(1),
    );
    if (!parent.ok) return parent;
    owner = strOrNull(parent.data[0]?.["import_job_id"]) ?? importId;
  }
  const list = await rows(
    untyped(db)
      .from("import_job_sheets")
      .select(
        "id, sheet_name, sheet_index, header_row, first_data_row, last_row, column_count, data_row_count, proposed_target_code, proposed_from_playbook",
      )
      .eq("import_job_id", owner)
      .is("deleted_at", null)
      .order("sheet_index"),
  );
  if (!list.ok) return list;
  const ids = list.data.map((s) => str(s["id"]));
  const opened = new Map<string, string>();
  if (ids.length > 0) {
    const jobs = await rows(
      untyped(db)
        .from("import_jobs")
        .select("id, import_job_sheet_id, import_status")
        .in("import_job_sheet_id", ids)
        .is("deleted_at", null),
    );
    if (!jobs.ok) return jobs;
    for (const j of jobs.data) {
      const status = str(j["import_status"]);
      if (status !== "Canceled" && status !== "Failed" && status !== "Undone") {
        opened.set(str(j["import_job_sheet_id"]), str(j["id"]));
      }
    }
  }
  return ok(
    list.data.map((s) => ({
      id: str(s["id"]),
      name: str(s["sheet_name"]),
      index: num(s["sheet_index"]),
      headerRow: numOrNull(s["header_row"]),
      firstDataRow: numOrNull(s["first_data_row"]),
      lastRow: numOrNull(s["last_row"]),
      columnCount: num(s["column_count"]),
      dataRowCount: num(s["data_row_count"]),
      proposedTargetCode: strOrNull(s["proposed_target_code"]),
      proposedFromPlaybook: s["proposed_from_playbook"] === true,
      importId: opened.get(str(s["id"])) ?? null,
    })),
  );
}

/** Display names of merge candidates, read as the caller: venues by name, counterparties by company. */
async function candidateNames(
  db: XosClient,
  reviews: readonly Raw[],
): Promise<Result<Map<string, string>>> {
  const names = new Map<string, string>();
  const ids = (table: string) =>
    reviews.filter((r) => r["candidate_table"] === table).map((r) => str(r["candidate_id"]));
  const venues = ids("app.venues");
  const counterparties = ids("app.counterparties");
  if (venues.length > 0) {
    const result = await rows(untyped(db).from("venues").select("id, name").in("id", venues));
    if (!result.ok) return result;
    for (const r of result.data) names.set(str(r["id"]), str(r["name"]));
  }
  if (counterparties.length > 0) {
    const result = await rows(
      untyped(db).from("counterparties").select("id, counterparty_name").in("id", counterparties),
    );
    if (!result.ok) return result;
    for (const r of result.data) names.set(str(r["id"]), str(r["counterparty_name"]));
  }
  return ok(names);
}

/** Saves the person's mapping (null skips a column) and confirms it once, which queues validation. */
export async function confirmMapping(
  db: XosClient,
  input: { importId: string; mapping: readonly { columnId: string; fieldName: string | null }[] },
): Promise<Result<string>> {
  for (const m of input.mapping) {
    const { error } = await untyped(db)
      .from("import_job_columns")
      .update({ field_name: m.fieldName })
      .eq("id", m.columnId)
      .eq("import_job_id", input.importId);
    if (error) return fail(toDataError(error));
  }
  return writtenId(
    untyped(db)
      .from("import_jobs")
      .update({ mapping_confirmed_at: new Date().toISOString() })
      .eq("id", input.importId)
      .select("id"),
  );
}

/** A person decides a fuzzy match: merge into the existing row, or keep the row separate. */
export function decideMergeReview(
  db: XosClient,
  input: { id: string; decision: "Merged" | "Kept Separate" },
): Promise<Result<string>> {
  return writtenId(
    untyped(db)
      .from("merge_reviews")
      .update({ decision: input.decision })
      .eq("id", input.id)
      .select("id"),
  );
}

/** Commits a validated import: opens the batch and queues the worker. Returns the batch id. */
export function requestImportCommit(db: XosClient, importId: string): Promise<Result<string>> {
  return rpc(db, "request_import_commit", { p_import_job_id: importId }, str);
}

export interface UndoOutcome {
  readonly reverted: number;
  readonly kept: number;
}

/** Undoes a whole batch within 7 days; rows a later edit depends on are kept and listed. */
export async function undoImportBatch(
  db: XosClient,
  input: { batchId: string; reason: string },
): Promise<Result<UndoOutcome>> {
  return rpc(
    db,
    "undo_import_batch",
    { p_import_batch_id: input.batchId, p_reason: input.reason },
    (d) => {
      const r = ((d as Raw[] | null) ?? [])[0] ?? {};
      return { reverted: num(r["reverted"]), kept: num(r["kept"]) };
    },
  );
}

/** Cancels an import that has not started committing. */
export function cancelImport(db: XosClient, importId: string): Promise<Result<string>> {
  return writtenId(
    untyped(db)
      .from("import_jobs")
      .update({ import_status: "Canceled" })
      .eq("id", importId)
      .select("id"),
  );
}

/**
 * The import wizard's feature flags for an org (0540): Google Sheets links and the assistant's mapping step. The
 * imports.ai_mapping flag is on by default (1402), so Aurora's step also needs the org's own AI switch: the
 * mapping feature turned on by an Admin in Settings, AI Features, with aurora_ai in the plan
 * (app.ai_enabled_features, 0650). An org that turned AI off never sees the step, and app.ai_begin_request
 * refuses aurora_feature_off before any column name reaches a model.
 */
export async function importFlags(
  db: XosClient,
  orgId: string,
): Promise<Result<{ googleSheets: boolean; aiMapping: boolean }>> {
  const flags = await rpc(
    db,
    "org_feature_flags",
    { p_org_id: orgId },
    (d) =>
      new Set(
        ((d as Raw[] | null) ?? [])
          .filter((r) => r["enabled"] === true)
          .map((r) => str(r["flag_key"])),
      ),
  );
  if (!flags.ok) return flags;
  const googleSheets = flags.data.has("imports.google_sheets");
  if (!flags.data.has("imports.ai_mapping")) return ok({ googleSheets, aiMapping: false });
  const features = await rpc(db, "ai_enabled_features", { p_org_id: orgId }, (d) =>
    ((d as unknown[] | null) ?? []).map(String),
  );
  if (!features.ok) return features;
  return ok({ googleSheets, aiMapping: features.data.includes("mapping") });
}

/** Rounds a similarity of 0.85 to 1 to a whole percentage for display. */
export function similarityPercent(similarity: number | null): number | null {
  const value = numOrNull(similarity);
  return value === null ? null : Math.round(value * 100);
}
