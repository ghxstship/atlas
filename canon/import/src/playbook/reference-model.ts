import type { Cell } from "../cell.ts";
import type { Findings } from "../doctrine.ts";
import { canonText } from "../doctrine.ts";
import { sheetGrid } from "../manifest.ts";
import { rawText, toMinorUnits } from "../model/values.ts";
import { normalizeCell, normalizeNumber } from "../normalize.ts";
import type { Rulings } from "../rulings.ts";
import type { SqlRow } from "../sql.ts";
import { getCell, sheetByName } from "../workbook.ts";
import type { SheetData, WorkbookData } from "../workbook.ts";

/**
 * Builds the owner's reference model tables (decisions D12 to D17) from the
 * Playbook and the rulings, and records every Playbook value a ruling changes
 * in the migration report (canon/reports/migration-report.txt).
 */

export interface ReferenceResult {
  readonly tables: Map<string, SqlRow[]>;
  readonly report: string[];
}

type Row = Record<string, string | boolean | null>;

class SheetRows {
  readonly sheet: SheetData;
  readonly headers: readonly string[];
  readonly rows: readonly number[];

  constructor(workbook: WorkbookData, name: string) {
    this.sheet = sheetByName(workbook, name);
    const grid = sheetGrid(this.sheet);
    this.headers = grid.headers;
    this.rows = grid.dataRows;
  }

  cell(row: number, header: string): Cell {
    const i = this.headers.indexOf(header);
    if (i < 0) throw new Error(`${this.sheet.name} has no column ${header}`);
    return getCell(this.sheet, row, i + 1);
  }

  text(row: number, header: string, findings: Findings): string | null {
    const v = rawText(this.cell(row, header));
    return v === null
      ? null
      : canonText(v, `Playbook ${this.sheet.name} row ${row} ${header}`, findings);
  }

  req(row: number, header: string, findings: Findings): string {
    const v = this.text(row, header, findings);
    if (v === null) throw new Error(`Playbook ${this.sheet.name} row ${row} ${header} is blank`);
    return v;
  }

  stamp(row: number, findings: Findings): Row {
    const at = (h: string) => {
      const c = this.cell(row, h);
      return c.kind === "date" || c.kind === "datetime" ? c.text : null;
    };
    const flag = this.cell(row, "FLAG");
    return {
      flag: flag.kind === "boolean" ? flag.text === "TRUE" : null,
      notes: this.text(row, "NOTES", findings),
      source_row: String(row),
      source_status: this.text(row, "STATUS", findings),
      source_created_by: this.text(row, "CREATED BY", findings),
      source_created_at: at("CREATED AT"),
      source_updated_at: at("UPDATED AT"),
    };
  }
}

/** A multiplier cell as a decimal: 1.5 and the text "1.5x" are both 1.5. */
export function multiplier(cell: Cell): { value: string; wasText: boolean } {
  if (cell.kind === "number") return { value: normalizeNumber(Number(cell.text)), wasText: false };
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*x\s*$/i.exec(cell.text);
  if (!m?.[1]) throw new Error(`"${cell.text}" is not a multiplier`);
  return { value: normalizeNumber(Number(m[1])), wasText: true };
}

/** Splits "Actions: 1. First. 2. Second." into its numbered steps. */
export function protocolSteps(text: string): string[] {
  const body = text.replace(/^\s*Actions:\s*/i, "");
  const parts = ` ${body}`.split(/\s(\d+)\.\s+/);
  const steps: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const n = Number(parts[i]);
    if (n !== steps.length + 1) throw new Error(`Protocol step ${n} is out of order in "${text}"`);
    steps.push((parts[i + 1] ?? "").trim());
  }
  if (steps.length === 0) throw new Error(`No numbered steps in "${text}"`);
  return steps;
}

export function applyServiceTokens(
  step: string,
  tokens: Rulings["emergency_service_tokens"],
): string {
  let out = step;
  for (const [phrase, token] of tokens) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, "g"), token);
  }
  return out;
}

