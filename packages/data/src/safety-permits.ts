import type { XosClient } from "./client.ts";
import { callRpc, derivedOrg, writeResult } from "./places.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Safety repository for the permit engine and inspections (Section 4.2 Safety, Section 7.4 Safety,
 * Section 3.7). Permit requirements come only from app.generate_permit_requirements, which reads the
 * canon permit rules (Bible tab 15) of the project's jurisdiction chain; this module never invents a
 * rule, a lead time or an authority. A requirement is tracked by a Permit record whose state follows
 * the record lifecycle (app.transition_record). Inspections run from org templates; results are canon
 * Inspection Result rows and freeze at sign-off, which the database gives only to someone other than
 * the inspector holding safety.inspection.sign_off.
 */

// Canon ------------------------------------------------------------------------------------------

export interface PermitRule {
  readonly rule: string;
  readonly ordinal: number;
  readonly triggerType: string;
  readonly condition: string;
  readonly permit: string;
  readonly authority: string;
  /** Lead time exactly as canon states it, for example "4-8 wks". */
  readonly leadTime: string;
  readonly jurisdictionId: string;
}

/** Canon permit rules in canon order, optionally for a set of jurisdictions. */
export async function listPermitRules(
  db: XosClient,
  jurisdictionIds?: readonly string[],
): Promise<Result<PermitRule[]>> {
  let query = db
    .schema("xpms")
    .from("dim_permit_rule")
    .select("rule, ordinal, trigger_type, condition, permit, ahj, lead_time, jurisdiction_id");
  if (jurisdictionIds) query = query.in("jurisdiction_id", [...jurisdictionIds]);
  const { data, error } = await query.order("ordinal");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      rule: r.rule,
      ordinal: r.ordinal,
      triggerType: r.trigger_type,
      condition: r.condition,
      permit: r.permit,
      authority: r.ahj,
      leadTime: r.lead_time,
      jurisdictionId: r.jurisdiction_id,
    })),
  );
}

export interface CanonEnumValue {
  /** The canon row id stored on the referencing column, for example ENM-084. */
  readonly id: string;
  /** Stable canon code; display labels are catalog keys built from it. */
  readonly code: string;
  readonly isDefault: boolean;
}

/** The canon Inspection Result enumeration in canon order. */
export async function listInspectionResultValues(db: XosClient): Promise<Result<CanonEnumValue[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("std_enumeration")
    .select("record_id, enum_code, is_default")
    .eq("enum_domain", "Inspection Result")
    .order("sort_order");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((e) => ({
      id: e.record_id,
      code: e.enum_code ?? "",
      isDefault: e.is_default ?? false,
    })),
  );
}

/** The nine record states in canon order (Bible tab 26). */
export async function listRecordStates(db: XosClient): Promise<Result<string[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("dim_record_state")
    .select("record_state")
    .order("ordinal");
  if (error) return fail(toDataError(error));
  return ok(data.map((s) => s.record_state));
}

/** Allowed record state moves, from the one transition rule table, as from state to next states. */
export async function listRecordTransitions(
  db: XosClient,
): Promise<Result<ReadonlyMap<string, readonly string[]>>> {
  const { data, error } = await db
    .from("lifecycle_transition_rules")
    .select("from_state, to_state")
    .eq("lifecycle", "record");
  if (error) return fail(toDataError(error));
  const moves = new Map<string, string[]>();
  for (const row of data) {
    if (row.from_state === null || row.to_state === null) continue;
    moves.set(row.from_state, [...(moves.get(row.from_state) ?? []), row.to_state]);
  }
  return ok(moves);
}

// Permit readiness ---------------------------------------------------------------------------------

/**
 * Whether the permit engine can answer for a project (Section 3.7): an unresolved jurisdiction and a
 * declared but unpopulated one both answer NO_ANSWER.
 */
export type PermitReadiness =
  | { readonly kind: "ready"; readonly jurisdictionId: string; readonly chain: readonly string[] }
  | { readonly kind: "unresolved" }
  | { readonly kind: "unpopulated"; readonly jurisdictionId: string };

