/**
 * Cross-cutting conventions (ADR 0003, ADR 0007): ETag and If-Match, Idempotency-Key, rate
 * limits, masked Restricted fields, the filter grammar, sort and keyset pagination.
 */
import { describe, expect, it } from "vitest";
import type { XosClient } from "@xos/data";
import { createApiApp } from "../src/app.ts";
import { ApiProblem } from "../src/problem.ts";
import type { RequestContext } from "../src/runtime/context.ts";
import { assertIfMatch, etagOf, ifMatchMatches, versionFromIfMatch } from "../src/runtime/etag.ts";
import { created, defineHandlers, ok } from "../src/runtime/handler.ts";
import {
  canonicalJson,
  databaseIdempotencyStore,
  requestHash,
} from "../src/runtime/idempotency.ts";
import type { BeginOutcome, IdempotencyStore, StoredResponse } from "../src/runtime/idempotency.ts";
import { applyFilter, keysetFilter, listPage, literal, orderFor } from "../src/runtime/listing.ts";
import { isMasked, maskRestricted, masked } from "../src/runtime/masking.ts";
import { encodeCursor } from "../src/runtime/pagination.ts";
import { createWindowRateLimiter, enforce, rateLimitHeaders } from "../src/runtime/rate-limit.ts";

const ORG = { id: "0192f1e2-7c3a-7b4d-9e8f-000000000001", slug: "demo" };

