import { describe, expect, it } from "vitest";
import { createShift, saveRosterShift, updateShift } from "../src/crew.ts";
import { fakeClient, okResponse } from "./fake-client.ts";

/**
 * B13 (RRR-237, G-133, C5): a shift's Labor budget line reaches the database on every path that saves a
 * shift. Most shifts save through createShift and updateShift, and only staff and held shifts through
 * app.save_roster_shift, so dropping the field from any one path would lose it for those shifts.
 */
const shift = {
  orgId: "o1",
  projectId: "pr1",
  roleCode: null,
  startsAt: "2027-06-01T12:00:00.000Z",
  endsAt: "2027-06-01T20:00:00.000Z",
  timeZone: "UTC",
};
const written = (call: { steps: [string, unknown[]][] } | undefined, step: string) =>
  call?.steps.find(([name]) => name === step)?.[1][0] as Record<string, unknown>;

describe("a shift's budget line", () => {
  it("is written when a shift is created, and null without one", async () => {
    const { db, calls } = fakeClient({
      "from:shifts": [okResponse({ id: "s1" }), okResponse({ id: "s2" })],
    });
    await createShift(db, { ...shift, membershipId: "m1", budgetLineId: "line" });
    await createShift(db, { ...shift, membershipId: "m1" });
    expect(written(calls[0], "insert")["budget_line_id"]).toBe("line");
    expect(written(calls[1], "insert")["budget_line_id"]).toBeNull();
  });

  it("is written, cleared or left alone when a shift is edited", async () => {
    const { db, calls } = fakeClient({
      "from:shifts": [
        okResponse([{ id: "s1" }]),
        okResponse([{ id: "s1" }]),
        okResponse([{ id: "s1" }]),
      ],
    });
    await updateShift(db, "s1", { budgetLineId: "line" });
    await updateShift(db, "s1", { budgetLineId: null });
    await updateShift(db, "s1", { roleCode: "x" });
    expect(written(calls[0], "update")).toEqual({ budget_line_id: "line" });
    expect(written(calls[1], "update")).toEqual({ budget_line_id: null });
    expect(written(calls[2], "update")).not.toHaveProperty("budget_line_id");
  });

  it("is sent to app.save_roster_shift on every save, null included", async () => {
    const { db, calls } = fakeClient({
      "rpc:save_roster_shift": [okResponse("s1"), okResponse("s1")],
    });
    const worker = { kind: "staff", engagementId: "e1", rosterEntryId: "r1" } as const;
    await saveRosterShift(db, { ...shift, worker, budgetLineId: "line" });
    await saveRosterShift(db, { ...shift, worker, budgetLineId: null });
    expect(written(calls[0], "args")["p_budget_line_id"]).toBe("line");
    const cleared = written(calls[1], "args");
    expect(cleared).toHaveProperty("p_budget_line_id");
    expect(cleared["p_budget_line_id"]).toBeNull();
  });
});
