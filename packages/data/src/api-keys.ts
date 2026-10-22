import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Org API keys for servers (ADR 0003, migrations 0921, 0922 and 1562; Section 4.5.6 org setting 33). Keys are created
 * by app.create_api_key, which needs org.api_keys.manage, the api_keys plan feature and step-up (a second factor in the
 * last 15 minutes, S9-08); the secret comes back once and only its hash is kept. Refusals keep the database's rules
 * (`step_up_required`, `plan_feature_required`, `api_key_scope_unknown`, `api_key_expiry_invalid`, `api_key_revoked`).
 */

export interface ApiKey {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly serviceAccountId: string | null;
}

export async function listApiKeys(db: XosClient, orgId: string): Promise<Result<ApiKey[]>> {
  const { data, error } = await db
    .from("api_keys")
    .select(
      "id, name, prefix, scopes, expires_at, revoked_at, last_used_at, created_at, service_account_id",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      expiresAt: k.expires_at,
      revokedAt: k.revoked_at,
      lastUsedAt: k.last_used_at,
      createdAt: k.created_at,
      serviceAccountId: k.service_account_id,
    })),
  );
}

/** Creates a key and returns its secret: the only time it can be read. */
export async function createApiKey(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly name: string;
    readonly scopes: readonly string[];
    readonly expiresAt: string;
  },
): Promise<Result<{ readonly id: string; readonly secret: string }>> {
  const { data, error } = await db.rpc("create_api_key", {
    p_org_id: input.orgId,
    p_name: input.name,
    p_scopes: [...input.scopes],
    p_expires_at: input.expiresAt,
  });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (!row) return fail({ kind: "unexpected", message: "create_api_key returned no row." });
  return ok({ id: row.api_key_id, secret: row.secret });
}

export async function revokeApiKey(db: XosClient, apiKeyId: string): Promise<Result<null>> {
  const { error } = await db.rpc("revoke_api_key", { p_api_key_id: apiKeyId });
  return error ? fail(toDataError(error)) : ok(null);
}

/** The capability groups a key or an app can be scoped to, in registry order. */
export async function listCapabilityGroups(db: XosClient): Promise<Result<string[]>> {
  const { data, error } = await db.from("capability_modules").select("code").order("sort_order");
  if (error) return fail(toDataError(error));
  return ok(data.map((m) => m.code));
}
