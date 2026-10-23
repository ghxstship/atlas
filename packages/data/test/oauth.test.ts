import { describe, expect, it, vi } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  consentToRequest,
  declineRequest,
  getAuthorizationDetails,
  getConsentRequest,
  getMyOAuthAccess,
  listConnectedApps,
  parseAuthorizeRequest,
  readAuthorizeAnswer,
  recordOAuthRequest,
  revokeConnectedApp,
  supabaseAuthorizeUrl,
  supabaseTokenUrl,
} from "../src/oauth.ts";

const CLIENT = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function params(overrides: Record<string, string | null> = {}) {
  const base: Record<string, string> = {
    client_id: CLIENT,
    redirect_uri: "https://ledger.example.test/callback",
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "work projects work openid",
    state: "xyz",
  };
  const merged = { ...base, ...overrides };
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) if (v !== null) out.set(k, v);
  return out;
}

function client(rpcs: Record<string, unknown>, oauth: Record<string, unknown> = {}) {
  const rpc = vi.fn(async (name: string) => rpcs[name] ?? { data: [], error: null });
  return { db: { rpc, auth: { oauth } } as unknown as XosClient, rpc };
}

describe("authorization requests", () => {
  it("takes the capability groups from scope, sorted, without Supabase Auth's own scopes", () => {
    const parsed = parseAuthorizeRequest(params());
    expect(parsed).toEqual({
      ok: true,
      request: {
        clientId: CLIENT,
        redirectUri: "https://ledger.example.test/callback",
        state: "xyz",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
        scopes: ["projects", "work"],
      },
    });
  });

  it.each([
    [{ client_id: "xos_client_abc" }, "client_id"],
    [{ redirect_uri: "https://a.test/cb#frag" }, "redirect_uri"],
    [{ response_type: "token" }, "response_type"],
    [{ code_challenge_method: "plain" }, "pkce"],
    [{ code_challenge: null }, "pkce"],
    [{ code_challenge: "short" }, "pkce"],
    [{ scope: "openid email" }, "scope"],
    [{ scope: "Work-Orders" }, "scope"],
    [{ state: "x".repeat(2001) }, "state"],
  ])("refuses %o as %s", (overrides, problem) => {
    expect(parseAuthorizeRequest(params(overrides))).toEqual({ ok: false, problem });
  });

  it("asks Supabase Auth for its own scope and passes PKCE and state through", () => {
    const parsed = parseAuthorizeRequest(params());
    if (!parsed.ok) throw new Error("expected a request");
    const url = new URL(supabaseAuthorizeUrl("http://127.0.0.1:54321/", parsed.request));
    expect(url.pathname).toBe("/auth/v1/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT,
      redirect_uri: "https://ledger.example.test/callback",
      response_type: "code",
      scope: "email",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "xyz",
    });
    expect(supabaseTokenUrl("https://x.supabase.co")).toBe(
      "https://x.supabase.co/auth/v1/oauth/token",
    );
  });

  it("reads Supabase Auth's answer", () => {
    expect(
      readAuthorizeAnswer(
        "http://127.0.0.1:3099/oauth/consent?authorization_id=abcdefghijklmnop12345678",
      ),
    ).toEqual({
      kind: "consent",
      authorizationId: "abcdefghijklmnop12345678",
    });
    const error = "https://ledger.example.test/callback?error=invalid_request&state=xyz";
    expect(readAuthorizeAnswer(error)).toEqual({ kind: "client", location: error });
    expect(readAuthorizeAnswer(null)).toEqual({ kind: "none" });
    expect(readAuthorizeAnswer("::not a url")).toEqual({ kind: "none" });
  });
});

