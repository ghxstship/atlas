import type { LivePacing } from "@xos/ui";
import { getOrgContext } from "@/lib/shell/context";
import { LiveRefresh } from "./live-refresh";

/**
 * Live updates for a list page (Section 11.7, ADR 0044, ADR 0083): the page rereads when rows of
 * its tables change in the org. Each table must be in the supabase_realtime publication (1450,
 * 2170); Realtime then sends a change only to people whose row level security lets them read it.
 */
export async function LiveList({
  org,
  tables,
  pacing,
}: {
  /** The org slug from the route. */
  org: string;
  tables: readonly string[];
  pacing?: LivePacing;
}) {
  const ctx = await getOrgContext(org);
  if (!ctx) return null;
  const filter = `org_id=eq.${ctx.org.id}`;
  return (
    <LiveRefresh
      topics={tables.map((table) => ({ table, filter }))}
      {...(pacing ? { pacing } : {})}
    />
  );
}
