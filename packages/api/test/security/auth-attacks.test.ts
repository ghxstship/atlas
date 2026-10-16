/**
 * A22 security review (RRR-41): credential, idempotency and rate limit attacks against the API
 * runtime, with no network. Each test names the ASVS 5.0 requirement it evidences.
 */
import { describe, expect, it } from "vitest";
import { ApiProblem } from "../../src/problem.ts";
import { apiKeyTokenScopes, createSupabaseAuthenticator } from "../../src/runtime/auth.ts";
import { requestHash } from "../../src/runtime/idempotency.ts";
import { createWindowRateLimiter, enforce } from "../../src/runtime/rate-limit.ts";

const SITE = "https://atlas.example.com";

function noNetwork(): never {
  throw new Error("the attack must be refused before any network call");
}

const authenticate = createSupabaseAuthenticator({
  url: "https://project.example.com",
  anonKey: "anon",
  siteOrigin: SITE,
  fetch: noNetwork as unknown as typeof fetch,
});

function cookieRequest(method: string, origin: string | null): Request {
  const session = encodeURIComponent(JSON.stringify({ access_token: "header.payload.signature" }));
  const headers: Record<string, string> = { cookie: `xos-auth=${session}` };
  if (origin !== null) headers["origin"] = origin;
  return new Request(`${SITE}/api/v1/projects`, { method, headers });
}

async function problemOf(promise: Promise<unknown>): Promise<ApiProblem> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiProblem) return error;
    throw error;
  }
  throw new Error("expected a problem response");
}

describe("A22 credential attacks", () => {
  it("refuses a cross-site POST that rides the Atlas session cookie (V3.5.1)", async () => {
    const problem = await problemOf(
      authenticate(cookieRequest("POST", "https://evil.example"), "r1"),
    );
    expect(problem.body.status).toBe(401);
  });

  it("refuses a cookie POST with no Origin header at all (V3.5.1)", async () => {
    const problem = await problemOf(authenticate(cookieRequest("DELETE", null), "r2"));
    expect(problem.body.status).toBe(401);
  });

  it("refuses an Authorization header that is not a bearer token (V8.3.1)", async () => {
    const request = new Request(`${SITE}/api/v1/projects`, {
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    const problem = await problemOf(authenticate(request, "r3"));
    expect(problem.body.status).toBe(401);
  });

  it("limits a minted API key token to its scopes, and to none when the claim is missing (V8.2.1)", () => {
    const amr = [{ method: "xos_api_key", timestamp: 0 }];
    expect(apiKeyTokenScopes({ amr, scopes: ["crew"] })).toEqual(["crew"]);
    expect(apiKeyTokenScopes({ amr })).toEqual([]);
    expect(apiKeyTokenScopes({ amr, scopes: [1, "crew", null] })).toEqual(["crew"]);
    expect(apiKeyTokenScopes({ amr: [{ method: "password" }] })).toBeNull();
  });
});

describe("A22 idempotency and rate limit attacks", () => {
  it("never lets one member replay another member's response with the same key (V8.2.2)", () => {
    const body = { name: "Load-In", budget: 100 };
    const mine = requestHash("user-a", "post", "/projects", body);
    expect(requestHash("user-b", "post", "/projects", body).equals(mine)).toBe(false);
    expect(
      requestHash("user-a", "post", "/projects", { budget: 100, name: "Load-In" }).equals(mine),
    ).toBe(true);
    expect(requestHash("user-a", "post", "/records", body).equals(mine)).toBe(false);
  });

  it("answers 429 with Retry-After once a caller passes the limit (V2.4.1)", async () => {
    const limiter = createWindowRateLimiter({ limit: 3, windowSeconds: 60, now: () => 0 });
    for (let i = 0; i < 3; i += 1) {
      const decision = await limiter.take("key-1");
      expect(() => enforce(decision)).not.toThrow();
    }
    const over = await limiter.take("key-1");
    let problem: ApiProblem | undefined;
    try {
      enforce(over);
    } catch (error) {
      if (error instanceof ApiProblem) problem = error;
    }
    expect(problem?.body.status).toBe(429);
    expect(problem?.headers["Retry-After"]).toBeDefined();
    const other = await limiter.take("key-2");
    expect(() => enforce(other)).not.toThrow();
  });
});
