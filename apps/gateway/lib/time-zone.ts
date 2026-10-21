import { isTimeZone, todayIn, zoneOrUtc } from "@xos/data/calendar";
import { resolveSettings } from "@xos/data/settings";
import { cache } from "react";
import { scheduleViewFrom, type ScheduleView } from "./format";
import { NO_ORG } from "./settings";
import type { GatewayContext } from "./shell/context";

/**
 * Calendars for Gateway's "today" (RRR-116). The UTC date is a day ahead every evening in the Americas, so
 * no page takes "today" from `toISOString()`:
 * - an engagement's pages use its project's time zone (`Engagement.projectTimeZone`, 1390), the calendar the
 *   engaging org dates that work on (private.project_today, 1305);
 * - pages that list a person's items across orgs (profile, money, documents, settings, a representative's
 *   roster) use the person's own `locale.time_zone` setting, UTC until they set one.
 */

/** The person's own settings, resolved once per request. */
const personalSettings = cache((ctx: GatewayContext) => resolveSettings(ctx.db, { orgId: NO_ORG }));

/** The person's own time zone: their personal locale.time_zone setting, UTC when unset or unknown. */
export const getPersonTimeZone = cache(async (ctx: GatewayContext): Promise<string> => {
  const settings = await personalSettings(ctx);
  if (!settings.ok) return "UTC";
  const value = settings.data.get("locale.time_zone")?.value;
  return zoneOrUtc(typeof value === "string" ? value : null);
});

/** Today on the person's own calendar, as `YYYY-MM-DD`. */
export async function personToday(ctx: GatewayContext): Promise<string> {
  return todayIn(await getPersonTimeZone(ctx));
}

/**
 * How the person reads schedule times (Section 15): the event's zone unless they chose their own
 * (me.time_zone_display), which is their locale.time_zone when they set a known one.
 */
export const getScheduleView = cache(async (ctx: GatewayContext): Promise<ScheduleView> => {
  const settings = await personalSettings(ctx);
  if (!settings.ok) return { display: "event", viewerZone: null };
  return scheduleViewFrom((key) => settings.data.get(key)?.value, isTimeZone);
});
