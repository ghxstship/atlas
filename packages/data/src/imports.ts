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

/**
 * The import wizard's side of imports (A36 on A18's 0530 and A36's 1061; Section 4.6.2): upload a
 * spreadsheet, confirm the column mapping, decide fuzzy duplicates, read the dry run, request the commit
 * and undo a batch. Detection, validation and the writes run in the import worker (import-worker.ts,
 * service role); everything here runs as the signed-in person.
 */

export const IMPORT_BUCKET = "imports";

export type ImportSource = "CSV" | "XLSX" | "XLS" | "Google Sheets";
export type ImportStatus =
  | "Uploaded"
  | "Detected"
  | "Mapped"
  | "Validated"
  | "Committing"
  | "Committed"
  | "Undone"
  | "Failed"
  | "Canceled";
export type RowState = "Valid" | "Invalid" | "Written" | "Refused" | "Skipped";
export type MergeDecision = "Pending" | "Merged" | "Kept Separate";

export interface ImportTargetField {
  readonly name: string;
  readonly required: boolean;
  readonly strongKey: boolean;
}

export interface ImportTarget {
  readonly code: string;
  /** Capability that authorizes importing into the target. */
  readonly writeCapability: string;
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
      writeCapability: str(t["write_capability"]),
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

export interface ImportDetail extends ImportSummary {
  readonly mappingConfirmedAt: string | null;
  readonly columns: readonly ImportColumn[];
  readonly issues: readonly RowIssue[];
  readonly reviews: readonly MergeReview[];
  readonly dryRun: DryRun | null;
  readonly batches: readonly ImportBatch[];
}

/** One import with everything the wizard shows; not-found when the caller may not see it. */
export async function getImport(db: XosClient, id: string): Promise<Result<ImportDetail>> {
  const job = await rows(
    untyped(db)
      .from("import_jobs")
      .select("id, target_code, original_filename, import_status, created_at, mapping_confirmed_at")
      .eq("id", id)
      .is("deleted_at", null)
      .limit(1),
  );
  if (!job.ok) return job;
  const head = job.data[0];
  if (!head) return fail({ kind: "not-found" });
  const [columns, results, reviews, dry, batches] = await Promise.all([
    rows(
      untyped(db)
        .from("import_job_columns")
        .select("id, sheet_name, column_index, header, field_name, suggested_field_name")
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
  ]);
  if (!columns.ok) return columns;
  if (!results.ok) return results;
  if (!reviews.ok) return reviews;
  if (!dry.ok) return dry;
  if (!batches.ok) return batches;

  const names = await candidateNames(db, reviews.data);
  if (!names.ok) return names;

  return ok({
    ...toSummary(head),
    mappingConfirmedAt: strOrNull(head["mapping_confirmed_at"]),
    columns: columns.data.map((c) => ({
      id: str(c["id"]),
      sheet: str(c["sheet_name"]),
      index: num(c["column_index"]),
      header: str(c["header"]),
      fieldName: strOrNull(c["field_name"]),
      suggestedFieldName: strOrNull(c["suggested_field_name"]),
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

/** Rounds a similarity of 0.85 to 1 to a whole percentage for display. */
export function similarityPercent(similarity: number | null): number | null {
  const value = numOrNull(similarity);
  return value === null ? null : Math.round(value * 100);
}
