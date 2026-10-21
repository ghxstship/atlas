import type { Database, XosClient } from "./client.ts";
import { fillPersonNames } from "./person-names.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Work repository (Section 3.10, Section 4.2 Work): the record spine for all 26 record kinds, their
 * 1:1 kind extensions, the nine record states with their transition rules, the state ledger and
 * replan log, checklists, assignments, watchers and recurrence rules.
 *
 * Kinds, subtypes, states and transitions are read from canon (xpms) and from
 * app.lifecycle_transition_rules, never restated here (Section 3.15). Reads go through row level
 * security (invariant 2), so every function sees exactly what the signed-in person may see. Atlas
 * and Compass (A17) share these functions.
 */

// Canon --------------------------------------------------------------------------------------------

export interface RecordKindInfo {
  readonly kind: string;
  readonly recordClass: string;
  readonly titleGrammar: string;
  /** Kind-scoped subtypes in canon order (Bible tab 25). */
  readonly subtypes: readonly string[];
}

export interface RecordStateInfo {
  readonly state: string;
  readonly ordinal: number;
  readonly meaning: string;
}

export interface TransitionRule {
  readonly from: string;
  readonly to: string;
}

/** The 26 record kinds with their class, title grammar and subtypes, in kind order. */
export async function listRecordKinds(db: XosClient): Promise<Result<RecordKindInfo[]>> {
  const canon = db.schema("xpms");
  const [kinds, subtypes] = await Promise.all([
    canon.from("dim_record_kind").select("record_kind, record_class, title_grammar"),
    canon.from("dim_record_subtype").select("record_kind, record_subtype, ordinal"),
  ]);
  if (kinds.error) return fail(toDataError(kinds.error));
  if (subtypes.error) return fail(toDataError(subtypes.error));
  const byKind = new Map<string, { subtype: string; ordinal: number }[]>();
  for (const row of subtypes.data) {
    const list = byKind.get(row.record_kind) ?? [];
    list.push({ subtype: row.record_subtype, ordinal: row.ordinal });
    byKind.set(row.record_kind, list);
  }
  return ok(
    kinds.data
      .map((k) => ({
        kind: k.record_kind,
        recordClass: k.record_class,
        titleGrammar: k.title_grammar,
        subtypes: (byKind.get(k.record_kind) ?? [])
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((s) => s.subtype),
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind)),
  );
}

/** The nine record states in canon order (Bible tab 26). */
export async function listRecordStates(db: XosClient): Promise<Result<RecordStateInfo[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("dim_record_state")
    .select("record_state, ordinal, meaning");
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((s) => ({ state: s.record_state, ordinal: s.ordinal, meaning: s.meaning }))
      .sort((a, b) => a.ordinal - b.ordinal),
  );
}

/** Allowed record state moves (app.lifecycle_transition_rules, lifecycle `record`). */
export async function listRecordTransitions(db: XosClient): Promise<Result<TransitionRule[]>> {
  const { data, error } = await db
    .from("lifecycle_transition_rules")
    .select("from_state, to_state")
    .eq("lifecycle", "record");
  if (error) return fail(toDataError(error));
  return ok(
    data.flatMap((r) =>
      r.from_state && r.to_state ? [{ from: r.from_state, to: r.to_state }] : [],
    ),
  );
}

/** The states a record in `from` may move to, in canon state order. */
export function nextStates(
  rules: readonly TransitionRule[],
  states: readonly RecordStateInfo[],
  from: string,
): string[] {
  const allowed = new Set(rules.filter((r) => r.from === from).map((r) => r.to));
  return states.filter((s) => allowed.has(s.state)).map((s) => s.state);
}

/** Reasons a move needs beyond the transition reason: a blocker or a replan reason. */
export function transitionNeeds(next: string): "blocker" | "replan" | null {
  // The database checks enforce these two (records_blocked_names_blocker and
  // records_deferred_carries_reason); the UI asks for the field before calling the RPC.
  if (next === "Blocked") return "blocker";
  if (next === "Deferred") return "replan";
  return null;
}

// Projects ---------------------------------------------------------------------------------------

export interface ProjectRef {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly timeZone: string;
}

