/**
 * Contract tests for B5: the flight grid, transfers and vehicles, space bookings, local contacts and blocks by night,
 * with the acts without rooms and the rooming list (migrations 2940 to 2946). Requests run through `contractApp` and
 * every success is checked against openapi/v1.json with `expectContract`. Visibility, logging and refusals are the
 * database's (pgTAP 2940 to 2946); here the views hold rows as a reader would see them, and the RPCs answer as the
 * database does, 42501 standing in for a reader without hospitality.fulfillment.read (404).
 */
import { describe, expect, it } from "vitest";
import { handlers as hospitality } from "../src/handlers/hospitality.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, requests, success } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(56000 + n).padStart(12, "0")}`;
const PROJECT = id(1);
const T = "2027-06-02T14:00:00.000Z";

const segment = (n: number, mode: "Flight" | "Ground") => ({
  id: id(10 + n),
  org_id: ORG,
  project_id: PROJECT,
  person_id: id(2),
  traveler_name: "Kai Morgan",
  engagement_id: null,
  fulfillment_id: null,
  travel_mode: mode,
  operator_name: "Northwind Air",
  service_identifier: "NW101",
  confirmation_identifier: "QX7Y2B",
  departs_from: "LHR",
  departs_at: T,
  departs_time_zone: "Europe/London",
  arrives_at_place: "MIA",
  arrives_at: null,
  arrives_time_zone: "America/New_York",
  phase: "Upcoming",
  journey_id: id(10 + n),
  leg_number: 1,
  leg_count: 1,
  final_arrival_at: null,
  final_arrival_place: "MIA",
  final_arrival_time_zone: "America/New_York",
});

function world() {
  const db = memoryDb(
    {
      travel_grid: [segment(1, "Flight"), segment(2, "Ground")],
      transfer_board: [
        {
          id: id(20),
          org_id: ORG,
          project_id: PROJECT,
          transfer_number: 3,
          transfer_key: "NWL-3",
          fulfillment_id: null,
          vehicle_id: id(21),
          vehicle_label: "Van 1",
          vehicle_type: "Van",
          seats: 7,
          driver_person_id: id(22),
          driver_name: "Dave Lindqvist",
          pickup_place: "Miami International Airport (MIA)",
          pickup_at: T,
          pickup_time_zone: "America/New_York",
          dropoff_place: "Crew Hotel",
          dropoff_at: "2027-06-02T15:00:00.000Z",
          dropoff_time_zone: "America/New_York",
          meets_travel_segment_id: id(11),
          meets_service_identifier: "NW101",
          meets_flight_arrives_at: null,
          meets_flight_after_pickup: false,
          passenger_count: 2,
          primary_passenger_id: id(2),
          primary_passenger_name: "Kai Morgan",
          tight_turnaround: false,
          status: "Assigned",
          notes: null,
        },
      ],
      transfer_vehicles: [
        {
          id: id(21),
          org_id: ORG,
          project_id: PROJECT,
          counterparty_id: null,
          label: "Van 1",
          vehicle_type: "Van",
          seats: 7,
          deleted_at: null,
        },
      ],
      space_booking_board: [
        {
          id: id(30),
          org_id: ORG,
          project_id: PROJECT,
          space_id: id(31),
          space_name: "Green Room A",
          space_capacity: 10,
          venue_name: "Northwind Pier Pavilion",
          engagement_id: null,
          engagement_cue_id: null,
          purpose: "Green Room",
          booking_mode: "Shared",
          party_size: 6,
          starts_at: T,
          ends_at: "2027-06-02T18:00:00.000Z",
          act_name: null,
          set_label: null,
          set_planned_at: null,
          set_moved: false,
          conflict_group: null,
          group_size: 1,
          group_peak_party: 6,
          over_capacity: false,
        },
      ],
      project_local_contacts: [
        {
          id: id(40),
          org_id: ORG,
          project_id: PROJECT,
          venue_id: null,
          day: null,
          contact_role: "Transport",
          contact_title: "Dispatch",
          source: "Contact",
          display_name: "Harbor Car Service",
          organization_name: null,
          phone: "+13055550100",
          email: "dispatch@harbor-cars.test",
          audience: "Shared",
          member_active: true,
        },
      ],
      accommodation_block_nights: [
        {
          block_id: id(50),
          org_id: ORG,
          project_id: PROJECT,
          block_number: 6,
          title: "Harborview Crew Block",
          night: "2027-06-01",
          rooms_held: 10,
          assigned: 4,
          free: 6,
          release_on: "2027-05-15",
          nightly_rate_minor: 18900,
          currency_code: "USD",
        },
      ],
    },
    {
      acts_without_rooms: (args) => {
        if (args["p_project_id"] !== PROJECT) throw { code: "42501", message: "hospitality.fulfillment.read is required" };
        return [{ engagement_id: id(60), act_name: "Arturo Bell", engagement_state: "Onboarding", people_count: 1 }];
      },
      rooming_list: (args) => {
        if (args["p_project_id"] !== PROJECT) throw { code: "42501", message: "hospitality.fulfillment.read is required" };
        return [
          {
            roster_entry_id: id(70),
            engagement_id: id(71),
            party_name: "Bayside Audio",
            person_id: id(2),
            person_name: "Kai Morgan",
            role_code: "9000.50.02",
            suggested_stays: [{ check_in_on: "2027-06-01", check_out_on: "2027-06-04", source: "Travel" }],
            assigned_stays: [],
            uncovered_nights: 3,
            status: "Missing",
            cost: [],
            lodging_allocation_id: null,
          },
        ];
      },
    },
  );
  return requests(contractApp({ handlers: [hospitality], db }));
}

