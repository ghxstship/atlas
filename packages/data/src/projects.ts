import type { Database, XosClient } from "./client";
import { Constants } from "./database.types";
import { fail, ok, toDataError, type Result } from "./result";

/**
 * Projects repository (Section 4.2 Projects, Section 4.5.1, Section 3.4): projects with their
 * project and production lifecycles, the scope tree, gate evidence on the one evidence spine, gate
 * passage and project members. Reads go through row level security (invariant 2: project data is
 * readable by project members, assigned people and project overseers); every state change goes
 * through A03's RPCs in migration 0301, which authorize, compare-and-set and write the ledgers.
 */

type Enums = Database["app"]["Enums"];
export type ProjectState = Enums["project_state"];
export type ProductionState = Enums["production_state"];
export type ProjectRole = Enums["project_role"];
export type ScopeKind = Enums["scope_kind"];

export interface ProjectSummary {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly projectState: ProjectState;
  readonly productionState: ProductionState;
  readonly phaseCode: string;
  readonly jurisdictionId: string | null;
  readonly regionCode: string | null;
  readonly tierCode: string | null;
  readonly timeZone: string;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly venueId: string | null;
  readonly venueName: string | null;
  readonly workspaceId: string | null;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}

export interface ScopeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: ScopeKind;
  readonly code: string;
  readonly name: string;
  readonly venueId: string | null;
  readonly venueName: string | null;
  /** ltree path of scope codes from the root; its depth orders the tree. */
  readonly path: string;
}

export interface Phase {
  readonly code: string;
  readonly gate: number;
  readonly name: string;
  readonly actCode: string;
  readonly definition: string;
  readonly gateExit: string;
}

export interface GateCriterion {
  readonly id: string;
  readonly gate: number;
  readonly ordinal: number;
  readonly statement: string;
  readonly blocking: boolean;
}

export interface CriterionStatus {
  readonly projectId: string;
  readonly criterionId: string;
  readonly gate: number;
  readonly blocking: boolean;
  /** Pieces of evidence of assertion rank 1 or more. */
  readonly evidenceCount: number;
  /** Highest rank attested; null when nothing is attested (the silence rule: absent, not zero). */
  readonly bestRank: number | null;
  readonly gatePassed: boolean;
}

export interface GateEvidence {
  readonly id: string;
  readonly criterionId: string;
  readonly uri: string | null;
  readonly note: string | null;
  readonly rank: number;
  readonly attestedBy: string | null;
  readonly attestedAt: string;
}

export interface AssertionRank {
  readonly rank: number;
  readonly meaning: string;
}

export interface PhaseTransition {
  readonly id: string;
  readonly gate: number;
  readonly fromPhaseCode: string;
  readonly toPhaseCode: string | null;
  readonly reason: string;
  readonly actor: string | null;
  readonly at: string;
}

export interface StateTransition<S extends string> {
  readonly id: string;
  readonly fromState: S | null;
  readonly toState: S;
  readonly reason: string;
  readonly actor: string | null;
  readonly at: string;
}

export interface ProjectMember {
  readonly id: string;
  readonly membershipId: string;
  readonly personId: string | null;
  readonly fullName: string | null;
  readonly role: ProjectRole;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface CodeLabel {
  readonly code: string;
  readonly label: string;
}

export interface Jurisdiction {
  readonly id: string;
  readonly level: string;
  readonly parent: string | null;
  readonly populated: boolean;
}

export interface Venue {
  readonly id: string;
  readonly name: string;
  readonly jurisdictionId: string;
  readonly timeZone: string;
}

const PROJECT_COLUMNS =
  "id, project_key, name, project_state, production_state, current_phase_code, jurisdiction_id, region_code, tier_code, time_zone, starts_on, ends_on, venue_id, workspace_id, archived_at, updated_at, venue:venues!projects_venue_id_fkey(name)";

interface ProjectRow {
  id: string;
  project_key: string;
  name: string;
  project_state: ProjectState;
  production_state: ProductionState;
  current_phase_code: string;
  jurisdiction_id: string | null;
  region_code: string | null;
  tier_code: string | null;
  time_zone: string;
  starts_on: string | null;
  ends_on: string | null;
  venue_id: string | null;
  workspace_id: string | null;
  archived_at: string | null;
  updated_at: string;
  venue: { name: string } | null;
}

function toProject(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    key: row.project_key,
    name: row.name,
    projectState: row.project_state,
    productionState: row.production_state,
    phaseCode: row.current_phase_code,
    jurisdictionId: row.jurisdiction_id,
    regionCode: row.region_code,
    tierCode: row.tier_code,
    timeZone: row.time_zone,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    venueId: row.venue_id,
    venueName: row.venue?.name ?? null,
    workspaceId: row.workspace_id,
    archivedAt: row.archived_at,
    updatedAt: row.updated_at,
  };
}

