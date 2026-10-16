/**
 * Credentials, org binding and locale (ADR 0003, ADR 0007 item 1), against a fake Supabase that
 * answers the Auth and PostgREST calls the authenticator makes.
 */
import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/app.ts";
import {
  apiKeyTokenScopes,
  createSupabaseAuthenticator,
  jwtClaims,
  negotiateLocale,
  parseCookies,
  sessionCookieName,
  sessionTokenFromCookies,
} from "../src/runtime/auth.ts";
import { requireOrg, requirePerson } from "../src/runtime/context.ts";
import type { RequestContext } from "../src/runtime/context.ts";
import { ApiProblem } from "../src/problem.ts";
import { defineHandlers, ok } from "../src/runtime/handler.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PERSON_ID = "22222222-2222-4222-8222-222222222222";
const ORG_A = { id: "33333333-3333-4333-8333-333333333333", slug: "alpha", name: "Alpha" };
const SA_USER_ID = "66666666-6666-4666-8666-666666666666";
const ORG_B = { id: "44444444-4444-4444-8444-444444444444", slug: "bravo", name: "Bravo" };

function jwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part({ alg: "HS256" })}.${part({ sub: USER_ID, ...claims })}.signature`;
}

const VALID = jwt({});

function fakeSupabase(orgs: (typeof ORG_A)[], options: { person?: boolean } = {}) {
  const calls: string[] = [];
  const exchanges: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const headers = new Headers(init?.headers ?? (input as Request).headers);
    calls.push(`${url.pathname} ${headers.get("authorization")}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/auth/v1/user") {
      const token = headers.get("authorization")?.replace("Bearer ", "") ?? "";
      if (token.endsWith(".signature"))
        return json({ id: USER_ID, email: "ada@example.com", aud: "authenticated" });
      return json({ code: 401, msg: "invalid JWT" }, 401);
    }
    if (url.pathname === "/functions/v1/api-token") {
      exchanges.push(headers.get("authorization") ?? "");
      const key = headers.get("authorization")?.replace("Bearer ", "");
      if (key === "xos_live_broken") return json({ detail: "boom" }, 500);
      if (key === "xos_live_nosa") {
        return json(
          { detail: "Attach this key to a service account before calling the API with it." },
          422,
        );
      }
      if (key === "xos_live_bare") return json({ detail: "Refused." }, 422);
      if (key !== "xos_live_valid") return json({ detail: "unknown" }, 401);
      return json({
        access_token: jwt({ sub: SA_USER_ID, org_id: ORG_A.id }),
        token_type: "bearer",
        expires_in: 300,
        org_id: ORG_A.id,
        scopes: ["canon"],
      });
    }
    if (url.pathname === "/rest/v1/people") {
      return json(options.person === false ? [] : [{ id: PERSON_ID, full_name: "Ada" }]);
    }
    if (url.pathname === "/rest/v1/memberships") {
      return json(
        orgs.map((o, i) => ({
          id: `m${i}`,
          organization: { ...o, parent_org_id: null, deleted_at: null },
          membership_roles: [],
        })),
      );
    }
    return json({ message: `unexpected ${url.pathname}` }, 500);
  };
  const authenticate = createSupabaseAuthenticator({
    url: "http://supabase.test",
    anonKey: "anon-key-for-tests-0000",
    siteOrigin: "https://atlas.test",
    fetch: fetcher,
  });
  return { authenticate, calls, exchanges };
}

function sessionCookie(token: string, chunked = false): string {
  const value = `base64-${Buffer.from(JSON.stringify({ access_token: token })).toString("base64url")}`;
  if (!chunked) return `__Host-xos-auth=${value}`;
  const mid = Math.floor(value.length / 2);
  return `__Host-xos-auth.0=${value.slice(0, mid)}; __Host-xos-auth.1=${value.slice(mid)}`;
}

async function resolve(
  authenticate: ReturnType<typeof fakeSupabase>["authenticate"],
  headers: Record<string, string>,
  method = "GET",
) {
  return authenticate(new Request("https://atlas.test/api/v1/me", { method, headers }), "req-1");
}