function titleCase(words: string): string {
  return words
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function rulingTables(rulings: Rulings, tables: Map<string, SqlRow[]>): void {
  tables.set(
    "worker_classification",
    rulings.worker_classifications.map((w) => ({
      code: w.code,
      label: w.label,
      is_employee: w.is_employee,
      payment_channel: w.payment_channel,
      sort_order: String(w.sort_order),
    })),
  );
  tables.set(
    "classification_document",
    rulings.classification_documents.map(([worker_classification, country, document, purpose]) => ({
      worker_classification,
      country,
      document,
      purpose,
    })),
  );
  tables.set(
    "pay_basis",
    rulings.pay_bases.map((label) => ({ label })),
  );
  tables.set(
    "arrangement",
    rulings.arrangements.map((label) => ({ label })),
  );
  tables.set(
    "pay_basis_classification",
    rulings.pay_basis_classifications.map(([pay_basis, worker_classification]) => ({
      pay_basis,
      worker_classification,
    })),
  );
  tables.set(
    "arrangement_classification",
    rulings.arrangement_classifications.map(([arrangement, worker_classification]) => ({
      arrangement,
      worker_classification,
    })),
  );
  tables.set(
    "organization_type",
    rulings.organization_types.map((label) => ({ label })),
  );
  tables.set(
    "classification_organization_type",
    rulings.classification_organization_types.map(([worker_classification, organization_type]) => ({
      worker_classification,
      organization_type,
    })),
  );
  tables.set(
    "wage_hour_rule",
    rulings.wage_hour_rules.map((w) => ({
      jurisdiction_id: w["jurisdiction_id"] ?? null,
      source: w["source"] ?? null,
      weekly_ot_after_hours: w["weekly_ot_after_hours"] ?? null,
      daily_ot_after_hours: w["daily_ot_after_hours"] ?? null,
      daily_dt_after_hours: w["daily_dt_after_hours"] ?? null,
      min_ot_multiplier: w["min_ot_multiplier"] ?? null,
      min_dt_multiplier: w["min_dt_multiplier"] ?? null,
    })),
  );
  tables.set(
    "agency_function",
    rulings.agency_functions.map(([fn, label, responder, sort]) => ({
      function: fn,
      label,
      responder,
      sort_order: String(sort),
    })),
  );
  tables.set(
    "jurisdiction_agency",
    rulings.jurisdiction_agencies.map(([jurisdiction_id, fn, agency, contact]) => ({
      jurisdiction_id,
      function: fn,
      agency,
      contact,
    })),
  );
}

function buildRoles(
  workbook: WorkbookData,
  tables: Map<string, SqlRow[]>,
  findings: Findings,
  report: string[],
): void {
  const s = new SheetRows(workbook, "Roles Library");
  const disciplines = new Set<string>();
  const ranks = new Set<string>();
  const depts = tables.get("dim_department") ?? [];
  const roles: SqlRow[] = s.rows.map((r) => {
    const code = s.req(r, "ROLE CODE", findings);
    const title = s.req(r, "JOB TITLE", findings);
    const discipline = s.req(r, "DISCIPLINE", findings);
    const rank = s.req(r, "RANK", findings);
    disciplines.add(discipline);
    ranks.add(rank);
    const stated = s.text(r, "DEPARTMENT", findings) ?? "";
    const dept = depts.find((d) => d["dept_code"] === code.slice(0, 4));
    const derived = `${code.slice(0, 4)} ${String(dept?.["department"] ?? "")}`;
    if (stated !== derived) {
      report.push(
        `Roles Library ${code} ${title}: stored department ${stated} dropped; class ${derived} derives from the code.`,
      );
    }
    return {
      role_code: code,
      job_title: title,
      discipline,
      rank,
      job_summary: s.text(r, "JOB SUMMARY", findings),
      key_responsibilities: s.text(r, "KEY RESPONSIBILITIES", findings),
      qualifications: s.text(r, "QUALIFICATIONS", findings),
      physical_requirements: s.text(r, "PHYSICAL REQUIREMENTS", findings),
      required_certifications: s.text(r, "REQUIRED CERTIFICATIONS", findings),
      default_clearance_tier: s.text(r, "DEFAULT CLEARANCE TIER", findings),
      default_radio_channel: s.text(r, "DEFAULT RADIO CHANNEL", findings),
      ...s.stamp(r, findings),
    };
  });
  tables.set(
    "role_discipline",
    [...disciplines].sort().map((name) => ({ name })),
  );
  tables.set(
    "role_rank",
    [...ranks].sort().map((label) => ({ label })),
  );
  tables.set("role", roles);
  report.push(
    `Roles Library: Discipline (${disciplines.size} values) and Rank (${ranks.size} values) become the role_discipline and role_rank lists; every role references them. Values unchanged.`,
  );
}

function buildRateCards(
  workbook: WorkbookData,
  rulings: Rulings,
  tables: Map<string, SqlRow[]>,
  findings: Findings,
  report: string[],
): void {
  const s = new SheetRows(workbook, "Labor Rate Cards");
  const roles = tables.get("role") ?? [];
  const accounts = tables.get("dim_gl_account") ?? [];
  const typeCounts = new Map<string, number>();
  let textMultipliers = 0;
  const used = new Set<string>();
  const cards: SqlRow[] = s.rows.map((r) => {
    const id = s.req(r, "RATE CARD ID", findings);
    const roleCode = s.req(r, "ROLE CODE", findings);
    const role = roles.find((x) => x["role_code"] === roleCode);
    if (!role)
      throw new Error(
        `Labor Rate Card ${id} names role ${roleCode}, which is not in the Roles Library`,
      );
    const type = s.req(r, "ENGAGEMENT TYPE", findings);
    const mapped = rulings.engagement_types[type];
    if (!mapped) throw new Error(`Labor Rate Card ${id} engagement type "${type}" has no ruling`);
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    const ot = multiplier(s.cell(r, "OT MULTIPLIER"));
    const dt = multiplier(s.cell(r, "DT MULTIPLIER"));
    if (ot.wasText || dt.wasText) textMultipliers += 1;
    const rule = rulings.overtime_rules.find(
      (o) =>
        normalizeNumber(Number(o.ot_multiplier)) === ot.value &&
        normalizeNumber(Number(o.dt_multiplier)) === dt.value,
    );
    if (!rule)
      throw new Error(
        `Labor Rate Card ${id} multipliers ${ot.value} and ${dt.value} match no overtime rule`,
      );
    used.add(rule.rule_id);
    const statedGl = normalizeCell(s.cell(r, "DEFAULT GL ACCOUNT"));
    const derived = accounts.find(
      (a) =>
        a["account_type"] === "Expense" &&
        a["account_code"]?.toString().slice(1, 2) === roleCode.slice(0, 1),
    );
    if (derived && statedGl !== derived["account_code"]) {
      report.push(
        `Labor Rate Cards ${id} ${roleCode} ${String(role["job_title"])}: stored GL ${statedGl}; derived GL ${String(derived["account_code"])} ${String(derived["account_name"])}.`,
      );
    }
    const titleStated = s.text(r, "JOB TITLE", findings);
    if (titleStated !== role["job_title"]) {
      findings.add(
        "conflict",
        `Playbook Labor Rate Cards row ${r} JOB TITLE`,
        `${id} states "${titleStated ?? ""}"; the Roles Library title "${String(role["job_title"])}" governs (ruling D12).`,
      );
    }
    const amount = (h: string) => {
      const c = s.cell(r, h);
      return c.kind === "number" ? toMinorUnits(normalizeNumber(Number(c.text))) : null;
    };
    return {
      rate_card_id: id,
      role_code: roleCode,
      worker_classification: mapped.worker_classification,
      pay_basis: s.req(r, "PAY BASIS", findings),
      arrangement: mapped.arrangement,
      standard_rate_minor: amount("STANDARD RATE"),
      min_grade_rate_minor: amount("MIN GRADE RATE"),
      max_grade_rate_minor: amount("MAX GRADE RATE"),
      per_diem_rate_minor: amount("PER DIEM RATE"),
      currency_code: "USD",
      overtime_rule_id: rule.rule_id,
      ...s.stamp(r, findings),
    };
  });
  tables.set(
    "overtime_rule",
    rulings.overtime_rules.map((o) => ({
      rule_id: o.rule_id,
      name: o.name,
      ot_multiplier: o.ot_multiplier,
      dt_multiplier: o.dt_multiplier,
    })),
  );
  tables.set("rate_card", cards);
  for (const [type, n] of typeCounts) {
    const m = rulings.engagement_types[type];
    const label =
      rulings.worker_classifications.find((w) => w.code === m?.worker_classification)?.label ?? "";
    report.push(
      `Labor Rate Cards: engagement type "${type}" (${n} rows) becomes classification ${label}, arrangement ${m?.arrangement ?? ""}; pay basis unchanged.`,
    );
  }
  report.push(
    `Labor Rate Cards: ${textMultipliers} rows stored multipliers as text ("1.5x"); all ${cards.length} now reference an overtime rule.`,
  );
}

function buildEmergency(
  workbook: WorkbookData,
  rulings: Rulings,
  tables: Map<string, SqlRow[]>,
  findings: Findings,
  report: string[],
): void {
  const s = new SheetRows(workbook, "Emergency Codes");
  const codes: Row[] = [];
  const domains: Row[] = [];
  const protocols: Row[] = [];
  const steps: Row[] = [];
  const tokenized: string[] = [];
  for (const r of s.rows) {
    const call = s.req(r, "RADIO CALL", findings);
    const code = call.trim().toUpperCase().replace(/\s+/g, "_");
    const emergency = s.req(r, "EMERGENCY", findings);
    const existing = codes.find((c) => c["code"] === code);
    if (!existing) {
      codes.push({
        code,
        label: titleCase(call),
        emergency,
        swatch: `ecode-${code.slice(5).toLowerCase()}`,
        sort_order: String(codes.length + 1),
      });
    } else if (existing["emergency"] !== emergency) {
      findings.add(
        "conflict",
        `Playbook Emergency Codes row ${r} EMERGENCY`,
        `${code} is "${emergency}" here and "${String(existing["emergency"])}" on its first row.`,
      );
    }
    const domain = s.req(r, "OPERATIONAL DOMAIN", findings);
    if (!domains.some((d) => d["domain"] === domain))
      domains.push({ domain, sort_order: String(domains.length + 1) });
    const key = s.req(r, "RECORD ID", findings);
    protocols.push({
      record_key: key,
      code,
      domain,
      department: s.text(r, "DEPARTMENT", findings),
      category: s.text(r, "CATEGORY", findings),
      sub_category: s.text(r, "SUB CATEGORY", findings),
      ...s.stamp(r, findings),
    });
    protocolSteps(s.req(r, "ACTION PROTOCOL", findings)).forEach((body, i) => {
      const tokenizedBody = applyServiceTokens(body, rulings.emergency_service_tokens);
      if (tokenizedBody !== body && !tokenized.includes(key)) tokenized.push(key);
      steps.push({ record_key: key, step_no: String(i + 1), body: tokenizedBody });
    });
  }
  tables.set("emergency_code", codes);
  tables.set("operational_domain", domains);
  tables.set("emergency_protocol", protocols);
  tables.set("emergency_protocol_step", steps);
  report.push(
    `Emergency Codes: ${protocols.length} protocols (${codes.length} codes x ${domains.length} domains) made global; organization and project columns dropped; ${steps.length} steps.`,
  );
  report.push(
    `Emergency Codes: agency names replaced with service tokens in ${tokenized.join(", ")}.`,
  );
}

export function buildReferenceModel(
  workbook: WorkbookData,
  rulings: Rulings,
  canon: ReadonlyMap<string, readonly SqlRow[]>,
  findings: Findings,
): ReferenceResult {
  const tables = new Map<string, SqlRow[]>();
  for (const [k, v] of canon) tables.set(k, [...v]);
  const report: string[] = [];
  rulingTables(rulings, tables);
  buildRoles(workbook, tables, findings, report);
  buildRateCards(workbook, rulings, tables, findings, report);
  buildEmergency(workbook, rulings, tables, findings, report);
  return { tables, report };
}
