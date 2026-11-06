import { describe, expect, it } from "vitest";
import { dayInZone, endOfDayInZone } from "../lib/stakeholder-packs/expiry";

const NOW = new Date("2026-03-01T12:00:00Z");

describe("a pack expiry picked for a day", () => {
  it("ends at the end of that day in a project west of UTC", () => {
    expect(endOfDayInZone("2026-03-02", "America/Los_Angeles", NOW)).toBe("2026-03-03T07:59:59.000Z");
  });

  it("ends at the end of that day in a project east of UTC", () => {
    expect(endOfDayInZone("2026-03-02", "Asia/Tokyo", NOW)).toBe("2026-03-02T14:59:59.000Z");
  });

  it("follows the zone across a daylight-saving change", () => {
    // New York moves to daylight time on 2026-03-08, so the 7th ends at UTC-5 and the 8th at UTC-4.
    expect(endOfDayInZone("2026-03-07", "America/New_York", NOW)).toBe("2026-03-08T04:59:59.000Z");
    expect(endOfDayInZone("2026-03-08", "America/New_York", NOW)).toBe("2026-03-09T03:59:59.000Z");
  });

  it("never passes the 90-day limit", () => {
    const end = endOfDayInZone("2026-12-31", "UTC", NOW);
    expect(Date.parse(end)).toBeLessThan(NOW.getTime() + 90 * 86_400_000);
  });

  it("names today in the zone", () => {
    const late = new Date("2026-03-02T02:00:00Z");
    expect(dayInZone(0, "America/Los_Angeles", late)).toBe("2026-03-01");
    expect(dayInZone(0, "Asia/Tokyo", late)).toBe("2026-03-02");
  });
});
