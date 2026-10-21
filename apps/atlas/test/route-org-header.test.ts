/**
 * The proxy names the org a route opens in x-xos-route-org (lib/shell/route-org.ts), so locale negotiation can apply
 * that org's locale.language before the page has its params. A value the browser sends is never passed on: the
 * proxy removes it from every request that names no org.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { ROUTE_ORG_HEADER } from "../lib/shell/route-org";

const SITE = "https://atlas.atlas.test";

describe("the route's org header", () => {
  let proxy: (request: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    process.env["SUPABASE_URL"] = "http://127.0.0.1:1";
    process.env["SUPABASE_ANON_KEY"] = "anon-key-for-proxy-tests-000";
    process.env["ATLAS_SITE_URL"] = SITE;
    ({ proxy } = await import("../proxy"));
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
    expect(res.headers.get(`x-middleware-request-${ROUTE_ORG_HEADER}`)).toBeNull();
    expect(res.headers.get("x-middleware-override-headers") ?? "").not.toContain(ROUTE_ORG_HEADER);
  });
});
