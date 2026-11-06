import { describe, expect, it } from "vitest";
import { breakChoice, buildPunch, type PunchContext } from "../src/domain/clock";

/** Break types on the clock (B9, migration 2985, ADR 0148 decision 4). */

const context: PunchContext = {
  projectId: "p1",
  shiftId: null,
  membershipId: "m1",
  engagementId: null,
  source: "Mobile",
};
const event = { deviceAt: "2027-06-01T15:00:00Z", monotonicAt: 1, bootId: "b", offsetMs: 0 } as never;

describe("what Break does", () => {
  it("asks only with two or more live types", () => {
    expect(breakChoice([])).toEqual({ ask: false, typeId: null });
    expect(breakChoice([{ id: "b1", name: "Meal" }])).toEqual({ ask: false, typeId: "b1" });
    expect(
      breakChoice([
        { id: "b1", name: "Meal" },
        { id: "b2", name: "Rest", paid: true },
      ]),
    ).toEqual({ ask: true });
  });
});

describe("the punch", () => {
  const punch = (kind: "Break Start" | "Break End", breakTypeId: string | null) =>
    buildPunch(kind, { ...context, breakTypeId }, event, null, [], 0, () => "x");

  it("carries the chosen type on a Break Start", () => {
    const m = punch("Break Start", "b1");
    expect(m.payload["p_break_type_id"]).toBe("b1");
    expect(m.optimistic?.["break_type_id"]).toBe("b1");
  });

  it("sends nothing without a type, so the server takes the org's default, else none", () => {
    expect(punch("Break Start", null).payload).not.toHaveProperty("p_break_type_id");
  });

  it("never carries a type on any other punch", () => {
    expect(punch("Break End", "b1").payload).not.toHaveProperty("p_break_type_id");
    expect(punch("Break End", "b1").optimistic?.["break_type_id"]).toBeNull();
  });
});