/** A two to five letter project key (Section 4.5.1), as `projects_key_format` checks it. */
export function isProjectKey(value: string): boolean {
  return /^[A-Z]{2,5}$/.test(value);
}

// Projects ---------------------------------------------------------------------------------------

/** Projects of the org the viewer may read, ordered by key; archived ones only on request. */
export async function listProjects(
  db: XosClient,
  orgId: string,
  options: { readonly includeArchived?: boolean } = {},
): Promise<Result<ProjectSummary[]>> {
  let query = db
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("project_key");
  if (!options.includeArchived) query = query.is("archived_at", null);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data as unknown as ProjectRow[]).map(toProject));
}

/** One project by key, or not-found when it does not exist or the viewer may not read it. */
export async function getProjectByKey(
  db: XosClient,
  orgId: string,
  projectKey: string,
): Promise<Result<ProjectSummary>> {
  if (!isProjectKey(projectKey)) return fail({ kind: "not-found" });
  const { data, error } = await db
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("org_id", orgId)
    .eq("project_key", projectKey)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toProject(data as unknown as ProjectRow));
}

export interface ProjectInput {
  readonly orgId: string;
  readonly key: string;
  readonly name: string;
  readonly timeZone: string;
  readonly jurisdictionId?: string | null;
  readonly regionCode?: string | null;
  readonly tierCode?: string | null;
  readonly venueId?: string | null;
  readonly startsOn?: string | null;
  readonly endsOn?: string | null;
}

/**
 * Creates a project in Proposed at Scope and its Engagement Root scope node, coded `{KEY}-E01`
 * after the engagement it roots. The database checks the key format, uniqueness per org, the time
 * zone and the active_projects plan limit; a refusal comes back typed.
 */
export async function createProject(
  db: XosClient,
  input: ProjectInput,
): Promise<Result<{ id: string; key: string; rootScopeNodeId: string }>> {
  const { data, error } = await db
    .from("projects")
    .insert({
      org_id: input.orgId,
      project_key: input.key,
      name: input.name.trim(),
      time_zone: input.timeZone,
      jurisdiction_id: input.jurisdictionId ?? null,
      region_code: input.regionCode ?? null,
      tier_code: input.tierCode ?? null,
      venue_id: input.venueId ?? null,
      starts_on: input.startsOn ?? null,
      ends_on: input.endsOn ?? null,
    })
    .select("id, project_key")
    .single();
  if (error) return fail(toDataError(error));
  const root = await createScopeNode(db, {
    projectId: data.id,
    parentId: null,
    kind: "Engagement Root",
    code: `${data.project_key}-E01`,
    name: input.name.trim(),
    venueId: input.venueId ?? null,
  });
  if (!root.ok) return fail(root.error);
  return ok({ id: data.id, key: data.project_key, rootScopeNodeId: root.data.id });
}

export type ProjectPatch = Partial<Omit<ProjectInput, "orgId">>;

/** Edits a project's header fields; the database decides who may change the key (0301 guard). */
export async function updateProject(
  db: XosClient,
  projectId: string,
  patch: ProjectPatch,
): Promise<Result<null>> {
  const update: Database["app"]["Tables"]["projects"]["Update"] = {};
  if (patch.key !== undefined) update.project_key = patch.key;
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.timeZone !== undefined) update.time_zone = patch.timeZone;
  if (patch.jurisdictionId !== undefined) update.jurisdiction_id = patch.jurisdictionId;
  if (patch.regionCode !== undefined) update.region_code = patch.regionCode;
  if (patch.tierCode !== undefined) update.tier_code = patch.tierCode;
  if (patch.venueId !== undefined) update.venue_id = patch.venueId;
  if (patch.startsOn !== undefined) update.starts_on = patch.startsOn;
  if (patch.endsOn !== undefined) update.ends_on = patch.endsOn;
  return writeOne(db.from("projects").update(update).eq("id", projectId).select("id"));
}

