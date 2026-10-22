/**
 * The proxy names the org a route opens in x-xos-route-org (lib/shell/route-org.ts), so locale negotiation can apply
 * that org's locale.language before the page has its params. A value the browser sends is never passed on: the
 * proxy replaces it on every page request, prefetches included, and removes it from a route that names no org.
 * The requests the proxy never sees, the /api/ route handlers, never negotiate a locale.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { ROUTE_ORG_HEADER } from "../lib/shell/route-org";

const SITE = "https://atlas.atlas.test";
const forwarded = (res: Response) => res.headers.get(`x-middleware-request-${ROUTE_ORG_HEADER}`);

describe("the route's org header", () => {
  let proxy: (request: NextRequest) => Promise<Response>;
  let config: Parameters<typeof unstable_doesMiddlewareMatch>[0]["config"];

  beforeAll(async () => {
    process.env["SUPABASE_URL"] = "http://127.0.0.1:1";
    process.env["SUPABASE_ANON_KEY"] = "anon-key-for-proxy-tests-000";
    process.env["ATLAS_SITE_URL"] = SITE;
    ({ proxy, config } = await import("../proxy"));
  });

  it("runs on prefetches of a page, and never on the API", () => {
    const page = "/northwind-live/projects";
    expect(unstable_doesMiddlewareMatch({ config, url: page })).toBe(true);
    expect(
      unstable_doesMiddlewareMatch({ config, url: page, headers: { "next-router-prefetch": "1" } }),
    ).toBe(true);
    expect(
      unstable_doesMiddlewareMatch({ config, url: page, headers: { purpose: "prefetch" } }),
    ).toBe(true);
    expect(unstable_doesMiddlewareMatch({ config, url: "/api/v1/projects" })).toBe(false);
  });

  it("names the route's org on a prefetch, over a value the browser sent, and does nothing else", async () => {
    for (const prefetch of [{ "next-router-prefetch": "1" }, { purpose: "prefetch" }]) {
      const res = await proxy(
        new NextRequest(`${SITE}/northwind-live/projects`, {
          headers: { host: "atlas.atlas.test", [ROUTE_ORG_HEADER]: "harbor-lights", ...prefetch },
        }),
      );
      expect(res.status).toBe(200);
      expect(forwarded(res)).toBe("northwind-live");
      // No nonce, session refresh or cookie: a prefetch gets what it got before the proxy ran on it.
      expect(res.headers.get("x-middleware-request-x-nonce")).toBeNull();
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    const outside = await proxy(
      new NextRequest(`${SITE}/auth/sign-in`, {
        headers: {
          host: "atlas.atlas.test",
          [ROUTE_ORG_HEADER]: "harbor-lights",
          "next-router-prefetch": "1",
        },
      }),
    );
    expect(forwarded(outside)).toBeNull();
    expect(outside.headers.get("x-middleware-override-headers") ?? "").not.toContain(
      ROUTE_ORG_HEADER,
    );
  });

  it("is never read by the API route handlers, which the proxy does not see", () => {
    const api = fileURLToPath(new URL("../app/api", import.meta.url));
    const sources = (readdirSync(api, { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => [f, readFileSync(join(api, f), "utf8")] as const);
    expect(sources.length).toBeGreaterThan(0);
    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(/next-intl|@\/i18n|route-org|org-language|ROUTE_ORG_HEADER/);
    }
  });

  it("drops a value the browser sent on a route that names no org", async () => {
    const res = await proxy(
      new NextRequest(`${SITE}/auth/sign-in`, {
        headers: { host: "atlas.atlas.test", [ROUTE_ORG_HEADER]: "harbor-lights" },
      }),
    );
    expect(res.status).toBe(200);
    // Next passes the request headers it forwards as x-middleware-request-* and lists them.
    expect(res.headers.get("x-middleware-request-x-nonce")).not.toBeNull();
    expect(forwarded(res)).toBeNull();
    expect(res.headers.get("x-middleware-override-headers") ?? "").not.toContain(ROUTE_ORG_HEADER);
  });
});
