import { describe, expect, it } from "vitest";

import { buildItinerary, hasItineraryChanges, type ItineraryTravel } from "../src/itinerary.ts";

const flight = (over: Partial<ItineraryTravel> = {}): ItineraryTravel => ({
  id: "t1",
  travel_mode: "Flight",
  operator_name: "Coastal Air",
  service_identifier: "CA 210",
  departs_from: "LAX",
  departs_at: "2027-06-02T06:00:00Z",
  departs_time_zone: "America/Los_Angeles",
  arrives_at_place: "JFK",
  arrives_at: "2027-06-02T14:30:00Z",
  arrives_time_zone: "America/New_York",
  ...over,
});

describe("buildItinerary", () => {
  it("puts a 23:00 Los Angeles departure arriving in New York on its departure day", () => {
    // 23:00 on June 1 in Los Angeles is 06:00 UTC on June 2.
    const result = buildItinerary({
      travel: [flight()],
      lodging: [],
      changes: [],
      projectZone: "America/New_York",
    });
    expect(result.days.map((d) => d.date)).toEqual(["2027-06-01"]);
    expect(result.days[0]?.items[0]?.type).toBe("travel");
  });

  it("keeps check-in and check-out on their calendar dates across a daylight saving change", () => {
    const result = buildItinerary({
      travel: [],
      lodging: [
        {
          id: "a1",
          hotel_name: "Harbor Inn",
          block_title: "Crew Hotel",
          check_in_on: "2027-03-13",
          check_out_on: "2027-03-15",
        },
      ],
      changes: [],
      projectZone: "America/New_York",
    });
    expect(result.days.map((d) => [d.date, d.items.map((i) => i.type)])).toEqual([
      ["2027-03-13", ["check-in"]],
      ["2027-03-15", ["check-out"]],
    ]);
  });

  it("puts set times on their day in the project zone, in order with the day's travel", () => {
    const result = buildItinerary({
      travel: [
        flight({
          id: "t2",
          departs_at: "2027-06-02T13:00:00Z",
          departs_time_zone: "America/New_York",
        }),
      ],
      lodging: [],
      setTimes: [
        // 01:30 UTC on June 3 is 21:30 on June 2 in New York.
        {
          id: "c1",
          label: "Headliner Set",
          planned_at: "2027-06-03T01:30:00Z",
          duration: "01:30:00",
        },
        { id: "c0", label: "Not planned", planned_at: null, duration: null },
      ],
      changes: [],
      projectZone: "America/New_York",
    });
    expect(result.days.map((d) => [d.date, d.items.map((i) => i.id)])).toEqual([
      ["2027-06-02", ["t2", "c1"]],
    ]);
  });

  it("marks changed and new items, lists removed ones, and keeps the baseline", () => {
    const result = buildItinerary({
      travel: [flight(), flight({ id: "t3", departs_at: "2027-06-04T15:00:00Z" })],
      lodging: [
        {
          id: "a1",
          hotel_name: "Harbor Inn",
          block_title: null,
          check_in_on: "2027-06-02",
          check_out_on: "2027-06-05",
        },
      ],
      changes: [
        {
          subject_kind: "travel",
          subject_id: "t1",
          change_kind: "changed",
          changed_fields: ["departs_at"],
          changed_at: "2027-06-01T10:00:00Z",
          baseline_at: "2027-05-30T09:00:00Z",
          title: null,
        },
        {
          subject_kind: "travel",
          subject_id: "t3",
          change_kind: "added",
          changed_fields: [],
          changed_at: "2027-06-01T10:00:00Z",
          baseline_at: "2027-05-30T09:00:00Z",
          title: null,
        },
        {
          subject_kind: "lodging",
          subject_id: "a1",
          change_kind: "changed",
          changed_fields: ["check_out_on"],
          changed_at: "2027-06-01T10:00:00Z",
          baseline_at: "2027-05-30T09:00:00Z",
          title: null,
        },
        {
          subject_kind: "travel",
          subject_id: "t9",
          change_kind: "removed",
          changed_fields: [],
          changed_at: "2027-06-01T10:00:00Z",
          baseline_at: "2027-05-30T09:00:00Z",
          title: "MIA → JFK",
        },
      ],
      projectZone: "America/New_York",
    });
    const items = result.days.flatMap((d) => d.items);
    expect(items.find((i) => i.id === "t1")?.changed).toEqual({
      kind: "changed",
      fields: ["departs_at"],
    });
    expect(items.find((i) => i.id === "t3")?.changed).toEqual({ kind: "added", fields: [] });
    expect(items.find((i) => i.id === "a1" && i.type === "check-in")?.changed).toBeNull();
    expect(items.find((i) => i.id === "a1" && i.type === "check-out")?.changed).toEqual({
      kind: "changed",
      fields: ["check_out_on"],
    });
    expect(result.removed).toEqual([
      { kind: "travel", id: "t9", title: "MIA → JFK", changedAt: "2027-06-01T10:00:00Z" },
    ]);
    expect(result.baselineAt).toBe("2027-05-30T09:00:00Z");
    expect(hasItineraryChanges(result)).toBe(true);
  });

  it("hides changes at or before a baseline given back by a visit", () => {
    const result = buildItinerary({
      travel: [flight()],
      lodging: [],
      changes: [
        {
          subject_kind: "travel",
          subject_id: "t1",
          change_kind: "changed",
          changed_fields: ["departs_at"],
          changed_at: "2027-06-01T10:00:00Z",
          baseline_at: "2027-05-30T09:00:00Z",
          title: null,
        },
      ],
      projectZone: "America/New_York",
      hideAtOrBefore: "2027-06-01T10:00:00Z",
    });
    expect(result.days[0]?.items[0]?.changed).toBeNull();
    expect(hasItineraryChanges(result)).toBe(false);
  });
});
