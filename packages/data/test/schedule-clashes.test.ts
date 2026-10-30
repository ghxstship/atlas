import { describe, expect, it } from "vitest";
import {
  classifyClash,
  clashCountsByProject,
  clashThresholds,
  loadClashes,
  loadTravelRequestClashes,
  type ClashCandidate,
} from "../src/schedule-clashes.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/**
 * Clashes (B4, G-46 and G-47, migration 2936): classifyClash applies scheduling.changeover_minutes and
 * scheduling.travel_buffer_minutes and the severity table of ADR 0143; a TBC input lowers a clash to a Warning.
 */

const base: ClashCandidate = {
  rule: "changeover",
  projectId: "p1",
  otherProjectId: "p1",
  day: "2027-06-05",
  subjectTable: "cues",
  subjectId: "c1",
  otherTable: "cues",
  otherId: "c2",
  partyKind: "person",
  partyId: "x",
  partyName: "Art",
  otherPartyName: "Quinn",
  startsAt: null,
  endsAt: null,
  otherStartsAt: null,
  otherEndsAt: null,
  gapMinutes: 10,
  tbc: false,
  draft: false,
};
const thresholds = { changeoverMinutes: 15, travelBufferMinutes: 120 };
const severity = (over: Partial<ClashCandidate>) =>
  classifyClash({ ...base, ...over }, thresholds)?.severity ?? null;

describe("classifyClash", () => {
  it("rates a changeover against the org minimum", () => {
    expect(severity({ gapMinutes: 10 })).toBe("Warning");
    expect(severity({ gapMinutes: -5 })).toBe("Clash");
    expect(severity({ gapMinutes: 15 })).toBe(null);
    expect(
      classifyClash({ ...base, gapMinutes: 20 }, { ...thresholds, changeoverMinutes: 30 })?.params
        .minimum,
    ).toBe(30);
  });

  it("rates travel against the buffer", () => {
    expect(severity({ rule: "arrival_near_call", gapMinutes: -10 })).toBe("Clash");
    expect(severity({ rule: "arrival_near_call", gapMinutes: 30 })).toBe("Warning");
    expect(severity({ rule: "departure_near_call_end", gapMinutes: 200 })).toBe(null);
  });

  it("keeps the severity table", () => {
    expect(severity({ rule: "person_double_booked" })).toBe("Clash");
    expect(severity({ rule: "person_double_booked", draft: true })).toBe("Warning");
    expect(severity({ rule: "person_in_transit" })).toBe("Clash");
    expect(severity({ rule: "supplier_overlap", gapMinutes: null })).toBe("Warning");
    expect(severity({ rule: "supplier_dock_overlap" })).toBe("Warning");
    expect(severity({ rule: "set_two_stages" })).toBe("Clash");
    expect(severity({ rule: "past_curfew", gapMinutes: 12 })).toBe("Clash");
  });

  it("lowers a TBC input to a Warning", () => {
    expect(severity({ rule: "set_two_stages", tbc: true })).toBe("Warning");
    expect(severity({ gapMinutes: -5, tbc: true })).toBe("Warning");
  });

  it("links both sides to where they are fixed", () => {
    const clash = classifyClash(
      { ...base, rule: "person_in_transit", subjectTable: "shifts", otherTable: "travel_segments" },
      thresholds,
    );
    expect(clash?.links.map((l) => l.kind)).toEqual(["shift", "travel_segment"]);
  });

  it("reads the thresholds from resolved settings, with the defaults when unset", () => {
    expect(clashThresholds(new Map([["scheduling.changeover_minutes", { value: 20 }]]))).toEqual({
      changeoverMinutes: 20,
      travelBufferMinutes: 120,
    });
  });
});

describe("loading clashes", () => {
  it("drops what the thresholds drop and counts a clash on both projects", async () => {
    const row = (over: Record<string, unknown>) => ({
      rule: "changeover",
      project_id: "p1",
      other_project_id: "p1",
      day: "2027-06-05",
      subject_table: "cues",
      subject_id: "c1",
      other_table: "cues",
      other_id: "c2",
      party_kind: "person",
      party_id: "x",
      party_name: "Art",
      other_party_name: "Quinn",
      starts_at: null,
      ends_at: null,
      other_starts_at: null,
      other_ends_at: null,
      gap_minutes: 10,
      tbc: false,
      draft: false,
      ...over,
    });
    const { db } = fakeClient({
      "rpc:schedule_clashes": [
        okResponse([
          row({}),
          row({ gap_minutes: 200 }),
          row({ rule: "person_double_booked", other_project_id: "p2", gap_minutes: 60 }),
        ]),
      ],
      "rpc:resolve_settings": [okResponse([])],
    });
    const loaded = await loadClashes(db, { orgId: "o1", from: "2027-06-01", to: "2027-06-30" });
    expect(loaded.ok && loaded.data.clashes.map((c) => [c.rule, c.severity])).toEqual([
      ["person_double_booked", "Clash"],
      ["changeover", "Warning"],
    ]);
    expect(loaded.ok && Object.fromEntries(clashCountsByProject(loaded.data.clashes))).toEqual({
      p1: 2,
      p2: 1,
    });
  });

  it("returns the travel check's denial as not found", async () => {
    const { db } = fakeClient({
      "rpc:travel_request_clashes": [
        errorResponse("42501", "hospitality.fulfillment.read is required"),
      ],
    });
    const loaded = await loadTravelRequestClashes(db, "p1");
    expect(!loaded.ok && loaded.error.kind).toBe("not-found");
  });
});
