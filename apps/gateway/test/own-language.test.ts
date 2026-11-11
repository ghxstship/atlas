import { describe, expect, it, vi } from "vitest";

/**
 * Locale negotiation reads the signed-in person's own language on every page. A person who holds a second factor
 * they have not passed this session is on /auth/mfa then, and getGatewayContext would send that page to itself.
 */
const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect, notFound: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
  headers: async () => new Headers({ "x-gateway-path": "/auth/mfa?next=%2Fhome" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: "u-1", factors: [{ id: "f-1", status: "verified" }] } },
      }),
      // A first-factor session: the token says aal1.
      getSession: async () => ({
        data: { session: { access_token: `x.${btoa(JSON.stringify({ aal: "aal1" }))}.y` } },
      }),
    },
  }),
}));
vi.mock("@xos/data/settings", () => ({
  resolveSettings: async () => ({
    ok: true,
    data: new Map([["locale.language", { source: "Personal", value: "es-US" }]]),
  }),
}));

import { ownLanguage } from "../lib/shell/personal-settings";

describe("ownLanguage", () => {
  it("reads the language of a person who has a second factor still to pass, without a redirect", async () => {
    await expect(ownLanguage()).resolves.toBe("es-US");
    expect(redirect).not.toHaveBeenCalled();
  });
});
