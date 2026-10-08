/**
 * Canon read resources (`xpms`, Section 7.2). Canon is populated by the importer, readable by
 * every authenticated user and never written through the API. Columns follow the Bible tab headers.
 */
import { z } from "zod";
import * as c from "../common/canon-codes.ts";
import * as f from "../common/fields.ts";
import { RecordState } from "../common/enums.ts";
import { defineResource } from "../common/resource.ts";

const label = (description: string, example: string) => f.text(description, example, 200);
const definition = (example: string) => f.longText("Definition, in sentence case.", example);

export const CanonDepartment = defineResource({
  name: "CanonDepartment",
  table: "xpms.dim_department",
  description: "A department class. Ten classes, always in numeric order.",
  base: "canon",
  key: "dept_code",
  fields: {
    dept_code: c.DeptCode,
    department: label("Department name.", "Environment"),
    source: f.code("Canon source of the row.", "canon"),
    note: f.longText("Note from the Bible.", "Environment replaces the 3.0 label.").nullable(),
  },
});

export const CanonDiscipline = defineResource({
  name: "CanonDiscipline",
  table: "xpms.dim_discipline",
  description: "A discipline within a department class.",
  base: "canon",
  key: "disc_code",
  fields: {
    disc_code: c.DiscCode,
    dept_code: c.DeptCode,
    discipline: label("Discipline name.", "Executive Leadership & Strategy"),
    source: f.code("Canon source of the row.", "canon"),
  },
});

export const CanonCategory = defineResource({
  name: "CanonCategory",
  table: "xpms.dim_category",
  description: "A category, the finest URID grain.",
  base: "canon",
  key: "cat_urid",
  fields: {
    cat_urid: c.Urid,
    disc_code: c.DiscCode,
    category: label("Category name.", "Production Leadership"),
    source: f.code("Canon source of the row.", "canon"),
  },
});

export const CanonAct = defineResource({
  name: "CanonAct",
  table: "xpms.dim_act",
  description: "An act: a presentation grouping of gates, never a control point.",
  base: "canon",
  key: "act",
  fields: {
    ordinal: f.int("Act ordinal.", 1, 1),
    act: c.ActCode,
    gates: f.code("Gate range the act groups.", "1-3"),
    definition: definition("Everything before money is committed."),
  },
});

export const CanonPhase = defineResource({
  name: "CanonPhase",
  table: "xpms.dim_phase",
  description: "A gated phase. Nine phases with fixed, append-only ordinals.",
  base: "canon",
  key: "phase_code",
  fields: {
    gate: f.int("Gate ordinal.", 1, 1),
    phase_code: c.PhaseCode,
    phase: label("Phase name.", "Scope"),
    act: c.ActCode,
    definition: definition("What needs to happen."),
    gate_exit: f.longText("What must be true to pass the gate.", "Go or no-go ratified."),
  },
});

export const CanonGateCriterion = defineResource({
  name: "CanonGateCriterion",
  table: "xpms.dim_gate_criterion",
  description: "A gate criterion. Blocking criteria stop the gate transition in the database.",
  base: "canon",
  key: "criterion_id",
  fields: {
    gate: f.int("Gate ordinal.", 1, 1),
    criterion_id: c.CriterionId,
    statement: f.longText("Criterion statement.", "A budget envelope exists and is approved."),
    blocking: f.bool("Whether the criterion blocks the gate.", true),
  },
});

export const CanonTier = defineResource({
  name: "CanonTier",
  table: "xpms.dim_tier",
  description: "A tier of experience. International is never a tier.",
  base: "canon",
  key: "tier_code",
  fields: { tier_code: c.TierCode, tier: label("Tier name.", "Physical") },
});

export const CanonTeam = defineResource({
  name: "CanonTeam",
  table: "xpms.dim_team",
  description: "A canon team: a tag that rolls up to a department, never a tree level.",
  base: "canon",
  key: "team_id",
  fields: {
    team_id: c.TeamId,
    team: label("Team name.", "Executive Leadership"),
    rolls_to_dept_code: c.DeptCode,
  },
});

export const CanonTag = defineResource({
  name: "CanonTag",
  table: "xpms.dim_tag",
  description: "A sustainability or compliance tag.",
  base: "canon",
  key: "tag_id",
  fields: {
    tag_id: c.TagId,
    tag_type: label("Tag type.", "Compliance"),
    tag: f.code("Tag value.", "OSHA"),
  },
});

