import type { SupabaseClient } from "@supabase/supabase-js";
import type { XosClient } from "./client";
import { nullAwareSum } from "./finance";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result";

/**
 * Built-in reports (Section 4.2 Reports, Section 7.4 Analytics): gate readiness, the coordinate
 * matrix, budget versus actual, labor, purchase order exposure, incidents and the final cost report.
 * Every figure is derived at read time from security_invoker views and tables, so each reader sees
 * only rows their row level security allows. Aggregates follow the silence rule (Section 3.7): a
 * blank amount makes its total blank and is counted, never summed as zero. Every row carries the ids
 * behind it so a page can drill from any number to its records (Section 11.11).
 * The report builder (Section 4.6.4) is A18's; this module only reads its saved definitions.
 */

type Raw = Record<string, unknown>;

function untyped(db: XosClient): SupabaseClient {
  return db as unknown as SupabaseClient;
}

async function rows(
  query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
): Promise<Result<Raw[]>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data as Raw[] | null) ?? []);
}

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : typeof v === "number" ? v : Number(v);
const obj = (v: unknown): Raw | null =>
  Array.isArray(v) ? ((v[0] as Raw | undefined) ?? null) : ((v as Raw | null) ?? null);
const numeric = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

interface ReportProject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly phase: string;
}

/** Readable projects of the org (the reports' scope), optionally one project. */
async function projectsOf(
  db: XosClient,
  orgId: string,
  projectId?: string | null,
): Promise<Result<ReportProject[]>> {
  let query = db
    .from("projects")
    .select("id, project_key, name, current_phase_code")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("project_key");
  if (projectId) query = query.eq("id", projectId);
  const result = await rows(query);
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      id: str(r["id"]),
      key: str(r["project_key"]),
      name: str(r["name"]),
      phase: str(r["current_phase_code"]),
    })),
  );
}

// Budget versus actual -----------------------------------------------------------------------------------

export type BudgetDimension = "account" | "costCenter" | "urid" | "department" | "project";
export const BUDGET_DIMENSIONS: readonly BudgetDimension[] = [
  "account",
  "costCenter",
  "department",
  "urid",
  "project",
];

export interface VarianceRow {
  /** The dimension value: account code, cost center code, URID, department class or project key. */
  readonly key: string;
  readonly currency: string;
  /** Original budget; null while any line in the group is unpriced. */
  readonly budgetMinor: number | null;
  readonly unpricedCount: number;
  readonly approvedChangeMinor: number;
  /** Original plus approved change orders; null while the original is null. */
  readonly revisedMinor: number | null;
  readonly actualMinor: number;
  /** Revised minus actual; null while the revised budget is null. */
  readonly varianceMinor: number | null;
  /** Budget lines behind the row, for drill-through. */
  readonly budgetLineIds: readonly string[];
}

interface LineFact {
  readonly budgetLineId: string;
  readonly budgetId: string;
  readonly projectId: string;
  readonly isBaseline: boolean;
  readonly currency: string;
  readonly lineType: string;
  readonly urid: string;
  readonly deptCode: string;
  readonly accountCode: string | null;
  readonly costCenterCode: string | null;
  readonly extendedMinor: number | null;
  readonly actualMinor: number;
}

interface ChangeFact {
  readonly budgetId: string;
  readonly projectId: string;
  readonly state: string;
  readonly urid: string;
  readonly deptCode: string;
  readonly accountCode: string | null;
  readonly costCenterId: string | null;
  readonly extendedMinor: number | null;
}

async function lineFacts(
  db: XosClient,
  projectIds: readonly string[],
): Promise<Result<LineFact[]>> {
  if (projectIds.length === 0) return ok([]);
  const result = await rows(
    untyped(db)
      .from("budget_line_facts")
      .select("*")
      .in("project_id", [...projectIds]),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      budgetLineId: str(r["budget_line_id"]),
      budgetId: str(r["budget_id"]),
      projectId: str(r["project_id"]),
      isBaseline: r["is_baseline"] === true,
      currency: str(r["currency_code"]).trim(),
      lineType: str(r["line_type"]),
      urid: str(r["urid"]),
      deptCode: str(r["dept_code"]),
      accountCode: strOrNull(r["account_code"]),
      costCenterCode: strOrNull(r["cost_center_code"]),
      extendedMinor: numOrNull(r["extended_minor"]),
      actualMinor: num(r["actual_minor"]),
    })),
  );
}

