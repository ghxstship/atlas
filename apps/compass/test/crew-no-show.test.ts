import { admits } from "@xos/sync";
import type { DownloadScope } from "@xos/sync";
import { describe, expect, it } from "vitest";
import { access } from "../src/domain/access";
import { buildNoShow, lateCrew } from "../src/domain/no-show";
import { isOpenShift } from "../src/domain/shifts";
import { summarizeMutation } from "../src/domain/queue-summary";

/** No-shows on the Crew tab and the shift rows they read (B9, migration 2982, ADR 0148). */

const NOW = Date.parse("2027-06-01T15:00:00Z");
const shift = (id: string, membership: string | null, start = "2027-06-01T14:00:00Z") => ({
  id,
  org_id: "o1",
  project_id: "p1",
  membership_id: membership,
  starts_at: start,
  ends_at: "2027-06-01T22:00:00Z",
});

describe("the late list", () => {
  it("lists a started shift whose member is not on site", () => {
    const shifts = [shift("a", "m1"), shift("b", "m2"), shift("c", "m3", "2027-06-01T16:00:00Z")];
    expect(lateCrew(shifts, new Set(["m2"]), new Set(), NOW).map((s) => s.id)).toEqual(["a"]);
  });

  it("leaves out someone already marked, at once and offline", () => {
    expect(lateCrew([shift("a", "m1")], new Set(), new Set(["a"]), NOW)).toEqual([]);
  });
});

describe("marking", () => {
  const input = { shiftId: "a", orgId: "o1", projectId: "p1", reason: " Not at the gate. " };

  it("queues one change, keyed by the client's id, that replays as the same mark", () => {
    const mutation = buildNoShow(input, NOW, () => "n1");
    expect(mutation).toMatchObject({
      op: "rpc",
      target: "app.mark_shift_no_show",
      table: "shift_no_shows",
      rowId: "n1",
      payload: { p_no_show_id: "n1", p_shift_id: "a", p_reason: "Not at the gate." },
    });
  });

  it("never holds the reason in the local row", () => {
    const { optimistic } = buildNoShow(input, NOW, () => "n1");
    expect(optimistic).toEqual({
      id: "n1",
      org_id: "o1",
      project_id: "p1",
      shift_id: "a",
      recorded_at: "2027-06-01T15:00:00.000Z",
    });
  });

  it("reads as a sentence in the queue", () => {
    const m = buildNoShow(input, NOW, () => "n1");
    const ctx = {
      day: () => "",
      time: () => "",
      zoneName: () => null,
      punchAction: () => "",
      kind: () => "",
    };
    expect(
      summarizeMutation(
        {
          op: m.op,
          target: m.target as string,
          table: m.table,
          payload: m.payload,
          base: null,
          queuedAt: "",
        },
        ctx as never,
      ).key,
    ).toBe("noShow");
  });
});

describe("the feature", () => {
  it("needs crew.shift.write on the project", () => {
    expect(
      access(
        {
          personId: "x",
          displayName: "",
          audience: "field-supervisor",
          capabilities: ["crew.shift.read"],
          membershipId: "m",
          engagements: [],
        } as never,
        "crew.no_show",
        "p1",
      ),
    ).toEqual({ allowed: false, reason: "capability" });
  });
});

describe("open shifts", () => {
  it("does not offer Claim on a shift held for a position, or held by the roster", () => {
    const base = {
      id: "s",
      project_id: "p1",
      starts_at: "2027-06-01T14:00:00Z",
      ends_at: "2027-06-01T22:00:00Z",
      shift_state: "Published",
    };
    expect(isOpenShift(base)).toBe(true);
    expect(isOpenShift({ ...base, project_position_id: "pos" })).toBe(false);
    expect(isOpenShift({ ...base, roster_entry_id: "r" })).toBe(false);
  });
});

describe("what the device downloads", () => {
  const crew: DownloadScope = {
    audience: "crew",
    personIds: ["x"],
    orgIds: [],
    membershipIds: [],
    readableProjectIds: [],
    engagementIds: ["e1"],
    engagedProjectIds: ["p1"],
    engagedOrgIds: ["o1"],
  };

  it("gives a crew or staff worker their org's break types, and not a vendor", () => {
    expect(admits("break_types", { id: "b", org_id: "o1" }, crew)).toBe(true);
    expect(admits("break_types", { id: "b", org_id: "o1" }, { ...crew, audience: "staff" })).toBe(
      true,
    );
    expect(admits("break_types", { id: "b", org_id: "o2" }, crew)).toBe(false);
    expect(admits("break_types", { id: "b", org_id: "o1" }, { ...crew, audience: "vendor" })).toBe(
      false,
    );
  });

  it("gives no-shows only to internal readers of the project", () => {
    expect(admits("shift_no_shows", { id: "n", project_id: "p1" }, crew)).toBe(false);
    expect(
      admits(
        "shift_no_shows",
        { id: "n", project_id: "p1" },
        { ...crew, audience: "field-supervisor", readableProjectIds: ["p1"] },
      ),
    ).toBe(true);
  });
});
