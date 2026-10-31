import type { Database, XosClient } from "./client.ts";
import type { CriterionStatus, GateCriterion, Phase, ProjectSummary } from "./projects.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Home repository (Section 4.2 Home, Section 4.5.5): what needs the person today, gate readiness
 * across projects, alerts and recent work. Records come from A03's record spine under row level
 * security, so a person sees only records of projects they may read (invariant 2). Readiness is
 * derived from the evidence spine at read time and never stored (Section 3.15).
 */

export interface HomeRecord {
  readonly id: string;
  readonly key: string | null;
  readonly title: string;
  readonly kind: string;
  readonly state: string;
  readonly dueAt: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly blocker: string | null;
  readonly projectKey: string | null;
  readonly updatedAt: string;
}

const RECORD_COLUMNS =
  "id, record_display_key, title, record_kind, record_state, due_at, starts_at, ends_at, blocker_text, updated_at, project:projects!records_project_id_fkey(project_key)";

interface RecordRow {
  id: string;
  record_display_key: string | null;
  title: string;
  record_kind: string;
  record_state: string;
  due_at: string | null;
  starts_at: string | null;
  ends_at: string | null;
  blocker_text: string | null;
  updated_at: string;
  project: { project_key: string } | null;
}

function toRecord(row: RecordRow): HomeRecord {
  return {
    id: row.id,
    key: row.record_display_key,
    title: row.title,
    kind: row.record_kind,
    state: row.record_state,
    dueAt: row.due_at,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    blocker: row.blocker_text,
    projectKey: row.project?.project_key ?? null,
    updatedAt: row.updated_at,
  };
}

/** Record states that close a record; a closed record is never due or overdue. */
const CLOSED_STATES = "(Complete,Canceled,Deferred)";

/**
 * Open records the person owns or is accountable for that are due, start or run within the window,
 * soonest first: the Today page (Section 4.5.5).
 */
export async function listMyRecordsBetween(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly personId: string;
    readonly from: Date;
    readonly to: Date;
  },
): Promise<Result<HomeRecord[]>> {
  const from = input.from.toISOString();
  const to = input.to.toISOString();
  const { data, error } = await db
    .from("records")
    .select(RECORD_COLUMNS)
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .not("record_state", "in", CLOSED_STATES)
    .or(`owner_party_id.eq.${input.personId},accountable_party_id.eq.${input.personId}`)
    .or(
      `and(due_at.gte.${from},due_at.lt.${to}),and(starts_at.lt.${to},ends_at.gte.${from}),and(starts_at.gte.${from},starts_at.lt.${to})`,
    )
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(100);
  if (error) return fail(toDataError(error));
  return ok((data as unknown as RecordRow[]).map(toRecord));
}

/** Open records the person owns or is accountable for whose due time has passed, oldest first. */
export async function listMyOverdueRecords(
  db: XosClient,
  input: { readonly orgId: string; readonly personId: string; readonly now: Date },
): Promise<Result<HomeRecord[]>> {
  const { data, error } = await db
    .from("records")
    .select(RECORD_COLUMNS)
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .not("record_state", "in", CLOSED_STATES)
    .or(`owner_party_id.eq.${input.personId},accountable_party_id.eq.${input.personId}`)
    .lt("due_at", input.now.toISOString())
    .order("due_at", { ascending: true })
    .limit(100);
  if (error) return fail(toDataError(error));
  return ok((data as unknown as RecordRow[]).map(toRecord));
}

/** Blocked records the person may read, each naming its blocker, most recently changed first. */
export async function listBlockedRecords(
  db: XosClient,
  orgId: string,
): Promise<Result<HomeRecord[]>> {
  const { data, error } = await db
    .from("records")
    .select(RECORD_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .eq("record_state", "Blocked")
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) return fail(toDataError(error));
  return ok((data as unknown as RecordRow[]).map(toRecord));
}

/** Records the person changed most recently: the Recent page's history of their own work. */
export async function listRecentRecords(
  db: XosClient,
  input: { readonly orgId: string; readonly personId: string; readonly limit?: number },
): Promise<Result<HomeRecord[]>> {
  const { data, error } = await db
    .from("records")
    .select(RECORD_COLUMNS)
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .or(`updated_by.eq.${input.personId},created_by.eq.${input.personId}`)
    .order("updated_at", { ascending: false })
    .limit(input.limit ?? 25);
  if (error) return fail(toDataError(error));
  return ok((data as unknown as RecordRow[]).map(toRecord));
}

