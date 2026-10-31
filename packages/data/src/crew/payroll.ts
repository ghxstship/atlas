import type { Database, XosClient } from "../client.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";
import {
  landed,
  MEMBERSHIP_EMBED,
  toMemberRef,
  toTransitions,
  type MemberRef,
  type TransitionEntry,
} from "./shared.ts";
import * as enums from "../enums.generated.ts";

/**
 * Pay periods, payroll runs, their lines and the payroll export (migrations 0341 and 0461). A posted
 * period never reopens (invariant 14); a Draft run reaches Accepted only through Calculated, Approved
 * and Exported (invariant 15). Calculation runs in the database so rates stay masked; the export needs
 * the payroll_export plan feature, the restricted export capability and step-up authentication.
 * A19's payroll handoffs (Gusto, ADP, Rippling) consume the produced file.
 */

export type PayPeriodState = Database["app"]["Enums"]["pay_period_state"];
export type PayrollRunState = Database["app"]["Enums"]["payroll_run_state"];
export const PAY_PERIOD_STATES: readonly PayPeriodState[] = enums.payPeriodState;
export const PAYROLL_RUN_STATES: readonly PayrollRunState[] = enums.payrollRunState;

export interface PayPeriod {
  readonly id: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly state: PayPeriodState;
  readonly runCount: number;
}

/** Pay periods of the org, latest first. */
export async function listPayPeriods(db: XosClient, orgId: string): Promise<Result<PayPeriod[]>> {
  const { data, error } = await db
    .from("pay_periods")
    .select("id, starts_on, ends_on, pay_period_state, payroll_runs(id, deleted_at)")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("starts_on", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((p) => ({
      id: p.id,
      startsOn: p.starts_on,
      endsOn: p.ends_on,
      state: p.pay_period_state,
      runCount: (p.payroll_runs ?? []).filter((r) => r.deleted_at === null).length,
    })),
  );
}

export interface PayPeriodDetail extends PayPeriod {
  readonly transitions: readonly TransitionEntry[];
  readonly runs: readonly PayrollRun[];
}

export async function getPayPeriod(db: XosClient, id: string): Promise<Result<PayPeriodDetail>> {
  const { data, error } = await db
    .from("pay_periods")
    .select("id, org_id, starts_on, ends_on, pay_period_state")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const [ledger, runs] = await Promise.all([
    db
      .from("pay_period_state_transitions")
      .select("id, from_state, to_state, reason, created_at, created_by")
      .eq("pay_period_id", id),
    listPayrollRuns(db, { orgId: data.org_id, payPeriodId: id }),
  ]);
  if (ledger.error) return fail(toDataError(ledger.error));
  if (!runs.ok) return runs;
  return ok({
    id: data.id,
    startsOn: data.starts_on,
    endsOn: data.ends_on,
    state: data.pay_period_state,
    runCount: runs.data.length,
    transitions: toTransitions(ledger.data),
    runs: runs.data,
  });
}

