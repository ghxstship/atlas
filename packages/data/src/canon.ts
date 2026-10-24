import type { Database, XosClient } from "./client.ts";
import { insertedId, readRows, rpcValue, touched } from "./commercial-common.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Canon browser repository (Section 4.2 Canon, Section 7.2): read-only reads of the xpms canon
 * (departments, disciplines, categories, elements, phases and gates, record kinds, roles,
 * jurisdictions and permit rules, metrics) and the org's canon extension proposals (migration 0490).
 * Nothing here writes xpms; an org extends canon only through proposals in the .50 to .99 range.
 */

const canon = (db: XosClient) => db.schema("xpms");

export interface Department {
  readonly code: string;
  readonly name: string;
  readonly coreFunction: string | null;
  readonly scope: string | null;
  readonly disciplineCount: number;
}

export async function listDepartments(db: XosClient): Promise<Result<Department[]>> {
  return readRows(
    canon(db)
      .from("dim_department")
      .select("dept_code, department, core_function, scope, dim_discipline(disc_code)")
      .order("dept_code"),
    (row) => ({
      code: row.dept_code,
      name: row.department,
      coreFunction: row.core_function,
      scope: row.scope,
      disciplineCount: (row.dim_discipline ?? []).length,
    }),
  );
}

export interface Discipline {
  readonly code: string;
  readonly departmentCode: string;
  readonly name: string;
  readonly source: string;
  readonly isExtension: boolean;
  readonly categoryCount: number;
}

export async function listDisciplines(db: XosClient): Promise<Result<Discipline[]>> {
  return readRows(
    canon(db)
      .from("dim_discipline")
      .select("disc_code, dept_code, discipline, source, is_extension, dim_category(cat_urid)")
      .order("disc_code"),
    (row) => ({
      code: row.disc_code,
      departmentCode: row.dept_code,
      name: row.discipline,
      source: row.source,
      isExtension: row.is_extension,
      categoryCount: (row.dim_category ?? []).length,
    }),
  );
}

export interface Category {
  readonly urid: string;
  readonly disciplineCode: string;
  readonly name: string;
  readonly xyz: string | null;
  readonly isExtension: boolean;
}

export async function listCategories(db: XosClient): Promise<Result<Category[]>> {
  return readRows(
    canon(db)
      .from("dim_category")
      .select("cat_urid, disc_code, category, xyz, is_extension")
      .order("cat_urid"),
    (row) => ({
      urid: row.cat_urid,
      disciplineCode: row.disc_code,
      name: row.category,
      xyz: row.xyz,
      isExtension: row.is_extension,
    }),
  );
}

/** The categories of one discipline, for a discovery filter that narrows from discipline to category. */
export async function listCategoriesInDiscipline(
  db: XosClient,
  disciplineCode: string,
): Promise<Result<Category[]>> {
  return readRows(
    canon(db)
      .from("dim_category")
      .select("cat_urid, disc_code, category, xyz, is_extension")
      .eq("disc_code", disciplineCode)
      .order("cat_urid"),
    (row) => ({
      urid: row.cat_urid,
      disciplineCode: row.disc_code,
      name: row.category,
      xyz: row.xyz,
      isExtension: row.is_extension,
    }),
  );
}

export interface Element {
  readonly id: string;
  readonly urid: string;
  readonly name: string;
  readonly commonName: string | null;
  readonly unitBasis: string;
  readonly grade: string;
  readonly tierCode: string;
  readonly leadTimeHours: number | null;
  readonly description: string | null;
}

export const ELEMENT_PAGE_SIZE = 50;

/**
 * One page of the 1,211 catalog elements, optionally filtered by text (item, common name, element
 * ID or URID) and URID prefix, with the total matching count.
 */
export async function listElements(
  db: XosClient,
  options: { readonly query?: string; readonly uridPrefix?: string; readonly page?: number } = {},
): Promise<Result<{ elements: Element[]; total: number }>> {
  const page = Math.max(0, options.page ?? 0);
  let query = canon(db)
    .from("elements")
    .select(
      "element_id, urid, item, common_name, unit_basis, grade, tier_code, lead_time_hours, description",
      { count: "exact" },
    );
  const text = options.query
    ?.trim()
    .replace(/[%,()*]/g, " ")
    .trim();
  if (text) {
    query = query.or(
      `item.ilike.*${text}*,common_name.ilike.*${text}*,element_id.ilike.*${text}*,urid.ilike.*${text}*`,
    );
  }
  if (options.uridPrefix && /^[0-9.]+$/.test(options.uridPrefix)) {
    query = query.like("urid", `${options.uridPrefix}%`);
  }
  const { data, error, count } = await query
    .order("element_id")
    .range(page * ELEMENT_PAGE_SIZE, page * ELEMENT_PAGE_SIZE + ELEMENT_PAGE_SIZE - 1);
  if (error) return fail(toDataError(error));
  return ok({
    total: count ?? 0,
    elements: (data ?? []).map((row) => ({
      id: row.element_id,
      urid: row.urid,
      name: row.item,
      commonName: row.common_name,
      unitBasis: row.unit_basis,
      grade: row.grade,
      tierCode: row.tier_code,
      leadTimeHours: row.lead_time_hours,
      description: row.description,
    })),
  });
}