export const CanonTouchpoint = defineResource({
  name: "CanonTouchpoint",
  table: "xpms.dim_touchpoint",
  description: "A five-sense touchpoint with Base, Elevated and Premium grades.",
  base: "canon",
  key: "touchpoint_id",
  fields: {
    touchpoint_id: c.TouchpointId,
    sense: label("Sense the touchpoint addresses.", "Architecture (Sight)"),
    brief_element: label("Brief element.", "Floor Plan"),
    category: label("Touchpoint category.", "Stage Configuration"),
    item: label("Touchpoint item.", "Ground-Level Stage"),
    base: f.longText("Base grade description.", "Low-rise deck stage."),
    elevated: f.longText("Elevated grade description.", "Deck stage with skirted fascia."),
    premium: f.longText("Premium grade description.", "Custom-fabricated floor stage."),
    optional_upgrades: f.longText("Optional upgrades.", "Stage-front lighting ribbon.").nullable(),
  },
});

export const CanonJurisdiction = defineResource({
  name: "CanonJurisdiction",
  table: "xpms.dim_jurisdiction",
  description:
    "A jurisdiction. An unpopulated jurisdiction returns no answer for permit and code questions.",
  base: "canon",
  key: "jurisdiction_id",
  fields: {
    jurisdiction_id: c.JurisdictionId,
    level: f.code("Jurisdiction level.", "region"),
    country: f.countryCode(),
    parent: c.JurisdictionId.nullable(),
    unit_system: f.code("Unit system.", "imperial"),
    currency: f.currency("Default currency of the jurisdiction."),
    primary_code_sets: f.text("Primary code sets in force.", "FBC, Florida Fire Prevention Code"),
    status: f.code("Population status of the jurisdiction's rules.", "populated"),
    note: f.longText("Note from the Bible.", "Florida amendments to the model codes.").nullable(),
  },
});

export const CanonRegion = defineResource({
  name: "CanonRegion",
  table: "xpms.dim_region",
  description: "A cost region. Only ratified multipliers answer; others refuse.",
  base: "canon",
  key: "region_code",
  fields: {
    region_code: c.RegionCode,
    name: label("Region name.", "Miami and South Florida"),
    jurisdiction_id: c.JurisdictionId,
    currency: f.currency("Currency of the region."),
    cost_multiplier: f.quantity("Ratified cost multiplier; null when unratified.", 1).nullable(),
    basis: f.bool("Whether the region is the basis region.", true),
    note: f.longText("Note from the Bible.", "Basis region.").nullable(),
  },
});

export const CanonRegionMultiplier = defineResource({
  name: "CanonRegionMultiplier",
  table: "xpms.dim_region_multiplier",
  description: "A cost multiplier for a region, with its ratification.",
  base: "canon",
  key: "region_code",
  fields: {
    region_code: c.RegionCode,
    multiplier: f.quantity("Cost multiplier.", 1),
    ratified: f.bool("Whether the multiplier is ratified.", true),
  },
});

export const CanonEscalationIndex = defineResource({
  name: "CanonEscalationIndex",
  table: "xpms.dim_escalation_index",
  description: "A price escalation index.",
  base: "canon",
  key: "index_id",
  fields: {
    index_id: f.code("Index identifier.", "BLS-CPI-U"),
    name: label("Index name.", "US CPI-U, all items"),
    applies_to: c.JurisdictionId,
    note: f.longText("Note from the Bible.", "Default escalation basis.").nullable(),
  },
});

export const CanonStalenessPolicy = defineResource({
  name: "CanonStalenessPolicy",
  table: "xpms.dim_staleness_policy",
  description: "A staleness step: how a price band degrades with age.",
  base: "canon",
  key: "age_months_gte",
  fields: {
    age_months_gte: f.int("Age in months at which the action applies.", 12),
    action: f.code("Action taken at that age.", "degrade"),
    detail: f.longText("Detail of the action.", "Degrade one step."),
  },
});