/** Opens a pay period. Periods of an org never overlap. */
export async function createPayPeriod(
  db: XosClient,
  orgId: string,
  input: { readonly startsOn: string; readonly endsOn: string },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("pay_periods")
    .insert({ org_id: orgId, starts_on: input.startsOn, ends_on: input.endsOn })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/**
 * The next pay period an org adds (app.next_pay_period_dates): the day after its latest period, sized by
 * payroll.pay_period and, for the first weekly or biweekly period, aligned to payroll.week_start. `today` is
 * the org's date (orgToday), so a first period starts in the org's week, not UTC's.
 */
export async function nextPayPeriodDates(
  db: XosClient,
  orgId: string,
  today: string,
): Promise<Result<{ startsOn: string; endsOn: string }>> {
  const { data, error } = await db.rpc("next_pay_period_dates", {
    p_org_id: orgId,
    p_today: today,
  });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (!row) return fail({ kind: "not-found" });
  return ok({ startsOn: row.starts_on, endsOn: row.ends_on });
}

/** Changes an Open period's dates. */
export async function updatePayPeriod(
  db: XosClient,
  id: string,
  input: { readonly startsOn: string; readonly endsOn: string },
): Promise<Result<null>> {
  const { data, error } = await db
    .from("pay_periods")
    .update({ starts_on: input.startsOn, ends_on: input.endsOn })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

/** Closes, reopens or posts a period (app.transition_pay_period). */
export async function transitionPayPeriod(
  db: XosClient,
  id: string,
  expected: PayPeriodState,
  next: PayPeriodState,
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("transition_pay_period", {
    p_pay_period_id: id,
    p_expected: expected,
    p_next: next,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}

// Payroll runs -------------------------------------------------------------------------------------------

export interface PayrollRun {
  readonly id: string;
  readonly payPeriodId: string;
  readonly periodStartsOn: string;
  readonly periodEndsOn: string;
  readonly currencyCode: string;
  readonly state: PayrollRunState;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

interface RunRow {
  id: string;
  pay_period_id: string;
  currency_code: string;
  payroll_run_state: PayrollRunState;
  created_by: string | null;
  created_at: string;
  pay_period: { starts_on: string; ends_on: string } | null;
}

const RUN_SELECT =
  "id, pay_period_id, currency_code, payroll_run_state, created_by, created_at, pay_period:pay_periods!payroll_runs_pay_period_id_fkey(starts_on, ends_on)";

function toRun(r: RunRow): PayrollRun {
  return {
    id: r.id,
    payPeriodId: r.pay_period_id,
    periodStartsOn: r.pay_period?.starts_on ?? "",
    periodEndsOn: r.pay_period?.ends_on ?? "",
    currencyCode: r.currency_code,
    state: r.payroll_run_state,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export async function listPayrollRuns(
  db: XosClient,
  filter: {
    readonly orgId: string;
    readonly payPeriodId?: string;
    readonly states?: readonly PayrollRunState[];
  },
): Promise<Result<PayrollRun[]>> {
  let query = db
    .from("payroll_runs")
    .select(RUN_SELECT)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (filter.payPeriodId) query = query.eq("pay_period_id", filter.payPeriodId);
  if (filter.states && filter.states.length > 0) {
    query = query.in("payroll_run_state", [...filter.states]);
  }
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data as unknown as RunRow[]).map(toRun));
}

export interface PayrollLine {
  readonly id: string;
  readonly member: MemberRef;
  readonly earningCode: string;
  readonly earningName: string;
  readonly isOvertime: boolean;
  readonly hours: number;
  readonly rateMinor: number | null;
  readonly amountMinor: number | null;
  readonly masked: boolean;
}

export interface PayrollExport {
  readonly id: string;
  readonly payrollRunId: string;
  readonly provider: string;
  readonly fileUri: string;
  readonly checksum: string;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

export interface PayrollRunDetail extends PayrollRun {
  readonly lines: readonly PayrollLine[];
  readonly exports: readonly PayrollExport[];
  readonly transitions: readonly TransitionEntry[];
  /** NULL-aware total: null when any line is masked or unpriced (Section 3.7). */
  readonly totalMinor: number | null;
  readonly totalHours: number;
}

export async function getPayrollRun(db: XosClient, id: string): Promise<Result<PayrollRunDetail>> {
  const { data, error } = await db
    .from("payroll_runs")
    .select(RUN_SELECT)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const [lines, codes, exports, ledger] = await Promise.all([
    db
      .from("payroll_line_amounts")
      .select("id, membership_id, earning_code_id, hours, rate_minor, amount_minor, is_masked")
      .eq("payroll_run_id", id),
    db.from("earning_codes").select("id, code, name, is_overtime"),
    db
      .from("payroll_exports")
      .select("id, payroll_run_id, provider, file_uri, checksum_sha256, created_at, created_by")
      .eq("payroll_run_id", id)
      .order("created_at", { ascending: false }),
    db
      .from("payroll_run_state_transitions")
      .select("id, from_state, to_state, reason, created_at, created_by")
      .eq("payroll_run_id", id),
  ]);
  for (const r of [lines, codes, exports, ledger]) {
    if (r.error) return fail(toDataError(r.error));
  }
  const memberships = [...new Set((lines.data ?? []).map((l) => l.membership_id ?? ""))].filter(
    (m) => m !== "",
  );
  const people = new Map<string, MemberRef>();
  if (memberships.length > 0) {
    const m = await db.from("memberships").select(MEMBERSHIP_EMBED).in("id", memberships);
    if (m.error) return fail(toDataError(m.error));
    for (const row of m.data) people.set(row.id, toMemberRef(row, row.id));
  }
  const codeById = new Map((codes.data ?? []).map((c) => [c.id, c]));
  const mapped = (lines.data ?? [])
    .map((l): PayrollLine => {
      const code = codeById.get(l.earning_code_id ?? "");
      const membershipId = l.membership_id ?? "";
      return {
        id: l.id ?? "",
        member: people.get(membershipId) ?? toMemberRef(null, membershipId),
        earningCode: code?.code ?? "",
        earningName: code?.name ?? "",
        isOvertime: code?.is_overtime ?? false,
        hours: Number(l.hours ?? 0),
        rateMinor: l.is_masked ? null : l.rate_minor,
        amountMinor: l.is_masked ? null : l.amount_minor,
        masked: l.is_masked ?? true,
      };
    })
    .sort(
      (a, b) =>
        (a.member.name ?? "").localeCompare(b.member.name ?? "") ||
        a.earningCode.localeCompare(b.earningCode),
    );
  return ok({
    ...toRun(data as unknown as RunRow),
    lines: mapped,
    exports: (exports.data ?? []).map((x) => ({
      id: x.id,
      payrollRunId: x.payroll_run_id,
      provider: x.provider,
      fileUri: x.file_uri,
      checksum: x.checksum_sha256,
      createdAt: x.created_at,
      createdBy: x.created_by,
    })),
    transitions: toTransitions(ledger.data ?? []),
    totalMinor: nullAwareTotal(mapped.map((l) => l.amountMinor)),
    totalHours: Math.round(mapped.reduce((sum, l) => sum + l.hours, 0) * 100) / 100,
  });
}

/** Sum of minor amounts; any null makes the total null (aggregates of blanks are blank). */
export function nullAwareTotal(amounts: readonly (number | null)[]): number | null {
  if (amounts.length === 0) return 0;
  let total = 0;
  for (const a of amounts) {
    if (a === null) return null;
    total += a;
  }
  return total;
}

/** Starts a Draft run for a pay period in one currency. */
export async function createPayrollRun(
  db: XosClient,
  input: { readonly orgId: string; readonly payPeriodId: string; readonly currencyCode: string },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("payroll_runs")
    .insert({
      org_id: input.orgId,
      pay_period_id: input.payPeriodId,
      currency_code: input.currencyCode,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Calculates a Draft run from approved timesheets (app.calculate_payroll_run); returns the line count. */
export async function calculatePayrollRun(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<{ lines: number }>> {
  const { data, error } = await db.rpc("calculate_payroll_run", {
    p_payroll_run_id: id,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ lines: data });
}

/**
 * Approves a Calculated run under spend authority (app.approve_payroll_run). `complete` is false when
 * a second approver is still needed above the dual threshold.
 */
export async function approvePayrollRun(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<{ complete: boolean }>> {
  const { data, error } = await db.rpc("approve_payroll_run", {
    p_payroll_run_id: id,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ complete: data });
}

/** Any other run move with compare-and-set (app.transition_payroll_run). */
export async function transitionPayrollRun(
  db: XosClient,
  id: string,
  expected: PayrollRunState,
  next: PayrollRunState,
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("transition_payroll_run", {
    p_payroll_run_id: id,
    p_expected: expected,
    p_next: next,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}

export interface ExportFile {
  readonly exportId: string | null;
  readonly fileUri: string;
  readonly checksum: string;
  readonly content: string;
}

/** Produces the export file of an Approved run and moves it to Exported (app.produce_payroll_export). */
export async function producePayrollExport(
  db: XosClient,
  runId: string,
  provider: string,
): Promise<Result<ExportFile>> {
  const { data, error } = await db
    .rpc("produce_payroll_export", { p_payroll_run_id: runId, p_provider: provider })
    .single();
  if (error) return fail(toDataError(error));
  return ok({
    exportId: data.payroll_export_id,
    fileUri: data.file_uri,
    checksum: data.checksum_sha256,
    content: data.content,
  });
}

/** Renders a produced export again for download, checking its checksum (app.payroll_export_file). */
export async function payrollExportFile(
  db: XosClient,
  exportId: string,
): Promise<Result<ExportFile>> {
  const { data, error } = await db
    .rpc("payroll_export_file", { p_payroll_export_id: exportId })
    .single();
  if (error) return fail(toDataError(error));
  return ok({
    exportId,
    fileUri: data.file_uri,
    checksum: data.checksum_sha256,
    content: data.content,
  });
}

/** Every export of the org, newest first, with its run and period. */
export async function listPayrollExports(
  db: XosClient,
  orgId: string,
): Promise<Result<Array<PayrollExport & { run: PayrollRun | null }>>> {
  const { data, error } = await db
    .from("payroll_exports")
    .select(
      `id, payroll_run_id, provider, file_uri, checksum_sha256, created_at, created_by, run:payroll_runs!payroll_exports_payroll_run_id_fkey(${RUN_SELECT})`,
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  const rows = data as unknown as Array<{
    id: string;
    payroll_run_id: string;
    provider: string;
    file_uri: string;
    checksum_sha256: string;
    created_at: string;
    created_by: string | null;
    run: RunRow | null;
  }>;
  return ok(
    rows.map((x) => ({
      id: x.id,
      payrollRunId: x.payroll_run_id,
      provider: x.provider,
      fileUri: x.file_uri,
      checksum: x.checksum_sha256,
      createdAt: x.created_at,
      createdBy: x.created_by,
      run: x.run ? toRun(x.run) : null,
    })),
  );
}

// Earning codes -------------------------------------------------------------------------------------------

export interface EarningCode {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isOvertime: boolean;
}

/** Earning codes of the org in code order. */
export async function listEarningCodes(
  db: XosClient,
  orgId: string,
): Promise<Result<EarningCode[]>> {
  const { data, error } = await db
    .from("earning_codes")
    .select("id, code, name, is_overtime")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("code", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(data.map((c) => ({ id: c.id, code: c.code, name: c.name, isOvertime: c.is_overtime })));
}
