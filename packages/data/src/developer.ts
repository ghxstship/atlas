import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * API access an org and its people manage in Settings (A86, RRR-131, finding A65-004):
 *   * org API keys and the service accounts they act for (0921, 0922; Section 4.5.6 org settings item 33),
 *   * personal API tokens where the org allows them (1432; personal settings item 15).
 * Secrets come back once from the create RPCs and are never readable again; only the hash is stored. Every read
 * and write runs as the caller, so row level security and the RPC checks decide.
 */

/** The capability groups (first segment of capability codes) scopes are chosen from, sorted. */
export async function listCapabilityGroups(db: XosClient): Promise<Result<string[]>> {
  const { data, error } = await db.from("capabilities").select("code");
  if (error) return fail(toDataError(error));
  return ok([...new Set(data.map((r) => r.code.split(".")[0] ?? r.code))].sort());
}

/** The groups of the given capability codes, sorted: what a person may scope a personal token to. */
export function capabilityGroupsOf(codes: Iterable<string>): string[] {
  return [...new Set([...codes].map((c) => c.split(".")[0] ?? c))].sort();
}

// Org API keys -----------------------------------------------------------------------------------------------

export interface ApiKey {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly serviceAccountId: string | null;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

/** The org's keys, newest first; trashed keys are left out. */
export async function listApiKeys(db: XosClient, orgId: string): Promise<Result<ApiKey[]>> {
  const { data, error } = await db
    .from("api_keys")
    .select("id, name, prefix, scopes, service_account_id, expires_at, last_used_at, revoked_at")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes,
      serviceAccountId: r.service_account_id,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
    })),
  );
}

export interface NewSecret {
  readonly id: string;
  /** Shown once; the database keeps only its hash. */
  readonly secret: string;
}

export interface ApiKeyInput {
  readonly orgId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
  /** The service account the key acts for; a key without one cannot call the API. */
  readonly serviceAccountId: string | null;
}

export async function createApiKey(db: XosClient, input: ApiKeyInput): Promise<Result<NewSecret>> {
  const base = {
    p_org_id: input.orgId,
    p_name: input.name,
    p_scopes: [...input.scopes],
    p_expires_at: input.expiresAt,
  };
  const { data, error } =
    input.serviceAccountId === null
      ? await db.rpc("create_api_key", base)
      : await db.rpc("create_api_key", { ...base, p_service_account_id: input.serviceAccountId });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (!row) return fail({ kind: "unexpected", message: "create_api_key returned no row" });
  return ok({ id: row.api_key_id, secret: row.secret });
}

export async function revokeApiKey(db: XosClient, apiKeyId: string): Promise<Result<null>> {
  const { error } = await db.rpc("revoke_api_key", { p_api_key_id: apiKeyId });
  if (error) return fail(toDataError(error));
  return ok(null);
}

// Service accounts -------------------------------------------------------------------------------------------

export interface ServiceAccount {
  readonly id: string;
  readonly name: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export async function listServiceAccounts(
  db: XosClient,
  orgId: string,
): Promise<Result<ServiceAccount[]>> {
  const { data, error } = await db
    .from("service_accounts")
    .select("id, name, expires_at, created_at")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({ id: r.id, name: r.name, expiresAt: r.expires_at, createdAt: r.created_at })),
  );
}

export interface ServiceAccountInput {
  readonly orgId: string;
  readonly name: string;
  readonly roleId: string;
  readonly expiresAt: string | null;
}

/** A service account takes a role the creator holds every capability of; never the Owner role. */
export async function createServiceAccount(
  db: XosClient,
  input: ServiceAccountInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("create_service_account", {
    p_org_id: input.orgId,
    p_name: input.name,
    p_role_id: input.roleId,
    ...(input.expiresAt === null ? {} : { p_expires_at: input.expiresAt }),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** Retires the account: its keys are revoked and its membership ends. */
export async function retireServiceAccount(
  db: XosClient,
  serviceAccountId: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("retire_service_account", {
    p_service_account_id: serviceAccountId,
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

// Personal API tokens ----------------------------------------------------------------------------------------

export interface PersonalToken {
  readonly id: string;
  readonly orgId: string;
  readonly orgName: string | null;
  readonly personId: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

/**
 * Personal tokens the caller may see, newest first: with a person, that person's own (in every org); with an
 * org, every token of that org (org.api_keys.manage sees all of them, anyone else only their own).
 */
export async function listPersonalTokens(
  db: XosClient,
  filter: { readonly personId?: string; readonly orgId?: string },
): Promise<Result<PersonalToken[]>> {
  let query = db
    .from("personal_access_tokens")
    .select(
      "id, org_id, person_id, name, prefix, expires_at, last_used_at, revoked_at, organizations(name), personal_access_token_scopes(scope, deleted_at)",
    )
    .is("deleted_at", null);
  if (filter.personId) query = query.eq("person_id", filter.personId);
  if (filter.orgId) query = query.eq("org_id", filter.orgId);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      orgName: r.organizations?.name ?? null,
      personId: r.person_id,
      name: r.name,
      prefix: r.prefix,
      scopes: (r.personal_access_token_scopes ?? [])
        .filter((s) => s.deleted_at === null)
        .map((s) => s.scope)
        .sort(),
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
    })),
  );
}

export interface PersonalTokenInput {
  readonly orgId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
}

export async function createPersonalToken(
  db: XosClient,
  input: PersonalTokenInput,
): Promise<Result<NewSecret>> {
  const { data, error } = await db.rpc("create_personal_access_token", {
    p_org_id: input.orgId,
    p_name: input.name,
    p_scopes: [...input.scopes],
    p_expires_at: input.expiresAt,
  });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (!row)
    return fail({ kind: "unexpected", message: "create_personal_access_token returned no row" });
  return ok({ id: row.personal_access_token_id, secret: row.secret });
}

export async function revokePersonalToken(db: XosClient, tokenId: string): Promise<Result<null>> {
  const { error } = await db.rpc("revoke_personal_access_token", { p_token_id: tokenId });
  if (error) return fail(toDataError(error));
  return ok(null);
}

/** Whether the caller's org allows personal tokens (developer.personal_tokens and the api_keys plan feature). */
export async function orgAllowsPersonalTokens(
  db: XosClient,
  orgId: string,
): Promise<Result<boolean>> {
  const { data, error } = await db.rpc("org_allows_personal_tokens", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  return ok(data === true);
}

/** The caller's orgs that allow personal tokens, by name. */
export async function listOrgsAllowingPersonalTokens(
  db: XosClient,
): Promise<Result<{ readonly id: string; readonly name: string }[]>> {
  const { data, error } = await db.rpc("my_orgs_allowing_personal_tokens");
  if (error) return fail(toDataError(error));
  return ok((data ?? []).map((r) => ({ id: r.org_id, name: r.org_name })));
}