describe("bearer session tokens", () => {
  it("verifies the token and binds the only membership", async () => {
    const { authenticate, calls } = fakeSupabase([ORG_A]);
    const context = await resolve(authenticate, {
      authorization: `Bearer ${VALID}`,
      "accept-language": "es-MX,es;q=0.9,en;q=0.5",
    });
    expect(context?.user).toEqual({ id: USER_ID, email: "ada@example.com" });
    expect(context?.personId).toBe(PERSON_ID);
    expect(context?.org).toEqual({ id: ORG_A.id, slug: ORG_A.slug });
    expect(context?.locale).toBe("es-US");
    expect(context?.credential).toBe("session");
    // Every database call carries the caller's token: RLS decides, never the service role.
    expect(calls.filter((c) => c.startsWith("/rest/")).every((c) => c.endsWith(VALID))).toBe(true);
  });

  it("binds the org_id claim when the caller is a member, else falls back", async () => {
    const two = fakeSupabase([ORG_A, ORG_B]);
    const claimed = await resolve(two.authenticate, {
      authorization: `Bearer ${jwt({ org_id: ORG_B.id })}`,
    });
    expect(claimed?.org?.id).toBe(ORG_B.id);
    const foreign = await resolve(two.authenticate, {
      authorization: `Bearer ${jwt({ org_id: "55555555-5555-4555-8555-555555555555" })}`,
    });
    expect(foreign?.org).toBeNull();
  });

  it("returns null for an invalid token and refuses a malformed header", async () => {
    const { authenticate } = fakeSupabase([ORG_A]);
    expect(await resolve(authenticate, { authorization: "Bearer not-a-jwt" })).toBeNull();
    await expect(resolve(authenticate, { authorization: "Basic abc" })).rejects.toBeInstanceOf(
      ApiProblem,
    );
    expect(await resolve(authenticate, { authorization: "Bearer xos_live_abcdef" })).toBeNull();
    expect(await resolve(authenticate, {})).toBeNull();
  });

  it("leaves person and org empty for a sign-in without a person", async () => {
    const { authenticate } = fakeSupabase([ORG_A], { person: false });
    const context = await resolve(authenticate, { authorization: `Bearer ${VALID}` });
    expect(context?.personId).toBeNull();
    expect(context?.org).toBeNull();
    expect(() => requireOrg(context as RequestContext)).toThrow(ApiProblem);
    expect(() => requirePerson(context as RequestContext)).toThrow(ApiProblem);
  });
});

describe("API keys", () => {
  it("exchanges a key for a service account token, caches it and limits it to its scopes", async () => {
    const { authenticate, calls, exchanges } = fakeSupabase([ORG_A]);
    const context = await resolve(authenticate, { authorization: "Bearer xos_live_valid" });
    expect(context?.credential).toBe("api_key");
    expect(context?.user.id).toBe(SA_USER_ID);
    expect(context?.org?.id).toBe(ORG_A.id);
    expect(context?.scopes).toEqual(["canon"]);
    const minted = jwt({ sub: SA_USER_ID, org_id: ORG_A.id });
    expect(calls.filter((c) => c.startsWith("/rest/")).every((c) => c.endsWith(minted))).toBe(true);
    await resolve(authenticate, { authorization: "Bearer xos_live_valid" });
    expect(exchanges).toHaveLength(1);

    const app = createApiApp({ authenticate, rateLimiter: false });
    // A path no module ever handles, so this stays a 404 as module agents add handlers.
    const outOfScope = await app.request("/no-such-resource", {
      headers: { authorization: "Bearer xos_live_valid" },
    });
    expect(outOfScope.status).toBe(404);
    const denied = defineHandlers("Projects", {
      "projects.list": async () => ok({ data: [], next_cursor: null } as never),
    });
    const scoped = createApiApp({ authenticate, handlers: [denied], rateLimiter: false });
    const res = await scoped.request("/projects", {
      headers: { authorization: "Bearer xos_live_valid" },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { detail: string }).detail).toMatch(
      /scopes do not include projects/,
    );
  });

  it("refuses keys the exchange refuses and surfaces exchange failures", async () => {
    const { authenticate } = fakeSupabase([ORG_A]);
    await expect(resolve(authenticate, { authorization: "Bearer xos_live_nosa" })).rejects.toThrow(
      /service account/,
    );
    await expect(
      resolve(authenticate, { authorization: "Bearer xos_live_broken" }),
    ).rejects.toThrow(/answered 500/);
  });
});