/** Element options for catalog pickers, matching text; at most `limit`. */
export async function searchElements(
  db: XosClient,
  text: string,
  limit = 20,
): Promise<Result<{ id: string; name: string; urid: string; unitBasis: string }[]>> {
  const result = await listElements(db, { query: text });
  if (!result.ok) return result;
  return ok(
    result.data.elements
      .slice(0, limit)
      .map((e) => ({ id: e.id, name: e.name, urid: e.urid, unitBasis: e.unitBasis })),
  );
}

export interface Phase {
  readonly code: string;
  readonly gate: number;
  readonly name: string;
  readonly actCode: string;
  readonly definition: string;
  readonly gateExit: string;
  readonly criteria: readonly {
    readonly id: string;
    readonly statement: string;
    readonly isBlocking: boolean;
  }[];
}

export async function listPhases(db: XosClient): Promise<Result<Phase[]>> {
  const [phases, criteria] = await Promise.all([
    readRows(
      canon(db)
        .from("dim_phase")
        .select("phase_code, gate, phase, act_code, definition, gate_exit")
        .order("gate"),
      (row) => row,
    ),
    readRows(
      canon(db)
        .from("dim_gate_criterion")
        .select("criterion_id, gate, ordinal, statement, is_blocking")
        .order("ordinal"),
      (row) => row,
    ),
  ]);
  if (!phases.ok) return phases;
  if (!criteria.ok) return criteria;
  return ok(
    phases.data.map((p) => ({
      code: p.phase_code,
      gate: p.gate,
      name: p.phase,
      actCode: p.act_code,
      definition: p.definition,
      gateExit: p.gate_exit,
      criteria: criteria.data
        .filter((c) => c.gate === p.gate)
        .map((c) => ({ id: c.criterion_id, statement: c.statement, isBlocking: c.is_blocking })),
    })),
  );
}

export interface RecordKind {
  readonly kind: string;
  readonly recordClass: string;
  readonly definition: string;
  readonly definitionOfDone: string;
  readonly titleGrammar: string;
  readonly subtypes: readonly string[];
}

export async function listRecordKinds(db: XosClient): Promise<Result<RecordKind[]>> {
  return readRows(
    canon(db)
      .from("dim_record_kind")
      .select(
        "record_kind, record_class, definition, definition_of_done, title_grammar, ordinal, dim_record_subtype(record_subtype, ordinal)",
      )
      .order("ordinal"),
    (row) => ({
      kind: row.record_kind,
      recordClass: row.record_class,
      definition: row.definition,
      definitionOfDone: row.definition_of_done,
      titleGrammar: row.title_grammar,
      subtypes: [...(row.dim_record_subtype ?? [])]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((s) => s.record_subtype),
    }),
  );
}

export interface CanonRole {
  readonly code: string;
  readonly name: string;
  readonly departmentCode: string;
  readonly jobTitle: string | null;
  readonly staffingRatio: number | null;
  readonly ratioBasis: string | null;
}

export async function listCanonRoles(db: XosClient): Promise<Result<CanonRole[]>> {
  return readRows(
    canon(db)
      .from("dim_role")
      .select("role_code, role, dept_code, job_title, staffing_ratio, ratio_basis")
      .order("role_code"),
    (row) => ({
      code: row.role_code,
      name: row.role,
      departmentCode: row.dept_code,
      jobTitle: row.job_title,
      staffingRatio: row.staffing_ratio,
      ratioBasis: row.ratio_basis,
    }),
  );
}

export interface Jurisdiction {
  readonly id: string;
  readonly level: string;
  readonly parent: string | null;
  readonly status: string;
  readonly currency: string | null;
  readonly unitSystem: string | null;
  readonly note: string | null;
  readonly permitRules: readonly {
    readonly rule: string;
    readonly triggerType: string;
    readonly condition: string;
    readonly permit: string;
    readonly ahj: string;
    readonly leadTime: string;
    readonly provenance: string;
  }[];
}

export async function listJurisdictions(db: XosClient): Promise<Result<Jurisdiction[]>> {
  const [jurisdictions, rules] = await Promise.all([
    readRows(
      canon(db)
        .from("jurisdiction")
        .select("jurisdiction_id, level, parent, status, currency, unit_system, note")
        .order("ordinal"),
      (row) => row,
    ),
    readRows(
      canon(db)
        .from("dim_permit_rule")
        .select(
          "rule, trigger_type, condition, permit, ahj, lead_time, jurisdiction_id, provenance",
        )
        .order("ordinal"),
      (row) => row,
    ),
  ]);
  if (!jurisdictions.ok) return jurisdictions;
  if (!rules.ok) return rules;
  return ok(
    jurisdictions.data.map((j) => ({
      id: j.jurisdiction_id,
      level: j.level,
      parent: j.parent,
      status: j.status,
      currency: j.currency,
      unitSystem: j.unit_system,
      note: j.note,
      permitRules: rules.data
        .filter((r) => r.jurisdiction_id === j.jurisdiction_id)
        .map((r) => ({
          rule: r.rule,
          triggerType: r.trigger_type,
          condition: r.condition,
          permit: r.permit,
          ahj: r.ahj,
          leadTime: r.lead_time,
          provenance: r.provenance,
        })),
    })),
  );
}

