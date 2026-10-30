import { labelActivity, listActivity, type ActivityEntry } from "@xos/data/activity";
import { addCalendarDays, startOfDayIn, todayIn } from "@xos/data/calendar";
import {
  buildAlerts,
  type Alert,
  listBlockedRecords,
  listMyOverdueRecords,
  listMyRecordsBetween,
  summarizeReadiness,
  type GateReadiness,
} from "@xos/data/home";
import {
  listCriterionStatus,
  listGateCriteria,
  listPhases,
  listProjects,
  type ProjectSummary,
} from "@xos/data/projects";
import { must } from "@/lib/projects/loaders";
import { regionOf, regionRead, type RegionData } from "@/lib/shell/region-data";
import { getOrgTimeZone } from "@/lib/shell/time-zone";

export type { Alert, AlertKind } from "@xos/data/home";
export { buildAlerts } from "@xos/data/home";
import type { OrgContext } from "@/lib/shell/context";

/** Readiness of every live project's current gate the viewer may read, with the gate count. */
export async function loadReadinessBoard(
  ctx: OrgContext,
): Promise<{ readiness: GateReadiness[]; totalGates: number }> {
  const db = ctx.viewer.db;
  const [projects, phases, criteria] = await Promise.all([
    listProjects(db, ctx.org.id),
    listPhases(db),
    listGateCriteria(db),
  ]);
  const live = must(projects, "projects").filter(
    (p) => p.projectState !== "Canceled" && p.projectState !== "Complete",
  );
  const statuses = must(
    await listCriterionStatus(
      db,
      live.map((p) => p.id),
    ),
    "gate readiness",
  );
  const allPhases = must(phases, "phases");
  return {
    readiness: summarizeReadiness(live, allPhases, must(criteria, "gate criteria"), statuses),
    totalGates: allPhases.length,
  };
}

/** Readiness of every live project's current gate the viewer may read. */
export async function loadReadiness(ctx: OrgContext): Promise<GateReadiness[]> {
  return (await loadReadinessBoard(ctx)).readiness;
}

/** Everything the alert list needs, read for the viewer. */
export async function loadAlerts(
  ctx: OrgContext,
  now: Date = new Date(),
  known?: readonly GateReadiness[],
): Promise<Alert[]> {
  const db = ctx.viewer.db;
  const personId = ctx.viewer.person?.id ?? null;
  const [readiness, blocked, overdue] = await Promise.all([
    known ? Promise.resolve([...known]) : loadReadiness(ctx),
    listBlockedRecords(db, ctx.org.id),
    personId
      ? listMyOverdueRecords(db, { orgId: ctx.org.id, personId, now })
      : Promise.resolve({ ok: true as const, data: [] }),
  ]);
  return buildAlerts({
    readiness,
    blocked: must(blocked, "blocked records"),
    overdue: must(overdue, "overdue records"),
    today: todayIn(await getOrgTimeZone(ctx), now),
  });
}

/**
 * Home's tiles, each read on its own (ADR 0118): a read that fails takes down only the tiles built
 * on it. Gate readiness feeds the readiness tile, the open blockers count and the alerts.
 */
export interface HomeTilesData {
  /** How many projects the viewer may read; null when they could not be read. */
  readonly projectCount: number | null;
  readonly active: RegionData<number>;
  readonly blocked: RegionData<number>;
  /** Null inside when the viewer has no person in the org, so nothing is theirs. */
  readonly dueToday: RegionData<number | null>;
  readonly openBlockers: RegionData<number>;
  readonly readiness: RegionData<GateReadiness[]>;
  readonly alerts: RegionData<Alert[]>;
  readonly activity: RegionData<ActivityEntry[]>;
}

/**
 * Today on a calendar as the instants it starts and ends: Home's "due today" window on the org's
 * calendar (A71), not the server's UTC day, which in New York starts at 20:00 the evening before.
 */
export function todayWindow(zone: string, now: Date = new Date()): { from: Date; to: Date } {
  const today = todayIn(zone, now);
  return {
    from: new Date(startOfDayIn(today, zone)),
    to: new Date(startOfDayIn(addCalendarDays(today, 1), zone)),
  };
}

/** The Home dashboard tiles (Section 4.2 Home): counts, gate readiness, alerts and recent activity. */
export async function loadHomeTiles(
  ctx: OrgContext,
  now: Date = new Date(),
): Promise<HomeTilesData> {
  const db = ctx.viewer.db;
  const personId = ctx.viewer.person?.id ?? null;
  const { from: start, to: end } = todayWindow(await getOrgTimeZone(ctx), now);
  const canFeed = ctx.capabilities.has("activity.feed.read");
  const readiness = await regionRead("home.readiness", () => loadReadiness(ctx));
  const [projects, alerts, due, activity] = await Promise.all([
    listProjects(db, ctx.org.id),
    // The alerts include every gate readiness alert, so without readiness they do not show.
    readiness.ok
      ? regionRead("home.alerts", () => loadAlerts(ctx, now, readiness.data))
      : Promise.resolve(readiness),
    personId
      ? listMyRecordsBetween(db, { orgId: ctx.org.id, personId, from: start, to: end })
      : Promise.resolve(null),
    canFeed
      ? regionRead("home.activity", async () =>
          labelActivity(
            db,
            must(await listActivity(db, { orgId: ctx.org.id, limit: 6 }), "activity").entries,
          ),
        )
      : Promise.resolve({ ok: true as const, data: [] }),
  ]);
  const all = regionOf("home.projects", () => must(projects, "projects"));
  const count = (pick: (p: ProjectSummary) => boolean): RegionData<number> =>
    all.ok ? { ok: true, data: all.data.filter(pick).length } : all;
  return {
    projectCount: all.ok ? all.data.length : null,
    active: count((p) => p.projectState !== "Complete" && p.projectState !== "Canceled"),
    blocked: count((p) => p.projectState === "Blocked"),
    dueToday:
      due === null
        ? { ok: true, data: null }
        : regionOf("home.due-today", () => must(due, "today's records").length),
    openBlockers: readiness.ok
      ? { ok: true, data: readiness.data.reduce((n, r) => n + r.unmet.length, 0) }
      : readiness,
    readiness: readiness.ok ? { ok: true, data: readiness.data.slice(0, 5) } : readiness,
    alerts: alerts.ok ? { ok: true, data: alerts.data.slice(0, 5) } : alerts,
    activity,
  };
}
