import type { ColumnSpec, TableSpec } from "./types.ts";

/**
 * Canon tables of the xpms schema (Section 7.2), in dependency order. Tables
 * whose rows mirror a Playbook sheet carry that sheet's Playbook-only columns
 * and the four row metadata columns the Playbook records.
 */

export const sourceRow: ColumnSpec = {
  name: "source_row",
  type: "int",
  nullable: true,
  comment:
    "Row of the Playbook sheet that mirrors this canon row; NULL when the Playbook has no such row.",
};

export const sourceMeta: readonly ColumnSpec[] = [
  sourceRow,
  {
    name: "source_status",
    type: "text",
    nullable: true,
    comment: "STATUS as recorded on the Playbook row (for example Active).",
  },
  {
    name: "source_created_by",
    type: "text",
    nullable: true,
    comment: "CREATED BY as recorded on the Playbook row.",
  },
  {
    name: "source_created_at",
    type: "timestamp",
    nullable: true,
    comment:
      "CREATED AT as recorded on the Playbook row: a wall-clock time; the Playbook records no time zone.",
  },
  {
    name: "source_updated_at",
    type: "timestamp",
    nullable: true,
    comment:
      "UPDATED AT as recorded on the Playbook row: a wall-clock time; the Playbook records no time zone.",
  },
];

const ordinal = (what: string): ColumnSpec => ({
  name: "ordinal",
  type: "int",
  comment: `Position of the ${what} in its Bible tab; the canonical display order where the code is not numeric.`,
  check: "ordinal > 0",
});

