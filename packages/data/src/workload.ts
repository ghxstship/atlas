import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { resolveSettings } from "./settings.ts";
import { untyped } from "./untyped.ts";

/**
 * The workload view (B4, G-45, migration 2935, ADR 0143 decision 5): hours per person per day from shifts and task
 * estimates, computed at read time by app.workload as the caller, so row level security decides what counts and
 * nothing is stored. The org's scheduling.workload_day_hours decides which days read as over (isOver).
 */

export const WORKLOAD_DAY_HOURS_KEY = "scheduling.workload_day_hours";
export const WORKLOAD_DAY_HOURS_DEFAULT = 10;

export interface WorkloadCell {
  readonly personId: string;
  readonly personName: string | null;
  readonly day: string;
  readonly shiftMinutes: number;
  readonly taskHours: number;
  readonly unestimatedTasks: number;
  readonly totalHours: number;
}

interface WorkloadRow {
  person_id: string;
  person_name: string | null;
  day: string;
  shift_minutes: number;
  task_hours: number | string;
  unestimated_tasks: number;
  total_hours: number | string;
}

export interface Workload {
  readonly cells: readonly WorkloadCell[];
  /** The org's day limit in hours (scheduling.workload_day_hours). */
  readonly limit: number;
}

/** True when a day's hours are over the org's limit; the limit itself is not over. */
export function isOver(hours: number, limit: number): boolean {
  return hours > limit;
}

/** The tint step of a cell, 0 (nothing) to 4 (at or over the limit), for the heatmap. */
export function workloadStep(hours: number, limit: number): 0 | 1 | 2 | 3 | 4 {
  if (hours <= 0) return 0;
  const ratio = hours / limit;
  if (ratio >= 1) return 4;
  if (ratio >= 0.75) return 3;
  if (ratio >= 0.4) return 2;
  return 1;
}

/** An integer setting's resolved value, or the fallback. */
export function settingInteger(
  settings: ReadonlyMap<string, { readonly value: unknown }>,
  key: string,
  fallback: number,
): number {
  const value = settings.get(key)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Hours per person per day over 1 to 92 days, with the org's day limit. */
export async function loadWorkload(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly from: string;
    readonly to: string;
    readonly projectId?: string | null;
  },
): Promise<Result<Workload>> {
  const [rows, settings] = await Promise.all([
    untyped(db).rpc("workload", {
      p_org_id: input.orgId,
      p_from: input.from,
      p_to: input.to,
      p_project_id: input.projectId ?? null,
    }),
    resolveSettings(db, { orgId: input.orgId }),
  ]);
  if (rows.error) return fail(toDataError(rows.error));
  const limit = settings.ok
    ? settingInteger(settings.data, WORKLOAD_DAY_HOURS_KEY, WORKLOAD_DAY_HOURS_DEFAULT)
    : WORKLOAD_DAY_HOURS_DEFAULT;
  return ok({
    limit,
    cells: (rows.data as WorkloadRow[]).map((r) => ({
      personId: r.person_id,
      personName: r.person_name,
      day: r.day,
      shiftMinutes: r.shift_minutes,
      taskHours: Number(r.task_hours),
      unestimatedTasks: r.unestimated_tasks,
      totalHours: Number(r.total_hours),
    })),
  });
}

/** The people (rows) and days (columns) of a workload, people by name, every day of the range. */
export function workloadGrid(
  workload: Workload,
  from: string,
  to: string,
): { people: { id: string; name: string | null }[]; days: string[] } {
  const people = new Map<string, string | null>();
  for (const c of workload.cells) if (!people.has(c.personId)) people.set(c.personId, c.personName);
  const days: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return {
    people: [...people]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => (a.name ?? "￿").localeCompare(b.name ?? "￿") || a.id.localeCompare(b.id)),
    days,
  };
}