/** Archives or restores a project (projects.project.archive); archived projects leave the lists. */
export async function setProjectArchived(
  db: XosClient,
  projectId: string,
  archived: boolean,
  now: Date = new Date(),
): Promise<Result<null>> {
  return writeOne(
    db
      .from("projects")
      .update({ archived_at: archived ? now.toISOString() : null })
      .eq("id", projectId)
      .select("id"),
  );
}

/** An update that must touch exactly one visible row; zero rows means not-found (ADR 0003). */
async function writeOne(
  query: PromiseLike<{ data: unknown[] | null; error: Parameters<typeof toDataError>[0] | null }>,
): Promise<Result<null>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  if (!data || data.length === 0) return fail({ kind: "not-found" });
  return ok(null);
}

// Lifecycles -------------------------------------------------------------------------------------

/** The moves a lifecycle allows from a state, read from the database's rule table (Section 3.12). */
export async function listAllowedTransitions(
  db: XosClient,
  lifecycle: "project" | "production",
  from: string,
): Promise<Result<string[]>> {
  const { data, error } = await db
    .from("lifecycle_transition_rules")
    .select("to_state")
    .eq("lifecycle", lifecycle)
    .eq("from_state", from);
  if (error) return fail(toDataError(error));
  return ok(data.flatMap((r) => (r.to_state ? [r.to_state] : [])));
}

export interface TransitionInput<S extends string> {
  readonly projectId: string;
  readonly expected: S;
  readonly next: S;
  readonly reason: string;
}