/** Projects the person may read, by key, for filters and pickers. */
export async function listProjectRefs(db: XosClient, orgId: string): Promise<Result<ProjectRef[]>> {
  const { data, error } = await db
    .from("projects")
    .select("id, project_key, name, time_zone")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .is("archived_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((p) => ({ id: p.id, key: p.project_key, name: p.name, timeZone: p.time_zone }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );
}

/** One project by its key, or not-found when it does not exist or is not readable. */
export async function getProjectRef(
  db: XosClient,
  orgId: string,
  projectKey: string,
): Promise<Result<ProjectRef>> {
  const { data, error } = await db
    .from("projects")
    .select("id, project_key, name, time_zone")
    .eq("org_id", orgId)
    .eq("project_key", projectKey)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok({ id: data.id, key: data.project_key, name: data.name, timeZone: data.time_zone });
}

export interface ScopeNodeRef {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
}

/** Scope nodes of a project, for the scope picker. */
export async function listScopeNodeRefs(
  db: XosClient,
  projectId: string,
): Promise<Result<ScopeNodeRef[]>> {
  const { data, error } = await db
    .from("scope_nodes")
    .select("id, project_id, name")
    .eq("project_id", projectId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((n) => ({ id: n.id, projectId: n.project_id, name: n.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

export interface PersonRef {
  readonly membershipId: string;
  readonly personId: string;
  readonly name: string | null;
}

/** Active members of the org the person may see, for owner and assignee pickers. */
export async function listPeopleRefs(
  db: XosClient,
  orgId: string,
  now: Date = new Date(),
): Promise<Result<PersonRef[]>> {
  const at = now.toISOString();
  const { data, error } = await db
    .from("memberships")
    .select("id, person_id, person:people!memberships_person_id_fkey(full_name)")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .lte("valid_from", at)
    .or(`valid_to.is.null,valid_to.gt.${at}`);
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((m) => ({
        membershipId: m.id,
        personId: m.person_id,
        name: m.person?.full_name ?? null,
      }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
  );
}

// Keys -----------------------------------------------------------------------------------------------

/** Splits a display key such as NWL-142 into its project key and number (Section 4.5.1). */
export function parseRecordKey(key: string): { projectKey: string; number: number } | null {
  const match = /^([A-Z]{2,5})-([1-9][0-9]{0,17})$/.exec(key.trim());
  if (!match?.[1] || !match[2]) return null;
  return { projectKey: match[1], number: Number(match[2]) };
}

export function formatRecordKey(projectKey: string, number: number): string {
  return `${projectKey}-${number}`;
}

// Records --------------------------------------------------------------------------------------------

export interface RecordSummary {
  readonly id: string;
  readonly key: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly projectTimeZone: string;
  readonly number: number;
  readonly kind: string;
  readonly subtype: string | null;
  readonly state: string;
  readonly title: string;
  readonly phaseCode: string | null;
  readonly urid: string | null;
  readonly xyz: string;
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  readonly accountableId: string | null;
  readonly scopeNodeId: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly dueAt: string | null;
  readonly timeZone: string | null;
  readonly blockerText: string | null;
  readonly replanReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

const RECORD_COLUMNS =
  "id, project_id, record_number, record_kind, record_subtype, record_state, title, phase_code, urid, xyz, owner_party_id, accountable_party_id, scope_node_id, starts_at, ends_at, due_at, time_zone, blocker_text, replan_reason, created_at, updated_at, deleted_at, project:projects!records_project_id_fkey!inner(project_key, name, time_zone), owner:people!records_owner_party_id_fkey(full_name)";

interface RecordRow {
  id: string;
  project_id: string;
  record_number: number;
  record_kind: string;
  record_subtype: string | null;
  record_state: string;
  title: string;
  phase_code: string | null;
  urid: string | null;
  xyz: string;
  owner_party_id: string | null;
  accountable_party_id: string | null;
  scope_node_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  due_at: string | null;
  time_zone: string | null;
  blocker_text: string | null;
  replan_reason: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  project: { project_key: string; name: string; time_zone: string } | null;
  owner: { full_name: string | null } | null;
}

export function toRecordSummary(row: RecordRow): RecordSummary {
  const projectKey = row.project?.project_key ?? "";
  return {
    id: row.id,
    key: formatRecordKey(projectKey, row.record_number),
    projectId: row.project_id,
    projectKey,
    projectName: row.project?.name ?? "",
    projectTimeZone: row.project?.time_zone ?? "UTC",
    number: row.record_number,
    kind: row.record_kind,
    subtype: row.record_subtype,
    state: row.record_state,
    title: row.title,
    phaseCode: row.phase_code,
    urid: row.urid,
    xyz: row.xyz,
    ownerId: row.owner_party_id,
    ownerName: row.owner?.full_name ?? null,
    accountableId: row.accountable_party_id,
    scopeNodeId: row.scope_node_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    dueAt: row.due_at,
    timeZone: row.time_zone,
    blockerText: row.blocker_text,
    replanReason: row.replan_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export type RecordSort = "key" | "title" | "next" | "updated" | "state";

export interface RecordQuery {
  readonly orgId: string;
  readonly projectId?: string;
  readonly kinds?: readonly string[];
  readonly states?: readonly string[];
  readonly ownerId?: string;
  readonly ids?: readonly string[];
  /** Case-insensitive match on the title. */
  readonly search?: string;
  /** Only records whose window, or due time, touches [from, to). */
  readonly from?: string;
  readonly to?: string;
  /** Only records with a start, end or due time. */
  readonly datedOnly?: boolean;
  /** Trash: only soft-deleted records. Otherwise soft-deleted records are left out. */
  readonly trashed?: boolean;
  readonly limit?: number;
}

/** PostgREST `or` filter for records whose window or due time touches [from, to). */
function windowFilter(from: string | undefined, to: string | undefined): string | null {
  if (!from && !to) return null;
  const lo = from ?? "-infinity";
  const hi = to ?? "infinity";
  return [
    `and(starts_at.lt.${hi},ends_at.gte.${lo})`,
    `and(starts_at.gte.${lo},starts_at.lt.${hi},ends_at.is.null)`,
    `and(due_at.gte.${lo},due_at.lt.${hi})`,
  ].join(",");
}

/** Records matching a query, newest number last within each project. */
export async function listRecords(
  db: XosClient,
  query: RecordQuery,
): Promise<Result<RecordSummary[]>> {
  let q = db.from("records").select(RECORD_COLUMNS).eq("org_id", query.orgId);
  if (query.projectId) q = q.eq("project_id", query.projectId);
  if (query.kinds && query.kinds.length > 0) q = q.in("record_kind", [...query.kinds]);
  if (query.states && query.states.length > 0) q = q.in("record_state", [...query.states]);
  if (query.ownerId) q = q.eq("owner_party_id", query.ownerId);
  if (query.ids) q = q.in("id", [...query.ids]);
  if (query.search && query.search.trim() !== "") {
    q = q.ilike("title", `%${query.search.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  }
  const window = windowFilter(query.from, query.to);
  if (window) q = q.or(window);
  if (query.datedOnly) q = q.or("starts_at.not.is.null,ends_at.not.is.null,due_at.not.is.null");
  q = query.trashed ? q.not("deleted_at", "is", null) : q.is("deleted_at", null);
  const { data, error } = await q
    .order("project_id")
    .order("record_number")
    .limit(query.limit ?? 500);
  if (error) return fail(toDataError(error));
  return ok(await namedOwners(db, (data as unknown as RecordRow[]).map(toRecordSummary)));
}

/** Owner names through the one name resolution (A59-011): an engaged owner is named. */
function namedOwners(db: XosClient, list: readonly RecordSummary[]): Promise<RecordSummary[]> {
  return fillPersonNames(
    db,
    list,
    (r) => r.ownerId,
    (r) => r.ownerName,
    (r, ownerName) => ({ ...r, ownerName }),
  );
}

async function namedOwner(db: XosClient, record: RecordSummary): Promise<RecordSummary> {
  return (await namedOwners(db, [record]))[0] ?? record;
}

/** The next date that matters for a record: its start while ahead, else its due or end time. */
export function nextDate(record: RecordSummary, now: Date = new Date()): string | null {
  const at = now.toISOString();
  if (record.startsAt && record.startsAt > at) return record.startsAt;
  return record.dueAt ?? record.endsAt ?? record.startsAt;
}

/** Sorts records for a list (Section 3.6: coded lists in numeric order by default). */
export function sortRecords(
  records: readonly RecordSummary[],
  sort: RecordSort,
  states: readonly RecordStateInfo[] = [],
): RecordSummary[] {
  const ordinal = new Map(states.map((s) => [s.state, s.ordinal]));
  const byKey = (a: RecordSummary, b: RecordSummary) =>
    a.projectKey.localeCompare(b.projectKey) || a.number - b.number;
  const copy = [...records];
  switch (sort) {
    case "title":
      return copy.sort((a, b) => a.title.localeCompare(b.title) || byKey(a, b));
    case "updated":
      return copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || byKey(a, b));
    case "state":
      return copy.sort(
        (a, b) => (ordinal.get(a.state) ?? 99) - (ordinal.get(b.state) ?? 99) || byKey(a, b),
      );
    case "next":
      return copy.sort((a, b) => {
        const x = nextDate(a);
        const y = nextDate(b);
        if (x === y) return byKey(a, b);
        if (x === null) return 1;
        if (y === null) return -1;
        return x.localeCompare(y);
      });
    default:
      return copy.sort(byKey);
  }
}

/** Groups records by a field, keeping the order of `order` and putting unknown values last. */
export function groupRecords<K extends "kind" | "state" | "projectKey">(
  records: readonly RecordSummary[],
  field: K,
  order: readonly string[] = [],
): { group: string; records: RecordSummary[] }[] {
  const groups = new Map<string, RecordSummary[]>();
  for (const value of order) groups.set(value, []);
  for (const r of records) {
    const value = r[field];
    groups.set(value, [...(groups.get(value) ?? []), r]);
  }
  return [...groups.entries()].map(([group, list]) => ({ group, records: list }));
}

/** One record by display key, including soft-deleted ones (Trash), or not-found. */
export async function getRecordByKey(
  db: XosClient,
  orgId: string,
  key: string,
): Promise<Result<RecordSummary>> {
  const parsed = parseRecordKey(key);
  if (!parsed) return fail({ kind: "not-found" });
  const { data, error } = await db
    .from("records")
    .select(RECORD_COLUMNS)
    .eq("org_id", orgId)
    .eq("record_number", parsed.number)
    .eq("project.project_key", parsed.projectKey)
    .is("project.deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(await namedOwner(db, toRecordSummary(data as unknown as RecordRow)));
}

/** One record by id, or not-found. */
export async function getRecord(db: XosClient, id: string): Promise<Result<RecordSummary>> {
  const { data, error } = await db
    .from("records")
    .select(RECORD_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(await namedOwner(db, toRecordSummary(data as unknown as RecordRow)));
}

export interface RecordInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly kind: string;
  readonly subtype?: string | null | undefined;
  readonly title: string;
  readonly scopeNodeId?: string | null | undefined;
  readonly phaseCode?: string | null | undefined;
  /** A URID category: the XYZ tag then follows the category (basis Category). */
  readonly urid?: string | null | undefined;
  /** Required without a URID category, or to differ from it (basis Declared). */
  readonly xyz?: string | null | undefined;
  readonly ownerId?: string | null | undefined;
  readonly accountableId?: string | null | undefined;
  readonly startsAt?: string | null | undefined;
  readonly endsAt?: string | null | undefined;
  readonly dueAt?: string | null | undefined;
  readonly timeZone?: string | null | undefined;
  /** The kind's attributes to write with the record, for kinds whose extension needs values. */
  readonly extension?: ExtensionValues | undefined;
}

/** The XYZ tag and its basis (Section 3.6) for a URID category's tag and a declared tag. */
export function resolveXyz(
  categoryXyz: string | null,
  declared: string | null | undefined,
): { xyz: string; basis: "Category" | "Declared" } | null {
  if (categoryXyz && (!declared || declared === categoryXyz)) {
    return { xyz: categoryXyz, basis: "Category" };
  }
  if (declared) return { xyz: declared, basis: "Declared" };
  return null;
}

async function categoryXyz(db: XosClient, urid: string | null | undefined) {
  if (!urid) return ok<string | null>(null);
  const { data, error } = await db
    .schema("xpms")
    .from("dim_category")
    .select("xyz")
    .eq("cat_urid", urid)
    .maybeSingle();
  if (error) return fail<string | null>(toDataError(error));
  return ok<string | null>(data?.xyz ?? null);
}

/**
 * Creates a record of any kind in Proposed with its kind's extension row. The database issues the
 * display number and validates the title grammar, refusing with a correction message.
 */
export async function createRecord(
  db: XosClient,
  input: RecordInput,
): Promise<Result<{ id: string; number: number }>> {
  const category = await categoryXyz(db, input.urid);
  if (!category.ok) return category;
  const tag = resolveXyz(category.data, input.xyz);
  if (!tag) {
    return fail({
      kind: "refusal",
      rule: "record_xyz_required",
      message: "Choose a URID category or declare the XYZ tag.",
    });
  }
  const { data, error } = await db
    .from("records")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      record_kind: input.kind,
      record_subtype: input.subtype ?? null,
      title: input.title.trim(),
      scope_node_id: input.scopeNodeId ?? null,
      phase_code: input.phaseCode ?? null,
      urid: input.urid ?? null,
      xyz: tag.xyz,
      xyz_basis: tag.basis,
      owner_party_id: input.ownerId ?? null,
      accountable_party_id: input.accountableId ?? null,
      starts_at: input.startsAt ?? null,
      ends_at: input.endsAt ?? null,
      due_at: input.dueAt ?? null,
      time_zone: input.timeZone ?? null,
    })
    .select("id, record_number")
    .single();
  if (error) return fail(toDataError(error));
  const extension = await saveRecordExtension(db, {
    orgId: input.orgId,
    recordId: data.id,
    kind: input.kind,
    fields: input.extension ?? {},
  });
  if (!extension.ok) return extension;
  return ok({ id: data.id, number: data.record_number });
}

export interface RecordPatch {
  readonly title?: string | undefined;
  readonly subtype?: string | null | undefined;
  readonly scopeNodeId?: string | null | undefined;
  readonly phaseCode?: string | null | undefined;
  readonly ownerId?: string | null | undefined;
  readonly accountableId?: string | null | undefined;
  readonly startsAt?: string | null | undefined;
  readonly endsAt?: string | null | undefined;
  readonly dueAt?: string | null | undefined;
  readonly timeZone?: string | null | undefined;
  /** Logged with the replan when the record is Scheduled or later (Section 3.10). */
  readonly replanReason?: string | null | undefined;
}

/** Edits a record. From Scheduled onward a date change is written to the replan log. */
export async function updateRecord(
  db: XosClient,
  id: string,
  patch: RecordPatch,
): Promise<Result<null>> {
  const row: Database["app"]["Tables"]["records"]["Update"] = {};
  if (patch.title !== undefined) row.title = patch.title.trim();
  if (patch.subtype !== undefined) row.record_subtype = patch.subtype;
  if (patch.scopeNodeId !== undefined) row.scope_node_id = patch.scopeNodeId;
  if (patch.phaseCode !== undefined) row.phase_code = patch.phaseCode;
  if (patch.ownerId !== undefined) row.owner_party_id = patch.ownerId;
  if (patch.accountableId !== undefined) row.accountable_party_id = patch.accountableId;
  if (patch.startsAt !== undefined) row.starts_at = patch.startsAt;
  if (patch.endsAt !== undefined) row.ends_at = patch.endsAt;
  if (patch.dueAt !== undefined) row.due_at = patch.dueAt;
  if (patch.timeZone !== undefined) row.time_zone = patch.timeZone;
  if (patch.replanReason !== undefined) row.replan_reason = patch.replanReason;
  if (Object.keys(row).length === 0) return ok(null);
  const { data, error } = await db.from("records").update(row).eq("id", id).select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export interface TransitionInput {
  readonly recordId: string;
  readonly expected: string;
  readonly next: string;
  readonly reason: string;
  readonly blockerText?: string | null | undefined;
  readonly replanReason?: string | null | undefined;
}

/** Moves a record to another state (app.transition_record, compare-and-set). */
export async function transitionRecord(
  db: XosClient,
  input: TransitionInput,
): Promise<Result<{ entryId: string }>> {
  const { data, error } = await db.rpc("transition_record", {
    p_record_id: input.recordId,
    p_expected: input.expected,
    p_next: input.next,
    p_reason: input.reason,
    ...(input.blockerText ? { p_blocker_text: input.blockerText } : {}),
    ...(input.replanReason ? { p_replan_reason: input.replanReason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ entryId: data });
}

/** Moves a record to Trash (soft delete). Canceled records are retained and refuse. */
export async function trashRecord(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("records")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/** Restores a record from Trash. */
export async function restoreRecord(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("records")
    .update({ deleted_at: null })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/**
 * Copies a record into a new Proposed record of the same project (journey 70): kind, subtype,
 * title, scope, phase, URID, XYZ tag, people, dates and the kind's attributes. With children, the
 * checklist is copied too, every item open.
 */
export async function duplicateRecord(
  db: XosClient,
  input: { readonly orgId: string; readonly recordId: string; readonly withChildren?: boolean },
): Promise<Result<{ id: string; number: number }>> {
  const source = await getRecord(db, input.recordId);
  if (!source.ok) return source;
  const r = source.data;
  const extension = await getRecordExtension(db, r.kind, r.id);
  if (!extension.ok) return extension;
  const created = await createRecord(db, {
    orgId: input.orgId,
    projectId: r.projectId,
    kind: r.kind,
    subtype: r.subtype,
    title: r.title,
    scopeNodeId: r.scopeNodeId,
    phaseCode: r.phaseCode,
    urid: r.urid,
    xyz: r.xyz,
    ownerId: r.ownerId,
    accountableId: r.accountableId,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    dueAt: r.dueAt,
    timeZone: r.timeZone,
    extension: extension.data,
  });
  if (!created.ok) return created;
  if (input.withChildren) {
    const items = await listChecklist(db, r.id);
    if (!items.ok) return items;
    for (const item of items.data) {
      const added = await addChecklistItem(db, {
        orgId: input.orgId,
        recordId: created.data.id,
        label: item.label,
      });
      if (!added.ok) return added;
    }
  }
  return created;
}

// Kind extensions ----------------------------------------------------------------------------------

/** The extension table of a kind: record_build for Build (Section 7.4, one table per kind). */
export function extensionTable(kind: string): string {
  return `record_${kind.toLowerCase().replace(/[^a-z]/g, "")}`;
}

/** Columns every extension row carries that are not the kind's own attributes. */
const EXTENSION_MACHINERY = new Set([
  "record_id",
  "org_id",
  "record_kind",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
  "deleted_at",
]);

export type ExtensionValues = Readonly<Record<string, string | number | boolean | null>>;

/** The kind's own attributes of a record, or an empty object when the row does not exist yet. */
export async function getRecordExtension(
  db: XosClient,
  kind: string,
  recordId: string,
): Promise<Result<ExtensionValues>> {
  const { data, error } = await untyped(db)
    .from(extensionTable(kind))
    .select("*")
    .eq("record_id", recordId)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  const values: Record<string, string | number | boolean | null> = {};
  for (const [column, value] of Object.entries(data ?? {})) {
    if (!EXTENSION_MACHINERY.has(column))
      values[column] = value as string | number | boolean | null;
  }
  return ok(values);
}

/** Writes the kind's own attributes of a record (insert on first save, update afterwards). */
export async function saveRecordExtension(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly recordId: string;
    readonly kind: string;
    readonly fields: ExtensionValues;
  },
): Promise<Result<null>> {
  const fields = Object.fromEntries(
    Object.entries(input.fields).filter(([c]) => !EXTENSION_MACHINERY.has(c) && c !== "score"),
  );
  const existing = await untyped(db)
    .from(extensionTable(input.kind))
    .select("record_id")
    .eq("record_id", input.recordId)
    .maybeSingle();
  if (existing.error) return fail(toDataError(existing.error));
  if (existing.data) {
    if (Object.keys(fields).length === 0) return ok(null);
    const { error } = await untyped(db)
      .from(extensionTable(input.kind))
      .update(fields)
      .eq("record_id", input.recordId);
    return error ? fail(toDataError(error)) : ok(null);
  }
  const { error } = await untyped(db)
    .from(extensionTable(input.kind))
    .insert({
      ...fields,
      record_id: input.recordId,
      org_id: input.orgId,
      record_kind: input.kind,
    });
  return error ? fail(toDataError(error)) : ok(null);
}

// History ----------------------------------------------------------------------------------------------

export interface StateEntry {
  readonly id: string;
  readonly from: string | null;
  readonly to: string;
  readonly reason: string;
  readonly at: string;
  readonly byName: string | null;
}

/** The record's state ledger, oldest first. */
export async function listStateHistory(
  db: XosClient,
  recordId: string,
): Promise<Result<StateEntry[]>> {
  const { data, error } = await db
    .from("record_state_transitions")
    .select(
      "id, from_state, to_state, reason, created_at, actor:people!record_state_transitions_created_by_fkey(full_name)",
    )
    .eq("record_id", recordId)
    .order("created_at");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((e) => ({
      id: e.id,
      from: e.from_state,
      to: e.to_state,
      reason: e.reason,
      at: e.created_at,
      byName: e.actor?.full_name ?? null,
    })),
  );
}

export interface ReplanEntry {
  readonly id: string;
  readonly fromState: string;
  readonly toState: string;
  readonly oldStartsAt: string | null;
  readonly newStartsAt: string | null;
  readonly oldEndsAt: string | null;
  readonly newEndsAt: string | null;
  readonly oldDueAt: string | null;
  readonly newDueAt: string | null;
  readonly reason: string | null;
  readonly at: string;
  readonly byName: string | null;
}

/** The record's replan log (Section 3.10), oldest first. */
export async function listReplans(db: XosClient, recordId: string): Promise<Result<ReplanEntry[]>> {
  const { data, error } = await db
    .from("record_replans")
    .select(
      "id, from_state, to_state, old_starts_at, new_starts_at, old_ends_at, new_ends_at, old_due_at, new_due_at, reason, created_at, actor:people!record_replans_created_by_fkey(full_name)",
    )
    .eq("record_id", recordId)
    .order("created_at");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((e) => ({
      id: e.id,
      fromState: e.from_state,
      toState: e.to_state,
      oldStartsAt: e.old_starts_at,
      newStartsAt: e.new_starts_at,
      oldEndsAt: e.old_ends_at,
      newEndsAt: e.new_ends_at,
      oldDueAt: e.old_due_at,
      newDueAt: e.new_due_at,
      reason: e.reason,
      at: e.created_at,
      byName: e.actor?.full_name ?? null,
    })),
  );
}

/** Whether a replan moved any date, and by how many milliseconds the end moved (positive is a slip). */
export function replanShift(entry: ReplanEntry): { moved: boolean; endShiftMs: number | null } {
  const moved =
    entry.oldStartsAt !== entry.newStartsAt ||
    entry.oldEndsAt !== entry.newEndsAt ||
    entry.oldDueAt !== entry.newDueAt;
  const before = entry.oldEndsAt ?? entry.oldDueAt;
  const after = entry.newEndsAt ?? entry.newDueAt;
  const endShiftMs = before && after ? Date.parse(after) - Date.parse(before) : null;
  return { moved, endShiftMs };
}

// Checklist --------------------------------------------------------------------------------------------

export interface ChecklistItem {
  readonly id: string;
  readonly position: number;
  readonly label: string;
  readonly checkedAt: string | null;
  readonly checkedByName: string | null;
}

export async function listChecklist(
  db: XosClient,
  recordId: string,
): Promise<Result<ChecklistItem[]>> {
  const { data, error } = await db
    .from("record_checklist_items")
    .select(
      "id, position, label, checked_at, checker:people!record_checklist_items_checked_by_fkey(full_name)",
    )
    .eq("record_id", recordId)
    .is("deleted_at", null)
    .order("position");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((i) => ({
      id: i.id,
      position: i.position,
      label: i.label,
      checkedAt: i.checked_at,
      checkedByName: i.checker?.full_name ?? null,
    })),
  );
}

/** Adds an item at the end of the checklist. */
export async function addChecklistItem(
  db: XosClient,
  input: { readonly orgId: string; readonly recordId: string; readonly label: string },
): Promise<Result<{ id: string }>> {
  const current = await listChecklist(db, input.recordId);
  if (!current.ok) return current;
  const position = Math.max(0, ...current.data.map((i) => i.position)) + 1;
  const { data, error } = await db
    .from("record_checklist_items")
    .insert({
      org_id: input.orgId,
      record_id: input.recordId,
      position,
      label: input.label.trim(),
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Ticks or clears an item; the database stamps who ticked it and when. */
export async function setChecklistItemChecked(
  db: XosClient,
  itemId: string,
  checked: boolean,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("record_checklist_items")
    .update({ checked_at: checked ? new Date().toISOString() : null })
    .eq("id", itemId)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export async function removeChecklistItem(db: XosClient, itemId: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("record_checklist_items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", itemId)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

// Assignments and watchers -----------------------------------------------------------------------------

export interface Assignment {
  readonly id: string;
  readonly membershipId: string;
  readonly name: string | null;
}

export async function listAssignments(
  db: XosClient,
  recordId: string,
): Promise<Result<Assignment[]>> {
  const { data, error } = await db
    .from("record_assignments")
    .select(
      "id, membership_id, membership:memberships!inner(person:people!memberships_person_id_fkey(full_name))",
    )
    .eq("record_id", recordId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as unknown as {
        id: string;
        membership_id: string;
        membership: { person: { full_name: string | null } | null } | null;
      }[]
    ).map((a) => ({
      id: a.id,
      membershipId: a.membership_id,
      name: a.membership?.person?.full_name ?? null,
    })),
  );
}

export async function assignRecord(
  db: XosClient,
  input: { readonly orgId: string; readonly recordId: string; readonly membershipId: string },
): Promise<Result<null>> {
  const { error } = await db.from("record_assignments").insert({
    org_id: input.orgId,
    record_id: input.recordId,
    membership_id: input.membershipId,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

export async function unassignRecord(db: XosClient, assignmentId: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("record_assignments")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", assignmentId)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/** The person's active watch on a record, if any. */
export async function getWatch(
  db: XosClient,
  recordId: string,
  personId: string,
): Promise<Result<{ id: string } | null>> {
  const { data, error } = await db
    .from("record_watchers")
    .select("id")
    .eq("record_id", recordId)
    .eq("person_id", personId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return ok(data ? { id: data.id } : null);
}

export async function watchRecord(
  db: XosClient,
  input: { readonly orgId: string; readonly recordId: string; readonly personId: string },
): Promise<Result<null>> {
  const { error } = await db.from("record_watchers").insert({
    org_id: input.orgId,
    record_id: input.recordId,
    person_id: input.personId,
  });
  if (error && error.code !== "23505") return fail(toDataError(error));
  return ok(null);
}

export async function unwatchRecord(db: XosClient, watchId: string): Promise<Result<null>> {
  const { error } = await db
    .from("record_watchers")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", watchId);
  return error ? fail(toDataError(error)) : ok(null);
}

// Recurrence -----------------------------------------------------------------------------------------

export interface Recurrence {
  readonly id: string;
  readonly recordId: string;
  readonly rrule: string;
  readonly timeZone: string;
  readonly untilAt: string | null;
}

/** Active recurrence rules for the given records, by record id. */
export async function listRecurrences(
  db: XosClient,
  recordIds: readonly string[],
): Promise<Result<Map<string, Recurrence>>> {
  if (recordIds.length === 0) return ok(new Map());
  const { data, error } = await db
    .from("record_recurrences")
    .select("id, record_id, rrule, time_zone, until_at")
    .in("record_id", [...recordIds])
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    new Map(
      data.map((r) => [
        r.record_id,
        {
          id: r.id,
          recordId: r.record_id,
          rrule: r.rrule,
          timeZone: r.time_zone,
          untilAt: r.until_at,
        },
      ]),
    ),
  );
}

/** Records with an active recurrence rule in the org, with the rule. */
export async function listRecurringRecords(
  db: XosClient,
  query: { readonly orgId: string; readonly projectId?: string },
): Promise<Result<{ record: RecordSummary; recurrence: Recurrence }[]>> {
  let q = db
    .from("record_recurrences")
    .select("id, record_id, rrule, time_zone, until_at")
    .eq("org_id", query.orgId)
    .is("deleted_at", null);
  q = q.limit(500);
  const { data, error } = await q;
  if (error) return fail(toDataError(error));
  if (data.length === 0) return ok([]);
  const records = await listRecords(db, {
    orgId: query.orgId,
    ids: data.map((r) => r.record_id),
    ...(query.projectId ? { projectId: query.projectId } : {}),
  });
  if (!records.ok) return records;
  const byId = new Map(records.data.map((r) => [r.id, r]));
  return ok(
    data.flatMap((r) => {
      const record = byId.get(r.record_id);
      return record
        ? [
            {
              record,
              recurrence: {
                id: r.id,
                recordId: r.record_id,
                rrule: r.rrule,
                timeZone: r.time_zone,
                untilAt: r.until_at,
              },
            },
          ]
        : [];
    }),
  );
}

/** Sets a record's recurrence rule, replacing the active one. */
export async function setRecurrence(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly recordId: string;
    readonly rrule: string;
    readonly timeZone: string;
    readonly untilAt?: string | null;
  },
): Promise<Result<null>> {
  const cleared = await clearRecurrence(db, input.recordId);
  if (!cleared.ok) return cleared;
  const { error } = await db.from("record_recurrences").insert({
    org_id: input.orgId,
    record_id: input.recordId,
    rrule: input.rrule,
    time_zone: input.timeZone,
    until_at: input.untilAt ?? null,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

export async function clearRecurrence(db: XosClient, recordId: string): Promise<Result<null>> {
  const { error } = await db
    .from("record_recurrences")
    .update({ deleted_at: new Date().toISOString() })
    .eq("record_id", recordId)
    .is("deleted_at", null);
  return error ? fail(toDataError(error)) : ok(null);
}

export type RecurrenceFrequency = "DAILY" | "WEEKLY" | "MONTHLY";

/** Builds an RFC 5545 rule from the choices the recurrence form offers. */
export function buildRrule(input: {
  readonly frequency: RecurrenceFrequency;
  readonly interval?: number;
  readonly byDay?: readonly string[];
  readonly count?: number;
}): string {
  const parts = [`FREQ=${input.frequency}`];
  if (input.interval && input.interval > 1) parts.push(`INTERVAL=${input.interval}`);
  if (input.frequency === "WEEKLY" && input.byDay && input.byDay.length > 0) {
    parts.push(`BYDAY=${input.byDay.join(",")}`);
  }
  if (input.count && input.count > 0) parts.push(`COUNT=${input.count}`);
  return parts.join(";");
}

/** Reads back the parts of a rule this module writes; other rules come back as null. */
export function parseRrule(rrule: string): {
  frequency: RecurrenceFrequency;
  interval: number;
  byDay: string[];
  count: number | null;
} | null {
  const fields = new Map(
    rrule.split(";").map((p) => {
      const [k, v] = p.split("=");
      return [k ?? "", v ?? ""] as const;
    }),
  );
  const frequency = fields.get("FREQ");
  if (frequency !== "DAILY" && frequency !== "WEEKLY" && frequency !== "MONTHLY") return null;
  const count = fields.get("COUNT");
  return {
    frequency,
    interval: Number(fields.get("INTERVAL") ?? "1") || 1,
    byDay: (fields.get("BYDAY") ?? "").split(",").filter((d) => d !== ""),
    count: count ? Number(count) : null,
  };
}

/** The next occurrences of a rule from its first start, at most `limit`, never past `until`. */
export function occurrences(
  firstStart: string,
  rrule: string,
  limit: number,
  until: string | null = null,
): string[] {
  const rule = parseRrule(rrule);
  if (!rule) return [];
  const out: string[] = [];
  const start = new Date(firstStart);
  const max = rule.count ?? Number.POSITIVE_INFINITY;
  const stop = until ? Date.parse(until) : Number.POSITIVE_INFINITY;
  const days = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const cursor = new Date(start);
  let produced = 0;
  for (let guard = 0; guard < 3660 && out.length < limit && produced < max; guard += 1) {
    if (cursor.getTime() > stop) break;
    const weekdayOk =
      rule.frequency !== "WEEKLY" ||
      rule.byDay.length === 0 ||
      rule.byDay.includes(days[cursor.getUTCDay()] ?? "");
    if (weekdayOk) {
      out.push(cursor.toISOString());
      produced += 1;
    }
    if (rule.frequency === "DAILY") cursor.setUTCDate(cursor.getUTCDate() + rule.interval);
    else if (rule.frequency === "MONTHLY") cursor.setUTCMonth(cursor.getUTCMonth() + rule.interval);
    else if (rule.byDay.length === 0) cursor.setUTCDate(cursor.getUTCDate() + 7 * rule.interval);
    else {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (cursor.getUTCDay() === start.getUTCDay() && rule.interval > 1) {
        cursor.setUTCDate(cursor.getUTCDate() + 7 * (rule.interval - 1));
      }
    }
  }
  return out;
}

// Canon pickers -----------------------------------------------------------------------------------------

export interface CanonOption {
  readonly value: string;
  readonly label: string;
  readonly code?: string;
}

/** Gated phases in gate order, for the phase picker (Section 3.4). */
export async function listPhaseOptions(
  db: XosClient,
): Promise<Result<(CanonOption & { gate: number })[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("dim_phase")
    .select("phase_code, gate, phase");
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((p) => ({ value: p.phase_code, label: p.phase, code: p.phase_code, gate: p.gate }))
      .sort((a, b) => a.gate - b.gate),
  );
}

/** The XYZ tags canon categories carry, plus Z (Timeline), in letter order (Section 3.6). */
export async function listXyzTags(db: XosClient): Promise<Result<string[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("dim_category")
    .select("xyz")
    .not("xyz", "is", null);
  if (error) return fail(toDataError(error));
  const tags = new Set(data.flatMap((c) => (c.xyz ? [c.xyz] : [])));
  return ok([...tags].sort());
}

/** URID categories matching a search, in numeric order (Section 3.6), for the URID picker. */
export async function searchCategories(
  db: XosClient,
  search: string,
  limit = 25,
): Promise<Result<CanonOption[]>> {
  let q = db.schema("xpms").from("dim_category").select("cat_urid, category");
  const term = search.trim();
  if (term !== "") {
    q = /^[0-9.]+$/.test(term)
      ? q.like("cat_urid", `${term}%`)
      : q.ilike("category", `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  }
  const { data, error } = await q.order("cat_urid").limit(limit);
  if (error) return fail(toDataError(error));
  return ok(data.map((c) => ({ value: c.cat_urid, label: c.category, code: c.cat_urid })));
}

/** Canon roles in code order, for Shift and Recruitment records. */
export async function listRoleOptions(db: XosClient): Promise<Result<CanonOption[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("role")
    .select("role_code, job_title")
    .order("role_code");
  if (error) return fail(toDataError(error));
  return ok(data.map((r) => ({ value: r.role_code, label: r.job_title, code: r.role_code })));
}

/** Values of one canon enumeration domain in sort order, for example Inspection Result. */
export async function listEnumerationOptions(
  db: XosClient,
  domain: string,
): Promise<Result<CanonOption[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("std_enumeration")
    .select("record_id, enum_label, enum_code, sort_order")
    .eq("enum_domain", domain);
  if (error) return fail(toDataError(error));
  return ok(
    data
      .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
      .map((e) => ({ value: e.record_id, label: e.enum_label ?? e.enum_code ?? e.record_id })),
  );
}

/** Permit rules in canon order, for Permit records. */
export async function listPermitRuleOptions(db: XosClient): Promise<Result<CanonOption[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("dim_permit_rule")
    .select("rule, permit, ordinal");
  if (error) return fail(toDataError(error));
  return ok(
    data
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((r) => ({ value: r.rule, label: r.permit, code: r.rule })),
  );
}

/** Controlled unit aliases in name order, for quantities. */
export async function listUnitOptions(db: XosClient): Promise<Result<CanonOption[]>> {
  const { data, error } = await db.schema("xpms").from("dim_unit_alias").select("alias, unit_code");
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((u) => ({ value: u.alias, label: u.alias, code: u.unit_code }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );
}

/** The org's counterparties by name, for Booking, Contract and Payment records. */
export async function listCounterpartyOptions(
  db: XosClient,
  orgId: string,
): Promise<Result<CanonOption[]>> {
  const { data, error } = await db
    .from("counterparties")
    .select("id, organization:organizations!counterparties_organization_id_fkey(name)")
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    (data as unknown as { id: string; organization: { name: string } | null }[])
      .map((c) => ({ value: c.id, label: c.organization?.name ?? c.id }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );
}

/** The org's venues by name, for Event records. */
export async function listVenueOptions(
  db: XosClient,
  orgId: string,
): Promise<Result<CanonOption[]>> {
  const { data, error } = await db
    .from("venues")
    .select("id, name")
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((v) => ({ value: v.id, label: v.name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );
}

/** ISO 4217 currencies with their minor unit exponent, for money in minor units. */
export async function listCurrencyOptions(
  db: XosClient,
): Promise<Result<{ code: string; exponent: number }[]>> {
  const { data, error } = await db.from("currencies").select("currency_code, minor_unit_exponent");
  if (error) return fail(toDataError(error));
  return ok(
    data
      .flatMap((c) =>
        c.currency_code ? [{ code: c.currency_code, exponent: c.minor_unit_exponent ?? 2 }] : [],
      )
      .sort((a, b) => a.code.localeCompare(b.code)),
  );
}