export async function getPermitReadiness(
  db: XosClient,
  projectId: string,
): Promise<Result<PermitReadiness>> {
  const project = await db
    .from("projects")
    .select("jurisdiction_id")
    .eq("id", projectId)
    .maybeSingle();
  if (project.error) return fail(toDataError(project.error));
  if (!project.data) return fail({ kind: "not-found" });
  const jurisdictionId = project.data.jurisdiction_id;
  if (jurisdictionId === null) return ok({ kind: "unresolved" });
  const all = await db
    .schema("xpms")
    .from("jurisdiction")
    .select("jurisdiction_id, parent, status");
  if (all.error) return fail(toDataError(all.error));
  const byId = new Map(all.data.map((j) => [j.jurisdiction_id, j]));
  const own = byId.get(jurisdictionId);
  if (!own || own.status !== "populated") return ok({ kind: "unpopulated", jurisdictionId });
  const chain: string[] = [];
  for (let at: string | null = jurisdictionId; at !== null; at = byId.get(at)?.parent ?? null) {
    if (chain.includes(at)) break;
    chain.push(at);
  }
  return ok({ kind: "ready", jurisdictionId, chain });
}

// Permit requirements -------------------------------------------------------------------------------

export interface PermitRecord {
  readonly id: string;
  readonly displayKey: string;
  readonly title: string;
  readonly state: string;
  readonly permitIdentifier: string | null;
  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
  readonly blocker: string | null;
}

export interface PermitRequirement {
  readonly id: string;
  readonly projectId: string;
  readonly rule: string;
  readonly createdAt: string;
  readonly record: PermitRecord | null;
}

/** Generates a project's permit requirements from canon; returns the number added. */
export async function generatePermitRequirements(
  db: XosClient,
  projectId: string,
): Promise<Result<{ added: number }>> {
  const { data, error } = await db.rpc("generate_permit_requirements", { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  return ok({ added: data });
}

/** Opens the Permit record that tracks a requirement (app.track_permit_requirement). */
export async function trackPermitRequirement(
  db: XosClient,
  requirementId: string,
  title?: string | null,
): Promise<Result<{ recordId: string }>> {
  const result = await callRpc<string>(db, "track_permit_requirement", {
    p_requirement_id: requirementId,
    p_title: title ?? null,
  });
  return result.ok ? ok({ recordId: result.data }) : result;
}

interface RecordRow {
  id: string;
  title: string;
  record_state: string;
  blocker_text: string | null;
  display_key: string | null;
}

async function loadPermitRecords(
  db: XosClient,
  ids: readonly string[],
): Promise<Result<Map<string, PermitRecord>>> {
  if (ids.length === 0) return ok(new Map());
  const records = await db
    .from("records")
    .select("id, title, record_state, blocker_text, display_key:record_display_key")
    .in("id", [...ids]);
  if (records.error) return fail(toDataError(records.error));
  const permits = await db
    .from("record_permit")
    .select("record_id, permit_identifier, issued_at, expires_at")
    .in("record_id", [...ids]);
  if (permits.error) return fail(toDataError(permits.error));
  const details = new Map(permits.data.map((p) => [p.record_id, p]));
  const map = new Map<string, PermitRecord>();
  for (const r of records.data as unknown as RecordRow[]) {
    const d = details.get(r.id);
    map.set(r.id, {
      id: r.id,
      displayKey: r.display_key ?? "",
      title: r.title,
      state: r.record_state,
      permitIdentifier: d?.permit_identifier ?? null,
      issuedAt: d?.issued_at ?? null,
      expiresAt: d?.expires_at ?? null,
      blocker: r.blocker_text,
    });
  }
  return ok(map);
}

/** Live permit requirements of the org's projects (or one project), with their Permit records. */
export async function listPermitRequirements(
  db: XosClient,
  filter: { readonly orgId: string; readonly projectId?: string },
): Promise<Result<PermitRequirement[]>> {
  let query = db
    .from("permit_requirements")
    .select("id, project_id, permit_rule, record_id, created_at")
    .eq("org_id", filter.orgId)
    .is("deleted_at", null);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  const { data, error } = await query.order("created_at");
  if (error) return fail(toDataError(error));
  const records = await loadPermitRecords(
    db,
    data.flatMap((r) => (r.record_id ? [r.record_id] : [])),
  );
  if (!records.ok) return records;
  return ok(
    data.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      rule: r.permit_rule,
      createdAt: r.created_at,
      record: r.record_id ? (records.data.get(r.record_id) ?? null) : null,
    })),
  );
}

