/**
 * Org switching (Section 4.5.7): a person engaged by several orgs, or a member of several, sees a combined
 * Today across all of them, an org switcher in the header, and each item with its org's brand chip.
 *
 * Calendars (A71, RRR-116). "Today" is never the UTC date: each item is placed on its own calendar, its
 * project's time zone (the shift's own zone first), and an item without a project on the person's own zone
 * (their locale.time_zone setting, else the device's zone). After 20:00 in New York the UTC date is
 * already tomorrow; a New York shift tonight is still today's, and a Tokyo shift for that same instant is
 * tomorrow's in Tokyo.
 *
 * Tenancy. The device holds rows of every org the person works in, each admitted by its own org's scope
 * (SyncSession). Screens other than the combined Today read the active org only (inOrg): a row carries its
 * org in org_id, or through its project.
 */
import { dateIn, isTimeZone, todayIn } from "@xos/data/calendar";
import { showState, type Cue } from "./show";
import { currentShift, isMine, type ShiftRow } from "./shifts";

/** The org a local row belongs to: its org_id, else its project's org; null when neither is known. */
export function rowOrg(
  row: Readonly<Record<string, unknown>>,
  projectOrgs: ReadonlyMap<string, string>,
): string | null {
  const org = row["org_id"];
  if (typeof org === "string") return org;
  const project = row["project_id"];
  if (typeof project === "string") return projectOrgs.get(project) ?? null;
  return null;
}

/**
 * True when a row belongs on the active org's screens. A row whose org the device cannot tell (canon
 * reference rows, the outbox) shows everywhere; a row of another org never does.
 */
export function inOrg(
  row: Readonly<Record<string, unknown>>,
  activeOrgId: string | null,
  projectOrgs: ReadonlyMap<string, string>,
): boolean {
  if (activeOrgId === null) return true;
  const org = rowOrg(row, projectOrgs);
  return org === null || org === activeOrgId;
}

/**
 * The person's own time zone for personal items: their locale.time_zone setting when it is a real zone,
 * else the device's zone, else UTC.
 */
export function personTimeZone(setting: unknown, deviceZone: string | null | undefined): string {
  if (typeof setting === "string" && isTimeZone(setting)) return setting;
  return isTimeZone(deviceZone) ? deviceZone : "UTC";
}

export interface TodayProject {
  readonly id: string;
  readonly time_zone?: string | null;
}

export interface TodaySheet {
  readonly id: string;
  readonly project_id: string;
  readonly day: string;
  readonly body: string;
}

export type TodayCue = Cue & { readonly project_id?: string | null };

export interface TodayOrg {
  readonly orgId: string;
  readonly orgName: string;
  readonly projectIds: readonly string[];
  readonly me: { readonly membershipId: string | null; readonly engagementIds: readonly string[] };
}

export interface TodayInput<S extends ShiftRow> {
  readonly orgs: readonly TodayOrg[];
  readonly activeOrgId: string | null;
  readonly shifts: readonly S[];
  readonly sheets: readonly TodaySheet[];
  readonly cues: readonly TodayCue[];
  readonly projects: readonly TodayProject[];
  readonly personZone: string;
  readonly nowMs: number;
}

export interface OrgTodayGroup<S extends ShiftRow> {
  readonly orgId: string;
  readonly orgName: string;
  readonly active: boolean;
  /** My shifts that start today on their own calendar, or are under way now, soonest first. */
  readonly shifts: readonly S[];
  /** The shift being worked now, when there is one. */
  readonly working: S | null;
  /** Day sheets dated today on their project's calendar. */
  readonly sheets: readonly TodaySheet[];
  /** The next cue still to be called today on its project's calendar. */
  readonly nextCue: TodayCue | null;
  /** True when nothing is due today in this org. */
  readonly empty: boolean;
}

/** The zone an item follows: its own, its project's, else the person's own. */
export function itemZone(
  own: string | null | undefined,
  project: string | null | undefined,
  personZone: string,
): string {
  if (isTimeZone(own)) return own;
  if (isTimeZone(project)) return project;
  return personZone;
}

/** True when an instant falls on today's date in the zone. */
export function isTodayIn(iso: string, zone: string, nowMs: number): boolean {
  const instant = Date.parse(iso);
  if (!Number.isFinite(instant)) return false;
  return dateIn(new Date(instant), zone) === todayIn(zone, new Date(nowMs));
}

/**
 * The combined Today: one group per org, the active org first and the rest by name, each with its own
 * shifts, day sheets and next cue placed on their own calendars.
 */
export function combinedToday<S extends ShiftRow>(input: TodayInput<S>): OrgTodayGroup<S>[] {
  const zones = new Map(input.projects.map((p) => [p.id, p.time_zone ?? null]));
  const groups = input.orgs.map((org): OrgTodayGroup<S> => {
    const projects = new Set(org.projectIds);
    const mine = input.shifts.filter(
      (s) =>
        projects.has(s.project_id) &&
        isMine(s, org.me) &&
        s.shift_state !== "Canceled" &&
        s.shift_state !== "Draft",
    );
    const today = mine
      .filter((s) => {
        const zone = itemZone(s.time_zone, zones.get(s.project_id), input.personZone);
        const underWay =
          Date.parse(s.starts_at) <= input.nowMs && Date.parse(s.ends_at) >= input.nowMs;
        return underWay || isTodayIn(s.starts_at, zone, input.nowMs);
      })
      .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    const sheets = input.sheets.filter(
      (d) =>
        projects.has(d.project_id) &&
        d.day ===
          todayIn(itemZone(null, zones.get(d.project_id), input.personZone), new Date(input.nowMs)),
    );
    let nextCue: TodayCue | null = null;
    for (const projectId of org.projectIds) {
      const cues = input.cues.filter((c) => c.project_id === projectId);
      const next = cues.length > 0 ? showState(cues, input.nowMs).next : null;
      const zone = itemZone(null, zones.get(projectId), input.personZone);
      if (!next?.planned_at || !isTodayIn(next.planned_at, zone, input.nowMs)) continue;
      if (!nextCue?.planned_at || Date.parse(next.planned_at) < Date.parse(nextCue.planned_at))
        nextCue = next;
    }
    return {
      orgId: org.orgId,
      orgName: org.orgName,
      active: org.orgId === input.activeOrgId,
      shifts: today,
      working: currentShift(today, input.nowMs),
      sheets,
      nextCue,
      empty: today.length === 0 && sheets.length === 0 && nextCue === null,
    };
  });
  return groups.sort(
    (a, b) => Number(b.active) - Number(a.active) || a.orgName.localeCompare(b.orgName),
  );
}
