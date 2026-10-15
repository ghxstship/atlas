import type { XosClient } from "./client.ts";
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
}

export interface TimelineModel {
  readonly days: readonly TimelineDay[];
  readonly bars: readonly TimelineBar[];
  /** Index of today, when today falls inside the timeline. */
  readonly today?: number;
}

/**
 * Lays dated records out on a day grid in a time zone, with dependency arrows and baseline
 * ghosts. Records without dates are left out; the caller lists them separately.
 */
export function buildTimeline(input: {
  readonly records: readonly RecordSummary[];
  readonly dependencies?: readonly Dependency[];
  readonly baseline?: ReadonlyMap<string, { start: string | null; end: string | null }>;
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
  if (dated.length === 0) return { days: [], bars: [] };
  const pad = input.pad ?? 1;
  const firstDay = addDays(
    dated.reduce(
      (m, r) => (localDay(r.window.start, tz) < m ? localDay(r.window.start, tz) : m),
      "9999-12-31",
    ),
    -pad,
  );
  const lastDay = addDays(
    dated.reduce(
      (m, r) => (localDay(r.window.end, tz) > m ? localDay(r.window.end, tz) : m),
      "0000-01-01",
    ),
    pad,
  );
  const count = Math.min(dayDiff(firstDay, lastDay) + 1, input.maxDays ?? 120);
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
      ...(plannedStart && plannedEnd
        ? {
            baselineStart: clamp(dayDiff(firstDay, localDay(plannedStart, tz))),
            baselineEnd: clamp(dayDiff(firstDay, localDay(plannedEnd, tz))),
          }
        : {}),
    };
  });
  const todayIndex = dayDiff(firstDay, localDay(input.now ?? new Date(), tz));
  return {
    days,
    bars,
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
