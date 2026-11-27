import type { Engagement, Representation } from "@xos/data/gateway";
import { describe, expect, it } from "vitest";
import { needsYou } from "../lib/home";
import { blockDays, blockRange } from "../lib/profile";

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
