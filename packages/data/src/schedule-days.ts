import type { XosClient } from "./client.ts";
import { Constants, type Database } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Project day types (B4, G-38, migration 2930, ADR 0143 decision 1): each date of a project is a Load In, Show,
 * Load Out, Travel, Off, Rehearsal or Other day, in up to four segments on a split day. Schedules, calendars, day
 * sheets and the portfolio timeline show them as text-labelled tags with a categorical colour and an icon, never
 * colour alone. Row level security decides who reads (schedule.timeline.read) and writes (schedule.timeline.write).
 */

export type DayType = Database["app"]["Enums"]["project_day_type"];

export { dayTypeSlug, dayTypeTone, type DayTypeTone } from "./schedule-day-tones.ts";
import { dayTypeTone, type DayTypeTone } from "./schedule-day-tones.ts";

/** The seven day types, in enum order. */
export const DAY_TYPES: readonly DayType[] = Constants.app.Enums.project_day_type;

export function isDayType(value: unknown): value is DayType {
  return typeof value === "string" && (DAY_TYPES as readonly string[]).includes(value);
}

export interface ProjectDay {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly dayOn: string;
  readonly dayType: DayType;
  readonly sortOrder: number;
  readonly label: string | null;
  readonly venueId: string | null;
  readonly venueName: string | null;
  readonly locationText: string | null;
  /** The zone the segment is read in: its venue's (directly or through its Show node), the stored zone, else the project's. */
  readonly timeZone: string;
  /** The zone stored on the row, set only when no venue applies. */
  readonly storedTimeZone: string | null;
  readonly scopeNodeId: string | null;
  readonly scopeNodeName: string | null;
  readonly teamCode: string | null;
  readonly updatedAt: string;
}

interface DayRow {
  id: string;
  project_id: string;
  day_on: string;
  day_type: DayType;
  sort_order: number;
  label: string | null;
  venue_id: string | null;
  location_text: string | null;
  time_zone: string | null;
  scope_node_id: string | null;
  team_code: string | null;
  updated_at: string;
  project: { project_key: string; time_zone: string } | null;
  venue: { name: string; time_zone: string } | null;
  scope_node: { name: string; venue: { name: string; time_zone: string } | null } | null;
}

const DAY_COLUMNS =
  "id, project_id, day_on, day_type, sort_order, label, venue_id, location_text, time_zone, scope_node_id, team_code, updated_at, project:projects!project_days_project_id_fkey(project_key, time_zone), venue:venues(name, time_zone), scope_node:scope_nodes!project_days_scope_node_id_fkey(name, venue:venues(name, time_zone))";

/** The zone a segment is read in (ADR 0143 decision 1, correction 21). */
export function effectiveDayZone(row: {
  readonly venueZone: string | null;
  readonly nodeVenueZone: string | null;
  readonly storedZone: string | null;
  readonly projectZone: string;
}): string {
  return row.venueZone ?? row.nodeVenueZone ?? row.storedZone ?? row.projectZone;
}

export function toProjectDay(row: DayRow): ProjectDay {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? "",
    dayOn: row.day_on,
    dayType: row.day_type,
    sortOrder: row.sort_order,
    label: row.label,
    venueId: row.venue_id,
    venueName: row.venue?.name ?? row.scope_node?.venue?.name ?? null,
    locationText: row.location_text,
    timeZone: effectiveDayZone({
      venueZone: row.venue?.time_zone ?? null,
      nodeVenueZone: row.scope_node?.venue?.time_zone ?? null,
      storedZone: row.time_zone,
      projectZone: row.project?.time_zone ?? "UTC",
    }),
    storedTimeZone: row.time_zone,
    scopeNodeId: row.scope_node_id,
    scopeNodeName: row.scope_node?.name ?? null,
    teamCode: row.team_code,
    updatedAt: row.updated_at,
  };
}