export interface Metric {
  readonly domain: string;
  readonly item: string;
  /** The value as canon states it: a number or a text, never both. */
  readonly value: number | string;
  readonly qualifier: string | null;
  readonly source: string | null;
  readonly jurisdictionId: string | null;
  readonly provenance: string;
}

export async function listMetrics(db: XosClient): Promise<Result<Metric[]>> {
  return readRows(
    canon(db)
      .from("dim_metric")
      .select(
        "domain, item, value_numeric, value_text, qualifier, source, jurisdiction_id, provenance",
      )
      .order("ordinal"),
    (row) => ({
      domain: row.domain,
      item: row.item,
      value: row.value_numeric ?? row.value_text ?? "",
      qualifier: row.qualifier,
      source: row.source,
      jurisdictionId: row.jurisdiction_id,
      provenance: row.provenance,
    }),
  );
}

// Org extensions (migration 0490) -------------------------------------------------------------------------

export type CanonExtensionLevel = Database["app"]["Enums"]["canon_extension_level"];
export type CanonExtensionState = Database["app"]["Enums"]["canon_extension_state"];

export interface CanonExtensionProposal {
  readonly id: string;
  readonly level: CanonExtensionLevel;
  readonly parentCode: string;
  readonly proposedCode: string;
  readonly label: string;
  readonly rationale: string;
  readonly state: CanonExtensionState;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

const PROPOSAL_COLUMNS =
  "id, extension_level, parent_code, proposed_code, label, rationale, proposal_state, decided_by, decided_at, created_by, created_at" as const;

export async function listCanonExtensionProposals(
  db: XosClient,
  orgId: string,
): Promise<Result<CanonExtensionProposal[]>> {
  return readRows(
    db
      .from("canon_extension_proposals")
      .select(PROPOSAL_COLUMNS)
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("proposed_code"),
    (row) => ({
      id: row.id,
      level: row.extension_level,
      parentCode: row.parent_code,
      proposedCode: row.proposed_code,
      label: row.label,
      rationale: row.rationale,
      state: row.proposal_state,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }),
  );
}

export interface CanonExtensionInput {
  readonly level: CanonExtensionLevel;
  readonly parentCode: string;
  readonly proposedCode: string;
  readonly label: string;
  readonly rationale: string;
}

export type CanonExtensionProblem = "shape" | "range" | "parent";

/** The shape rules the database checks, run before the round trip so the form can explain them. */
export function canonExtensionProblems(input: CanonExtensionInput): CanonExtensionProblem[] {
  const problems: CanonExtensionProblem[] = [];
  const code = input.proposedCode.trim();
  const parent = input.parentCode.trim();
  const discipline = input.level === "Discipline";
  const shapeOk = discipline
    ? /^[0-9]000$/.test(parent) && /^[0-9]{4}\.[0-9]{2}$/.test(code)
    : /^[0-9]{4}\.[0-9]{2}$/.test(parent) && /^[0-9]{4}\.[0-9]{2}\.[0-9]{2}$/.test(code);
  if (!shapeOk) return ["shape"];
  if (!code.startsWith(parent)) problems.push("parent");
  const disciplineSegment = Number(code.slice(5, 7));
  const categorySegment = discipline ? 0 : Number(code.slice(8, 10));
  if (disciplineSegment < 50 && categorySegment < 50) problems.push("range");
  return problems;
}

export async function proposeCanonExtension(
  db: XosClient,
  orgId: string,
  input: CanonExtensionInput,
): Promise<Result<{ id: string }>> {
  return insertedId(
    db
      .from("canon_extension_proposals")
      .insert({
        org_id: orgId,
        extension_level: input.level,
        parent_code: input.parentCode.trim(),
        proposed_code: input.proposedCode.trim(),
        label: input.label.trim(),
        rationale: input.rationale.trim(),
      })
      .select("id")
      .single(),
  );
}

/** Edits the label and rationale of a proposal that is still Proposed. */
export async function updateCanonExtension(
  db: XosClient,
  id: string,
  input: { readonly label: string; readonly rationale: string },
): Promise<Result<null>> {
  return touched(
    db
      .from("canon_extension_proposals")
      .update({ label: input.label.trim(), rationale: input.rationale.trim() })
      .eq("id", id)
      .select("id"),
  );
}

/** Approves, rejects or withdraws a proposal (app.decide_canon_extension). */
export async function decideCanonExtension(
  db: XosClient,
  move: {
    readonly id: string;
    readonly expected: CanonExtensionState;
    readonly next: CanonExtensionState;
    readonly reason: string;
  },
): Promise<Result<null>> {
  const rpc = db.rpc("decide_canon_extension", {
    p_proposal_id: move.id,
    p_expected: move.expected,
    p_next: move.next,
    p_reason: move.reason,
  });
  const result = await rpcValue(rpc);
  return result.ok ? ok(null) : result;
}