export const CanonPermitRule = defineResource({
  name: "CanonPermitRule",
  table: "xpms.dim_permit_rule",
  description: "A permit rule of the jurisdiction permit engine.",
  base: "canon",
  key: "rule",
  fields: {
    rule: label("Rule name.", "Assembly occupancy"),
    trigger_type: f.code("What triggers the rule.", "threshold"),
    condition: f.longText("Trigger condition.", "Occupant load of 50 or more."),
    permit: f.text("Permit required.", "Certificate of occupancy"),
    ahj: f.text("Authority having jurisdiction.", "City Building and Fire"),
    lead_time: f.text("Typical lead time.", "4-8 wks"),
    jurisdiction_id: c.JurisdictionId,
    provenance: c.Provenance,
    note: f.longText("Note from the Bible.", "Triggered by occupant load.").nullable(),
  },
});

export const CanonMetric = defineResource({
  name: "CanonMetric",
  table: "xpms.dim_metric",
  description: "A metric, often code-derived and jurisdiction-bound.",
  base: "canon",
  key: "item",
  fields: {
    domain: f.code("Metric domain.", "capacity"),
    item: label("Metric item.", "Stage or performance area"),
    value: f.quantity("Metric value.", 15),
    qualifier: f.code("Qualifier of the value.", "net").nullable(),
    source: f.text("Source of the value.", "IBC 1004.5"),
    code_derived: f.bool("Whether the value comes from a code.", true),
    jurisdiction_id: c.JurisdictionId.nullable(),
    jurisdiction_neutral: f.bool("Whether the value holds in every jurisdiction.", false),
    provenance: c.Provenance,
  },
});

export const CanonIdentifierClass = defineResource({
  name: "CanonIdentifierClass",
  table: "xpms.dim_identifier_class",
  description: "Identifier grammar: identifier, code or token (Section 3.6).",
  base: "canon",
  key: "class",
  fields: {
    class: f.code("Identifier class.", "identifier"),
    issued_by: f.text("Who issues it.", "An external authority"),
    scope: f.text("Where it is unique.", "Global"),
    mutable: f.bool("Whether it may change.", false),
    rule: f.longText("Rule.", "Recorded and validated, never minted."),
    examples: f.text("Examples.", "GTIN, MPN, UNSPSC"),
  },
});

export const CanonGrain = defineResource({
  name: "CanonGrain",
  table: "xpms.dim_grain",
  description: "Grain: class, unit or lot (Section 3.9).",
  base: "canon",
  key: "grain",
  fields: {
    grain: c.GrainCode,
    counts: f.text("What it counts.", "One physical thing"),
    identified_by: f.text("How it is identified.", "Serial or asset tag"),
    answers: f.text("What it answers.", "Where is this one?"),
    note: f.longText("Note from the Bible.", "Tracked individually.").nullable(),
  },
});

export const CanonProvenance = defineResource({
  name: "CanonProvenance",
  table: "xpms.dim_provenance",
  description: "A provenance rank. A lower rank never overwrites a populated higher-rank field.",
  base: "canon",
  key: "provenance",
  fields: {
    provenance: c.Provenance,
    rank: f.int("Rank, higher wins.", 80),
    definition: definition("A tenant human entering a fact."),
    may_overwrite: f.text("What this provenance may overwrite.", "Any field not canon-locked"),
    max_confidence: c.AssertionLabel,
  },
});

export const CanonFacet = defineResource({
  name: "CanonFacet",
  table: "xpms.dim_facet",
  description: "A facet carried from canon.",
  base: "canon",
  key: "facet",
  fields: {
    facet: label("Facet name.", "Phase"),
    form: f.text("Form of the facet.", "Nine gated phases"),
    rolls_up_to: label("What the facet rolls up to.", "Act").nullable(),
    since: f.code("Version that introduced it.", "3.0").nullable(),
    note: f.longText("Note from the Bible.", "Carried from canon.").nullable(),
  },
});

export const CanonAssertionRank = defineResource({
  name: "CanonAssertionRank",
  table: "xpms.dim_assertion_rank",
  description: "An assertion rank, 4 down to 0, across economics, compliance and capability.",
  base: "canon",
  key: "rank",
  fields: {
    rank: f.int("Assertion rank.", 4),
    meaning: f.longText("Meaning of the rank.", "Attested by a named accountable party."),
    economics: c.AssertionLabel.nullable(),
    compliance: c.AssertionLabel.nullable(),
    capability: c.AssertionLabel.nullable(),
    note: f.longText("Note from the Bible.", "A vendor quote.").nullable(),
  },
});

