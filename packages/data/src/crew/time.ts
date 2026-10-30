import type { Database, XosClient } from "../client.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";
import {
  landed,
  ENGAGEMENT_EMBED,
  MEMBERSHIP_EMBED,
  toWorker,
  type EngagementRow,
  toTransitions,
  type WorkerRef,
  type TransitionEntry,
} from "./shared.ts";
import * as enums from "../enums.generated.ts";

/**
 * Time entries (app.time_entries): clock-in and clock-out punches. One person's entries never overlap
 * (invariant 20), so a second clock in from another device is refused by the database. Every change
 * is audited, and a change inside an approved timesheet voids the approval (invariant 19). Compass
 * calls `clockIn` and `clockOut` with its own source.
 */

export type TimeEntrySource = Database["app"]["Enums"]["time_entry_source"];
export type CorrectionState = Database["app"]["Enums"]["correction_state"];

export interface TimeEntry {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly member: WorkerRef;
  readonly shiftId: string | null;
  readonly clockIn: string;
  readonly clockOut: string | null;
  readonly breakMinutes: number;
  readonly source: TimeEntrySource;
  readonly createdAt: string;
}

const ENTRY_SELECT = `id, project_id, membership_id, shift_id, clock_in, clock_out, break_minutes, source, created_at, project:projects!time_entries_project_id_fkey(project_key), membership:memberships!time_entries_membership_id_fkey(${MEMBERSHIP_EMBED}), engagement_id, engagement:engagements!time_entries_engagement_id_fkey(${ENGAGEMENT_EMBED})`;

interface EntryRow {
  id: string;
  project_id: string;
  membership_id: string | null;
  engagement_id: string | null;
  engagement: EngagementRow | null;
  shift_id: string | null;
  clock_in: string;
  clock_out: string | null;
  break_minutes: number;
  source: TimeEntrySource;
  created_at: string;
  project: { project_key: string } | null;
  membership: { id: string; person_id: string; person: { full_name: string | null } | null } | null;
}

function toEntry(row: EntryRow): TimeEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? "",
    member: toWorker(row.membership, row.membership_id, row.engagement, row.engagement_id),
    shiftId: row.shift_id,
    clockIn: row.clock_in,
    clockOut: row.clock_out,
    breakMinutes: row.break_minutes,
    source: row.source,
    createdAt: row.created_at,
  };
}

/** Worked minutes of an entry: closed time less breaks; null while the person is clocked in. */
export function workedMinutes(entry: Pick<TimeEntry, "clockIn" | "clockOut" | "breakMinutes">) {
  if (entry.clockOut === null) return null;
  const span = Math.round((Date.parse(entry.clockOut) - Date.parse(entry.clockIn)) / 60_000);
  return Math.max(0, span - entry.breakMinutes);
}

export interface TimeEntryFilter {
  readonly orgId: string;
  readonly projectId?: string;
  readonly membershipId?: string;
  readonly engagementId?: string;
  readonly shiftId?: string;
  /** Entries clocked in at or after this instant. */
  readonly from?: string;
  /** Entries clocked in before this instant. */
  readonly to?: string;
  readonly openOnly?: boolean;
}

/** Time entries the caller may read, newest clock in first. */
export async function listTimeEntries(
  db: XosClient,
  filter: TimeEntryFilter,
): Promise<Result<TimeEntry[]>> {
  let query = db
    .from("time_entries")
    .select(ENTRY_SELECT)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null)
    .order("clock_in", { ascending: false })
    .limit(1000);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  if (filter.membershipId) query = query.eq("membership_id", filter.membershipId);
  if (filter.engagementId) query = query.eq("engagement_id", filter.engagementId);
  if (filter.shiftId) query = query.eq("shift_id", filter.shiftId);
  if (filter.from) query = query.gte("clock_in", filter.from);
  if (filter.to) query = query.lt("clock_in", filter.to);
  if (filter.openOnly) query = query.is("clock_out", null);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data as unknown as EntryRow[]).map(toEntry));
}

