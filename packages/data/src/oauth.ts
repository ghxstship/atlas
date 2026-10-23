import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * OAuth 2.1 for the public API on Supabase Auth's OAuth server (A99, RRR-144; ADR 0055; Section 10.1). The OpenAPI
 * document names `/oauth/authorize` and `/oauth/token` and one scope per capability group. Supabase Auth accepts only
 * its own scopes, so Atlas's authorize route starts Supabase Auth's authorization with `email`, and records the
 * capability groups for that authorization (migration 1563); the consent page reads them back and records the grant
 * before Supabase Auth issues the code. Refusals keep the database's rules:
 *
 * - `oauth_request_expired`, `oauth_request_recorded`: start again from the app;   - `oauth_client_unknown`;
 * - `oauth_not_member`: only members of the app's org;   - `oauth_scope_unknown`, `oauth_scope_missing`;
 * - `oauth_pkce_required`: S256 only;   - `step_up_required`: Restricted groups need a recent second factor.
 */

/** The scope Atlas asks Supabase Auth for; the capability groups travel beside it. */
export const SUPABASE_OAUTH_SCOPE = "email";

export interface AuthorizeRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string | null;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
  /** Capability groups the app asks for, from `scope`. */
  readonly scopes: readonly string[];
}

export type AuthorizeProblem =
  "client_id" | "redirect_uri" | "response_type" | "pkce" | "scope" | "state";

/**
 * Validates an authorization request as RFC 6749 and OAuth 2.1 describe it, before anything is sent on: a client id
 * (Supabase Auth's client uuid), the registered redirect URI, `response_type=code`, PKCE with S256 (a 43 to 128
 * character challenge; plain is refused) and at least one capability group in `scope`.
 */
export function parseAuthorizeRequest(
  params: URLSearchParams,
):
  | { readonly ok: true; readonly request: AuthorizeRequest }
  | { readonly ok: false; readonly problem: AuthorizeProblem } {
  const clientId = params.get("client_id") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    return { ok: false, problem: "client_id" };
  }
  const redirectUri = params.get("redirect_uri") ?? "";
  if (redirectUri.length === 0 || redirectUri.length > 2000 || redirectUri.includes("#")) {
    return { ok: false, problem: "redirect_uri" };
  }
  if (params.get("response_type") !== "code") return { ok: false, problem: "response_type" };
  const challenge = params.get("code_challenge") ?? "";
  if (
    params.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)
  ) {
    return { ok: false, problem: "pkce" };
  }
  const scopes = [
    ...new Set(
      (params.get("scope") ?? "")
        .split(/\s+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s !== "" && !["openid", "email", "profile", "phone"].includes(s)),
    ),
  ].sort();
  if (
    scopes.length === 0 ||
    scopes.length > 40 ||
    scopes.some((s) => !/^[a-z][a-z0-9_]*$/.test(s))
  ) {
    return { ok: false, problem: "scope" };
  }
  const state = params.get("state");
  if (state !== null && state.length > 2000) return { ok: false, problem: "state" };
  return {
    ok: true,
    request: {
      clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scopes,
    },
  };
}

/** Supabase Auth's authorization endpoint for a request, asking for its own scope only. */
export function supabaseAuthorizeUrl(supabaseUrl: string, request: AuthorizeRequest): string {
  const query = new URLSearchParams({
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    response_type: "code",
    scope: SUPABASE_OAUTH_SCOPE,
    code_challenge: request.codeChallenge,
    code_challenge_method: request.codeChallengeMethod,
    ...(request.state === null ? {} : { state: request.state }),
  });
  return `${supabaseUrl.replace(/\/$/, "")}/auth/v1/oauth/authorize?${query.toString()}`;
}