async function approvedChangeFacts(
  db: XosClient,
  projectIds: readonly string[],
): Promise<Result<ChangeFact[]>> {
  if (projectIds.length === 0) return ok([]);
  const result = await rows(
    untyped(db)
      .from("change_order_line_facts")
      .select("*")
      .in("project_id", [...projectIds])
      .eq("change_order_state", "Approved"),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      budgetId: str(r["budget_id"]),
      projectId: str(r["project_id"]),
      state: str(r["change_order_state"]),
      urid: str(r["urid"]),
      deptCode: str(r["dept_code"]),
      accountCode: strOrNull(r["account_code"]),
      costCenterId: strOrNull(r["cost_center_id"]),
      extendedMinor: numOrNull(r["extended_minor"]),
    })),
  );
}

/**
 * The working budgets of each project: every budget that is not the gate 3 baseline, or the baseline
 * itself when it is the project's only budget. The baseline stays the reference of the final cost
 * report and is never counted twice.
 */
export function workingBudgetIds(
  facts: readonly { budgetId: string; projectId: string; isBaseline: boolean }[],
): Set<string> {
  const byProject = new Map<string, { working: Set<string>; baseline: Set<string> }>();
  for (const f of facts) {
    const entry = byProject.get(f.projectId) ?? { working: new Set(), baseline: new Set() };
    (f.isBaseline ? entry.baseline : entry.working).add(f.budgetId);
    byProject.set(f.projectId, entry);
  }
  const ids = new Set<string>();
  for (const { working, baseline } of byProject.values())
    for (const id of working.size > 0 ? working : baseline) ids.add(id);
  return ids;
}

function groupVariance(
  lines: readonly LineFact[],
  changes: readonly ChangeFact[],
  keyOfLine: (l: LineFact) => string,
  keyOfChange: (c: ChangeFact) => string,
  currencyOfBudget: ReadonlyMap<string, string>,
): VarianceRow[] {
  const groups = new Map<
    string,
    {
      key: string;
      currency: string;
      amounts: (number | null)[];
      actual: number;
      change: number;
      ids: string[];
    }
  >();
  const groupFor = (key: string, currency: string) => {
    const id = `${key}|${currency}`;
    const g = groups.get(id) ?? { key, currency, amounts: [], actual: 0, change: 0, ids: [] };
    groups.set(id, g);
    return g;
  };
  for (const l of lines) {
    const g = groupFor(keyOfLine(l), l.currency);
    g.amounts.push(l.extendedMinor);
    g.actual += l.actualMinor;
    g.ids.push(l.budgetLineId);
  }
  for (const c of changes) {
    const g = groupFor(keyOfChange(c), currencyOfBudget.get(c.budgetId) ?? "");
    g.change += c.extendedMinor ?? 0;
  }
  return [...groups.values()]
    .map((g) => {
      const sum = nullAwareSum(g.amounts);
      const budget = g.amounts.length === 0 ? 0 : sum.total;
      const revised = budget === null ? null : budget + g.change;
      return {
        key: g.key,
        currency: g.currency,
        budgetMinor: budget,
        unpricedCount: sum.unpricedCount,
        approvedChangeMinor: g.change,
        revisedMinor: revised,
        actualMinor: g.actual,
        varianceMinor: revised === null ? null : revised - g.actual,
        budgetLineIds: g.ids,
      };
    })
    .sort((a, b) => numeric(a.key, b.key) || a.currency.localeCompare(b.currency));
}

export interface BudgetVersusActual {
  readonly rows: readonly VarianceRow[];
  /** Totals per currency, NULL-aware. */
  readonly totals: readonly VarianceRow[];
}

