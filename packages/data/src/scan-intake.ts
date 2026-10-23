import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * The scan intake queue (migration 0367, Section 13): codes a Compass device could not resolve on
 * the spot wait here until a person resolves each one once, through app.resolve_scan_intake, as
 * Matched to an existing record, Created (a record made for it, such as a catalog binding) or
 * Dismissed with a note. Nothing maps a code automatically: Aurora's Suggest binding only proposes
 * (A95, Section 4.7). Row level security shows the queue to scan log readers and the scanner.
 */

type Enums = Database["app"]["Enums"];
export type ScanSymbology = Enums["scan_symbology"];
export type ScanMode = Enums["scan_mode"];
export type ScanResolution = Enums["scan_resolution"];

export interface ScanIntakeItem {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string | null;
  readonly scannedValue: string;
  readonly symbology: ScanSymbology;
  readonly scanMode: ScanMode;
  readonly scannedById: string | null;
  readonly scannedByName: string | null;
  readonly deviceScannedAt: string;
}

interface IntakeRow {
  id: string;
  project_id: string;
  scanned_value: string;
  symbology: ScanSymbology;
  scan_mode: ScanMode;
  scanned_by: string | null;
  device_scanned_at: string;
  project: { project_key: string | null } | null;
  scanner: { full_name: string | null } | null;
}

const COLUMNS =
  "id, project_id, scanned_value, symbology, scan_mode, scanned_by, device_scanned_at, project:projects!scan_intake_project_id_fkey(project_key), scanner:people!scan_intake_scanned_by_fkey(full_name)";

/** The most scans the queue lists at once, newest first. */
export const SCAN_INTAKE_LIMIT = 200;

/** Open scans of an org, or of one project, newest first. */
export async function listOpenScanIntake(
  db: XosClient,
  filter: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<ScanIntakeItem[]>> {
  let query = db
    .from("scan_intake")
    .select(COLUMNS)
    .eq("org_id", filter.orgId)
    .is("resolved_at", null)
    .is("deleted_at", null);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  const { data, error } = await query
    .order("device_scanned_at", { ascending: false })
    .limit(SCAN_INTAKE_LIMIT);
  if (error) return fail(toDataError(error));
  return ok(
    (data as unknown as IntakeRow[]).map((r) => ({
      id: r.id,
      projectId: r.project_id,
      projectKey: r.project?.project_key ?? null,
      scannedValue: r.scanned_value,
      symbology: r.symbology,
      scanMode: r.scan_mode,
      scannedById: r.scanned_by,
      scannedByName: r.scanner?.full_name ?? null,
      deviceScannedAt: r.device_scanned_at,
    })),
  );
}

export type ScanIntakeResolution =
  | {
      readonly resolution: "Matched" | "Created";
      /** Table of the record the scan resolved to, without the schema, such as catalog_bindings. */
      readonly subjectTable: string;
      readonly subjectId: string;
      readonly note?: string | null;
    }
  | { readonly resolution: "Dismissed"; readonly note: string };

/**
 * Resolves an open scan once. Needs credentials.scan.write on its project; refuses a second
 * resolution (scan_intake_resolved), a dismissal without a note (scan_intake_dismiss_note) and a
 * record of another org (scan_intake_subject).
 */
export async function resolveScanIntake(
  db: XosClient,
  id: string,
  input: ScanIntakeResolution,
): Promise<Result<null>> {
  const { error } = await db.rpc("resolve_scan_intake", {
    p_scan_intake_id: id,
    p_resolution: input.resolution,
    ...(input.resolution === "Dismissed"
      ? { p_note: input.note }
      : {
          p_subject_table: input.subjectTable,
          p_subject_id: input.subjectId,
          ...(input.note ? { p_note: input.note } : {}),
        }),
  });
  return error ? fail(toDataError(error)) : ok(null);
}