export interface PermitDetails {
  readonly permitIdentifier: string | null;
  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
}

/** Records the authority's permit number and validity on the Permit record. */
export async function updatePermitDetails(
  db: XosClient,
  recordId: string,
  details: PermitDetails,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("record_permit")
    .update({
      permit_identifier: details.permitIdentifier?.trim() || null,
      issued_at: details.issuedAt,
      expires_at: details.expiresAt,
    })
    .eq("record_id", recordId)
    .select("record_id");
  return writeResult(data?.map((d) => ({ id: d.record_id })) ?? null, error);
}

export interface RecordTransition {
  readonly recordId: string;
  readonly expected: string;
  readonly next: string;
  readonly reason: string;
  readonly blocker?: string | null;
  readonly replanReason?: string | null;
}

/** Moves a record with compare-and-set on its expected state (app.transition_record). */
export async function transitionRecord(
  db: XosClient,
  input: RecordTransition,
): Promise<Result<{ entryId: string }>> {
  const { data, error } = await db.rpc("transition_record", {
    p_record_id: input.recordId,
    p_expected: input.expected,
    p_next: input.next,
    p_reason: input.reason,
    ...(input.blocker ? { p_blocker_text: input.blocker } : {}),
    ...(input.replanReason ? { p_replan_reason: input.replanReason } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ entryId: data });
}

// Inspection templates --------------------------------------------------------------------------------

export interface InspectionItem {
  readonly id: string;
  readonly position: number;
  readonly prompt: string;
  /** A failure stops use. */
  readonly critical: boolean;
}

export interface InspectionTemplate {
  readonly id: string;
  readonly name: string;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
  readonly items: readonly InspectionItem[];
}

interface TemplateRow {
  id: string;
  name: string;
  deleted_at: string | null;
  updated_at: string;
  inspection_items: {
    id: string;
    position: number;
    prompt: string;
    is_critical: boolean;
    deleted_at: string | null;
  }[];
}

function toTemplate(row: TemplateRow): InspectionTemplate {
  return {
    id: row.id,
    name: row.name,
    archivedAt: row.deleted_at,
    updatedAt: row.updated_at,
    items: row.inspection_items
      .filter((i) => i.deleted_at === null)
      .map((i) => ({ id: i.id, position: i.position, prompt: i.prompt, critical: i.is_critical }))
      .sort((a, b) => a.position - b.position),
  };
}

const TEMPLATE_COLUMNS =
  "id, name, deleted_at, updated_at, inspection_items(id, position, prompt, is_critical, deleted_at)";

export async function listInspectionTemplates(
  db: XosClient,
  orgId: string,
  archive: "live" | "archived" | "all" = "live",
): Promise<Result<InspectionTemplate[]>> {
  let query = db.from("inspection_templates").select(TEMPLATE_COLUMNS).eq("org_id", orgId);
  if (archive === "live") query = query.is("deleted_at", null);
  if (archive === "archived") query = query.not("deleted_at", "is", null);
  const { data, error } = await query.order("name");
  if (error) return fail(toDataError(error));
  return ok((data as unknown as TemplateRow[]).map(toTemplate));
}

export async function createInspectionTemplate(
  db: XosClient,
  orgId: string,
  name: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("inspection_templates")
    .insert({ org_id: orgId, name: name.trim() })
    .select("id");
  return writeResult(data, error);
}

export async function renameInspectionTemplate(
  db: XosClient,
  id: string,
  name: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("inspection_templates")
    .update({ name: name.trim() })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

/** The safety tables that archive and restore through deleted_at. */
export type SafetyTable = "inspection_templates" | "inspection_items" | "inspections";

export async function setSafetyArchived(
  db: XosClient,
  table: SafetyTable,
  id: string,
  archived: boolean,
  now: Date = new Date(),
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from(table)
    .update({ deleted_at: archived ? now.toISOString() : null })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

/** Appends an item at the end of a template. */
export async function addInspectionItem(
  db: XosClient,
  input: {
    readonly templateId: string;
    readonly prompt: string;
    readonly critical: boolean;
    readonly position: number;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("inspection_items")
    .insert(
      derivedOrg<"inspection_items">({
        inspection_template_id: input.templateId,
        position: input.position,
        prompt: input.prompt.trim(),
        is_critical: input.critical,
      }),
    )
    .select("id");
  return writeResult(data, error);
}

export async function updateInspectionItem(
  db: XosClient,
  id: string,
  input: { readonly prompt: string; readonly critical: boolean },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("inspection_items")
    .update({ prompt: input.prompt.trim(), is_critical: input.critical })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

/**
 * Swaps the positions of two items of one template: the keyboard path for reordering (Section
 * 11.7). Positions are unique per template, so one item parks on a free position first.
 */
export async function swapInspectionItems(
  db: XosClient,
  a: Pick<InspectionItem, "id" | "position">,
  b: Pick<InspectionItem, "id" | "position">,
  parking: number,
): Promise<Result<null>> {
  const steps: [string, number][] = [
    [a.id, parking],
    [b.id, a.position],
    [a.id, b.position],
  ];
  for (const [id, position] of steps) {
    const { data, error } = await db
      .from("inspection_items")
      .update({ position })
      .eq("id", id)
      .select("id");
    const result = writeResult(data, error);
    if (!result.ok) return result;
  }
  return ok(null);
}

// Inspections ------------------------------------------------------------------------------------------

export interface InspectionResultEntry {
  readonly id: string;
  readonly itemId: string;
  readonly resultEnumId: string;
  readonly note: string | null;
}

export interface Inspection {
  readonly id: string;
  readonly projectId: string;
  readonly templateId: string;
  readonly recordId: string | null;
  readonly inspectorId: string | null;
  readonly inspectedAt: string;
  readonly signedOffBy: string | null;
  readonly signedOffAt: string | null;
  readonly archivedAt: string | null;
  readonly results: readonly InspectionResultEntry[];
}

/** Derived progress of an inspection; never stored (Section 3.15 rule 2). */
export type InspectionProgress =
  "not-started" | "in-progress" | "ready-for-sign-off" | "signed-off";

export function inspectionProgress(
  inspection: Pick<Inspection, "signedOffAt" | "results">,
  itemCount: number,
): InspectionProgress {
  if (inspection.signedOffAt !== null) return "signed-off";
  if (inspection.results.length === 0) return "not-started";
  return inspection.results.length >= itemCount ? "ready-for-sign-off" : "in-progress";
}

interface InspectionRow {
  id: string;
  project_id: string;
  inspection_template_id: string;
  record_id: string | null;
  inspector_person_id: string | null;
  inspected_at: string;
  signed_off_by: string | null;
  signed_off_at: string | null;
  deleted_at: string | null;
  inspection_results: {
    id: string;
    inspection_item_id: string;
    result_enum_id: string;
    note: string | null;
    deleted_at: string | null;
  }[];
}

function toInspection(row: InspectionRow): Inspection {
  return {
    id: row.id,
    projectId: row.project_id,
    templateId: row.inspection_template_id,
    recordId: row.record_id,
    inspectorId: row.inspector_person_id,
    inspectedAt: row.inspected_at,
    signedOffBy: row.signed_off_by,
    signedOffAt: row.signed_off_at,
    archivedAt: row.deleted_at,
    results: row.inspection_results
      .filter((r) => r.deleted_at === null)
      .map((r) => ({
        id: r.id,
        itemId: r.inspection_item_id,
        resultEnumId: r.result_enum_id,
        note: r.note,
      })),
  };
}

const INSPECTION_COLUMNS =
  "id, project_id, inspection_template_id, record_id, inspector_person_id, inspected_at, signed_off_by, signed_off_at, deleted_at, inspection_results(id, inspection_item_id, result_enum_id, note, deleted_at)";

export async function listInspections(
  db: XosClient,
  filter: {
    readonly orgId: string;
    readonly projectId?: string;
    readonly archive?: "live" | "archived" | "all";
  },
): Promise<Result<Inspection[]>> {
  let query = db.from("inspections").select(INSPECTION_COLUMNS).eq("org_id", filter.orgId);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  const archive = filter.archive ?? "live";
  if (archive === "live") query = query.is("deleted_at", null);
  if (archive === "archived") query = query.not("deleted_at", "is", null);
  const { data, error } = await query.order("inspected_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok((data as unknown as InspectionRow[]).map(toInspection));
}

/** Starts an inspection from a template (app.start_inspection); the inspector is the session person. */
export async function createInspection(
  db: XosClient,
  input: { readonly projectId: string; readonly templateId: string; readonly inspectedAt: string },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("start_inspection", {
    p_project_id: input.projectId,
    p_template_id: input.templateId,
    p_inspected_at: input.inspectedAt,
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/**
 * Records one item's result through app.record_inspection_result. A Failed result opens its punch
 * item in the same transaction (journey 17). The database refuses a result on a signed-off inspection
 * (inspection_signed_off), an item of another template and a value outside the canon enumeration.
 */
export async function recordInspectionResult(
  db: XosClient,
  input: {
    readonly inspectionId: string;
    readonly itemId: string;
    readonly resultEnumId: string;
    readonly note: string | null;
    readonly photoUri?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("record_inspection_result", {
    p_inspection_id: input.inspectionId,
    p_item_id: input.itemId,
    p_result_enum_id: input.resultEnumId,
    ...(input.note?.trim() ? { p_note: input.note.trim() } : {}),
    ...(input.photoUri ? { p_photo_uri: input.photoUri } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** Signs off an inspection (app.sign_off_inspection); the database refuses the inspector. */
export async function signOffInspection(
  db: XosClient,
  id: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("sign_off_inspection", { p_inspection_id: id });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/**
 * The punch items failed results opened (journey 17), keyed by inspection result, with the display
 * key of each item's Task record. Punch items are A08's (app.punch_items, 0410); this only reads them.
 */
export async function listPunchItemsForResults(
  db: XosClient,
  resultIds: readonly string[],
): Promise<Result<ReadonlyMap<string, { recordId: string; displayKey: string }>>> {
  if (resultIds.length === 0) return ok(new Map());
  const items = await db
    .from("punch_items")
    .select("inspection_result_id, record_id")
    .in("inspection_result_id", [...resultIds])
    .is("deleted_at", null);
  if (items.error) return fail(toDataError(items.error));
  const recordIds = items.data.map((i) => i.record_id);
  const records =
    recordIds.length === 0
      ? { data: [] as { id: string; display_key: string | null }[], error: null }
      : await db.from("records").select("id, display_key:record_display_key").in("id", recordIds);
  if (records.error) return fail(toDataError(records.error));
  const keys = new Map(
    (records.data as unknown as { id: string; display_key: string | null }[]).map((r) => [
      r.id,
      r.display_key ?? "",
    ]),
  );
  return ok(
    new Map(
      items.data.flatMap((i) =>
        i.inspection_result_id
          ? [
              [
                i.inspection_result_id,
                { recordId: i.record_id, displayKey: keys.get(i.record_id) ?? "" },
              ] as const,
            ]
          : [],
      ),
    ),
  );
}

// People names ---------------------------------------------------------------------------------------------

/** Display names of people by id, for inspector and sign-off columns; unknown ids are omitted. */
export async function listPeopleNames(
  db: XosClient,
  ids: readonly string[],
): Promise<Result<ReadonlyMap<string, string>>> {
  if (ids.length === 0) return ok(new Map());
  const { data, error } = await db
    .from("people")
    .select("id, full_name")
    .in("id", [...new Set(ids)]);
  if (error) return fail(toDataError(error));
  return ok(new Map(data.flatMap((p) => (p.full_name ? [[p.id, p.full_name] as const] : []))));
}
