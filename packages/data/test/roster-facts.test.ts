import { describe, expect, it } from "vitest";
import { setRosterLock, rosterLocked } from "../src/roster.ts";
import {
  clearRosterProjectFact,
  getMyPreviousRosterFacts,
  getRosterProjectFacts,
  listRosterFactStatus,
  listRosterTravelDayCounts,
  listRosterTravelParty,
  offeredFactKinds,
  PROJECT_FACT_KINDS,
  rosterFactChip,
  saveRosterTravelRequest,
  saveRosterVehicle,
  searchAirports,
  SHOE_SIZE_SYSTEMS,
} from "../src/roster-facts.ts";
import { workDetailLogKey } from "../src/work-details.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const facts = {
  roster_entry_id: "r1",
  engagement_id: "e1",
  org_id: "o1",
  person_id: "kai",
  standing: "Company",
  offered: { travel: true, lodging: false, uniforms: true, parking: false },
  present: { travel: true, uniform: false, vehicle: false },
  entered_by_person: { travel: true, uniform: false, vehicle: false },
  readable: ["Travel", "Uniform", "Vehicle"],
  travel: {
    inbound_airport_code: "MIA",
    inbound_airport_name: "Miami International Airport",
    outbound_airport_code: null,
    outbound_airport_name: null,
    inbound_on: "2027-06-01",
    outbound_on: null,
    seat_preference: "Aisle",
    meal_preference: null,
    needs_ground_transport: true,
    needs_lodging: false,
    travel_notes: null,
    updated_at: "2026-10-28T12:00:00Z",
  },
  uniform: null,
  vehicle: null,
};

