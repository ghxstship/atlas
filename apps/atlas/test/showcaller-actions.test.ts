import type * as Showcaller from "@xos/data/showcaller-links";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B3 (RRR-227, ADR 0142): the showcaller portal's server side. Writes take the token from the portal's route and
 * the device grant only from its HttpOnly cookie, never from the browser's arguments; a malformed token or write
 * never reaches the database; the grant cookie is HttpOnly, SameSite=Lax (so opening the link from an email or a
 * chat keeps the device), scoped to the link's own path and Secure on https; and only a POST opens a link. Cross-site
 * server action posts are refused by Next's Origin check before the action runs; pgTAP 2924 proves the rest.
 */
const TOKEN = `xscl_${"ab".repeat(32)}`;
const GRANT = `xcgr_${"cd".repeat(32)}`;
const CUE = "0192f3a0-0000-7000-8000-000000000001";
const state = vi.hoisted(() => ({
  cookie: null as string | null,
  site: "https://atlas.example.test",
}));
const data = vi.hoisted(() => ({ write: vi.fn(), open: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  env: () => ({ ATLAS_SITE_URL: state.site, SUPABASE_URL: "http://db", SUPABASE_ANON_KEY: "anon" }),
}));
vi.mock("@/lib/live-links/public", () => ({
  PUBLIC_HEADERS: {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "same-origin",
  },
  publicDb: () => ({}),
  visitorAddress: () => "198.51.100.7",
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "xos_showcaller_grant" && state.cookie !== null
        ? { value: state.cookie }
        : undefined,
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/observability", () => ({ observability: { logger: { error: () => undefined } } }));
vi.mock("@xos/data/showcaller-links", async (importOriginal) => ({
  ...(await importOriginal<typeof Showcaller>()),
  showcallerWrite: data.write,
  openShowcallerLink: data.open,
}));

const { portalWriteAction } = await import("@/lib/showcaller/actions");
const { showcallerGrantCookie } = await import("@/lib/showcaller/public");
const route = await import("@/app/share/showcaller/[token]/open/route");

const params = (token: string) => ({ params: Promise.resolve({ token }) }) as never;

describe("portal writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cookie = GRANT;
    data.write.mockResolvedValue({ ok: true, data: { refused: false } });
  });

  it("writes with the route's token and the cookie's grant", async () => {
    expect(await portalWriteAction(TOKEN, { op: "call", cueId: CUE })).toEqual({ ok: true });
    expect(data.write).toHaveBeenCalledWith(
      {},
      {
        token: TOKEN,
        grant: GRANT,
        clientAddress: "198.51.100.7",
        write: { op: "call", cueId: CUE },
      },
    );
  });

  it("never takes a grant from the arguments", async () => {
    state.cookie = null;
    await portalWriteAction(TOKEN, { op: "call", cueId: CUE, grant: "xcgr_attacker" } as never);
    expect(data.write.mock.calls[0]?.[1]).toMatchObject({ grant: "" });
  });

  it("refuses a malformed token or write before the database", async () => {
    expect(await portalWriteAction("xshv_nope", { op: "call", cueId: CUE })).toEqual({
      ok: false,
      reason: "showcaller_link_invalid",
    });
    expect(await portalWriteAction(TOKEN, { op: "call", cueId: "not-a-uuid" })).toEqual({
      ok: false,
      reason: "showcaller_cue_field",
    });
    expect(
      await portalWriteAction(TOKEN, {
        op: "save",
        cueId: CUE,
        expectedUpdatedAt: null,
        fields: { label: "Go", called_at: "2027-01-01T00:00:00Z" } as never,
      }),
    ).toEqual({ ok: false, reason: "showcaller_cue_field" });
    expect(await portalWriteAction(TOKEN, { op: "shift", seconds: 7200 })).toEqual({
      ok: false,
      reason: "showcaller_cue_field",
    });
    expect(data.write).not.toHaveBeenCalled();
  });

  it("reports the database's refusal and an unexpected failure", async () => {
    data.write.mockResolvedValueOnce({
      ok: true,
      data: { refused: true, reason: "showcaller_link_scope" },
    });
    expect(await portalWriteAction(TOKEN, { op: "remove", cueId: CUE })).toEqual({
      ok: false,
      reason: "showcaller_link_scope",
    });
    data.write.mockResolvedValueOnce({ ok: false, error: { kind: "unexpected" } });
    expect(await portalWriteAction(TOKEN, { op: "standby", cueId: null })).toEqual({
      ok: false,
      reason: "unexpected",
    });
  });
});

describe("the grant cookie", () => {
  it("is HttpOnly, SameSite=Lax, path-scoped and Secure on https", () => {
    state.site = "https://atlas.example.test";
    const cookie = showcallerGrantCookie(
      TOKEN,
      GRANT,
      new Date(Date.now() + 3_600_000).toISOString(),
    );
    expect(cookie).toContain(`xos_showcaller_grant=${GRANT}`);
    expect(cookie).toContain(`Path=/share/showcaller/${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toMatch(/Max-Age=3[56]\d\d/);
  });

  it("drops Secure over http, so local runs work", () => {
    state.site = "http://localhost:3000";
    expect(
      showcallerGrantCookie(TOKEN, GRANT, new Date(Date.now() + 60_000).toISOString()),
    ).not.toContain("Secure");
  });
});

describe("the open handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.site = "https://atlas.example.test";
  });

  it("opens only on POST: a GET goes back to the portal", async () => {
    const response = await route.GET(
      new Request(`https://atlas.example.test/share/showcaller/${TOKEN}/open`),
      params(TOKEN),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`/share/showcaller/${TOKEN}`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(data.open).not.toHaveBeenCalled();
  });

  it("sets the grant on a correct code and returns a refusal by reason", async () => {
    data.open.mockResolvedValueOnce({
      ok: true,
      data: {
        refused: false,
        grant: GRANT,
        grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const form = new FormData();
    form.set("accessCode", "042424");
    const opened = await route.POST(
      new Request(`https://atlas.example.test/share/showcaller/${TOKEN}/open`, {
        method: "POST",
        body: form,
      }),
      params(TOKEN),
    );
    expect(opened.headers.get("Set-Cookie")).toContain("xos_showcaller_grant=");
    expect(data.open).toHaveBeenCalledWith(
      {},
      { token: TOKEN, accessCode: "042424", clientAddress: "198.51.100.7" },
    );
    data.open.mockResolvedValueOnce({
      ok: true,
      data: { refused: true, reason: "showcaller_link_devices" },
    });
    const refused = await route.POST(
      new Request(`https://atlas.example.test/share/showcaller/${TOKEN}/open`, {
        method: "POST",
        body: form,
      }),
      params(TOKEN),
    );
    expect(refused.headers.get("Location")).toBe(
      `/share/showcaller/${TOKEN}?reason=showcaller_link_devices`,
    );
    expect(refused.headers.get("Set-Cookie")).toBeNull();
  });

  it("answers 404 for a token of another kind", async () => {
    const response = await route.POST(
      new Request("https://atlas.example.test/share/showcaller/x/open", { method: "POST" }),
      params(`xscr_${"ab".repeat(32)}`),
    );
    expect(response.status).toBe(404);
    expect(data.open).not.toHaveBeenCalled();
  });
});
