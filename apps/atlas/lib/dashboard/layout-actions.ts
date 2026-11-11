"use server";

import { clearPersonalSetting, setPersonalSetting } from "@xos/data/settings";
import { getViewer } from "@/lib/shell/context";
import { DASHBOARD_LAYOUT_SETTINGS, formatLayout, isDashboardId } from "./layout";

/**
 * Saves the spans a person gave a dashboard's tiles (Section 11.6, A129) as their own setting for
 * every org. The template already shows the new spans, so nothing re-renders; the next visit reads
 * them back.
 */
export async function saveDashboardLayoutAction(
  dashboard: string,
  spans: Readonly<Record<string, number>>,
): Promise<{ readonly ok: boolean }> {
  if (!isDashboardId(dashboard)) return { ok: false };
  const value = formatLayout(dashboard, spans);
  if (value === null) return { ok: false };
  const viewer = await getViewer();
  if (!viewer?.person) return { ok: false };
  const saved = await setPersonalSetting(viewer.db, {
    key: DASHBOARD_LAYOUT_SETTINGS[dashboard],
    value,
  });
  return { ok: saved.ok };
}

/** Puts a dashboard's tiles back to their default spans. */
export async function resetDashboardLayoutAction(
  dashboard: string,
): Promise<{ readonly ok: boolean }> {
  if (!isDashboardId(dashboard)) return { ok: false };
  const viewer = await getViewer();
  if (!viewer?.person) return { ok: false };
  const cleared = await clearPersonalSetting(viewer.db, {
    key: DASHBOARD_LAYOUT_SETTINGS[dashboard],
  });
  return { ok: cleared.ok };
}