export const CanonRecordKind = defineResource({
  name: "CanonRecordKind",
  table: "xpms.dim_record_kind",
  description: "A record kind with its class, definition of done and title grammar.",
  base: "canon",
  key: "record_kind",
  fields: {
    record_kind: c.RecordKind,
    definition: definition("A unit of assigned work."),
    definition_of_done: f.longText("Definition of done.", "Done against its acceptance."),
    record_class: c.RecordClass,
    title_grammar: f.longText("Title grammar validated on write.", "Imperative verb first."),
  },
});

export const CanonRecordSubtype = defineResource({
  name: "CanonRecordSubtype",
  table: "xpms.dim_record_subtype",
  description: "A kind-scoped record subtype.",
  base: "canon",
  key: "record_subtype",
  fields: {
    record_kind: c.RecordKind,
    record_subtype: c.RecordSubtype,
    unspsc_segment: f.code("UNSPSC segment.", "80").nullable(),
    gate: f.int("Gate the subtype belongs to.", 1, 1).nullable(),
    phase_code: c.PhaseCode.nullable(),
  },
});

export const CanonRecordState = defineResource({
  name: "CanonRecordState",
  table: "xpms.dim_record_state",
  description: "A record state with its meaning, in lifecycle order.",
  base: "canon",
  key: "record_state",
  fields: {
    record_state: RecordState,
    meaning: f.longText("Meaning of the state.", "Dated and resourced."),
  },
});

export const CanonRole = defineResource({
  name: "CanonRole",
  table: "xpms.dim_role",
  description: "A workforce role with its staffing ratio.",
  base: "canon",
  key: "role_code",
  fields: {
    role_code: c.RoleCode,
    role: label("Role function name.", "Rigging lead"),
    dept_code: c.DeptCode,
    staffing_ratio: f.text("Staffing ratio.", "1 per 250 guests").nullable(),
    ratio_basis: f.text("Basis of the ratio.", "Guests").nullable(),
    kit_basis: f.text("Kit basis.", "Per person").nullable(),
    job_title: label("Job title.", "Head Rigger").nullable(),
  },
});

export const CanonCounterpartyType = defineResource({
  name: "CanonCounterpartyType",
  table: "xpms.dim_counterparty_type",
  description: "A vendor counterparty type.",
  base: "canon",
  key: "counterparty_type",
  fields: {
    counterparty_type: c.CounterpartyType,
    definition: definition("Designs and installs audiovisual systems."),
  },
});

export const CanonGlAccount = defineResource({
  name: "CanonGlAccount",
  table: "xpms.dim_gl_account",
  description: "A GL account in the fixed 23-account chart. Tenants cannot add accounts.",
  base: "canon",
  key: "account_code",
  fields: {
    account_code: c.GlAccountCode,
    account_name: label("Account name.", "Environment"),
    account_type: label("Account type.", "Expense"),
    tax_type: c.TaxType,
    description: f.longText("Account description.", "Environment class costs."),
  },
});

export const CanonCostCenterTemplate = defineResource({
  name: "CanonCostCenterTemplate",
  table: "xpms.dim_cost_center_template",
  description: "A cost center template (GL dimension 1).",
  base: "canon",
  key: "cost_center_id",
  fields: {
    cost_center_id: c.CostCenterCode,
    cost_center: label("Cost center name.", "Venue Standing Operations"),
    kind: label("Cost center kind.", "Standing"),
    scope_code: f.code("Scope code the cost center belongs to.", "E01").nullable(),
    note: f.longText("Note from the Bible.", "Runs whether or not an event does.").nullable(),
  },
});

export const CanonCategoryGl = defineResource({
  name: "CanonCategoryGl",
  table: "xpms.dim_category_gl",
  description: "The GL account each category posts to.",
  base: "canon",
  key: "cat_urid",
  fields: {
    cat_urid: c.Urid,
    disc_code: c.DiscCode,
    dept_code: c.DeptCode,
    account_code: c.GlAccountCode,
  },
});

