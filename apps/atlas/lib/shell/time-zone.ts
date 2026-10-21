import { todayIn, zoneOrUtc } from "@xos/data/calendar";
import { resolveSettings } from "@xos/data/settings";
import { cache } from "react";
import type { OrgContext } from "./context";

/**
 * The org's time zone: its locale.time_zone setting (Section 4.5.6 item 35, journey 63), UTC when
 * unset or unknown, read once per request. Org-wide dates (finance defaults, the crew week across
 * projects) follow it, as private.org_today does in the database (A71, RRR-116).
 */
export const getOrgTimeZone = cache(async (ctx: OrgContext): Promise<string> => {
  const settings = await resolveSettings(ctx.viewer.db, { orgId: ctx.org.id });
  if (!settings.ok) return "UTC";
  const value = settings.data.get("locale.time_zone")?.value;
  return zoneOrUtc(typeof value === "string" ? value : null);
});

/** Today on the org's calendar, as `YYYY-MM-DD`; never the UTC date, a day ahead in the evening. */
export async function orgToday(ctx: OrgContext): Promise<string> {
  return todayIn(await getOrgTimeZone(ctx));
}
