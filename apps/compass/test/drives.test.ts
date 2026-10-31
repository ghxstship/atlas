import { describe, expect, it } from "vitest";
import { dialable, driveStatus, drivesByDay, todaysContacts } from "../src/domain/drives";
import { EXTERNAL_PAGES } from "../src/domain/external";

/** B5 (ADR 0144): More > Drives and the ground transport section, worked out on the device. */

const transfer = (over: Record<string, unknown>) => ({
  id: "t1",
  project_id: "p1",
  project_name: "Northwind Summer Series",
  transfer_key: "NWL-3",
  my_role: "Driver",
  pickup_place: "MIA",
  pickup_at: "2027-06-02T14:00:00Z",
  pickup_time_zone: "America/New_York",
  dropoff_place: "Crew Hotel",
  dropoff_at: "2027-06-02T15:00:00Z",
  dropoff_time_zone: "America/New_York",
  vehicle_label: "Van 1",
  seats: 7,
  passenger_names: ["Kai Morgan", "Sam Kowalski"],
  primary_passenger_name: "Kai Morgan",
  meets_service_identifier: "NW101",
  meets_arrives_at: "2027-06-02T13:40:00Z",
  status: "Assigned",
  ...over,
});
const zoneOf = () => "America/New_York";

describe("drives", () => {
  it("groups the person's drives by pickup day on the project calendar, from today", () => {
    const days = drivesByDay({
      transfers: [
        transfer({}),
        // 23:30 in New York on June 2 is June 3 in UTC: still June 2's drive.
        transfer({
          id: "t2",
          pickup_at: "2027-06-03T03:30:00Z",
          dropoff_at: "2027-06-03T04:30:00Z",
        }),
        transfer({
          id: "t3",
          pickup_at: "2027-06-04T14:00:00Z",
          dropoff_at: "2027-06-04T15:00:00Z",
        }),
        transfer({ id: "t4", my_role: "Passenger" }),
        transfer({
          id: "t5",
          pickup_at: "2027-05-30T14:00:00Z",
          dropoff_at: "2027-05-30T15:00:00Z",
        }),
      ],
      contacts: [
        {
          id: "c1",
          project_id: "p1",
          day: null,
          contact_role: "Transport",
          display_name: "Harbor Cars",
          phone: "+13055550100",
        },
        {
          id: "c2",
          project_id: "p1",
          day: "2027-06-04",
          contact_role: "Transport",
          display_name: "Night Dispatch",
          phone: "+13055550101",
        },
        {
          id: "c3",
          project_id: "p1",
          day: null,
          contact_role: "Medical",
          display_name: "Bay Medical",
          phone: "+13055550199",
        },
        {
          id: "c4",
          project_id: "p1",
          day: null,
          contact_role: "Transport",
          display_name: "Old Desk",
          phone: "305 555 0102",
        },
      ],
      zoneOf,
      now: Date.parse("2027-06-01T12:00:00Z"),
    });
    expect(days.map((d) => [d.day, d.drives.map((x) => x.id)])).toEqual([
      ["2027-06-02", ["t1", "t2"]],
      ["2027-06-04", ["t3"]],
    ]);
    expect(days[0]?.callContacts.map((c) => c.tel)).toEqual(["+13055550100"]);
    expect(days[1]?.callContacts.map((c) => c.name)).toEqual(["Harbor Cars", "Night Dispatch"]);
    expect(days[0]?.drives[0]).toMatchObject({
      primaryPassenger: "Kai Morgan",
      passengers: ["Kai Morgan", "Sam Kowalski"],
      seats: 7,
    });
  });

  it("works out the status from the clock", () => {
    const row = {
      pickupAt: "2027-06-02T14:00:00Z",
      dropoffAt: "2027-06-02T15:00:00Z",
      hasVehicle: true,
      hasDriver: true,
    };
    expect(driveStatus(row, Date.parse("2027-06-02T13:00:00Z"))).toBe("Assigned");
    expect(driveStatus(row, Date.parse("2027-06-02T14:30:00Z"))).toBe("Underway");
    expect(driveStatus(row, Date.parse("2027-06-02T15:00:00Z"))).toBe("Done");
    expect(driveStatus({ ...row, hasVehicle: false }, Date.parse("2027-06-02T13:00:00Z"))).toBe(
      "Unassigned",
    );
  });

  it("calls only a number that dials", () => {
    expect(dialable("+1 305 555 0100")).toBe("+13055550100");
    expect(dialable("305-555-0100")).toBeNull();
    expect(
      todaysContacts(
        [
          { id: "a", project_id: "p1", day: null, display_name: "Desk", phone: "+13055550100" },
          {
            id: "b",
            project_id: "p1",
            day: "2027-06-03",
            display_name: "Tomorrow",
            phone: "+13055550101",
          },
          { id: "c", project_id: "p1", day: null, display_name: "Member", phone: null },
        ],
        "p1",
        "2027-06-02",
      ).map((c) => c.name),
    ).toEqual(["Desk"]);
  });
});

describe("ground transport on travel and lodging", () => {
  it("lists the person's transfers on the project", () => {
    const page = EXTERNAL_PAGES["travel-and-lodging"];
    expect(page.tables).toContain("my_transfers");
    const sections = page.build({
      rows: (table) =>
        table === "my_transfers"
          ? [transfer({ my_role: "Passenger", passenger_names: ["Kai Morgan"] })]
          : [],
      projectId: "p1",
      personId: "kai",
      engagements: [],
      zoneOf: () => "America/New_York",
      todayOf: () => "2027-06-01",
    });
    const ground = sections.find((s) => s.id === "ground");
    expect(ground?.items[0]?.title).toBe("MIA → Crew Hotel");
    expect(ground?.items[0]?.tag?.key).toBe("gateway.enums.transferStatus.assigned");
  });
});
