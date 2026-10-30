import type { XosClient } from "./client.ts";
import type { BulkRow } from "./bulk.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";
import { listRecords, type RecordSummary } from "./work.ts";

/**
 * Schedule repository (Section 4.2 Schedule): timeline records and their dependencies, baselines
 * with derived variance, actuals and the replan view. Dates come from the record spine; nothing
 * here stores a derived value (Section 3.15). Atlas and Compass (A17) share these functions, and
 * the timeline helpers turn records into the rows the Timeline and Calendar views draw.
 */

// Dependencies ---------------------------------------------------------------------------------------

export interface Dependency {
  readonly id: string;
  readonly predecessorId: string;
  readonly successorId: string;
  readonly type: string;
  /** Postgres interval text, for example 02:00:00 or -1 days. */
  readonly lag: string;
}

/** Live dependencies touching the given records, as predecessor or successor. */
export async function listDependencies(
  db: XosClient,
  recordIds: readonly string[],
): Promise<Result<Dependency[]>> {
  if (recordIds.length === 0) return ok([]);
  const ids = [...recordIds].join(",");
  const { data, error } = await db
    .from("record_dependencies")
    .select("id, predecessor_record_id, successor_record_id, dependency_type, lag")
    .or(`predecessor_record_id.in.(${ids}),successor_record_id.in.(${ids})`)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    data.map((d) => ({
      id: d.id,
      predecessorId: d.predecessor_record_id,
      successorId: d.successor_record_id,
      type: d.dependency_type,
      lag: String(d.lag),
    })),
  );
}