/** Budget versus actual by one dimension across the working budgets (Section 7.4 Analytics). */
export async function budgetVersusActual(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly projectId?: string | null;
    readonly dimension: BudgetDimension;
  },
): Promise<Result<BudgetVersusActual>> {
  const projects = await projectsOf(db, input.orgId, input.projectId);
  if (!projects.ok) return projects;
  const ids = projects.data.map((p) => p.id);
  const [facts, changes] = await Promise.all([lineFacts(db, ids), approvedChangeFacts(db, ids)]);
  if (!facts.ok) return facts;
  if (!changes.ok) return changes;
  const working = workingBudgetIds(facts.data);
  const lines = facts.data.filter((f) => working.has(f.budgetId));
  const currencyOfBudget = new Map(lines.map((l) => [l.budgetId, l.currency]));
  const applied = changes.data.filter((c) => currencyOfBudget.has(c.budgetId));
  const keyOfProject = new Map(projects.data.map((p) => [p.id, p.key]));
  const codeOfCostCenter = new Map<string, string>();
  const unassigned = "";
  const byLine: Record<BudgetDimension, (l: LineFact) => string> = {
    account: (l) => l.accountCode ?? unassigned,
    costCenter: (l) => l.costCenterCode ?? unassigned,
    urid: (l) => l.urid,
    department: (l) => l.deptCode,
    project: (l) => keyOfProject.get(l.projectId) ?? unassigned,
  };
  if (input.dimension === "costCenter" && applied.some((c) => c.costCenterId)) {
    const centers = await rows(
      db.from("cost_centers").select("id, code").eq("org_id", input.orgId),
    );
    if (!centers.ok) return centers;
    for (const c of centers.data) codeOfCostCenter.set(str(c["id"]), str(c["code"]));
  }
  const byChange: Record<BudgetDimension, (c: ChangeFact) => string> = {
    account: (c) => c.accountCode ?? unassigned,
    costCenter: (c) =>
      c.costCenterId ? (codeOfCostCenter.get(c.costCenterId) ?? unassigned) : unassigned,
    urid: (c) => c.urid,
    department: (c) => c.deptCode,
    project: (c) => keyOfProject.get(c.projectId) ?? unassigned,
  };
  const result = groupVariance(
    lines,
    applied,
    byLine[input.dimension],
    byChange[input.dimension],
    currencyOfBudget,
  );
  return ok({
    rows: result,
    totals: groupVariance(
      lines,
      applied,
      () => "",
      () => "",
      currencyOfBudget,
    ),
  });
}

// Final cost report -------------------------------------------------------------------------------------

export interface FinalCostRow {
  readonly accountCode: string;
  readonly currency: string;
  /** Gate 3 baseline budget; null while any baseline line is unpriced. */
  readonly baselineMinor: number | null;
  readonly baselineUnpricedCount: number;
  readonly approvedChangeMinor: number;
  readonly revisedMinor: number | null;
  /** Posted ledger actual: every posted debit less credit on the account for the project. */
  readonly actualMinor: number;
  readonly varianceMinor: number | null;
  readonly budgetLineIds: readonly string[];
}

export interface FinalCostReport {
  readonly project: ReportProject;
  /** False when the project has no gate 3 baseline: the report answers NO_ANSWER, never zero. */
  readonly hasBaseline: boolean;
  readonly rows: readonly FinalCostRow[];
  readonly totals: readonly FinalCostRow[];
}

/**
 * The final cost report against the gate 3 baseline (Section 20.2 journey 23): baseline by expense
 * account, approved change orders, revised budget, posted actuals from the Universal Posting Line and
 * the variance.
 */