export const CANON_TABLES: readonly TableSpec[] = [
  {
    name: "dim_department",
    comment:
      "The ten locked department classes (Bible tab 01, Section 3.2), listed in numeric order. 4000 is Environment.",
    primaryKey: ["dept_code"],
    columns: [
      {
        name: "dept_code",
        type: "code",
        comment: "Four-digit class code, 0000 to 9000.",
        check: "dept_code ~ '^[0-9]000$'",
      },
      { name: "department", type: "text", comment: "Department label in Title Case." },
      { name: "source", type: "text", comment: "Where the class comes from in canon (canon)." },
      {
        name: "note",
        type: "text",
        nullable: true,
        comment: "Bible note, such as the 4.0 label correction for 4000.",
      },
      {
        name: "executive_lead",
        type: "text",
        nullable: true,
        comment: "EXECUTIVE LEAD from the Playbook Departments sheet.",
      },
      {
        name: "core_function",
        type: "text",
        nullable: true,
        comment: "CORE FUNCTION from the Playbook Departments sheet.",
      },
      {
        name: "scope",
        type: "text",
        nullable: true,
        comment: "SCOPE from the Playbook Departments sheet.",
      },
      ...sourceMeta,
    ],
  },
  {
    name: "dim_discipline",
    comment:
      "Disciplines (Bible tab 02): canon codes .01 to .49 and adopter extensions .50 to .99 within a department.",
    primaryKey: ["disc_code"],
    columns: [
      {
        name: "disc_code",
        type: "code",
        comment: "Discipline code DDDD.DD.",
        check: "disc_code ~ '^[0-9]{4}\\.[0-9]{2}$'",
      },
      {
        name: "dept_code",
        type: "code",
        references: "dim_department(dept_code)",
        comment: "Department class the discipline belongs to.",
      },
      { name: "discipline", type: "text", comment: "Discipline label in Title Case." },
      {
        name: "source",
        type: "text",
        comment:
          "Origin of the discipline: canon, workforce, ramp-up or another tagged extension source.",
      },
      {
        name: "is_extension",
        type: "bool",
        comment: "True when the discipline segment is .50 to .99 (an extension range).",
        generated: "(substr(disc_code, 6, 2)::integer >= 50)",
      },
      ...sourceMeta,
    ],
    checks: ["left(disc_code, 4) = dept_code"],
  },
  {
    name: "dim_category",
    comment:
      "Categories (Bible tab 03). The category URID DDDD.DD.DD is the universal semantic key; there is no fourth segment.",
    primaryKey: ["cat_urid"],
    columns: [
      {
        name: "cat_urid",
        type: "code",
        comment: "Category URID DDDD.DD.DD.",
        check: "cat_urid ~ '^[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}$'",
      },
      {
        name: "disc_code",
        type: "code",
        references: "dim_discipline(disc_code)",
        comment: "Discipline the category belongs to.",
      },
      { name: "category", type: "text", comment: "Category label in Title Case." },
      {
        name: "source",
        type: "text",
        comment: "Origin of the category: canon or a tagged extension source.",
      },
      {
        name: "xyz",
        type: "xyz",
        nullable: true,
        comment:
          "SCHEMA FAMILY (XYZ) from the Playbook Categories & URID Master sheet: X Resource, Y Process, Z Timeline.",
      },
      {
        name: "is_extension",
        type: "bool",
        comment: "True when the discipline or category segment is .50 to .99.",
        generated:
          "(substr(cat_urid, 6, 2)::integer >= 50 or substr(cat_urid, 9, 2)::integer >= 50)",
      },
      ...sourceMeta,
    ],
    checks: ["left(cat_urid, 7) = disc_code"],
  },
  {
    name: "dim_act",
    comment:
      "The three acts PLAN, BUILD and SHOW (Bible tab 04). Acts group phases for presentation only; gates are the only control points.",
    primaryKey: ["act_code"],
    unique: [["ordinal"]],
    orderBy: ["ordinal"],
    columns: [
      { name: "act_code", type: "code", comment: "Act code in capitals." },
      {
        name: "ordinal",
        type: "int",
        comment: "Act order, 1 to 3.",
        check: "ordinal between 1 and 3",
      },
      { name: "definition", type: "text", comment: "What the act covers, in sentence case." },
    ],
  },
  {
    name: "dim_phase",
    comment:
      "The nine gated phases with fixed, append-only ordinals (Bible tab 05, Section 3.4). Gates 1 to 3 are Scope, Engage and Advance.",
    primaryKey: ["phase_code"],
    unique: [["gate"], ["phase"]],
    orderBy: ["gate"],
    columns: [
      {
        name: "phase_code",
        type: "code",
        comment: "Three-letter phase code.",
        check: "phase_code ~ '^[A-Z]{3}$'",
      },
      {
        name: "gate",
        type: "int",
        comment: "Gate ordinal, 1 to 9.",
        check: "gate between 1 and 9",
      },
      { name: "phase", type: "text", comment: "Phase label in Title Case." },
      {
        name: "act_code",
        type: "code",
        references: "dim_act(act_code)",
        comment: "Act the phase is presented under.",
      },
      { name: "definition", type: "text", comment: "What the phase covers." },
      { name: "gate_exit", type: "text", comment: "The condition that closes the gate." },
      {
        name: "is_redefined",
        type: "bool",
        comment: "True when 4.0 kept the code but redefined the phase (Advance).",
      },
    ],
  },
  {
    name: "dim_gate_criterion",
    comment: "The 35 gate criteria (Bible tab 06). A blocking criterion stops the gate transition.",
    primaryKey: ["criterion_id"],
    unique: [["ordinal"]],
    orderBy: ["ordinal"],
    columns: [
      { name: "criterion_id", type: "code", comment: "Criterion code G{gate}.{NAME}." },
      {
        name: "gate",
        type: "int",
        references: "dim_phase(gate)",
        comment: "Gate the criterion belongs to.",
      },
      ordinal("criterion"),
      { name: "statement", type: "text", comment: "The criterion statement, sentence case." },
      {
        name: "is_blocking",
        type: "bool",
        comment: "True when an unmet criterion stops the gate.",
      },
    ],
    checks: ["criterion_id like 'G' || gate::text || '.%'"],
  },
  {
    name: "dim_tier",
    comment:
      "The six tiers of experience (Bible tab 07, Section 3.5). International is never a tier.",
    primaryKey: ["tier_code"],
    columns: [
      {
        name: "tier_code",
        type: "code",
        comment: "Two-digit tier code, 01 to 06.",
        check: "tier_code ~ '^0[1-6]$'",
      },
      { name: "tier", type: "text", comment: "Tier label." },
    ],
  },
  {
    name: "dim_team",
    comment:
      "Canon teams (Bible tab 08). A team is a tag that rolls up to a department, never a tree level.",
    primaryKey: ["team_id"],
    columns: [
      {
        name: "team_id",
        type: "code",
        comment: "Team code DDDD-Tnn.",
        check: "team_id ~ '^[0-9]{4}-T[0-9]{2}$'",
      },
      { name: "team", type: "text", comment: "Team label." },
      {
        name: "dept_code",
        type: "code",
        references: "dim_department(dept_code)",
        comment: "Department the team rolls up to.",
      },
      {
        name: "workgroup_tag",
        type: "text",
        nullable: true,
        comment: "WORKGROUP TAG from the Playbook Teams sheet.",
      },
      {
        name: "lead_role",
        type: "text",
        nullable: true,
        comment: "LEAD ROLE from the Playbook Teams sheet.",
      },
      {
        name: "responsibilities",
        type: "text",
        nullable: true,
        comment: "RESPONSIBILITIES from the Playbook Teams sheet.",
      },
      ...sourceMeta,
    ],
    checks: ["left(team_id, 4) = dept_code"],
  },
  {
    name: "dim_tag",
    comment: "Sustainability and compliance tags (Bible tab 09).",
    primaryKey: ["tag_id"],
    columns: [
      { name: "tag_id", type: "code", comment: "Tag code TAG-nnn." },
      {
        name: "tag_type",
        type: "text",
        comment: "Tag family, such as Sustainability or Compliance.",
      },
      { name: "tag", type: "text", comment: "Tag value as written in canon." },
    ],
  },
  {
    name: "dim_assertion_rank",
    comment: "Assertion ranks 4 to 0 (Bible tab 22). Rank 0 is absent: not zero and not low.",
    primaryKey: ["rank"],
    columns: [
      {
        name: "rank",
        type: "int",
        comment: "Rank, 4 (attested) to 0 (absent).",
        check: "rank between 0 and 4",
      },
      { name: "meaning", type: "text", comment: "What a claim at this rank rests on." },
      { name: "note", type: "text", nullable: true, comment: "Canon examples for the rank." },
    ],
  },
  {
    name: "dim_assertion_word",
    comment:
      "Domain-native assertion words and their shared rank (Bible tab 22): economics, compliance and capability.",
    primaryKey: ["domain", "word"],
    orderBy: ["domain", "rank"],
    columns: [
      {
        name: "domain",
        type: "code",
        comment: "Assertion domain.",
        check: "domain in ('economics', 'compliance', 'capability')",
      },
      { name: "word", type: "code", comment: "Assertion word in capitals." },
      {
        name: "rank",
        type: "int",
        references: "dim_assertion_rank(rank)",
        comment: "Shared rank of the word.",
      },
    ],
    unique: [["domain", "rank"]],
  },
  {
    name: "dim_provenance",
    comment:
      "Provenance ranks (Bible tab 19, Section 3.8): human 100, operator 80, imported 60, agent 40, provider 20.",
    primaryKey: ["provenance"],
    unique: [["rank"]],
    orderBy: ["rank"],
    columns: [
      { name: "provenance", type: "code", comment: "Provenance name." },
      {
        name: "rank",
        type: "int",
        comment: "Rank; a lower rank never overwrites a populated field written by a higher rank.",
        check: "rank > 0",
      },
      { name: "definition", type: "text", comment: "Who writes with this provenance." },
      {
        name: "may_overwrite",
        type: "text",
        comment: "What a writer of this provenance may overwrite, as canon states it.",
      },
      {
        name: "max_confidence",
        type: "code",
        comment: "Highest economics assertion word this provenance may carry.",
      },
    ],
  },
  {
    name: "dim_staleness_policy",
    comment:
      "Staleness policy for price bands (Bible tab 14): degrade one step at 12 months, to MODELED at 24, expire at 36.",
    primaryKey: ["age_months_gte"],
    columns: [
      {
        name: "age_months_gte",
        type: "int",
        comment: "Band age in whole months from which the action applies.",
        check: "age_months_gte >= 0",
      },
      {
        name: "action",
        type: "code",
        comment: "Action: hold, degrade_one_step, degrade_to_modeled or expire.",
        check: "action in ('hold', 'degrade_one_step', 'degrade_to_modeled', 'expire')",
      },
      { name: "detail", type: "text", nullable: true, comment: "Canon detail for the action." },
    ],
  },
  {
    name: "jurisdiction",
    comment:
      "Jurisdictions (Bible tab 11) in third normal form (decision D19): the country derives from the ID; unit system and currency are stored on the country and inherited; code sets are rows of jurisdiction_code_set; jurisdiction_resolved returns tab 11 exactly. An unpopulated jurisdiction returns no answer; it never passes.",
    primaryKey: ["jurisdiction_id"],
    unique: [["ordinal"]],
    orderBy: ["ordinal"],
    checks: [
      "(level = 'country') = (parent is null)",
      "level <> 'country' or (unit_system is not null and currency is not null)",
      "parent is null or left(parent, 2) = left(jurisdiction_id, 2)",
    ],
    columns: [
      {
        name: "jurisdiction_id",
        type: "code",
        comment: "Jurisdiction code, country first (US, US-FL, US-FL-MIAMI-DADE).",
        check: "jurisdiction_id ~ '^[A-Z]{2}(-[A-Z0-9]+)*$'",
      },
      ordinal("jurisdiction"),
      {
        name: "level",
        type: "code",
        comment: "country, region or ahj.",
        check: "level in ('country', 'region', 'ahj')",
      },
      {
        name: "country",
        type: "code",
        comment: "ISO 3166-1 alpha-2 country, derived from the ID.",
        generated: "(left(jurisdiction_id, 2))",
      },
      {
        name: "parent",
        type: "code",
        nullable: true,
        references: "jurisdiction(jurisdiction_id)",
        comment: "Enclosing jurisdiction; NULL for a country.",
      },
      {
        name: "unit_system",
        type: "code",
        nullable: true,
        comment:
          "imperial or metric; stated on the country and inherited unless a lower level states its own.",
        check: "unit_system in ('imperial', 'metric')",
      },
      {
        name: "currency",
        type: "currency",
        nullable: true,
        comment:
          "ISO 4217 currency; stated on the country and inherited unless a lower level states its own.",
      },
      {
        name: "status",
        type: "code",
        comment: "populated or declared-unpopulated.",
        check: "status in ('populated', 'declared-unpopulated')",
      },
      { name: "note", type: "text", nullable: true, comment: "Canon note." },
    ],
  },
  {
    name: "dim_region",
    comment:
      "Cost regions (Bible tab 12). Only a region with a ratified multiplier prices; others refuse.",
    primaryKey: ["region_code"],
    orderBy: ["ordinal"],
    columns: [
      { name: "region_code", type: "code", comment: "Region code." },
      ordinal("region"),
      { name: "name", type: "text", comment: "Region name." },
      {
        name: "jurisdiction_id",
        type: "code",
        references: "jurisdiction(jurisdiction_id)",
        comment: "Jurisdiction the region resolves to.",
      },
      { name: "currency_code", type: "currency", comment: "ISO 4217 currency of the region." },
      { name: "note", type: "text", nullable: true, comment: "Canon note." },
    ],
  },
  {
    name: "dim_region_multiplier",
    comment:
      "Ratified cost multipliers (Bible tab 12). A region without a row has no multiplier and refuses to price.",
    primaryKey: ["region_code"],
    columns: [
      {
        name: "region_code",
        type: "code",
        references: "dim_region(region_code)",
        comment: "Region the multiplier applies to.",
      },
      {
        name: "cost_multiplier",
        type: "numeric",
        comment: "Multiplier applied to basis-region bands.",
        check: "cost_multiplier > 0",
      },
      {
        name: "is_basis",
        type: "bool",
        comment: "True for the basis region the bands were sourced in.",
      },
    ],
  },
  {
    name: "dim_escalation_index",
    comment: "Escalation indices (Bible tab 13) used to carry bands forward in time.",
    primaryKey: ["index_id"],
    columns: [
      { name: "index_id", type: "code", comment: "Index code." },
      { name: "name", type: "text", comment: "Index name." },
      {
        name: "applies_to",
        type: "code",
        references: "jurisdiction(jurisdiction_id)",
        comment: "Jurisdiction the index applies to.",
      },
      { name: "note", type: "text", nullable: true, comment: "Canon note." },
    ],
  },
  {
    name: "dim_permit_rule",
    comment: "Permit rules (Bible tab 15), stamped to their jurisdiction.",
    primaryKey: ["rule"],
    unique: [["ordinal"]],
    orderBy: ["ordinal"],
    columns: [
      { name: "rule", type: "text", comment: "Rule name; unique within canon." },
      ordinal("rule"),
      {
        name: "trigger_type",
        type: "code",
        comment: "What triggers the rule: threshold, project, element or condition.",
      },
      { name: "condition", type: "text", comment: "Triggering condition." },
      { name: "permit", type: "text", comment: "Permit or instrument required." },
      { name: "ahj", type: "text", comment: "Authority having jurisdiction." },
      { name: "lead_time", type: "text", comment: "Lead time as canon states it." },
      {
        name: "jurisdiction_id",
        type: "code",
        references: "jurisdiction(jurisdiction_id)",
        comment: "Jurisdiction the rule binds to.",
      },
      {
        name: "provenance",
        type: "code",
        references: "dim_provenance(provenance)",
        comment: "Provenance of the rule.",
      },
      { name: "note", type: "text", nullable: true, comment: "Canon note." },
    ],
  },
  {
    name: "dim_metric",
    comment:
      "Code-derived and modeled metrics (Bible tab 16). A code-derived metric is bound to its jurisdiction.",
    primaryKey: ["domain", "item"],
    unique: [["ordinal"]],
    orderBy: ["ordinal"],
    columns: [
      { name: "domain", type: "code", comment: "Metric domain." },
      { name: "item", type: "text", comment: "What is measured." },
      ordinal("metric"),
      {
        name: "value_numeric",
        type: "numeric",
        nullable: true,
        comment: "Numeric value, when canon states a number.",
      },
      {
        name: "value_text",
        type: "text",
        nullable: true,
        comment: "Value as text, when canon states it in words.",
      },
      { name: "qualifier", type: "text", nullable: true, comment: "Qualifier of the value." },
      {
        name: "source",
        type: "text",
        nullable: true,
        comment: "Code section or basis of the value.",
      },
      {
        name: "is_code_derived",
        type: "bool",
        comment: "True when the value derives from an adopted code.",
      },
      {
        name: "jurisdiction_id",
        type: "code",
        nullable: true,
        references: "jurisdiction(jurisdiction_id)",
        comment: "Jurisdiction a code-derived value binds to.",
      },
      {
        name: "is_jurisdiction_neutral",
        type: "bool",
        comment: "True when the value holds in any jurisdiction.",
      },
      {
        name: "provenance",
        type: "code",
        references: "dim_provenance(provenance)",
        comment: "Provenance of the metric.",
      },
    ],
    checks: ["(value_numeric is null) <> (value_text is null)"],
  },
  {
    name: "dim_identifier_class",
    comment:
      "Identifier grammar (Bible tab 17): identifier, code and token. The tab 17 line banning status is superseded by Section 3.6 and is not enforced.",
    primaryKey: ["class"],
    orderBy: ["ordinal"],
    columns: [
      { name: "class", type: "code", comment: "identifier, code or token." },
      ordinal("class"),
      { name: "issued_by", type: "text", comment: "Who issues values of the class." },
      { name: "scope", type: "text", comment: "Scope within which a value is unique." },
      {
        name: "is_mutable",
        type: "bool",
        comment: "True when values may change under governance.",
      },
      { name: "rule", type: "text", comment: "The governing rule." },
      { name: "examples", type: "text", comment: "Canon examples." },
    ],
  },
  {
    name: "dim_grain",
    comment: "Grain (Bible tab 18): class, unit and lot.",
    primaryKey: ["grain"],
    orderBy: ["ordinal"],
    columns: [
      { name: "grain", type: "code", comment: "class, unit or lot." },
      ordinal("grain"),
      { name: "counts", type: "text", comment: "What the grain counts." },
      { name: "identified_by", type: "text", comment: "Identifiers of the grain." },
      { name: "answers", type: "text", comment: "The question the grain answers." },
      { name: "note", type: "text", nullable: true, comment: "Canon note." },
    ],
  },
  {
    name: "dim_facet",
    comment: "Facets carried from canon (Bible tab 20).",
    primaryKey: ["facet"],
    orderBy: ["ordinal"],
    columns: [
      { name: "facet", type: "text", comment: "Facet name." },
      ordinal("facet"),
      { name: "form", type: "text", nullable: true, comment: "How the facet is represented." },
      { name: "rolls_up_to", type: "text", nullable: true, comment: "Facet it rolls up to." },
      {
        name: "since",
        type: "text",
        nullable: true,
        comment: "Canon version that introduced the facet.",
      },
      { name: "note", type: "text", nullable: true, comment: "Canon note." },
    ],
  },
  {
    name: "dim_identity_axis",
    comment:
      "Identity doctrine axes (Bible tab 21). The crosswalk GTIN to GPC brick to UNSPSC to URID is proposed and human-confirmed, never automatic.",
    primaryKey: ["axis"],
    orderBy: ["ordinal"],
    columns: [
      { name: "axis", type: "text", comment: "Identity axis." },
      ordinal("axis"),
      { name: "example", type: "text", comment: "Canon example value." },
      { name: "answers", type: "text", comment: "The question the axis answers." },
      {
        name: "name_class",
        type: "code",
        references: "dim_identifier_class(class)",
        comment: "Identifier grammar class of the axis.",
      },
    ],
  },
  {
    name: "dim_record_class",
    comment:
      "The five record classes (Bible tab 24): Work, Artifact, Commitment, Control and Time.",
    primaryKey: ["record_class"],
    unique: [["ordinal"]],
    orderBy: ["ordinal"],
    columns: [
      { name: "record_class", type: "text", comment: "Record class." },
      {
        name: "ordinal",
        type: "int",
        comment: "Order of first appearance in Bible tab 24.",
        check: "ordinal > 0",
      },
    ],
  },
  {
    name: "dim_record_kind",
    comment:
      "The 26 record kinds (Bible tab 24), each with a definition of done and a title grammar.",
    primaryKey: ["record_kind"],
    unique: [["ordinal"]],
    orderBy: ["ordinal"],
    columns: [
      { name: "record_kind", type: "text", comment: "Record kind." },
      ordinal("record kind"),
      { name: "definition", type: "text", comment: "What a record of the kind is." },
      { name: "definition_of_done", type: "text", comment: "When a record of the kind is done." },
      {
        name: "record_class",
        type: "text",
        references: "dim_record_class(record_class)",
        comment: "Class of the kind.",
      },
      { name: "title_grammar", type: "text", comment: "Title grammar validated on write." },
    ],
  },
  {
    name: "dim_record_subtype",
    comment:
      "The 124 kind-scoped record subtypes (Bible tab 25). The composite key lets a record carry a subtype only for its own kind.",
    primaryKey: ["record_kind", "record_subtype"],
    unique: [["ordinal"]],
    orderBy: ["ordinal"],
    columns: [
      {
        name: "record_kind",
        type: "text",
        references: "dim_record_kind(record_kind)",
        comment: "Kind the subtype belongs to.",
      },
      { name: "record_subtype", type: "text", comment: "Subtype label." },
      ordinal("subtype"),
      {
        name: "unspsc_segment",
        type: "text",
        nullable: true,
        comment: "UNSPSC segment and its title, where canon gives one.",
      },
    ],
  },
  {
    name: "dim_record_state",
    comment: "The nine record states (Bible tab 26). Canceled, never Cancelled.",
    primaryKey: ["record_state"],
    unique: [["ordinal"]],
    orderBy: ["ordinal"],
    columns: [
      { name: "record_state", type: "text", comment: "Record state." },
      ordinal("state"),
      { name: "meaning", type: "text", comment: "What the state means." },
    ],
  },
  {
    name: "dim_state",
    comment:
      "The shared state vocabulary (Bible tab 37): five core states plus small domain extensions.",
    primaryKey: ["state"],
    unique: [["ordinal"]],
    orderBy: ["ordinal"],
    columns: [
      { name: "state", type: "text", comment: "State label." },
      ordinal("state"),
      {
        name: "family",
        type: "text",
        comment: "Core or the domain extension the state belongs to.",
      },
      { name: "meaning", type: "text", comment: "What the state means." },
      { name: "applies_to", type: "text", comment: "What the state applies to." },
    ],
  },
  {
    name: "dim_role",
    comment:
      "The 61 workforce roles (Bible tab 27) with function name, job title and staffing ratio. Role codes share the URID shape.",
    primaryKey: ["role_code"],
    columns: [
      {
        name: "role_code",
        type: "code",
        comment: "Role code DDDD.DD.DD.",
        check: "role_code ~ '^[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}$'",
      },
      { name: "role", type: "text", comment: "Function name of the role." },
      {
        name: "dept_code",
        type: "code",
        references: "dim_department(dept_code)",
        comment: "Department the role belongs to.",
      },
      {
        name: "staffing_ratio",
        type: "numeric",
        nullable: true,
        comment: "Staffing ratio, read with ratio_basis.",
      },
      {
        name: "ratio_basis",
        type: "text",
        nullable: true,
        comment: "Basis of the staffing ratio.",
      },
      { name: "kit_basis", type: "text", nullable: true, comment: "Kit or scheduling basis." },
      {
        name: "job_title",
        type: "text",
        nullable: true,
        comment: "Job title, where canon names one.",
      },
    ],
    checks: ["left(role_code, 4) = dept_code"],
  },
  {
    name: "dim_gl_account_type",
    comment:
      "General ledger account types and their normal balance (Playbook GL Accounts sheet, NORMAL BALANCE).",
    primaryKey: ["account_type"],
    columns: [
      {
        name: "account_type",
        type: "text",
        comment: "Account type: Asset, Liability, Equity, Revenue or Expense.",
      },
      {
        name: "normal_balance",
        type: "code",
        nullable: true,
        comment: "Debit or Credit.",
        check: "normal_balance in ('Debit', 'Credit')",
      },
    ],
  },
  {
    name: "dim_gl_account",
    comment:
      "The fixed 23-account chart (Bible tab 29 and the GL chart CSV). Tenants cannot add accounts.",
    primaryKey: ["account_code"],
    columns: [
      {
        name: "account_code",
        type: "code",
        comment: "Four-digit account: ledger type digit, class digit, 00.",
        check: "account_code ~ '^[0-9]{2}00$'",
      },
      { name: "account_name", type: "text", comment: "Account name." },
      {
        name: "account_type",
        type: "text",
        references: "dim_gl_account_type(account_type)",
        comment: "Account type.",
      },
      {
        name: "tax_type",
        type: "text",
        comment: "Default tax type: Tax on Purchases, Tax on Sales, Tax Exempt or None.",
      },
      { name: "description", type: "text", comment: "What posts to the account." },
      {
        name: "class_code",
        type: "code",
        nullable: true,
        references: "dim_department(dept_code)",
        comment:
          "Department class of a revenue or expense account, derived from the class digit; NULL for balance sheet accounts (decision D13: postings resolve by class).",
        generated:
          "(case when account_type in ('Revenue', 'Expense') then substr(account_code, 2, 1) || '000' end)",
      },
      ...sourceMeta,
    ],
    unique: [["class_code", "account_type"]],
  },
  {
    name: "dim_cost_center_template",
    comment:
      "Cost center templates (Bible tab 30), dimension 1: standing operations, corporate overhead and one per event scope.",
    primaryKey: ["cost_center_id"],
    orderBy: ["ordinal"],
    columns: [
      { name: "cost_center_id", type: "code", comment: "Cost center code." },
      ordinal("cost center"),
      { name: "cost_center", type: "text", comment: "Cost center name." },
      { name: "kind", type: "text", comment: "Standing, Overhead or Event." },
      {
        name: "scope_code",
        type: "code",
        nullable: true,
        comment: "Event scope code, for event cost centers.",
      },
      { name: "note", type: "text", nullable: true, comment: "Canon note." },
      ...sourceMeta,
    ],
  },
  {
    name: "dim_counterparty_type",
    comment:
      "The counterparty types (Bible tab 28). A vendor engagement carries a counterparty type; an internal one carries a role code.",
    primaryKey: ["counterparty_type"],
    orderBy: ["ordinal"],
    unique: [["classification_code"]],
    columns: [
      { name: "counterparty_type", type: "text", comment: "Counterparty type." },
      ordinal("counterparty type"),
      { name: "definition", type: "text", comment: "What the counterparty does." },
      {
        name: "classification_code",
        type: "code",
        nullable: true,
        comment: "CLASSIFICATION CODE from the Playbook Counterparty Types sheet.",
      },
      {
        name: "vendor_class",
        type: "text",
        nullable: true,
        comment: "VENDOR CLASS from the Playbook Counterparty Types sheet.",
      },
      {
        name: "clearance_tier",
        type: "text",
        nullable: true,
        comment: "CLEARANCE TIER from the Playbook Counterparty Types sheet.",
      },
      {
        name: "default_account_code",
        type: "code",
        nullable: true,
        references: "dim_gl_account(account_code)",
        comment: "DEFAULT GL ACCOUNT from the Playbook Counterparty Types sheet.",
      },
      ...sourceMeta,
    ],
  },
  {
    name: "dim_category_gl",
    comment:
      "Default cost center of each category (Bible tab 31). The GL account is derived by class (decision D13, view xpms.v_category_gl); the importer verifies tab 31 states the same account.",
    primaryKey: ["cat_urid"],
    columns: [
      {
        name: "cat_urid",
        type: "code",
        references: "dim_category(cat_urid)",
        comment: "Category.",
      },
      {
        name: "default_cost_center",
        type: "code",
        references: "dim_cost_center_template(cost_center_id)",
        comment: "Default dimension 1.",
      },
    ],
  },
  {
    name: "dim_touchpoint",
    comment: "The 90 five-sense touchpoints (Bible tab 10) with Base, Elevated and Premium grades.",
    primaryKey: ["touchpoint_id"],
    orderBy: ["ordinal"],
    columns: [
      { name: "touchpoint_id", type: "code", comment: "Touchpoint code." },
      ordinal("touchpoint"),
      { name: "sense", type: "text", comment: "Sense family." },
      { name: "brief_element", type: "text", comment: "Brief element." },
      { name: "category", type: "text", comment: "Touchpoint category." },
      { name: "item", type: "text", comment: "Touchpoint item." },
      { name: "base", type: "text", comment: "Base grade description." },
      { name: "elevated", type: "text", comment: "Elevated grade description." },
      { name: "premium", type: "text", comment: "Premium grade description." },
      { name: "optional_upgrades", type: "text", nullable: true, comment: "Optional upgrades." },
      { name: "add_ons", type: "text", nullable: true, comment: "Add-ons." },
      { name: "substitutions", type: "text", nullable: true, comment: "Substitutions." },
      { name: "venue_zone", type: "text", nullable: true, comment: "Venue zone." },
      {
        name: "event_tier_fit",
        type: "text",
        nullable: true,
        comment: "Event tier fit as canon states it.",
      },
      {
        name: "dept_code",
        type: "code",
        references: "dim_department(dept_code)",
        comment: "Department class.",
      },
      { name: "division", type: "text", nullable: true, comment: "Division label." },
      {
        name: "tier_code",
        type: "code",
        references: "dim_tier(tier_code)",
        comment: "Tier of experience.",
      },
      {
        name: "lifecycle_phase_code",
        type: "code",
        nullable: true,
        references: "dim_phase(phase_code)",
        comment:
          "Lifecycle gate, relabeled to 4.0; NULL where canon names a value that is not a gated phase (held in xpms.intake).",
      },
      { name: "xyz", type: "xyz", comment: "Schema family tag." },
    ],
  },
  {
    name: "dim_unit_dimension",
    comment:
      "Physical dimensions of units (count, length, time and so on). Canon 4.0 states none; rows arrive through intake.",
    primaryKey: ["dimension_code"],
    columns: [
      { name: "dimension_code", type: "code", comment: "Dimension code." },
      { name: "name", type: "text", comment: "Dimension name." },
    ],
  },
  {
    name: "dim_unit_alias",
    comment:
      "Unit bases used by canon (the Item Catalog unit_basis values). A unit without a dimension refuses arithmetic rather than guessing.",
    primaryKey: ["alias"],
    columns: [
      { name: "alias", type: "text", comment: "Unit basis as written in canon." },
      { name: "unit_code", type: "text", comment: "Canonical unit the alias resolves to." },
      {
        name: "dimension_code",
        type: "code",
        nullable: true,
        references: "dim_unit_dimension(dimension_code)",
        comment: "Dimension of the unit, once ratified.",
      },
    ],
  },
  {
    name: "grade",
    comment:
      "Price grades Base, Elevated and Premium (decision D11). Labels are data; the Bible tab 34 labels Grade 1 Basic, Grade 2 Standard and Grade 3 Premium are superseded.",
    primaryKey: ["code"],
    unique: [["label"], ["sort_order"]],
    orderBy: ["sort_order"],
    columns: [
      {
        name: "code",
        type: "code",
        comment: "base, elevated or premium.",
        check: "code in ('base', 'elevated', 'premium')",
      },
      { name: "label", type: "text", comment: "Grade label." },
      { name: "sort_order", type: "int", comment: "Display order." },
    ],
  },
  {
    name: "dim_upl_field",
    comment:
      "The Universal Posting Line (Bible tab 36): one export shape and its platform mappings.",
    primaryKey: ["field"],
    orderBy: ["ordinal"],
    columns: [
      { name: "field", type: "code", comment: "Field or platform name." },
      ordinal("field"),
      { name: "rule", type: "text", comment: "Rule or mapping for the field." },
    ],
  },
  {
    name: "dim_budget_template_rule",
    comment: "The budget template specification (Bible tab 34).",
    primaryKey: ["field"],
    orderBy: ["ordinal"],
    columns: [
      { name: "field", type: "text", comment: "Template field or topic." },
      ordinal("rule"),
      { name: "rule", type: "text", comment: "The rule." },
    ],
  },
  {
    name: "dim_change_record",
    comment: "The 3.0 to 4.0 change record (Bible tab 35). Codes never move.",
    primaryKey: ["change"],
    orderBy: ["ordinal"],
    columns: [
      { name: "change", type: "text", comment: "What changed." },
      ordinal("change"),
      { name: "from_value", type: "text", comment: "Value in 3.0." },
      { name: "to_value", type: "text", comment: "Value in 4.0." },
      { name: "why", type: "text", comment: "Reason for the change." },
    ],
  },
  {
    name: "canon_statement",
    comment:
      "Narrative Bible rows that are statements rather than dimension members: the cover, the silence rule, identity doctrine notes and build provenance.",
    primaryKey: ["tab", "ordinal"],
    columns: [
      { name: "tab", type: "text", comment: "Bible tab the statement comes from." },
      ordinal("statement"),
      { name: "item", type: "text", nullable: true, comment: "Statement heading." },
      { name: "statement", type: "text", nullable: true, comment: "Statement text." },
    ],
  },
  {
    name: "dim_urn_namespace",
    comment: "URN kinds resolvable under urn:xpms (Section 3.1): urn:xpms:{kind}:{key}.",
    primaryKey: ["kind"],
    columns: [
      {
        name: "kind",
        type: "code",
        comment: "URN kind segment.",
        check: "kind ~ '^[a-z][a-z_]*$'",
      },
      { name: "table_name", type: "code", comment: "xpms table holding the kind." },
      { name: "key_column", type: "code", comment: "Natural key column of that table." },
      { name: "label_column", type: "code", comment: "Column holding the display label." },
    ],
  },
  {
    name: "dim_locale",
    comment:
      "Locales canon labels can be translated into (Section 15). Codes are never translated.",
    primaryKey: ["locale_code"],
    columns: [
      { name: "locale_code", type: "code", comment: "BCP 47 locale code." },
      { name: "name", type: "text", comment: "Locale name in English." },
      { name: "is_source", type: "bool", comment: "True for the source locale, en-US." },
      {
        name: "release_stage",
        type: "code",
        comment: "general or beta.",
        check: "release_stage in ('general', 'beta')",
      },
    ],
  },
  {
    name: "elements",
    comment:
      "The catalog: 1,211 elements (Bible tab 32 and the Item Catalog CSV). Item IDs follow {URID}-{ORG}-{SEQ}.",
    primaryKey: ["element_id"],
    columns: [
      { name: "element_id", type: "code", comment: "Item ID {URID}-{ORG}-{SEQ}." },
      {
        name: "urid",
        type: "code",
        references: "dim_category(cat_urid)",
        comment: "Category URID of the element.",
      },
      { name: "item", type: "text", comment: "Item name in Title Case." },
      { name: "common_name", type: "text", nullable: true, comment: "Common name." },
      { name: "kind", type: "code", comment: "Resource kind." },
      {
        name: "unit_basis",
        type: "text",
        references: "dim_unit_alias(alias)",
        comment: "Unit basis.",
      },
      {
        name: "grade",
        type: "text",
        comment: "Experience grade of the element: Standard, Base, Elevated or Premium.",
      },
      { name: "description", type: "text", nullable: true, comment: "Description, sentence case." },
      { name: "specification", type: "text", nullable: true, comment: "Specification." },
      { name: "xyz", type: "xyz", comment: "Schema family tag." },
      { name: "xyz_basis", type: "text", comment: "Basis of the XYZ tag, stored beside it." },
      {
        name: "tier_code",
        type: "code",
        references: "dim_tier(tier_code)",
        comment: "Tier of experience.",
      },
      { name: "lead_time_hours", type: "numeric", nullable: true, comment: "Lead time in hours." },
      { name: "crew", type: "text", nullable: true, comment: "Crew needed." },
      {
        name: "unspsc",
        type: "code",
        nullable: true,
        comment: "UNSPSC identifier; recorded, never minted.",
      },
      {
        name: "purchase_account",
        type: "code",
        nullable: true,
        references: "dim_gl_account(account_code)",
        comment: "Purchase account.",
      },
      {
        name: "sales_account",
        type: "code",
        nullable: true,
        references: "dim_gl_account(account_code)",
        comment: "Sales account.",
      },
      {
        name: "default_cost_center",
        type: "code",
        references: "dim_cost_center_template(cost_center_id)",
        comment: "Default dimension 1.",
      },
      {
        name: "price_evidence",
        type: "text",
        nullable: true,
        comment: "Source of the price bands.",
      },
      { name: "source", type: "text", comment: "Where the element entered canon." },
      {
        name: "mapping_confidence",
        type: "text",
        comment: "How the element was mapped to its URID.",
      },
      {
        name: "lifecycle_state",
        type: "text",
        references: "dim_state(state)",
        comment: "Lifecycle state from the shared vocabulary.",
      },
      {
        name: "external_ref",
        type: "text",
        nullable: true,
        comment: "Legacy code or touchpoint ID; never a join key.",
      },
      sourceRow,
    ],
    checks: [
      "left(element_id, 11) = urid || '-'",
      "purchase_account is not null or sales_account is not null",
    ],
  },
  {
    name: "element_price_bands",
    comment:
      "Price bands per element and grade. NULL is never stored: an element without a band is unpriced.",
    primaryKey: ["element_id", "grade_code"],
    columns: [
      {
        name: "element_id",
        type: "code",
        references: "elements(element_id)",
        comment: "Element priced.",
      },
      {
        name: "grade_code",
        type: "code",
        references: "grade(code)",
        comment: "Price grade.",
      },
      {
        name: "amount_minor",
        type: "minor",
        comment: "Amount in minor units of currency_code.",
        check: "amount_minor >= 0",
      },
      { name: "currency_code", type: "currency", comment: "ISO 4217 currency of the amount." },
      {
        name: "assertion_word",
        type: "code",
        nullable: true,
        comment:
          "Economics assertion word; NULL means canon states none and confidence resolves as no answer.",
      },
      {
        name: "valid_from",
        type: "date",
        nullable: true,
        comment: "Date the band was sourced; NULL means canon states none.",
      },
      {
        name: "valid_to",
        type: "date",
        nullable: true,
        comment: "Date the band stops applying, if stated.",
      },
    ],
    checks: ["valid_to is null or valid_from is null or valid_to >= valid_from"],
  },
  {
    name: "element_gtins",
    comment:
      "GTINs bound to elements. Many GTINs map to one element; one GTIN maps to at most one element. Never one-to-one.",
    primaryKey: ["gtin"],
    columns: [
      { name: "gtin", type: "code", comment: "GTIN-14 identifier.", check: "gtin ~ '^[0-9]{14}$'" },
      {
        name: "element_id",
        type: "code",
        references: "elements(element_id)",
        comment: "Element the trade item is an instance of.",
      },
      {
        name: "gpc_brick",
        type: "code",
        nullable: true,
        comment: "GS1 GPC brick of the trade item.",
      },
      {
        name: "confirmed_by",
        type: "text",
        comment: "Named human who confirmed the crosswalk; it is never automatic.",
      },
    ],
  },
  {
    name: "bridge_element_phase",
    comment: "Phase participation of an element, multi-valued (Section 3.4).",
    primaryKey: ["element_id", "phase_code"],
    columns: [
      { name: "element_id", type: "code", references: "elements(element_id)", comment: "Element." },
      {
        name: "phase_code",
        type: "code",
        references: "dim_phase(phase_code)",
        comment: "Phase the element participates in.",
      },
      {
        name: "is_default",
        type: "bool",
        comment: "True for the element's default phase from the catalog.",
      },
    ],
  },
  {
    name: "bridge_element_tag",
    comment: "Sustainability and compliance tags of an element.",
    primaryKey: ["element_id", "tag_id"],
    columns: [
      { name: "element_id", type: "code", references: "elements(element_id)", comment: "Element." },
      { name: "tag_id", type: "code", references: "dim_tag(tag_id)", comment: "Tag." },
    ],
  },
  {
    name: "bridge_element_permit",
    comment: "Permit rules an element triggers.",
    primaryKey: ["element_id", "rule"],
    columns: [
      { name: "element_id", type: "code", references: "elements(element_id)", comment: "Element." },
      { name: "rule", type: "text", references: "dim_permit_rule(rule)", comment: "Permit rule." },
    ],
  },
  {
    name: "bridge_element_metric",
    comment: "Metrics that apply to an element.",
    primaryKey: ["element_id", "domain", "item"],
    foreignKeys: [
      { columns: ["domain", "item"], table: "dim_metric", targets: ["domain", "item"] },
    ],
    columns: [
      { name: "element_id", type: "code", references: "elements(element_id)", comment: "Element." },
      { name: "domain", type: "code", comment: "Metric domain." },
      { name: "item", type: "text", comment: "Metric item." },
    ],
  },
  {
    name: "bridge_touchpoint_discipline",
    comment:
      "Disciplines a touchpoint is delivered through, from the URIDs of the catalog items that realize it.",
    primaryKey: ["touchpoint_id", "disc_code"],
    columns: [
      {
        name: "touchpoint_id",
        type: "code",
        references: "dim_touchpoint(touchpoint_id)",
        comment: "Touchpoint.",
      },
      {
        name: "disc_code",
        type: "code",
        references: "dim_discipline(disc_code)",
        comment: "Discipline.",
      },
    ],
  },
  {
    name: "bridge_discipline_team",
    comment: "Teams that deliver a discipline.",
    primaryKey: ["disc_code", "team_id"],
    columns: [
      {
        name: "disc_code",
        type: "code",
        references: "dim_discipline(disc_code)",
        comment: "Discipline.",
      },
      { name: "team_id", type: "code", references: "dim_team(team_id)", comment: "Team." },
    ],
  },
];