export const CanonUnitAlias = defineResource({
  name: "CanonUnitAlias",
  table: "xpms.dim_unit_alias",
  description: "An alias of a controlled unit.",
  base: "canon",
  key: "alias",
  fields: {
    alias: f.code("Alias as written.", "ea"),
    unit: c.UnitCode,
  },
});

export const CanonUnitDimension = defineResource({
  name: "CanonUnitDimension",
  table: "xpms.dim_unit_dimension",
  description: "A controlled unit and the dimension it measures.",
  base: "canon",
  key: "unit",
  fields: {
    unit: c.UnitCode,
    dimension: f.code("Dimension measured.", "count"),
  },
});

export const CanonUrnNamespace = defineResource({
  name: "CanonUrnNamespace",
  table: "xpms.dim_urn_namespace",
  description: "A URN kind under `urn:xpms`.",
  base: "canon",
  key: "kind",
  fields: {
    kind: f.code("URN kind.", "category"),
    resolves_to: f.text("Table the kind resolves to.", "xpms.dim_category"),
  },
});

export const CanonLocale = defineResource({
  name: "CanonLocale",
  table: "xpms.dim_locale",
  description: "A supported locale.",
  base: "canon",
  key: "locale",
  fields: { locale: f.localeTag(), name: label("Locale name.", "English (United States)") },
});

export const CanonElement = defineResource({
  name: "CanonElement",
  table: "xpms.elements",
  description: "A catalog element, the unit of the catalog.",
  base: "canon",
  key: "element_id",
  fields: {
    element_id: c.ItemId,
    urid: c.Urid,
    item: label("Element name.", "Ground Stage Deck"),
    common_name: label("Common name.", "Stage deck").nullable(),
    kind: f.code("Element kind.", "rental"),
    unit_basis: c.UnitCode,
    grain: c.GrainCode,
    xyz: c.Xyz,
    xyz_basis: f.text("Basis for the XYZ tag.", "Physical inventory"),
  },
});

export const CanonElementPriceBand = defineResource({
  name: "CanonElementPriceBand",
  table: "xpms.element_price_bands",
  description:
    "A price band for an element at one grade. Effective confidence is computed at read time from the staleness policy.",
  base: "canon",
  key: "element_id",
  fields: {
    element_id: c.ItemId,
    grade: c.Grade,
    unit_price_minor: f.money("Band unit price.", 45000),
    currency: f.currency(),
    assertion_rank: f.int("Assertion rank of the price.", 3),
    effective_confidence: c.AssertionLabel.nullable(),
    valid_from: f.date("First day the band is valid."),
    valid_to: f.date("Last day the band is valid.").nullable(),
    region_code: c.RegionCode,
  },
});

export const CanonElementGtin = defineResource({
  name: "CanonElementGtin",
  table: "xpms.element_gtins",
  description: "A GTIN mapped to an element. One GTIN maps to at most one element.",
  base: "canon",
  key: "gtin",
  fields: {
    gtin: z
      .string()
      .regex(/^[0-9]{8,14}$/)
      .meta({ description: "GTIN identifier.", example: "00012345678905" }),
    element_id: c.ItemId,
    confirmed_by: f.text("Ratifier who confirmed the crosswalk.", "Canon Ratifier"),
  },
});

const bridge = (
  name: string,
  table: string,
  description: string,
  fields: Record<string, z.ZodType>,
) => defineResource({ name, table, description, base: "view", fields });

export const CanonElementPhase = bridge(
  "CanonElementPhase",
  "xpms.bridge_element_phase",
  "Phase participation of an element (multi-valued).",
  { element_id: c.ItemId, phase_code: c.PhaseCode },
);
export const CanonElementTag = bridge(
  "CanonElementTag",
  "xpms.bridge_element_tag",
  "A tag carried by an element.",
  { element_id: c.ItemId, tag_id: c.TagId },
);
export const CanonElementPermit = bridge(
  "CanonElementPermit",
  "xpms.bridge_element_permit",
  "A permit rule an element can trigger.",
  { element_id: c.ItemId, rule: f.text("Permit rule name.", "Tent or membrane") },
);
export const CanonElementMetric = bridge(
  "CanonElementMetric",
  "xpms.bridge_element_metric",
  "A metric that applies to an element.",
  { element_id: c.ItemId, item: f.text("Metric item.", "Stage or performance area") },
);
export const CanonTouchpointDiscipline = bridge(
  "CanonTouchpointDiscipline",
  "xpms.bridge_touchpoint_discipline",
  "A discipline that delivers a touchpoint.",
  { touchpoint_id: c.TouchpointId, disc_code: c.DiscCode },
);
export const CanonDisciplineTeam = bridge(
  "CanonDisciplineTeam",
  "xpms.bridge_discipline_team",
  "A canon team that works in a discipline.",
  { disc_code: c.DiscCode, team_id: c.TeamId },
);

