"use server";

import {
  browserSubscription,
  registerWebPush,
  revokeWebPush,
  syncWebPush,
} from "@xos/data/web-push";
import { getViewer } from "@/lib/shell/context";

/**
 * Browser notifications (Section 4.10, A65-023, migration 1533). Every call uses the viewer's own client; the
 * database registers the browser for each org the person belongs to and keeps it one person's at a time.
 */

export type PushSync = "active" | "unknown" | "signed-out";

/** Checks this browser's subscription on a visit; "unknown" tells the browser to unsubscribe. */
export async function syncWebPushAction(subscription: unknown): Promise<PushSync> {
  const parsed = browserSubscription(subscription);
  const viewer = await getViewer();
  if (!viewer?.person) return "signed-out";
  if (!parsed) return "unknown";
  const result = await syncWebPush(viewer.db, "Atlas", parsed);
  return result.ok ? result.data : "unknown";
}

/** Turns browser notifications on for this browser. */
export async function registerWebPushAction(subscription: unknown): Promise<boolean> {
  const parsed = browserSubscription(subscription);
  const viewer = await getViewer();
  if (!parsed || !viewer?.person) return false;
  const result = await registerWebPush(viewer.db, "Atlas", parsed);
  return result.ok;
}

/** Turns browser notifications off for this browser. */
export async function revokeWebPushAction(endpoint: string): Promise<boolean> {
  const viewer = await getViewer();
  if (!viewer?.person || typeof endpoint !== "string" || endpoint.length > 1000) return false;
  const result = await revokeWebPush(viewer.db, endpoint);
  return result.ok;
}