function contextWith(db: unknown, org: typeof ORG | null = ORG): RequestContext {
  return {
    user: { id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f", email: null },
    personId: "0192f1e2-7c3a-7b4d-9e8f-00000000000a",
    org,
    locale: "en-US",
    db: db as XosClient,
    credential: "session",
    requestId: "req-1",
  };
}

const PROJECT = {
  id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
  updated_at: "2026-10-14T12:00:00.123456+00:00",
};

describe("ETag and If-Match", () => {
  it("encodes updated_at so an update can compare and set", () => {
    const tag = etagOf(PROJECT);
    expect(tag).toMatch(/^W\/"/);
    expect(versionFromIfMatch(tag)).toBe(PROJECT.updated_at);
    expect(versionFromIfMatch(tag.slice(2))).toBe(PROJECT.updated_at);
    expect(versionFromIfMatch("*")).toBeNull();
  });

  it("hashes rows without updated_at and refuses foreign tags", () => {
    const tag = etagOf({ dept_code: "4000" });
    expect(tag).toBe(etagOf({ dept_code: "4000" }));
    expect(tag).not.toBe(etagOf({ dept_code: "5000" }));
    expect(() => versionFromIfMatch(tag)).toThrow(ApiProblem);
    expect(() => versionFromIfMatch("nonsense")).toThrow(ApiProblem);
    expect(() =>
      versionFromIfMatch(`W/"${Buffer.from("not a date").toString("base64url")}"`),
    ).toThrow(ApiProblem);
  });

  it("matches a list of tags and *", () => {
    const tag = etagOf(PROJECT);
    expect(ifMatchMatches(`"x", ${tag}`, PROJECT)).toBe(true);
    expect(ifMatchMatches("*", PROJECT)).toBe(true);
    expect(ifMatchMatches('"x"', PROJECT)).toBe(false);
    expect(() => assertIfMatch('"x"', PROJECT)).toThrow(/changed since you read it/);
  });
});

function memoryStore() {
  const rows = new Map<string, { hash: string; response?: StoredResponse }>();
  const store: IdempotencyStore = {
    async begin(_c, key, hash): Promise<BeginOutcome> {
      const row = rows.get(key);
      if (row === undefined) {
        rows.set(key, { hash: hash.toString("hex") });
        return { outcome: "proceed" };
      }
      if (row.hash !== hash.toString("hex")) return { outcome: "mismatch" };
      if (row.response === undefined) return { outcome: "in_progress" };
      return { outcome: "replay", response: row.response };
    },
    async complete(_c, key, response) {
      const row = rows.get(key);
      if (row !== undefined) row.response = response;
    },
    async abandon(_c, key) {
      rows.delete(key);
    },
  };
  return { store, rows };
}

describe("Idempotency-Key", () => {
  const post = (key: string, body: unknown, user = "u1") =>
    new Request("http://x/projects", {
      method: "POST",
      headers: {
        authorization: `Bearer ${user}`,
        "idempotency-key": key,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  function api(store: IdempotencyStore, fail = { value: false }) {
    let calls = 0;
    const handlers = defineHandlers("Projects", {
      "projects.create": async () => {
        calls += 1;
        if (fail.value) throw new Error("database unavailable");
        return created({ ...PROJECT, n: calls } as never);
      },
    });
    const app = createApiApp({
      authenticate: async (r) => ({
        ...contextWith({}),
        user: { id: r.headers.get("authorization") ?? "", email: null },
      }),
      handlers: [handlers],
      idempotency: store,
      rateLimiter: false,
      onError: () => undefined,
    });
    return { app, calls: () => calls };
  }

  const body = { name: "Load-In", project_key: "LDI", time_zone: "America/New_York" };

  it("replays the original response for the same key and body", async () => {
    const { store } = memoryStore();
    const { app, calls } = api(store);
    const first = await app.request(post("key-00001", body));
    const second = await app.request(post("key-00001", { ...body }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
    expect(calls()).toBe(1);
  });

  it("answers 409 for a different body, another caller or a running request", async () => {
    const { store, rows } = memoryStore();
    const { app } = api(store);
    await app.request(post("key-00002", body));
    const changed = await app.request(post("key-00002", { ...body, name: "Other" }));
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as { detail: string }).detail).toMatch(/different request/);
    const otherUser = await app.request(post("key-00002", body, "u2"));
    expect(otherUser.status).toBe(409);
    rows.set("key-00003", {
      hash: requestHash("Bearer u1", "post", "/projects", body).toString("hex"),
    });
    const running = await app.request(post("key-00003", body));
    expect(running.status).toBe(409);
    expect(((await running.json()) as { detail: string }).detail).toMatch(/still running/);
  });

  it("releases the key when the request fails", async () => {
    const { store, rows } = memoryStore();
    const fail = { value: true };
    const { app } = api(store, fail);
    expect((await app.request(post("key-00004", body))).status).toBe(500);
    expect(rows.has("key-00004")).toBe(false);
    fail.value = false;
    expect((await app.request(post("key-00004", body))).status).toBe(201);
  });

  it("hashes canonically", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}');
    expect(canonicalJson(undefined)).toBe("null");
    expect(requestHash("u", "post", "/p", { a: 1, b: 2 })).toEqual(
      requestHash("u", "POST", "/p", { b: 2, a: 1 }),
    );
  });

  it("calls A18's ledger RPCs as the caller", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const answers: Record<string, unknown> = {
      begin_idempotent_request: [
        { outcome: "replay", response_status: 201, response_body: { id: 1 } },
      ],
    };
    const db = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push([name, args]);
        return { data: answers[name] ?? null, error: null };
      },
    };
    const ctx = contextWith(db);
    const hash = Buffer.alloc(32, 1);
    expect(await databaseIdempotencyStore.begin(ctx, "key-1", hash)).toEqual({
      outcome: "replay",
      response: { status: 201, body: { id: 1 } },
    });
    expect(calls[0]?.[1]).toEqual({
      p_org_id: ORG.id,
      p_key: "key-1",
      p_request_hash: `\\x${hash.toString("hex")}`,
    });
    for (const outcome of ["proceed", "in_progress", "mismatch"]) {
      answers["begin_idempotent_request"] = [
        { outcome, response_status: null, response_body: null },
      ];
      expect((await databaseIdempotencyStore.begin(ctx, "k", hash)).outcome).toBe(outcome);
    }
    answers["begin_idempotent_request"] = [];
    await expect(databaseIdempotencyStore.begin(ctx, "k", hash)).rejects.toThrow(/returned/);
    await databaseIdempotencyStore.complete(ctx, "key-1", { status: 201, body: { id: 1 } });
    await databaseIdempotencyStore.abandon(ctx, "key-1");
    expect(calls.map(([n]) => n).slice(-2)).toEqual([
      "complete_idempotent_request",
      "abandon_idempotent_request",
    ]);
  });

  it("skips the ledger without an active org and surfaces RPC errors", async () => {
    const failing = {
      rpc: async () => ({
        data: null,
        error: { code: "42501", message: "organization not found" },
      }),
    };
    const none = contextWith(failing, null);
    expect(await databaseIdempotencyStore.begin(none, "k", Buffer.alloc(32))).toEqual({
      outcome: "proceed",
    });
    await databaseIdempotencyStore.complete(none, "k", { status: 201, body: null });
    await databaseIdempotencyStore.abandon(none, "k");
    const some = contextWith(failing);
    await expect(databaseIdempotencyStore.begin(some, "k", Buffer.alloc(32))).rejects.toMatchObject(
      {
        code: "42501",
      },
    );
    await expect(
      databaseIdempotencyStore.complete(some, "k", { status: 201, body: null }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(databaseIdempotencyStore.abandon(some, "k")).rejects.toMatchObject({
      code: "42501",
    });
  });
});

describe("rate limits and ETag headers through the runtime", () => {
  const handlers = defineHandlers("Projects", {
    "projects.get": async () => ok(PROJECT as never),
  });

  it("sends rate limit headers and 429 with Retry-After", async () => {
    let now = 0;
    const app = createApiApp({
      authenticate: async () => contextWith({}),
      handlers: [handlers],
      rateLimiter: createWindowRateLimiter({ limit: 2, windowSeconds: 60, now: () => now }),
    });
    const path = `/projects/${PROJECT.id}`;
    const first = await app.request(path);
    expect(first.headers.get("ratelimit-limit")).toBe("2");
    expect(first.headers.get("ratelimit-remaining")).toBe("1");
    expect(first.headers.get("etag")).toBe(etagOf(PROJECT));
    await app.request(path);
    const limited = await app.request(path);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("ratelimit-remaining")).toBe("0");
    now = 60_000;
    expect((await app.request(path)).status).toBe(200);
  });

  it("evicts the oldest caller window at capacity", () => {
    const limiter = createWindowRateLimiter({ limit: 1, maxCallers: 1, now: () => 0 });
    expect(limiter.take("a")).toMatchObject({ allowed: true });
    expect(limiter.take("b")).toMatchObject({ allowed: true });
    expect(limiter.take("a")).toMatchObject({ allowed: true, remaining: 0 });
    const decision = { limit: 1, remaining: 0, reset: 5, allowed: false };
    expect(rateLimitHeaders(decision)["RateLimit-Reset"]).toBe("5");
    expect(() => enforce(decision)).toThrow(ApiProblem);
  });
});

describe("masked Restricted fields", () => {
  it("masks what the caller may not read and keeps the field present", () => {
    const row = { id: "1", rate_minor: 5000, ssn_last4: "1234" };
    const out = maskRestricted(
      row,
      ["rate_minor", "ssn_last4", "absent"],
      (f) => f === "rate_minor",
      (f) => `data.restricted.read.${f}`,
    );
    expect(out.rate_minor).toBe(5000);
    expect(out.ssn_last4).toEqual(masked("Requires data.restricted.read.ssn_last4."));
    expect("absent" in out).toBe(false);
    expect(isMasked(out.ssn_last4)).toBe(true);
    expect(isMasked({ masked: false })).toBe(false);
  });
});

/** A builder that records PostgREST calls and answers with fixed rows. */
function recorder(rows: Record<string, unknown>[]) {
  const calls: string[] = [];
  const builder: Record<string, unknown> = {};
  for (const name of [
    "eq",
    "neq",
    "lt",
    "lte",
    "gt",
    "gte",
    "in",
    "is",
    "not",
    "ilike",
    "or",
    "order",
    "limit",
    "select",
  ]) {
    builder[name] = (...args: unknown[]) => {
      calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
      return builder;
    };
  }
  builder["then"] = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
  return { builder, calls };
}

describe("list queries", () => {
  it("maps every filter operator to PostgREST", () => {
    const { builder, calls } = recorder([]);
    applyFilter(
      builder,
      {
        a: { eq: "1", ne: "2", lt: "3", lte: "4", gt: "5", gte: "6" },
        b: { in: "x, y", is_null: "true" },
        c: { is_null: "false", contains: "50%_off" },
      },
      ["a", "b", "c"],
    );
    expect(calls).toEqual([
      'eq("a","1")',
      'neq("a","2")',
      'lt("a","3")',
      'lte("a","4")',
      'gt("a","5")',
      'gte("a","6")',
      'in("b",["x","y"])',
      'is("b",null)',
      'not("c","is",null)',
      'ilike("c","%50\\\\%\\\\_off%")',
    ]);
    expect(() => applyFilter(builder, { secret: { eq: "1" } }, ["a"])).toThrow(/not supported/);
    expect(() => applyFilter(builder, { a: { is_null: "maybe" } }, ["a"])).toThrow(/true or false/);
  });

  it("orders by sort or the default, ending with the key", () => {
    expect(orderFor(undefined, ["name", "id"], ["name"], "id")).toEqual([
      { field: "name", ascending: true },
      { field: "id", ascending: true },
    ]);
    expect(orderFor("-name,id,name", ["name", "id"], ["name"], "id")).toEqual([
      { field: "name", ascending: false },
      { field: "id", ascending: true },
    ]);
    expect(() => orderFor("secret", ["name"], ["name"], "id")).toThrow(/not supported/);
  });

  it("builds keyset filters with quoted literals", () => {
    const order = [
      { field: "starts_at", ascending: false },
      { field: "id", ascending: true },
    ];
    expect(keysetFilter(order, { starts_at: "2026-10-14T12:00:00Z", id: "abc" })).toBe(
      'starts_at.lt."2026-10-14T12:00:00Z",and(starts_at.eq."2026-10-14T12:00:00Z",id.gt.abc)',
    );
    expect(literal(null)).toBe("null");
    expect(literal('a "b"')).toBe('"a \\"b\\""');
  });

  it("runs a page with sparse fields, filters and a cursor", async () => {
    const rows = [
      { id: "1", name: "A", created_at: "t1" },
      { id: "2", name: "B", created_at: "t2" },
      { id: "3", name: "C", created_at: "t3" },
    ];
    const { builder, calls } = recorder(rows);
    const page = await listPage<{ id: string; name: string }>(
      builder as never,
      {
        limit: 2,
        fields: "name",
        filter: { name: { contains: "a" } },
        cursor: encodeCursor({ created_at: "t0", id: "0" }),
      },
      { columns: ["id", "name", "created_at"], key: "id", defaultOrder: ["created_at"] },
    );
    expect(calls[0]).toBe('select("id,name,created_at")');
    expect(calls).toContain('or("created_at.gt.t0,and(created_at.eq.t0,id.gt.0)")');
    expect(calls.at(-1)).toBe("limit(3)");
    expect(page.data).toEqual([
      { id: "1", name: "A" },
      { id: "2", name: "B" },
    ]);
    expect(page.next_cursor).toBe(encodeCursor({ created_at: "t2", id: "2" }));
  });

  it("returns every column by default and throws database errors", async () => {
    const { builder } = recorder([{ id: "1", name: "A", created_at: "t1" }]);
    const page = await listPage(
      builder as never,
      {},
      {
        columns: ["id", "name", "created_at"],
        key: "id",
        defaultOrder: ["created_at"],
      },
    );
    expect(page).toEqual({ data: [{ id: "1", name: "A", created_at: "t1" }], next_cursor: null });
    const failing = {
      select: () => failing,
      order: () => failing,
      limit: () => failing,
      then: (resolve: (v: unknown) => void) =>
        resolve({ data: null, error: { code: "42501", message: "denied" } }),
    };
    await expect(
      listPage(failing as never, {}, { columns: ["id"], key: "id", defaultOrder: ["id"] }),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("sparse responses under contract validation", () => {
  it("accepts a sparse page and rejects a malformed one", async () => {
    const good = defineHandlers("Projects", {
      "projects.list": async () => ok({ data: [{ id: PROJECT.id }], next_cursor: null } as never),
      "projects.get": async () => ok({ id: PROJECT.id } as never),
    });
    const app = createApiApp({
      authenticate: async () => contextWith({}),
      handlers: [good],
      validateResponses: true,
      rateLimiter: false,
    });
    expect((await app.request("/projects?fields=id")).status).toBe(200);
    expect((await app.request(`/projects/${PROJECT.id}?fields=id`)).status).toBe(200);
    expect((await app.request(`/projects/${PROJECT.id}`)).status).toBe(500);

    const bad = defineHandlers("Projects", {
      "projects.list": async () => ok({ data: [{ id: 5 }], next_cursor: 3 } as never),
    });
    const strict = createApiApp({
      authenticate: async () => contextWith({}),
      handlers: [bad],
      validateResponses: true,
      rateLimiter: false,
      onError: () => undefined,
    });
    expect((await strict.request("/projects?fields=id")).status).toBe(500);
  });
});
