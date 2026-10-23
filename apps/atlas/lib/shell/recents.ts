import { recordRecentView, type RecentViewTable } from "@xos/data/search";
import type { OrgContext } from "./context";

/**
 * Notes that the viewer opened a record, incident, document, SOP or handbook article, for the command
 * menu's recent items (Section 11.7: the last 50 records each person viewed appear before they type).
 * app.record_recent_view runs as the viewer, so only something they can read is noted. Callers run it
 * beside their other reads (Promise.all), so it adds no wait, and it never fails the page.
 */
export async function rememberView(
  ctx: OrgContext,
  table: RecentViewTable,
  id: string,
): Promise<void> {
  // Previewing another role (View as role) is looking, not opening: it leaves the viewer's list alone.
  if (ctx.preview) return;
  await recordRecentView(ctx.viewer.db, { orgId: ctx.org.id, table, id });
}