// Gate readiness ---------------------------------------------------------------------------------

export interface GateReadiness {
  readonly project: ProjectSummary;
  /** The phase the project is in; its gate is the next one to pass. Null after gate 9 is passed. */
  readonly phase: Phase | null;
  readonly blockingTotal: number;
  readonly blockingMet: number;
  readonly advisoryTotal: number;
  readonly advisoryMet: number;
  /** Blocking criteria of the current gate with no evidence of rank 1 or more, in canon order. */
  readonly unmet: readonly GateCriterion[];
  /** True once every gate is passed and the project rests in Close. */
  readonly closed: boolean;
}

/**
 * Readiness of each project's current gate, from canon criteria and the evidence spine. A criterion
 * counts as met only with evidence of assertion rank 1 or more (Section 3.7: an absent claim is a
 * refusal, never a pass).
 */
export function summarizeReadiness(
  projects: readonly ProjectSummary[],
  phases: readonly Phase[],
  criteria: readonly GateCriterion[],
  statuses: readonly CriterionStatus[],
): GateReadiness[] {
  const met = new Set(
    statuses.filter((s) => s.evidenceCount > 0).map((s) => `${s.projectId}|${s.criterionId}`),
  );
  const passed = new Set(
    statuses.filter((s) => s.gatePassed).map((s) => `${s.projectId}|${s.gate}`),
  );
  return projects.map((project) => {
    const phase = phases.find((p) => p.code === project.phaseCode) ?? null;
    const gate = phase?.gate ?? 0;
    const closed = gate > 0 && passed.has(`${project.id}|${gate}`) && gate === phases.length;
    const current = criteria.filter((c) => c.gate === gate);
    const isMet = (c: GateCriterion) => met.has(`${project.id}|${c.id}`);
    const blocking = current.filter((c) => c.blocking);
    const advisory = current.filter((c) => !c.blocking);
    return {
      project,
      phase,
      blockingTotal: blocking.length,
      blockingMet: blocking.filter(isMet).length,
      advisoryTotal: advisory.length,
      advisoryMet: advisory.filter(isMet).length,
      unmet: closed ? [] : blocking.filter((c) => !isMet(c)),
      closed,
    };
  });
}

// Alerts -----------------------------------------------------------------------------------------

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

// Home summary (API home.get) --------------------------------------------------------------------

/** Records the person owns or is accountable for: open (not closed) or Blocked, counted. */
export async function countMyRecords(
  db: XosClient,
  input: { readonly orgId: string; readonly personId: string; readonly which: "open" | "blocked" },
): Promise<Result<number>> {
  let q = db
    .from("records")
    .select("id", { count: "exact", head: true })
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .or(`owner_party_id.eq.${input.personId},accountable_party_id.eq.${input.personId}`);
  q =
    input.which === "blocked"
      ? q.eq("record_state", "Blocked")
      : q.not("record_state", "in", CLOSED_STATES);
  const { count, error } = await q;
  if (error) return fail(toDataError(error));
  return ok(count ?? 0);
}

