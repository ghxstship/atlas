"use server";

import {
  browserSubscription,
  registerWebPush,
  revokeWebPush,
  syncWebPush,
} from "@xos/data/web-push";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Browser notifications (Section 4.10, A65-023, migration 1533). Every call uses the signed-in person's own client;
 * the database registers the browser for each org the person belongs to and, in Gateway, for the person (1670), so
 * an external party or a marketplace user with no membership gets their pushes here too. It keeps the browser one
 * person's at a time.
 */

export type PushSync = "active" | "unknown" | "signed-out";

async function signedIn() {
  const db = await createServerSupabase();
  const { data } = await db.auth.getUser();
  return data.user ? db : null;
}

/** Checks this browser's subscription on a visit; "unknown" tells the browser to unsubscribe. */
export async function syncWebPushAction(subscription: unknown): Promise<PushSync> {
  const db = await signedIn();
  if (!db) return "signed-out";
  const parsed = browserSubscription(subscription);
  if (!parsed) return "unknown";
  const result = await syncWebPush(db, "Gateway", parsed);
  return result.ok ? result.data : "unknown";
}

/** Turns browser notifications on for this browser. */
export async function registerWebPushAction(subscription: unknown): Promise<boolean> {
  const parsed = browserSubscription(subscription);
  const db = await signedIn();
  if (!parsed || !db) return false;
  const result = await registerWebPush(db, "Gateway", parsed);
  return result.ok;
}

/** Turns browser notifications off for this browser. */
export async function revokeWebPushAction(endpoint: string): Promise<boolean> {
  const db = await signedIn();
  if (!db || typeof endpoint !== "string" || endpoint.length > 1000) return false;
  const result = await revokeWebPush(db, endpoint);
  return result.ok;
}
