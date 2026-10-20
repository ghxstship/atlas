import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authErrorKey,
  isAuthNotice,
  oauthCallbackError,
  type AuthErrorKey,
} from "../lib/auth/errors";
import { providerQueryParams } from "../lib/auth/providers";
import { safeNext, signInErrorPath, siteUrl } from "../lib/auth/redirect";
import { buildCsp } from "../lib/security/headers";

/**
 * Sign in with Google (ADR 0036, RRR-117). The server action and the callback run with the real
 * @supabase/ssr client against an in-memory cookie jar; fetch is replaced, so nothing leaves the
 * process. Supabase Auth's answers below are the shapes the local GoTrue returned for the same
 * requests (captured on the xos4-a72 stack).
 */

const SITE = "http://127.0.0.1:3006";
const SUPABASE = "http://127.0.0.1:55421";

/** next/headers: a cookie jar that keeps what the Supabase client sets, and the request headers. */
const jar = vi.hoisted(() => {
  const values = new Map<string, { value: string; options: Record<string, unknown> }>();
  return {
    values,
    store: {
      getAll: () => [...values].map(([name, c]) => ({ name, value: c.value })),
      get: (name: string) => {
        const c = values.get(name);
        return c ? { name, value: c.value } : undefined;
      },
      set: (name: string, value: string, options: Record<string, unknown> = {}) => {
        if (options["maxAge"] === 0) values.delete(name);
        else values.set(name, { value, options });
      },
    },
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => jar.store,
  headers: async () => new Headers({ host: "127.0.0.1:3006" }),
}));

/** next/navigation: redirect() ends the action, as Next's own does, and reports where to. */
class Redirected extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));

let settings: Record<string, boolean>;
let tokenRequests: { auth_code: string; code_verifier: string }[];
let tokenAnswer: () => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const b64url = (text: string) => Buffer.from(text).toString("base64url");

/** A session as Supabase Auth's /token returns it; the access token is built here, never stored. */
function session(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: "4f1c2e7a-0000-4000-8000-000000000072",
    exp: now + 3600,
    role: "authenticated",
  };
  return {
    access_token: [b64url('{"alg":"HS256"}'), b64url(JSON.stringify(claims)), "sig"].join("."),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: "refresh-for-tests",
    user: {
      id: claims.sub,
      aud: "authenticated",
      email: "ada@example.com",
      app_metadata: { provider: "google", providers: ["email", "google"] },
      user_metadata: { full_name: "Ada Lovelace" },
      created_at: "2026-10-20T00:00:00Z",
    },
  };
}

beforeAll(() => {
  vi.stubEnv("SUPABASE_URL", SUPABASE);
  vi.stubEnv("SUPABASE_ANON_KEY", "anon-key-for-tests-0000000000");
  vi.stubEnv("ATLAS_SITE_URL", SITE);
});

