import { describe, expect, it } from "vitest";
import {
  DAY_TYPES,
  dayTagsByDate,
  dayTypeSlug,
  dayTypeTone,
  deleteProjectDay,
  effectiveDayZone,
  listProjectDays,
  saveProjectDay,
  type ProjectDay,
} from "../src/schedule-days.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** Project day types (B4, G-38, migration 2930): the enum, tones, zones, reads, writes and the tag band. */

const row = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  project_id: "p1",
  day_on: "2027-11-14",
  day_type: "Travel",
  sort_order: 2,
  label: "Travel to Austin",
  venue_id: null,
  location_text: "Austin, Texas",
  time_zone: "America/Chicago",
  scope_node_id: null,
  team_code: null,
  updated_at: "2027-01-01T00:00:00Z",
  project: { project_key: "NWS", time_zone: "America/New_York" },
  venue: null,
  scope_node: null,
  ...over,
});

describe("day types", () => {
  it("keeps the database's seven types in order, each with a category and an icon", () => {
    expect(DAY_TYPES).toEqual([
      "Load In",
      "Show",
      "Load Out",
      "Travel",
      "Off",
      "Rehearsal",
      "Other",
    ]);
    const categories = DAY_TYPES.map((t) => dayTypeTone(t).category);
    expect(new Set(categories).size).toBe(7);
    expect(DAY_TYPES.every((t) => dayTypeTone(t).icon.length > 0)).toBe(true);
    expect(dayTypeSlug("Load Out")).toBe("loadOut");
  });

  it("reads a segment in its venue's zone, else its node's venue, else its own, else the project's", () => {
    expect(
      effectiveDayZone({
        venueZone: "Europe/London",
        nodeVenueZone: null,
        storedZone: null,
        projectZone: "UTC",
      }),
    ).toBe("Europe/London");
    expect(
      effectiveDayZone({
        venueZone: null,
        nodeVenueZone: "Asia/Tokyo",
        storedZone: null,
        projectZone: "UTC",
      }),
    ).toBe("Asia/Tokyo");
    expect(
      effectiveDayZone({
        venueZone: null,
        nodeVenueZone: null,
        storedZone: "America/Chicago",
        projectZone: "UTC",
      }),
    ).toBe("America/Chicago");
    expect(
      effectiveDayZone({
        venueZone: null,
        nodeVenueZone: null,
        storedZone: null,
        projectZone: "UTC",
      }),
    ).toBe("UTC");
  });
});

describe("project days", () => {
  it("lists live days of the org's projects in the window", async () => {
    const { db, calls } = fakeClient({ "from:project_days": [okResponse([row()])] });
    const listed = await listProjectDays(db, {
      orgId: "o1",
      projectIds: ["p1"],
      from: "2027-11-01",
      to: "2027-11-30",
    });
    expect(listed.ok && listed.data[0]).toMatchObject({
      projectKey: "NWS",
      dayType: "Travel",
      timeZone: "America/Chicago",
      label: "Travel to Austin",
    });
    expect(calls[0]?.steps).toContainEqual(["is", ["deleted_at", null]]);
    expect(calls[0]?.steps).toContainEqual(["gte", ["day_on", "2027-11-01"]]);
  });

  it("asks nothing for no projects", async () => {
    const { db, calls } = fakeClient({});
    const listed = await listProjectDays(db, { orgId: "o1", projectIds: [] });
    expect(listed.ok && listed.data).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("drops a venue when a Show node is named; the node's venue, if any, sets the zone in the database", async () => {
    const { db, calls } = fakeClient({ "from:project_days": [okResponse({ id: "d2" })] });
    await saveProjectDay(db, {
      projectId: "p1",
      dayOn: "2027-11-13",
      dayType: "Show",
      sortOrder: 1,
      scopeNodeId: "n1",
      venueId: "v1",
      timeZone: "America/Chicago",
      label: "  ",
    });
    const insert = calls[0]?.steps.find((s) => s[0] === "insert")?.[1][0] as Record<
      string,
      unknown
    >;
    expect(insert).toMatchObject({
      venue_id: null,
      time_zone: "America/Chicago",
      scope_node_id: "n1",
      label: null,
      project_id: "p1",
    });
  });

  it("returns the split limit as a refusal", async () => {
    const { db } = fakeClient({
      "from:project_days": [
        errorResponse(
          "XR001",
          "project_day_split_limit: A day splits into at most four segments.",
          "project_day_split_limit",
        ),
      ],
    });
    const saved = await saveProjectDay(db, {
      projectId: "p1",
      dayOn: "2027-11-14",
      dayType: "Off",
      sortOrder: 4,
    });
    expect(!saved.ok && saved.error).toMatchObject({
      kind: "refusal",
      rule: "project_day_split_limit",
    });
  });

  it("soft deletes, and reports a day it could not see", async () => {
    const { db } = fakeClient({ "from:project_days": [okResponse([])] });
    const deleted = await deleteProjectDay(db, "d1");
    expect(!deleted.ok && deleted.error.kind).toBe("not-found");
  });
});

describe("the day-type band", () => {
  const day = (key: string, type: ProjectDay["dayType"], order = 1): ProjectDay => ({
    id: `${key}${type}`,
    projectId: key,
    projectKey: key,
    dayOn: "2027-11-14",
    dayType: type,
    sortOrder: order,
    label: null,
    venueId: null,
    venueName: null,
    locationText: null,
    timeZone: "UTC",
    storedTimeZone: null,
    scopeNodeId: null,
    scopeNodeName: null,
    teamCode: null,
    updatedAt: "",
  });

  it("names one project's segments in order", () => {
    const tags = dayTagsByDate(
      [day("NWS", "Travel", 2), day("NWS", "Load Out", 1)],
      (d) => d.dayType,
    );
    expect(tags.get("2027-11-14")?.tags.map((t) => t.label)).toEqual(["Load Out", "Travel"]);
  });

  it("prefixes project keys and folds past three into +n", () => {
    const tags = dayTagsByDate(
      [day("AAA", "Show"), day("BBB", "Load In"), day("CCC", "Off"), day("DDD", "Travel")],
      (d) => d.dayType,
      { prefixKeys: true },
    );
    expect(tags.get("2027-11-14")).toMatchObject({ more: 1 });
    expect(tags.get("2027-11-14")?.tags.map((t) => t.label)).toEqual([
      "AAA Show",
      "BBB Load In",
      "CCC Off",
    ]);
  });
});
