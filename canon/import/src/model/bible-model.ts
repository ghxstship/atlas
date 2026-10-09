import { readBibleTable } from "../bible.ts";
import type { BibleTable } from "../bible.ts";
import type { CsvTable } from "../csv.ts";
import type { Findings } from "../doctrine.ts";
import { canonText, substituteEmDash } from "../doctrine.ts";
import { EMPTY } from "../cell.ts";
import { normalizeCell, normalizeText } from "../normalize.ts";
import type { SqlRow } from "../sql.ts";
import type { WorkbookData } from "../workbook.ts";
import type { Rulings } from "../rulings.ts";
import { RowReader, toMinorUnits } from "./values.ts";

/**
 * Builds canon rows from the Bible, the Item Catalog CSV and the GL chart CSV.
 * Derived columns the Bible repeats (department names beside codes, phase
 * names beside phase codes) are not stored; they are checked against their
 * single home and any disagreement stops the import.
 */

export interface IntakeRow extends SqlRow {
  readonly source_file: string;
  readonly source_sheet: string;
  readonly source_row: string;
  readonly source_column: string;
  readonly target_table: string;
  readonly target_key: string;
  readonly target_column: string;
  readonly proposed_value: string | null;
  readonly canon_value: string | null;
  readonly reason: string;
  readonly intake_state: string;
}

export interface CanonModel {
  readonly tables: ReadonlyMap<string, SqlRow[]>;
  readonly intake: IntakeRow[];
  /** Parsed row counts by Bible tab number or CSV role. */
  readonly counts: ReadonlyMap<string, number>;
  /** key to value from the Bible _generated tab. */
  readonly generated: ReadonlyMap<string, string>;
  /** Hard inconsistencies; any entry stops the import. */
  readonly problems: string[];
}

export interface CanonInputs {
  readonly bible: WorkbookData;
  readonly itemCatalog: CsvTable;
  readonly glChart: CsvTable;
  readonly rulings: Rulings;
  /** SHA-256 of each input file, recorded in xpms.version. */
  readonly files: {
    readonly bible: string;
    readonly itemCatalog: string;
    readonly glChart: string;
    readonly playbook: string;
  };
}

const BIBLE = "XOS_4.0_Bible.xlsx";
const ITEM_CSV = "XOS_4.0_Item_Catalog.csv";

class Builder {
  readonly tables = new Map<string, SqlRow[]>();
  readonly counts = new Map<string, number>();
  readonly problems: string[] = [];
  readonly intake: IntakeRow[] = [];
  readonly findings: Findings;
  readonly bible: WorkbookData;
  readonly rulings: Rulings;

  constructor(bible: WorkbookData, rulings: Rulings, findings: Findings) {
    this.bible = bible;
    this.rulings = rulings;
    this.findings = findings;
  }

  tab(n: string): { table: BibleTable; readers: RowReader[] } {
    const table = readBibleTable(this.bible, n);
    this.counts.set(n, table.rows.length);
    return {
      table,
      readers: table.rows.map((r) => new RowReader(r, `Bible ${table.tab}`, this.findings)),
    };
  }

  put(name: string, rows: SqlRow[]): void {
    if (this.tables.has(name)) throw new Error(`Rows for xpms.${name} built twice`);
    this.tables.set(name, rows);
  }

  rows(name: string): SqlRow[] {
    const r = this.tables.get(name);
    if (!r) throw new Error(`Rows for xpms.${name} are not built yet`);
    return r;
  }

  /**
   * Records a disagreement between two canon statements of the same fact. The
   * stored value comes from the fact's single home; the disagreement is reported
   * for an owner decision rather than resolved by the importer.
   */
  expect(cond: boolean, message: string): void {
    if (!cond) this.findings.add("conflict", message.split(":")[0] ?? message, message);
  }
}

function lookup(rows: readonly SqlRow[], key: string, value: string, col: string): string | null {
  const row = rows.find((r) => r[key] === value);
  const v = row?.[col];
  return typeof v === "string" ? v : null;
}