/** Live project days the caller reads, by date then place in the day. */
export async function listProjectDays(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly projectIds?: readonly string[];
    readonly from?: string;
    readonly to?: string;
  },
): Promise<Result<ProjectDay[]>> {
  if (input.projectIds?.length === 0) return ok([]);
  let query = untyped(db)
    .from("project_days")
    .select(DAY_COLUMNS)
    .eq("org_id", input.orgId)
    .is("deleted_at", null);
  if (input.projectIds) query = query.in("project_id", [...input.projectIds]);
  if (input.from) query = query.gte("day_on", input.from);
  if (input.to) query = query.lte("day_on", input.to);
  const { data, error } = await query
    .order("day_on", { ascending: true })
    .order("sort_order", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok((data as unknown as DayRow[]).map(toProjectDay));
}

export interface ProjectDayInput {
  readonly id?: string;
  readonly projectId: string;
  readonly dayOn: string;
  readonly dayType: DayType;
  readonly sortOrder: number;
  readonly label?: string | null;
  readonly venueId?: string | null;
  readonly locationText?: string | null;
  readonly timeZone?: string | null;
  readonly scopeNodeId?: string | null;
  readonly teamCode?: string | null;
}

const blank = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/** Adds a segment, or changes one by id. A Show node gives the venue, so a venue is dropped when a node is named. */
export async function saveProjectDay(
  db: XosClient,
  input: ProjectDayInput,
): Promise<Result<{ id: string }>> {
  const node = input.scopeNodeId ?? null;
  const venue = node ? null : (input.venueId ?? null);
  const row = {
    day_on: input.dayOn,
    day_type: input.dayType,
    sort_order: input.sortOrder,
    label: blank(input.label),
    venue_id: venue,
    location_text: blank(input.locationText),
    time_zone: venue ? null : blank(input.timeZone),
    scope_node_id: node,
    team_code: input.teamCode ?? null,
  };
  const table = untyped(db).from("project_days");
  const { data, error } = input.id
    ? await table.update(row).eq("id", input.id).select("id").single()
    : await table
        .insert({ ...row, project_id: input.projectId })
        .select("id")
        .single();
  if (error) return fail(toDataError(error));
  return ok({ id: (data as { id: string }).id });
}

/** One segment of a date as the day editor sends it: an existing one by id, keeping its place, or a new one. */
export interface DaySegmentInput {
  readonly id?: string | undefined;
  readonly sortOrder?: number | undefined;
  readonly dayType: DayType;
  readonly label?: string | null;
  readonly venueId?: string | null;
  readonly locationText?: string | null;
  readonly timeZone?: string | null;
  readonly scopeNodeId?: string | null;
  readonly teamCode?: string | null;
}

/**
 * Saves one date's segments and moves the removed ones to Trash in a single transaction (app.save_project_days), so a
 * refused segment leaves the date as it was. A kept segment keeps its place; a new one takes the first free place.
 */
export async function saveProjectDays(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly dayOn: string;
    readonly segments: readonly DaySegmentInput[];
    readonly removedIds?: readonly string[];
  },
): Promise<Result<string[]>> {
  const { data, error } = await untyped(db).rpc("save_project_days", {
    p_project_id: input.projectId,
    p_day_on: input.dayOn,
    p_segments: input.segments.map((s) => ({
      ...(s.id ? { id: s.id } : {}),
      ...(s.id && s.sortOrder ? { sortOrder: s.sortOrder } : {}),
      dayType: s.dayType,
      label: blank(s.label),
      venueId: s.scopeNodeId ? null : (s.venueId ?? null),
      locationText: blank(s.locationText),
      timeZone: blank(s.timeZone),
      scopeNodeId: s.scopeNodeId ?? null,
      teamCode: s.teamCode ?? null,
    })),
    p_removed_ids: [...(input.removedIds ?? [])],
  });
  if (error) return fail(toDataError(error));
  return ok((data as string[] | null) ?? []);
}

/** Moves a segment to Trash; restoreProjectDay is the delete toast's Undo (ADR 0110). */
export async function deleteProjectDay(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await untyped(db)
    .from("project_days")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  if ((data as unknown[]).length === 0) return fail({ kind: "not-found" });
  return ok(null);
}

export async function restoreProjectDay(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await untyped(db)
    .from("project_days")
    .update({ deleted_at: null })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  if ((data as unknown[]).length === 0) return fail({ kind: "not-found" });
  return ok(null);
}

/** A day-type tag as the Timeline, Calendar and day sheet draw it. */
export interface DayTag {
  readonly label: string;
  readonly category: DayTypeTone["category"];
  readonly icon: string;
  readonly dayType: DayType;
}

/**
 * The tags of each date: one per segment, in place order. With several projects in view each label is prefixed with
 * its project key, at most three per date and then "+n", as on the crew band (correction 33).
 */
export function dayTagsByDate(
  days: readonly ProjectDay[],
  name: (day: ProjectDay) => string,
  options: { readonly prefixKeys?: boolean; readonly max?: number } = {},
): Map<string, { tags: DayTag[]; more: number }> {
  const max = options.max ?? 3;
  const byDate = new Map<string, ProjectDay[]>();
  for (const d of days) byDate.set(d.dayOn, [...(byDate.get(d.dayOn) ?? []), d]);
  const out = new Map<string, { tags: DayTag[]; more: number }>();
  for (const [date, list] of byDate) {
    const sorted = [...list].sort(
      (a, b) => a.projectKey.localeCompare(b.projectKey) || a.sortOrder - b.sortOrder,
    );
    const limit = options.prefixKeys ? max : sorted.length;
    out.set(date, {
      tags: sorted.slice(0, limit).map((d) => ({
        label: options.prefixKeys ? `${d.projectKey} ${name(d)}` : name(d),
        dayType: d.dayType,
        ...dayTypeTone(d.dayType),
      })),
      more: Math.max(0, sorted.length - limit),
    });
  }
  return out;
}

/** A Show node a day segment can serve, with the venue that sets its zone. */
export interface ShowNodeRef {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly code: string;
  readonly venueId: string | null;
}

/** The live Show nodes of the given projects. */
export async function listShowNodes(
  db: XosClient,
  projectIds: readonly string[],
): Promise<Result<ShowNodeRef[]>> {
  if (projectIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("scope_nodes")
    .select("id, project_id, name, scope_code, venue_id")
    .in("project_id", [...projectIds])
    .eq("scope_kind", "Show")
    .is("deleted_at", null)
    .order("scope_code");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((n) => ({
      id: n.id,
      projectId: n.project_id,
      name: n.name,
      code: n.scope_code,
      venueId: n.venue_id,
    })),
  );
}

/** The canon teams a segment can apply to (xpms.dim_team), by code. */
export async function listCanonTeams(
  db: XosClient,
): Promise<Result<{ code: string; name: string }[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("dim_team")
    .select("team_id, team")
    .order("team_id");
  if (error) return fail(toDataError(error));
  return ok(data.map((r) => ({ code: r.team_id, name: r.team })));
}
