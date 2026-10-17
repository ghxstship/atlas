import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Dashboards and scheduled report email (A43, finding A38-004; Section 4.6.4, journey 29), over A18's
 * tables (0550) and A43's deliveries (1127). A dashboard is a 12-column grid of saved reports, kept for
 * one member or one team; a schedule emails a saved report as PDF, CSV or .xlsx to members of the org,
 * each run with the recipient's own access. Every write goes through row level security.
 */

type Raw = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const absent = (v: unknown): boolean => v === null || v === undefined;

async function rows(
  query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
): Promise<Result<Raw[]>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data as Raw[] | null) ?? []);
}

async function done(
  query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
): Promise<Result<null>> {
  const { error } = await query;
  return error ? fail(toDataError(error)) : ok(null);
}

async function inserted(
  query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
): Promise<Result<{ id: string }>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok({ id: str((data as Raw | null)?.["id"]) });
}

const now = () => new Date().toISOString();

// Dashboards ---------------------------------------------------------------------------------------------

export interface Dashboard {
  readonly id: string;
  readonly name: string;
  readonly teamId: string | null;
  readonly mine: boolean;
  readonly tileCount: number;
}

export interface DashboardTile {
  readonly id: string;
  readonly dashboardId: string;
  readonly reportDefinitionId: string;
  readonly reportName: string;
  readonly gridColumn: number;
  readonly gridRow: number;
  readonly columnSpan: number;
  readonly rowSpan: number;
}

/** The viewer's dashboards and their teams', by name. */
export async function listDashboards(
  db: XosClient,
  input: { readonly orgId: string; readonly membershipId: string },
): Promise<Result<Dashboard[]>> {
  const result = await rows(
    untyped(db)
      .from("dashboards")
      .select("id, name, team_id, membership_id, tiles:dashboard_tiles(id, deleted_at)")
      .eq("org_id", input.orgId)
      .is("deleted_at", null)
      .order("name"),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      id: str(r["id"]),
      name: str(r["name"]),
      teamId: strOrNull(r["team_id"]),
      mine: str(r["membership_id"]) === input.membershipId,
      tileCount: ((r["tiles"] as Raw[] | null) ?? []).filter((t) => absent(t["deleted_at"])).length,
    })),
  );
}

/** A dashboard for the viewer, or for one of their teams. */
export async function createDashboard(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly membershipId: string;
    readonly name: string;
    readonly teamId?: string | null;
  },
): Promise<Result<{ id: string }>> {
  return inserted(
    untyped(db)
      .from("dashboards")
      .insert({
        org_id: input.orgId,
        name: input.name.trim(),
        ...(input.teamId ? { team_id: input.teamId } : { membership_id: input.membershipId }),
      })
      .select("id")
      .single(),
  );
}

export async function deleteDashboard(db: XosClient, id: string): Promise<Result<null>> {
  return done(untyped(db).from("dashboards").update({ deleted_at: now() }).eq("id", id));
}

/** A dashboard's tiles in grid order, with their reports' names. */
export async function listTiles(
  db: XosClient,
  dashboardId: string,
): Promise<Result<DashboardTile[]>> {
  const result = await rows(
    untyped(db)
      .from("dashboard_tiles")
      .select(
        "id, dashboard_id, report_definition_id, grid_column, grid_row, column_span, row_span, report:report_definitions(name)",
      )
      .eq("dashboard_id", dashboardId)
      .is("deleted_at", null)
      .order("grid_row")
      .order("grid_column"),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      id: str(r["id"]),
      dashboardId: str(r["dashboard_id"]),
      reportDefinitionId: str(r["report_definition_id"]),
      reportName: str((r["report"] as Raw | null)?.["name"]),
      gridColumn: num(r["grid_column"]),
      gridRow: num(r["grid_row"]),
      columnSpan: num(r["column_span"]),
      rowSpan: num(r["row_span"]),
    })),
  );
}