/** Supabase Auth's token endpoint, which `/oauth/token` forwards to. */
export function supabaseTokenUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}/auth/v1/oauth/token`;
}

/**
 * What Supabase Auth's authorization answered: its consent page (with the authorization id), or a redirect back to the
 * app carrying an error, which is passed on as it is.
 */
export function readAuthorizeAnswer(
  location: string | null,
):
  | { readonly kind: "consent"; readonly authorizationId: string }
  | { readonly kind: "client"; readonly location: string }
  | { readonly kind: "none" } {
  if (!location) return { kind: "none" };
  let url: URL;
  try {
    url = new URL(location);
  } catch (error) {
    if (error instanceof TypeError) return { kind: "none" };
    throw error;
  }
  const id = url.searchParams.get("authorization_id");
  if (url.pathname.endsWith("/oauth/consent") && id && /^[a-z0-9]{16,64}$/.test(id)) {
    return { kind: "consent", authorizationId: id };
  }
  return { kind: "client", location };
}

export async function recordOAuthRequest(
  db: XosClient,
  authorizationId: string,
  scopes: readonly string[],
): Promise<Result<null>> {
  const { error } = await db.rpc("record_oauth_request", {
    p_authorization_id: authorizationId,
    p_scopes: [...scopes],
  });
  return error ? fail(toDataError(error)) : ok(null);
}

export interface ConsentRequest {
  readonly appId: string;
  readonly appName: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly restrictedScopes: readonly string[];
  /** What the caller's live grant already gives the app, or null for a first consent. */
  readonly grantedScopes: readonly string[] | null;
  readonly pkceS256: boolean;
  readonly expiresAt: string;
}

/** The pending authorization the caller started, for the consent page; null when it is gone or not theirs. */
export async function getConsentRequest(
  db: XosClient,
  authorizationId: string,
): Promise<Result<ConsentRequest | null>> {
  const { data, error } = await db.rpc("oauth_consent_request", {
    p_authorization_id: authorizationId,
  });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (!row) return ok(null);
  return ok({
    appId: row.oauth_app_id,
    appName: row.app_name,
    orgId: row.org_id,
    orgName: row.org_name,
    redirectUri: row.redirect_uri,
    scopes: row.scopes ?? [],
    restrictedScopes: row.restricted_scopes ?? [],
    grantedScopes: row.granted_scopes ?? null,
    pkceS256: row.pkce_s256 === true,
    expiresAt: row.expires_at,
  });
}

/**
 * Supabase Auth's view of the authorization: it ties the authorization to the signed-in person, and answers with a
 * redirect when the person already consented to everything asked.
 */
export async function getAuthorizationDetails(
  db: XosClient,
  authorizationId: string,
): Promise<Result<{ readonly redirectUrl: string | null }>> {
  const { data, error } = await db.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error)
    return fail({ kind: "refusal", rule: "oauth_request_expired", message: error.message });
  return ok({ redirectUrl: "redirect_url" in data ? (data.redirect_url ?? null) : null });
}

/**
 * The caller consents: the database checks PKCE and step-up and records the grant (app.consent_oauth_request), then
 * Supabase Auth issues the code. Returns where to send the browser: the app's redirect URI with the code and state.
 */
export async function consentToRequest(
  db: XosClient,
  authorizationId: string,
): Promise<Result<string>> {
  const { error } = await db.rpc("consent_oauth_request", { p_authorization_id: authorizationId });
  if (error) return fail(toDataError(error));
  const approved = await db.auth.oauth.approveAuthorization(authorizationId, {
    skipBrowserRedirect: true,
  });
  if (approved.error || !approved.data.redirect_url) {
    return fail({
      kind: "refusal",
      rule: "oauth_request_expired",
      message: approved.error?.message ?? "No redirect.",
    });
  }
  return ok(approved.data.redirect_url);
}

/** The caller declines: the app hears access_denied. Returns where to send the browser. */
export async function declineRequest(
  db: XosClient,
  authorizationId: string,
): Promise<Result<string>> {
  const { error } = await db.rpc("decline_oauth_request", { p_authorization_id: authorizationId });
  if (error) return fail(toDataError(error));
  const denied = await db.auth.oauth.denyAuthorization(authorizationId, {
    skipBrowserRedirect: true,
  });
  if (denied.error || !denied.data.redirect_url) {
    return fail({
      kind: "refusal",
      rule: "oauth_request_expired",
      message: denied.error?.message ?? "No redirect.",
    });
  }
  return ok(denied.data.redirect_url);
}

/** Removes the caller's recorded request when Supabase Auth answered without asking (the grant already covers it). */
export async function forgetOAuthRequest(
  db: XosClient,
  authorizationId: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("decline_oauth_request", { p_authorization_id: authorizationId });
  return error ? fail(toDataError(error)) : ok(null);
}

// Connected apps ---------------------------------------------------------------------------------------------------------

export interface ConnectedApp {
  readonly grantId: string;
  readonly appId: string;
  readonly appName: string;
  readonly orgName: string;
  readonly scopes: readonly string[];
  readonly grantedAt: string;
  readonly lastUsedAt: string | null;
}

export async function listConnectedApps(db: XosClient): Promise<Result<ConnectedApp[]>> {
  const { data, error } = await db.rpc("my_oauth_apps");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      grantId: row.grant_id,
      appId: row.oauth_app_id,
      appName: row.app_name,
      orgName: row.org_name,
      scopes: row.scopes ?? [],
      grantedAt: row.granted_at,
      lastUsedAt: row.last_used_at ?? null,
    })),
  );
}

/** Revokes the caller's grant: the app's sessions end and its refresh token stops working at once (migration 1563). */
export async function revokeConnectedApp(db: XosClient, grantId: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("oauth_grants")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", grantId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}

/** For an app's session: the app, its org and the capability groups the live grant gives it. */
export async function getMyOAuthAccess(db: XosClient): Promise<
  Result<{
    readonly appId: string;
    readonly orgId: string;
    readonly scopes: readonly string[];
  } | null>
> {
  const { data, error } = await db.rpc("my_oauth_access");
  if (error) return fail(toDataError(error));
  const row = data[0];
  return ok(row ? { appId: row.oauth_app_id, orgId: row.org_id, scopes: row.scopes ?? [] } : null);
}

// Registered apps (org settings, Integrations) ---------------------------------------------------------------------------

export interface OAuthApp {
  readonly id: string;
  readonly name: string;
  readonly redirectUri: string;
  /** The client_id apps send to /oauth/authorize: their Supabase Auth client (migration 1563). */
  readonly clientId: string | null;
  readonly createdAt: string;
}

/** An org's live apps with their client ids; needs org.settings.read, as app.oauth_apps does. */
export async function listOAuthApps(db: XosClient, orgId: string): Promise<Result<OAuthApp[]>> {
  const [apps, clients] = await Promise.all([
    db
      .from("oauth_apps")
      .select("id, name, redirect_uri, created_at")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("created_at"),
    db.rpc("oauth_app_client_ids", { p_org_id: orgId }),
  ]);
  if (apps.error) return fail(toDataError(apps.error));
  if (clients.error) return fail(toDataError(clients.error));
  const byApp = new Map(clients.data.map((c) => [c.oauth_app_id, c.auth_client_id]));
  return ok(
    apps.data.map((a) => ({
      id: a.id,
      name: a.name,
      redirectUri: a.redirect_uri,
      clientId: byApp.get(a.id) ?? null,
      createdAt: a.created_at,
    })),
  );
}

/** Registers an app; the database makes its Supabase Auth client. Needs org.integrations.manage. */
export async function registerOAuthApp(
  db: XosClient,
  input: { readonly orgId: string; readonly name: string; readonly redirectUri: string },
): Promise<Result<{ readonly id: string }>> {
  const { data, error } = await db
    .from("oauth_apps")
    .insert({
      org_id: input.orgId,
      name: input.name.trim(),
      redirect_uri: input.redirectUri.trim(),
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Removes an app: every grant, consent and session of it ends (migration 1563). */
export async function removeOAuthApp(db: XosClient, appId: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("oauth_apps")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", appId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}
