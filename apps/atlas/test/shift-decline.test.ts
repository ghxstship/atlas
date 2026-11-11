import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 4.9 surface crawl: the person assigned to a Published shift declines it on the web, as Compass lets them
 * (app.decline_shift). The reason is optional and the person's own words; a blank one is left to the database's
 * default, and one over 500 characters never reaches the write.
 */

const state = vi.hoisted(() => ({ declineShift: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("@/lib/shell/context", () => ({
  getOrgContext: async () => ({ org: { id: "org", slug: "acme" }, viewer: { db: {} } }),
}));
vi.mock("@/lib/shell/translate", () => ({ getTranslate: async () => (key: string) => key }));
vi.mock("@xos/data/crew", () => ({ declineShift: state.declineShift }));

const { declineShiftAction } = await import("@/app/[org]/crew/actions");

const SHIFT = "0192f1e2-7c3a-7b4d-9e8f-000000000006";

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries({ org: "acme", id: SHIFT, ...values })) data.set(k, v);
  return data;
}

beforeEach(() => {
  state.declineShift.mockReset();
  state.declineShift.mockResolvedValue({ ok: true, data: { transitionId: "t1" } });
});

describe("declineShiftAction", () => {
  it("declines the shift with the person's reason", async () => {
    expect(await declineShiftAction({}, form({ reason: "  Double booked.  " }))).toEqual({
      ok: true,
    });
    expect(state.declineShift.mock.calls[0]?.slice(1)).toEqual([SHIFT, "Double booked."]);
  });

  it("leaves a blank reason to the database", async () => {
    await declineShiftAction({}, form({ reason: " " }));
    expect(state.declineShift.mock.calls[0]?.slice(1)).toEqual([SHIFT, null]);
  });

  it("never writes a reason over 500 characters or a shift that is not an id", async () => {
    expect((await declineShiftAction({}, form({ reason: "x".repeat(501) }))).error).toBeTruthy();
    expect((await declineShiftAction({}, form({ id: "nope" }))).error).toBeTruthy();
    expect(state.declineShift).not.toHaveBeenCalled();
  });
});
