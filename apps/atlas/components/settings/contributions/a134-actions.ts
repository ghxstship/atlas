"use server";

import type { DataError } from "@xos/data";
import {
  addHoliday,
  assignHolidayCalendarVenue,
  createEarningCode,
  createHolidayCalendar,
  createTimeOffPolicy,
  EARNING_CODE_KINDS,
  normalizeEarningCode,
  normalizeSubdivisionCode,
  removeHoliday,
  retireEarningCode,
  retireHolidayCalendar,
  retireTimeOffPolicy,
  unassignHolidayCalendarVenue,
  updateEarningCode,
  updateHolidayCalendar,
  updateTimeOffPolicy,
  type EarningCodeKind,
} from "@xos/data/crew";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { contextFor } from "@/lib/platform/action-context";
import { fromDataError } from "@/lib/platform/data-error";
import { done, field, inputError, type PlatformActionState } from "@/lib/platform/state";

/**
 * Server actions of A134's panels on Settings, Payroll and Time Off (RRR-196, ADR 0112): earning codes, time off
 * policies and holiday calendars. Each writes with the viewer's client, so row level security (org.payroll.write)
 * decides; `intent` picks create, update or retire. A unique conflict comes back as the rule naming what is taken, so
 * the form says which name or day is in use (`platform.refusals`), never "someone changed this".
 */

const uuid = z.uuid();
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

function refresh(slug: string): void {
  revalidatePath(`/${slug}/settings/payroll-and-time-off`);
  // Holidays change time off day counts.
  revalidatePath(`/${slug}/crew/time-off`);
}

function outcome(error: DataError, taken: (message: string) => string): PlatformActionState {
  if (error.kind === "conflict") return { rule: taken(error.message), at: Date.now() };
  return fromDataError(error);
}

const name = (form: FormData) => {
  const value = field(form, "name");
  return value.length > 0 && value.length <= 100 ? value : null;
};

/** A number of hours from 0 to `max`, in steps of a quarter hour; blank is `blank`. */
function hours(
  form: FormData,
  key: string,
  max: number,
  blank: number | null,
): number | null | undefined {
  const raw = field(form, key);
  if (!raw) return blank;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= max && Number.isInteger(value * 4)
    ? value
    : undefined;
}

export async function earningCodeAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const intent = field(form, "intent");
  const id = field(form, "id");
  if (intent !== "create" && !uuid.safeParse(id).success) return inputError();
  const taken = () => "earning_code_taken";
  if (intent === "retire") {
    const result = await retireEarningCode(ctx.viewer.db, id);
    if (!result.ok) return fromDataError(result.error);
    refresh(ctx.org.slug);
    return done(id);
  }
  const code = normalizeEarningCode(field(form, "code"));
  const kind = field(form, "kind") as EarningCodeKind;
  const label = name(form);
  if (!code || !label || !EARNING_CODE_KINDS.includes(kind)) return inputError();
  const input = { code, name: label, kind };
  if (intent === "create") {
    const result = await createEarningCode(ctx.viewer.db, ctx.org.id, input);
    if (!result.ok) return outcome(result.error, taken);
    refresh(ctx.org.slug);
    return done(result.data.id);
  }
  if (intent !== "update") return inputError();
  const result = await updateEarningCode(ctx.viewer.db, id, input);
  if (!result.ok) return outcome(result.error, taken);
  refresh(ctx.org.slug);
  return done(id);
}

