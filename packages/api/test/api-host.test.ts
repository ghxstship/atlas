/**
 * The API host (RRR-119): Atlas serves the API at `/api/v1` on its own host and at `/v1` on the
 * API host. A request keeps its original path after the proxy rewrites it, so the runtime strips
 * whichever mount prefix the path starts with, and the caller's rate limit window is the same
 * whichever host the request arrived on.
 */
import { describe, expect, it } from "vitest";
import type { XosClient } from "@xos/data";
import { createApiApp, stripBasePath } from "../src/app.ts";
import type { RequestContext } from "../src/runtime/context.ts";
import { defineHandlers, ok } from "../src/runtime/handler.ts";
import { createWindowRateLimiter } from "../src/runtime/rate-limit.ts";

const BASES = ["/api/v1", "/v1"] as const;
const ATLAS = "https://atlas.test";
const API = "https://api.atlas.test";

const PROJECT = {
  id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
  updated_at: "2026-10-14T12:00:00.123456+00:00",
};

function context(): RequestContext {
  return {
    user: { id: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f", email: null },
    personId: "0192f1e2-7c3a-7b4d-9e8f-00000000000a",
    org: { id: "0192f1e2-7c3a-7b4d-9e8f-000000000001", slug: "demo" },
    locale: "en-US",
    db: {} as XosClient,
    credential: "session",
    requestId: "req-1",
  };
}

describe("mount prefixes", () => {
  it("strips the first prefix a path starts with, and only that one", () => {
    expect(stripBasePath("/api/v1/projects", BASES)).toBe("/projects");
    expect(stripBasePath("/v1/projects", BASES)).toBe("/projects");
    expect(stripBasePath("/api/v1", BASES)).toBe("/");
    expect(stripBasePath("/v1", BASES)).toBe("/");
    expect(stripBasePath("/api/v1/v1/projects", BASES)).toBe("/v1/projects");
    expect(stripBasePath("/v10/projects", BASES)).toBe("/v10/projects");
    expect(stripBasePath("/projects", BASES)).toBe("/projects");
  });

  it("serves each operation under every prefix and names the path the caller used", async () => {
    const app = createApiApp({
      authenticate: async () => null,
      basePath: [...BASES],
      rateLimiter: false,
    });
    for (const url of [
      `${ATLAS}/api/v1/canon/departments`,
      `${API}/v1/canon/departments`,
      `${API}/api/v1/canon/departments`,
    ]) {
      const res = await app.request(url);
      expect(res.status, url).toBe(401);
      expect(((await res.json()) as { instance: string }).instance).toBe(new URL(url).pathname);
    }
    const other = await app.request(`${API}/v2/canon/departments`);
    expect(other.status).toBe(404);
    expect(((await other.json()) as { type: string }).type).toBe("/problems/not-found");
  });

  it("keeps a single string prefix working as before", async () => {
    const app = createApiApp({
      authenticate: async () => null,
      basePath: "/api/v1/",
      rateLimiter: false,
    });
    expect((await app.request(`${ATLAS}/api/v1/canon/departments`)).status).toBe(401);
    expect((await app.request(`${API}/v1/canon/departments`)).status).toBe(404);
  });
});

describe("rate limits across hosts", () => {
  it("counts a caller's requests in one window whichever host they use", async () => {
    const app = createApiApp({
      authenticate: async () => context(),
      basePath: [...BASES],
      handlers: [defineHandlers("Projects", { "projects.get": async () => ok(PROJECT as never) })],
      rateLimiter: createWindowRateLimiter({ limit: 2, windowSeconds: 60, now: () => 0 }),
    });
    const first = await app.request(`${ATLAS}/api/v1/projects/${PROJECT.id}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("ratelimit-remaining")).toBe("1");
    const second = await app.request(`${API}/v1/projects/${PROJECT.id}`);
    expect(second.status).toBe(200);
    expect(second.headers.get("ratelimit-remaining")).toBe("0");
    const third = await app.request(`${API}/v1/projects/${PROJECT.id}`);
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
  });
});
