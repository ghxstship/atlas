import { describe, expect, it } from "vitest";
import {
  actionFor,
  buildShiftAction,
  groupByDay,
  isOpenShift,
  startsIn,
  type ShiftRow,
} from "../src/domain/shifts";

const now = Date.UTC(2026, 9, 15, 12, 0, 0);
const h = 3600_000;
const shift = (id: string, startOffsetH: number, over: Partial<ShiftRow> = {}): ShiftRow => ({
  id,
  project_id: "p1",
  membership_id: "m1",
  starts_at: new Date(now + startOffsetH * h).toISOString(),
  ends_at: new Date(now + (startOffsetH + 8) * h).toISOString(),
  shift_state: "Published",
  ...over,
});

describe("schedule", () => {
  it("groups upcoming shifts by day and drops ended and draft shifts", () => {
    const days = groupByDay(
      [
        shift("b", 30),
        shift("a", 2),
        shift("old", -20),
        shift("draft", 3, { shift_state: "Draft" }),
      ],
      now,
      (iso) => iso.slice(0, 10),
    );
    expect(days).toEqual([
      { day: "2026-10-15", shifts: [expect.objectContaining({ id: "a" })] },
      { day: "2026-10-16", shifts: [expect.objectContaining({ id: "b" })] },
    ]);
  });

  it("offers accept on my published shift and claim on open shifts to members", () => {
    const me = { membershipId: "m1", engagementIds: [] };
    expect(actionFor(shift("a", 2), me)).toBe("accept");
    expect(actionFor(shift("a", 2, { shift_state: "Accepted" }), me)).toBeNull();
    expect(actionFor(shift("o", 2, { membership_id: null }), me)).toBe("claim");
    expect(actionFor(shift("x", 2, { membership_id: "m2" }), me)).toBeNull();
    const external = { membershipId: null, engagementIds: ["e1"] };
    expect(actionFor(shift("e", 2, { membership_id: null, engagement_id: "e1" }), external)).toBe(
      "accept",
    );
    expect(actionFor(shift("o", 2, { membership_id: null }), external)).toBeNull();
    expect(isOpenShift(shift("o", 2, { membership_id: null, shift_state: "Accepted" }))).toBe(
      false,
    );
  });

  it("routes accept and claim to the right RPC", () => {
    expect(buildShiftAction(shift("a", 2), "accept", false)).toMatchObject({
      target: "app.accept_shift",
      payload: { p_shift_id: "a" },
      optimistic: { shift_state: "Accepted" },
    });
    expect(buildShiftAction(shift("a", 2), "accept", true).target).toBe("accept_engaged_shift");
    expect(buildShiftAction(shift("o", 2), "claim", false).target).toBe("app.claim_open_shift");
  });

  it("counts down to the call time", () => {
    expect(startsIn(new Date(now + 3 * h + 20 * 60_000).toISOString(), now)).toBe("3h 20m");
    expect(startsIn(new Date(now + 15 * 60_000).toISOString(), now)).toBe("15m");
    expect(startsIn(new Date(now - 1).toISOString(), now)).toBeNull();
  });
});