/** The org's base currency, as A30's settings registry resolves it for the caller. */
export async function orgBaseCurrency(db: XosClient, orgId: string): Promise<Result<string>> {
  const { data, error } = await db.rpc("resolve_settings", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  const value = (data ?? []).find((s) => s.setting_key === "org.base_currency")?.value_text;
  if (!value) return fail({ kind: "not-found" });
  return ok(value.toUpperCase());
}

export interface MoneyTotal {
  /** Sum in minor units; null when nothing priced was summed (Section 3.7: blanks stay blank). */
  readonly totalMinor: number | null;
  readonly currency: string;
  /** Inputs left out of the sum: unpriced purchase orders, or ones in another currency. */
  readonly unpricedCount: number;
}

const COMMITTED_STATES: Database["app"]["Enums"]["po_state"][] = ["Approved", "Sent", "Closed"];

/**
 * Committed spend: approved, sent and closed purchase orders with their approved change orders, in
 * the given currency. A purchase order with an unpriced line, or in another currency, is counted as
 * unpriced rather than converted or zeroed.
 */
export async function committedSpend(
  db: XosClient,
  orgId: string,
  currency: string,
): Promise<Result<MoneyTotal>> {
  const pos = await db
    .from("purchase_orders")
    .select("id")
    .eq("org_id", orgId)
    .in("po_state", COMMITTED_STATES)
    .is("deleted_at", null);
  if (pos.error) return fail(toDataError(pos.error));
  const ids = (pos.data ?? []).map((r) => r.id);
  if (ids.length === 0) return ok({ totalMinor: null, currency, unpricedCount: 0 });
  const totals = await db
    .from("purchase_order_totals")
    .select("purchase_order_id, currency_code, lines_total_minor, approved_changes_minor")
    .in("purchase_order_id", ids);
  if (totals.error) return fail(toDataError(totals.error));
  let sum = 0;
  let summed = 0;
  let unpriced = 0;
  for (const t of totals.data ?? []) {
    if (t.currency_code !== currency || t.lines_total_minor === null) {
      unpriced += 1;
      continue;
    }
    sum += t.lines_total_minor + (t.approved_changes_minor ?? 0);
    summed += 1;
  }
  return ok({ totalMinor: summed > 0 ? sum : null, currency, unpricedCount: unpriced });
}

/** The next doors of Home > Today (B6, G-249): an Event record whose doors open soonest. */
export interface NextDoors {
  readonly recordId: string;
  readonly key: string | null;
  readonly title: string;
  readonly projectKey: string;
  readonly projectName: string;
  /** The project's IANA zone, which the tile shows the doors time in. */
  readonly projectTimeZone: string | null;
  readonly venueName: string | null;
  readonly doorsAt: string;
}

/** How far back an opened door still shows (Doors opened 40 min ago), and how far ahead the tile looks. */
const DOORS_LOOKBACK_MS = 6 * 3_600_000;
const DOORS_LOOKAHEAD_MS = 14 * 86_400_000;

/**
 * The earliest doors at or after six hours ago and within 14 days, among the live Event records of
 * the org's live projects the viewer reads (row level security), or null when there is none. The
 * venue is the event's own (app.record_event.venue_id). Two reads, never one per record.
 */
export async function nextDoors(
  db: XosClient,
  input: { readonly orgId: string; readonly now?: Date },
): Promise<Result<NextDoors | null>> {
  const now = input.now ?? new Date();
  const events = await db
    .from("record_event")
    .select("record_id, doors_at, venue:venues!record_event_venue_id_fkey(name)")
    .eq("org_id", input.orgId)
    .gte("doors_at", new Date(now.getTime() - DOORS_LOOKBACK_MS).toISOString())
    .lte("doors_at", new Date(now.getTime() + DOORS_LOOKAHEAD_MS).toISOString())
    .order("doors_at", { ascending: true })
    .limit(25);
  if (events.error) return fail(toDataError(events.error));
  const rows = (events.data ?? []) as unknown as {
    record_id: string;
    doors_at: string | null;
    venue: { name: string } | null;
  }[];
  if (rows.length === 0) return ok(null);
  const records = await db
    .from("records")
    .select(
      "id, record_display_key, title, project:projects!records_project_id_fkey(project_key, name, time_zone, deleted_at)",
    )
    .in(
      "id",
      rows.map((r) => r.record_id),
    )
    .eq("org_id", input.orgId)
    .eq("record_kind", "Event")
    .neq("record_state", "Canceled")
    .is("deleted_at", null);
  if (records.error) return fail(toDataError(records.error));
  const byId = new Map(
    (
      (records.data ?? []) as unknown as {
        id: string;
        record_display_key: string | null;
        title: string;
        project: {
          project_key: string;
          name: string;
          time_zone: string | null;
          deleted_at: string | null;
        } | null;
      }[]
    ).map((r) => [r.id, r]),
  );
  for (const row of rows) {
    const record = byId.get(row.record_id);
    if (!record || !row.doors_at || !record.project || record.project.deleted_at !== null) continue;
    return ok({
      recordId: record.id,
      key: record.record_display_key,
      title: record.title,
      projectKey: record.project.project_key,
      projectName: record.project.name,
      projectTimeZone: record.project.time_zone,
      venueName: row.venue?.name ?? null,
      doorsAt: row.doors_at,
    });
  }
  return ok(null);
}
