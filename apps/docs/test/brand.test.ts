/** Docs site white label (A138, ADR 0066): host and path resolution, the brand lookup and the proxy. */
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRAND_COOKIE,
  BRAND_SCRIPT,
  brandAssetUrl,
  decodeBrand,
  docsAccent,
  encodeBrand,
  fetchDocsBrand,
  parseTenantHosts,
  readCookie,
  resolveTenant,
  scopedPath,
  type DocsBrand,
} from "../lib/brand.ts";
import { proxy } from "../proxy.ts";

const HOSTS = parseTenantHosts(
  " docs.northwind-live.com=northwind-live, help.harbor.test:443=HARBOR-LIGHTS ,bad, x=Not A Slug,=x",
);
const SUPABASE = "https://db.xos.test";
const brand: DocsBrand = {
  name: "Northwind",
  logoLightUrl: `${SUPABASE}/storage/v1/object/public/org-brand/org-a/light.png`,
  logoDarkUrl: null,
  accent: "#0B5FFF",
};

describe("parseTenantHosts", () => {
  it("maps each configured host to its org slug, lowercased, and skips malformed pairs", () => {
    expect([...HOSTS]).toEqual([
      ["docs.northwind-live.com", "northwind-live"],
      ["help.harbor.test", "harbor-lights"],
    ]);
    expect(parseTenantHosts(undefined).size).toBe(0);
  });
});

describe("resolveTenant", () => {
  it("serves a mapped host's org on every path, whatever the port or case", () => {
    expect(
      resolveTenant("Docs.Northwind-Live.com:3004", "/en-US/guides/quickstart", HOSTS),
    ).toEqual({
      slug: "northwind-live",
      via: "host",
      rest: "/en-US/guides/quickstart",
      base: "",
    });
  });

  it("serves an org's docs under /o/<slug>/ on any other host", () => {
    expect(resolveTenant("docs.xos.test", "/o/northwind-live/es-US/reference", HOSTS)).toEqual({
      slug: "northwind-live",
      via: "path",
      rest: "/es-US/reference",
      base: "/o/northwind-live",
    });
    expect(resolveTenant(null, "/o/northwind-live", HOSTS)?.rest).toBe("/");
    expect(resolveTenant(null, "/o/northwind-live/", HOSTS)?.rest).toBe("/");
  });

  it("is the platform docs for other paths and for malformed slugs", () => {
    expect(resolveTenant("docs.xos.test", "/en-US/guides/quickstart", HOSTS)).toBeNull();
    expect(resolveTenant("docs.xos.test", "/o/", HOSTS)).toBeNull();
    expect(resolveTenant("docs.xos.test", "/o/Northwind/en-US", HOSTS)).toBeNull();
    expect(resolveTenant("docs.xos.test", "/o/-x-/en-US", HOSTS)).toBeNull();
    expect(resolveTenant("docs.xos.test", `/o/${"a".repeat(49)}/en-US`, HOSTS)).toBeNull();
    expect(resolveTenant("docs.xos.test", "/other/northwind-live", HOSTS)).toBeNull();
  });
});

describe("docsAccent", () => {
  it("keeps an accent that passes every accent pair in every theme, uppercased", () => {
    expect(docsAccent("#0b5fff")).toBe("#0B5FFF");
  });

  it("drops a failing or malformed accent", () => {
    expect(docsAccent("#FFFF00")).toBeNull();
    expect(docsAccent("#000000")).toBeNull();
    expect(docsAccent("blue")).toBeNull();
    expect(docsAccent(null)).toBeNull();
  });
});

