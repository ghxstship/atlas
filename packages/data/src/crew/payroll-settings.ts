import type { XosClient } from "../client.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";
import { landed } from "./shared.ts";

/**
 * What Settings, Payroll and Time Off edits (Section 4.5.6, A134): earning codes and time off policies (migration 0341)
 * and holiday calendars (2270). Every write is org.payroll.write under row level security; retiring soft deletes, so
 * payroll lines and requests that name a retired code or policy keep it. Holidays on the calendar that governs the work
 * change time off day counts and holiday pay (ADR 0112).
 */

// Earning codes -------------------------------------------------------------------------------------------------------

/** Kind of an earning code: regular pay, an overtime multiplier, or holiday pay. */
export type EarningCodeKind = "regular" | "overtime" | "holiday";

export const EARNING_CODE_KINDS: readonly EarningCodeKind[] = ["regular", "overtime", "holiday"];

/** Earning codes are 2 to 20 capitals, digits or underscores (earning_codes_code_format). */
export function normalizeEarningCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9_]{2,20}$/.test(code) ? code : null;
}

export interface EarningCodeInput {
  readonly code: string;
  readonly name: string;
  readonly kind: EarningCodeKind;
}

function kindColumns(kind: EarningCodeKind) {
  return { is_overtime: kind === "overtime", is_holiday: kind === "holiday" };
}