export async function finalCostReport(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId: string },
): Promise<Result<FinalCostReport>> {
  const projects = await projectsOf(db, input.orgId, input.projectId);
  if (!projects.ok) return projects;
  const project = projects.data[0];
  if (!project) return fail({ kind: "not-found" });
  const [facts, changes, postings] = await Promise.all([
    lineFacts(db, [project.id]),
    approvedChangeFacts(db, [project.id]),
    rows(
      db
        .from("posting_lines")
        .select("account_code, amount_minor, currency")
        .eq("project_id", project.id),
    ),
  ]);
  if (!facts.ok) return facts;
  if (!changes.ok) return changes;
  if (!postings.ok) return postings;
  const baseline = facts.data.filter((f) => f.isBaseline);
  const currency = baseline[0]?.currency ?? facts.data[0]?.currency ?? "";
  const groups = new Map<
    string,
    {
      account: string;
      currency: string;
      amounts: (number | null)[];
      change: number;
      actual: number;
      ids: string[];
    }
  >();
  const groupFor = (account: string, cur: string) => {
    const id = `${account}|${cur}`;
    const g = groups.get(id) ?? {
      account,
      currency: cur,
      amounts: [],
      change: 0,
      actual: 0,
      ids: [],
    };
    groups.set(id, g);
    return g;
  };
  for (const l of baseline) {
    const g = groupFor(l.accountCode ?? "", l.currency);
    g.amounts.push(l.extendedMinor);
    g.ids.push(l.budgetLineId);
  }
  for (const c of changes.data)
    groupFor(c.accountCode ?? "", currency).change += c.extendedMinor ?? 0;
  for (const p of postings.data) {
    const account = str(p["account_code"]);
    if (!account.startsWith("5")) continue;
    groupFor(account, str(p["currency"]).trim()).actual += num(p["amount_minor"]);
  }
  const toRow = (g: {
    account: string;
    currency: string;
    amounts: (number | null)[];
    change: number;
    actual: number;
    ids: string[];
  }): FinalCostRow => {
    const sum = nullAwareSum(g.amounts);
    const base = g.amounts.length === 0 ? 0 : sum.total;
    const revised = base === null ? null : base + g.change;
    return {
      accountCode: g.account,
      currency: g.currency,
      baselineMinor: base,
      baselineUnpricedCount: sum.unpricedCount,
      approvedChangeMinor: g.change,
      revisedMinor: revised,
      actualMinor: g.actual,
      varianceMinor: revised === null ? null : revised - g.actual,
      budgetLineIds: g.ids,
    };
  };
  const list = [...groups.values()]
    .map(toRow)
    .sort((a, b) => numeric(a.accountCode, b.accountCode));
  const totals = new Map<string, FinalCostRow[]>();
  for (const r of list) totals.set(r.currency, [...(totals.get(r.currency) ?? []), r]);
  return ok({
    project,
    hasBaseline: baseline.length > 0,
    rows: list,
    totals: [...totals.entries()].map(([cur, rs]) => {
      const base = nullAwareSum(rs.map((r) => r.baselineMinor));
      const revised = nullAwareSum(rs.map((r) => r.revisedMinor));
      const actual = rs.reduce((s, r) => s + r.actualMinor, 0);
      return {
        accountCode: "",
        currency: cur,
        baselineMinor: base.total,
        baselineUnpricedCount: rs.reduce((s, r) => s + r.baselineUnpricedCount, 0),
        approvedChangeMinor: rs.reduce((s, r) => s + r.approvedChangeMinor, 0),
        revisedMinor: revised.total,
        actualMinor: actual,
        varianceMinor: revised.total === null ? null : revised.total - actual,
        budgetLineIds: rs.flatMap((r) => r.budgetLineIds),
      };
    }),
  });
}

// Gate readiness ----------------------------------------------------------------------------------------

export interface GateReadinessRow {
  readonly project: ReportProject;
  /** The gate that closes the current phase; null once gate 9 has passed. */
  readonly nextGate: number | null;
  readonly blockingTotal: number;
  readonly blockingMet: number;
  readonly otherTotal: number;
  readonly otherMet: number;
  readonly ready: boolean;
  /** Blocking criteria still without evidence of assertion rank 1 or more. */
  readonly unmetBlocking: readonly string[];
}

