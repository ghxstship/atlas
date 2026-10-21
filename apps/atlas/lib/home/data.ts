import { listActivity, type ActivityEntry } from "@xos/data/activity";
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
} from "@xos/data/projects";
import { must } from "@/lib/projects/loaders";
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

export interface HomeTilesData {
  readonly projectCount: number;
  readonly active: number;
  readonly blocked: number;
  readonly dueToday: number | null;
  readonly openBlockers: number;
  readonly readiness: GateReadiness[];
  readonly alerts: Alert[];
  readonly activity: ActivityEntry[];
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
  const readiness = await loadReadiness(ctx);
  const [projects, alerts, due, activity] = await Promise.all([
    listProjects(db, ctx.org.id),
    loadAlerts(ctx, now, readiness),
    personId
      ? listMyRecordsBetween(db, { orgId: ctx.org.id, personId, from: start, to: end })
      : Promise.resolve(null),
    canFeed ? listActivity(db, { orgId: ctx.org.id, limit: 6 }) : Promise.resolve(null),
  ]);
  const all = must(projects, "projects");
  return {
    projectCount: all.length,
    active: all.filter((p) => p.projectState !== "Complete" && p.projectState !== "Canceled")
      .length,
    blocked: all.filter((p) => p.projectState === "Blocked").length,
    dueToday: due === null ? null : must(due, "today's records").length,
    openBlockers: readiness.reduce((n, r) => n + r.unmet.length, 0),
    readiness: readiness.slice(0, 5),
    alerts: alerts.slice(0, 5),
    activity: activity === null ? [] : must(activity, "activity").entries,
  };
}
