import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authErrorKey, isAuthNotice, oauthCallbackError } from "../lib/auth/errors";
import { providerQueryParams } from "../lib/auth/providers";
import { signInErrorPath, siteUrl } from "../lib/auth/redirect";
import { buildCsp } from "../lib/security/headers";

/**
 * Sign in with Google on Gateway (ADR 0036, RRR-117). The account is the one Atlas and Compass use.
 * The server action and the callback run with the real @supabase/ssr client against an in-memory
 * cookie jar; fetch is replaced, so nothing leaves the process.
 */

const SITE = "http://127.0.0.1:3127";
const SUPABASE = "http://127.0.0.1:55421";

const jar = vi.hoisted(() => {
  const values = new Map<string, { value: string; options: Record<string, unknown> }>();
  return {
    values,
    host: { value: "127.0.0.1:3127" },
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
  headers: async () => new Headers({ host: jar.host.value }),
}));

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

let tokenRequests: { auth_code: string; code_verifier: string }[];
/** The signed-in user's metadata, as Supabase Auth's /user returns it. */
let userMetadata: Record<string, unknown>;
/** Worker Terms rows the acceptance log holds for the person. */
let accepted: { document_slug: string }[];
/** Acceptances written through app.record_legal_acceptances. */
let recorded: Record<string, unknown>[];
/** Age confirmations written through app.confirm_minimum_age (migration 1381). */
let ages: Record<string, unknown>[];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

const b64url = (text: string) => Buffer.from(text).toString("base64url");

function session(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: "4f1c2e7a-0000-4000-8000-000000000127", exp: now + 3600 };
  return {
    access_token: [b64url('{"alg":"HS256"}'), b64url(JSON.stringify(claims)), "sig"].join("."),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: "refresh-for-tests",
    user: { id: claims.sub, aud: "authenticated", email: "sam@example.com", app_metadata: {} },
  };
}

beforeAll(() => {
  vi.stubEnv("SUPABASE_URL", SUPABASE);
  vi.stubEnv("SUPABASE_ANON_KEY", "anon-key-for-tests-0000000000");
  vi.stubEnv("GATEWAY_SITE_URL", SITE);
  vi.stubEnv("GATEWAY_PLATFORM_HOSTS", "127.0.0.1,localhost");
});

