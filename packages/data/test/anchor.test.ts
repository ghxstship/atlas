import { describe, expect, it } from "vitest";
import {
  anchorOffset,
  daysBetweenDates,
  formatAnchorOffset,
  localDate,
  moveProjectAnchor,
  setProjectAnchor,
  shiftDate,
} from "../src/anchor.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** Anchor offset scheduling (B4, G-44, migration 2934): offsets on the wall clock, the move and the first anchor. */

describe("offsets", () => {
  it("counts signed whole days from the anchor on the project's wall clock", () => {
    // 02:00 UTC on June 6 is still June 5 in New York.
    expect(localDate("2027-06-06T02:00:00Z", "America/New_York")).toBe("2027-06-05");
    expect(anchorOffset("2027-06-06T02:00:00Z", "2027-06-08", "America/New_York")).toBe(-3);
    expect(anchorOffset("2027-06-09T14:00:00Z", "2027-06-08", "America/New_York")).toBe(1);
    expect(daysBetweenDates("2027-02-27", "2027-03-02")).toBe(3);
  });

  it("writes D-3, D0 and D+1", () => {
    expect(formatAnchorOffset(-3)).toBe("D−3");
    expect(formatAnchorOffset(0)).toBe("D0");
    expect(formatAnchorOffset(1)).toBe("D+1");
    expect(shiftDate("2027-02-27", 2)).toBe("2027-03-01");
    expect(shiftDate("2027-03-01", -2)).toBe("2027-02-27");
  });
});

describe("moving the anchor", () => {
  it("previews and maps every moving and staying item", async () => {
    const { db, calls } = fakeClient({
      "rpc:move_project_anchor": [
        okResponse([
          {
            item_kind: "Record",
            item_id: "r1",
            label: "NWS-1 Rig",
            moves: true,
            stays_because: null,
            old_at: "a",
            new_at: "b",
            old_on: null,
            new_on: null,
            shift_days: 2,
          },
          {
            item_kind: "Shift",
            item_id: "s1",
            label: "Frank",
            moves: false,
            stays_because: "shift",
            old_at: "c",
            new_at: "c",
            old_on: null,
            new_on: null,
            shift_days: 0,
          },
        ]),
      ],
    });
    const moved = await moveProjectAnchor(db, {
      projectId: "p1",
      anchorOn: "2027-06-07",
      commit: false,
      reason: " ",
    });
    expect(moved.ok && moved.data.map((i) => [i.kind, i.moves, i.staysBecause])).toEqual([
      ["Record", true, null],
      ["Shift", false, "shift"],
    ]);
    expect(calls[0]?.steps[0]?.[1][0]).toMatchObject({ p_commit: false, p_reason: null });
  });

  it("returns anchor_unset as a refusal", async () => {
    const { db } = fakeClient({
      "rpc:move_project_anchor": [
        errorResponse("XR001", "anchor_unset: Set the anchor first.", "anchor_unset"),
      ],
    });
    const moved = await moveProjectAnchor(db, {
      projectId: "p1",
      anchorOn: "2027-06-07",
      commit: true,
    });
    expect(!moved.ok && moved.error).toMatchObject({ kind: "refusal", rule: "anchor_unset" });
  });

  it("sets the first anchor with a plain update", async () => {
    const { db, calls } = fakeClient({ "from:projects": [okResponse([{ id: "p1" }])] });
    const set = await setProjectAnchor(db, "p1", "2027-06-05");
    expect(set.ok).toBe(true);
    expect(calls[0]?.steps).toContainEqual(["update", [{ anchor_on: "2027-06-05" }]]);
  });
});