describe("the Atlas session cookie", () => {
  it("reads plain and chunked cookies and binds the last opened org", async () => {
    const { authenticate } = fakeSupabase([ORG_A, ORG_B]);
    const plain = await resolve(authenticate, {
      cookie: `${sessionCookie(VALID)}; xos-last-org=bravo`,
    });
    expect(plain?.org?.slug).toBe("bravo");
    const chunked = await resolve(authenticate, { cookie: sessionCookie(VALID, true) });
    expect(chunked?.user.id).toBe(USER_ID);
    expect(chunked?.org).toBeNull();
  });

  it("ignores an unprefixed session cookie on an https site (A22-014 cookie tossing)", async () => {
    const { authenticate } = fakeSupabase([ORG_A]);
    const tossed = sessionCookie(VALID).replace("__Host-xos-auth=", "xos-auth=");
    expect(await resolve(authenticate, { cookie: tossed })).toBeNull();
  });

  it("refuses the cookie on a cross-site state-changing request", async () => {
    const { authenticate } = fakeSupabase([ORG_A]);
    await expect(
      resolve(authenticate, { cookie: sessionCookie(VALID), origin: "https://evil.test" }, "POST"),
    ).rejects.toThrow(/cross-site/);
    await expect(resolve(authenticate, { cookie: sessionCookie(VALID) }, "POST")).rejects.toThrow(
      /cross-site/,
    );
    const same = await resolve(
      authenticate,
      { cookie: sessionCookie(VALID), origin: "https://atlas.test" },
      "POST",
    );
    expect(same?.org?.id).toBe(ORG_A.id);
  });

  it("answers 401 through the runtime when the credential is refused", async () => {
    const { authenticate } = fakeSupabase([ORG_A]);
    const app = createApiApp({ authenticate });
    const res = await app.request("/canon/departments", {
      headers: { authorization: "Bearer xos_live_abcdef" },
    });
    expect(res.status).toBe(401);
  });
});

describe("helpers", () => {
  it("parses cookies and tolerates malformed escapes", () => {
    const cookies = parseCookies("a=1; b=%E0%A4%A; =x; c");
    expect(cookies.get("a")).toBe("1");
    expect(cookies.get("b")).toBe("%E0%A4%A");
    expect(parseCookies(null).size).toBe(0);
  });

  it("names the session cookie with __Host- only over https", () => {
    expect(sessionCookieName("https://atlas.test")).toBe("__Host-xos-auth");
    expect(sessionCookieName("http://localhost:3000")).toBe("xos-auth");
  });

  it("rejects a session cookie without a token", () => {
    expect(sessionTokenFromCookies(new Map([["xos-auth", "{}"]]), "xos-auth")).toBeNull();
    expect(sessionTokenFromCookies(new Map([["xos-auth", "not json"]]), "xos-auth")).toBeNull();
    expect(
      sessionTokenFromCookies(new Map([["xos-auth", '{"access_token":"t"}']]), "xos-auth"),
    ).toBe("t");
  });

  it("reads JWT claims defensively", () => {
    expect(jwtClaims("x")).toEqual({});
    expect(jwtClaims("a.bm90IGpzb24.c")).toEqual({});
    expect(jwtClaims(jwt({ org_id: "o" }))["org_id"]).toBe("o");
  });

  it("negotiates the locale", () => {
    const supported = ["en-US", "es-US"];
    expect(negotiateLocale(null, supported)).toBe("en-US");
    expect(negotiateLocale("fr-FR, es;q=0.8", supported)).toBe("es-US");
    expect(negotiateLocale("fr", supported)).toBe("en-US");
    expect(negotiateLocale("*", supported)).toBe("en-US");
    expect(negotiateLocale("es-us", supported)).toBe("es-US");
  });
});

describe("API key tokens presented as bearer JWTs", () => {
  it("keeps the key's scope limit on a minted token", () => {
    expect(
      apiKeyTokenScopes({ amr: [{ method: "xos_api_key", timestamp: 1 }], scopes: ["canon"] }),
    ).toEqual(["canon"]);
  });

  it("gives a minted token without a scopes claim no scopes", () => {
    expect(apiKeyTokenScopes({ amr: [{ method: "xos_api_key", timestamp: 1 }] })).toEqual([]);
  });

  it("leaves an ordinary session unscoped", () => {
    expect(apiKeyTokenScopes({ amr: [{ method: "password", timestamp: 1 }] })).toBeNull();
    expect(apiKeyTokenScopes({})).toBeNull();
  });
});