/** Moves a project to another project state (compare-and-set on the expected state). */
export async function transitionProject(
  db: XosClient,
  input: TransitionInput<ProjectState>,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("transition_project", {
    p_project_id: input.projectId,
    p_expected: input.expected,
    p_next: input.next,
    p_reason: input.reason.trim(),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

/** Moves a project's production to another production state; Closed refuses new spend. */
export async function transitionProduction(
  db: XosClient,
  input: TransitionInput<ProductionState>,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("transition_production", {
    p_project_id: input.projectId,
    p_expected: input.expected,
    p_next: input.next,
    p_reason: input.reason.trim(),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

interface LedgerRow {
  id: string;
  from_state: string | null;
  to_state: string;
  reason: string;
  created_at: string;
  actor: { full_name: string | null } | null;
}

function toTransition<S extends string>(row: LedgerRow): StateTransition<S> {
  return {
    id: row.id,
    fromState: row.from_state as S | null,
    toState: row.to_state as S,
    reason: row.reason,
    actor: row.actor?.full_name ?? null,
    at: row.created_at,
  };
}

/** The project state ledger, newest first. */
export async function listProjectStateHistory(
  db: XosClient,
  projectId: string,
): Promise<Result<StateTransition<ProjectState>[]>> {
  const { data, error } = await db
    .from("project_state_transitions")
    .select(
      "id, from_state, to_state, reason, created_at, actor:people!project_state_transitions_created_by_fkey(full_name)",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok((data as unknown as LedgerRow[]).map((r) => toTransition<ProjectState>(r)));
}

/** The production state ledger, newest first. */
export async function listProductionStateHistory(
  db: XosClient,
  projectId: string,
): Promise<Result<StateTransition<ProductionState>[]>> {
  const { data, error } = await db
    .from("production_state_transitions")
    .select(
      "id, from_state, to_state, reason, created_at, actor:people!production_state_transitions_created_by_fkey(full_name)",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok((data as unknown as LedgerRow[]).map((r) => toTransition<ProductionState>(r)));
}

// Scope tree -------------------------------------------------------------------------------------

/** The project's scope tree, in path order so parents precede their children. */
export async function listScopeNodes(
  db: XosClient,
  projectId: string,
): Promise<Result<ScopeNode[]>> {
  const { data, error } = await db
    .from("scope_nodes")
    .select(
      "id, parent_id, scope_kind, scope_code, name, venue_id, path, venue:venues!scope_nodes_venue_id_fkey(name)",
    )
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("path");
  if (error) return fail(toDataError(error));
  const rows = data as unknown as {
    id: string;
    parent_id: string | null;
    scope_kind: ScopeKind;
    scope_code: string;
    name: string;
    venue_id: string | null;
    path: string;
    venue: { name: string } | null;
  }[];
  return ok(
    rows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      kind: r.scope_kind,
      code: r.scope_code,
      name: r.name,
      venueId: r.venue_id,
      venueName: r.venue?.name ?? null,
      path: r.path,
    })),
  );
}

export interface ScopeNodeInput {
  readonly projectId: string;
  readonly parentId: string | null;
  readonly kind: ScopeKind;
  readonly code: string;
  readonly name: string;
  readonly venueId?: string | null;
}

/** Adds a scope node; the database maintains its path and refuses a parent in another project. */
export async function createScopeNode(
  db: XosClient,
  input: ScopeNodeInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("scope_nodes")
    .insert({
      project_id: input.projectId,
      parent_id: input.parentId,
      scope_kind: input.kind,
      scope_code: input.code,
      name: input.name.trim(),
      venue_id: input.venueId ?? null,
      // Maintained by the t40 guard from parent_id and scope_code; any value is replaced.
      path: input.code.replace(/-/g, "_"),
    } as Database["app"]["Tables"]["scope_nodes"]["Insert"])
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Renames a scope node or changes its venue; parent, code and kind are immutable (0301 guard). */
export async function updateScopeNode(
  db: XosClient,
  nodeId: string,
  patch: { readonly name?: string; readonly venueId?: string | null },
): Promise<Result<null>> {
  const update: Database["app"]["Tables"]["scope_nodes"]["Update"] = {};
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.venueId !== undefined) update.venue_id = patch.venueId;
  return writeOne(db.from("scope_nodes").update(update).eq("id", nodeId).select("id"));
}

/** Soft deletes a scope node with no live children. The engagement root is never removed. */
export async function removeScopeNode(
  db: XosClient,
  node: Pick<ScopeNode, "id" | "parentId">,
  children: number,
  now: Date = new Date(),
): Promise<Result<null>> {
  if (node.parentId === null) {
    return fail({
      kind: "refusal",
      rule: "scope_root_retained",
      message: "The engagement root stays.",
    });
  }
  if (children > 0) {
    return fail({
      kind: "refusal",
      rule: "scope_node_has_children",
      message: "Remove the nodes beneath it first.",
    });
  }
  return writeOne(
    db
      .from("scope_nodes")
      .update({ deleted_at: now.toISOString() })
      .eq("id", node.id)
      .select("id"),
  );
}

// Gates ------------------------------------------------------------------------------------------

/** The nine gated phases in gate order (Section 3.4), from canon. */
export async function listPhases(db: XosClient): Promise<Result<Phase[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("dim_phase")
    .select("phase_code, gate, phase, act_code, definition, gate_exit")
    .order("gate");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      code: r.phase_code,
      gate: r.gate,
      name: r.phase,
      actCode: r.act_code,
      definition: r.definition,
      gateExit: r.gate_exit,
    })),
  );
}

/** The 35 canon gate criteria in canon order (Bible tab 06). */
export async function listGateCriteria(db: XosClient): Promise<Result<GateCriterion[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("dim_gate_criterion")
    .select("criterion_id, gate, ordinal, statement, is_blocking")
    .order("ordinal");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.criterion_id,
      gate: r.gate,
      ordinal: r.ordinal,
      statement: r.statement,
      blocking: r.is_blocking,
    })),
  );
}

