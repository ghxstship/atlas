/**
 * Local JWT verification against the JWKS (A24-010) and the identity cache, against fake Auth and
 * PostgREST endpoints.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createIdentityCache, createSupabaseAuthenticator } from "../src/runtime/auth.ts";
import { createJwksVerifier } from "../src/runtime/jwt.ts";
import { serverTiming } from "../src/runtime/mount.ts";
import type { XosClient } from "@xos/data";

const URL_ = "http://auth.test";
const NOW = 1_800_000_000_000;
const USER_ID = "11111111-1111-4111-8111-111111111111";
const PERSON_ID = "22222222-2222-4222-8222-222222222222";
const ORG = { id: "33333333-3333-4333-8333-333333333333", slug: "alpha", name: "Alpha" };

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "ES256", use: "sig" };

const membership = {
  id: "55555555-5555-4555-8555-555555555555",
  organization: { ...ORG, parent_org_id: null, deleted_at: null },
  membership_roles: [],
};

const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function es256(claims: Record<string, unknown>, kid = "k1"): string {
  const head = part({ alg: "ES256", kid, typ: "JWT" });
  const body = part({
    sub: USER_ID,
    role: "authenticated",
    email: "ada@example.com",
    iss: `${URL_}/auth/v1`,
    exp: NOW / 1000 + 3600,
    ...claims,
  });
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${body}.${signature.toString("base64url")}`;
}

function fakeAuth(options: { jwks?: "ok" | "down" } = {}) {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    calls.push(url.pathname);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/auth/v1/.well-known/jwks.json") {
      return options.jwks === "down" ? json({}, 503) : json({ keys: [jwk] });
    }
    if (url.pathname === "/auth/v1/user") {
      return json({ id: USER_ID, email: "ada@example.com", aud: "authenticated" });
    }
    if (url.pathname === "/rest/v1/people") return json({ id: PERSON_ID, full_name: "Ada" });
    if (url.pathname === "/rest/v1/memberships") {
      return json([membership]);
    }
    void init;
    return json({ message: `unexpected ${url.pathname}` }, 404);
  };
  return { calls, fetcher };
}

const verifier = (fetcher: typeof fetch, now = () => NOW) =>
  createJwksVerifier({ url: URL_, anonKey: "anon", fetch: fetcher, now });

describe("createJwksVerifier", () => {
  it("verifies an ES256 session token and fetches the key set once", async () => {
    const { calls, fetcher } = fakeAuth();
    const verify = verifier(fetcher);
    const claims = await verify(es256({}));
    expect(claims).toMatchObject({ sub: USER_ID, email: "ada@example.com" });
    await verify(es256({}));
    await Promise.all([verify(es256({})), verify(es256({}))]);
    expect(calls.filter((c) => c.endsWith("jwks.json"))).toHaveLength(1);
  });

  it("refuses a forged, expired, anonymous or malformed token", async () => {
    const verify = verifier(fakeAuth().fetcher);
    const token = es256({});
    const [h, , s] = token.split(".");
    expect(await verify(`${h}.${part({ sub: "someone-else", exp: NOW / 1000 + 60 })}.${s}`)).toBe(
      null,
    );
    expect(await verify(es256({ exp: NOW / 1000 - 120 }))).toBe(null);
    expect(await verify(es256({ nbf: NOW / 1000 + 600 }))).toBe(null);
    expect(await verify(es256({ role: "anon" }))).toBe(null);
    expect(await verify(es256({ sub: "" }))).toBe(null);
    expect(await verify("not-a-jwt")).toBe(null);
  });

  it("leaves to Auth what it cannot judge: HS256, an unknown key, another issuer", async () => {
    const { calls, fetcher } = fakeAuth();
    const verify = verifier(fetcher);
    const hs = `${part({ alg: "HS256" })}.${part({ sub: USER_ID })}.sig`;
    expect(await verify(hs)).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(await verify(es256({ iss: "https://elsewhere/auth/v1" }))).toBeUndefined();
    let clock = NOW;
    const later = verifier(fetcher, () => clock);
    await later(es256({}));
    clock += 10_000;
    expect(await later(es256({}, "rotated"))).toBeUndefined();
    // One refetch for the unknown key id, then the cached set again.
    expect(calls.filter((c) => c.endsWith("jwks.json"))).toHaveLength(3);
  });

  it("reports a key set outage and defers to Auth, retrying after 30 seconds", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { calls, fetcher } = fakeAuth({ jwks: "down" });
    let clock = NOW;
    const verify = verifier(fetcher, () => clock);
    expect(await verify(es256({}))).toBeUndefined();
    expect(await verify(es256({}))).toBeUndefined();
    expect(calls.filter((c) => c.endsWith("jwks.json"))).toHaveLength(1);
    clock += 31_000;
    await verify(es256({}));
    expect(calls.filter((c) => c.endsWith("jwks.json"))).toHaveLength(2);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("the authenticator with local verification", () => {
  it("never calls Auth for a token the key set verifies, and reuses the identity", async () => {
    const { calls, fetcher } = fakeAuth();
    const authenticate = createSupabaseAuthenticator({
      url: URL_,
      anonKey: "anon",
      siteOrigin: "http://atlas.test",
      fetch: fetcher,
      now: () => NOW,
    });
    const request = () =>
      new Request("http://atlas.test/api/v1/me", {
        headers: { authorization: `Bearer ${es256({})}` },
      });
    const first = await authenticate(request(), "r1");
    expect(first).toMatchObject({
      user: { id: USER_ID, email: "ada@example.com" },
      personId: PERSON_ID,
      org: { id: ORG.id, slug: ORG.slug },
    });
    await authenticate(request(), "r2");
    expect(calls).not.toContain("/auth/v1/user");
    expect(calls.filter((c) => c === "/rest/v1/people")).toHaveLength(1);
    expect(calls.filter((c) => c === "/rest/v1/memberships")).toHaveLength(1);
  });
});

describe("createIdentityCache", () => {
  const db = (person: unknown, orgs: unknown[]) => {
    const reads = { people: 0, memberships: 0 };
    const query = (table: "people" | "memberships") => {
      reads[table] += 1;
      const result =
        table === "people" ? { data: person, error: null } : { data: orgs, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "is", "in", "limit", "lte", "or"]) {
        builder[m] = () => builder;
      }
      builder["maybeSingle"] = async () => result;
      builder["single"] = async () => result;
      builder["then"] = (resolve: (v: unknown) => unknown) => resolve(result);
      return builder;
    };
    return { client: { from: query } as unknown as XosClient, reads };
  };

  it("reuses an identity until it expires", async () => {
    let clock = 0;
    const cache = createIdentityCache(30_000, () => clock);
    const { client, reads } = db({ id: PERSON_ID, full_name: "Ada" }, [membership]);
    expect(await cache(client, USER_ID)).toMatchObject({ personId: PERSON_ID });
    await cache(client, USER_ID);
    expect(reads.people).toBe(1);
    clock = 31_000;
    await cache(client, USER_ID);
    expect(reads.people).toBe(2);
  });

  it("never caches a missing person, and caches nothing with a zero TTL", async () => {
    const missing = createIdentityCache(30_000);
    const empty = db(null, []);
    expect(await missing(empty.client, USER_ID)).toBe(null);
    await missing(empty.client, USER_ID);
    expect(empty.reads.people).toBe(2);
    const off = createIdentityCache(0);
    const full = db({ id: PERSON_ID, full_name: "Ada" }, []);
    await off(full.client, USER_ID);
    await off(full.client, USER_ID);
    expect(full.reads.people).toBe(2);
  });
});

describe("serverTiming", () => {
  it("names each phase with its duration, including one that throws", async () => {
    let clock = 0;
    const timing = serverTiming(() => clock);
    await timing.measure("auth", () => {
      clock += 4.25;
      return null;
    });
    await expect(
      timing.measure("handler", async () => {
        clock += 10;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(timing.header()).toBe("auth;dur=4.3, handler;dur=10.0");
  });
});