function buildDimensions(b: Builder): void {
  const depts = b.tab("01").readers.map((r) => ({
    dept_code: r.req("dept_code"),
    department: r.req("department"),
    source: r.req("source"),
    note: r.opt("note"),
    executive_lead: null,
    core_function: null,
    scope: null,
    source_row: null,
    source_status: null,
    source_created_by: null,
    source_created_at: null,
    source_updated_at: null,
  }));
  b.put("dim_department", depts);

  const meta = {
    source_row: null,
    source_status: null,
    source_created_by: null,
    source_created_at: null,
    source_updated_at: null,
  };
  b.put(
    "dim_discipline",
    b.tab("02").readers.map((r) => ({
      disc_code: r.req("disc_code"),
      dept_code: r.req("dept_code"),
      discipline: r.req("discipline"),
      source: r.req("source"),
      ...meta,
    })),
  );
  b.put(
    "dim_category",
    b.tab("03").readers.map((r) => ({
      cat_urid: r.req("cat_urid"),
      disc_code: r.req("disc_code"),
      category: r.req("category"),
      source: r.req("source"),
      xyz: null,
      ...meta,
    })),
  );

  const acts = b.tab("04").readers.map((r) => ({
    act_code: r.req("act"),
    ordinal: r.int("ordinal"),
    definition: r.req("definition"),
    gates: r.req("gates"),
  }));
  b.put(
    "dim_act",
    acts.map((a) => ({ act_code: a.act_code, ordinal: a.ordinal, definition: a.definition })),
  );

  const phases = b.tab("05").readers.map((r) => {
    const code = r.req("phase_code");
    const supersedes = r.opt("supersedes");
    const tokens = supersedes === null ? [] : supersedes.split(",").map((s) => s.trim());
    return {
      row: {
        phase_code: code,
        gate: r.int("gate"),
        phase: r.req("phase"),
        act_code: r.req("act"),
        definition: r.req("definition"),
        gate_exit: r.req("gate_exit"),
        is_redefined: tokens.some((t) => t === `${code} (redefined)`),
      },
      superseded: tokens.filter((t) => /^[A-Z]{3}$/.test(t) && t !== code),
      unknown: tokens.filter((t) => !/^[A-Z]{3}$/.test(t) && t !== `${code} (redefined)`),
      location: r.location("supersedes"),
    };
  });
  b.put(
    "dim_phase",
    phases.map((p) => p.row),
  );
  for (const p of phases) {
    for (const u of p.unknown) b.problems.push(`${p.location}: cannot read supersession "${u}"`);
  }
  for (const a of acts) {
    const gates = phases
      .filter((p) => p.row.act_code === a.act_code)
      .map((p) => Number(p.row.gate));
    const stated = `${Math.min(...gates)}-${Math.max(...gates)}`;
    b.expect(
      stated === a.gates,
      `Bible 04 act ${a.act_code} states gates ${a.gates}; phases give ${stated}`,
    );
  }

  const changes = b.tab("35").readers.map((r, i) => ({
    change: r.req("change"),
    ordinal: String(i + 1),
    from_value: r.req("from"),
    to_value: r.req("to"),
    why: r.req("why"),
  }));
  b.put("dim_change_record", changes);
  const supersession: SqlRow[] = [];
  for (const p of phases) {
    for (const code of p.superseded) {
      const change = changes.find((c) => c.from_value.endsWith(` ${code}`));
      if (!change) {
        b.problems.push(`Bible 35 has no change record naming superseded phase ${code}`);
        continue;
      }
      supersession.push({
        domain: "phase",
        code,
        successor_code: p.row.phase_code,
        label: change.from_value.slice(0, -(code.length + 1)),
        reason: `${change.change}: ${change.why}`,
      });
    }
  }
  b.put("supersession", supersession);

  b.put(
    "dim_gate_criterion",
    b.tab("06").readers.map((r, i) => ({
      criterion_id: r.req("criterion_id"),
      gate: r.int("gate"),
      ordinal: String(i + 1),
      statement: r.req("statement"),
      is_blocking: r.bool("blocking"),
    })),
  );
  b.put(
    "dim_tier",
    b.tab("07").readers.map((r) => ({ tier_code: r.req("tier_code"), tier: r.req("tier") })),
  );
  b.put(
    "dim_team",
    b.tab("08").readers.map((r) => ({
      team_id: r.req("team_id"),
      team: r.req("team"),
      dept_code: r.req("rolls_to_dept_code"),
      workgroup_tag: null,
      lead_role: null,
      responsibilities: null,
      ...meta,
    })),
  );
  b.put(
    "dim_tag",
    b.tab("09").readers.map((r) => ({
      tag_id: r.req("tag_id"),
      tag_type: r.req("tag_type"),
      tag: r.req("tag"),
    })),
  );

  // Assertion ranks and words come before provenance, whose max_confidence must be an economics word.
  const words: SqlRow[] = [];
  b.put(
    "dim_assertion_rank",
    b.tab("22").readers.map((r) => {
      const rank = r.int("rank");
      for (const domain of ["economics", "compliance", "capability"]) {
        const word = r.opt(domain);
        if (word !== null) words.push({ domain, word, rank });
      }
      return { rank, meaning: r.req("meaning"), note: r.opt("note") };
    }),
  );
  b.put("dim_assertion_word", words);
  const economics = new Set(words.filter((w) => w["domain"] === "economics").map((w) => w["word"]));
  b.put(
    "dim_provenance",
    b.tab("19").readers.map((r) => {
      const max = r.req("max_confidence");
      b.expect(
        economics.has(max),
        `${r.location("max_confidence")}: ${max} is not an economics assertion word`,
      );
      return {
        provenance: r.req("provenance"),
        rank: r.int("rank"),
        definition: r.req("definition"),
        may_overwrite: r.req("may_overwrite"),
        max_confidence: max,
      };
    }),
  );
  b.put(
    "dim_staleness_policy",
    b.tab("14").readers.map((r) => ({
      age_months_gte: r.int("age_months_gte"),
      action: r.req("action"),
      detail: r.opt("detail"),
    })),
  );
  buildJurisdictions(b);
  const multipliers: SqlRow[] = [];
  b.put(
    "dim_region",
    b.tab("12").readers.map((r, i) => {
      const code = r.req("region_code");
      const multiplier = r.num("cost_multiplier");
      const basis = r.bool("basis");
      if (multiplier !== null)
        multipliers.push({ region_code: code, cost_multiplier: multiplier, is_basis: basis });
      else b.expect(!basis, `${r.location("basis")}: a basis region must carry a multiplier`);
      return {
        region_code: code,
        ordinal: String(i + 1),
        name: r.req("name"),
        jurisdiction_id: r.req("jurisdiction_id"),
        currency_code: r.req("currency"),
        note: r.opt("note"),
      };
    }),
  );
  b.put("dim_region_multiplier", multipliers);
  b.put(
    "dim_escalation_index",
    b.tab("13").readers.map((r) => ({
      index_id: r.req("index_id"),
      name: r.req("name"),
      applies_to: r.req("applies_to"),
      note: r.opt("note"),
    })),
  );
  b.put(
    "dim_permit_rule",
    b.tab("15").readers.map((r, i) => ({
      rule: r.req("rule"),
      ordinal: String(i + 1),
      trigger_type: r.req("trigger_type"),
      condition: r.req("condition"),
      permit: r.req("permit"),
      ahj: r.req("ahj"),
      lead_time: r.req("lead_time"),
      jurisdiction_id: r.req("jurisdiction_id"),
      provenance: r.req("provenance"),
      note: r.opt("note"),
    })),
  );
  b.put(
    "dim_metric",
    b.tab("16").readers.map((r, i) => {
      const value = r.cell("value");
      const numeric = value.kind === "number";
      return {
        domain: r.req("domain"),
        item: r.req("item"),
        ordinal: String(i + 1),
        value_numeric: numeric ? r.num("value") : null,
        value_text: numeric ? null : r.req("value"),
        qualifier: r.opt("qualifier"),
        source: r.opt("source"),
        is_code_derived: r.bool("code_derived"),
        jurisdiction_id: r.opt("jurisdiction_id"),
        is_jurisdiction_neutral: r.bool("jurisdiction_neutral"),
        provenance: r.req("provenance"),
      };
    }),
  );
  b.put(
    "dim_identifier_class",
    b.tab("17").readers.map((r, i) => ({
      class: r.req("class"),
      ordinal: String(i + 1),
      issued_by: r.req("issued_by"),
      scope: r.req("scope"),
      is_mutable: r.bool("mutable"),
      rule: r.req("rule"),
      examples: r.req("examples"),
    })),
  );
  b.put(
    "dim_grain",
    b.tab("18").readers.map((r, i) => ({
      grain: r.req("grain"),
      ordinal: String(i + 1),
      counts: r.req("counts"),
      identified_by: r.req("identified_by"),
      answers: r.req("answers"),
      note: r.opt("note"),
    })),
  );
  b.put(
    "dim_facet",
    b.tab("20").readers.map((r, i) => ({
      facet: r.req("facet"),
      ordinal: String(i + 1),
      form: r.opt("form"),
      rolls_up_to: r.opt("rolls_up_to"),
      since: r.opt("since"),
      note: r.opt("note"),
    })),
  );

  const statements: SqlRow[] = [];
  const statement = (tab: string, item: string | null, text: string | null) => {
    const ordinal = statements.filter((s) => s["tab"] === tab).length + 1;
    statements.push({ tab, ordinal: String(ordinal), item, statement: text });
  };
  for (const r of b.tab("00").readers) statement("00 Cover", r.opt("Item"), r.opt("Statement"));
  const axes: SqlRow[] = [];
  for (const r of b.tab("21").readers) {
    if (r.opt("name_class") === null) {
      statement("21 Identity Doctrine", r.opt("axis"), r.opt("example"));
      continue;
    }
    axes.push({
      axis: r.req("axis"),
      ordinal: String(axes.length + 1),
      example: r.req("example"),
      answers: r.req("answers"),
      name_class: r.req("name_class"),
    });
  }
  b.put("dim_identity_axis", axes);
  const silence = b.tab("23");
  statement("23 Silence Rule", silence.table.headers[0] ?? null, null);
  for (const r of silence.readers) statement("23 Silence Rule", r.opt("INSTANCES"), null);
  b.findings.add(
    "structure",
    "Bible 23 · Silence Rule",
    "The tab holds only headings (INSTANCES, four bullet markers, WHY, CEILING, FLOOR, NOTE) with no statement text. The headings are stored in xpms.canon_statement; the rule itself is implemented from Section 3.7.",
  );
  const generated = new Map<string, string>();
  for (const r of b.tab("_generated").readers) {
    const key = r.req("key");
    const value = r.req("value");
    generated.set(key, value);
    statement("_generated", key, value);
  }
  b.put("canon_statement", statements);

  const kinds = b.tab("24");
  const classes: string[] = [];
  b.put(
    "dim_record_kind",
    kinds.readers.map((r, i) => {
      const cls = r.req("record_class");
      if (!classes.includes(cls)) classes.push(cls);
      return {
        record_kind: r.req("record_kind"),
        ordinal: String(i + 1),
        definition: r.req("definition"),
        definition_of_done: r.req("definition_of_done"),
        record_class: cls,
        title_grammar: r.req("title_grammar"),
      };
    }),
  );
  const strays = kinds.table.headers.filter((h) => h.includes("#"));
  if (strays.length > 0) {
    b.findings.add(
      "structure",
      `Bible ${kinds.table.tab}`,
      `Columns ${strays.join(", ")} repeat headers of tab 25 and do not describe the kind on their row; they are not loaded. Owner decision: remove them from the Bible or state what they mean.`,
    );
  }
  b.put(
    "dim_record_class",
    classes.map((c, i) => ({ record_class: c, ordinal: String(i + 1) })),
  );
  const subtypes = b.tab("25");
  const phaseRows = b.rows("dim_phase");
  const stated = subtypes.readers.filter((r) => r.opt("phase_code") !== null);
  const isPhaseList =
    stated.length === phaseRows.length &&
    stated.every(
      (r, i) =>
        r.rowNumber === subtypes.readers[i]?.rowNumber &&
        r.int("gate") === phaseRows[i]?.["gate"] &&
        r.req("phase_code") === phaseRows[i]?.["phase_code"] &&
        r.req("phase") === phaseRows[i]?.["phase"],
    );
  if (!isPhaseList)
    b.problems.push("Bible 25 gate, phase_code and phase columns no longer match the known layout");
  b.findings.add(
    "structure",
    `Bible ${subtypes.table.tab}`,
    `Columns gate, phase_code and phase hold the nine phases on the first ${stated.length} rows only; they repeat tab 05 and do not describe the subtype on their row, so subtypes carry no phase. Owner decision: remove the columns or state a phase per subtype.`,
  );
  b.put(
    "dim_record_subtype",
    subtypes.readers.map((r, i) => ({
      record_kind: r.req("record_kind"),
      record_subtype: r.req("record_subtype"),
      ordinal: String(i + 1),
      unspsc_segment: r.opt("unspsc_segment"),
    })),
  );
  b.put(
    "dim_record_state",
    b.tab("26").readers.map((r, i) => ({
      record_state: r.req("record_state"),
      ordinal: String(i + 1),
      meaning: r.req("meaning"),
    })),
  );
  b.put(
    "dim_state",
    b.tab("37").readers.map((r, i) => ({
      state: r.req("state"),
      ordinal: String(i + 1),
      family: r.req("family"),
      meaning: r.req("meaning"),
      applies_to: r.req("applies_to"),
    })),
  );
  b.put(
    "dim_role",
    b.tab("27").readers.map((r) => {
      const dept = r.req("dept_code");
      const home = lookup(depts, "dept_code", dept, "department");
      b.expect(
        home === r.req("department"),
        `${r.location("department")}: role ${r.req("role_code")} names department "${r.req("department")}" for ${dept}; tab 01 names it "${home ?? ""}". The code is stored; the label is not.`,
      );
      return {
        role_code: r.req("role_code"),
        role: r.req("role"),
        dept_code: dept,
        staffing_ratio: r.num("staffing_ratio"),
        ratio_basis: r.opt("ratio_basis"),
        kit_basis: r.opt("kit_basis"),
        job_title: r.opt("job_title"),
      };
    }),
  );
  b.put(
    "dim_counterparty_type",
    b.tab("28").readers.map((r, i) => ({
      counterparty_type: r.req("counterparty_type"),
      ordinal: String(i + 1),
      definition: r.req("definition"),
      classification_code: null,
      vendor_class: null,
      clearance_tier: null,
      default_account_code: null,
      ...meta,
    })),
  );
  b.put(
    "dim_cost_center_template",
    b.tab("30").readers.map((r, i) => ({
      cost_center_id: r.req("cost_center_id"),
      ordinal: String(i + 1),
      cost_center: r.req("cost_center"),
      kind: r.req("kind"),
      scope_code: r.opt("scope_code"),
      note: r.opt("note"),
      ...meta,
    })),
  );
  b.put(
    "dim_upl_field",
    b.tab("36").readers.map((r, i) => ({
      field: r.req("field"),
      ordinal: String(i + 1),
      rule: r.req("rule"),
    })),
  );
  const budget = b.tab("34").readers.map((r, i) => ({
    field: r.req("field"),
    ordinal: String(i + 1),
    rule: r.req("rule"),
  }));
  b.put("dim_budget_template_rule", budget);
  const columns = budget.find((x) => x.field === "Columns")?.rule ?? "";
  const grades = columns
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^Grade [1-3] /.test(s));
  const ruled = [...b.rulings.grades].sort((x, y) => x.sort_order - y.sort_order);
  if (grades.length !== ruled.length) {
    b.problems.push(
      `Bible 34 names ${grades.length} price grades; ruling D11 names ${ruled.length}`,
    );
  }
  b.findings.add(
    "ruling",
    "Bible 34 · Budget Template Spec Columns",
    `Price grade labels ${grades.join(", ")} are superseded by ruling D11: ${ruled.map((g) => g.label).join(", ")} (xpms.grade).`,
  );
  b.put(
    "grade",
    ruled.map((g) => ({ code: g.code, label: g.label, sort_order: String(g.sort_order) })),
  );
}