const std = (name: string, table: string, description: string, fields: Record<string, z.ZodType>) =>
  defineResource({
    name,
    table,
    description: `${description} Standard Library row, copied into each new org as editable org data.`,
    base: "canon",
    key: "code",
    fields: { code: c.StdCode, ...fields },
  });

export const StdDocument = std(
  "StdDocument",
  "xpms.std_document_library",
  "A document and asset library entry.",
  {
    title: label("Document title.", "Venue Load-In Guide"),
    urid: c.UridAtAnyGrain.nullable(),
  },
);
export const StdEmergencyCode = std(
  "StdEmergencyCode",
  "xpms.std_emergency_code",
  "An emergency code.",
  {
    name: label("Code name.", "Medical Assist"),
    response: f.longText("Response procedure.", "Dispatch the medical team to the location."),
  },
);
export const StdEnumeration = std(
  "StdEnumeration",
  "xpms.std_enumeration",
  "A controlled enumeration value.",
  {
    enumeration: f.code("Enumeration name.", "line_state"),
    value: label("Value.", "Committed"),
  },
);
export const StdLaborRateCard = std(
  "StdLaborRateCard",
  "xpms.std_labor_rate_card",
  "A labor rate card line.",
  {
    role_code: c.RoleCode,
    rate_minor: f.money("Rate per unit.", 4500),
    currency: f.currency(),
    unit: c.UnitCode,
  },
);
export const StdRadioChannel = std(
  "StdRadioChannel",
  "xpms.std_radio_channel",
  "A radio channel plan entry.",
  {
    channel: f.int("Channel number.", 1, 1),
    name: label("Channel name.", "Production"),
  },
);
export const StdRole = std("StdRole", "xpms.std_role", "A Roles Library entry.", {
  role_code: c.RoleCode,
  description: f.longText("Role description.", "Leads rigging for the show."),
});
export const StdSop = std("StdSop", "xpms.std_sop", "A standard operating procedure.", {
  title: label("SOP title.", "Working at Height"),
  body: f.longText("SOP body.", "Inspect the harness before every use."),
});
export const StdVendorClass = std("StdVendorClass", "xpms.std_vendor_class", "A vendor class.", {
  name: label("Vendor class name.", "Staging"),
  counterparty_type: c.CounterpartyType,
});
export const StdVendorEntitlement = std(
  "StdVendorEntitlement",
  "xpms.std_vendor_entitlement",
  "A vendor or sponsor entitlement.",
  {
    name: label("Entitlement name.", "Logo on Main Stage Screen"),
    description: f.longText("Entitlement description.", "Logo shown between sets."),
  },
);
export const StdVerbiage = std(
  "StdVerbiage",
  "xpms.std_verbiage",
  "A controlled vocabulary term.",
  {
    term: label("Term.", "Load-In"),
    usage: f.longText("Usage rule.", "Hyphenate as a noun."),
  },
);

export const CanonProductionTemplate = defineResource({
  name: "CanonProductionTemplate",
  table: "xpms.production_template",
  description: "The XOS 4.0 Production Template, with the Cover Page as metadata.",
  base: "canon",
  key: "template_id",
  fields: {
    template_id: f.code("Template identifier.", "xos-4.0-production"),
    title: label("Template title.", "XOS 4.0 Production Template"),
    sheet_count: f.int("Number of record-template sheets.", 27),
  },
});

export const CanonSupersession = defineResource({
  name: "CanonSupersession",
  table: "xpms.supersession",
  description: "A supersession edge. The graph stays acyclic.",
  base: "canon",
  key: "superseded_code",
  fields: {
    superseded_code: f.code("Code that was superseded.", "DIS"),
    superseded_by: f.code("Code that supersedes it.", "SCP"),
    ratification_id: f.uuid("Ratification that recorded the supersession."),
  },
});

