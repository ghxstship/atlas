import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B10: a right code goes in an httpOnly, Lax cookie scoped to the link's path, for the shorter of 12 hours and the link's
 * life, and Secure whenever Gateway is served over https; a wrong code never sets it; accepting reads the code from the
 * cookie; forgetting clears it.
 */

const request = vi.hoisted(() => ({
  set: [] as { name: string; value: string; options: Record<string, unknown> }[],
  cookie: "123456" as string | undefined,
  opened: null as unknown,
  accepted: null as unknown,
  acceptArgs: null as unknown,
  revalidated: [] as string[],
  site: "https://gateway.example.com",
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (request.cookie ? { value: request.cookie } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) =>
      request.set.push({ name, value, options }),
  }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => request.revalidated.push(p),
}));
vi.mock("@/lib/env", () => ({ env: () => ({ GATEWAY_SITE_URL: request.site }) }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({}) }));
vi.mock("@xos/data/gateway", () => ({
  openCrewShifts: async () => request.opened,
  acceptCrewShift: async (_db: unknown, input: unknown) => {
    request.acceptArgs = input;
    return request.accepted;
  },
}));

const { acceptCrewShiftAction, forgetCrewCodeAction, openCrewShiftsAction } =
  await import("../lib/actions/crew-shifts");

const TOKEN = `xcrw_${"a".repeat(64)}`;

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

describe("the crew access link's code cookie", () => {
  beforeEach(() => {
    request.set = [];
    request.revalidated = [];
    request.cookie = "123456";
    request.site = "https://gateway.example.com";
  });

  it("keeps a right code for 12 hours on this link's path only", async () => {
    request.opened = {
      ok: true,
      data: { refused: false, linkExpiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
    };
    const state = await openCrewShiftsAction({}, form({ token: TOKEN, accessCode: "123456" }));
    expect(state.refusal).toBeUndefined();
    expect(request.set[0]).toMatchObject({
      name: "xos_crew_code",
      value: "123456",
      options: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: `/shifts/${TOKEN}`,
        maxAge: 43_200,
      },
    });
  });

  it("leaves Secure off on local http, where WebKit would refuse the cookie", async () => {
    request.site = "http://127.0.0.1:3127";
    request.opened = {
      ok: true,
      data: { refused: false, linkExpiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
    };
    await openCrewShiftsAction({}, form({ token: TOKEN, accessCode: "123456" }));
    expect(request.set[0]?.options["secure"]).toBe(false);
  });

  it("keeps it no longer than the link lives", async () => {
    request.opened = {
      ok: true,
      data: { refused: false, linkExpiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    };
    await openCrewShiftsAction({}, form({ token: TOKEN, accessCode: "123456" }));
    expect(Number(request.set[0]?.options["maxAge"])).toBeLessThanOrEqual(3_600);
  });

  it("sets nothing for a wrong code and says why", async () => {
    request.opened = { ok: true, data: { refused: true, reason: "crew_access_access_code" } };
    const state = await openCrewShiftsAction({}, form({ token: TOKEN, accessCode: "000000" }));
    expect(state.refusal).toBe("crew_access_access_code");
    expect(request.set).toEqual([]);
  });

  it("accepts with the code from the cookie, never from the form", async () => {
    request.accepted = { ok: true, data: { refused: false, state: "Accepted" } };
    const state = await acceptCrewShiftAction(
      {},
      form({ token: TOKEN, shiftId: "0192a000-0000-7000-8000-000000000001", accessCode: "999999" }),
    );
    expect(state.accepted).toBe(true);
    expect(request.acceptArgs).toMatchObject({ token: TOKEN, accessCode: "123456" });
    expect(request.revalidated).toEqual([`/shifts/${TOKEN}`]);
  });

  it("clears the cookie on the same path", async () => {
    await forgetCrewCodeAction(form({ token: TOKEN }));
    expect(request.set[0]).toMatchObject({
      value: "",
      options: { path: `/shifts/${TOKEN}`, maxAge: 0 },
    });
  });
});
