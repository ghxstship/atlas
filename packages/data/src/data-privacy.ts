import type { XosClient } from "./client.ts";
import { Constants, type Database } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Data and Privacy in Settings (A86, RRR-131, finding A65-004; Section 4.5.6 org settings item 39):
 *   * data subject requests and their 30-day clock (0501), moved through app.transition_dsar
 *     (data.request.manage);
 *   * legal holds, placed and released by insert and update under row level security
 *     (data.legal_hold.manage); a hold is never edited or deleted, only released once (0500);
 *   * the platform retention policies and column classifications, read-only (0500, 0330);
 *   * the org's view exports (0530): the caller's own, or every one with audit.log.read.
 */

export type DataRequestState = Database["app"]["Enums"]["dsar_state"];
export type DataRequestType = Database["app"]["Enums"]["dsar_request_type"];
export type DataClassification = Database["app"]["Enums"]["data_classification"];

export const DATA_CLASSIFICATIONS: readonly DataClassification[] =
  Constants.app.Enums.data_classification;

/** Allowed moves of a data request (0501's lifecycle rules), in the order the buttons appear. */
export const DATA_REQUEST_MOVES: Readonly<Record<DataRequestState, readonly DataRequestState[]>> = {
  Received: ["Verifying", "In Progress", "Refused", "Withdrawn"],
  Verifying: ["In Progress", "Refused", "Withdrawn"],
  "In Progress": ["Extended", "Completed", "Refused", "Withdrawn"],
  Extended: ["Completed", "Refused", "Withdrawn"],
  Completed: [],
  Refused: [],
  Withdrawn: [],
};

export interface DataRequest {
  readonly id: string;
  readonly type: DataRequestType;
  readonly state: DataRequestState;
  readonly subjectEmail: string;
  readonly details: string | null;
  readonly receivedAt: string;
  readonly dueAt: string | null;
  readonly overdue: boolean;
}

/** The org's data requests, open ones first by due date, then closed ones newest first. */
export async function listDataRequests(
  db: XosClient,
  orgId: string,
): Promise<Result<DataRequest[]>> {
  const [requests, clock] = await Promise.all([
    db
      .from("dsar_requests")
      .select("id, request_type, dsar_state, subject_email, details, received_at")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("received_at", { ascending: false })
      .limit(100),
    db.from("dsar_request_clock").select("dsar_request_id, due_at, is_overdue").eq("org_id", orgId),
  ]);
  if (requests.error) return fail(toDataError(requests.error));
  if (clock.error) return fail(toDataError(clock.error));
  const due = new Map(clock.data.map((c) => [c.dsar_request_id, c]));
  const rows = requests.data.map((r) => ({
    id: r.id,
    type: r.request_type,
    state: r.dsar_state,
    subjectEmail: r.subject_email,
    details: r.details,
    receivedAt: r.received_at,
    dueAt: due.get(r.id)?.due_at ?? null,
    overdue: due.get(r.id)?.is_overdue === true,
  }));
  const open = (r: DataRequest) => DATA_REQUEST_MOVES[r.state].length > 0;
  return ok([
    ...rows.filter(open).sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? "")),
    ...rows.filter((r) => !open(r)),
  ]);
}

/** Moves a request with compare-and-set; a reason is required and recorded with the move. */
export async function moveDataRequest(
  db: XosClient,
  move: {
    readonly id: string;
    readonly expected: DataRequestState;
    readonly next: DataRequestState;
    readonly reason: string;
  },
): Promise<Result<null>> {
  const { error } = await db.rpc("transition_dsar", {
    p_dsar_request_id: move.id,
    p_expected: move.expected,
    p_next: move.next,
    p_reason: move.reason,
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

// Legal holds ------------------------------------------------------------------------------------------------

export interface LegalHold {
  readonly id: string;
  readonly matter: string;
  /** One table, or null for every table of the org. */
  readonly tableName: string | null;
  readonly placedAt: string;
  readonly releasedAt: string | null;
}

export async function listLegalHolds(db: XosClient, orgId: string): Promise<Result<LegalHold[]>> {
  const { data, error } = await db
    .from("legal_holds")
    .select("id, matter, table_name, placed_at, released_at")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("placed_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      matter: r.matter,
      tableName: r.table_name,
      placedAt: r.placed_at,
      releasedAt: r.released_at,
    })),
  );
}

/** Places a hold: purges, partition expiry, account deletion and tenant purge skip the held data. */
export async function placeLegalHold(
  db: XosClient,
  input: { readonly orgId: string; readonly matter: string; readonly tableName: string | null },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("legal_holds")
    .insert({ org_id: input.orgId, matter: input.matter, table_name: input.tableName })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Releases a hold once; the database stamps the time. */
export async function releaseLegalHold(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("legal_holds")
    .update({ released_at: new Date().toISOString() })
    .eq("id", id)
    .is("released_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length > 0 ? ok(null) : fail({ kind: "not-found" });
}

// Retention and classification -------------------------------------------------------------------------------

export interface RetentionPolicy {
  readonly tableName: string;
  readonly retention: string;
  readonly basis: string;
  readonly rationale: string | null;
}

/** The platform's retention periods, by table. */
export async function listRetentionPolicies(db: XosClient): Promise<Result<RetentionPolicy[]>> {
  const { data, error } = await db
    .from("retention_policies")
    .select("table_name, retention, basis, rationale")
    .order("table_name");
  if (error) return fail(toDataError(error));
  return ok(
    data.flatMap((r) =>
      r.table_name
        ? [
            {
              tableName: r.table_name,
              retention: r.retention ?? "",
              basis: r.basis ?? "",
              rationale: r.rationale,
            },
          ]
        : [],
    ),
  );
}

export interface ClassificationSummary {
  /** Columns per classification. */
  readonly counts: Readonly<Record<DataClassification, number>>;
  /** Every Restricted column with the capability that reads it. */
  readonly restricted: readonly {
    readonly table: string;
    readonly column: string;
    readonly capability: string | null;
  }[];
}

export async function getClassificationSummary(
  db: XosClient,
): Promise<Result<ClassificationSummary>> {
  const { data, error } = await db
    .from("column_classifications")
    .select("table_name, column_name, classification, read_capability");
  if (error) return fail(toDataError(error));
  const counts = Object.fromEntries(DATA_CLASSIFICATIONS.map((c) => [c, 0])) as Record<
    DataClassification,
    number
  >;
  const restricted: { table: string; column: string; capability: string | null }[] = [];
  for (const r of data) {
    if (!r.classification || !r.table_name || !r.column_name) continue;
    counts[r.classification] += 1;
    if (r.classification === "Restricted") {
      restricted.push({
        table: r.table_name,
        column: r.column_name,
        capability: r.read_capability,
      });
    }
  }
  restricted.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
  return ok({ counts, restricted });
}

// Exports ----------------------------------------------------------------------------------------------------

export interface ExportJob {
  readonly id: string;
  readonly sourceLabel: string;
  readonly format: string;
  readonly status: string;
  readonly classification: DataClassification;
  readonly rowCount: number | null;
  readonly createdAt: string;
}

/** Recent view exports the caller may see, newest first. */
export async function listExportJobs(
  db: XosClient,
  orgId: string,
  limit = 20,
): Promise<Result<ExportJob[]>> {
  const { data, error } = await db
    .from("export_jobs")
    .select("id, source_label, export_format, export_status, classification, row_count, created_at")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      sourceLabel: r.source_label,
      format: r.export_format,
      status: r.export_status,
      classification: r.classification,
      rowCount: r.row_count,
      createdAt: r.created_at,
    })),
  );
}
