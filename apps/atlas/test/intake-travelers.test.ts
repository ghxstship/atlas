import { describe, expect, it } from "vitest";
import { travelersOf } from "@/lib/aurora/intake-travelers";

const candidate = (person_id: string, engagement_id: string | null) => ({
  person_id,
  display_name: `Person ${person_id}`,
  engagement_id,
});

describe("the itinerary review's travelers (B15)", () => {
  it("links the one engagement a person has on the project", () => {
    expect(travelersOf([candidate("p1", "e1")])).toEqual([
      { value: "p1", label: "Person p1", engagementId: "e1" },
    ]);
  });

  it("links none for a person with two, rather than whichever sorts first", () => {
    expect(travelersOf([candidate("p1", "e1"), candidate("p1", "e2")])).toEqual([
      { value: "p1", label: "Person p1", engagementId: null },
    ]);
  });

  it("ignores a row without an engagement beside the one", () => {
    expect(travelersOf([candidate("p1", null), candidate("p1", "e1")])[0]?.engagementId).toBe("e1");
    expect(travelersOf([candidate("p2", null)])[0]?.engagementId).toBeNull();
  });
});
