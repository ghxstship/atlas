import type { XosClient } from "./client.ts";
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
