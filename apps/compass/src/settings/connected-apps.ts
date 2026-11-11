/**
 * Settings, Connected Apps in Compass (Section 4.5.6 personal item 13, A99, migration 1563, ADR 0055, ADR 0072): the
 * OAuth apps the person lets act for them, each live grant with the app, the org that registered it, the capability
 * groups it may use and when it last refreshed its access (app.my_oauth_apps), read and revoked with the @xos/data
 * functions Atlas and Gateway use. Revoking ends the app's sessions for the person at once, so it needs the server's
 * answer and is disabled offline; the list shows from the device.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { XosClient } from "@xos/data/client";
import { listConnectedApps } from "@xos/data/oauth";
import type { DataError } from "@xos/data/result";
import type { Row } from "@xos/sync";

/** The device-local copy of the person's live grants. */
export const CONNECTED_APPS_MIRROR = "_me_connected_apps";

/** A live grant as the device keeps it; the row id is the grant's. */
export interface GrantRow extends Row {
  readonly appName: string;
  readonly orgName: string;
  readonly scopes: readonly string[];
  readonly grantedAt: string;
  readonly lastUsedAt: string | null;
}

/** The person's live grants, newest first, or null when the read failed. */
export async function readMyGrants(client: SupabaseClient): Promise<GrantRow[] | null> {
  const result = await listConnectedApps(client as unknown as XosClient);
  if (!result.ok) return null;
  return result.data.map((a) => ({
    id: a.grantId,
    appName: a.appName,
    orgName: a.orgName,
    scopes: [...a.scopes],
    grantedAt: a.grantedAt,
    lastUsedAt: a.lastUsedAt,
  }));
}

/** The grants newest first, as app.my_oauth_apps orders them. */
export function grantItems(grants: readonly GrantRow[]): GrantRow[] {
  return [...grants].sort((a, b) => b.grantedAt.localeCompare(a.grantedAt));
}

/** The capability groups a grant gives, sorted, for "Areas: …". */
export function scopeList(scopes: readonly string[]): string {
  return [...scopes].sort().join(", ");
}

/**
 * The message key for a failed revoke: a grant already gone (revoked elsewhere, or the org removed the app) reads as
 * not available; anything else as a failure to try again.
 */
export function revokeErrorKey(error: DataError): string {
  return error.kind === "not-found"
    ? "compassSettings.connections.gone"
    : "compassSettings.common.failed";
}
