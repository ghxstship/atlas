import type * as Data from "@xos/data";
import type * as AuthAssurance from "@xos/data/auth-assurance";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The org idle timeout on a one-tap email link (A127, ADR 0106), through the real cookie path. The proxy runs on
 * /auth/act/{token} and records the last-seen cookie as now before the confirm page or its button runs, so the gate
 * would always see a fresh device. The proxy forwards the previous request in x-xos-previous-seen, and the gate
 * judges that. This drives the real proxy, then the real gate and membership resolver over the headers it forwarded,
 * with only the org's settings faked: a member idle for three hours under a 15-minute timeout signs in again.
 */

const SITE = "https://atlas.atlas.test";
const TOKEN = `xact_${"a".repeat(48)}.${"b".repeat(32)}`;
const IDLE_MS = 3 * 60 * 60_000;

const forwarded = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("next/headers", () => ({ headers: async () => forwarded.headers }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@xos/data", async (importOriginal) => ({
  ...(await importOriginal<typeof Data>()),
  getMyOrganization: async () => ({
    ok: true,
    data: { id: "o1", slug: "acme", name: "Acme Live", membershipId: "m1", roles: [], bestBand: 4 },
  }),
  listRoleCapabilities: async () => ({ ok: true, data: new Map() }),
  isPartnerOrganization: async () => ({ ok: true, data: false }),
}));
vi.mock("@xos/data/access-controls", () => ({
  networkAccess: async () => ({ ok: true, data: { allowed: true } }),
}));
vi.mock("@xos/data/auth-assurance", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthAssurance>()),
  // security.idle_timeout_minutes = 15 (migration 1330), signed in long ago; orgAuthDecision stays real.
  getOrgAuthStatus: async () => ({
    ok: true,
    data: {
      mfaRequired: false,
      mfaVerified: false,
      signedInAt: "2026-01-01T00:00:00Z",
      sessionHours: null,
      sessionExpiresAt: null,
      sessionExpired: false,
      idleTimeoutMinutes: 15,
      sessionEnded: false,
    },
  }),
}));
vi.mock("@xos/data/developer", () => ({
  orgAllowsPersonalTokens: async () => ({ ok: true, data: false }),
}));
vi.mock("@xos/data/settings", () => ({
  listDisabledModules: async () => ({ ok: true, data: [] }),
  getPersona: async () => ({ ok: true, data: null }),
}));

/** The request headers Next passes on from a proxy response (x-middleware-request-*). */
function forwardedFrom(response: Response): Headers {
  const headers = new Headers();
  const prefix = "x-middleware-request-";
  for (const [name, value] of response.headers) {
    if (name.startsWith(prefix)) headers.set(name.slice(prefix.length), value);
  }
  return headers;
}

describe("a one-tap link judges the org idle timeout by the device's previous request (A127)", () => {
  let proxy: (request: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    process.env["SUPABASE_URL"] = "http://127.0.0.1:1";
    process.env["SUPABASE_ANON_KEY"] = "anon-key-for-proxy-tests-000";
    process.env["ATLAS_SITE_URL"] = SITE;
    ({ proxy } = await import("../proxy"));
  });

  async function openLink(lastSeenAt: number, sent?: string): Promise<Headers> {
    const response = await proxy(
      new NextRequest(`${SITE}/auth/act/${TOKEN}`, {
        headers: {
          host: "atlas.atlas.test",
          cookie: `xos-last-seen=${lastSeenAt}`,
          ...(sent === undefined ? {} : { "x-xos-previous-seen": sent }),
        },
      }),
    );
    return forwardedFrom(response);
  }

  it("forwards the previous request, never a value the browser sent, with the cookie already recorded", async () => {
    const before = Date.now() - IDLE_MS;
    const headers = await openLink(before, String(Date.now()));
    expect(headers.get("x-xos-previous-seen")).toBe(String(before));
    const cookie = /xos-last-seen=(\d+)/.exec(headers.get("cookie") ?? "");
    expect(Number(cookie?.[1])).toBeGreaterThan(before);
  });

  it("sends a member idle past the timeout to sign in again, which the recorded cookie alone would let through", async () => {
    forwarded.headers = await openLink(Date.now() - IDLE_MS);
    const { resolveMembership } = await import("../lib/shell/membership");
    // What the gate saw before it read the forwarded value: the cookie the proxy had just set to now.
    await expect(
      resolveMembership({} as never, "p1", "acme", forwarded.headers),
    ).resolves.not.toBeNull();

    const { actionLinkGate, enforceActionLinkGate } = await import("../lib/auth/action-link-gate");
    const viewer = { db: {}, person: { id: "p1" }, secondFactorOwed: false } as never;
    await expect(actionLinkGate(viewer, "acme")).resolves.toEqual({
      kind: "owed",
      decision: "idle",
    });
    await expect(enforceActionLinkGate(viewer, "acme", TOKEN)).rejects.toThrow(
      "redirect:/auth/session-ended?org=acme&reason=idle",
    );
  });

  it("lets a member through inside the timeout", async () => {
    forwarded.headers = await openLink(Date.now() - 5 * 60_000);
    const { actionLinkGate } = await import("../lib/auth/action-link-gate");
    const viewer = { db: {}, person: { id: "p1" }, secondFactorOwed: false } as never;
    await expect(actionLinkGate(viewer, "acme")).resolves.toEqual({ kind: "member" });
  });
});
