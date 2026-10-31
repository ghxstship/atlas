import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * The schedule grid (B4, G-41, migration 2931, ADR 0143 decision 3): a day's records, or a running order's cues,
 * typed into rows and saved in one transaction. The RPCs run as the caller, so row level security and every guard
 * decide; a save is all or nothing, and its preview runs the same writes and undoes them, so the preview the grid
 * shows is what Apply writes. Refusals come back on their rows with the rule and the database's sentence.
 */

export type GridAction = "create" | "update" | "move" | "unchanged" | "refused";

export interface GridRowResult {
  /** 1-based index of the row in the save. */
  readonly index: number;
  /** The record or cue the row created or edited; for a refused new row, null. */
  readonly id: string | null;
  readonly action: GridAction;
  readonly rule: string | null;
  readonly message: string | null;
}

export interface GridSave {
  readonly rows: readonly GridRowResult[];
  readonly created: number;
  readonly changed: number;
  readonly refused: number;
}

interface GridRpcRow {
  row_index: number;
  record_id: string | null;
  action: GridAction;
  refusal_code: string | null;
  refusal_message: string | null;
}

export function toGridSave(rows: readonly GridRpcRow[]): GridSave {
  const mapped = rows.map((r) => ({
    index: r.row_index,
    id: r.record_id,
    action: r.action,
    rule: r.refusal_code,
    message: r.refusal_message,
  }));
  return {
    rows: mapped,
    created: mapped.filter((r) => r.action === "create").length,
    changed: mapped.filter((r) => r.action === "update" || r.action === "move").length,
    refused: mapped.filter((r) => r.action === "refused").length,
  };
}

/** One row of the day grid. An edited row carries the values the grid loaded in `expect` (compare and set). */
export interface DayGridRow {
  readonly id?: string | undefined;
  readonly expect?: Readonly<Record<string, string | boolean | null>> | undefined;
  readonly title: string;
  /** For a new row only; a record keeps its kind. */
  readonly recordKind?: string | undefined;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly dueAt: string | null;
  readonly startTbc: boolean;
  readonly ownerPartyId: string | null;
}

export function dayGridPayload(rows: readonly DayGridRow[]): Record<string, unknown>[] {
  return rows.map((r) => ({
    ...(r.id ? { id: r.id } : { record_kind: r.recordKind ?? null }),
    ...(r.expect ? { expect: r.expect } : {}),
    title: r.title,
    starts_at: r.startsAt,
    ends_at: r.endsAt,
    due_at: r.dueAt,
    start_tbc: r.startTbc,
    owner_party_id: r.ownerPartyId,
  }));
}

/** Previews (commit false) or saves a project day's grid. */
export async function saveDayGrid(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly day: string;
    readonly rows: readonly DayGridRow[];
    readonly commit: boolean;
  },
): Promise<Result<GridSave>> {
  const { data, error } = await untyped(db).rpc("save_day_grid", {
    p_project_id: input.projectId,
    p_day: input.day,
    p_rows: dayGridPayload(input.rows),
    p_commit: input.commit,
  });
  if (error) return fail(toDataError(error));
  return ok(toGridSave(data as GridRpcRow[]));
}

/** One row of the cue grid, in running order. Every live cue of the run is listed once; the grid never deletes. */
export interface CueGridRow {
  readonly id?: string | undefined;
  readonly expect?: Readonly<Record<string, string | number | boolean | null>> | undefined;
  readonly label: string;
  readonly plannedAt: string | null;
  readonly durationMinutes: number | null;
  readonly segment: string | null;
  readonly startTbc: boolean;
}

export function cueGridPayload(rows: readonly CueGridRow[]): Record<string, unknown>[] {
  return rows.map((r) => ({
    ...(r.id ? { id: r.id } : {}),
    ...(r.expect ? { expect: r.expect } : {}),
    label: r.label,
    planned_at: r.plannedAt,
    duration_minutes: r.durationMinutes,
    segment: r.segment,
    start_tbc: r.startTbc,
  }));
}

/** Previews (commit false) or saves a running order's cue grid. */
export async function saveCueGrid(
  db: XosClient,
  input: {
    readonly runOfShowId: string;
    readonly rows: readonly CueGridRow[];
    readonly commit: boolean;
  },
): Promise<Result<GridSave>> {
  const { data, error } = await untyped(db).rpc("save_cue_grid", {
    p_run_of_show_id: input.runOfShowId,
    p_rows: cueGridPayload(input.rows),
    p_commit: input.commit,
  });
  if (error) return fail(toDataError(error));
  return ok(toGridSave(data as GridRpcRow[]));
}

/** Errors keyed "row:col" for SpreadsheetGrid, from a save's refused rows (row ids are the grid's row ids). */
export function gridErrors(
  save: GridSave,
  rowIds: readonly string[],
  column: (rule: string | null) => string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const r of save.rows) {
    if (r.action !== "refused") continue;
    const rowId = rowIds[r.index - 1];
    if (rowId) errors[`${rowId}:${column(r.rule)}`] = r.message ?? r.rule ?? "";
  }
  return errors;
}

/** A cue as the cue grid loads it: its fields, its length in minutes and whether it was called. */
export interface CueGridSource {
  readonly id: string;
  readonly position: number;
  readonly label: string;
  readonly plannedAt: string | null;
  readonly durationMinutes: number | null;
  readonly segment: string | null;
  readonly startTbc: boolean;
  readonly calledAt: string | null;
}

/** Postgres interval text (HH:MM:SS, with optional days) as whole minutes; null for none. */
export function intervalMinutes(value: string | null): number | null {
  if (value === null) return null;
  const match = /^(?:(\d+) days? ?)?(\d+):(\d{2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  return (
    Number(match[1] ?? 0) * 1440 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Math.round(Number(match[4]) / 60)
  );
}

/** A running order's live cues in running order, for the cue grid. */
export async function listCueGridRows(
  db: XosClient,
  runOfShowId: string,
): Promise<Result<CueGridSource[]>> {
  const { data, error } = await db
    .from("cues")
    .select("id, position, label, planned_at, duration, segment, start_tbc, called_at")
    .eq("run_of_show_id", runOfShowId)
    .is("deleted_at", null)
    .order("position");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((c) => ({
      id: c.id,
      position: c.position,
      label: c.label,
      plannedAt: c.planned_at,
      durationMinutes: intervalMinutes(c.duration === null ? null : String(c.duration)),
      segment: c.segment,
      startTbc: c.start_tbc,
      calledAt: c.called_at,
    })),
  );
}