/** Assertion ranks 0 to 4 (Bible tab 22). */
export async function listAssertionRanks(db: XosClient): Promise<Result<AssertionRank[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("dim_assertion_rank")
    .select("rank, meaning")
    .order("rank", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(data.map((r) => ({ rank: r.rank, meaning: r.meaning })));
}

/** Gate readiness per criterion for the given projects, derived from the evidence spine. */
export async function listCriterionStatus(
  db: XosClient,
  projectIds: readonly string[],
): Promise<Result<CriterionStatus[]>> {
  if (projectIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("gate_criteria_status")
    .select("project_id, criterion_id, gate, is_blocking, evidence_count, best_assertion_rank, gate_passed")
    .in("project_id", [...projectIds]);
  if (error) return fail(toDataError(error));
  return ok(
    data.flatMap((r) =>
      r.project_id && r.criterion_id && r.gate !== null
        ? [
            {
              projectId: r.project_id,
              criterionId: r.criterion_id,
              gate: r.gate,
              blocking: r.is_blocking === true,
              evidenceCount: r.evidence_count ?? 0,
              bestRank: r.best_assertion_rank,
              gatePassed: r.gate_passed === true,
            },
          ]
        : [],
    ),
  );
}

/** Live (not withdrawn) evidence on a project, newest first. */
export async function listGateEvidence(
  db: XosClient,
  projectId: string,
): Promise<Result<GateEvidence[]>> {
  const { data, error } = await db
    .from("gate_evidence")
    .select(
      "id, criterion_id, evidence_uri, note, assertion_rank, attested_at, attester:people!gate_evidence_attested_by_fkey(full_name)",
    )
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("attested_at", { ascending: false });
  if (error) return fail(toDataError(error));
  const rows = data as unknown as {
    id: string;
    criterion_id: string;
    evidence_uri: string | null;
    note: string | null;
    assertion_rank: number;
    attested_at: string;
    attester: { full_name: string | null } | null;
  }[];
  return ok(
    rows.map((r) => ({
      id: r.id,
      criterionId: r.criterion_id,
      uri: r.evidence_uri,
      note: r.note,
      rank: r.assertion_rank,
      attestedBy: r.attester?.full_name ?? null,
      attestedAt: r.attested_at,
    })),
  );
}

export interface EvidenceInput {
  readonly projectId: string;
  readonly criterionId: string;
  readonly uri: string;
  readonly note?: string | null;
  readonly rank: number;
}

/** Attests evidence against a criterion; the database stamps who and when (0301 guard). */
export async function attestEvidence(
  db: XosClient,
  input: EvidenceInput,
): Promise<Result<{ id: string }>> {
  const note = input.note?.trim();
  const { data, error } = await db
    .from("gate_evidence")
    .insert({
      project_id: input.projectId,
      criterion_id: input.criterionId,
      evidence_uri: input.uri.trim(),
      note: note && note.length > 0 ? note : null,
      assertion_rank: input.rank,
    } as Database["app"]["Tables"]["gate_evidence"]["Insert"])
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Withdraws evidence; it stops counting toward its criterion and is never edited. */
export async function withdrawEvidence(
  db: XosClient,
  evidenceId: string,
  now: Date = new Date(),
): Promise<Result<null>> {
  return writeOne(
    db
      .from("gate_evidence")
      .update({ deleted_at: now.toISOString() })
      .eq("id", evidenceId)
      .select("id"),
  );
}

/**
 * Passes the gate that closes the expected phase (invariant 9). A missing blocking criterion comes
 * back as the `gate_criteria_unmet` refusal naming the criteria. Returns the phase afterwards.
 */
export async function passGate(
  db: XosClient,
  input: { readonly projectId: string; readonly expectedPhase: string; readonly reason: string },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("pass_gate", {
    p_project_id: input.projectId,
    p_expected_phase: input.expectedPhase,
    p_reason: input.reason.trim(),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

/** Gates the project has passed, in gate order. */
export async function listPhaseTransitions(
  db: XosClient,
  projectId: string,
): Promise<Result<PhaseTransition[]>> {
  const { data, error } = await db
    .from("project_phase_transitions")
    .select(
      "id, gate, from_phase_code, to_phase_code, reason, created_at, actor:people!project_phase_transitions_created_by_fkey(full_name)",
    )
    .eq("project_id", projectId)
    .order("gate");
  if (error) return fail(toDataError(error));
  const rows = data as unknown as {
    id: string;
    gate: number;
    from_phase_code: string;
    to_phase_code: string | null;
    reason: string;
    created_at: string;
    actor: { full_name: string | null } | null;
  }[];
  return ok(
    rows.map((r) => ({
      id: r.id,
      gate: r.gate,
      fromPhaseCode: r.from_phase_code,
      toPhaseCode: r.to_phase_code,
      reason: r.reason,
      actor: r.actor?.full_name ?? null,
      at: r.created_at,
    })),
  );
}

// Members ----------------------------------------------------------------------------------------

/** Current project members, by role then name. */
export async function listProjectMembers(
  db: XosClient,
  projectId: string,
  now: Date = new Date(),
): Promise<Result<ProjectMember[]>> {
  const at = now.toISOString();
  const { data, error } = await db
    .from("project_members")
    .select(
      "id, membership_id, project_role, valid_from, valid_to, membership:memberships!project_members_membership_id_fkey(person_id, person:people!memberships_person_id_fkey(full_name))",
    )
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .or(`valid_to.is.null,valid_to.gt.${at}`);
  if (error) return fail(toDataError(error));
  const rows = data as unknown as {
    id: string;
    membership_id: string;
    project_role: ProjectRole;
    valid_from: string;
    valid_to: string | null;
    membership: { person_id: string; person: { full_name: string | null } | null } | null;
  }[];
  const order = PROJECT_ROLE_ORDER;
  return ok(
    rows
      .map((r) => ({
        id: r.id,
        membershipId: r.membership_id,
        personId: r.membership?.person_id ?? null,
        fullName: r.membership?.person?.full_name ?? null,
        role: r.project_role,
        validFrom: r.valid_from,
        validTo: r.valid_to,
      }))
      .sort(
        (a, b) =>
          order.indexOf(a.role) - order.indexOf(b.role) ||
          (a.fullName ?? "").localeCompare(b.fullName ?? ""),
      ),
  );
}

/** Project roles in enum order, from the generated database constants. */
export const PROJECT_ROLE_ORDER: readonly ProjectRole[] = Constants.app.Enums.project_role;

/** Scope node kinds in enum order. */
export const SCOPE_KINDS: readonly ScopeKind[] = Constants.app.Enums.scope_kind;

/** Project states in enum order. */
export const PROJECT_STATES: readonly ProjectState[] = Constants.app.Enums.project_state;

/** Adds an org member to the project (projects.members.manage); nobody can add themselves. */
export async function addProjectMember(
  db: XosClient,
  input: { readonly projectId: string; readonly membershipId: string; readonly role: ProjectRole },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("project_members")
    .insert({
      project_id: input.projectId,
      membership_id: input.membershipId,
      project_role: input.role,
    } as Database["app"]["Tables"]["project_members"]["Insert"])
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Ends a project membership now; the row is kept as history. */
export async function endProjectMember(
  db: XosClient,
  projectMemberId: string,
  now: Date = new Date(),
): Promise<Result<null>> {
  return writeOne(
    db
      .from("project_members")
      .update({ valid_to: now.toISOString() })
      .eq("id", projectMemberId)
      .select("id"),
  );
}

// Reference lookups ------------------------------------------------------------------------------

/** Canon jurisdictions in canon order (Section 3.5: resolved per project at gate 1). */
export async function listJurisdictions(db: XosClient): Promise<Result<Jurisdiction[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("jurisdiction")
    .select("jurisdiction_id, level, parent, status")
    .order("ordinal");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.jurisdiction_id,
      level: r.level,
      parent: r.parent,
      populated: r.status === "populated",
    })),
  );
}

/** The six tiers of experience (Bible tab 07). */
export async function listTiers(db: XosClient): Promise<Result<CodeLabel[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("dim_tier")
    .select("tier_code, tier")
    .order("tier_code");
  if (error) return fail(toDataError(error));
  return ok(data.map((r) => ({ code: r.tier_code, label: r.tier })));
}

/** Cost regions (Bible tab 12). */
export async function listRegions(db: XosClient): Promise<Result<CodeLabel[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("dim_region")
    .select("region_code")
    .order("region_code");
  if (error) return fail(toDataError(error));
  return ok(data.map((r) => ({ code: r.region_code, label: r.region_code })));
}

/** Venues of the org the viewer may read. */
export async function listVenues(db: XosClient, orgId: string): Promise<Result<Venue[]>> {
  const { data, error } = await db
    .from("venues")
    .select("id, name, jurisdiction_id, time_zone")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      name: r.name,
      jurisdictionId: r.jurisdiction_id,
      timeZone: r.time_zone,
    })),
  );
}