describe("roster project facts (R5)", () => {
  it("reads an entry's facts, and no standing is not-found", async () => {
    const { db } = moduleClient({
      "rpc:roster_project_facts": [
        okResponse(facts),
        errorResponse("42501", "the roster entry is not readable"),
      ],
    });
    const read = await getRosterProjectFacts(db, "r1");
    expect(read.ok && read.data).toMatchObject({
      standing: "Company",
      enteredByPerson: { travel: true, uniform: false, vehicle: false },
      travel: { inboundAirportCode: "MIA", needsGroundTransport: true },
      uniform: null,
    });
    const denied = await getRosterProjectFacts(db, "r2");
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.error.kind).toBe("not-found");
  });

  it("maps status rows to chips: On file, Missing, Not offered", async () => {
    const { db } = moduleClient({
      "rpc:roster_project_fact_status": [
        okResponse([
          {
            roster_entry_id: "r1",
            travel_offered: true,
            lodging_offered: false,
            uniforms_offered: true,
            parking_offered: false,
            has_travel: true,
            has_uniform: false,
            has_vehicle: false,
            travel_entered_by_person: true,
            uniform_entered_by_person: false,
            vehicle_entered_by_person: false,
          },
        ]),
      ],
    });
    const result = await listRosterFactStatus(db, "e1");
    const status = result.ok ? result.data[0] : undefined;
    expect(status && rosterFactChip(status, "travel")).toBe("onFile");
    expect(status && rosterFactChip(status, "uniform")).toBe("missing");
    expect(status && rosterFactChip(status, "vehicle")).toBe("notOffered");
    expect(offeredFactKinds(facts.offered)).toEqual(["Travel", "Uniform"]);
  });

  it("sends every argument on a save, cleared values as null", async () => {
    const { db, calls } = moduleClient({
      "rpc:save_roster_travel_request": [
        okResponse("t1"),
        errorResponse("XR001", "airport_unknown: Choose.", "airport_unknown"),
      ],
      "rpc:save_roster_vehicle": [okResponse("v1")],
      "rpc:clear_roster_project_fact": [okResponse(null)],
    });
    const input = {
      inboundAirportCode: "MIA",
      outboundAirportCode: null,
      inboundOn: "2027-06-01",
      outboundOn: null,
      seatPreference: null,
      mealPreference: null,
      needsGroundTransport: false,
      needsLodging: false,
      travelNotes: null,
    };
    expect(await saveRosterTravelRequest(db, "r1", input)).toEqual({ ok: true, data: "t1" });
    expect(stepsOf(calls[0], "args")[0]?.[0]).toMatchObject({
      p_roster_entry_id: "r1",
      p_inbound_airport_code: "MIA",
      p_outbound_airport_code: null,
      p_needs_lodging: false,
    });
    const refused = await saveRosterTravelRequest(db, "r1", {
      ...input,
      inboundAirportCode: "XQZ",
    });
    expect(!refused.ok && refused.error).toMatchObject({
      kind: "refusal",
      rule: "airport_unknown",
    });
    await saveRosterVehicle(db, "r1", {
      make: "Ford",
      model: "Transit",
      color: null,
      plate: "ABC1234",
      plateRegion: "US-FL",
    });
    await clearRosterProjectFact(db, "r1", "Vehicle");
    expect(stepsOf(calls[3], "args")[0]?.[0]).toEqual({
      p_roster_entry_id: "r1",
      p_kind: "Vehicle",
    });
  });

  it("offers the last values of a kind as a pre-fill", async () => {
    const { db } = moduleClient({
      "rpc:my_previous_roster_facts": [
        okResponse({
          make: "Ford",
          model: "Transit",
          color: null,
          plate: "ABC1234",
          plate_region: "US-FL",
        }),
        okResponse(null),
      ],
    });
    const last = await getMyPreviousRosterFacts(db, "Vehicle");
    expect(last.ok && last.data).toMatchObject({
      kind: "Vehicle",
      value: { plate: "ABC1234", plateRegion: "US-FL" },
    });
    const none = await getMyPreviousRosterFacts(db, "Uniform");
    expect(none.ok && none.data).toEqual({ kind: "Uniform", value: null });
  });

  it("searches airports by exact code first, then names and cities", async () => {
    const mia = {
      iata_code: "MIA",
      name: "Miami International Airport",
      municipality: "Miami",
      country_code: "US",
    };
    const opa = {
      iata_code: "OPF",
      name: "Miami-Opa Locka Executive Airport",
      municipality: "Miami",
      country_code: "US",
    };
    const { db, calls } = moduleClient({
      "from:airports": [okResponse(mia), okResponse([opa, mia])],
    });
    const result = await searchAirports(db, "mia");
    expect(result.ok && result.data.map((a) => a.iataCode)).toEqual(["MIA", "OPF"]);
    expect(stepsOf(calls[0], "eq")).toEqual([["iata_code", "MIA"]]);
    expect(stepsOf(calls[1], "limit")).toEqual([[20]]);
    expect(await searchAirports(db, "  ")).toEqual({ ok: true, data: [] });
  });

  it("reads the travel party and its day counts", async () => {
    const { db } = moduleClient({
      "rpc:roster_travel_party": [
        okResponse([
          {
            roster_entry_id: "r1",
            engagement_id: "e1",
            party_name: "Bayside Audio",
            person_id: "kai",
            person_name: "Kai Morgan",
            role_code: null,
            arrival_starts_at: null,
            arrival_ends_at: null,
            arrival_time_zone: null,
            travel: facts.travel,
            room: {
              assigned: true,
              check_in_on: "2027-06-01",
              check_out_on: "2027-06-04",
              block_name: "Hotel Cadillac",
            },
            pickup: { booked: false },
            pass: null,
          },
        ]),
      ],
      "rpc:roster_travel_day_counts": [
        okResponse([
          {
            day: "2027-06-01",
            arriving: 1,
            departing: 0,
            on_site: 1,
            rooms_needed: 1,
            pickups_needed: 1,
            truncated: false,
          },
        ]),
      ],
    });
    const party = await listRosterTravelParty(db, "p1");
    expect(party.ok && party.data[0]).toMatchObject({
      room: { assigned: true, blockName: "Hotel Cadillac" },
      pickupBooked: false,
      passIssued: null,
    });
    const counts = await listRosterTravelDayCounts(db, "p1");
    expect(counts.ok && counts.data[0]).toMatchObject({
      onSite: 1,
      roomsNeeded: 1,
      pickupsNeeded: 1,
    });
  });

  it("labels the access log actions of project facts", () => {
    expect(workDetailLogKey("roster_travel_requests.insert")).toBe("travelSaved");
    expect(workDetailLogKey("roster_travel_requests.delete")).toBe("travelCleared");
    expect(workDetailLogKey("roster_uniform_sizes.update")).toBe("uniformSaved");
    expect(workDetailLogKey("roster_vehicles.delete")).toBe("vehicleCleared");
    expect(workDetailLogKey("project_facts.viewed")).toBe("projectFactsViewed");
    expect(workDetailLogKey("project_facts.counted")).toBe("projectFactsCounted");
    expect(workDetailLogKey("project_facts.expired")).toBe("projectFactsExpired");
    expect(workDetailLogKey("project_facts.erased")).toBe("projectFactsErased");
  });

  it("names the kinds and shoe systems from the database enums", () => {
    expect(PROJECT_FACT_KINDS).toEqual(["Travel", "Uniform", "Vehicle"]);
    expect(SHOE_SIZE_SYSTEMS).toEqual(["US Men", "US Women", "EU", "UK"]);
  });
});

describe("the names lock (R5, G-142)", () => {
  it("sets and clears the lock", async () => {
    const { db, calls } = moduleClient({
      "rpc:set_roster_lock": [okResponse(null), okResponse(null)],
    });
    await setRosterLock(db, "e1", "2027-05-20T23:59:00Z");
    await setRosterLock(db, "e1", null);
    expect(stepsOf(calls[1], "args")[0]?.[0]).toEqual({ p_engagement_id: "e1", p_locks_at: null });
  });

  it("is locked only once the instant has passed", () => {
    const now = new Date("2027-05-21T00:00:00Z");
    expect(rosterLocked(null, now)).toBe(false);
    expect(rosterLocked("2027-05-20T23:59:00Z", now)).toBe(true);
    expect(rosterLocked("2027-05-22T00:00:00Z", now)).toBe(false);
  });
});
