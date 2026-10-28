import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Show repository (Section 4.2 Show): running orders and their cues, day sheets and call sheets.
 * Calling a cue goes through app.call_cue, which stamps the database time and the caller once.
 * Live progression (current cue, time to the next one) is derived from the cues, never stored, so
 * Atlas and Compass (A17, Section 4.3 item 9) compute the same answer from the same rows.
 */

// Running orders ---------------------------------------------------------------------------------------

export interface RunOfShow {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly timeZone: string;
  readonly scopeNodeId: string | null;
  readonly name: string;
  readonly showDate: string;
  readonly cueCount: number;
  readonly calledCount: number;
}

interface RunRow {
  id: string;
  project_id: string;
  scope_node_id: string | null;
  name: string;
  show_date: string;
  project: { project_key: string; name: string; time_zone: string } | null;
  cues: { called_at: string | null; deleted_at: string | null }[] | null;
}

function toRun(row: RunRow): RunOfShow {
  const live = (row.cues ?? []).filter((c) => c.deleted_at === null);
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? "",
    projectName: row.project?.name ?? "",
    timeZone: row.project?.time_zone ?? "UTC",
    scopeNodeId: row.scope_node_id,
    name: row.name,
    showDate: row.show_date,
    cueCount: live.length,
    calledCount: live.filter((c) => c.called_at !== null).length,
  };
}

const RUN_COLUMNS =
  "id, project_id, scope_node_id, name, show_date, project:projects!inner(project_key, name, time_zone), cues(called_at, deleted_at)";

