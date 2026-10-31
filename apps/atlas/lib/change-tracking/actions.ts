"use server";

import { markSeen, recordVisit, type SeenSurface } from "@xos/data/change-tracking";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getViewer } from "@/lib/shell/context";

/**
 * The last-seen markers of Home > Today and Show > Show day (B6, ADR 0145). A page records a visit
 * once it is on screen (components/change-tracking/visit-marker.tsx), never during a render or a
 * prefetch; Mark all as seen moves the marker to now. A visit is a 30-minute window, so a refresh
 * never clears the highlights. The database decides whether the page's scope is the person's.
 */
const SURFACE = z.enum(["Today", "Show Day"]);
const id = z.uuid();

export async function recordVisitAction(
  surface: SeenSurface,
  scopeId: string,
): Promise<{ readonly ok: boolean }> {
  const parsed = z.object({ surface: SURFACE, scopeId: id }).safeParse({ surface, scopeId });
  const viewer = await getViewer();
  if (!parsed.success || !viewer?.person) return { ok: false };
  const result = await recordVisit(viewer.db, parsed.data.surface, parsed.data.scopeId);
  return { ok: result.ok };
}

/** Mark all as seen, from a form: `surface`, `scopeId` and the page `path` to refresh. */
export async function markSeenAction(form: FormData): Promise<void> {
  const parsed = z
    .object({ surface: SURFACE, scopeId: id, path: z.string().startsWith("/").max(500) })
    .safeParse(Object.fromEntries(form));
  const viewer = await getViewer();
  if (!parsed.success || !viewer?.person) return;
  const result = await markSeen(viewer.db, parsed.data.surface, parsed.data.scopeId);
  if (result.ok) revalidatePath(parsed.data.path);
}