/** Adds a dependency. The database refuses cycles and links across projects. */
export async function addDependency(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly predecessorId: string;
    readonly successorId: string;
    readonly type?: "Finish to Start" | "Start to Start" | "Finish to Finish" | "Start to Finish";
    readonly lagMinutes?: number;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("record_dependencies")
    .insert({
      org_id: input.orgId,
      predecessor_record_id: input.predecessorId,
      successor_record_id: input.successorId,
      dependency_type: input.type ?? "Finish to Start",
      lag: `${input.lagMinutes ?? 0} minutes`,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function removeDependency(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("record_dependencies")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

// Timeline -------------------------------------------------------------------------------------------

/** The start and end a record occupies on a timeline, or null when it carries no date. */
export function recordWindow(record: RecordSummary): { start: string; end: string } | null {
  const start = record.startsAt ?? record.dueAt ?? record.endsAt;
  const end = record.endsAt ?? record.dueAt ?? record.startsAt;
  if (!start || !end) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

const DAY_MS = 86_400_000;

/** The calendar day of an instant in a time zone, as YYYY-MM-DD. */
export function localDay(instant: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(typeof instant === "string" ? new Date(instant) : instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Whole days from one YYYY-MM-DD day to another. */
export function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export interface TimelineDay {
  readonly day: string;
  /** Weekday index, 0 for Sunday. */
  readonly weekday: number;
  readonly date: number;
  readonly weekend: boolean;
}

export interface TimelineBar {
  readonly record: RecordSummary;
  /** Day index of the first day, from the timeline's first day. */
  readonly start: number;
  /** Day index of the last day, inclusive. */
  readonly end: number;
  readonly milestone: boolean;
  /** Index of the first predecessor bar, for the dependency arrow. */
  readonly dependsOn?: number;
  readonly baselineStart?: number;
  readonly baselineEnd?: number;
  /** The record stays put when the schedule moves (complete, or locked into a baseline). */
  readonly locked?: boolean;
}

/** A dependency between two bars, by bar index, for the reschedule preview. */
export interface TimelineEdge {
  readonly from: number;
  readonly to: number;
  readonly type: string;
  /** The dependency's lag in hours; negative for lead. */
  readonly lagHours: number;
}

export interface TimelineModel {
  readonly days: readonly TimelineDay[];
  readonly bars: readonly TimelineBar[];
  /** Every dependency between two drawn bars. */
  readonly edges?: readonly TimelineEdge[];
  /** Index of today, when today falls inside the timeline. */
  readonly today?: number;
}

/** Hours in a Postgres interval as PostgREST prints it: `02:00:00`, `1 day`, `-3 days 04:30:00`. */
export function intervalHours(text: string): number {
  let hours = 0;
  const days = /(-?\d+)\s+days?/.exec(text);
  if (days) hours += Number(days[1]) * 24;
  const clock = /(-)?(\d+):(\d{2})(?::(\d{2}(?:\.\d+)?))?/.exec(text);
  if (clock) {
    const value = Number(clock[2]) + Number(clock[3]) / 60 + Number(clock[4] ?? 0) / 3600;
    hours += clock[1] ? -value : value;
  }
  return hours;
}

/**
 * Lays dated records out on a day grid in a time zone, with dependency arrows and baseline
 * ghosts. Records without dates are left out; the caller lists them separately (the schedule's
 * Unscheduled list, P8). When nothing is dated, `window` still draws its days, so an undated record
 * can be placed on one.
 */
export function buildTimeline(input: {
  readonly records: readonly RecordSummary[];
  /** First and last YYYY-MM-DD days drawn when no record is dated. */
  readonly window?: { readonly first: string; readonly last: string };
  readonly dependencies?: readonly Dependency[];
  readonly baseline?: ReadonlyMap<string, { start: string | null; end: string | null }>;
  /** Ids of records that stay put when the schedule moves. */
  readonly locked?: ReadonlySet<string>;
  readonly timeZone: string;
  readonly now?: Date;
  /** Days of padding on each side. */
  readonly pad?: number;
  /** At most this many days are drawn. */
  readonly maxDays?: number;
}): TimelineModel {
  const tz = input.timeZone;
  const dated = input.records
    .map((record) => ({ record, window: recordWindow(record) }))
    .filter(
      (r): r is { record: RecordSummary; window: { start: string; end: string } } =>
        r.window !== null,
    )
    .sort((a, b) => a.window.start.localeCompare(b.window.start));
  if (dated.length === 0 && !input.window) return { days: [], bars: [] };
  const pad = input.pad ?? 1;
  const firstDay =
    dated.length === 0 && input.window
      ? input.window.first
      : addDays(
          dated.reduce(
            (m, r) => (localDay(r.window.start, tz) < m ? localDay(r.window.start, tz) : m),
            "9999-12-31",
          ),
          -pad,
        );
  const lastDay =
    dated.length === 0 && input.window
      ? input.window.last
      : addDays(
          dated.reduce(
            (m, r) => (localDay(r.window.end, tz) > m ? localDay(r.window.end, tz) : m),
            "0000-01-01",
          ),
          pad,
        );
  const count = Math.max(1, Math.min(dayDiff(firstDay, lastDay) + 1, input.maxDays ?? 120));
  const days: TimelineDay[] = Array.from({ length: count }, (_, i) => {
    const day = addDays(firstDay, i);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    return {
      day,
      weekday,
      date: Number(day.slice(8, 10)),
      weekend: weekday === 0 || weekday === 6,
    };
  });
  const clamp = (n: number) => Math.max(0, Math.min(count - 1, n));
  const index = new Map(dated.map((r, i) => [r.record.id, i]));
  const bars = dated.map(({ record, window }): TimelineBar => {
    const start = clamp(dayDiff(firstDay, localDay(window.start, tz)));
    const end = clamp(dayDiff(firstDay, localDay(window.end, tz)));
    const predecessor = input.dependencies?.find((d) => d.successorId === record.id);
    const dependsOn = predecessor ? index.get(predecessor.predecessorId) : undefined;
    const planned = input.baseline?.get(record.id);
    const plannedStart = planned?.start ?? planned?.end ?? null;
    const plannedEnd = planned?.end ?? planned?.start ?? null;
    return {
      record,
      start,
      end,
      milestone: record.kind === "Milestone" || (window.start === window.end && !record.startsAt),
      ...(dependsOn !== undefined ? { dependsOn } : {}),
      ...(input.locked?.has(record.id) ? { locked: true } : {}),
      ...(plannedStart && plannedEnd
        ? {
            baselineStart: clamp(dayDiff(firstDay, localDay(plannedStart, tz))),
            baselineEnd: clamp(dayDiff(firstDay, localDay(plannedEnd, tz))),
          }
        : {}),
    };
  });
  const edges: TimelineEdge[] = [];
  for (const d of input.dependencies ?? []) {
    const from = index.get(d.predecessorId);
    const to = index.get(d.successorId);
    if (from !== undefined && to !== undefined) {
      edges.push({ from, to, type: d.type, lagHours: intervalHours(d.lag) });
    }
  }
  const todayIndex = dayDiff(firstDay, localDay(input.now ?? new Date(), tz));
  return {
    days,
    bars,
    edges,
    ...(todayIndex >= 0 && todayIndex < count ? { today: todayIndex } : {}),
  };
}

/** Records that fall on each local day of a month, for the calendar view. */
export function calendarEvents(
  records: readonly RecordSummary[],
  timeZone: string,
): { date: string; record: RecordSummary }[] {
  const events: { date: string; record: RecordSummary }[] = [];
  for (const record of records) {
    const window = recordWindow(record);
    if (!window) continue;
    const first = localDay(window.start, timeZone);
    const last = localDay(window.end, timeZone);
    const span = Math.min(dayDiff(first, last), 62);
    for (let i = 0; i <= span; i += 1) events.push({ date: addDays(first, i), record });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The days a timeline draws when no record is dated (P8): the project's start to end dates, or
 * today and the 27 days after it when the project has none (or none is given).
 */
export async function scheduleWindow(
  db: XosClient,
  projectId: string | undefined,
  today: string,
): Promise<Result<{ first: string; last: string }>> {
  const fallback = { first: today, last: addDays(today, 27) };
  if (!projectId) return ok(fallback);
  const { data, error } = await db
    .from("projects")
    .select("starts_on, ends_on")
    .eq("id", projectId)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data?.starts_on || !data.ends_on || data.ends_on < data.starts_on) return ok(fallback);
  return ok({ first: data.starts_on, last: data.ends_on });
}

// Reschedule -----------------------------------------------------------------------------------------

/** A record a reschedule moves, or the record rescheduled itself (`isTarget`). */
export interface RescheduleMove {
  readonly recordId: string;
  readonly isTarget: boolean;
  /** Whole days of the project's calendar the start and the end move. */
  readonly shiftStartDays: number;
  readonly shiftEndDays: number;
  /** Whole minutes of the project's wall clock the start and the end move, after the days (P8). */
  readonly shiftStartMinutes: number;
  readonly shiftEndMinutes: number;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly dueAt: string | null;
  readonly oldStartsAt: string | null;
  readonly oldEndsAt: string | null;
  readonly oldDueAt: string | null;
  /** The record's window in the project's latest locked baseline, which a reschedule never touches. */
  readonly baselineStartsAt: string | null;
  readonly baselineEndsAt: string | null;
}

interface MoveRow {
  readonly record_id: string;
  readonly is_target: boolean;
  readonly shift_start_days: number;
  readonly shift_end_days: number;
  readonly shift_start_minutes: number | null;
  readonly shift_end_minutes: number | null;
  readonly starts_at: string | null;
  readonly ends_at: string | null;
  readonly due_at: string | null;
  readonly old_starts_at: string | null;
  readonly old_ends_at: string | null;
  readonly old_due_at: string | null;
  readonly baseline_starts_at: string | null;
  readonly baseline_ends_at: string | null;
}

function toMove(r: MoveRow): RescheduleMove {
  return {
    recordId: r.record_id,
    isTarget: r.is_target,
    shiftStartDays: r.shift_start_days,
    shiftEndDays: r.shift_end_days,
    shiftStartMinutes: r.shift_start_minutes ?? 0,
    shiftEndMinutes: r.shift_end_minutes ?? 0,
    startsAt: r.starts_at ?? null,
    endsAt: r.ends_at ?? null,
    dueAt: r.due_at ?? null,
    oldStartsAt: r.old_starts_at ?? null,
    oldEndsAt: r.old_ends_at ?? null,
    oldDueAt: r.old_due_at ?? null,
    baselineStartsAt: r.baseline_starts_at ?? null,
    baselineEndsAt: r.baseline_ends_at ?? null,
  };
}

/**
 * Moves or resizes a record by whole days and then whole minutes, and pushes the successors its
 * dependencies need moved (app.reschedule_record, migrations 2260 and 2850, ADR 0111): by whole days
 * when the change has no minute part, else by whole minutes. Without `commit` it only previews: the
 * same rows, nothing written. Cycles, locked records and impossible windows come back as refusals.
 */
export async function rescheduleRecord(
  db: XosClient,
  input: {
    readonly recordId: string;
    readonly startDays: number;
    readonly endDays: number;
    readonly startMinutes?: number;
    readonly endMinutes?: number;
    readonly commit?: boolean;
    readonly reason?: string;
  },
): Promise<Result<RescheduleMove[]>> {
  const { data, error } = await db.rpc("reschedule_record", {
    p_record_id: input.recordId,
    p_start_days: input.startDays,
    p_end_days: input.endDays,
    p_commit: input.commit ?? false,
    ...(input.startMinutes ? { p_start_minutes: input.startMinutes } : {}),
    ...(input.endMinutes ? { p_end_minutes: input.endMinutes } : {}),
    ...(input.reason ? { p_reason: input.reason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok((data ?? []).map(toMove));
}

/** A record a multi-record shift moves, with its project. */
export interface ShiftMove extends RescheduleMove {
  readonly projectId: string;
}

/**
 * Shifts up to 500 records by the same minutes and pushes their successors outside the selection
 * (app.shift_records, migration 2850). The selected records move rigidly together; undated and
 * Canceled ones stay where they are and are not returned. Without `commit` it only previews.
 */
export async function shiftRecords(
  db: XosClient,
  input: {
    readonly recordIds: readonly string[];
    readonly minutes: number;
    readonly commit?: boolean;
    readonly reason?: string;
  },
): Promise<Result<ShiftMove[]>> {
  const { data, error } = await db.rpc("shift_records", {
    p_record_ids: [...input.recordIds],
    p_minutes: input.minutes,
    p_commit: input.commit ?? false,
    ...(input.reason ? { p_reason: input.reason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok((data ?? []).map((r) => ({ ...toMove(r), projectId: r.project_id })));
}

/**
 * Places an undated record on a day of its project's calendar (app.place_record, migration 2851):
 * a Milestone is due at 17:00, any other kind runs 09:00 to 17:00, and its successors are pushed by
 * whole days. Without `commit` it only previews. A dated record is refused (place_dated).
 */
export async function placeRecord(
  db: XosClient,
  input: {
    readonly recordId: string;
    readonly day: string;
    readonly commit?: boolean;
    readonly reason?: string;
  },
): Promise<Result<RescheduleMove[]>> {
  const { data, error } = await db.rpc("place_record", {
    p_record_id: input.recordId,
    p_day: input.day,
    p_commit: input.commit ?? false,
    ...(input.reason ? { p_reason: input.reason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok((data ?? []).map(toMove));
}

/**
 * The rows that undo a committed shift, placement or reschedule through app.bulk_update_records:
 * each moved record's old dates set back, expecting the dates the move wrote, so an undo after
 * someone else changed a record is refused (bulk_stale). A null old date sets the date back to
 * null, which returns a placed record to the Unscheduled list.
 */
export function shiftUndoRows(moves: readonly RescheduleMove[]): BulkRow[] {
  return moves
    .filter(
      (m) => m.startsAt !== m.oldStartsAt || m.endsAt !== m.oldEndsAt || m.dueAt !== m.oldDueAt,
    )
    .map((m) => ({
      id: m.recordId,
      set: { starts_at: m.oldStartsAt, ends_at: m.oldEndsAt, due_at: m.oldDueAt },
      expect: { starts_at: m.startsAt, ends_at: m.endsAt, due_at: m.dueAt },
    }));
}

/**
 * Records among the given ones that a reschedule leaves where they are: Complete records and
 * Timeline windows locked into a baseline (the same rule app.reschedule_record applies).
 */
export async function lockedRecordIds(
  db: XosClient,
  records: readonly RecordSummary[],
): Promise<Result<Set<string>>> {
  const locked = new Set(records.filter((r) => r.state === "Complete").map((r) => r.id));
  const windows = records.filter((r) => r.kind === "Timeline").map((r) => r.id);
  if (windows.length === 0) return ok(locked);
  const { data, error } = await db
    .from("record_timeline")
    .select("record_id")
    .in("record_id", windows)
    .not("baseline_locked_at", "is", null);
  if (error) return fail(toDataError(error));
  for (const row of data) locked.add(row.record_id);
  return ok(locked);
}

// Baselines ------------------------------------------------------------------------------------------

export interface Baseline {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly name: string;
  readonly lockedAt: string | null;
  readonly createdAt: string;
  readonly itemCount: number;
}

/** Baselines of the org or one project, newest first. */
export async function listBaselines(
  db: XosClient,
  query: { readonly orgId: string; readonly projectId?: string },
): Promise<Result<Baseline[]>> {
  let q = db
    .from("schedule_baselines")
    .select(
      "id, project_id, name, locked_at, created_at, project:projects!inner(project_key), items:schedule_baseline_items(count)",
    )
    .eq("org_id", query.orgId)
    .is("deleted_at", null);
  if (query.projectId) q = q.eq("project_id", query.projectId);
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as unknown as {
        id: string;
        project_id: string;
        name: string;
        locked_at: string | null;
        created_at: string;
        project: { project_key: string } | null;
        items: { count: number }[] | null;
      }[]
    ).map((b) => ({
      id: b.id,
      projectId: b.project_id,
      projectKey: b.project?.project_key ?? "",
      name: b.name,
      lockedAt: b.locked_at,
      createdAt: b.created_at,
      itemCount: b.items?.[0]?.count ?? 0,
    })),
  );
}

/** Creates an unlocked baseline; lock it to capture the plan. */
export async function createBaseline(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId: string; readonly name: string },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("schedule_baselines")
    .insert({ org_id: input.orgId, project_id: input.projectId, name: input.name.trim() })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Captures every dated record of the project and locks the baseline (app.lock_baseline). */
export async function lockBaseline(
  db: XosClient,
  baselineId: string,
): Promise<Result<{ captured: number }>> {
  const { data, error } = await untyped(db).rpc("lock_baseline", {
    p_baseline_id: baselineId,
  });
  if (error) return fail(toDataError(error));
  return ok({ captured: Number(data ?? 0) });
}

/** Renames or deletes an unlocked baseline; a locked one refuses both. */
export async function updateBaseline(
  db: XosClient,
  id: string,
  patch: { readonly name?: string; readonly deleted?: boolean },
): Promise<Result<null>> {
  const row: { name?: string; deleted_at?: string } = {};
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.deleted) row.deleted_at = new Date().toISOString();
  const { data, error } = await db.from("schedule_baselines").update(row).eq("id", id).select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export interface BaselineVariance {
  readonly record: RecordSummary;
  readonly plannedStart: string | null;
  readonly plannedEnd: string | null;
  /** Milliseconds the current start is after the planned start; NULL when either is missing. */
  readonly startSlipMs: number | null;
  /** Milliseconds the current end is after the planned end; positive is late. */
  readonly endSlipMs: number | null;
}

/** Planned versus current dates of every record in a baseline (variance is derived, never stored). */
export function computeVariance(
  items: readonly { recordId: string; plannedStart: string | null; plannedEnd: string | null }[],
  records: readonly RecordSummary[],
): BaselineVariance[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const diff = (current: string | null, planned: string | null) =>
    current && planned ? Date.parse(current) - Date.parse(planned) : null;
  return items.flatMap((item) => {
    const record = byId.get(item.recordId);
    if (!record) return [];
    const window = recordWindow(record);
    return [
      {
        record,
        plannedStart: item.plannedStart,
        plannedEnd: item.plannedEnd,
        startSlipMs: diff(window?.start ?? null, item.plannedStart),
        endSlipMs: diff(window?.end ?? null, item.plannedEnd),
      },
    ];
  });
}

/** One baseline with its items against the records' current dates. */
export async function getBaselineVariance(
  db: XosClient,
  orgId: string,
  baselineId: string,
): Promise<Result<{ baseline: Baseline; variance: BaselineVariance[] }>> {
  const { data, error } = await db
    .from("schedule_baselines")
    .select(
      "id, project_id, name, locked_at, created_at, project:projects!inner(project_key), items:schedule_baseline_items(record_id, planned_starts_at, planned_ends_at)",
    )
    .eq("id", baselineId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const row = data as unknown as {
    id: string;
    project_id: string;
    name: string;
    locked_at: string | null;
    created_at: string;
    project: { project_key: string } | null;
    items:
      | { record_id: string; planned_starts_at: string | null; planned_ends_at: string | null }[]
      | null;
  };
  const items = (row.items ?? []).map((i) => ({
    recordId: i.record_id,
    plannedStart: i.planned_starts_at,
    plannedEnd: i.planned_ends_at,
  }));
  const records =
    items.length === 0
      ? ok<RecordSummary[]>([])
      : await listRecords(db, { orgId, ids: items.map((i) => i.recordId) });
  if (!records.ok) return records;
  return ok({
    baseline: {
      id: row.id,
      projectId: row.project_id,
      projectKey: row.project?.project_key ?? "",
      name: row.name,
      lockedAt: row.locked_at,
      createdAt: row.created_at,
      itemCount: items.length,
    },
    variance: computeVariance(items, records.data),
  });
}

/** The most recent locked baseline of a project, as planned windows by record id. */
export async function latestBaselinePlan(
  db: XosClient,
  projectId: string,
): Promise<Result<Map<string, { start: string | null; end: string | null }>>> {
  const { data, error } = await db
    .from("schedule_baselines")
    .select("id, items:schedule_baseline_items(record_id, planned_starts_at, planned_ends_at)")
    .eq("project_id", projectId)
    .not("locked_at", "is", null)
    .is("deleted_at", null)
    .order("locked_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  const items =
    (
      data as unknown as {
        items:
          | {
              record_id: string;
              planned_starts_at: string | null;
              planned_ends_at: string | null;
            }[]
          | null;
      } | null
    )?.items ?? [];
  return ok(
    new Map(
      items.map((i) => [i.record_id, { start: i.planned_starts_at, end: i.planned_ends_at }]),
    ),
  );
}

// Actuals ----------------------------------------------------------------------------------------------

export interface Actual {
  readonly recordId: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export async function getActual(db: XosClient, recordId: string): Promise<Result<Actual | null>> {
  const { data, error } = await db
    .from("schedule_actuals")
    .select("record_id, actual_starts_at, actual_ends_at")
    .eq("record_id", recordId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return ok(
    data
      ? {
          recordId: data.record_id,
          startedAt: data.actual_starts_at,
          finishedAt: data.actual_ends_at,
        }
      : null,
  );
}

/** Records when a record actually started and finished (one row per record). */
export async function setActual(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly recordId: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
  },
): Promise<Result<null>> {
  const current = await getActual(db, input.recordId);
  if (!current.ok) return current;
  if (current.data) {
    const { error } = await db
      .from("schedule_actuals")
      .update({ actual_starts_at: input.startedAt, actual_ends_at: input.finishedAt })
      .eq("record_id", input.recordId)
      .is("deleted_at", null);
    return error ? fail(toDataError(error)) : ok(null);
  }
  const { error } = await db.from("schedule_actuals").insert({
    org_id: input.orgId,
    record_id: input.recordId,
    actual_starts_at: input.startedAt,
    actual_ends_at: input.finishedAt,
  });
  return error ? fail(toDataError(error)) : ok(null);
}