export const CanonRatification = defineResource({
  name: "CanonRatification",
  table: "xpms.ratification",
  description: "A ratification record. 4.0 grammar is proposed until a named ratifier is recorded.",
  base: "canon",
  key: "ratification_id",
  fields: {
    ratification_id: f.uuid("Identifier of the ratification."),
    subject: f.text("What was ratified.", "4.0 phase grammar"),
    ratifier: f.text("Named ratifier.", "Canon Ratifier"),
    ratified_at: f.instant("When it was ratified."),
  },
});

export const CanonVersion = defineResource({
  name: "CanonVersion",
  table: "xpms.version",
  description:
    "The current canon version and generation. Canon responses are cached by generation.",
  base: "canon",
  key: "generation",
  fields: {
    version: f.code("Canon version.", "4.0"),
    generation: f.int("Canon generation, incremented by every canon data migration.", 1, 1),
    imported_at: f.instant("When the generation was imported."),
  },
});

export const CanonIntake = defineResource({
  name: "CanonIntake",
  table: "xpms.intake",
  description: "A proposed canon addition, staged for ratification.",
  base: "global",
  serverSet: ["intake_state"],
  fields: {
    proposed_kind: f.code("What kind of canon value is proposed.", "category"),
    proposed_code: f.code("Proposed code.", "4000.01.50"),
    proposed_label: label("Proposed label.", "Modular Stage Systems"),
    rationale: f.longText(
      "Why the addition is needed.",
      "Several orgs track modular stage systems.",
    ),
    intake_state: f.stateLabel("Intake state.", "Proposed"),
  },
});

/** Derived canon views (Section 7.2). */
export const CoordinateMatrixCell = defineResource({
  name: "CoordinateMatrixCell",
  table: "xpms.v_coordinate_matrix",
  description: "One of 90 coordinates: a department by a phase, counting participation.",
  base: "view",
  fields: {
    dept_code: c.DeptCode,
    phase_code: c.PhaseCode,
    element_count: f.int("Elements participating at the coordinate.", 42),
  },
});

export const PhaseCoverage = defineResource({
  name: "PhaseCoverage",
  table: "xpms.v_phase_coverage",
  description: "Coverage of a phase: Active elements or a declared gap.",
  base: "view",
  fields: {
    phase_code: c.PhaseCode,
    active_element_count: f.int("Active elements in the phase.", 120),
    declared_gap: f.bool("Whether the phase carries a declared gap.", false),
  },
});

export const ElementEconomics = defineResource({
  name: "ElementEconomics",
  table: "xpms.v_element_economics",
  description: "Element economics with effective confidence at read time.",
  base: "view",
  fields: {
    element_id: c.ItemId,
    grade: c.Grade,
    unit_price_minor: f.money("Effective unit price.", 45000),
    currency: f.currency(),
    effective_confidence: c.AssertionLabel.nullable(),
  },
});

export const CrosswalkCoverage = defineResource({
  name: "CrosswalkCoverage",
  table: "xpms.v_crosswalk_coverage",
  description: "Crosswalk coverage from GTIN to GPC brick to UNSPSC to URID.",
  base: "view",
  fields: {
    urid: c.Urid,
    element_count: f.int("Elements under the URID.", 12),
    gtin_mapped_count: f.int("Elements with at least one confirmed GTIN.", 4),
  },
});

export const ElementResolution = defineResource({
  name: "ElementResolution",
  table: "xpms.resolve_element",
  description: "An element resolved from a query or GTIN. No match returns a NO_ANSWER refusal.",
  base: "view",
  fields: {
    element_id: c.ItemId,
    urid: c.Urid,
    item: label("Element name.", "Ground Stage Deck"),
    match: f.code("How the element matched.", "gtin"),
  },
});

export const UrnResolution = defineResource({
  name: "UrnResolution",
  table: "xpms.urn_resolve",
  description: "A URN resolved to its canon row.",
  base: "view",
  fields: {
    urn: c.UrnString,
    kind: f.code("URN kind.", "category"),
    key: f.code("Natural key of the row.", "4000.01.01"),
    label: label("Display label of the row.", "Production Leadership"),
  },
});
