import { describe, expect, it } from "vitest";
import {
  getShiftOutcome,
  listShortages,
  markNoShow,
  respondReconfirmation,
  shortageCounts,
  withdrawNoShow,
} from "../src/crew.ts";
import { requestSwap } from "../src/crew/swaps.ts";
import { fakeClient, okResponse } from "./fake-client.ts";

/** Crew coverage (B9, migrations 2980 to 2982 and 2986): shortages, no-shows and "Still coming?" answers. */

const argsOf = (call: { steps: [string, unknown[]][] } | undefined) =>
  call?.steps.find((step) => step[0] === "args")?.[1][0];

const refused = (rule: string) => ({
  data: null,
  error: { code: "XR001", message: `${rule}: no`, hint: rule },
});

describe("shortages", () => {
  it("maps app.crew_shortages and counts each kind", async () => {
    const { db, calls } = fakeClient({
      "rpc:crew_shortages": [
        okResponse([
          {
            kind: "open",
            project_id: "p1",
            project_name: "Pier",
            shift_id: "s1",
            po_line_id: null,
            purchase_order_id: null,
            role_code: "0000.50.01",
            starts_at: "2027-06-01T12:00:00Z",
            ends_at: "2027-06-01T20:00:00Z",
            time_zone: "America/New_York",
            party_name: null,
            person_name: null,
            quantity: null,
            detail: "Deck Chief",
            asked_at: null,
          },
          {
            kind: "vendor_unconfirmed",
            project_id: "p1",
            project_name: "Pier",
            shift_id: null,
            po_line_id: "l1",
            purchase_order_id: "po1",
            role_code: null,
            starts_at: "2027-06-01T04:00:00Z",
            ends_at: null,
            time_zone: "America/New_York",
            party_name: "Tideline Labor",
            person_name: null,
            quantity: "6",
            detail: "Stagehands",
            asked_at: null,
          },
        ]),
      ],
    });
    const result = await listShortages(db, { orgId: "o1", from: "2027-06-01", to: "2027-06-14" });
    expect(argsOf(calls[0])).toEqual({ p_org_id: "o1", p_from: "2027-06-01", p_to: "2027-06-14" });
    expect(result.ok && result.data[1]).toMatchObject({
      kind: "vendor_unconfirmed",
      purchaseOrderId: "po1",
      quantity: 6,
      partyName: "Tideline Labor",
    });
    expect(result.ok && [...shortageCounts(result.data)]).toEqual([
      ["open", 1],
      ["vendor_unconfirmed", 1],
    ]);
  });

  it("surfaces the range refusal", async () => {
    const { db } = fakeClient({ "rpc:crew_shortages": [refused("crew_shortages_range")] });
    const result = await listShortages(db, { orgId: "o1", from: "2027-01-01", to: "2027-12-31" });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "crew_shortages_range" },
    });
  });
});

describe("no-shows", () => {
  it("sends the client's id, so a retry is the same mark", async () => {
    const { db, calls } = fakeClient({ "rpc:mark_shift_no_show": [okResponse("n1")] });
    const result = await markNoShow(db, { id: "n1", shiftId: "s1", reason: "Not here." });
    expect(result).toEqual({ ok: true, data: { id: "n1" } });
    expect(argsOf(calls[0])).toEqual({
      p_no_show_id: "n1",
      p_shift_id: "s1",
      p_reason: "Not here.",
      p_open_replacement: false,
    });
  });

  it("withdraws with a reason", async () => {
    const { db, calls } = fakeClient({ "rpc:withdraw_shift_no_show": [okResponse("n1")] });
    await withdrawNoShow(db, "n1", "He called in.");
    expect(argsOf(calls[0])).toEqual({ p_no_show_id: "n1", p_reason: "He called in." });
  });
});

describe("Still coming?", () => {
  it("answers, with a reason only when there is one", async () => {
    const { db, calls } = fakeClient({
      "rpc:respond_shift_reconfirmation": [okResponse("r1"), okResponse("r1")],
    });
    await respondReconfirmation(db, "s1", true);
    await respondReconfirmation(db, "s1", false, "Sick.");
    expect(argsOf(calls[0])).toEqual({ p_shift_id: "s1", p_coming: true });
    expect(argsOf(calls[1])).toEqual({ p_shift_id: "s1", p_coming: false, p_reason: "Sick." });
  });

  it("reads a shift's latest answers and its no-show", async () => {
    const { db } = fakeClient({
      "from:shift_responses": [
        okResponse([
          {
            id: "r2",
            shift_id: "s1",
            person_id: "x",
            ask_kind: "Reconfirmation",
            answer: "Waiting",
            asked_at: "2027-06-01T00:00:00Z",
            answered_at: null,
            reason: null,
          },
          {
            id: "r1",
            shift_id: "s1",
            person_id: "x",
            ask_kind: "Offer",
            answer: "Accepted",
            asked_at: "2027-05-01T00:00:00Z",
            answered_at: "2027-05-02T00:00:00Z",
            reason: null,
          },
        ]),
      ],
      "from:shift_no_shows": [okResponse(null)],
    });
    const result = await getShiftOutcome(db, "s1");
    expect(result.ok && result.data.reconfirmation?.answer).toBe("Waiting");
    expect(result.ok && result.data.offer?.answer).toBe("Accepted");
    expect(result.ok && result.data.noShow).toBeNull();
  });
});

describe("swap reasons", () => {
  it("sends a typed reason, trimmed, and nothing for an empty one", async () => {
    const { db, calls } = fakeClient({
      "from:shift_swaps": [okResponse({ id: "w1" }), okResponse({ id: "w2" })],
    });
    const base = {
      orgId: "o1",
      projectId: "p1",
      shiftId: "s1",
      requestedByMembershipId: "m1",
      proposedMembershipId: "m2",
    };
    await requestSwap(db, { ...base, reason: "  Exam that morning. " });
    await requestSwap(db, { ...base, reason: "   " });
    const reasons = calls
      .flatMap((c) => c.steps)
      .filter((step) => step[0] === "insert")
      .map((step) => (step[1][0] as { reason: string | null }).reason);
    expect(reasons).toEqual(["Exam that morning.", null]);
  });
});
