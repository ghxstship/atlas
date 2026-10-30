import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Browser notifications through Web Push (Section 4.10, A65-023, migration 1533). A browser registers for every org
 * the person belongs to and, in Gateway, for the person (1670), whose own browser takes the pushes of orgs they work
 * with as an external party and their marketplace matches. It belongs to one person at a time; the notification
 * dispatcher sends it the Push deliveries, under A80's quiet hours and preferences.
 */

// The push_subscriptions_web_app check of migration 1533, which equals app.shortcut_shell by
// coincidence; not that enum.
// eslint-disable-next-line xos/no-restated-enums
export type WebPushApp = "Atlas" | "Gateway";

/** A browser's PushSubscription as PushSubscription.toJSON() gives it. */
export interface BrowserSubscription {
  readonly endpoint: string;
  /** The P-256 public key, base64url. */
  readonly p256dh: string;
  /** The 16-byte authentication secret, base64url. */
  readonly auth: string;
}

const ENDPOINT = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/[!-~]*$/;

/** Parses PushSubscription.toJSON() output, or null when anything is missing or malformed. */
export function browserSubscription(input: unknown): BrowserSubscription | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = value.endpoint;
  const p256dh = value.keys?.p256dh;
  const auth = value.keys?.auth;
  if (typeof endpoint !== "string" || endpoint.length > 1000 || !ENDPOINT.test(endpoint))
    return null;
  if (typeof p256dh !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(p256dh)) return null;
  if (typeof auth !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(auth)) return null;
  return { endpoint, p256dh, auth };
}

/** Turns browser notifications on: registers the browser for each org the person belongs to, and in Gateway for them. */
export async function registerWebPush(
  db: XosClient,
  app: WebPushApp,
  subscription: BrowserSubscription,
): Promise<Result<number>> {
  const { data, error } = await db.rpc("register_web_push", {
    p_app: app,
    p_endpoint: subscription.endpoint,
    p_p256dh: subscription.p256dh,
    p_auth: subscription.auth,
  });
  if (error) return fail(toDataError(error));
  return ok(typeof data === "number" ? data : 0);
}

/**
 * Checks the browser's subscription on a visit: "active" when it is the person's (it then covers orgs they joined
 * since), "unknown" when it is not, and the browser should unsubscribe. Another person's rows for it are revoked.
 */
export async function syncWebPush(
  db: XosClient,
  app: WebPushApp,
  subscription: BrowserSubscription,
): Promise<Result<"active" | "unknown">> {
  const { data, error } = await db.rpc("sync_web_push", {
    p_app: app,
    p_endpoint: subscription.endpoint,
    p_p256dh: subscription.p256dh,
    p_auth: subscription.auth,
  });
  if (error) return fail(toDataError(error));
  return ok(data === "active" ? "active" : "unknown");
}

/** Turns browser notifications off for this browser. */
export async function revokeWebPush(db: XosClient, endpoint: string): Promise<Result<number>> {
  const { data, error } = await db.rpc("revoke_web_push", { p_endpoint: endpoint });
  if (error) return fail(toDataError(error));
  return ok(typeof data === "number" ? data : 0);
}
