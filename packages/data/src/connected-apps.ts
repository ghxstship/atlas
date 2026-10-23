import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * A person's connected apps (A86, RRR-131, finding A65-004; Section 4.5.6 personal settings item 13): the OAuth
 * grants they consented to, with the app and org names (migration 1433 over 0638). Only the person lists and
 * revokes their own grants; an org's integrations admin can read them but never revoke them.
 */

export interface ConnectedApp {
  readonly grantId: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly appName: string;
  readonly scopes: readonly string[];
  readonly grantedAt: string;
}

export async function listMyConnectedApps(db: XosClient): Promise<Result<ConnectedApp[]>> {
  const { data, error } = await db.rpc("my_oauth_grants");
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      grantId: r.oauth_grant_id,
      orgId: r.org_id,
      orgName: r.org_name,
      appName: r.app_name,
      scopes: r.scopes,
      grantedAt: r.granted_at,
    })),
  );
}

/** Revokes the person's own grant; the app's tokens stop working at their next refresh. */
export async function revokeConnectedApp(db: XosClient, grantId: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("oauth_grants")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", grantId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length > 0 ? ok(null) : fail({ kind: "not-found" });
}
