import type { XosClient } from "../client.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";
import { landed } from "./shared.ts";

/**
 * Crew scheduling (A132, migrations 2250 and 2251, ADR 0063): shift templates an org plans from, members'
 * availability on the calendar they keep for the org, the org's availability window, and the members ranked
 * for one shift for the schedule's drag list. Row level security and the RPCs decide every row: templates are
 * written with org.scheduling.write, shifts are planned and ranked with crew.shift.write on the project.
 */

// Shift templates --------------------------------------------------------------------------------------------

export interface ShiftTemplate {
  readonly id: string;
  readonly name: string;
  readonly roleCode: string | null;
  /** Call time, `HH:MM`, read in the project's time zone. */
  readonly callTime: string;
  /** Wrap time, `HH:MM`; at or before the call, the shift ends the next day. */
  readonly wrapTime: string;
  readonly headcount: number;
  readonly breakMinutes: number;
}

interface ShiftTemplateRow {
  id: string;
  name: string;
  role_code: string | null;
  call_time: string;
  wrap_time: string;
  headcount: number;
  break_minutes: number;
}

const hhmm = (time: string) => time.slice(0, 5);

function toTemplate(row: ShiftTemplateRow): ShiftTemplate {
  return {
    id: row.id,
    name: row.name,
    roleCode: row.role_code,
    callTime: hhmm(row.call_time),
    wrapTime: hhmm(row.wrap_time),
    headcount: row.headcount,
    breakMinutes: row.break_minutes,
  };
}

/** The org's shift templates by name. Soft-deleted templates are in Trash and never listed. */
export async function listShiftTemplates(
  db: XosClient,
  orgId: string,
): Promise<Result<ShiftTemplate[]>> {
  const { data, error } = await db
    .from("shift_templates")
    .select("id, name, role_code, call_time, wrap_time, headcount, break_minutes")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  return ok((data as ShiftTemplateRow[]).map(toTemplate));
}

export interface ShiftTemplateInput {
  readonly orgId: string;
  readonly name: string;
  readonly roleCode: string | null;
  readonly callTime: string;
  readonly wrapTime: string;
  readonly headcount: number;
  readonly breakMinutes: number;
}