/** The next free slot of a 12-column grid for a tile `span` columns wide. */
export function nextSlot(
  tiles: readonly Pick<DashboardTile, "gridColumn" | "gridRow" | "columnSpan" | "rowSpan">[],
  span: number,
): { gridColumn: number; gridRow: number } {
  const width = Math.min(Math.max(span, 1), 12);
  const taken = (column: number, row: number) =>
    tiles.some(
      (t) =>
        row >= t.gridRow &&
        row < t.gridRow + t.rowSpan &&
        column < t.gridColumn + t.columnSpan &&
        column + width > t.gridColumn,
    );
  for (let row = 1; row < 200; row += 1) {
    for (let column = 1; column + width <= 13; column += 1) {
      if (!taken(column, row)) return { gridColumn: column, gridRow: row };
    }
  }
  return { gridColumn: 1, gridRow: 200 };
}

/** Places a saved report on a dashboard at the next free slot. */
export async function addTile(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly dashboardId: string;
    readonly reportDefinitionId: string;
    readonly columnSpan: number;
    readonly rowSpan?: number;
  },
): Promise<Result<{ id: string }>> {
  const current = await listTiles(db, input.dashboardId);
  if (!current.ok) return current;
  const slot = nextSlot(current.data, input.columnSpan);
  return inserted(
    untyped(db)
      .from("dashboard_tiles")
      .insert({
        org_id: input.orgId,
        dashboard_id: input.dashboardId,
        report_definition_id: input.reportDefinitionId,
        grid_column: slot.gridColumn,
        grid_row: slot.gridRow,
        column_span: Math.min(Math.max(input.columnSpan, 1), 13 - slot.gridColumn),
        row_span: Math.min(Math.max(input.rowSpan ?? 1, 1), 12),
      })
      .select("id")
      .single(),
  );
}

export async function removeTile(db: XosClient, id: string): Promise<Result<null>> {
  return done(untyped(db).from("dashboard_tiles").update({ deleted_at: now() }).eq("id", id));
}

// Schedules -----------------------------------------------------------------------------------------------

export type Cadence = "Daily" | "Weekly" | "Monthly";
export type ExportFormat = "CSV" | "XLSX" | "PDF";
export const CADENCES: readonly Cadence[] = ["Daily", "Weekly", "Monthly"];
export const EXPORT_FORMATS: readonly ExportFormat[] = ["PDF", "CSV", "XLSX"];

export interface ReportSchedule {
  readonly id: string;
  readonly reportDefinitionId: string;
  readonly cadence: Cadence;
  readonly localHour: number;
  readonly weekday: number | null;
  readonly monthDay: number | null;
  readonly timeZone: string;
  readonly format: ExportFormat;
  readonly nextRunAt: string;
  readonly pausedAt: string | null;
  readonly recipients: readonly { readonly id: string; readonly membershipId: string }[];
}

export interface ScheduleInput {
  readonly orgId: string;
  readonly reportDefinitionId: string;
  readonly cadence: Cadence;
  readonly localHour: number;
  readonly weekday: number | null;
  readonly monthDay: number | null;
  readonly timeZone: string;
  readonly format: ExportFormat;
  readonly recipientMembershipIds: readonly string[];
}

export interface ReportDeliveryRow {
  readonly id: string;
  readonly scheduleId: string;
  readonly membershipId: string;
  readonly status: string;
  readonly scheduledFor: string;
  readonly sentAt: string | null;
  readonly lastError: string | null;
}

