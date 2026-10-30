/**
 * 'Whose rider' choices (R2, lib/advancing/rider-party.ts): the native select falls back to its first
 * option when the value has none, so a rider whose engagement has ended, or an editor without a
 * people-picker capability, must still find the rider's own party offered, or saving a new title
 * would clear it.
 */
import { describe, expect, it } from "vitest";
import { riderPartyChoices, riderPartyValue } from "@/lib/advancing/rider-party";

const ACCOUNT = { value: "c:acct", label: "Northline Audio" };
const PARTIES = [
  ACCOUNT,
  { value: "e:eng-a", label: "Ana Ruiz · AAA", projectId: "proj-a" },
  { value: "e:eng-b", label: "Bo Lind · BBB", projectId: "proj-b" },
];

describe("riderPartyValue", () => {
  it("names the engagement, then the counterparty, then nobody", () => {
    expect(riderPartyValue({ counterpartyId: null, engagementId: "eng-a" })).toBe("e:eng-a");
    expect(riderPartyValue({ counterpartyId: "acct", engagementId: null })).toBe("c:acct");
    expect(riderPartyValue({ counterpartyId: null, engagementId: null })).toBe("");
  });
});

describe("riderPartyChoices", () => {
  it("offers counterparties and only the given project's Artist engagements", () => {
    expect(riderPartyChoices(PARTIES, "proj-a")).toEqual([
      { value: "c:acct", label: "Northline Audio" },
      { value: "e:eng-a", label: "Ana Ruiz · AAA" },
    ]);
    expect(riderPartyChoices(PARTIES, "")).toEqual([{ value: "c:acct", label: "Northline Audio" }]);
  });

  it("keeps the rider's own engagement when the picker left it out", () => {
    expect(
      riderPartyChoices(PARTIES, "proj-a", { value: "e:eng-ended", label: "Cy Moss" }),
    ).toEqual([
      { value: "c:acct", label: "Northline Audio" },
      { value: "e:eng-a", label: "Ana Ruiz · AAA" },
      { value: "e:eng-ended", label: "Cy Moss" },
    ]);
    // With no picker capability there are no engagement options at all.
    expect(riderPartyChoices([ACCOUNT], "proj-a", { value: "e:eng-a", label: "Ana Ruiz" })).toEqual(
      [
        { value: "c:acct", label: "Northline Audio" },
        { value: "e:eng-a", label: "Ana Ruiz" },
      ],
    );
  });

  it("adds nothing for a rider with no party or a party already offered", () => {
    expect(riderPartyChoices(PARTIES, "proj-a", { value: "", label: "No one yet" })).toHaveLength(
      2,
    );
    expect(riderPartyChoices(PARTIES, "proj-a", { value: "c:acct", label: "Other" })).toHaveLength(
      2,
    );
  });
});
