import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 4.9 surface crawl: a Published shift on the Shifts tab is declined as well as accepted, with an optional reason
 * (app.decline_shift, the rule Compass already follows). A blank reason is left to the database's default; one over 500
 * characters never reaches the write, and a refusal keeps its rule.
 */

const state = vi.hoisted(() => ({ declined: [] as unknown[][], result: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({}) }));
vi.mock("@/lib/shell/context", () => ({ getGatewayContext: async () => null }));
vi.mock("@xos/data/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xos/data/gateway")>()),
  declineEngagedShift: async (...args: unknown[]) => {
    state.declined.push(args.slice(1));
    return state.result;
  },
}));

const { declineShiftAction } = await import("../lib/actions/operations");

const SHIFT = "0192f1e2-7c3a-7b4d-9e8f-000000000006";

beforeEach(() => {
  state.declined = [];
  state.result = { ok: true, data: { id: "t1" } };
});

describe("declining a shift in Gateway", () => {
  it("passes the person's reason, trimmed", async () => {
    expect(await declineShiftAction(SHIFT, "  Booked elsewhere that day.  ")).toEqual({ ok: true });
    expect(state.declined).toEqual([[SHIFT, "Booked elsewhere that day."]]);
  });

  it("sends no reason when the field is blank", async () => {
    await declineShiftAction(SHIFT, "   ");
    await declineShiftAction(SHIFT);
    expect(state.declined).toEqual([
      [SHIFT, null],
      [SHIFT, null],
    ]);
  });

  it("refuses a reason over 500 characters before writing", async () => {
    expect(await declineShiftAction(SHIFT, "x".repeat(501))).toEqual({
      ok: false,
      outcome: "invalid",
    });
    expect(state.declined).toEqual([]);
  });

  it("says what the database refused", async () => {
    state.result = {
      ok: false,
      error: { kind: "refusal", rule: "lifecycle_transition", message: "No." },
    };
    expect(await declineShiftAction(SHIFT, null)).toEqual({
      ok: false,
      outcome: "refusals.lifecycle_transition",
    });
  });
});