/** Running orders of the org or a project, by show date then name. */
export async function listRunsOfShow(
  db: XosClient,
  query: {
    readonly orgId: string;
    readonly projectId?: string;
    readonly from?: string;
    readonly to?: string;
    readonly search?: string;
  },
): Promise<Result<RunOfShow[]>> {
  let q = db
    .from("run_of_show")
    .select(RUN_COLUMNS)
    .eq("org_id", query.orgId)
    .is("deleted_at", null);
  if (query.projectId) q = q.eq("project_id", query.projectId);
  if (query.from) q = q.gte("show_date", query.from);
  if (query.to) q = q.lte("show_date", query.to);
  if (query.search && query.search.trim() !== "") {
    q = q.ilike("name", `%${query.search.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  }
  const { data, error } = await q.order("show_date").order("name").limit(500);
  if (error) return fail(toDataError(error));
  return ok((data as unknown as RunRow[]).map(toRun));
}

export async function getRunOfShow(db: XosClient, id: string): Promise<Result<RunOfShow>> {
  const { data, error } = await db
    .from("run_of_show")
    .select(RUN_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toRun(data as unknown as RunRow));
}

export async function createRunOfShow(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly name: string;
    readonly showDate: string;
    readonly scopeNodeId?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("run_of_show")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      name: input.name.trim(),
      show_date: input.showDate,
      scope_node_id: input.scopeNodeId ?? null,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function updateRunOfShow(
  db: XosClient,
  id: string,
  patch: {
    readonly name?: string;
    readonly showDate?: string;
    readonly scopeNodeId?: string | null;
  },
): Promise<Result<null>> {
  const row: { name?: string; show_date?: string; scope_node_id?: string | null } = {};
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.showDate !== undefined) row.show_date = patch.showDate;
  if (patch.scopeNodeId !== undefined) row.scope_node_id = patch.scopeNodeId;
  const { data, error } = await db.from("run_of_show").update(row).eq("id", id).select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export async function deleteRunOfShow(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("run_of_show")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

// Cues -------------------------------------------------------------------------------------------------

export interface Cue {
  readonly id: string;
  readonly runOfShowId: string;
  readonly position: number;
  readonly label: string;
  readonly plannedAt: string | null;
  /** Planned length in seconds; NULL when not set. */
  readonly durationSeconds: number | null;
  readonly calledAt: string | null;
  readonly calledByName: string | null;
}

/** Postgres interval text (HH:MM:SS, with optional days) in seconds. */
export function intervalSeconds(interval: string | null): number | null {
  if (!interval) return null;
  const match = /^(?:(-?\d+) days? ?)?(-?)(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(interval.trim());
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const sign = match[2] === "-" ? -1 : 1;
  return (
    days * 86_400 + sign * (Number(match[3]) * 3600 + Number(match[4]) * 60 + Number(match[5]))
  );
}

export async function listCues(db: XosClient, runOfShowId: string): Promise<Result<Cue[]>> {
  const { data, error } = await db
    .from("cues")
    .select(
      "id, run_of_show_id, position, label, planned_at, duration, called_at, caller:people!cues_called_by_fkey(full_name)",
    )
    .eq("run_of_show_id", runOfShowId)
    .is("deleted_at", null)
    .order("position");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((c) => ({
      id: c.id,
      runOfShowId: c.run_of_show_id,
      position: c.position,
      label: c.label,
      plannedAt: c.planned_at,
      durationSeconds: intervalSeconds(c.duration === null ? null : String(c.duration)),
      calledAt: c.called_at,
      calledByName: c.caller?.full_name ?? null,
    })),
  );
}

/** Adds a cue at the end of the running order. */
export async function addCue(
  db: XosClient,
  input: {
    readonly orgId: string;
    /** The running order's project; the database stamps it again from the running order. */
    readonly projectId: string;
    readonly runOfShowId: string;
    readonly label: string;
    readonly plannedAt?: string | null;
    readonly durationSeconds?: number | null;
  },
): Promise<Result<{ id: string }>> {
  const current = await listCues(db, input.runOfShowId);
  if (!current.ok) return current;
  const position = Math.max(0, ...current.data.map((c) => c.position)) + 1;
  const { data, error } = await db
    .from("cues")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      run_of_show_id: input.runOfShowId,
      position,
      label: input.label.trim(),
      planned_at: input.plannedAt ?? null,
      duration:
        input.durationSeconds === null || input.durationSeconds === undefined
          ? null
          : `${input.durationSeconds} seconds`,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function updateCue(
  db: XosClient,
  id: string,
  patch: {
    readonly label?: string;
    readonly plannedAt?: string | null;
    readonly durationSeconds?: number | null;
  },
): Promise<Result<null>> {
  const row: { label?: string; planned_at?: string | null; duration?: string | null } = {};
  if (patch.label !== undefined) row.label = patch.label.trim();
  if (patch.plannedAt !== undefined) row.planned_at = patch.plannedAt;
  if (patch.durationSeconds !== undefined) {
    row.duration = patch.durationSeconds === null ? null : `${patch.durationSeconds} seconds`;
  }
  const { data, error } = await db.from("cues").update(row).eq("id", id).select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export async function removeCue(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("cues")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/**
 * Swaps a cue with its neighbor (keyboard reordering). Positions are unique per running order, so
 * the move parks the cue past the end first.
 */
export async function moveCue(
  db: XosClient,
  runOfShowId: string,
  cueId: string,
  direction: "up" | "down",
): Promise<Result<null>> {
  const cues = await listCues(db, runOfShowId);
  if (!cues.ok) return cues;
  const index = cues.data.findIndex((c) => c.id === cueId);
  const other = cues.data[direction === "up" ? index - 1 : index + 1];
  const cue = cues.data[index];
  if (!cue || !other) return ok(null);
  const park = Math.max(...cues.data.map((c) => c.position)) + 1;
  for (const [id, position] of [
    [cue.id, park],
    [other.id, cue.position],
    [cue.id, other.position],
  ] as const) {
    const { error } = await db.from("cues").update({ position }).eq("id", id);
    if (error) return fail(toDataError(error));
  }
  return ok(null);
}

/** Calls a cue now (app.call_cue): the database stamps the time and the caller, once. */
export async function callCue(db: XosClient, cueId: string): Promise<Result<{ calledAt: string }>> {
  const { data, error } = await untyped(db).rpc("call_cue", { p_cue_id: cueId });
  if (error) return fail(toDataError(error));
  return ok({ calledAt: String(data) });
}

// Set times: cues linked to artist engagements (migration 0760) ------------------------------------------

/** A cue marked as an artist's set time (app.engagement_cues). */
export interface CueEngagement {
  readonly id: string;
  readonly cueId: string;
  readonly engagementId: string;
  /** The artist's name; null when the person row is hidden. */
  readonly personName: string | null;
}

/** The set times of one running order's cues. */
export async function listCueEngagements(
  db: XosClient,
  runOfShowId: string,
): Promise<Result<CueEngagement[]>> {
  const { data, error } = await db
    .from("engagement_cues")
    .select(
      "id, cue_id, engagement_id, cue:cues!engagement_cues_cue_id_fkey!inner(run_of_show_id), engagement:engagements!engagement_cues_engagement_id_fkey(person:people!engagements_person_id_fkey(full_name))",
    )
    .eq("cue.run_of_show_id", runOfShowId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    (data as unknown as CueEngagementRow[]).map((r) => ({
      id: r.id,
      cueId: r.cue_id,
      engagementId: r.engagement_id,
      personName: r.engagement?.person?.full_name ?? null,
    })),
  );
}

/** org_id comes from the engagement (ADR 0002 tenant guards). */
type EngagementCueInsert = Database["app"]["Tables"]["engagement_cues"]["Insert"];

interface CueEngagementRow {
  id: string;
  cue_id: string;
  engagement_id: string;
  engagement: { person: { full_name: string | null } | null } | null;
}

/**
 * Marks a cue as an artist's set time. Only (engagement_id, cue_id) are written, as the column grant
 * allows; the database refuses engagement_cue_artist_only and engagement_cue_project_mismatch, and a
 * cue already linked to the engagement comes back as a conflict.
 */
export async function linkCueToEngagement(
  db: XosClient,
  input: { readonly cueId: string; readonly engagementId: string },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("engagement_cues")
    .insert({ engagement_id: input.engagementId, cue_id: input.cueId } as EngagementCueInsert)
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Removes a set time (soft delete). */
export async function unlinkCueEngagement(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("engagement_cues")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export interface CueProgress {
  /** Index of the last called cue, or -1 before the first call. */
  readonly current: number;
  /** Index of the next cue to call, or -1 when every cue is called. */
  readonly next: number;
  /** Seconds until the next cue's planned time, negative when it is late; NULL without a plan. */
  readonly nextInSeconds: number | null;
  /** Seconds the current cue has run. */
  readonly elapsedSeconds: number | null;
  readonly complete: boolean;
}

/** Where a running order stands at `now`: current and next cue and time to the next one. */
export function cueProgress(
  cues: readonly Pick<Cue, "calledAt" | "plannedAt">[],
  now: Date = new Date(),
): CueProgress {
  let current = -1;
  cues.forEach((c, i) => {
    if (c.calledAt !== null) current = i;
  });
  const next = cues.findIndex((c, i) => i > current && c.calledAt === null);
  const nextCue = next >= 0 ? cues[next] : undefined;
  const currentCue = current >= 0 ? cues[current] : undefined;
  const nowMs = now.getTime();
  return {
    current,
    next,
    nextInSeconds: nextCue?.plannedAt
      ? Math.round((Date.parse(nextCue.plannedAt) - nowMs) / 1000)
      : null,
    elapsedSeconds: currentCue?.calledAt
      ? Math.round((nowMs - Date.parse(currentCue.calledAt)) / 1000)
      : null,
    complete: cues.length > 0 && next === -1,
  };
}

// Day sheets -----------------------------------------------------------------------------------------

export interface DaySheet {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly day: string;
  readonly body: string;
  readonly publishedAt: string | null;
  readonly updatedAt: string;
}

interface SheetRow {
  id: string;
  project_id: string;
  day: string;
  body?: string;
  published_at: string | null;
  updated_at: string;
  project: { project_key: string } | null;
}

export async function listDaySheets(
  db: XosClient,
  query: {
    readonly orgId: string;
    readonly projectId?: string;
    readonly from?: string;
    readonly to?: string;
    readonly id?: string;
  },
): Promise<Result<DaySheet[]>> {
  let q = untyped(db)
    .from("day_sheets")
    .select(
      "id, project_id, day, body, published_at, updated_at, project:projects!inner(project_key)",
    )
    .eq("org_id", query.orgId)
    .is("deleted_at", null);
  if (query.projectId) q = q.eq("project_id", query.projectId);
  if (query.from) q = q.gte("day", query.from);
  if (query.to) q = q.lte("day", query.to);
  if (query.id) q = q.eq("id", query.id);
  const { data, error } = await q.order("day").limit(500);
  if (error) return fail(toDataError(error));
  return ok(
    (data as unknown as SheetRow[]).map((s) => ({
      id: s.id,
      projectId: s.project_id,
      projectKey: s.project?.project_key ?? "",
      day: s.day,
      body: s.body ?? "",
      publishedAt: s.published_at,
      updatedAt: s.updated_at,
    })),
  );
}

/** Writes the day sheet of a project day, creating it on first save. */
export async function saveDaySheet(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly day: string;
    readonly body: string;
  },
): Promise<Result<{ id: string }>> {
  const { data: existing, error: readError } = await db
    .from("day_sheets")
    .select("id")
    .eq("project_id", input.projectId)
    .eq("day", input.day)
    .is("deleted_at", null)
    .maybeSingle();
  if (readError) return fail(toDataError(readError));
  if (existing) {
    const { error } = await db
      .from("day_sheets")
      .update({ body: input.body })
      .eq("id", existing.id);
    return error ? fail(toDataError(error)) : ok({ id: existing.id });
  }
  const { data, error } = await db
    .from("day_sheets")
    .insert({ org_id: input.orgId, project_id: input.projectId, day: input.day, body: input.body })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Publishes a day sheet or call sheet; the database stamps the time, once. */
export async function publishSheet(
  db: XosClient,
  table: "day_sheets" | "call_sheets",
  id: string,
): Promise<Result<null>> {
  const { data, error } = await untyped(db)
    .from(table)
    .update({ published_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return (data as unknown[]).length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/** Moves a day sheet or call sheet to Trash (a soft delete, restorable for its retention period). */
export async function deleteSheet(
  db: XosClient,
  table: "day_sheets" | "call_sheets",
  id: string,
): Promise<Result<null>> {
  const { data, error } = await db
    .from(table)
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/**
 * Restores a sheet from Trash: the Undo of deleteSheet (Section 11.7). A live sheet for the same
 * project day, saved since, is refused by the one-sheet-a-day index as a conflict.
 */
export async function restoreSheet(
  db: XosClient,
  table: "day_sheets" | "call_sheets",
  id: string,
): Promise<Result<null>> {
  const { data, error } = await db
    .from(table)
    .update({ deleted_at: null })
    .eq("id", id)
    .not("deleted_at", "is", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

// Call sheets ----------------------------------------------------------------------------------------

export interface CallSheet {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly day: string;
  readonly publishedAt: string | null;
  readonly updatedAt: string;
}

export async function listCallSheets(
  db: XosClient,
  query: {
    readonly orgId: string;
    readonly projectId?: string;
    readonly from?: string;
    readonly to?: string;
    readonly id?: string;
  },
): Promise<Result<CallSheet[]>> {
  let q = db
    .from("call_sheets")
    .select("id, project_id, day, published_at, updated_at, project:projects!inner(project_key)")
    .eq("org_id", query.orgId)
    .is("deleted_at", null);
  if (query.projectId) q = q.eq("project_id", query.projectId);
  if (query.from) q = q.gte("day", query.from);
  if (query.to) q = q.lte("day", query.to);
  if (query.id) q = q.eq("id", query.id);
  const { data, error } = await q.order("day").limit(500);
  if (error) return fail(toDataError(error));
  return ok(
    (data as unknown as SheetRow[]).map((s) => ({
      id: s.id,
      projectId: s.project_id,
      projectKey: s.project?.project_key ?? "",
      day: s.day,
      publishedAt: s.published_at,
      updatedAt: s.updated_at,
    })),
  );
}

export async function createCallSheet(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId: string; readonly day: string },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("call_sheets")
    .insert({ org_id: input.orgId, project_id: input.projectId, day: input.day })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export interface Call {
  readonly shiftId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly roleCode: string | null;
  readonly roleTitle: string | null;
  readonly personName: string | null;
}

/**
 * The calls of a project day: its shifts that start on that local day, by call time. Calls are
 * derived from crew shifts (A13), never copied onto the call sheet.
 */
export async function listCalls(
  db: XosClient,
  input: { readonly projectId: string; readonly day: string; readonly timeZone: string },
): Promise<Result<Call[]>> {
  const start = zonedMidnight(input.day, input.timeZone);
  const end = zonedMidnight(nextDay(input.day), input.timeZone);
  const { data, error } = await db
    .from("shifts")
    .select(
      "id, starts_at, ends_at, role_code, membership:memberships(person:people!memberships_person_id_fkey(full_name))",
    )
    .eq("project_id", input.projectId)
    .gte("starts_at", start)
    .lt("starts_at", end)
    .is("deleted_at", null)
    .order("starts_at");
  if (error) return fail(toDataError(error));
  const rows = data as unknown as {
    id: string;
    starts_at: string;
    ends_at: string;
    role_code: string | null;
    membership: { person: { full_name: string | null } | null } | null;
  }[];
  const codes = [...new Set(rows.flatMap((r) => (r.role_code ? [r.role_code] : [])))];
  const titles = new Map<string, string>();
  if (codes.length > 0) {
    const roles = await db
      .schema("xpms")
      .from("role")
      .select("role_code, job_title")
      .in("role_code", codes);
    if (roles.error) return fail(toDataError(roles.error));
    for (const r of roles.data) titles.set(r.role_code, r.job_title);
  }
  return ok(
    rows.map((r) => ({
      shiftId: r.id,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      roleCode: r.role_code,
      roleTitle: r.role_code ? (titles.get(r.role_code) ?? null) : null,
      personName: r.membership?.person?.full_name ?? null,
    })),
  );
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The instant a local day begins in a time zone, as an ISO string. */
export function zonedMidnight(day: string, timeZone: string): string {
  const utc = Date.parse(`${day}T00:00:00Z`);
  const offset = (at: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return (
      Date.UTC(
        get("year"),
        get("month") - 1,
        get("day"),
        get("hour"),
        get("minute"),
        get("second"),
      ) - at
    );
  };
  const first = utc - offset(utc);
  return new Date(utc - offset(first)).toISOString();
}
