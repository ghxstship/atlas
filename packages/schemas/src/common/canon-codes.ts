/**
 * Canon codes. Every closed list that comes from canon (Section 2) is a string code validated
 * by pattern, never a hand-typed enum: the values live in `xpms` and are loaded by the canon
 * importer. Each schema is registered as a component so the contract names it once.
 */
import { z } from "zod";
import { TITLE_CASE_PATTERN } from "./fields.ts";

function canonCode(id: string, pattern: RegExp, description: string, example: string) {
  return z.string().regex(pattern).meta({ id, description, example });
}

function canonLabel(id: string, description: string, example: string) {
  return canonCode(id, new RegExp(TITLE_CASE_PATTERN), description, example);
}

export const DeptCode = canonCode(
  "DeptCode",
  /^[0-9]000$/,
  "Department class code from `xpms.dim_department` (Section 3.2).",
  "4000",
);

export const DiscCode = canonCode(
  "DiscCode",
  /^[0-9]000\.[0-9]{2}$/,
  "Discipline code `DDDD.DD` from `xpms.dim_discipline`. Canon holds .01 to .49; tenant extensions hold .50 to .99.",
  "4000.01",
);

export const Urid = canonCode(
  "Urid",
  /^[0-9]000\.[0-9]{2}\.[0-9]{2}$/,
  "Category URID `DDDD.DD.DD` from `xpms.dim_category` (Section 3.3). There is no fourth segment.",
  "4000.01.01",
);

export const UridAtAnyGrain = canonCode(
  "UridAtAnyGrain",
  /^[0-9]000(\.[0-9]{2}){1,2}$/,
  "URID at discipline grain (`DDDD.DD`) or category grain (`DDDD.DD.DD`), as GL dimension 2 allows.",
  "4000.01",
);

export const PhaseCode = canonCode(
  "PhaseCode",
  /^[A-Z]{3}$/,
  "Phase code from `xpms.dim_phase`, ordered by gate ordinal.",
  "SCP",
);

export const ActCode = canonCode("ActCode", /^[A-Z]+$/, "Act from `xpms.dim_act`.", "PLAN");

export const CriterionId = canonCode(
  "CriterionId",
  /^G[1-9]\.[A-Z0-9_]+$/,
  "Gate criterion identifier from `xpms.dim_gate_criterion`.",
  "G1.BUDGET_ENVELOPE",
);

export const TierCode = canonCode(
  "TierCode",
  /^[0-9]{2}$/,
  "Tier of experience code from `xpms.dim_tier`.",
  "04",
);

export const TeamId = canonCode(
  "TeamId",
  /^[0-9]000-T[0-9]{2}$/,
  "Canon team identifier from `xpms.dim_team`.",
  "4000-T01",
);

export const TagId = canonCode(
  "TagId",
  /^TAG-[0-9]{3}$/,
  "Sustainability or compliance tag from `xpms.dim_tag`.",
  "TAG-002",
);

export const TouchpointId = canonCode(
  "TouchpointId",
  /^[A-Z]{3}-[0-9]{2}$/,
  "Five-sense touchpoint identifier from `xpms.dim_touchpoint`.",
  "SGT-01",
);

export const JurisdictionId = canonCode(
  "JurisdictionId",
  /^[A-Z]{2}(-[A-Z0-9]+)*$/,
  "Jurisdiction identifier from `xpms.dim_jurisdiction`. An unpopulated jurisdiction returns no answer.",
  "US-FL",
);

export const RegionCode = canonCode(
  "RegionCode",
  /^[A-Z]{2}(-[A-Z0-9]+)+$/,
  "Cost region code from `xpms.dim_region`.",
  "NA-SE-MIA",
);

export const RoleCode = canonCode(
  "RoleCode",
  /^[0-9]000\.[0-9]{2}\.[0-9]{2}$/,
  "Workforce role code from `xpms.dim_role`, on URID grammar.",
  "5000.50.01",
);

export const GlAccountCode = canonCode(
  "GlAccountCode",
  /^[0-9]{4}$/,
  "GL account code from the fixed chart in `xpms.dim_gl_account` (Section 3.11).",
  "5400",
);

export const CostCenterCode = canonCode(
  "CostCenterCode",
  /^CC-[A-Z0-9-]+$/,
  "Cost center identifier (GL dimension 1).",
  "CC-VENUE",
);

export const ItemId = canonCode(
  "ItemId",
  /^[0-9]000\.[0-9]{2}\.[0-9]{2}-[A-Z0-9]+-[0-9]+$/,
  "Catalog item identifier `{URID}-{ORG}-{SEQ}` (Section 3.6).",
  "4000.01.01-XPMS-001",
);

export const RecordKind = canonLabel(
  "RecordKind",
  "Record kind from `xpms.dim_record_kind` (26 kinds, Section 3.10).",
  "Task",
);

export const RecordSubtype = canonLabel(
  "RecordSubtype",
  "Kind-scoped record subtype from `xpms.dim_record_subtype`. A subtype of one kind cannot be stored on another.",
  "Design",
);

export const RecordClass = canonLabel(
  "RecordClass",
  "Record class from `xpms.dim_record_kind`, derived from the kind.",
  "Work",
);

export const CounterpartyType = canonLabel(
  "CounterpartyType",
  "Counterparty type from `xpms.dim_counterparty_type`.",
  "AV Integrator",
);

export const Provenance = canonCode(
  "Provenance",
  /^[a-z]+$/,
  "Provenance from `xpms.dim_provenance` (Section 3.8); a lower rank never overwrites a higher one.",
  "operator",
);

export const AssertionLabel = canonCode(
  "AssertionLabel",
  /^[A-Z]+$/,
  "Assertion label from `xpms.dim_assertion_rank` (Section 3.8).",
  "QUOTED",
);

export const Grade = canonLabel(
  "Grade",
  "Price band grade from `xpms.element_price_bands`.",
  "Elevated",
);

export const GrainCode = canonCode(
  "GrainCode",
  /^[a-z]+$/,
  "Grain from `xpms.dim_grain` (Section 3.9).",
  "unit",
);

export const Xyz = canonCode(
  "Xyz",
  /^[XYZ]$/,
  "XYZ schema-family tag (Section 3.6): X Resource, Y Process, Z Timeline.",
  "X",
);

export const UnitCode = canonCode(
  "UnitCode",
  /^[a-z][a-z0-9_-]*$/,
  "Unit basis from the controlled unit list in `xpms.dim_unit_alias`.",
  "each",
);

export const SharedState = canonLabel(
  "SharedState",
  "A value from the shared finance and commercial state vocabulary (Bible tab 37): the five core states plus declared domain extensions.",
  "Committed",
);

export const LineType = canonLabel(
  "LineType",
  "Budget line type from the budget template specification (Bible tab 34). Fee and Contingency are line types, not accounts.",
  "Contingency",
);

export const TaxType = canonLabel(
  "TaxType",
  "Tax type from the Universal Posting Line specification (Bible tab 36).",
  "Tax on Purchases",
);

export const UrnString = canonCode(
  "Urn",
  /^urn:xpms:[a-z_]+:.+$/,
  "URN in the `urn:xpms` namespace.",
  "urn:xpms:category:4000.01.01",
);

export const StdCode = canonCode(
  "StdCode",
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  "Natural code of a Standard Library row (Section 2.1).",
  "SOP-001",
);
