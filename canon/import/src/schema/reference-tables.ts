import { sourceMeta } from "./canon-tables.ts";
import type { ColumnSpec, TableSpec } from "./types.ts";

/**
 * Tables of the owner's canon reference model (design/xos-design-system/export/canon/
 * 0100_xpms_canon.sql, decisions D11 to D17 and D19), ported to ADR 0002: every table,
 * key, constraint and view is kept, codes use canon domains, money is bigint minor
 * units with a currency, and Playbook columns the model does not name are kept as
 * extra columns so no Playbook value is lost.
 */

const playbookExtras = (sheet: string, cols: readonly [string, string][]): ColumnSpec[] =>
  cols.map(([name, header]) => ({
    name,
    type: name === "flag" ? ("bool" as const) : ("text" as const),
    nullable: true,
    comment: `${header} from the Playbook ${sheet} sheet.`,
  }));

const money = (name: string, label: string): ColumnSpec => ({
  name,
  type: "minor",
  nullable: true,
  comment: `${label} in minor units of currency_code; NULL is unpriced.`,
  check: `${name} >= 0`,
});

export const REFERENCE_TABLES: readonly TableSpec[] = [
  {
    name: "jurisdiction_code_set",
    comment:
      "Code sets a jurisdiction adopts, one row each (Bible tab 11, primary_code_sets), in their stated order.",
    primaryKey: ["jurisdiction_id", "code_set"],
    unique: [["jurisdiction_id", "sort_order"]],
    orderBy: ["jurisdiction_id", "sort_order"],
    columns: [
      {
        name: "jurisdiction_id",
        type: "code",
        references: "jurisdiction(jurisdiction_id)",
        onDelete: "cascade",
        comment: "Jurisdiction adopting the code set.",
      },
      { name: "code_set", type: "text", comment: "Code set name." },
      {
        name: "sort_order",
        type: "int",
        comment: "Position in the Bible's list.",
        check: "sort_order > 0",
      },
    ],
  },
  {
    name: "agency_function",
    comment: "Functions an agency serves: emergency responders and regulators (decision D15).",
    primaryKey: ["function"],
    unique: [["label"], ["sort_order"]],
    orderBy: ["sort_order"],
    columns: [
      {
        name: "function",
        type: "code",
        comment: "Function token, as protocol steps name it ({fire}, {ems}).",
      },
      { name: "label", type: "text", comment: "Function label." },
      { name: "responder", type: "bool", comment: "True for emergency responders." },
      { name: "sort_order", type: "int", comment: "Display order." },
    ],
  },
  {
    name: "jurisdiction_agency",
    comment:
      "The agency serving each function in a jurisdiction, reached through the project's venue (decisions D15 and D19).",
    primaryKey: ["jurisdiction_id", "function"],
    columns: [
      {
        name: "jurisdiction_id",
        type: "code",
        references: "jurisdiction(jurisdiction_id)",
        comment: "Jurisdiction served.",
      },
      {
        name: "function",
        type: "code",
        references: "agency_function(function)",
        comment: "Function served.",
      },
      { name: "agency", type: "text", comment: "Agency name, as canon names it." },
      { name: "contact", type: "text", nullable: true, comment: "Contact number, where stated." },
    ],
  },
  {
    name: "wage_hour_rule",
    comment:
      "Wage-and-hour minimums a jurisdiction adds to its parent; the strictest value up the chain governs (decision D16).",
    primaryKey: ["jurisdiction_id"],
    checks: [
      "daily_dt_after_hours is null or daily_ot_after_hours is null or daily_dt_after_hours > daily_ot_after_hours",
      "min_dt_multiplier is null or min_ot_multiplier is null or min_dt_multiplier >= min_ot_multiplier",
    ],
    columns: [
      {
        name: "jurisdiction_id",
        type: "code",
        references: "jurisdiction(jurisdiction_id)",
        comment: "Jurisdiction stating the rule.",
      },
      { name: "source", type: "text", comment: "Law the rule comes from." },
      {
        name: "weekly_ot_after_hours",
        type: "numeric",
        nullable: true,
        comment: "Weekly hours after which overtime applies.",
        check: "weekly_ot_after_hours > 0",
      },
      {
        name: "daily_ot_after_hours",
        type: "numeric",
        nullable: true,
        comment: "Daily hours after which overtime applies.",
        check: "daily_ot_after_hours > 0",
      },
      {
        name: "daily_dt_after_hours",
        type: "numeric",
        nullable: true,
        comment: "Daily hours after which double time applies.",
      },
      {
        name: "min_ot_multiplier",
        type: "numeric",
        nullable: true,
        comment: "Minimum overtime multiplier.",
        check: "min_ot_multiplier >= 1",
      },
      {
        name: "min_dt_multiplier",
        type: "numeric",
        nullable: true,
        comment: "Minimum double-time multiplier.",
      },
    ],
  },
  {
    name: "organization_type",
    comment: "Legal forms of an organization (decision D17).",
    primaryKey: ["label"],
    columns: [{ name: "label", type: "text", comment: "Organization type." }],
  },
  {
    name: "worker_classification",
    comment:
      "The legal relationship of a worker, independent of pay computation and schedule (decision D16). Codes are jurisdiction-neutral.",
    primaryKey: ["code"],
    unique: [["label"], ["sort_order"]],
    orderBy: ["sort_order"],
    checks: ["not is_employee or payment_channel = 'Payroll'"],
    columns: [
      { name: "code", type: "code", comment: "Classification code.", check: "code ~ '^[A-Z_]+$'" },
      { name: "label", type: "text", comment: "Classification label." },
      { name: "is_employee", type: "bool", comment: "True for an employment relationship." },
      {
        name: "payment_channel",
        type: "text",
        comment: "Payroll, Accounts Payable or None.",
        check: "payment_channel in ('Payroll', 'Accounts Payable', 'None')",
      },
      { name: "sort_order", type: "int", comment: "Display order." },
    ],
  },
  {
    name: "classification_document",
    comment: "Country documents a classification requires (W-4, I-9, W-2, W-9, 1099-NEC).",
    primaryKey: ["worker_classification", "country", "document"],
    columns: [
      {
        name: "worker_classification",
        type: "code",
        references: "worker_classification(code)",
        comment: "Classification.",
      },
      {
        name: "country",
        type: "code",
        references: "jurisdiction(jurisdiction_id)",
        comment: "Declared country the document belongs to.",
      },
      { name: "document", type: "text", comment: "Document name." },
      {
        name: "purpose",
        type: "text",
        comment: "Onboarding or Year-End.",
        check: "purpose in ('Onboarding', 'Year-End')",
      },
    ],
  },
  {
    name: "classification_organization_type",
    comment:
      "Which organization types may use each worker classification; Volunteer only for Nonprofit and Public Agency (rule XOS-ENG-6).",
    primaryKey: ["worker_classification", "organization_type"],
    columns: [
      {
        name: "worker_classification",
        type: "code",
        references: "worker_classification(code)",
        comment: "Classification.",
      },
      {
        name: "organization_type",
        type: "text",
        references: "organization_type(label)",
        comment: "Organization type allowed to use it.",
      },
    ],
  },
  {
    name: "pay_basis",
    comment: "How pay is computed (decision D16).",
    primaryKey: ["label"],
    columns: [{ name: "label", type: "text", comment: "Pay basis." }],
  },
  {
    name: "arrangement",
    comment:
      "The commercial arrangement: a standing retainer or per-engagement work (decision D16).",
    primaryKey: ["label"],
    columns: [{ name: "label", type: "text", comment: "Arrangement." }],
  },
  {
    name: "pay_basis_classification",
    comment:
      "Lawful or permitted pairs of pay basis and classification. A rate card must match a row.",
    primaryKey: ["pay_basis", "worker_classification"],
    columns: [
      { name: "pay_basis", type: "text", references: "pay_basis(label)", comment: "Pay basis." },
      {
        name: "worker_classification",
        type: "code",
        references: "worker_classification(code)",
        comment: "Classification.",
      },
    ],
  },
  {
    name: "arrangement_classification",
    comment:
      "Permitted pairs of arrangement and classification; Retainer is Independent Contractor only.",
    primaryKey: ["arrangement", "worker_classification"],
    columns: [
      {
        name: "arrangement",
        type: "text",
        references: "arrangement(label)",
        comment: "Arrangement.",
      },
      {
        name: "worker_classification",
        type: "code",
        references: "worker_classification(code)",
        comment: "Classification.",
      },
    ],
  },
  {
    name: "overtime_rule",
    comment:
      "Overtime and double-time multipliers, stored once as numbers (decision D14). 1.5x is display formatting.",
    primaryKey: ["rule_id"],
    unique: [["name"], ["ot_multiplier", "dt_multiplier"]],
    checks: ["dt_multiplier >= ot_multiplier"],
    columns: [
      {
        name: "rule_id",
        type: "code",
        comment: "Rule code OTR-nnn.",
        check: "rule_id ~ '^OTR-[0-9]{3}$'",
      },
      { name: "name", type: "text", comment: "Rule name." },
      {
        name: "ot_multiplier",
        type: "numeric",
        comment: "Overtime multiplier.",
        check: "ot_multiplier >= 1",
      },
      { name: "dt_multiplier", type: "numeric", comment: "Double-time multiplier." },
    ],
  },
  {
    name: "role_discipline",
    comment: "Disciplines of the Roles Library, each stored once (decision D12).",
    primaryKey: ["name"],
    columns: [{ name: "name", type: "text", comment: "Discipline label." }],
  },
  {
    name: "role_rank",
    comment: "Ranks of the Roles Library, each stored once (decision D12).",
    primaryKey: ["label"],
    columns: [{ name: "label", type: "text", comment: "Rank label." }],
  },
  {
    name: "role",
    comment:
      "The Roles Library (decision D12): owns role codes and job titles. Department derives from the code and is not stored.",
    primaryKey: ["role_code"],
    unique: [["source_row"]],
    columns: [
      {
        name: "role_code",
        type: "code",
        comment: "Role code DDDD.DD.DD.",
        check: "role_code ~ '^[0-9]000\\.[0-9]{2}\\.[0-9]{2}$'",
      },
      {
        name: "class_code",
        type: "code",
        references: "dim_department(dept_code)",
        comment: "Department class, derived from the role code.",
        generated: "(left(role_code, 4))",
      },
      { name: "job_title", type: "text", comment: "Job title; the one home of the title." },
      {
        name: "discipline",
        type: "text",
        references: "role_discipline(name)",
        comment: "Discipline.",
      },
      { name: "rank", type: "text", references: "role_rank(label)", comment: "Rank." },
      ...playbookExtras("Roles Library", [
        ["job_summary", "JOB SUMMARY"],
        ["key_responsibilities", "KEY RESPONSIBILITIES"],
        ["qualifications", "QUALIFICATIONS"],
        ["physical_requirements", "PHYSICAL REQUIREMENTS"],
        ["required_certifications", "REQUIRED CERTIFICATIONS"],
        ["default_clearance_tier", "DEFAULT CLEARANCE TIER"],
        ["default_radio_channel", "DEFAULT RADIO CHANNEL"],
        ["flag", "FLAG"],
        ["notes", "NOTES"],
      ]),
      ...sourceMeta,
    ],
  },
  {
    name: "rate_card",
    comment:
      "Labor Rate Cards (decisions D12 to D14 and D16): only the card's own facts. Title, department, GL account and multipliers are joined or derived.",
    primaryKey: ["rate_card_id"],
    unique: [["role_code", "worker_classification", "pay_basis", "arrangement"], ["source_row"]],
    foreignKeys: [
      {
        columns: ["pay_basis", "worker_classification"],
        table: "pay_basis_classification",
        targets: ["pay_basis", "worker_classification"],
      },
      {
        columns: ["arrangement", "worker_classification"],
        table: "arrangement_classification",
        targets: ["arrangement", "worker_classification"],
      },
    ],
    checks: [
      "max_grade_rate_minor is null or min_grade_rate_minor is null or max_grade_rate_minor >= min_grade_rate_minor",
    ],
    columns: [
      {
        name: "rate_card_id",
        type: "code",
        comment: "Rate card code LRC-nnn.",
        check: "rate_card_id ~ '^LRC-[0-9]{3}$'",
      },
      {
        name: "role_code",
        type: "code",
        references: "role(role_code)",
        comment: "Role the card prices.",
      },
      {
        name: "worker_classification",
        type: "code",
        comment: "Classification of the engagement the card prices.",
      },
      { name: "pay_basis", type: "text", comment: "How pay is computed." },
      { name: "arrangement", type: "text", comment: "Retainer or per engagement." },
      money("standard_rate_minor", "Standard rate"),
      money("min_grade_rate_minor", "Lowest grade rate"),
      money("max_grade_rate_minor", "Highest grade rate"),
      money("per_diem_rate_minor", "Per diem"),
      {
        name: "currency_code",
        type: "currency",
        comment: "ISO 4217 currency of the amounts; the Playbook states US dollars.",
      },
      {
        name: "overtime_rule_id",
        type: "code",
        references: "overtime_rule(rule_id)",
        comment: "Overtime rule the card follows.",
      },
      ...playbookExtras("Labor Rate Cards", [
        ["flag", "FLAG"],
        ["notes", "NOTES"],
      ]),
      ...sourceMeta,
    ],
  },
  {
    name: "emergency_code",
    comment:
      "Emergency codes, global: no organization, project or jurisdiction (decision D15). Numeric sort order.",
    primaryKey: ["code"],
    unique: [["label"], ["swatch"], ["sort_order"]],
    orderBy: ["sort_order"],
    columns: [
      {
        name: "code",
        type: "code",
        comment: "Code token, such as CODE_RED.",
        check: "code ~ '^CODE_[A-Z]+$'",
      },
      { name: "label", type: "text", comment: "Code word, such as Code Red." },
      { name: "emergency", type: "text", comment: "The emergency the code announces." },
      {
        name: "swatch",
        type: "code",
        comment: "Design token of the swatch (ecode-*).",
        check: "swatch ~ '^ecode-[a-z]+$'",
      },
      { name: "sort_order", type: "int", comment: "Order of first appearance in the Playbook." },
    ],
  },
  {
    name: "operational_domain",
    comment: "Operational domains an emergency protocol is written for.",
    primaryKey: ["domain"],
    unique: [["sort_order"]],
    orderBy: ["sort_order"],
    columns: [
      { name: "domain", type: "text", comment: "Domain name." },
      { name: "sort_order", type: "int", comment: "Order of first appearance in the Playbook." },
    ],
  },
  {
    name: "emergency_protocol",
    comment:
      "The protocol for one code in one operational domain. Global; agencies are resolved per jurisdiction.",
    primaryKey: ["record_key"],
    unique: [["code", "domain"], ["source_row"]],
    columns: [
      {
        name: "record_key",
        type: "code",
        comment: "Protocol key EMG-nnn.",
        check: "record_key ~ '^EMG-[0-9]{3}$'",
      },
      {
        name: "code",
        type: "code",
        references: "emergency_code(code)",
        comment: "Emergency code.",
      },
      {
        name: "domain",
        type: "text",
        references: "operational_domain(domain)",
        comment: "Operational domain.",
      },
      ...playbookExtras("Emergency Codes", [
        ["department", "DEPARTMENT"],
        ["category", "CATEGORY"],
        ["sub_category", "SUB CATEGORY"],
        ["flag", "FLAG"],
        ["notes", "NOTES"],
      ]),
      ...sourceMeta,
    ],
  },
  {
    name: "emergency_protocol_step",
    comment:
      "Numbered protocol steps. Steps name services ({fire}, {ems}, {lawEnforcement}, {bombSquad}, {federal}), never an agency.",
    primaryKey: ["record_key", "step_no"],
    columns: [
      {
        name: "record_key",
        type: "code",
        references: "emergency_protocol(record_key)",
        onDelete: "cascade",
        comment: "Protocol.",
      },
      { name: "step_no", type: "int", comment: "Step number.", check: "step_no >= 1" },
      { name: "body", type: "text", comment: "Step text, sentence case." },
    ],
  },
];
