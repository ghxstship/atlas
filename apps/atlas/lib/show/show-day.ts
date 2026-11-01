import type { XosClient } from "@xos/data";
import { addCalendarDays, startOfDayIn, todayIn } from "@xos/data/calendar";
import { listTravelSegments, type TravelSegment } from "@xos/data/hospitality";
import { intervalSeconds, listRunsOfShow, type RunOfShow } from "@xos/data/show";
import { fail, ok, toDataError, type Result } from "@xos/data/result";

/**
 * Show > Show day (B6, G-179): one project's show day on the Dashboard template. Sets by stage, each
 * running order's progress, who arrives and who sleeps where that night, read under row level
 * security in a fixed number of queries whatever the day holds (never one per running order, cue or
 * guest). Arrivals and hotels are read only for a viewer with hospitality.fulfillment.read; R5's
 * logged travel requests are never read here. The grouping is pure, so it is unit tested.
 */

export interface ShowDayProject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly timeZone: string;
  /** Show dates of the project's running orders, so the page can default to today's. */
  readonly showDates: readonly string[];
}

/** The projects the viewer reads running orders of (show.run_of_show.read), each with its show dates. */
export function showDayProjects(runs: readonly RunOfShow[]): ShowDayProject[] {
  const byId = new Map<
    string,
    { project: Omit<ShowDayProject, "showDates">; dates: Set<string> }
  >();
  for (const r of runs) {
    const entry = byId.get(r.projectId) ?? {
      project: { id: r.projectId, key: r.projectKey, name: r.projectName, timeZone: r.timeZone },
      dates: new Set<string>(),
    };
    entry.dates.add(r.showDate);
    byId.set(r.projectId, entry);
  }
  return [...byId.values()]
    .map(({ project, dates }) => ({ ...project, showDates: [...dates].sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The project the page opens on: the one asked for by key, else the first with a running order today
 * on its own calendar, else the first with any running order.
 */
export function pickShowDayProject(
  projects: readonly ShowDayProject[],
  requestedKey: string | null,
  now: Date = new Date(),
): ShowDayProject | null {
  const asked = requestedKey ? projects.find((p) => p.key === requestedKey) : undefined;
  if (asked) return asked;
  return (
    projects.find((p) => p.showDates.includes(todayIn(p.timeZone, now))) ?? projects[0] ?? null
  );
}

export interface ShowDayCue {
  readonly id: string;
  readonly runOfShowId: string;
  readonly position: number;
  readonly label: string;
  readonly plannedAt: string | null;
  readonly durationSeconds: number | null;
  readonly calledAt: string | null;
}

export interface SetTimeLink {
  readonly cueId: string;
  /** The act's name, as the running order's set times show it. */
  readonly actName: string | null;
}

export type SetState = "called" | "next" | "planned";

export interface ShowDaySet {
  readonly cueId: string;
  readonly label: string;
  readonly actName: string | null;
  readonly plannedAt: string | null;
  readonly durationSeconds: number | null;
  readonly calledAt: string | null;
  readonly state: SetState;
}

export interface StageSets {
  /** The running order's scope node (its stage), else the running order's own name. */
  readonly stage: string;
  readonly runOfShowId: string;
  readonly sets: readonly ShowDaySet[];
}

const byPosition = (a: ShowDayCue, b: ShowDayCue) => a.position - b.position;

/** The day's set cues grouped by stage, in running order, with the first set not yet called up next. */
export function setsByStage(
  runs: readonly RunOfShow[],
  cues: readonly ShowDayCue[],
  links: readonly SetTimeLink[],
  stageNames: ReadonlyMap<string, string>,
): StageSets[] {
  const acts = new Map<string, string | null>();
  for (const l of links) if (!acts.has(l.cueId)) acts.set(l.cueId, l.actName);
  return runs.flatMap((run) => {
    const setCues = cues.filter((c) => c.runOfShowId === run.id && acts.has(c.id)).sort(byPosition);
    if (setCues.length === 0) return [];
    const next = setCues.find((c) => c.calledAt === null)?.id ?? null;
    return [
      {
        stage: (run.scopeNodeId ? stageNames.get(run.scopeNodeId) : undefined) ?? run.name,
        runOfShowId: run.id,
        sets: setCues.map((c) => ({
          cueId: c.id,
          label: c.label,
          actName: acts.get(c.id) ?? null,
          plannedAt: c.plannedAt,
          durationSeconds: c.durationSeconds,
          calledAt: c.calledAt,
          state: c.calledAt !== null ? "called" : c.id === next ? "next" : "planned",
        })),
      },
    ];
  });
}

export interface RunProgress {
  readonly runOfShowId: string;
  readonly name: string;
  readonly stage: string;
  readonly called: number;
  readonly total: number;
  /** The first cue not yet called, in running order. */
  readonly next: { readonly label: string; readonly plannedAt: string | null } | null;
}

/** Each running order of the day with its stage, called of total cues and the next cue. */
export function runProgress(
  runs: readonly RunOfShow[],
  cues: readonly ShowDayCue[],
  stageNames: ReadonlyMap<string, string>,
): RunProgress[] {
  return runs.map((run) => {
    const own = cues.filter((c) => c.runOfShowId === run.id).sort(byPosition);
    const next = own.find((c) => c.calledAt === null);
    return {
      runOfShowId: run.id,
      name: run.name,
      stage: (run.scopeNodeId ? stageNames.get(run.scopeNodeId) : undefined) ?? run.name,
      called: own.filter((c) => c.calledAt !== null).length,
      total: own.length,
      next: next ? { label: next.label, plannedAt: next.plannedAt } : null,
    };
  });
}

/** The day's window on the project's calendar, from its local midnight to the next. */
export function dayWindow(
  day: string,
  zone: string,
): { readonly start: string; readonly end: string } {
  return { start: startOfDayIn(day, zone), end: startOfDayIn(addCalendarDays(day, 1), zone) };
}

/**
 * Who arrives that day: segments landing inside the day's window in the project zone, or leaving
 * then when no arrival time is known, earliest first.
 */
export function arrivalsOn(
  travel: readonly TravelSegment[],
  day: string,
  zone: string,
): TravelSegment[] {
  const { start, end } = dayWindow(day, zone);
  const from = Date.parse(start);
  const to = Date.parse(end);
  const inside = (iso: string) => {
    const at = Date.parse(iso);
    return at >= from && at < to;
  };
  const when = (s: TravelSegment) => s.arrivesAt ?? s.departsAt;
  return travel
    .filter((s) => (s.arrivesAt !== null ? inside(s.arrivesAt) : inside(s.departsAt)))
    .sort((a, b) => Date.parse(when(a)) - Date.parse(when(b)));
}

export interface HotelNight {
  readonly blockId: string;
  readonly hotelName: string | null;
  readonly blockTitle: string;
  /** Guests whose stay covers the night (check-in on or before the day, check-out after it). */
  readonly guests: readonly string[];
  readonly checkIns: readonly string[];
  readonly checkOuts: readonly string[];
  /** Room assignment ids on the day, for the Changed tag. */
  readonly assignmentIds: readonly string[];
}

/** A room assignment of the project, with its block and hotel. */
export interface RoomStay {
  readonly id: string;
  readonly personName: string | null;
  readonly checkInOn: string;
  readonly checkOutOn: string;
  readonly blockId: string;
  readonly blockTitle: string;
  readonly hotelName: string | null;
}

/** Each block with a guest that night or a check-in or check-out that day, by name, in block order. */
export function hotelsOn(stays: readonly RoomStay[], day: string): HotelNight[] {
  const blocks = new Map<string, { title: string; hotel: string | null; stays: RoomStay[] }>();
  for (const s of stays) {
    const b = blocks.get(s.blockId) ?? { title: s.blockTitle, hotel: s.hotelName, stays: [] };
    b.stays.push(s);
    blocks.set(s.blockId, b);
  }
  const name = (s: RoomStay) => s.personName ?? "";
  return [...blocks.entries()]
    .flatMap(([blockId, b]) => {
      const guests = b.stays.filter((s) => s.checkInOn <= day && day < s.checkOutOn);
      const checkIns = b.stays.filter((s) => s.checkInOn === day);
      const checkOuts = b.stays.filter((s) => s.checkOutOn === day);
      if (guests.length === 0 && checkIns.length === 0 && checkOuts.length === 0) return [];
      return [
        {
          blockId,
          hotelName: b.hotel,
          blockTitle: b.title,
          guests: guests.map(name).sort(),
          checkIns: checkIns.map(name).sort(),
          checkOuts: checkOuts.map(name).sort(),
          assignmentIds: [...new Set([...guests, ...checkIns, ...checkOuts].map((s) => s.id))],
        },
      ];
    })
    .sort((a, b) => (a.hotelName ?? a.blockTitle).localeCompare(b.hotelName ?? b.blockTitle));
}

export interface ShowDayData {
  readonly runs: readonly RunOfShow[];
  readonly cues: readonly ShowDayCue[];
  readonly links: readonly SetTimeLink[];
  readonly stageNames: ReadonlyMap<string, string>;
  /** Null when the viewer lacks hospitality.fulfillment.read on the project. */
  readonly arrivals: readonly TravelSegment[] | null;
  readonly hotels: readonly HotelNight[] | null;
}

interface CueRow {
  id: string;
  run_of_show_id: string;
  position: number;
  label: string;
  planned_at: string | null;
  duration: unknown;
  called_at: string | null;
}

interface StayRow {
  id: string;
  check_in_on: string;
  check_out_on: string;
  person: { full_name: string | null } | null;
  block: { id: string; title: string; hotel: { counterparty_name: string | null } | null } | null;
}

interface LinkRow {
  cue_id: string;
  engagement: { person: { full_name: string | null } | null } | null;
}

/** Everything the Show day of one project and day shows, in at most six reads. */
export async function loadShowDay(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly project: ShowDayProject;
    readonly day: string;
    readonly hospitality: boolean;
  },
): Promise<Result<ShowDayData>> {
  const runs = await listRunsOfShow(db, {
    orgId: input.orgId,
    projectId: input.project.id,
    from: input.day,
    to: input.day,
  });
  if (!runs.ok) return runs;
  const runIds = runs.data.map((r) => r.id);
  const scopeIds = [...new Set(runs.data.flatMap((r) => (r.scopeNodeId ? [r.scopeNodeId] : [])))];
  const [cues, scopes, travel, blocks] = await Promise.all([
    runIds.length === 0
      ? Promise.resolve({ data: [] as CueRow[], error: null })
      : db
          .from("cues")
          .select("id, run_of_show_id, position, label, planned_at, duration, called_at")
          .in("run_of_show_id", runIds)
          .is("deleted_at", null)
          .order("position"),
    scopeIds.length === 0
      ? Promise.resolve({ data: [] as { id: string; name: string }[], error: null })
      : db.from("scope_nodes").select("id, name").in("id", scopeIds),
    input.hospitality
      ? listTravelSegments(db, { orgId: input.orgId, projectId: input.project.id })
      : Promise.resolve(null),
    input.hospitality
      ? db
          .from("accommodation_assignments")
          .select(
            "id, check_in_on, check_out_on, person:people!accommodation_assignments_person_id_fkey(full_name), " +
              "block:accommodation_blocks!accommodation_assignments_accommodation_block_id_fkey!inner(id, title, project_id, deleted_at, hotel:counterparties!accommodation_blocks_counterparty_id_fkey(counterparty_name))",
          )
          .eq("block.project_id", input.project.id)
          .is("block.deleted_at", null)
          .is("deleted_at", null)
          .lte("check_in_on", input.day)
          .gte("check_out_on", input.day)
      : Promise.resolve(null),
  ]);
  if (cues.error) return fail(toDataError(cues.error));
  if (scopes.error) return fail(toDataError(scopes.error));
  if (travel && !travel.ok) return travel;
  if (blocks?.error) return fail(toDataError(blocks.error));
  const cueRows = (cues.data ?? []) as unknown as CueRow[];
  const cueIds = cueRows.map((c) => c.id);
  const links =
    cueIds.length === 0
      ? { data: [] as LinkRow[], error: null }
      : await db
          .from("engagement_cues")
          .select(
            "cue_id, engagement:engagements!engagement_cues_engagement_id_fkey(person:people!engagements_person_id_fkey(full_name))",
          )
          .in("cue_id", cueIds)
          .is("deleted_at", null);
  if (links.error) return fail(toDataError(links.error));
  return ok({
    runs: runs.data,
    cues: cueRows.map((c) => ({
      id: c.id,
      runOfShowId: c.run_of_show_id,
      position: c.position,
      label: c.label,
      plannedAt: c.planned_at,
      durationSeconds: intervalSeconds(c.duration === null ? null : String(c.duration)),
      calledAt: c.called_at,
    })),
    links: ((links.data ?? []) as unknown as LinkRow[]).map((l) => ({
      cueId: l.cue_id,
      actName: l.engagement?.person?.full_name ?? null,
    })),
    stageNames: new Map(
      ((scopes.data ?? []) as { id: string; name: string }[]).map((s) => [s.id, s.name]),
    ),
    arrivals: travel ? arrivalsOn(travel.data, input.day, input.project.timeZone) : null,
    hotels: blocks
      ? hotelsOn(
          ((blocks.data ?? []) as unknown as StayRow[]).map((r) => ({
            id: r.id,
            personName: r.person?.full_name ?? null,
            checkInOn: r.check_in_on,
            checkOutOn: r.check_out_on,
            blockId: r.block?.id ?? "",
            blockTitle: r.block?.title ?? "",
            hotelName: r.block?.hotel?.counterparty_name ?? null,
          })),
          input.day,
        )
      : null,
  });
}
