import { describe, expect, it } from "vitest";
import { decodeWorker, encodeWorker, workerValue } from "../lib/crew/workers";

/** The shift editor's Person select (R12): members, agency slots and agency staff in one field. */
const A = "01920000-0000-7000-8000-000000000001";
const B = "01920000-0000-7000-8000-000000000002";

describe("shift workers", () => {
  it("round-trips every kind", () => {
    for (const choice of [
      { kind: "open" as const },
      { kind: "member" as const, membershipId: A },
      { kind: "agency" as const, engagementId: A },
      { kind: "staff" as const, rosterEntryId: A, engagementId: B },
    ]) {
      expect(decodeWorker(encodeWorker(choice))).toEqual(choice);
    }
  });

  it("refuses values that are not well formed", () => {
    expect(decodeWorker("agency:nope")).toBeNull();
    expect(decodeWorker(`staff:${A}`)).toBeNull();
    expect(decodeWorker(`agency:${A}:${B}`)).toBeNull();
    expect(decodeWorker("someone")).toBeNull();
  });

  it("reads a shift's current worker", () => {
    expect(workerValue({ member: null, agencySlot: { engagementId: A } })).toBe(`agency:${A}`);
    expect(workerValue({ member: null, rosterEntryId: A })).toBe(`staff:${A}`);
    expect(workerValue({ member: { membershipId: B } })).toBe(B);
    expect(workerValue({ member: null })).toBe("");
  });
});
