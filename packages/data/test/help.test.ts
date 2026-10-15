import { describe, expect, it } from "vitest";
import { dismissTip, getHelpState, recordTour, resetTips } from "../src/help.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

describe("tours and tips", () => {
  it("reads tour progress and dismissed tips", async () => {
    const { db } = fakeClient({
      "from:tour_progress": [
        okResponse([{ id: "p1", tour_key: "module.crew", tour_state: "Completed", step: 4 }]),
        errorResponse("500", "x"),
        okResponse([]),
      ],
      "from:tip_dismissals": [
        okResponse([{ tip_key: "gates" }]),
        okResponse([]),
        errorResponse("500", "x"),
      ],
    });
    expect(await getHelpState(db, "m1")).toEqual({
      ok: true,
      data: {
        tours: [{ id: "p1", tourKey: "module.crew", state: "Completed", step: 4 }],
        dismissedTips: ["gates"],
      },
    });
    expect((await getHelpState(db, "m1")).ok).toBe(false);
    expect((await getHelpState(db, "m1")).ok).toBe(false);
  });

  it("offers a tour once, then moves it", async () => {
    const { db, calls } = fakeClient({
      "from:tour_progress": [
        okResponse(null),
        okResponse(null),
        okResponse({ id: "p1" }),
        okResponse(null),
      ],
    });
    const input = { orgId: "o", membershipId: "m1", tourKey: "module.crew" };
    expect((await recordTour(db, { ...input, state: "Offered" })).ok).toBe(true);
    expect(calls[1]?.steps.find(([s]) => s === "insert")?.[1][0]).toMatchObject({
      tour_state: "Offered",
      step: 0,
    });
    expect((await recordTour(db, { ...input, state: "Started", step: 2 })).ok).toBe(true);
    expect(calls[3]?.steps.find(([s]) => s === "update")?.[1][0]).toEqual({
      tour_state: "Started",
      step: 2,
    });
  });

  it("returns tour refusals", async () => {
    const { db } = fakeClient({
      "from:tour_progress": [
        errorResponse("500", "x"),
        okResponse({ id: "p1" }),
        errorResponse("XR001", "tour_offered_once: once", "tour_offered_once"),
      ],
    });
    const input = {
      orgId: "o",
      membershipId: "m1",
      tourKey: "module.crew",
      state: "Offered" as const,
    };
    expect((await recordTour(db, input)).ok).toBe(false);
    const refused = await recordTour(db, input);
    expect(refused.ok ? null : refused.error).toMatchObject({
      kind: "refusal",
      rule: "tour_offered_once",
    });
  });

  it("dismisses a tip once and resets tips", async () => {
    const { db } = fakeClient({
      "from:tip_dismissals": [
        okResponse(null),
        errorResponse("23505", "duplicate"),
        errorResponse("500", "x"),
        okResponse(null),
        errorResponse("500", "x"),
      ],
    });
    const input = { orgId: "o", membershipId: "m1", tipKey: "gates" };
    expect((await dismissTip(db, input)).ok).toBe(true);
    expect((await dismissTip(db, input)).ok).toBe(true);
    expect((await dismissTip(db, input)).ok).toBe(false);
    expect((await resetTips(db, "m1")).ok).toBe(true);
    expect((await resetTips(db, "m1")).ok).toBe(false);
  });
});