beforeEach(() => {
  jar.values.clear();
  jar.host.value = "127.0.0.1:3127";
  tokenRequests = [];
  userMetadata = { full_name: "Sam Rivera" };
  accepted = [];
  recorded = [];
  ages = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== SUPABASE) throw new Error(`unexpected request to ${url.origin}`);
    if (url.pathname === "/auth/v1/settings") return json({ external: { google: true } });
    if (url.pathname === "/auth/v1/token") {
      tokenRequests.push(JSON.parse(String(init?.body)));
      return json(session());
    }
    if (url.pathname === "/auth/v1/user") {
      return json({ ...(session()["user"] as object), user_metadata: userMetadata });
    }
    if (url.pathname === "/rest/v1/legal_acceptances") return json(accepted);
    if (url.pathname === "/rest/v1/rpc/record_legal_acceptances") {
      recorded.push(JSON.parse(String(init?.body)));
      return json(1);
    }
    if (url.pathname === "/rest/v1/rpc/minimum_age_confirmed") return json(ages.length > 0);
    if (url.pathname === "/rest/v1/rpc/confirm_minimum_age") {
      ages.push(JSON.parse(String(init?.body)));
      return json("2026-10-20T10:00:00Z");
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

/** Calls the callback and resolves its redirect, always a path on this site, as the browser would. */
async function callback(query: string): Promise<{ to: URL; origin: string }> {
  const { GET } = await import("../app/auth/callback/route");
  const response = await GET(new NextRequest(`${SITE}/auth/callback?${query}`));
  const location = response.headers.get("location") ?? "";
  expect(location).toMatch(/^\/(?![/\\])/);
  return { to: new URL(location, SITE), origin: SITE };
}

function stored(name: string): unknown {
  const cookie = jar.values.get(name);
  if (!cookie) throw new Error(`no cookie ${name}`);
  const raw = cookie.value.startsWith("base64-")
    ? Buffer.from(cookie.value.slice("base64-".length), "base64url").toString()
    : cookie.value;
  return JSON.parse(raw);
}

describe("Gateway: Continue with Google", () => {
  it("starts PKCE on the platform host and returns to Gateway's callback with next", async () => {
    const to = await startWith({ provider: "google", next: "/auth/claim" });
    expect(`${to.origin}${to.pathname}`).toBe(`${SUPABASE}/auth/v1/authorize`);
    expect(to.searchParams.get("provider")).toBe("google");
    expect(to.searchParams.get("code_challenge_method")).toBe("s256");
    expect(to.searchParams.get("prompt")).toBe("select_account");
    const back = new URL(to.searchParams.get("redirect_to") ?? "");
    expect(`${back.origin}${back.pathname}`).toBe(`${SITE}/auth/callback`);
    expect(back.searchParams.get("next")).toBe("/auth/claim");
    expect(back.searchParams.get("provider")).toBe("google");

    const [flowId] = stored("xos-auth-flows-code-verifier") as string[];
    const verifier = String(stored(`xos-auth-flow-${flowId}-code-verifier`));
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      to.searchParams.get("code_challenge"),
    );
  });

  it("defaults to Home and drops destinations off this site", async () => {
    for (const next of ["", "//evil.example", "https://evil.example/home"]) {
      const to = await startWith({ provider: "google", next });
      const back = new URL(to.searchParams.get("redirect_to") ?? "");
      expect(back.origin).toBe(SITE);
      expect(back.searchParams.get("next")).toBe("/home");
    }
  });

  it("offers no provider on an org's custom domain, whose return leg would lose the verifier", async () => {
    jar.host.value = "portal.acme-events.example";
    const to = await startWith({ provider: "google", next: "/work" });
    expect(`${to.pathname}${to.search}`).toBe("/auth/sign-in?error=provider_disabled&next=%2Fwork");
    expect(jar.values.size).toBe(0);
  });

  it("exchanges the code and lands on next with the session cookie set", async () => {
    accepted = [{ document_slug: "worker-terms" }];
    const start = await startWith({ provider: "google", next: "/work/engagements/eng_1" });
    const back = new URL(start.searchParams.get("redirect_to") ?? "");
    back.searchParams.set("code", "c0ffee00-0000-4000-8000-000000000127");
    const { to, origin } = await callback(back.searchParams.toString());
    expect(`${to.origin}${to.pathname}`).toBe(`${origin}/work/engagements/eng_1`);
    expect(tokenRequests).toHaveLength(1);
    expect([...jar.values.keys()].some((name) => /^xos-auth(\.\d+)?$/.test(name))).toBe(true);
  });

  it("returns to sign-in with the provider's refusal and keeps next", async () => {
    const cases: [string, string][] = [
      [
        "error=access_denied&error_description=&next=%2Fauth%2Fclaim&provider=google",
        "oauth_cancelled",
      ],
      [
        "error=server_error&error_description=boom&next=%2Fauth%2Fclaim&provider=google",
        "provider_error",
      ],
      [
        "error=access_denied&error_code=provider_email_needs_verification&next=%2Fauth%2Fclaim",
        "email_not_verified",
      ],
      ["error=access_denied&error_code=sso_required&next=%2Fauth%2Fclaim", "sso_required"],
    ];
    for (const [query, key] of cases) {
      const { to } = await callback(query);
      expect(`${to.pathname}${to.search}`).toBe(`/auth/sign-in?error=${key}&next=%2Fauth%2Fclaim`);
    }
    const { to: home } = await callback("error=access_denied&provider=google");
    expect(`${home.pathname}${home.search}`).toBe("/auth/sign-in?error=oauth_cancelled");
    const { to: elsewhere } = await callback("code=abc&provider=google");
    expect(`${elsewhere.pathname}${elsewhere.search}`).toBe("/auth/sign-in?error=oauth_expired");
    expect(tokenRequests).toEqual([]);
  });
});

describe("Gateway: the Worker Terms for an account Google created (A59-025)", () => {
  async function signedInWithGoogle(next: string): Promise<URL> {
    const start = await startWith({ provider: "google", next });
    const back = new URL(start.searchParams.get("redirect_to") ?? "");
    back.searchParams.set("code", "c0ffee00-0000-4000-8000-000000000128");
    return (await callback(back.searchParams.toString())).to;
  }

  it("sends a new Google account to accept the Worker Terms, keeping where it was going", async () => {
    const to = await signedInWithGoogle("/auth/claim");
    expect(`${to.pathname}${to.search}`).toBe("/auth/terms?next=%2Fauth%2Fclaim");
    const home = await signedInWithGoogle("/home");
    expect(`${home.pathname}${home.search}`).toBe("/auth/terms");
  });

  it("lets an account through that accepted them, or whose acceptance is about to be written", async () => {
    accepted = [{ document_slug: "worker-terms" }];
    expect((await signedInWithGoogle("/auth/claim")).pathname).toBe("/auth/claim");
    accepted = [];
    userMetadata = {
      pending_legal_acceptances: [{ slug: "worker-terms", version: "1.0.0-draft" }],
    };
    expect((await signedInWithGoogle("/auth/claim")).pathname).toBe("/auth/claim");
  });

  it("never asks after an email link, which accepted them on the sign-up form", async () => {
    const start = await startWith({ provider: "google" });
    expect(start.pathname).toBe("/auth/v1/authorize");
    const { to } = await callback("code=abc&next=%2Fauth%2Fclaim");
    expect(to.pathname).toBe("/auth/claim");
  });

  it("records the acceptance with the current versions, then continues", async () => {
    const { acceptSignUpTerms } = await import("../app/auth/actions");
    await startWith({ provider: "google" });
    const back = new URLSearchParams({ code: "abc", provider: "google" });
    await callback(back.toString());

    const unticked = new FormData();
    unticked.set("next", "/auth/claim");
    expect(await acceptSignUpTerms({}, unticked)).toEqual({
      fieldErrors: { acceptTerms: "terms", ageConfirmed: "age" },
    });
    expect(recorded).toEqual([]);

    const ticked = new FormData();
    ticked.set("next", "/auth/claim");
    ticked.set("acceptTerms", "yes");
    ticked.set("ageConfirmed", "16");
    await expect(acceptSignUpTerms({}, ticked)).rejects.toMatchObject({ url: "/auth/claim" });
    // A Google account confirms "16 or older" here, since no form asked before (A65-014).
    expect(ages).toEqual([{ p_surface: "Gateway" }]);
    expect(recorded).toEqual([
      {
        p_org_id: null,
        p_document_slugs: ["worker-terms"],
        p_document_versions: ["1.0.0-draft"],
      },
    ]);
  });
});

describe("Gateway OAuth helpers", () => {
  it("map errors and build addresses like Atlas", () => {
    expect(oauthCallbackError(new URLSearchParams("error=access_denied"))).toBe("oauth_cancelled");
    expect(authErrorKey({ code: "pkce_code_verifier_not_found" })).toBe("link_invalid");
    expect(isAuthNotice("oauth_cancelled")).toBe(true);
    expect(siteUrl(SITE, "/auth/callback", "/home", { provider: "google" })).toBe(
      `${SITE}/auth/callback?next=%2Fhome&provider=google`,
    );
    expect(signInErrorPath("provider_error", "/home", "/home")).toBe(
      "/auth/sign-in?error=provider_error",
    );
    expect(providerQueryParams("google")).toEqual({ prompt: "select_account" });
  });

  it("let the no-JavaScript sign-in form redirect through to Google's consent screen", () => {
    const csp = buildCsp({
      nonce: "n",
      development: false,
      supabaseOrigin: SUPABASE,
      secureSite: true,
    });
    expect(csp).toContain(`form-action 'self' ${SUPABASE} https://accounts.google.com;`);
  });
});
