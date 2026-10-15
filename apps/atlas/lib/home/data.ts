import { listActivity, type ActivityEntry } from "@xos/data/activity";
import {
  listBlockedRecords,
  listMyOverdueRecords,
  listMyRecordsBetween,
  summarizeReadiness,
  type GateReadiness,
  type HomeRecord,
} from "@xos/data/home";
import {
  listCriterionStatus,
  listGateCriteria,
  listPhases,
  listProjects,
} from "@xos/data/projects";
import { must } from "@/lib/projects/loaders";
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

export type AlertKind =
  "blockedProject" | "blockedRecord" | "overdue" | "gateGap" | "noJurisdiction";

export interface Alert {
  readonly id: string;
  readonly kind: AlertKind;
  readonly severity: "high" | "medium";
  readonly values: Readonly<Record<string, string | number>>;
  /** Project key the alert opens, with the tab. */
  readonly projectKey: string | null;
  readonly tab: "overview" | "gates" | "settings";
  /** Sort time: the instant the alert concerns, newest concern first within a severity. */
  readonly at: string;
}

const GAP_WINDOW_DAYS = 30;

/**
 * The alerts Home raises (Section 4.2 Home): blocked projects and records, the person's overdue
 * records, projects whose first production day is within 30 days with blocking criteria open at the
 * current gate, and projects past Scope with no jurisdiction. Derived at read time, never stored.
 */
export function buildAlerts(input: {
  readiness: readonly GateReadiness[];
  blocked: readonly HomeRecord[];
  overdue: readonly HomeRecord[];
  today: string;
}): Alert[] {
  const alerts: Alert[] = [];
  const horizon = new Date(Date.parse(`${input.today}T00:00:00Z`) + GAP_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  for (const r of input.readiness) {
    const p = r.project;
    if (p.projectState === "Blocked") {
      alerts.push({
        id: `bp:${p.id}`,
        kind: "blockedProject",
        severity: "high",
        values: { key: p.key, name: p.name },
        projectKey: p.key,
        tab: "overview",
        at: p.updatedAt,
      });
    }
    if (
      r.unmet.length > 0 &&
      r.phase &&
      p.startsOn !== null &&
      p.startsOn >= input.today &&
      p.startsOn <= horizon
    ) {
      alerts.push({
        id: `gg:${p.id}`,
        kind: "gateGap",
        severity: "high",
        values: { key: p.key, date: p.startsOn, count: r.unmet.length, gate: r.phase.gate },
        projectKey: p.key,
        tab: "gates",
        at: `${p.startsOn}T00:00:00Z`,
      });
    }
    if (p.jurisdictionId === null && r.phase !== null && r.phase.gate > 1) {
      alerts.push({
        id: `nj:${p.id}`,
        kind: "noJurisdiction",
        severity: "medium",
        values: { key: p.key },
        projectKey: p.key,
        tab: "settings",
        at: p.updatedAt,
      });
    }
  }
  for (const rec of input.blocked) {
    alerts.push({
      id: `br:${rec.id}`,
      kind: "blockedRecord",
      severity: "high",
      values: { key: rec.key ?? "", title: rec.title, blocker: rec.blocker ?? "" },
      projectKey: rec.projectKey,
      tab: "overview",
      at: rec.updatedAt,
    });
  }
  for (const rec of input.overdue) {
    alerts.push({
      id: `od:${rec.id}`,
      kind: "overdue",
      severity: "medium",
      values: { key: rec.key ?? "", title: rec.title, date: rec.dueAt ?? "" },
      projectKey: rec.projectKey,
      tab: "overview",
      at: rec.dueAt ?? rec.updatedAt,
    });
  }
  return alerts.sort((a, b) =>
    a.severity !== b.severity ? (a.severity === "high" ? -1 : 1) : a.at < b.at ? 1 : -1,
  );
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
    today: now.toISOString().slice(0, 10),
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

/** The Home dashboard tiles (Section 4.2 Home): counts, gate readiness, alerts and recent activity. */
export async function loadHomeTiles(
  ctx: OrgContext,
  now: Date = new Date(),
): Promise<HomeTilesData> {
  const db = ctx.viewer.db;
  const personId = ctx.viewer.person?.id ?? null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86_400_000);
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