describe("fetchDocsBrand", () => {
  it("calls the public RPC with the anon key and maps logos to public bucket URLs", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json([
        {
          name: "Northwind",
          logo_light_path: "org-a/light logo.png",
          logo_dark_path: null,
          accent_hex: "#FFFF00",
        },
      ]);
    }) as unknown as typeof fetch;
    const found = await fetchDocsBrand("northwind-live", {
      supabaseUrl: `${SUPABASE}/`,
      anonKey: "anon-test-key",
      fetch: fake,
    });
    expect(found).toEqual({
      name: "Northwind",
      logoLightUrl: `${SUPABASE}/storage/v1/object/public/org-brand/org-a/light%20logo.png`,
      logoDarkUrl: null,
      accent: null,
    });
    expect(calls[0]?.url).toBe(`${SUPABASE}/rest/v1/rpc/docs_brand_for_slug`);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["content-profile"]).toBe("api_public");
    expect(headers["apikey"]).toBe("anon-test-key");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ p_org_slug: "northwind-live" });
  });

  it("answers null for an org without a docs brand and throws on a failed call", async () => {
    const empty = (async () => Response.json([])) as unknown as typeof fetch;
    await expect(
      fetchDocsBrand("harbor-lights", { supabaseUrl: SUPABASE, anonKey: "k", fetch: empty }),
    ).resolves.toBeNull();
    const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(
      fetchDocsBrand("harbor-lights", { supabaseUrl: SUPABASE, anonKey: "k", fetch: failing }),
    ).rejects.toThrow("500");
    expect(brandAssetUrl(SUPABASE, null)).toBeNull();
  });
});

describe("the brand cookie", () => {
  it("round-trips a brand and its link base", () => {
    expect(decodeBrand(encodeBrand(brand, "/o/northwind-live"))).toEqual({
      ...brand,
      base: "/o/northwind-live",
    });
    expect(decodeBrand(encodeBrand(brand, ""))?.base).toBe("");
  });

  it("refuses anything malformed, and drops unsafe logo URLs and accents", () => {
    expect(decodeBrand(null)).toBeNull();
    expect(decodeBrand("%E0%A4%A")).toBeNull();
    expect(decodeBrand(encodeURIComponent("[1]"))).toBeNull();
    expect(decodeBrand(encodeBrand({ ...brand, name: " " }, ""))).toBeNull();
    expect(decodeBrand(encodeBrand(brand, "https://evil.test"))).toBeNull();
    const unsafe = decodeBrand(
      encodeURIComponent(
        JSON.stringify({
          name: "N",
          logoLightUrl: "javascript:alert(1)",
          accent: "red;x:y",
          base: "",
        }),
      ),
    );
    expect(unsafe).toEqual({
      name: "N",
      logoLightUrl: null,
      logoDarkUrl: null,
      accent: null,
      base: "",
    });
  });

  it("is read from a cookie header by name", () => {
    expect(readCookie(`a=1; ${BRAND_COOKIE}=x%3Dy; b=2`, BRAND_COOKIE)).toBe("x%3Dy");
    expect(readCookie("a=1", BRAND_COOKIE)).toBeNull();
  });

  it("is applied before paint by the head script", () => {
    const style = new Map<string, string>();
    const dataset: Record<string, string> = {};
    const document = {
      cookie: `${BRAND_COOKIE}=${encodeBrand(brand, "/o/northwind-live")}`,
      documentElement: {
        dataset,
        style: { setProperty: (k: string, v: string) => style.set(k, v) },
      },
    };
    new Function("document", BRAND_SCRIPT)(document);
    expect(dataset["docsBrand"]).toBe("org");
    expect(style.get("--color-accent-default")).toBe("#0B5FFF");
  });
});

describe("scopedPath", () => {
  it("keeps docs links inside the org's docs and leaves others alone", () => {
    expect(scopedPath("/en-US/guides/quickstart", "/o/northwind-live")).toBe(
      "/o/northwind-live/en-US/guides/quickstart",
    );
    expect(scopedPath("/o/northwind-live/en-US", "/o/northwind-live")).toBe(
      "/o/northwind-live/en-US",
    );
    expect(scopedPath("/openapi.json", "/o/northwind-live")).toBe("/openapi.json");
    expect(scopedPath("/en-US", "")).toBe("/en-US");
  });
});

