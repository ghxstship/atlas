import { describe, expect, it } from "vitest";
import { collectionState } from "@/lib/collection-kit/page";

// "Today" defaults come from the org's calendar (orgToday), passed in as a YYYY-MM-DD date, never
// from the UTC clock: on the last evening of a month in the Americas UTC is already in the next one.
describe("collection calendars on the org's calendar", () => {
  it("opens on the month of the org's date, whatever the UTC month is", () => {
    expect(collectionState({}, ["table", "calendar"], "2026-10-31").month).toBe("2026-10-01");
    expect(collectionState({}, ["calendar"], "2027-01-01").month).toBe("2027-01-01");
  });

  it("keeps a month the URL asks for", () => {
    expect(collectionState({ month: "2027-02" }, ["calendar"], "2026-10-31").month).toBe(
      "2027-02-01",
    );
  });

  it("ignores a malformed month and falls back to the org's month", () => {
    expect(collectionState({ month: "2027-2" }, ["calendar"], "2026-10-31").month).toBe(
      "2026-10-01",
    );
  });
});