/**
 * Bible tab 11 in third normal form (ruling D19): the country is derived from the
 * ID, unit system and currency are stored where they first appear in the chain and
 * inherited below, and each code set is a row. jurisdiction_resolved re-forms the tab.
 */
function buildJurisdictions(b: Builder): void {
  const rows = b.tab("11").readers.map((r, i) => ({
    reader: r,
    id: r.req("jurisdiction_id"),
    ordinal: String(i + 1),
    level: r.req("level"),
    country: r.req("country"),
    parent: r.opt("parent"),
    unit: r.req("unit_system"),
    currency: r.req("currency"),
    codeSets: r.req("primary_code_sets"),
    status: r.req("status"),
    note: r.opt("note"),
  }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: SqlRow[] = [];
  const sets: SqlRow[] = [];
  for (const j of rows) {
    b.expect(
      j.country === j.id.slice(0, 2),
      `${j.reader.location("country")}: country ${j.country} is not the first segment of ${j.id}`,
    );
    const parent = j.parent === null ? undefined : byId.get(j.parent);
    out.push({
      jurisdiction_id: j.id,
      ordinal: j.ordinal,
      level: j.level,
      parent: j.parent,
      unit_system: parent && parent.unit === j.unit ? null : j.unit,
      currency: parent && parent.currency === j.currency ? null : j.currency,
      status: j.status,
      note: j.note,
    });
    j.codeSets
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .forEach((code_set, k) =>
        sets.push({ jurisdiction_id: j.id, code_set, sort_order: String(k + 1) }),
      );
  }
  b.put("jurisdiction", out);
  b.put("jurisdiction_code_set", sets);
}

function verifyNamesAgainstHome(b: Builder): void {
  const disc = b.rows("dim_discipline");
  const cats = b.rows("dim_category");
  const depts = b.rows("dim_department");
  const accounts = b.rows("dim_gl_account");
  const { readers } = b.tab("31");
  const rows: SqlRow[] = [];
  for (const r of readers) {
    const urid = r.req("cat_urid");
    const discCode = r.req("disc_code");
    const deptCode = r.req("dept_code");
    b.expect(
      lookup(cats, "cat_urid", urid, "category") === r.req("category"),
      `${r.location("category")}: disagrees with tab 03`,
    );
    b.expect(
      lookup(cats, "cat_urid", urid, "disc_code") === discCode,
      `${r.location("disc_code")}: disagrees with tab 03`,
    );
    b.expect(
      lookup(disc, "disc_code", discCode, "discipline") === r.req("discipline"),
      `${r.location("discipline")}: disagrees with tab 02`,
    );
    b.expect(
      lookup(depts, "dept_code", deptCode, "department") === r.req("department"),
      `${r.location("department")}: disagrees with tab 01`,
    );
    b.expect(
      lookup(cats, "cat_urid", urid, "source") === r.req("source"),
      `${r.location("source")}: disagrees with tab 03`,
    );
    b.expect(
      r.req("dimension_2_discipline") === discCode,
      `${r.location("dimension_2_discipline")}: is not the discipline code`,
    );
    b.expect(
      r.req("dimension_2_category") === urid,
      `${r.location("dimension_2_category")}: is not the URID`,
    );
    const account = r.req("account_code");
    b.expect(
      lookup(accounts, "account_code", account, "account_name") === r.req("account_name"),
      `${r.location("account_name")}: disagrees with tab 29`,
    );
    const byClass = accounts.find(
      (a) =>
        a["account_type"] === "Expense" &&
        String(a["account_code"]).slice(1, 2) === urid.slice(0, 1),
    );
    b.expect(
      byClass?.["account_code"] === account,
      `${r.location("account_code")}: states ${account}; the class expense account is ${String(byClass?.["account_code"] ?? "")} (decision D13 derives it)`,
    );
    rows.push({ cat_urid: urid, default_cost_center: r.req("default_cost_center") });
  }
  b.put("dim_category_gl", rows);
}

function buildGl(b: Builder, gl: CsvTable): void {
  const tab = b.tab("29");
  b.counts.set("gl-chart", gl.records.length);
  const csvRows = gl.records.map((rec) => rec.values);
  const types: string[] = [];
  const accounts = tab.readers.map((r) => {
    const code = r.req("account_code");
    const row = {
      account_code: code,
      account_name: r.req("account_name"),
      account_type: r.req("account_type"),
      tax_type: r.req("tax_type"),
      description: r.req("description"),
    };
    if (!types.includes(row.account_type)) types.push(row.account_type);
    const csv = csvRows.find((c) => c["account_code"] === code);
    if (!csv) b.problems.push(`GL chart CSV has no account ${code} from Bible tab 29`);
    else {
      for (const [k, v] of Object.entries(row)) {
        const csvValue = canonText(csv[k] ?? "", `GL chart CSV ${code} ${k}`, b.findings);
        b.expect(
          normalizeText(csvValue) === normalizeText(v),
          `GL account ${code} ${k}: Bible tab 29 "${v}" differs from the GL chart CSV "${csvValue}"`,
        );
      }
    }
    return {
      ...row,
      source_row: null,
      source_status: null,
      source_created_by: null,
      source_created_at: null,
      source_updated_at: null,
    };
  });
  for (const c of csvRows) {
    if (!accounts.some((a) => a.account_code === c["account_code"]))
      b.problems.push(`GL chart CSV account ${c["account_code"]} is not in Bible tab 29`);
  }
  b.put(
    "dim_gl_account_type",
    types.map((t) => ({ account_type: t, normal_balance: null })),
  );
  b.put("dim_gl_account", accounts);
}

const ITEM_COLUMNS = [
  "item_id",
  "urid",
  "department",
  "discipline",
  "category",
  "item",
  "common_name",
  "kind",
  "unit_basis",
  "grade",
  "description",
  "specification",
  "xyz",
  "xyz_basis",
  "default_phase",
  "tier",
  "unit_cost_usd",
  "cost_low_usd",
  "cost_high_usd",
  "lead_time_hrs",
  "crew",
  "unspsc",
  "purchase_account",
  "sales_account",
  "account_type",
  "default_cost_center",
  "price_evidence",
  "source",
  "mapping_confidence",
  "lifecycle_state",
  "external_ref",
] as const;

const ELEMENT_FIELDS: Readonly<Record<string, string>> = {
  urid: "urid",
  item: "item",
  common_name: "common_name",
  kind: "kind",
  unit_basis: "unit_basis",
  grade: "grade",
  description: "description",
  specification: "specification",
  xyz: "xyz",
  xyz_basis: "xyz_basis",
  tier_code: "tier",
  lead_time_hours: "lead_time_hrs",
  crew: "crew",
  unspsc: "unspsc",
  purchase_account: "purchase_account",
  sales_account: "sales_account",
  default_cost_center: "default_cost_center",
  price_evidence: "price_evidence",
  source: "source",
  mapping_confidence: "mapping_confidence",
  lifecycle_state: "lifecycle_state",
  external_ref: "external_ref",
};

function buildCatalog(b: Builder, items: CsvTable, generatedAt: string): void {
  b.counts.set("item-catalog", items.records.length);
  const missing = ITEM_COLUMNS.filter((c) => !items.headers.includes(c));
  if (missing.length > 0) throw new Error(`Item Catalog CSV lacks columns ${missing.join(", ")}`);
  const tab = b.tab("32");
  const tabById = new Map(
    tab.table.rows.map((r) => [
      normalizeCell(r.cells["item_id"] ?? { kind: "empty", text: "" }),
      r,
    ]),
  );
  const cats = b.rows("dim_category");
  const discs = b.rows("dim_discipline");
  const depts = b.rows("dim_department");
  const tiers = b.rows("dim_tier");
  const phases = b.rows("dim_phase");
  const accounts = b.rows("dim_gl_account");
  const grades = b.rulings.grades;
  const elements: SqlRow[] = [];
  const bands: SqlRow[] = [];
  const phaseBridge: SqlRow[] = [];
  const provenance: SqlRow[] = [];
  const units: string[] = [];
  for (const rec of items.records) {
    const v = rec.values;
    const id = v["item_id"] ?? "";
    const where = `Item Catalog CSV line ${rec.line} (${id})`;
    const text = (col: string): string | null => {
      const raw = v[col] ?? "";
      return raw.trim() === "" ? null : canonText(raw, `${where} ${col}`, b.findings);
    };
    const tabRow = tabById.get(id);
    if (!tabRow) b.problems.push(`${where}: not in Bible tab 32`);
    else {
      for (const col of ITEM_COLUMNS) {
        const bibleValue = normalizeText(
          substituteEmDash(normalizeCell(tabRow.cells[col] ?? EMPTY)),
        );
        const csvValue = normalizeText(text(col) ?? "");
        const numeric =
          bibleValue !== "" && csvValue !== "" && Number(bibleValue) === Number(csvValue);
        b.expect(
          bibleValue === csvValue || numeric,
          `${where} ${col}: CSV "${csvValue}" differs from Bible tab 32 "${bibleValue}"`,
        );
      }
    }
    const urid = text("urid") ?? "";
    const disc = urid.slice(0, 7);
    const dept = urid.slice(0, 4);
    b.expect(
      id.startsWith(`${urid}-`) && /^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[A-Z]+-[0-9]+$/.test(id),
      `${where}: item ID does not follow {URID}-{ORG}-{SEQ}`,
    );
    const deptLabel = `${dept} ${lookup(depts, "dept_code", dept, "department") ?? ""}`;
    const discLabel = `${disc} ${lookup(discs, "disc_code", disc, "discipline") ?? ""}`;
    const catLabel = lookup(cats, "cat_urid", urid, "category");
    b.expect(
      text("department") === deptLabel,
      `${where}: department "${text("department") ?? ""}" disagrees with URID ${urid}, whose department is "${deptLabel}"`,
    );
    b.expect(
      text("discipline") === discLabel,
      `${where}: discipline "${text("discipline") ?? ""}" disagrees with URID ${urid}, whose discipline is "${discLabel}"`,
    );
    b.expect(
      text("category") === catLabel,
      `${where}: category "${text("category") ?? ""}" disagrees with URID ${urid}, whose category is "${catLabel ?? ""}"`,
    );
    const tierText = text("tier") ?? "";
    const tierCode = tierText.slice(0, 2);
    b.expect(
      `${tierCode} ${lookup(tiers, "tier_code", tierCode, "tier") ?? ""}` === tierText,
      `${where}: tier "${tierText}" is not a tab 07 tier`,
    );
    const account = text("purchase_account") ?? text("sales_account");
    b.expect(
      account !== null &&
        lookup(accounts, "account_code", account, "account_type") === text("account_type"),
      `${where}: account_type disagrees with tab 29`,
    );
    const unit = text("unit_basis") ?? "";
    if (!units.includes(unit)) units.push(unit);

    const row: Record<string, string | null> = { element_id: id };
    for (const [col, src] of Object.entries(ELEMENT_FIELDS)) {
      row[col] = col === "tier_code" ? tierCode : text(src);
    }
    elements.push({ ...row, source_row: null });
    for (const [col, value] of Object.entries(row)) {
      if (col !== "element_id" && value !== null) {
        provenance.push({
          element_id: id,
          field_name: col,
          provenance: "imported",
          recorded_at: generatedAt,
        });
      }
    }

    for (const g of grades) {
      const column = g.catalog_column;
      const amount = text(column);
      if (amount === null) continue;
      bands.push({
        element_id: id,
        grade_code: g.code,
        amount_minor: toMinorUnits(amount),
        currency_code: "USD",
        assertion_word: null,
        valid_from: null,
        valid_to: null,
      });
    }

    const phaseName = text("default_phase");
    const phase = phases.find((p) => p["phase"] === phaseName);
    if (phase)
      phaseBridge.push({
        element_id: id,
        phase_code: phase["phase_code"] as string,
        is_default: true,
      });
    else {
      b.intake.push({
        source_file: ITEM_CSV,
        source_sheet: "XOS_4.0_Item_Catalog",
        source_row: String(rec.line),
        source_column: "default_phase",
        target_table: "bridge_element_phase",
        target_key: id,
        target_column: "phase_code",
        proposed_value: phaseName,
        canon_value: null,
        reason: `Default phase "${phaseName ?? ""}" is not one of the nine gated phases in Bible tab 05.`,
        intake_state: "Proposed",
      });
    }
  }
  for (const r of tab.table.rows) {
    const id = normalizeCell(r.cells["item_id"] ?? { kind: "empty", text: "" });
    if (!items.records.some((rec) => rec.values["item_id"] === id))
      b.problems.push(`Bible tab 32 item ${id} is not in the Item Catalog CSV`);
  }
  reportUnresolved(
    b,
    "default_phase",
    "Item Catalog default_phase",
    "items name default phase",
    "xpms.bridge_element_phase",
  );
  b.put("dim_unit_dimension", []);
  b.put(
    "dim_unit_alias",
    units.map((u) => ({ alias: u, unit_code: u, dimension_code: null })),
  );
  b.findings.add(
    "unresolved-reference",
    "Units",
    `Canon states ${units.length} unit bases (${units.join(", ")}) and no unit dimensions. xpms.dim_unit_alias holds each basis as its own unit with no dimension, so arithmetic across units refuses until the owner ratifies dimensions.`,
  );
  b.put("elements", elements);
  b.put("element_price_bands", bands);
  b.put("bridge_element_phase", phaseBridge);
  b.put("field_provenance", provenance);
  b.put("element_gtins", []);

  const touchpoints = b.rows("dim_touchpoint");
  const tpBridge = new Set<string>();
  for (const e of elements) {
    const ref = e["external_ref"];
    if (typeof ref === "string" && touchpoints.some((t) => t["touchpoint_id"] === ref)) {
      tpBridge.add(`${ref}|${(e["urid"] as string).slice(0, 7)}`);
    }
  }
  b.put(
    "bridge_touchpoint_discipline",
    [...tpBridge].map((k) => {
      const [touchpoint_id = "", disc_code = ""] = k.split("|");
      return { touchpoint_id, disc_code };
    }),
  );
  for (const name of [
    "bridge_element_tag",
    "bridge_element_permit",
    "bridge_element_metric",
    "bridge_discipline_team",
  ]) {
    b.put(name, []);
    b.findings.add(
      "unresolved-reference",
      `xpms.${name}`,
      "Canon states no rows for this relationship (the Bible names tags, permit triggers and teams only in prose notes). The table is in place and empty until the owner supplies the links.",
    );
  }
}

function reportUnresolved(
  b: Builder,
  column: string,
  location: string,
  what: string,
  where: string,
): void {
  const byValue = new Map<string, number>();
  for (const i of b.intake.filter((x) => x.source_column === column)) {
    byValue.set(i.proposed_value ?? "", (byValue.get(i.proposed_value ?? "") ?? 0) + 1);
  }
  for (const [value, n] of byValue) {
    b.findings.add(
      "unresolved-reference",
      location,
      `${n} ${what} "${value}", which is not one of the nine gated phases. They carry no phase in ${where} and wait in xpms.intake for an owner decision.`,
    );
  }
}

function buildTouchpoints(b: Builder): void {
  const depts = b.rows("dim_department");
  const tiers = b.rows("dim_tier");
  const phases = b.rows("dim_phase");
  b.put(
    "dim_touchpoint",
    b.tab("10").readers.map((r, i) => {
      const dept = r.req("dept_code");
      b.expect(
        lookup(depts, "dept_code", dept, "department") === r.req("department"),
        `${r.location("department")}: disagrees with tab 01`,
      );
      const tierText = r.req("tier");
      const tierCode = tierText.slice(0, 2);
      b.expect(
        `${tierCode} ${lookup(tiers, "tier_code", tierCode, "tier") ?? ""}` === tierText,
        `${r.location("tier")}: "${tierText}" is not a tab 07 tier`,
      );
      const phaseName = r.req("lifecycle_gate");
      const phase = phases.find((p) => p["phase"] === phaseName);
      const id = r.req("touchpoint_id");
      if (!phase) {
        b.intake.push({
          source_file: BIBLE,
          source_sheet: "10 · Touchpoints",
          source_row: String(r.rowNumber),
          source_column: "lifecycle_gate",
          target_table: "dim_touchpoint",
          target_key: id,
          target_column: "lifecycle_phase_code",
          proposed_value: phaseName,
          canon_value: null,
          reason: `Lifecycle gate "${phaseName}" is not one of the nine gated phases in Bible tab 05.`,
          intake_state: "Proposed",
        });
      }
      return {
        touchpoint_id: id,
        ordinal: String(i + 1),
        sense: r.req("sense"),
        brief_element: r.req("brief_element"),
        category: r.req("category"),
        item: r.req("item"),
        base: r.req("base"),
        elevated: r.req("elevated"),
        premium: r.req("premium"),
        optional_upgrades: r.opt("optional_upgrades"),
        add_ons: r.opt("add_ons"),
        substitutions: r.opt("substitutions"),
        venue_zone: r.opt("venue_zone"),
        event_tier_fit: r.opt("event_tier_fit"),
        dept_code: dept,
        division: r.opt("division"),
        tier_code: tierCode,
        lifecycle_phase_code: (phase?.["phase_code"] as string | undefined) ?? null,
        xyz: r.req("xyz"),
      };
    }),
  );
  reportUnresolved(
    b,
    "lifecycle_gate",
    "Bible 10 · Touchpoints lifecycle_gate",
    "touchpoints name lifecycle gate",
    "xpms.dim_touchpoint",
  );
}

function verifyCoordinateMatrix(b: Builder): void {
  const { readers, table } = b.tab("33");
  const phases = b.rows("dim_phase").map((p) => p["phase_code"] as string);
  const depts = b.rows("dim_department").map((d) => d["dept_code"] as string);
  b.expect(
    JSON.stringify(table.headers.slice(1)) === JSON.stringify(phases),
    "Bible 33 phase columns differ from the gate order in tab 05",
  );
  b.expect(
    JSON.stringify(readers.map((r) => r.req("dept_code"))) === JSON.stringify(depts),
    "Bible 33 department rows differ from tab 01",
  );
  for (const r of readers) {
    for (const p of phases) {
      b.expect(
        r.req(p) === `${r.req("dept_code")}x${p}`,
        `${r.location(p)}: coordinate is not {CLASS}x{PHASE_CODE}`,
      );
    }
  }
}

function systemRows(b: Builder): void {
  b.put("dim_urn_namespace", [
    {
      kind: "department",
      table_name: "dim_department",
      key_column: "dept_code",
      label_column: "department",
    },
    {
      kind: "discipline",
      table_name: "dim_discipline",
      key_column: "disc_code",
      label_column: "discipline",
    },
    {
      kind: "category",
      table_name: "dim_category",
      key_column: "cat_urid",
      label_column: "category",
    },
    { kind: "phase", table_name: "dim_phase", key_column: "phase_code", label_column: "phase" },
    {
      kind: "criterion",
      table_name: "dim_gate_criterion",
      key_column: "criterion_id",
      label_column: "statement",
    },
    { kind: "tier", table_name: "dim_tier", key_column: "tier_code", label_column: "tier" },
    { kind: "team", table_name: "dim_team", key_column: "team_id", label_column: "team" },
    { kind: "tag", table_name: "dim_tag", key_column: "tag_id", label_column: "tag" },
    {
      kind: "touchpoint",
      table_name: "dim_touchpoint",
      key_column: "touchpoint_id",
      label_column: "item",
    },
    {
      kind: "jurisdiction",
      table_name: "jurisdiction",
      key_column: "jurisdiction_id",
      label_column: "jurisdiction_id",
    },
    { kind: "region", table_name: "dim_region", key_column: "region_code", label_column: "name" },
    { kind: "role", table_name: "dim_role", key_column: "role_code", label_column: "role" },
    {
      kind: "account",
      table_name: "dim_gl_account",
      key_column: "account_code",
      label_column: "account_name",
    },
    {
      kind: "cost_center",
      table_name: "dim_cost_center_template",
      key_column: "cost_center_id",
      label_column: "cost_center",
    },
    { kind: "element", table_name: "elements", key_column: "element_id", label_column: "item" },
  ]);
  b.put("dim_locale", [
    { locale_code: "de-DE", name: "German (Germany)", is_source: false, release_stage: "beta" },
    {
      locale_code: "en-US",
      name: "English (United States)",
      is_source: true,
      release_stage: "general",
    },
    {
      locale_code: "es-US",
      name: "Spanish (United States)",
      is_source: false,
      release_stage: "general",
    },
    { locale_code: "fr-FR", name: "French (France)", is_source: false, release_stage: "beta" },
    { locale_code: "it-IT", name: "Italian (Italy)", is_source: false, release_stage: "beta" },
    { locale_code: "ja-JP", name: "Japanese (Japan)", is_source: false, release_stage: "beta" },
    { locale_code: "pt-BR", name: "Portuguese (Brazil)", is_source: false, release_stage: "beta" },
  ]);
}

export function buildCanonModel(inputs: CanonInputs, findings: Findings): CanonModel {
  const b = new Builder(inputs.bible, inputs.rulings, findings);
  buildDimensions(b);
  buildGl(b, inputs.glChart);
  verifyNamesAgainstHome(b);
  buildTouchpoints(b);
  verifyCoordinateMatrix(b);
  const generated = new Map<string, string>();
  for (const s of b.rows("canon_statement")) {
    if (s["tab"] === "_generated") generated.set(s["item"] as string, s["statement"] as string);
  }
  const generatedAt = generated.get("generated_at");
  if (generatedAt === undefined) throw new Error("Bible _generated tab states no generated_at");
  buildCatalog(b, inputs.itemCatalog, generatedAt);
  systemRows(b);
  b.put("version", [
    {
      version_code: "4.0",
      generation: "1",
      bible_generated_at: generatedAt,
      bible_sha256: inputs.files.bible,
      item_catalog_sha256: inputs.files.itemCatalog,
      gl_chart_sha256: inputs.files.glChart,
      playbook_sha256: inputs.files.playbook,
    },
  ]);
  b.put("ratification", []);
  return { tables: b.tables, intake: b.intake, counts: b.counts, generated, problems: b.problems };
}

export const BIBLE_FILE = BIBLE;