/** Schedules of a report the viewer may read, with their recipients. */
export async function listSchedules(
  db: XosClient,
  reportDefinitionId: string,
): Promise<Result<ReportSchedule[]>> {
  const result = await rows(
    untyped(db)
      .from("report_schedules")
      .select(
        "id, report_definition_id, cadence, local_hour, weekday, month_day, time_zone, export_format, next_run_at, paused_at, recipients:report_schedule_recipients(id, membership_id, deleted_at)",
      )
      .eq("report_definition_id", reportDefinitionId)
      .is("deleted_at", null)
      .order("created_at"),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      id: str(r["id"]),
      reportDefinitionId: str(r["report_definition_id"]),
      cadence: str(r["cadence"]) as Cadence,
      localHour: num(r["local_hour"]),
      weekday: absent(r["weekday"]) ? null : num(r["weekday"]),
      monthDay: absent(r["month_day"]) ? null : num(r["month_day"]),
      timeZone: str(r["time_zone"]),
      format: str(r["export_format"]) as ExportFormat,
      nextRunAt: str(r["next_run_at"]),
      pausedAt: strOrNull(r["paused_at"]),
      recipients: ((r["recipients"] as Raw[] | null) ?? [])
        .filter((x) => absent(x["deleted_at"]))
        .map((x) => ({ id: str(x["id"]), membershipId: str(x["membership_id"]) })),
    })),
  );
}

/** Schedules a report by email; the database computes the next delivery time. */
export async function createSchedule(
  db: XosClient,
  input: ScheduleInput,
): Promise<Result<{ id: string }>> {
  const created = await inserted(
    untyped(db)
      .from("report_schedules")
      .insert({
        org_id: input.orgId,
        report_definition_id: input.reportDefinitionId,
        cadence: input.cadence,
        local_hour: input.localHour,
        weekday: input.cadence === "Weekly" ? input.weekday : null,
        month_day: input.cadence === "Monthly" ? input.monthDay : null,
        time_zone: input.timeZone,
        export_format: input.format,
        next_run_at: now(),
      })
      .select("id")
      .single(),
  );
  if (!created.ok) return created;
  for (const membershipId of input.recipientMembershipIds) {
    const added = await addRecipient(db, {
      orgId: input.orgId,
      scheduleId: created.data.id,
      membershipId,
    });
    if (!added.ok) return added;
  }
  return created;
}

export async function addRecipient(
  db: XosClient,
  input: { readonly orgId: string; readonly scheduleId: string; readonly membershipId: string },
): Promise<Result<{ id: string }>> {
  return inserted(
    untyped(db)
      .from("report_schedule_recipients")
      .insert({
        org_id: input.orgId,
        report_schedule_id: input.scheduleId,
        membership_id: input.membershipId,
      })
      .select("id")
      .single(),
  );
}

export async function removeRecipient(db: XosClient, id: string): Promise<Result<null>> {
  return done(
    untyped(db).from("report_schedule_recipients").update({ deleted_at: now() }).eq("id", id),
  );
}

/** Pauses or resumes a schedule. */
export async function setSchedulePaused(
  db: XosClient,
  id: string,
  paused: boolean,
): Promise<Result<null>> {
  return done(
    untyped(db)
      .from("report_schedules")
      .update({ paused_at: paused ? now() : null })
      .eq("id", id),
  );
}

export async function deleteSchedule(db: XosClient, id: string): Promise<Result<null>> {
  return done(untyped(db).from("report_schedules").update({ deleted_at: now() }).eq("id", id));
}

/** The latest deliveries of a schedule the viewer may read, newest first. */
export async function listDeliveries(
  db: XosClient,
  scheduleId: string,
): Promise<Result<ReportDeliveryRow[]>> {
  const result = await rows(
    untyped(db)
      .from("report_deliveries")
      .select(
        "id, report_schedule_id, membership_id, delivery_status, scheduled_for, sent_at, last_error",
      )
      .eq("report_schedule_id", scheduleId)
      .is("deleted_at", null)
      .order("scheduled_for", { ascending: false })
      .limit(20),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      id: str(r["id"]),
      scheduleId: str(r["report_schedule_id"]),
      membershipId: str(r["membership_id"]),
      status: str(r["delivery_status"]),
      scheduledFor: str(r["scheduled_for"]),
      sentAt: strOrNull(r["sent_at"]),
      lastError: strOrNull(r["last_error"]),
    })),
  );
}
