import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import type { Database } from "./database.types.ts";

/**
 * Enterprise single sign-on and SCIM (Section 9, Enterprise plan; migrations 0638 and 1332, A77). An org's identity
 * provider is a Supabase Auth SSO provider (SAML 2.0) that XOS support connects; the org records its provider id,
 * the role new people receive, whether signing in adds people just in time and whether SCIM provisions them. Every
 * call runs as the caller, so row level security and the 0638 guards decide (saml_sso and scim plan features, never
 * the Owner role, SCIM tokens only through their RPC with step-up).
 */

export interface IdentityProvider {
  readonly id: string;
  readonly protocol: Database["app"]["Enums"]["identity_protocol"];
  readonly name: string;
  readonly authProviderId: string;
  readonly defaultRoleId: string;
  readonly jitEnabled: boolean;
  readonly scimEnabled: boolean;
  /** The visible start of the SCIM token, or null when none was issued. */
  readonly scimTokenPrefix: string | null;
}

export async function listIdentityProviders(
  db: XosClient,
  orgId: string,
): Promise<Result<IdentityProvider[]>> {
  const { data, error } = await db
    .from("identity_providers")
    .select(
      "id, protocol, name, auth_provider_id, default_role_id, jit_enabled, scim_enabled, scim_token_prefix",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((p) => ({
      id: p.id,
      protocol: p.protocol,
      name: p.name,
      authProviderId: p.auth_provider_id,
      defaultRoleId: p.default_role_id,
      jitEnabled: p.jit_enabled,
      scimEnabled: p.scim_enabled,
      scimTokenPrefix: p.scim_token_prefix,
    })),
  );
}

export interface IdentityProviderInput {
  readonly orgId: string;
  readonly name: string;
  readonly protocol: Database["app"]["Enums"]["identity_protocol"];
  readonly authProviderId: string;
  readonly defaultRoleId: string;
  readonly jitEnabled: boolean;
  readonly scimEnabled: boolean;
}

export async function addIdentityProvider(
  db: XosClient,
  input: IdentityProviderInput,
): Promise<Result<string>> {
  const { data, error } = await db
    .from("identity_providers")
    .insert({
      org_id: input.orgId,
      name: input.name.trim(),
      protocol: input.protocol,
      auth_provider_id: input.authProviderId.trim(),
      default_role_id: input.defaultRoleId,
      jit_enabled: input.jitEnabled,
      scim_enabled: input.scimEnabled,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok(data.id);
}

export async function updateIdentityProvider(
  db: XosClient,
  id: string,
  input: {
    readonly defaultRoleId: string;
    readonly jitEnabled: boolean;
    readonly scimEnabled: boolean;
  },
): Promise<Result<null>> {
  const { data, error } = await db
    .from("identity_providers")
    .update({
      default_role_id: input.defaultRoleId,
      jit_enabled: input.jitEnabled,
      scim_enabled: input.scimEnabled,
    })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  if (data.length === 0) return fail({ kind: "not-found" });
  return ok(null);
}

/** Issues or rotates a provider's SCIM token and returns it once (step-up required, migration 0638). */
export async function issueScimToken(db: XosClient, providerId: string): Promise<Result<string>> {
  const { data, error } = await db.rpc("issue_scim_token", { p_identity_provider_id: providerId });
  if (error) return fail(toDataError(error));
  return ok(data);
}

export interface SsoJoin {
  readonly orgId: string;
  readonly slug: string;
  /** True when this sign-in added the person to the org just in time. */
  readonly joined: boolean;
}

/** After a single sign-on: the org of the session's identity provider, joined just in time when it adds people. */
export async function joinBySsoSession(db: XosClient): Promise<Result<SsoJoin | null>> {
  const { data, error } = await db.rpc("join_by_sso_session");
  if (error) return fail(toDataError(error));
  const row = data[0];
  return ok(row ? { orgId: row.org_id, slug: row.slug, joined: row.joined } : null);
}