export async function createEarningCode(
  db: XosClient,
  orgId: string,
  input: EarningCodeInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("earning_codes")
    .insert({
      org_id: orgId,
      code: input.code,
      name: input.name.trim(),
      ...kindColumns(input.kind),
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function updateEarningCode(
  db: XosClient,
  id: string,
  input: EarningCodeInput,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("earning_codes")
    .update({ code: input.code, name: input.name.trim(), ...kindColumns(input.kind) })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

export async function retireEarningCode(
  db: XosClient,
  id: string,
  at: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("earning_codes")
    .update({ deleted_at: at.toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

// Time off policies ---------------------------------------------------------------------------------------------------

export interface TimeOffPolicyInput {
  readonly name: string;
  /** Hours accrued per pay period; null when the policy does not accrue. */
  readonly accrualHoursPerPeriod: number | null;
}

export async function createTimeOffPolicy(
  db: XosClient,
  orgId: string,
  input: TimeOffPolicyInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("time_off_policies")
    .insert({
      org_id: orgId,
      name: input.name.trim(),
      accrual_hours_per_period: input.accrualHoursPerPeriod,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function updateTimeOffPolicy(
  db: XosClient,
  id: string,
  input: TimeOffPolicyInput,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("time_off_policies")
    .update({ name: input.name.trim(), accrual_hours_per_period: input.accrualHoursPerPeriod })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

export async function retireTimeOffPolicy(
  db: XosClient,
  id: string,
  at: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("time_off_policies")
    .update({ deleted_at: at.toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

// Holiday calendars ---------------------------------------------------------------------------------------------------

export interface Holiday {
  readonly id: string;
  readonly observedOn: string;
  readonly name: string;
  readonly paidHours: number;
}

export interface HolidayCalendar {
  readonly id: string;
  readonly name: string;
  /** ISO 3166-2 subdivision the calendar is for, such as US-CA; null when it is for none. */
  readonly subdivisionCode: string | null;
  /** Applies across the org (to work in its subdivision when it names one). */
  readonly appliesToOrg: boolean;
  /** Venues the calendar is assigned to, by name. */
  readonly venues: readonly {
    readonly assignmentId: string;
    readonly venueId: string;
    readonly name: string;
  }[];
  /** Holidays in date order. */
  readonly holidays: readonly Holiday[];
}

/** ISO 3166-2 subdivision codes, as venues store them (venues_subdivision_code_format). */
export function normalizeSubdivisionCode(value: string): string | null | undefined {
  const code = value.trim().toUpperCase();
  if (!code) return null;
  return /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(code) ? code : undefined;
}

interface CalendarRow {
  id: string;
  name: string;
  subdivision_code: string | null;
  applies_to_org: boolean;
  holidays:
    | {
        id: string;
        observed_on: string;
        name: string;
        paid_hours: number;
        deleted_at: string | null;
      }[]
    | null;
  venues:
    | {
        id: string;
        venue_id: string;
        deleted_at: string | null;
        venue: { name: string } | null;
      }[]
    | null;
}

/** The org's live holiday calendars in name order, each with its live holidays and venue assignments. */
export async function listHolidayCalendars(
  db: XosClient,
  orgId: string,
): Promise<Result<HolidayCalendar[]>> {
  const { data, error } = await db
    .from("holiday_calendars")
    .select(
      "id, name, subdivision_code, applies_to_org, holidays:holidays!holidays_holiday_calendar_id_fkey(id, observed_on, name, paid_hours, deleted_at), venues:holiday_calendar_venues!holiday_calendar_venues_holiday_calendar_id_fkey(id, venue_id, deleted_at, venue:venues!holiday_calendar_venues_venue_id_fkey(name))",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(
    (data as unknown as CalendarRow[]).map((c) => ({
      id: c.id,
      name: c.name,
      subdivisionCode: c.subdivision_code,
      appliesToOrg: c.applies_to_org,
      venues: (c.venues ?? [])
        .filter((v) => v.deleted_at === null)
        .map((v) => ({ assignmentId: v.id, venueId: v.venue_id, name: v.venue?.name ?? "" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      holidays: (c.holidays ?? [])
        .filter((h) => h.deleted_at === null)
        .map((h) => ({
          id: h.id,
          observedOn: h.observed_on,
          name: h.name,
          paidHours: Number(h.paid_hours),
        }))
        .sort((a, b) => a.observedOn.localeCompare(b.observedOn)),
    })),
  );
}

export interface HolidayCalendarInput {
  readonly name: string;
  readonly subdivisionCode: string | null;
  readonly appliesToOrg: boolean;
}

export async function createHolidayCalendar(
  db: XosClient,
  orgId: string,
  input: HolidayCalendarInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("holiday_calendars")
    .insert({
      org_id: orgId,
      name: input.name.trim(),
      subdivision_code: input.subdivisionCode,
      applies_to_org: input.appliesToOrg,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function updateHolidayCalendar(
  db: XosClient,
  id: string,
  input: HolidayCalendarInput,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("holiday_calendars")
    .update({
      name: input.name.trim(),
      subdivision_code: input.subdivisionCode,
      applies_to_org: input.appliesToOrg,
    })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

/**
 * Retires a calendar; its holidays stop applying with it, and 2272 ends its venue assignments in the same update so
 * those venues can take another calendar.
 */
export async function retireHolidayCalendar(
  db: XosClient,
  id: string,
  at: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("holiday_calendars")
    .update({ deleted_at: at.toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

export async function addHoliday(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly calendarId: string;
    readonly observedOn: string;
    readonly name: string;
    readonly paidHours: number;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("holidays")
    .insert({
      org_id: input.orgId,
      holiday_calendar_id: input.calendarId,
      observed_on: input.observedOn,
      name: input.name.trim(),
      paid_hours: input.paidHours,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function removeHoliday(
  db: XosClient,
  id: string,
  at: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("holidays")
    .update({ deleted_at: at.toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

export async function assignHolidayCalendarVenue(
  db: XosClient,
  input: { readonly orgId: string; readonly calendarId: string; readonly venueId: string },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("holiday_calendar_venues")
    .insert({
      org_id: input.orgId,
      holiday_calendar_id: input.calendarId,
      venue_id: input.venueId,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function unassignHolidayCalendarVenue(
  db: XosClient,
  assignmentId: string,
  at: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("holiday_calendar_venues")
    .update({ deleted_at: at.toISOString() })
    .eq("id", assignmentId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}
