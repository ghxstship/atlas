import { describe, expect, it } from "vitest";
import { foldWarnings, shiftPolicyWarnings } from "../src/crew.ts";
import { fakeClient, okResponse } from "./fake-client.ts";

/** The org's scheduling warnings (B9, migration 2983): rest and daily and weekly hours, which never refuse. */

describe("shift policy warnings", () => {
  it("keeps the smaller gap when both sides of a shift are short, and one row per code", () => {
    expect(
      foldWarnings([
        { code: "shift_rest_short", minutes: 480, limitMinutes: 600, otherShiftId: "a" },
        { code: "shift_week_over", minutes: 3100, limitMinutes: 3000, otherShiftId: null },
        { code: "shift_rest_short", minutes: 300, limitMinutes: 600, otherShiftId: "b" },
      ]),
    ).toEqual([
      { code: "shift_rest_short", minutes: 300, limitMinutes: 600, otherShiftId: "b" },
      { code: "shift_week_over", minutes: 3100, limitMinutes: 3000, otherShiftId: null },
    ]);
  });

  it("groups by person and ignores a code it does not know", async () => {
    const { db } = fakeClient({
      "rpc:shift_policy_warnings": [
        okResponse([
          {
            person_id: "p1",
            code: "shift_day_over",
            minutes: 780,
            limit_minutes: 720,
            other_shift_id: null,
          },
          {
            person_id: "p1",
            code: "shift_new_rule",
            minutes: 1,
            limit_minutes: 1,
            other_shift_id: null,
          },
          {
            person_id: "p2",
            code: "shift_rest_short",
            minutes: 480,
            limit_minutes: 600,
            other_shift_id: "s9",
          },
        ]),
      ],
    });
    const result = await shiftPolicyWarnings(db, "s1", ["p1", "p2", "p3", "p1"]);
    expect(result.ok && result.data.get("p1")?.map((w) => w.code)).toEqual(["shift_day_over"]);
    expect(result.ok && result.data.get("p2")?.[0]?.otherShiftId).toBe("s9");
    expect(result.ok && result.data.has("p3")).toBe(false);
  });

  it("asks nothing for nobody", async () => {
    const { db, calls } = fakeClient({});
    const result = await shiftPolicyWarnings(db, "s1", []);
    expect(result.ok && result.data.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