describe("consent", () => {
  it("records the request and reads it back", async () => {
    const { db, rpc } = client({
      oauth_consent_request: {
        data: [
          {
            oauth_app_id: "a1",
            app_name: "Ledger Sync",
            client_id: "xos_client_1",
            org_id: "o1",
            org_name: "Northwind Live",
            redirect_uri: "https://ledger.example.test/callback",
            scopes: ["data", "work"],
            restricted_scopes: ["data"],
            granted_scopes: null,
            pkce_s256: true,
            expires_at: "t",
          },
        ],
        error: null,
      },
    });
    expect(await recordOAuthRequest(db, "auth1", ["work"])).toEqual({ ok: true, data: null });
    expect(rpc).toHaveBeenCalledWith("record_oauth_request", {
      p_authorization_id: "auth1",
      p_scopes: ["work"],
    });
    expect(await getConsentRequest(db, "auth1")).toMatchObject({
      ok: true,
      data: {
        appName: "Ledger Sync",
        restrictedScopes: ["data"],
        grantedScopes: null,
        pkceS256: true,
      },
    });
    expect(await getConsentRequest(client({}).db, "auth1")).toEqual({ ok: true, data: null });
  });

  it("asks Supabase Auth for the details and notices an earlier consent", async () => {
    const details = client(
      {},
      {
        getAuthorizationDetails: async () => ({
          data: { authorization_id: "a", scope: "email" },
          error: null,
        }),
      },
    );
    expect(await getAuthorizationDetails(details.db, "a")).toEqual({
      ok: true,
      data: { redirectUrl: null },
    });
    const known = client(
      {},
      {
        getAuthorizationDetails: async () => ({
          data: { redirect_url: "https://app/cb?code=1" },
          error: null,
        }),
      },
    );
    expect(await getAuthorizationDetails(known.db, "a")).toEqual({
      ok: true,
      data: { redirectUrl: "https://app/cb?code=1" },
    });
    const gone = client(
      {},
      { getAuthorizationDetails: async () => ({ data: null, error: { message: "gone" } }) },
    );
    expect(await getAuthorizationDetails(gone.db, "a")).toMatchObject({
      ok: false,
      error: { rule: "oauth_request_expired" },
    });
  });

  it("records the grant before Supabase Auth issues the code", async () => {
    const approveAuthorization = vi.fn(async () => ({
      data: { redirect_url: "https://app/cb?code=1&state=x" },
      error: null,
    }));
    const { db, rpc } = client({}, { approveAuthorization });
    expect(await consentToRequest(db, "auth1")).toEqual({
      ok: true,
      data: "https://app/cb?code=1&state=x",
    });
    expect(rpc).toHaveBeenCalledWith("consent_oauth_request", { p_authorization_id: "auth1" });
    expect(approveAuthorization).toHaveBeenCalledWith("auth1", { skipBrowserRedirect: true });
  });

  it("never asks Supabase Auth for a code the database refused", async () => {
    const approveAuthorization = vi.fn();
    const { db } = client(
      {
        consent_oauth_request: {
          data: null,
          error: { code: "XR001", message: "step_up_required: x", hint: "step_up_required" },
        },
      },
      { approveAuthorization },
    );
    expect(await consentToRequest(db, "auth1")).toMatchObject({
      ok: false,
      error: { rule: "step_up_required" },
    });
    expect(approveAuthorization).not.toHaveBeenCalled();
  });

  it("declines with access_denied", async () => {
    const denyAuthorization = vi.fn(async () => ({
      data: { redirect_url: "https://app/cb?error=access_denied" },
      error: null,
    }));
    const { db, rpc } = client({}, { denyAuthorization });
    expect(await declineRequest(db, "auth1")).toEqual({
      ok: true,
      data: "https://app/cb?error=access_denied",
    });
    expect(rpc).toHaveBeenCalledWith("decline_oauth_request", { p_authorization_id: "auth1" });
    const failed = client(
      {},
      { denyAuthorization: async () => ({ data: null, error: { message: "x" } }) },
    );
    expect(await declineRequest(failed.db, "auth1")).toMatchObject({ ok: false });
  });
});

describe("connected apps", () => {
  it("lists grants and revokes one", async () => {
    const select = vi.fn(async () => ({ data: [{ id: "g1" }], error: null }));
    const chain = {
      update: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      is: vi.fn(() => ({ select })),
    };
    const rpc = vi.fn(async () => ({
      data: [
        {
          grant_id: "g1",
          oauth_app_id: "a1",
          app_name: "Ledger Sync",
          org_name: "Northwind Live",
          scopes: ["work"],
          granted_at: "t",
          last_used_at: null,
        },
      ],
      error: null,
    }));
    const db = { rpc, from: vi.fn(() => chain) } as unknown as XosClient;
    expect(await listConnectedApps(db)).toMatchObject({
      ok: true,
      data: [{ grantId: "g1", appName: "Ledger Sync" }],
    });
    expect(await revokeConnectedApp(db, "g1")).toEqual({ ok: true, data: null });
    expect(chain.eq).toHaveBeenCalledWith("id", "g1");
    select.mockResolvedValueOnce({ data: [], error: null });
    expect(await revokeConnectedApp(db, "g2")).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("reads an app session's access", async () => {
    const { db } = client({
      my_oauth_access: {
        data: [{ oauth_app_id: "a1", org_id: "o1", scopes: ["work"] }],
        error: null,
      },
    });
    expect(await getMyOAuthAccess(db)).toEqual({
      ok: true,
      data: { appId: "a1", orgId: "o1", scopes: ["work"] },
    });
    expect(await getMyOAuthAccess(client({}).db)).toEqual({ ok: true, data: null });
  });
});
