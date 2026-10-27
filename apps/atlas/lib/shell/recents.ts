import {
  recentProjects as listRecentProjects,
  recordRecentView,
  type RecentProject,
  type RecentViewTable,
} from "@xos/data/search";
import { observability } from "@/lib/observability";
import type { OrgContext } from "./context";
import { RECENT_PROJECT_COUNT } from "./nav-model";

/**
 * Notes that the viewer opened a record, incident, document, SOP, handbook article or project, for the command
 * menu's recent items (Section 11.7: the last 50 records each person viewed appear before they type) and the
 * sidebar's recent projects (Section 4.5.2). app.record_recent_view runs as the viewer, so only something they can
 * read is noted. Callers run it beside their other reads (Promise.all), so it adds no wait, and it never fails the
 * page.
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

/**
 * The projects the viewer opened most recently in the org, newest first, read with their own row level security
 * (app.recent_projects, migration 2090). The sidebar can do without them: a failed read lists none and is logged.
 */
export async function recentProjects(ctx: OrgContext): Promise<readonly RecentProject[]> {
  if (!ctx.viewer.person) return [];
  const result = await listRecentProjects(ctx.viewer.db, ctx.org.id, RECENT_PROJECT_COUNT);
  if (result.ok) return result.data;
  observability.logger.error("Cannot read the recent projects; listing none", {
    error: result.error,
  });
  return [];
}
