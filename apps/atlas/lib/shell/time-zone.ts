import { todayIn, zoneOrUtc } from "@xos/data/calendar";
import { getOrgSettingValue } from "@xos/data/settings";
import { cache } from "react";
import type { OrgContext } from "./context";

/**
 * The org's time zone: the locale.time_zone value the org set at its own scope (Section 4.5.6 item 35,
 * journey 63), UTC when unset or unknown, read once per request. Org-wide dates (finance defaults, the
 * crew week across projects) follow it, as private.org_today does in the database (A71, RRR-116). A
 * member's own locale.time_zone never moves the org's calendar: resolved settings would rank it first.
 */
export const getOrgTimeZone = cache(async (ctx: OrgContext): Promise<string> => {
  const stored = await getOrgSettingValue(ctx.viewer.db, ctx.org.id, "locale.time_zone");
  return zoneOrUtc(stored.ok && typeof stored.data === "string" ? stored.data : null);
});

/** Today on the org's calendar, as `YYYY-MM-DD`; never the UTC date, a day ahead in the evening. */
export async function orgToday(ctx: OrgContext): Promise<string> {
  return todayIn(await getOrgTimeZone(ctx));
}

/** The first day of a week for a payroll.week_start value: 1 for monday, else 0 (sunday, the default). */
export function weekStartDay(value: unknown): 0 | 1 {
  return value === "monday" ? 1 : 0;
}

/**
 * The org's payroll week: the first day (0 Sunday, 1 Monday) of the payroll.week_start value the org set
 * at its own scope, Sunday when unset. Pay periods (app.next_pay_period_dates) and weekly overtime
 * (app.calculate_payroll_run) count on it, so new timesheets and the planner's weekly hours do too; a
 * person's own week start only changes their calendars (1323, A71).
 */
export const getOrgWeekStart = cache(async (ctx: OrgContext): Promise<0 | 1> => {
  const stored = await getOrgSettingValue(ctx.viewer.db, ctx.org.id, "payroll.week_start");
  return weekStartDay(stored.ok ? stored.data : null);
});
