import { listActiveCrisisAlerts } from "@xos/data/crisis-alerts";
import { cache } from "react";
import type { OrgContext } from "@/lib/shell/context";

/**
 * The crisis alerts in force for the viewer, read once per request: the shell's crisis banner and Home's alerts both
 * show them (crawl 4.9). Its own module, so the layout's banner loads none of Home's readers.
 */
export const loadActiveCrisisAlerts = cache((ctx: OrgContext) =>
  listActiveCrisisAlerts(ctx.viewer.db, {
    orgId: ctx.org.id,
    personId: ctx.viewer.person?.id ?? null,
  }),
);