export async function timeOffPolicyAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const intent = field(form, "intent");
  const id = field(form, "id");
  if (intent !== "create" && !uuid.safeParse(id).success) return inputError();
  const taken = () => "time_off_policy_taken";
  if (intent === "retire") {
    const result = await retireTimeOffPolicy(ctx.viewer.db, id);
    if (!result.ok) return fromDataError(result.error);
    refresh(ctx.org.slug);
    return done(id);
  }
  const label = name(form);
  const accrual = hours(form, "accrual", 1000, null);
  if (!label || accrual === undefined) return inputError();
  const input = { name: label, accrualHoursPerPeriod: accrual };
  if (intent === "create") {
    const result = await createTimeOffPolicy(ctx.viewer.db, ctx.org.id, input);
    if (!result.ok) return outcome(result.error, taken);
    refresh(ctx.org.slug);
    return done(result.data.id);
  }
  if (intent !== "update") return inputError();
  const result = await updateTimeOffPolicy(ctx.viewer.db, id, input);
  if (!result.ok) return outcome(result.error, taken);
  refresh(ctx.org.slug);
  return done(id);
}

export async function holidayCalendarAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const intent = field(form, "intent");
  const id = field(form, "id");
  if (intent !== "create" && !uuid.safeParse(id).success) return inputError();
  // Two calendars may not share a name, nor apply to the org for the same subdivision.
  const taken = (message: string) =>
    message.includes("holiday_calendars_org_applies_key")
      ? "holiday_calendar_applies_taken"
      : "holiday_calendar_taken";
  if (intent === "retire") {
    const result = await retireHolidayCalendar(ctx.viewer.db, id);
    if (!result.ok) return fromDataError(result.error);
    refresh(ctx.org.slug);
    return done(id);
  }
  const label = name(form);
  const subdivision = normalizeSubdivisionCode(field(form, "subdivision"));
  if (!label || subdivision === undefined) return inputError();
  const input = {
    name: label,
    subdivisionCode: subdivision,
    appliesToOrg: form.get("appliesToOrg") === "on",
  };
  if (intent === "create") {
    const result = await createHolidayCalendar(ctx.viewer.db, ctx.org.id, input);
    if (!result.ok) return outcome(result.error, taken);
    refresh(ctx.org.slug);
    return done(result.data.id);
  }
  if (intent !== "update") return inputError();
  const result = await updateHolidayCalendar(ctx.viewer.db, id, input);
  if (!result.ok) return outcome(result.error, taken);
  refresh(ctx.org.slug);
  return done(id);
}

export async function holidayAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const intent = field(form, "intent");
  if (intent === "remove") {
    const id = field(form, "id");
    if (!uuid.safeParse(id).success) return inputError();
    const result = await removeHoliday(ctx.viewer.db, id);
    if (!result.ok) return fromDataError(result.error);
    refresh(ctx.org.slug);
    return done(id);
  }
  const calendar = field(form, "calendar");
  const observedOn = field(form, "observedOn");
  const label = name(form);
  const paid = hours(form, "paidHours", 24, 8);
  if (
    intent !== "add" ||
    !uuid.safeParse(calendar).success ||
    !isoDate.test(observedOn) ||
    !label ||
    paid === null ||
    paid === undefined
  ) {
    return inputError();
  }
  const result = await addHoliday(ctx.viewer.db, {
    orgId: ctx.org.id,
    calendarId: calendar,
    observedOn,
    name: label,
    paidHours: paid,
  });
  if (!result.ok) return outcome(result.error, () => "holiday_day_taken");
  refresh(ctx.org.slug);
  return done(result.data.id);
}

export async function holidayVenueAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const intent = field(form, "intent");
  if (intent === "unassign") {
    const id = field(form, "id");
    if (!uuid.safeParse(id).success) return inputError();
    const result = await unassignHolidayCalendarVenue(ctx.viewer.db, id);
    if (!result.ok) return fromDataError(result.error);
    refresh(ctx.org.slug);
    return done(id);
  }
  const calendar = field(form, "calendar");
  const venue = field(form, "venue");
  if (intent !== "assign" || !uuid.safeParse(calendar).success || !uuid.safeParse(venue).success) {
    return inputError();
  }
  const result = await assignHolidayCalendarVenue(ctx.viewer.db, {
    orgId: ctx.org.id,
    calendarId: calendar,
    venueId: venue,
  });
  if (!result.ok) return outcome(result.error, () => "holiday_venue_taken");
  refresh(ctx.org.slug);
  return done(result.data.id);
}