beforeEach(() => {
  jar.values.clear();
  settings = { google: true, apple: false, azure: false };
  tokenRequests = [];
  tokenAnswer = () => json(session());
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== SUPABASE) throw new Error(`unexpected request to ${url.origin}`);
    if (url.pathname === "/auth/v1/settings") return json({ external: settings });
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      tokenRequests.push(JSON.parse(String(init?.body)));
      return tokenAnswer();
    }
    throw new Error(`unexpected request to ${url.pathname}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function startWith(fields: Record<string, string>): Promise<URL> {
  const { signInWithProvider } = await import("../app/auth/actions");
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  try {
    await signInWithProvider(form);
  } catch (error) {
    if (error instanceof Redirected) return new URL(error.url, SITE);
    throw error;
  }
  throw new Error("signInWithProvider did not redirect");
}

/** NextRequest names a loopback host localhost; redirects stay on whatever host the request has. */
let requestOrigin = "";

async function callback(query: string): Promise<URL> {
  const { GET } = await import("../app/auth/callback/route");
  const request = new NextRequest(`${SITE}/auth/callback?${query}`);
  requestOrigin = new URL(request.url).origin;
  const response = await GET(request);
  expect(response.status).toBe(307);
  return new URL(response.headers.get("location") ?? "");
}

/** A value @supabase/ssr wrote to the jar, decoded from its base64url encoding. */
function stored(name: string): unknown {
  const cookie = jar.values.get(name);
  if (!cookie) throw new Error(`no cookie ${name}`);
  const raw = cookie.value.startsWith("base64-")
    ? Buffer.from(cookie.value.slice("base64-".length), "base64url").toString()
    : cookie.value;
  return JSON.parse(raw);
}

/** The PKCE flows started in this jar, oldest first (auth-js keeps an index of them). */
function flows(): string[] {
  return stored("xos-auth-flows-code-verifier") as string[];
}

/** The code verifier of a flow, without the redirect type auth-js may append. */
function verifierOf(flowId: string): string {
  return String(stored(`xos-auth-flow-${flowId}-code-verifier`)).split("/")[0] ?? "";
}

describe("Continue with Google: starting the flow", () => {
  it("sends the browser to Supabase Auth's authorize endpoint with a PKCE challenge", async () => {
    const to = await startWith({ provider: "google", next: "/auth/invite/xlnk_abc123" });
    expect(`${to.origin}${to.pathname}`).toBe(`${SUPABASE}/auth/v1/authorize`);
    expect(to.searchParams.get("provider")).toBe("google");
    expect(to.searchParams.get("code_challenge_method")).toBe("s256");
    expect(to.searchParams.get("prompt")).toBe("select_account");

    const back = new URL(to.searchParams.get("redirect_to") ?? "");
    expect(`${back.origin}${back.pathname}`).toBe(`${SITE}/auth/callback`);
    expect(back.searchParams.get("next")).toBe("/auth/invite/xlnk_abc123");
    expect(back.searchParams.get("provider")).toBe("google");

    // The verifier stays in an httpOnly, same-site cookie; the URL carries only its SHA-256.
    const [flowId] = flows();
    const verifier = verifierOf(flowId ?? "");
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      to.searchParams.get("code_challenge"),
    );
    expect(to.toString()).not.toContain(verifier);
    expect(jar.values.get(`xos-auth-flow-${flowId}-code-verifier`)?.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("keeps an org page as the destination and drops anything off this site", async () => {
    const org = await startWith({ provider: "google", next: "/acme/p/NWS/overview?tab=crew" });
    const orgBack = new URL(org.searchParams.get("redirect_to") ?? "");
    expect(orgBack.searchParams.get("next")).toBe("/acme/p/NWS/overview?tab=crew");

    for (const next of ["//evil.example/x", "https://evil.example", "/\\evil.example"]) {
      const to = await startWith({ provider: "google", next });
      const back = new URL(to.searchParams.get("redirect_to") ?? "");
      expect(back.origin).toBe(SITE);
      expect(back.searchParams.has("next")).toBe(false);
    }
  });

  it("refuses a provider that is unknown or not turned on, keeping where the person was going", async () => {
    const unknown = await startWith({ provider: "github", next: "/acme/home" });
    expect(`${unknown.pathname}${unknown.search}`).toBe(
      "/auth/sign-in?error=provider_disabled&next=%2Facme%2Fhome",
    );
    settings = { google: false, apple: false, azure: false };
    const off = await startWith({ provider: "google" });
    expect(`${off.pathname}${off.search}`).toBe("/auth/sign-in?error=provider_disabled");
    expect(jar.values.size).toBe(0);
  });
});

describe("Continue with Google: the callback", () => {
  it("exchanges the code with the stored verifier and sets the session cookie", async () => {
    const to = await startWith({ provider: "google", next: "/auth/invite/xlnk_abc123" });
    const back = new URL(to.searchParams.get("redirect_to") ?? "");
    const [flowId] = flows();
    const verifier = verifierOf(flowId ?? "");
    // Supabase Auth adds the code to the return address and keeps the rest (captured locally).
    back.searchParams.set("code", "c0ffee00-0000-4000-8000-000000000001");

    const landed = await callback(back.searchParams.toString());
    expect(`${landed.origin}${landed.pathname}`).toBe(`${requestOrigin}/auth/invite/xlnk_abc123`);
    expect(tokenRequests).toEqual([
      { auth_code: "c0ffee00-0000-4000-8000-000000000001", code_verifier: verifier },
    ]);
    const sessionCookies = [...jar.values.keys()].filter((name) => /^xos-auth(\.\d+)?$/.test(name));
    expect(sessionCookies.length).toBeGreaterThan(0);
    expect(jar.values.get(sessionCookies[0] ?? "")?.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
    });
    // Without a flow id, auth-js uses and removes the fixed key that mirrors the latest flow.
    expect(jar.values.has("xos-auth-code-verifier")).toBe(false);
  });

  it("picks the named flow's verifier when the return address carries sb_flow_id", async () => {
    await startWith({ provider: "google" });
    await startWith({ provider: "google" });
    const [first, second] = flows();
    expect(first).not.toBe(second);
    const verifier = verifierOf(first ?? "");
    await callback(`code=first-code&provider=google&sb_flow_id=${first}`);
    expect(tokenRequests).toEqual([{ auth_code: "first-code", code_verifier: verifier }]);
    expect(jar.values.has(`xos-auth-flow-${first}-code-verifier`)).toBe(false);
  });

  it("never sends the person off this site after signing in", async () => {
    for (const next of ["//evil.example", "https://evil.example/home", "javascript:alert(1)"]) {
      await startWith({ provider: "google" });
      const landed = await callback(
        new URLSearchParams({ code: "abc", provider: "google", next }).toString(),
      );
      expect(landed.origin).toBe(requestOrigin);
      expect(landed.pathname).toBe("/");
    }
  });

  const refusals: [string, string, AuthErrorKey][] = [
    // Captured from the local GoTrue: Google's consent screen closed (error=access_denied).
    [
      "cancelled at Google",
      "error=access_denied&error_description=&next=%2Fauth%2Finvite%2Fxlnk_abc&provider=google",
      "oauth_cancelled",
    ],
    [
      "Google's own error",
      "error=server_error&error_description=boom&next=%2Fauth%2Finvite%2Fxlnk_abc&provider=google",
      "provider_error",
    ],
    [
      "an unverified Google email",
      "error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified+email+with+google.&next=%2Fauth%2Finvite%2Fxlnk_abc&provider=google",
      "email_not_verified",
    ],
    [
      "an org that requires single sign-on",
      "error=access_denied&error_code=sso_required&next=%2Fauth%2Finvite%2Fxlnk_abc&provider=google",
      "sso_required",
    ],
    [
      "a stale OAuth state",
      "error=invalid_request&error_code=bad_oauth_state&error_description=OAuth+state+parameter+is+invalid&next=%2Fauth%2Finvite%2Fxlnk_abc",
      "oauth_expired",
    ],
  ];

  it.each(refusals)("returns to sign-in with a message for %s", async (_, query, key) => {
    const landed = await callback(query);
    expect(landed.pathname).toBe("/auth/sign-in");
    expect(landed.searchParams.get("error")).toBe(key);
    expect(landed.searchParams.get("next")).toBe("/auth/invite/xlnk_abc");
    expect(tokenRequests).toEqual([]);
  });

  it("reads a code that cannot be exchanged as an expired sign-in, or an expired email link", async () => {
    // Started in another browser: no verifier here, so nothing is sent to Supabase Auth.
    const elsewhere = await callback("code=abc&provider=google&next=%2Facme%2Fhome");
    expect(`${elsewhere.pathname}${elsewhere.search}`).toBe(
      "/auth/sign-in?error=oauth_expired&next=%2Facme%2Fhome",
    );
    expect(tokenRequests).toEqual([]);

    // Supabase Auth no longer knows the flow (the shape the local GoTrue returns).
    tokenAnswer = () =>
      new Response(
        JSON.stringify({
          code: 404,
          error_code: "flow_state_not_found",
          msg: "invalid flow state, no valid flow state found",
        }),
        {
          status: 404,
          headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
        },
      );
    await startWith({ provider: "google" });
    const stale = await callback("code=abc&provider=google");
    expect(`${stale.pathname}${stale.search}`).toBe("/auth/sign-in?error=oauth_expired");
    await startWith({ provider: "google" });
    const link = await callback("code=abc&next=%2Facme%2Fhome");
    expect(link.searchParams.get("error")).toBe("link_invalid");
    const noCode = await callback("provider=google");
    expect(`${noCode.pathname}${noCode.search}`).toBe("/auth/sign-in?error=oauth_expired");
  });
});

describe("OAuth error mapping", () => {
  it("maps Supabase Auth's return parameters to catalog keys", () => {
    const params = (query: string) => new URLSearchParams(query);
    expect(oauthCallbackError(params("code=abc"))).toBeNull();
    expect(oauthCallbackError(params("error=access_denied"))).toBe("oauth_cancelled");
    expect(oauthCallbackError(params("error=access_denied&error_code=user_banned"))).toBe(
      "provider_error",
    );
    expect(oauthCallbackError(params("error=temporarily_unavailable"))).toBe("provider_error");
    expect(oauthCallbackError(params("error=access_denied&error_code=otp_expired"))).toBe(
      "link_invalid",
    );
    expect(oauthCallbackError(params("error_code=sso_session_required"))).toBe("sso_required");
  });

  it("passes the new keys through the sign-in page's error parameter", () => {
    for (const key of [
      "oauth_cancelled",
      "oauth_expired",
      "provider_error",
      "email_not_verified",
      "sso_required",
    ] as const) {
      expect(authErrorKey({ code: key })).toBe(key);
    }
    expect(isAuthNotice("oauth_cancelled")).toBe(true);
    expect(isAuthNotice("provider_error")).toBe(false);
  });
});

describe("OAuth helpers", () => {
  it("builds the return address with next and the provider", () => {
    expect(siteUrl(SITE, "/auth/callback", "/acme/home", { provider: "google" })).toBe(
      `${SITE}/auth/callback?next=%2Facme%2Fhome&provider=google`,
    );
    expect(siteUrl(SITE, "/auth/callback", "/", { provider: "google" })).toBe(
      `${SITE}/auth/callback?provider=google`,
    );
    expect(signInErrorPath("oauth_cancelled", "/")).toBe("/auth/sign-in?error=oauth_cancelled");
    expect(safeNext("/auth/invite/xlnk_abc")).toBe("/auth/invite/xlnk_abc");
  });

  it("asks Google for its account chooser and nothing extra of the others", () => {
    expect(providerQueryParams("google")).toEqual({ prompt: "select_account" });
    expect(providerQueryParams("apple")).toEqual({});
  });

  it("lets the no-JavaScript sign-in form redirect through to Google's consent screen", () => {
    const csp = buildCsp({
      nonce: "n",
      development: false,
      supabaseOrigin: SUPABASE,
      secureSite: true,
    });
    expect(csp).toContain(`form-action 'self' ${SUPABASE} https://accounts.google.com;`);
  });
});