export interface AuditEntry {
  readonly id: string;
  readonly at: string;
  readonly by: string | null;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>>;
}

export interface Correction {
  readonly id: string;
  readonly timeEntryId: string;
  readonly requestedBy: string | null;
  readonly clockIn: string;
  readonly clockOut: string | null;
  readonly breakMinutes: number;
  readonly reason: string;
  readonly state: CorrectionState;
  readonly createdAt: string;
}

export interface TimeEntryDetail extends TimeEntry {
  readonly audit: readonly AuditEntry[];
  readonly corrections: readonly Correction[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** One entry with its audit trail and corrections, or not-found. */
export async function getTimeEntry(db: XosClient, id: string): Promise<Result<TimeEntryDetail>> {
  const { data, error } = await db
    .from("time_entries")
    .select(ENTRY_SELECT)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const [audit, corrections] = await Promise.all([
    db
      .from("time_entry_audit")
      .select("id, created_at, created_by, old_values, new_values")
      .eq("time_entry_id", id)
      .order("created_at", { ascending: true }),
    db
      .from("time_entry_corrections")
      .select(
        "id, time_entry_id, requested_by, proposed_clock_in, proposed_clock_out, proposed_break_minutes, reason, correction_state, created_at",
      )
      .eq("time_entry_id", id)
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
  ]);
  if (audit.error) return fail(toDataError(audit.error));
  if (corrections.error) return fail(toDataError(corrections.error));
  return ok({
    ...toEntry(data as unknown as EntryRow),
    audit: audit.data.map((a) => ({
      id: a.id,
      at: a.created_at,
      by: a.created_by,
      before: asRecord(a.old_values),
      after: asRecord(a.new_values) ?? {},
    })),
    corrections: corrections.data.map(toCorrection),
  });
}

interface CorrectionRow {
  id: string;
  time_entry_id: string;
  requested_by: string | null;
  proposed_clock_in: string;
  proposed_clock_out: string | null;
  proposed_break_minutes: number;
  reason: string;
  correction_state: CorrectionState;
  created_at: string;
}

function toCorrection(c: CorrectionRow): Correction {
  return {
    id: c.id,
    timeEntryId: c.time_entry_id,
    requestedBy: c.requested_by,
    clockIn: c.proposed_clock_in,
    clockOut: c.proposed_clock_out,
    breakMinutes: c.proposed_break_minutes,
    reason: c.reason,
    state: c.correction_state,
    createdAt: c.created_at,
  };
}

/** Corrections awaiting a decision in the org, oldest first. */
export async function listPendingCorrections(
  db: XosClient,
  orgId: string,
): Promise<Result<Correction[]>> {
  const { data, error } = await db
    .from("time_entry_corrections")
    .select(
      "id, time_entry_id, requested_by, proposed_clock_in, proposed_clock_out, proposed_break_minutes, reason, correction_state, created_at",
    )
    .eq("org_id", orgId)
    .eq("correction_state", "Proposed")
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(data.map(toCorrection));
}

export interface ClockInInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly membershipId: string;
  readonly shiftId?: string | null;
  readonly source: TimeEntrySource;
  readonly kioskDeviceId?: string | null;
  readonly at?: Date;
}

/** Clocks a person in. A second open entry for the same person is refused (time_entry_overlap). */
export async function clockIn(db: XosClient, input: ClockInInput): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("time_entries")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      membership_id: input.membershipId,
      shift_id: input.shiftId ?? null,
      source: input.source,
      kiosk_device_id: input.kioskDeviceId ?? null,
      clock_in: (input.at ?? new Date()).toISOString(),
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Clocks a person out of an open entry, recording unpaid break minutes. */
export async function clockOut(
  db: XosClient,
  id: string,
  breakMinutes: number,
  at: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("time_entries")
    .update({ clock_out: at.toISOString(), break_minutes: breakMinutes })
    .eq("id", id)
    .is("clock_out", null)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

export interface ManualEntryInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly membershipId: string;
  readonly shiftId: string | null;
  readonly clockIn: string;
  readonly clockOut: string | null;
  readonly breakMinutes: number;
}

/** Records a closed or open entry typed in by a supervisor or the worker (source Web). */
export async function createTimeEntry(
  db: XosClient,
  input: ManualEntryInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("time_entries")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      membership_id: input.membershipId,
      shift_id: input.shiftId,
      clock_in: input.clockIn,
      clock_out: input.clockOut,
      break_minutes: input.breakMinutes,
      source: "Web",
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Edits an entry's times directly (time entry writers); the change is audited. */
export async function updateTimeEntry(
  db: XosClient,
  id: string,
  patch: {
    readonly clockIn: string;
    readonly clockOut: string | null;
    readonly breakMinutes: number;
  },
): Promise<Result<null>> {
  const { data, error } = await db
    .from("time_entries")
    .update({
      clock_in: patch.clockIn,
      clock_out: patch.clockOut,
      break_minutes: patch.breakMinutes,
    })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

/** Voids an entry (soft delete, audited); time entries are never hard-deleted. */
export async function voidTimeEntry(
  db: XosClient,
  id: string,
  at: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("time_entries")
    .update({ deleted_at: at.toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

/** Asks for a correction to an entry; a time approver other than the requester decides it. */
export async function requestCorrection(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly timeEntryId: string;
    readonly clockIn: string;
    readonly clockOut: string | null;
    readonly breakMinutes: number;
    readonly reason: string;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("time_entry_corrections")
    .insert({
      org_id: input.orgId,
      time_entry_id: input.timeEntryId,
      proposed_clock_in: input.clockIn,
      proposed_clock_out: input.clockOut,
      proposed_break_minutes: input.breakMinutes,
      reason: input.reason.trim(),
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Approves or rejects a correction (app.decide_time_entry_correction). */
export async function decideCorrection(
  db: XosClient,
  id: string,
  decision: Database["app"]["Enums"]["approval_decision"],
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("decide_time_entry_correction", {
    p_correction_id: id,
    p_decision: decision,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}

// Timesheets ------------------------------------------------------------------------------------------

export type TimesheetState = Database["app"]["Enums"]["timesheet_state"];
export const TIMESHEET_STATES: readonly TimesheetState[] = enums.timesheetState;

export interface Timesheet {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly member: WorkerRef;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly state: TimesheetState;
  readonly submittedBy: string | null;
  /** Worked minutes derived from the time entries (app.timesheet_hours). */
  readonly workedMinutes: number;
  readonly hasOpenEntry: boolean;
}

const SHEET_SELECT = `id, org_id, project_id, membership_id, period_start, period_end, timesheet_state, submitted_by, project:projects!timesheets_project_id_fkey(project_key), membership:memberships!timesheets_membership_id_fkey(${MEMBERSHIP_EMBED}), engagement_id, engagement:engagements!timesheets_engagement_id_fkey(${ENGAGEMENT_EMBED})`;

interface SheetRow {
  id: string;
  org_id: string;
  project_id: string;
  membership_id: string | null;
  engagement_id: string | null;
  engagement: EngagementRow | null;
  period_start: string;
  period_end: string;
  timesheet_state: TimesheetState;
  submitted_by: string | null;
  project: { project_key: string } | null;
  membership: { id: string; person_id: string; person: { full_name: string | null } | null } | null;
}

async function withHours(db: XosClient, rows: readonly SheetRow[]): Promise<Result<Timesheet[]>> {
  if (rows.length === 0) return ok([]);
  const { data, error } = await db
    .from("timesheet_hours")
    .select("timesheet_id, worked_minutes, has_open_entry")
    .in(
      "timesheet_id",
      rows.map((r) => r.id),
    );
  if (error) return fail(toDataError(error));
  const hours = new Map(data.map((h) => [h.timesheet_id, h]));
  return ok(
    rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      projectKey: r.project?.project_key ?? "",
      member: toWorker(r.membership, r.membership_id, r.engagement, r.engagement_id),
      periodStart: r.period_start,
      periodEnd: r.period_end,
      state: r.timesheet_state,
      submittedBy: r.submitted_by,
      workedMinutes: hours.get(r.id)?.worked_minutes ?? 0,
      hasOpenEntry: hours.get(r.id)?.has_open_entry ?? false,
    })),
  );
}

export interface TimesheetFilter {
  readonly orgId: string;
  readonly projectId?: string;
  readonly membershipId?: string;
  readonly states?: readonly TimesheetState[];
}

/** Timesheets the caller may read, latest period first, with derived hours. */
export async function listTimesheets(
  db: XosClient,
  filter: TimesheetFilter,
): Promise<Result<Timesheet[]>> {
  let query = db
    .from("timesheets")
    .select(SHEET_SELECT)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null)
    .order("period_start", { ascending: false })
    .limit(500);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  if (filter.membershipId) query = query.eq("membership_id", filter.membershipId);
  if (filter.states && filter.states.length > 0) {
    query = query.in("timesheet_state", [...filter.states]);
  }
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return withHours(db, data as unknown as SheetRow[]);
}

export interface TimesheetApproval {
  readonly id: string;
  readonly approvedBy: string;
  readonly approvedMinutes: number;
  readonly at: string;
  readonly voidedAt: string | null;
}

export interface TimesheetDetail extends Timesheet {
  readonly entries: readonly TimeEntry[];
  readonly approvals: readonly TimesheetApproval[];
  readonly transitions: readonly TransitionEntry[];
}

/** One timesheet with its entries, approvals and state ledger, or not-found. */
export async function getTimesheet(db: XosClient, id: string): Promise<Result<TimesheetDetail>> {
  const { data, error } = await db
    .from("timesheets")
    .select(SHEET_SELECT)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const row = data as unknown as SheetRow;
  const [sheet, approvals, ledger] = await Promise.all([
    withHours(db, [row]),
    db
      .from("timesheet_approvals")
      .select("id, approved_by, approved_minutes, created_at, voided_at")
      .eq("timesheet_id", id)
      .order("created_at", { ascending: true }),
    db
      .from("timesheet_state_transitions")
      .select("id, from_state, to_state, reason, created_at, created_by")
      .eq("timesheet_id", id),
  ]);
  if (!sheet.ok) return sheet;
  if (approvals.error) return fail(toDataError(approvals.error));
  if (ledger.error) return fail(toDataError(ledger.error));
  const end = new Date(`${row.period_end}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const entries = await listTimeEntries(db, {
    orgId: row.org_id,
    projectId: row.project_id,
    ...(row.membership_id ? { membershipId: row.membership_id } : {}),
    ...(row.engagement_id ? { engagementId: row.engagement_id } : {}),
    from: `${row.period_start}T00:00:00Z`,
    to: end.toISOString(),
  });
  if (!entries.ok) return entries;
  return ok({
    ...(sheet.data[0] as Timesheet),
    entries: entries.data,
    approvals: approvals.data.map((a) => ({
      id: a.id,
      approvedBy: a.approved_by,
      approvedMinutes: a.approved_minutes,
      at: a.created_at,
      voidedAt: a.voided_at,
    })),
    transitions: toTransitions(ledger.data),
  });
}

/** Opens a timesheet for a person, project and period. One per person, project and period start. */
export async function createTimesheet(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly membershipId: string;
    readonly periodStart: string;
    readonly periodEnd: string;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("timesheets")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      membership_id: input.membershipId,
      period_start: input.periodStart,
      period_end: input.periodEnd,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Submits a drafted or rejected timesheet with no open entries (app.submit_timesheet). */
export async function submitTimesheet(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("submit_timesheet", {
    p_timesheet_id: id,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}

/** Approves or rejects a submitted timesheet (app.decide_timesheet); never by submitter or worker. */
export async function decideTimesheet(
  db: XosClient,
  id: string,
  decision: Database["app"]["Enums"]["approval_decision"],
  reason: string,
): Promise<Result<{ transitionId: string }>> {
  const { data, error } = await db.rpc("decide_timesheet", {
    p_timesheet_id: id,
    p_decision: decision,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}
