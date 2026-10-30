import { untyped } from "@xos/data/untyped";
import { httpFromFetch } from "@xos/integrations/http";
import {
  credentialJson,
  exchangeCode,
  fetchAccount,
  isOAuthStorageProvider,
} from "@xos/integrations/storage-oauth";
import { NextResponse, type NextRequest } from "next/server";
import { storageOAuthClient } from "@/lib/integrations/storage-oauth";
import { observability } from "@/lib/observability";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Where Google and Microsoft send an Admin back after Connect with Google or Connect with Microsoft (B16, ADR 0155
 * D5; migration 3053). Under the reserved /oauth prefix, so no org slug can shadow it, and inside the proxy, so the
 * session is fresh. It uses the state once (app.finish_integration_oauth: same person, unused, 10 minutes), exchanges
 * the code with the PKCE verifier and the platform app's secret, names the connection's account, stores the refresh
 * token in Vault (app.store_integration_credential) and marks the connection Connected, then answers 303 to the org's
 * Integrations settings. A failure is shown on Atlas's own problem page, never sent anywhere else.
 */

export const dynamic = "force-dynamic";

/** A relative redirect: Next names a loopback host localhost in request.url (ADR 0036). */
function goTo(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { location, "cache-control": "no-store" },
  });
}

const problem = (rule: string) =>
  goTo(`/oauth/integrations/problem?rule=${encodeURIComponent(rule)}`);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const search = request.nextUrl.searchParams;
  const state = search.get("state") ?? "";
  const code = search.get("code") ?? "";
  const db = await createServerSupabase();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) {
    const here = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    return goTo(`/auth/sign-in?next=${encodeURIComponent(here)}`);
  }
  if (state === "") return problem("integration_oauth_state_invalid");
  const raw = untyped(db);
  const { data: finished, error } = await raw.rpc("finish_integration_oauth", { p_state: state });
  const row = (
    finished as
      | {
          status: string;
          connection_id: string;
          provider_code: string;
          code_verifier: string;
          redirect_uri: string;
        }[]
      | null
  )?.[0];
  if (error || !row) return problem("unexpected");
  if (row.status === "rate_limited") return problem("rate_limited");
  if (row.status !== "ok") return problem("integration_oauth_state_invalid");
  // The provider answered with an error (the Admin declined, or the app is misconfigured): the state is used up.
  if (search.get("error") !== null || code === "")
    return problem("integration_oauth_state_invalid");
  const provider = row.provider_code;
  if (!isOAuthStorageProvider(provider)) return problem("integration_oauth_unsupported");
  const client = storageOAuthClient(provider);
  if (client === null) return problem("oauth_not_configured");

  const http = httpFromFetch((input, init) => fetch(input, init));
  let credential;
  let account;
  try {
    credential = await exchangeCode(http, provider, {
      ...client,
      code,
      redirectUri: row.redirect_uri,
      verifier: row.code_verifier,
    });
    account = await fetchAccount(http, provider, credential.access_token);
  } catch (failure) {
    const rule = (failure as { code?: string }).code ?? "unexpected";
    observability.logger.error("a storage sign-in failed", { rule });
    return problem(
      rule === "oauth_refresh_token_missing" || rule === "credential_revoked" ? rule : "unexpected",
    );
  }

  const { data: connection } = await raw
    .from("integration_connections")
    .select("id, org_id, connection_state, provider_settings")
    .eq("id", row.connection_id)
    .single();
  if (!connection) return problem("unexpected");
  const settings = { ...((connection.provider_settings as Record<string, unknown> | null) ?? {}) };
  if (provider === "onedrive_sharepoint" && account.driveId && !settings["drive_id"])
    settings["drive_id"] = account.driveId;
  const named = await raw
    .from("integration_connections")
    .update({
      external_account_id: account.id,
      external_account_name: account.name,
      provider_settings: settings,
    })
    .eq("id", row.connection_id);
  if (named.error) {
    return problem(named.error.code === "23505" ? "integration_account_connected" : "unexpected");
  }
  const stored = await raw.rpc("store_integration_credential", {
    p_connection_id: row.connection_id,
    p_secret: credentialJson(credential),
    p_kind: "OAuth Token",
    p_expires_at: null,
  });
  if (stored.error) return problem("unexpected");
  const from = String(connection.connection_state);
  if (from === "Pending" || from === "Error") {
    const moved = await raw.rpc("transition_integration_connection", {
      p_connection_id: row.connection_id,
      p_expected: from,
      p_next: "Connected",
      p_reason: `Signed in with ${provider === "google_drive" ? "Google" : "Microsoft"}.`,
    });
    if (moved.error) return problem("unexpected");
  }
  const { data: org } = await raw
    .from("organizations")
    .select("slug")
    .eq("id", connection.org_id)
    .single();
  if (!org) return problem("unexpected");
  return goTo(`/${String(org.slug)}/settings/integrations?connected=${row.connection_id}`);
}
