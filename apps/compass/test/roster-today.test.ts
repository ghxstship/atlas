import { describe, expect, it } from "vitest";
import { rosterToday } from "../src/domain/rosterToday";

/**
 * Compass Today for a person who works the project only on a party's roster (R8): the call from their own shift
 * today or their arrival window, their parking pass with zones and vehicle, the gear they hold and what waits at
 * the desk, all from their own rows only.
 */
const base = {
  entries: [
    {
      id: "r1",
      project_id: "p1",
      arrival_starts_at: "2027-06-01T12:00:00Z",
      arrival_ends_at: "2027-06-01T14:00:00Z",
      arrival_time_zone: "America/New_York",
    },
  ],
  allocations: [
    {
      id: "a1",
      roster_entry_id: "r1",
      kind: "Asset",
      item_name: "Radios",
      quantity: 1,
      allocation_state: "Approved",
      display_status: "Reserved",
    },
    {
      id: "a2",
      roster_entry_id: "r1",
      kind: "Asset",
      item_name: "Carts",
      quantity: 1,
      allocation_state: "Approved",
      display_status: "Issued",
    },
    {
      id: "a3",
      roster_entry_id: "r1",
      kind: "Credential",
      item_name: "Crew",
      quantity: 1,
      allocation_state: "Requested",
      display_status: "Requested",
    },
    {
      id: "a4",
      roster_entry_id: "r2",
      kind: "Asset",
      item_name: "Radios",
      quantity: 1,
      allocation_state: "Approved",
      display_status: "Reserved",
    },
  ],
  passes: [
    {
      id: "c1",
      project_id: "p1",
      category_name: "Crew Parking",
      zone_names: ["Lot A"],
      vehicle_make: "Ford",
      vehicle_model: "Transit",
      vehicle_color: "White",
      revoked_at: null,
    },
    {
      id: "c2",
      project_id: "p1",
      category_name: "Old Pass",
      zone_names: [],
      revoked_at: "2027-05-01T00:00:00Z",
    },
  ],
  custody: [
    { id: "k1", roster_entry_id: "r1", class_name: "Radios", asset_tag: "NWL-RAD-001" },
    { id: "k2", roster_entry_id: "r2", class_name: "Radios", asset_tag: "NWL-RAD-002" },
  ],
  shifts: [],
  projectTimeZone: "America/New_York",
  today: "2027-06-01",
};

describe("roster Today", () => {
  it("calls the person at the start of their arrival window", () => {
    const day = rosterToday(base);
    expect(day.call).toEqual({
      at: "2027-06-01T12:00:00Z",
      timeZone: "America/New_York",
      source: "arrival",
    });
    expect(day.arrival?.endsAt).toBe("2027-06-01T14:00:00Z");
  });

  it("calls them at their own first shift today when they have one", () => {
    const day = rosterToday({
      ...base,
      shifts: [
        { starts_at: "2027-06-01T15:00:00Z", time_zone: "America/New_York" },
        { starts_at: "2027-06-01T11:00:00Z", time_zone: "America/New_York" },
        { starts_at: "2027-06-02T11:00:00Z", time_zone: "America/New_York" },
      ],
    });
    expect(day.call).toMatchObject({ at: "2027-06-01T11:00:00Z", source: "shift" });
  });

  it("names the live parking pass by zones and vehicle, never the plate", () => {
    expect(rosterToday(base).parking).toEqual([
      { id: "c1", category: "Crew Parking", zones: ["Lot A"], vehicle: "Ford Transit White" },
    ]);
  });

  it("lists only their own gear and what waits at the desk", () => {
    const day = rosterToday(base);
    expect(day.gear).toEqual([{ id: "k1", label: "Radios (NWL-RAD-001)" }]);
    expect(day.pickups).toEqual([{ id: "a1", label: "Radios (1)", status: "Reserved" }]);
  });

  it("has no call without an arrival or a shift", () => {
    const day = rosterToday({ ...base, entries: [{ id: "r1" }] });
    expect(day.call).toBeNull();
    expect(day.arrival).toBeNull();
  });
});