/** Readiness of each project's next gate from the evidence spine (app.gate_criteria_status). */
export async function gateReadiness(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<GateReadinessRow[]>> {
  const projects = await projectsOf(db, input.orgId, input.projectId);
  if (!projects.ok) return projects;
  if (projects.data.length === 0) return ok([]);
  const status = await rows(
    db
      .from("gate_criteria_status")
      .select("project_id, gate, criterion_id, is_blocking, evidence_count, gate_passed")
      .in(
        "project_id",
        projects.data.map((p) => p.id),
      ),
  );
  if (!status.ok) return status;
  return ok(
    projects.data.map((project) => {
      const mine = status.data.filter((s) => str(s["project_id"]) === project.id);
      const open = mine
        .filter((s) => s["gate_passed"] !== true)
        .map((s) => num(s["gate"]))
        .sort((a, b) => a - b);
      const nextGate = open[0] ?? null;
      const criteria = mine.filter((s) => num(s["gate"]) === nextGate);
      const met = (s: Raw) => num(s["evidence_count"]) > 0;
      const blocking = criteria.filter((s) => s["is_blocking"] === true);
      const other = criteria.filter((s) => s["is_blocking"] !== true);
      const unmetBlocking = blocking
        .filter((s) => !met(s))
        .map((s) => str(s["criterion_id"]))
        .sort(numeric);
      return {
        project,
        nextGate,
        blockingTotal: blocking.length,
        blockingMet: blocking.length - unmetBlocking.length,
        otherTotal: other.length,
        otherMet: other.filter(met).length,
        ready: nextGate !== null && unmetBlocking.length === 0,
        unmetBlocking,
      };
    }),
  );
}

// Coordinate matrix -------------------------------------------------------------------------------------

export interface CoordinateMatrixData {
  readonly departments: readonly { code: string; name: string }[];
  readonly phases: readonly { gate: number; code: string; name: string }[];
  /** Record counts keyed `DEPT|PHASE`; a missing key is zero records. */
  readonly cells: Readonly<Record<string, number>>;
  readonly total: number;
}

/** Records by department class and phase: the 90 coordinates (10 departments by 9 phases). */
export async function coordinateMatrix(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<CoordinateMatrixData>> {
  const canon = db.schema("xpms");
  let records = db
    .from("records")
    .select("urid, phase_code")
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .not("urid", "is", null)
    .not("phase_code", "is", null);
  if (input.projectId) records = records.eq("project_id", input.projectId);
  const [departments, phases, found] = await Promise.all([
    rows(canon.from("dim_department").select("dept_code, department").order("dept_code")),
    rows(canon.from("dim_phase").select("phase_code, gate, phase").order("gate")),
    rows(records),
  ]);
  if (!departments.ok) return departments;
  if (!phases.ok) return phases;
  if (!found.ok) return found;
  const cells: Record<string, number> = {};
  for (const r of found.data) {
    const key = `${str(r["urid"]).slice(0, 4)}|${str(r["phase_code"])}`;
    cells[key] = (cells[key] ?? 0) + 1;
  }
  return ok({
    departments: departments.data.map((d) => ({
      code: str(d["dept_code"]),
      name: str(d["department"]),
    })),
    phases: phases.data
      .filter((p) => numOrNull(p["gate"]) !== null)
      .map((p) => ({ gate: num(p["gate"]), code: str(p["phase_code"]), name: str(p["phase"]) })),
    cells,
    total: found.data.length,
  });
}

// Labor ---------------------------------------------------------------------------------------------------

export interface LaborRow {
  readonly project: ReportProject;
  readonly currency: string | null;
  /** Budgeted labor (Labor lines of the working budgets); null while any is unpriced. */
  readonly budgetMinor: number | null;
  readonly unpricedCount: number;
  readonly workedMinutes: number;
  readonly timesheetCount: number;
  readonly openEntryCount: number;
}

export interface PayrollRunRow {
  readonly payrollRunId: string;
  readonly hours: number;
  /** Null when masked (Section 8.3) or when nothing is priced. */
  readonly amountMinor: number | null;
  readonly isMasked: boolean;
  readonly lineCount: number;
}

export interface LaborReport {
  readonly projects: readonly LaborRow[];
  readonly payrollRuns: readonly PayrollRunRow[];
}

/** Labor: budgeted labor, worked time from timesheets, and payroll run amounts (masked when restricted). */
export async function laborReport(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<LaborReport>> {
  const projects = await projectsOf(db, input.orgId, input.projectId);
  if (!projects.ok) return projects;
  const ids = projects.data.map((p) => p.id);
  const [facts, hours, payroll] = await Promise.all([
    lineFacts(db, ids),
    ids.length === 0
      ? Promise.resolve(ok([] as Raw[]))
      : rows(
          db
            .from("timesheet_hours")
            .select("timesheet_id, project_id, worked_minutes, has_open_entry")
            .in("project_id", ids),
        ),
    input.projectId
      ? Promise.resolve(ok([] as Raw[]))
      : rows(
          db
            .from("payroll_line_amounts")
            .select("payroll_run_id, hours, amount_minor, is_masked")
            .eq("org_id", input.orgId),
        ),
  ]);
  if (!facts.ok) return facts;
  if (!hours.ok) return hours;
  if (!payroll.ok) return payroll;
  const working = workingBudgetIds(facts.data);
  const labor = facts.data.filter((f) => working.has(f.budgetId) && f.lineType === "Labor");
  const runs = new Map<
    string,
    { hours: number; amounts: (number | null)[]; masked: boolean; count: number }
  >();
  for (const l of payroll.data) {
    const id = str(l["payroll_run_id"]);
    const run = runs.get(id) ?? { hours: 0, amounts: [], masked: false, count: 0 };
    run.hours += num(l["hours"]);
    run.amounts.push(numOrNull(l["amount_minor"]));
    run.masked ||= l["is_masked"] === true;
    run.count += 1;
    runs.set(id, run);
  }
  return ok({
    projects: projects.data.map((project) => {
      const lines = labor.filter((l) => l.projectId === project.id);
      const sheets = hours.data.filter((h) => str(h["project_id"]) === project.id);
      const sum = nullAwareSum(lines.map((l) => l.extendedMinor));
      return {
        project,
        currency: lines[0]?.currency ?? null,
        budgetMinor: lines.length === 0 ? null : sum.total,
        unpricedCount: sum.unpricedCount,
        workedMinutes: sheets.reduce((s, h) => s + num(h["worked_minutes"]), 0),
        timesheetCount: sheets.length,
        openEntryCount: sheets.filter((h) => h["has_open_entry"] === true).length,
      };
    }),
    payrollRuns: [...runs.entries()].map(([id, run]) => ({
      payrollRunId: id,
      hours: run.hours,
      amountMinor: run.masked ? null : nullAwareSum(run.amounts).total,
      isMasked: run.masked,
      lineCount: run.count,
    })),
  });
}

// Purchase order exposure ------------------------------------------------------------------------------

export interface PoExposureRow {
  readonly purchaseOrderId: string;
  readonly poNumber: number;
  readonly projectId: string;
  readonly projectKey: string | null;
  readonly vendorName: string | null;
  readonly state: string;
  readonly currency: string;
  readonly unpricedCount: number;
  /** Lines plus approved changes; null while any line is unpriced. */
  readonly committedMinor: number | null;
  /** Value received: received quantity times unit price; null when a received line is unpriced. */
  readonly receivedMinor: number | null;
  /** Committed less received; null when either is null. */
  readonly exposureMinor: number | null;
}

/** Open commitment per purchase order: committed, received and the exposure that remains. */
export async function purchaseOrderExposure(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<PoExposureRow[]>> {
  let orders = db
    .from("purchase_orders")
    .select(
      "id, po_number, project_id, po_state, currency_code, project:projects(project_key), vendor:vendors(counterparty:counterparties(organization:organizations!counterparties_organization_id_fkey(name)))",
    )
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .order("po_number");
  if (input.projectId) orders = orders.eq("project_id", input.projectId);
  const pos = await rows(orders);
  if (!pos.ok) return pos;
  if (pos.data.length === 0) return ok([]);
  const ids = pos.data.map((p) => str(p["id"]));
  const [totals, received] = await Promise.all([
    rows(
      db
        .from("purchase_order_totals")
        .select("purchase_order_id, unpriced_count, lines_total_minor, approved_changes_minor")
        .in("purchase_order_id", ids),
    ),
    rows(
      db
        .from("receipt_lines")
        .select(
          "quantity_received, deleted_at, po_line:po_lines!inner(purchase_order_id, unit_price_minor)",
        )
        .in("po_line.purchase_order_id", ids)
        .is("deleted_at", null),
    ),
  ]);
  if (!totals.ok) return totals;
  if (!received.ok) return received;
  const totalOf = new Map(totals.data.map((t) => [str(t["purchase_order_id"]), t]));
  const receivedOf = new Map<string, (number | null)[]>();
  for (const r of received.data) {
    const line = obj(r["po_line"]);
    const po = str(line?.["purchase_order_id"]);
    const price = numOrNull(line?.["unit_price_minor"]);
    const value = price === null ? null : Math.round(num(r["quantity_received"]) * price);
    receivedOf.set(po, [...(receivedOf.get(po) ?? []), value]);
  }
  return ok(
    pos.data.map((p) => {
      const id = str(p["id"]);
      const t = totalOf.get(id) ?? {};
      const lines = numOrNull(t["lines_total_minor"]);
      const committed = lines === null ? null : lines + num(t["approved_changes_minor"]);
      const rec = receivedOf.get(id) ?? [];
      const receivedMinor = rec.length === 0 ? 0 : nullAwareSum(rec).total;
      const vendor = obj(obj(obj(p["vendor"])?.["counterparty"])?.["organization"]);
      return {
        purchaseOrderId: id,
        poNumber: num(p["po_number"]),
        projectId: str(p["project_id"]),
        projectKey: strOrNull(obj(p["project"])?.["project_key"]),
        vendorName: strOrNull(vendor?.["name"]),
        state: str(p["po_state"]),
        currency: str(p["currency_code"]).trim(),
        unpricedCount: num(t["unpriced_count"]),
        committedMinor: committed,
        receivedMinor,
        exposureMinor:
          committed === null || receivedMinor === null ? null : committed - receivedMinor,
      };
    }),
  );
}

// Incidents ---------------------------------------------------------------------------------------------

export interface IncidentCountRow {
  readonly severityId: string | null;
  readonly severityLabel: string | null;
  readonly state: string;
  readonly count: number;
  readonly incidentIds: readonly string[];
}

export interface IncidentsReport {
  readonly rows: readonly IncidentCountRow[];
  readonly total: number;
  readonly open: number;
}

/** Incident counts by canon severity and incident state. */
export async function incidentsReport(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly projectId?: string | null;
    readonly from?: string | null;
    readonly to?: string | null;
  },
): Promise<Result<IncidentsReport>> {
  let query = db
    .from("incidents")
    .select("id, severity_enum_id, incident_state, occurred_at")
    .eq("org_id", input.orgId)
    .is("deleted_at", null);
  if (input.projectId) query = query.eq("project_id", input.projectId);
  if (input.from) query = query.gte("occurred_at", input.from);
  if (input.to) query = query.lte("occurred_at", input.to);
  const [incidents, severities] = await Promise.all([
    rows(query),
    rows(
      db
        .schema("xpms")
        .from("std_enumeration")
        .select("record_id, enum_label, sort_order")
        .eq("enum_domain", "Incident Severity")
        .order("sort_order"),
    ),
  ]);
  if (!incidents.ok) return incidents;
  if (!severities.ok) return severities;
  const order = new Map(severities.data.map((s, i) => [str(s["record_id"]), i]));
  const label = new Map(severities.data.map((s) => [str(s["record_id"]), str(s["enum_label"])]));
  const groups = new Map<string, { severity: string | null; state: string; ids: string[] }>();
  for (const i of incidents.data) {
    const severity = strOrNull(i["severity_enum_id"]);
    const state = str(i["incident_state"]);
    const key = `${severity ?? ""}|${state}`;
    const g = groups.get(key) ?? { severity, state, ids: [] };
    g.ids.push(str(i["id"]));
    groups.set(key, g);
  }
  const states = ["Reported", "Dispatched", "Contained", "Closed"];
  return ok({
    rows: [...groups.values()]
      .map((g) => ({
        severityId: g.severity,
        severityLabel: g.severity ? (label.get(g.severity) ?? null) : null,
        state: g.state,
        count: g.ids.length,
        incidentIds: g.ids,
      }))
      .sort(
        (a, b) =>
          (order.get(a.severityId ?? "") ?? 99) - (order.get(b.severityId ?? "") ?? 99) ||
          states.indexOf(a.state) - states.indexOf(b.state),
      ),
    total: incidents.data.length,
    open: incidents.data.filter((i) => str(i["incident_state"]) !== "Closed").length,
  });
}

// Saved reports (A18's report builder) -------------------------------------------------------------------

export interface SavedReport {
  readonly id: string;
  readonly name: string;
  readonly sourceCode: string;
  readonly chart: string;
  readonly shared: boolean;
  readonly mine: boolean;
  readonly updatedAt: string;
}

/** Report definitions the viewer owns or may read as shared (A18, migration 0550). */
export async function listSavedReports(
  db: XosClient,
  input: { readonly orgId: string; readonly membershipId: string },
): Promise<Result<SavedReport[]>> {
  const result = await rows(
    untyped(db)
      .from("report_definitions")
      .select("id, name, source_code, chart, shared, membership_id, updated_at")
      .eq("org_id", input.orgId)
      .is("deleted_at", null)
      .order("name"),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      id: str(r["id"]),
      name: str(r["name"]),
      sourceCode: str(r["source_code"]),
      chart: str(r["chart"]),
      shared: r["shared"] === true,
      mine: str(r["membership_id"]) === input.membershipId,
      updatedAt: str(r["updated_at"]),
    })),
  );
}