describe("Hospitality: flights, transfers, space bookings, local contacts and nights (B5)", () => {
  it("lists flights only, and reads one", async () => {
    const http = world();
    const page = (await expectContract(await success(http.get("/flights")), "flights.list")) as {
      data: { travel_mode?: string; id: string }[];
    };
    expect(page.data.map((r) => r.id)).toEqual([id(11)]);
    await expectContract(await success(http.get(`/flights/${id(11)}`)), "flights.get");
    expect((await http.get(`/flights/${id(12)}`)).status).toBe(404);
  });

  it("lists and reads transfers and vehicles", async () => {
    const http = world();
    const page = (await expectContract(await success(http.get("/transfers")), "transfers.list")) as {
      data: { status: string }[];
    };
    expect(page.data[0]?.status).toBe("Assigned");
    await expectContract(await success(http.get(`/transfers/${id(20)}`)), "transfers.get");
    await expectContract(await success(http.get("/transfer-vehicles")), "transferVehicles.list");
    await expectContract(await success(http.get(`/transfer-vehicles/${id(21)}`)), "transferVehicles.get");
  });

  it("lists and reads space bookings, and lists local contacts", async () => {
    const http = world();
    await expectContract(await success(http.get("/space-bookings")), "spaceBookings.list");
    await expectContract(await success(http.get(`/space-bookings/${id(30)}`)), "spaceBookings.get");
    const contacts = (await expectContract(await success(http.get("/local-contacts")), "localContacts.list")) as {
      data: { phone: string | null }[];
    };
    expect(contacts.data[0]?.phone).toBe("+13055550100");
  });

  it("lists nights, the acts without rooms and the rooming list", async () => {
    const http = world();
    await expectContract(await success(http.get("/accommodation-nights")), "accommodationNights.list");
    const acts = (await expectContract(
      await success(http.get(`/accommodation-nights/acts-without-rooms?project_id=${PROJECT}`)),
      "accommodationNights.actsWithoutRooms",
    )) as { data: { act_name: string }[] };
    expect(acts.data[0]?.act_name).toBe("Arturo Bell");
    const rooming = (await expectContract(
      await success(http.get(`/accommodation-nights/rooming-list?project_id=${PROJECT}`)),
      "accommodationNights.roomingList",
    )) as { data: { status: string }[] };
    expect(rooming.data[0]?.status).toBe("Missing");
    expect((await http.get(`/accommodation-nights/rooming-list?project_id=${id(98)}`)).status).toBe(404);
  });
});
