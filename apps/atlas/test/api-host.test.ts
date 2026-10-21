/**
 * The API host (RRR-119, lib/api-host.ts): with XOS_API_HOST set, the proxy answers that host as
 * the public API before any page work. `/v1/*` is rewritten to the API route, `/` describes the API,
 * everything else is a 404 problem, and no session is read and no cookie is set there.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiHostResponse, isApiHost } from "../lib/api-host";
import { docsUrl } from "../lib/docs-site";

const API_HOST = "api.atlas.test";

const config = {
  ATLAS_SITE_URL: "https://atlas.atlas.test",
  DOCS_SITE_URL: "https://docs.atlas.test/",
  XOS_API_HOST: API_HOST,
};

function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  const headers = { host: API_HOST, ...init.headers };
  return new NextRequest(`https://${headers.host}${path}`, {
    method: init.method ?? "GET",
    headers,
  });
}

describe("matching the API host", () => {
  it("compares the host name without case or port", () => {
    expect(isApiHost("API.atlas.test:443", config)).toBe(true);
    expect(isApiHost("api.atlas.test", config)).toBe(true);
    expect(isApiHost("atlas.atlas.test", config)).toBe(false);
    expect(isApiHost("api.atlas.test.evil.test", config)).toBe(false);
    expect(isApiHost(null, config)).toBe(false);
    expect(isApiHost("api.atlas.test", { XOS_API_HOST: undefined })).toBe(false);
  });

  it("builds docs links only when the docs site is configured", () => {
    expect(docsUrl(config, "/reference")).toBe("https://docs.atlas.test/reference");
    expect(docsUrl({ DOCS_SITE_URL: undefined }, "/reference")).toBeNull();
  });
});

describe("answering the API host", () => {
  it("rewrites /v1 paths to the API route, keeping the query", () => {
    const res = apiHostResponse(request("/v1/canon/departments?limit=2"), config);
    expect(res.headers.get("x-middleware-rewrite")).toBe(
      `https://${API_HOST}/api/v1/canon/departments?limit=2`,
    );
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("describes the API at / and /v1", async () => {
    for (const path of ["/", "/v1"]) {
      const res = apiHostResponse(request(path), config);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
      expect(await res.json()).toEqual({
        name: "XOS Public API",
        versions: {
          v1: {
            base_url: `https://${API_HOST}/v1`,
            openapi: `https://${API_HOST}/v1/openapi.json`,
          },
        },
        docs: "https://docs.atlas.test/reference",
      });
    }
    const bare = apiHostResponse(request("/"), { ...config, DOCS_SITE_URL: undefined });
    expect(await bare.json()).not.toHaveProperty("docs");
  });

  it("answers every page path, and writes to /, with a 404 problem", async () => {
    for (const [path, method] of [
      ["/auth/sign-in", "GET"],
      ["/demo-productions/home", "GET"],
      ["/v2/projects", "GET"],
      ["/", "POST"],
    ] as const) {
      const res = apiHostResponse(request(path, { method }), config);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await res.json()).toMatchObject({ type: "/problems/not-found", instance: path });
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });
});

describe("the proxy on each host", () => {
  const fetchSpy = vi.fn(async () => {
    throw new Error("The proxy must not call Supabase on the API host.");
  });
  let proxy: (request: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    process.env["SUPABASE_URL"] = "http://127.0.0.1:1";
    process.env["SUPABASE_ANON_KEY"] = "anon-key-for-proxy-tests-000";
    process.env["ATLAS_SITE_URL"] = config.ATLAS_SITE_URL;
    process.env["XOS_API_HOST"] = API_HOST;
    ({ proxy } = await import("../proxy"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockClear();
  });

  it("serves the API host without reading the session or setting a cookie", async () => {
    vi.stubGlobal("fetch", fetchSpy);
    const page = await proxy(
      request("/auth/sign-in", { headers: { cookie: "__Host-xos-auth=base64-e30" } }),
    );
    expect(page.status).toBe(404);
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(page.headers.get("content-security-policy")).toBeNull();
    // A server-to-server write sends no Origin; the page CSRF check would refuse it, the API host
    // hands it to the API, whose own credential checks apply as on the Atlas host.
    const write = await proxy(request("/v1/projects", { method: "POST" }));
    expect(write.status).toBe(200);
    expect(write.headers.get("x-middleware-rewrite")).toBe(`https://${API_HOST}/api/v1/projects`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the Atlas host's page checks", async () => {
    const res = await proxy(
      request("/auth/sign-in", {
        method: "POST",
        headers: { host: "atlas.atlas.test", origin: "https://evil.test" },
      }),
    );
    expect(res.status).toBe(403);
  });
});