describe("proxy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function request(url: string, host?: string) {
    return new NextRequest(url, {
      headers: { "accept-language": "es-US", ...(host ? { host } : {}) },
    });
  }

  function lookup(rows: unknown[]) {
    vi.stubEnv("SUPABASE_URL", SUPABASE);
    vi.stubEnv("SUPABASE_ANON_KEY", "anon-test-key");
    const fetchMock = vi.fn(async () => Response.json(rows));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const northwind = [
    {
      name: "Northwind",
      logo_light_path: "org-a/light.png",
      logo_dark_path: null,
      accent_hex: "#0B5FFF",
    },
  ];

  it("keeps the platform docs as before: a locale redirect, then the page", async () => {
    const fetchMock = lookup(northwind);
    const redirect = await proxy(request("https://docs.xos.test/guides/quickstart"));
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("https://docs.xos.test/es-US/guides/quickstart");
    const page = await proxy(request("https://docs.xos.test/en-US"));
    expect(page.headers.get("x-middleware-next")).toBe("1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves /o/<slug>/… as the docs page, with the brand in a cookie scoped to the org's docs", async () => {
    lookup(northwind);
    const response = await proxy(
      request("https://docs.xos.test/o/northwind-live/en-US/reference?x=1"),
    );
    expect(response.headers.get("x-middleware-rewrite")).toBe(
      "https://docs.xos.test/en-US/reference?x=1",
    );
    const cookie = response.cookies.get(BRAND_COOKIE);
    expect(cookie?.path).toBe("/o/northwind-live");
    expect(cookie?.secure).toBe(true);
    expect(decodeBrand(cookie?.value)).toEqual({
      name: "Northwind",
      logoLightUrl: `${SUPABASE}/storage/v1/object/public/org-brand/org-a/light.png`,
      logoDarkUrl: null,
      accent: "#0B5FFF",
      base: "/o/northwind-live",
    });
  });

  it("redirects an org's docs without a locale to the visitor's locale inside them", async () => {
    lookup(northwind);
    const response = await proxy(request("https://docs.xos.test/o/northwind-live"));
    expect(response.headers.get("location")).toBe("https://docs.xos.test/o/northwind-live/es-US");
  });

  it("serves a mapped host's docs in place, with the brand on the whole host", async () => {
    vi.stubEnv("XOS_DOCS_TENANT_HOSTS", "docs.northwind-live.com=northwind-live");
    const fetchMock = lookup(northwind);
    const response = await proxy(
      request("https://docs.northwind-live.com/en-US", "docs.northwind-live.com"),
    );
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.cookies.get(BRAND_COOKIE)?.path).toBe("/");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ p_org_slug: "northwind-live" });
  });

  it("sends an org without a docs brand to the platform docs, and clears a stale brand on its host", async () => {
    lookup([]);
    const response = await proxy(request("https://docs.xos.test/o/harbor-lights/en-US/reference"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://docs.xos.test/en-US/reference");
    vi.stubEnv("XOS_DOCS_TENANT_HOSTS", "help.harbor.test=harbor-lights");
    const onHost = await proxy(request("https://help.harbor.test/en-US", "help.harbor.test"));
    expect(onHost.headers.get("x-middleware-next")).toBe("1");
    expect(onHost.headers.get("set-cookie")).toContain(`${BRAND_COOKIE}=;`);
  });

  it("falls back to the platform docs when the lookup fails or is not configured", async () => {
    vi.stubEnv("SUPABASE_URL", SUPABASE);
    vi.stubEnv("SUPABASE_ANON_KEY", "anon-test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await proxy(request("https://docs.xos.test/o/northwind-live/en-US"));
    expect(failed.headers.get("location")).toBe("https://docs.xos.test/en-US");
    vi.unstubAllEnvs();
    vi.stubEnv("SUPABASE_URL", "");
    const unconfigured = await proxy(request("https://docs.xos.test/o/northwind-live/en-US"));
    expect(unconfigured.headers.get("location")).toBe("https://docs.xos.test/en-US");
  });
});