/** Adds a template. The database refuses a duplicate name, a break as long as the shift and more than 50 people. */
export async function createShiftTemplate(
  db: XosClient,
  input: ShiftTemplateInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("shift_templates")
    .insert({
      org_id: input.orgId,
      name: input.name.trim(),
      role_code: input.roleCode,
      call_time: input.callTime,
      wrap_time: input.wrapTime,
      headcount: input.headcount,
      break_minutes: input.breakMinutes,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Moves a template to Trash; shifts already planned from it stay. */
export async function trashShiftTemplate(
  db: XosClient,
  id: string,
  at: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("shift_templates")
    .update({ deleted_at: at.toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

/** Minutes a template's shift lasts; a wrap at or before the call runs past midnight. */
export function templateMinutes(template: Pick<ShiftTemplate, "callTime" | "wrapTime">): number {
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const span = minutes(template.wrapTime) - minutes(template.callTime);
  return span > 0 ? span : span + 24 * 60;
}

/** Every day from `from` to `to`, both `YYYY-MM-DD` and included; empty when `to` is before `from`. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= end; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
    if (days.length > 366) break;
  }
  return days;
}

/**
 * Plans the template's headcount of open Draft shifts on each day (app.create_shifts_from_template): all or
 * none, at most 31 days, call and wrap read in the project's time zone.
 */
export async function createShiftsFromTemplate(
  db: XosClient,
  input: {
    readonly templateId: string;
    readonly projectId: string;
    readonly days: readonly string[];
  },
): Promise<Result<{ ids: string[] }>> {
  const { data, error } = await db.rpc("create_shifts_from_template", {
    p_template_id: input.templateId,
    p_project_id: input.projectId,
    p_days: [...input.days],
  });
  if (error) return fail(toDataError(error));
  return ok({ ids: data ?? [] });
}

// Fill rate --------------------------------------------------------------------------------------------------

export interface FillRate {
  /** Live shifts with someone on them. */
  readonly filled: number;
  /** Live shifts: every shift that is not Canceled. */
  readonly total: number;
  /** Whole percent filled; 0 with no live shift. */
  readonly percent: number;
}

/** How many of the live shifts have someone on them (Section 11.11 crew fill). Canceled shifts do not count. */
export function fillRate(
  shifts: ReadonlyArray<{ readonly state: string; readonly assigned: boolean }>,
): FillRate {
  const live = shifts.filter((s) => s.state !== "Canceled");
  const filled = live.filter((s) => s.assigned).length;
  return {
    filled,
    total: live.length,
    percent: live.length === 0 ? 0 : Math.round((filled / live.length) * 100),
  };
}

// Availability -----------------------------------------------------------------------------------------------

export type AvailabilityKind = "Available" | "Unavailable" | "Tentative";
/** A member's availability over a shift: a kind they stated, or nothing stated. */
export type StatedAvailability = AvailabilityKind | "Unstated";

const STATED: readonly StatedAvailability[] = ["Available", "Tentative", "Unstated", "Unavailable"];
const statedOf = (value: string): StatedAvailability =>
  (STATED as readonly string[]).includes(value) ? (value as StatedAvailability) : "Unstated";

export interface AvailabilityStatus {
  /** The member's calendar kept for the org; null until they state a first period. */
  readonly calendarId: string | null;
  readonly timeZone: string;
  /** scheduling.availability_required */
  readonly required: boolean;
  /** scheduling.availability_notice_days */
  readonly noticeDays: number;
  /** scheduling.availability_horizon_days */
  readonly horizonDays: number;
  /** First day the member may still change while availability is required. */
  readonly lockedUntil: string | null;
  /** Days from the end of the notice period to the horizon with nothing stated. */
  readonly unstatedDays: readonly string[];
}

/** The signed-in member's availability window for the org (app.my_availability_status). */
export async function getMyAvailabilityStatus(
  db: XosClient,
  orgId: string,
): Promise<Result<AvailabilityStatus>> {
  const { data, error } = await db.rpc("my_availability_status", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  const row = (data ?? [])[0];
  if (!row) return fail({ kind: "not-found" });
  return ok({
    calendarId: row.availability_calendar_id,
    timeZone: row.time_zone,
    required: row.required,
    noticeDays: row.notice_days,
    horizonDays: row.horizon_days,
    lockedUntil: row.locked_until,
    unstatedDays: row.unstated_days ?? [],
  });
}

/** The member's calendar kept for the org, opened in the zone given when they have none. */
export async function ensureMemberAvailabilityCalendar(
  db: XosClient,
  orgId: string,
  timeZone: string | null,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("ensure_member_availability_calendar", {
    p_org_id: orgId,
    ...(timeZone ? { p_time_zone: timeZone } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

export interface AvailabilityPeriod {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly kind: AvailabilityKind;
  readonly note: string | null;
}

/** Periods on one of the caller's calendars that end after `from`, by start. */
export async function listAvailabilityPeriods(
  db: XosClient,
  calendarId: string,
  from: string,
): Promise<Result<AvailabilityPeriod[]>> {
  const { data, error } = await db
    .from("availability_blocks")
    .select("id, starts_at, ends_at, availability_kind, note")
    .eq("availability_calendar_id", calendarId)
    .is("deleted_at", null)
    .gt("ends_at", from)
    .order("starts_at")
    .limit(200);
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: row.id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      kind: row.availability_kind,
      note: row.note,
    })),
  );
}

/** States a period. While the org requires availability, a period inside the notice period is refused. */
export async function addAvailabilityPeriod(
  db: XosClient,
  input: {
    readonly calendarId: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly kind: AvailabilityKind;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("availability_blocks")
    .insert({
      availability_calendar_id: input.calendarId,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      availability_kind: input.kind,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Removes a period (soft delete), under the same notice lock. */
export async function removeAvailabilityPeriod(
  db: XosClient,
  id: string,
  at: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("availability_blocks")
    .update({ deleted_at: at.toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

// Ranking for a shift ----------------------------------------------------------------------------------------

export interface ShiftCandidate {
  readonly membershipId: string;
  readonly personId: string;
  readonly name: string | null;
  readonly availability: StatedAvailability;
  /** Nothing stated where the org requires availability, for a shift inside the horizon. */
  readonly overdue: boolean;
  /** Holds a live shift that overlaps this one. */
  readonly conflict: boolean;
  /** Worked the shift's role before. */
  readonly workedRole: boolean;
  readonly weekMinutes: number;
  /** 1 for the best fit. */
  readonly rank: number;
}

/**
 * The org's members ranked for one shift (app.rank_shift_candidates): free of an overlapping shift first, then
 * Available, Tentative, nothing stated and Unavailable, then those who worked the role, then the fewest hours
 * in the week from `weekStart`.
 */
export async function rankShiftCandidates(
  db: XosClient,
  shiftId: string,
  weekStart?: string,
): Promise<Result<ShiftCandidate[]>> {
  const { data, error } = await db.rpc("rank_shift_candidates", {
    p_shift_id: shiftId,
    ...(weekStart ? { p_week_start: weekStart } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((row) => ({
      membershipId: row.membership_id,
      personId: row.person_id,
      name: row.full_name,
      availability: statedOf(row.availability),
      overdue: row.overdue,
      conflict: row.conflict,
      workedRole: row.worked_role,
      weekMinutes: row.week_minutes,
      rank: row.candidate_rank,
    })),
  );
}

/**
 * Puts a member on a shift that is still open, compare and set: the update lands only while nobody holds the
 * shift, so a crew member's claim (1322) or another planner's assignment made since the board was read is never
 * overwritten. A shift someone filled in the meantime comes back as the `shift_already_filled` refusal; a shift
 * that is gone or out of reach comes back not found.
 */
export async function assignOpenShift(
  db: XosClient,
  shiftId: string,
  membershipId: string,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("shifts")
    .update({ membership_id: membershipId })
    .eq("id", shiftId)
    .is("deleted_at", null)
    .is("membership_id", null)
    .select("id");
  if (error) return fail(toDataError(error));
  if (data && data.length > 0) return ok(null);
  const { data: shift, error: readError } = await db
    .from("shifts")
    .select("id, membership_id")
    .eq("id", shiftId)
    .is("deleted_at", null)
    .maybeSingle();
  if (readError) return fail(toDataError(readError));
  if (shift?.membership_id) {
    return fail({
      kind: "refusal",
      rule: "shift_already_filled",
      message: "Someone was put on this shift since the schedule was read.",
    });
  }
  return fail({ kind: "not-found" });
}
