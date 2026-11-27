import type { Engagement, Representation } from "@xos/data/gateway";
import { describe, expect, it } from "vitest";
import { scheduleDay } from "../lib/format";
import { needsYou, pickUpNext } from "../lib/home";
import { blockDays, blockRange } from "../lib/profile";
import { byDay, itemDay, mergeUpcoming, type UpcomingItem } from "../lib/upcoming";

/**
 * Gateway dates a person reads as "today" or as a day of their availability on their own calendar, never the
 * UTC date (RRR-116; 4.20 follows the 4.19 compliance fix). Cases run at 22:00 on New Year's Eve 2026 in New
 * York, already 03:00 on 2027-01-01 in UTC, so the UTC date is a day (and a year) ahead.
 */

const NOW = new Date("2027-01-01T03:00:00Z");

describe("Home's Needs You list (lib/home.ts)", () => {
  const representation: Representation = {
    id: "rep-1",
    accountId: "acct-1",
    accountName: "Bayside Talent",
    artistPersonId: "me",
    artistName: "Ada",
    representativePersonId: "agent-1",
    expiresOn: "2026-12-31",
    acceptedAt: null,
    revokedAt: null,
    scopes: [],
  };
  const completed = {
    id: "eng-1",
    state: "Complete",
    startDate: "2026-12-10",
    endDate: "2026-12-17",
  } as unknown as Engagement;

  const feed = () =>
    needsYou({
      engagements: [completed],
      documents: [],
      onboarding: [],
      applications: [],
      representations: [representation],
      personId: "me",
      now: NOW,
      today: "2026-12-31",
    }).map((i) => i.kind);

  it("asks to accept a representation that expires today on the person's calendar", () => {
    expect(feed()).toContain("representation");
  });

  it("asks to rate work that ended fourteen days before the person's today", () => {
    expect(feed()).toContain("rate");
  });
});

describe("the profile's availability days (lib/profile.ts)", () => {
  // A Tokyo project's poll answer for 2027-01-05 runs from that day's midnight in Tokyo to the next (6123).
  const answer = {
    calendarId: "cal-tokyo",
    startsAt: "2027-01-04T15:00:00Z",
    endsAt: "2027-01-05T15:00:00Z",
    kind: "Available",
  };
  // The person's own calendar is kept in UTC: a block for 2027-01-05 to 2027-01-06.
  const own = {
    calendarId: "cal-own",
    startsAt: "2027-01-05T00:00:00Z",
    endsAt: "2027-01-07T00:00:00Z",
    kind: "Unavailable",
  };
  const zones = new Map([
    ["cal-tokyo", "Asia/Tokyo"],
    ["cal-own", "UTC"],
  ]);

  it("reads an org calendar's block on its zone", () => {
    expect(blockDays([answer, own], "Available", zones)).toEqual(["2027-01-05"]);
    expect(blockRange(answer, zones)).toEqual({ first: "2027-01-05", last: "2027-01-05" });
  });

  it("ends a block on its last day, not the day it stops", () => {
    expect(blockDays([answer, own], "Unavailable", zones)).toEqual(["2027-01-05", "2027-01-06"]);
    expect(blockRange(own, zones)).toEqual({ first: "2027-01-05", last: "2027-01-06" });
  });
});

describe("Home's Up Next card (lib/home.ts)", () => {
  // The engagement's last day is New Year's Eve, still today in New York though UTC is on New Year's Day.
  const lastDay = {
    id: "eng-2",
    state: "Active",
    startDate: "2026-12-28",
    endDate: "2026-12-31",
  } as unknown as Engagement;

  it("keeps an engagement on its last day on the person's calendar", () => {
    expect(pickUpNext([], [lastDay], NOW, "2026-12-31")).toEqual({
      kind: "engagement",
      engagement: lastDay,
    });
  });

  it("drops it once that day is over on the person's calendar", () => {
    expect(pickUpNext([], [lastDay], NOW, "2027-01-01")).toBeNull();
  });
});

describe("Work, Upcoming (lib/upcoming.ts)", () => {
  const input = {
    now: NOW,
    today: "2026-12-31",
    engagements: [
      {
        id: "eng-3",
        key: "E-3",
        state: "Active",
        startDate: "2026-12-31",
        endDate: null,
        jobTitle: "Stagehand",
        projectName: "Countdown",
        orgName: "Harbor Events",
        projectId: "proj-1",
      } as unknown as Engagement,
    ],
    shifts: [],
    records: [],
    docks: [],
    lodging: [],
    interviews: [],
  };

  it("lists an item dated today on the person's calendar", () => {
    expect(mergeUpcoming(input).map((i) => i.id)).toEqual(["start-eng-3"]);
  });

  // A New York shift at 20:00 on New Year's Eve, already 01:00 on New Year's Day in UTC.
  const shift: UpcomingItem = {
    id: "shift-1",
    kind: "shift",
    title: "Load-out",
    at: "2027-01-01T01:00:00Z",
    endsAt: "2027-01-01T05:00:00Z",
    timeZone: "America/New_York",
    orgName: null,
    projectName: null,
    engagementKey: null,
    detail: null,
  };
  const eventZone = { display: "event", viewerZone: null } as const;

  it("puts a timed item under its day in the zone its time is shown in", () => {
    expect(itemDay(shift, eventZone)).toBe("2026-12-31");
    expect(byDay([shift], eventZone).map(([day]) => day)).toEqual(["2026-12-31"]);
  });

  it("follows the person's own zone when they chose it", () => {
    const tokyo = { display: "viewer", viewerZone: "Asia/Tokyo" } as const;
    expect(itemDay(shift, tokyo)).toBe("2027-01-01");
  });

  it("keeps a date-only item on its own date", () => {
    const start = mergeUpcoming(input)[0] as UpcomingItem;
    expect(itemDay(start, eventZone)).toBe("2026-12-31");
  });
});

describe("an engagement's records calendar (components/engagement/tabs-client.tsx)", () => {
  // A set time at 20:00 on New Year's Eve in the project's New York zone, 01:00 on New Year's Day in UTC.
  const setTime = "2027-01-01T01:00:00Z";

  it("puts a record on its day in the project's zone", () => {
    expect(scheduleDay(setTime, "America/New_York", { display: "event", viewerZone: null })).toBe(
      "2026-12-31",
    );
  });

  it("keeps a record with no date on its placeholder date", () => {
    expect(
      scheduleDay("9999-12-31", "America/New_York", { display: "event", viewerZone: null }),
    ).toBe("9999-12-31");
  });
});
