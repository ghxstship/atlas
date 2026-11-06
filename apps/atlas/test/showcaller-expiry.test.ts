import { describe, expect, it } from "vitest";
import {
  expiresBeforeShow,
  showcallerDayFromToday,
  showcallerExpiryFor,
} from "@/lib/showcaller/expiry";

/**
 * B3 (ADR 0142): a link picked for a calendar day lasts to the end of that day in the project's zone. Ending it in
 * UTC would stop a Los Angeles link at 16:59 local, before the show.
 */
describe("a showcaller link's expiry", () => {
  const now = new Date("2027-03-10T12:00:00Z");

  it("ends the chosen day in the project's zone", () => {
    expect(showcallerExpiryFor("2027-03-13", "America/Los_Angeles", now)).toBe(
      "2027-03-14T07:59:00.000Z",
    );
    expect(showcallerExpiryFor("2027-03-13", "Asia/Tokyo", now)).toBe("2027-03-13T14:59:00.000Z");
  });

  it("stays under the 14-day ceiling", () => {
    const ceiling = now.getTime() + 14 * 86_400_000;
    const last = Date.parse(showcallerExpiryFor("2027-03-24", "America/Los_Angeles", now));
    expect(last).toBeLessThan(ceiling);
    expect(ceiling - last).toBe(60_000);
    expect(Date.parse(showcallerExpiryFor("2027-06-01", "Asia/Tokyo", now))).toBe(last);
  });

  it("offers days counted from today in the zone, not in UTC", () => {
    const lateInLa = new Date("2027-03-11T05:00:00Z");
    expect(showcallerDayFromToday(0, "America/Los_Angeles", lateInLa)).toBe("2027-03-10");
    expect(showcallerDayFromToday(0, "Asia/Tokyo", lateInLa)).toBe("2027-03-11");
    expect(showcallerDayFromToday(1, "America/Los_Angeles", lateInLa)).toBe("2027-03-11");
    expect(showcallerDayFromToday(14, "America/Los_Angeles", lateInLa)).toBe("2027-03-24");
    expect(showcallerDayFromToday(1, "UTC", new Date("2027-12-31T12:00:00Z"))).toBe("2028-01-01");
  });

  it("warns on a day before the show, comparing local days", () => {
    expect(expiresBeforeShow("2027-03-12", "2027-03-13")).toBe(true);
    expect(expiresBeforeShow("2027-03-13", "2027-03-13")).toBe(false);
    expect(expiresBeforeShow("", "2027-03-13")).toBe(false);
  });
});
