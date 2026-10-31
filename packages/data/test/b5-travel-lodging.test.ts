import { describe, expect, it } from "vitest";
import { listTravelGrid } from "../src/hospitality.ts";
import {
  E164,
  createLocalContact,
  listProjectLocalContacts,
  sortLocalContacts,
  toE164,
  updateLocalContact,
} from "../src/local-contacts.ts";
import {
  buildNightsMatrix,
  daysUntil,
  listBudgetLineLodging,
  listRoomingList,
  parseRoomingEntry,
  setBlockBudgetLine,
  type BlockNight,
} from "../src/lodging.ts";
import { conflictGroups, setTimeWindow, toSpaceBooking } from "../src/space-bookings.ts";
import {
  addTransferPassenger,
  cancelTransfer,
  createTransfer,
  getTransfer,
  listTransferPersonOptions,
  listTransfers,
  restoreTransfer,
  setPrimaryPassenger,
  toTransfer,
  updateTransfer,
  type TransferInput,
} from "../src/transfers.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const boardRow = {
  id: "t1",
  project_id: "p1",
  transfer_number: 3,
  transfer_key: "NWL-3",
  fulfillment_id: null,
  vehicle_id: "v1",
  vehicle_label: "Van 1",
  vehicle_type: "Van",
  seats: 2,
  driver_person_id: "dave",
  driver_name: "Dave Lindqvist",
  pickup_place: "MIA",
  pickup_at: "2027-06-02T14:00:00Z",
  pickup_time_zone: "America/New_York",
  dropoff_place: "Crew Hotel",
  dropoff_at: "2027-06-02T15:00:00Z",
  dropoff_time_zone: "America/New_York",
  meets_travel_segment_id: "s1",
  meets_service_identifier: "NW101",
  meets_flight_arrives_at: "2027-06-02T14:20:00Z",
  meets_flight_after_pickup: true,
  passenger_count: 2,
  primary_passenger_id: "kai",
  primary_passenger_name: "Kai Morgan",
  tight_turnaround: null,
  status: "Assigned",
  notes: null,
};

const input: TransferInput = {
  fulfillmentId: null,
  vehicleId: "v1",
  driverPersonId: "dave",
  pickupPlace: "MIA",
  pickupAt: "2027-06-02T14:00:00Z",
  pickupTimeZone: "America/New_York",
  dropoffPlace: "Crew Hotel",
  dropoffAt: "2027-06-02T15:00:00Z",
  dropoffTimeZone: "America/New_York",
  meetsSegmentId: null,
  notes: null,
};

describe("transfers", () => {
  it("maps the board, with warnings defaulting to false and an unknown status to Unassigned", () => {
    const t = toTransfer({ ...boardRow, status: "Teleported" } as never);
    expect(t.key).toBe("NWL-3");
    expect(t.flightLandsAfterPickup).toBe(true);
    expect(t.tightTurnaround).toBe(false);
    expect(t.status).toBe("Unassigned");
  });

  it("lists the org's board with the project and window filters", async () => {
    const { db, calls } = fakeClient({ "from:transfer_board": [okResponse([boardRow])] });
    const r = await listTransfers(db, { orgId: "o1", projectId: "p1", from: "2027-06-02T00:00:00Z", to: "2027-06-03T00:00:00Z" });
    expect(r.ok && r.data[0]?.driverName).toBe("Dave Lindqvist");
    const steps = calls[0]?.steps.map(([m, a]) => `${m}:${String(a[0])}`) ?? [];
    expect(steps).toEqual(expect.arrayContaining(["eq:org_id", "eq:project_id", "gte:pickup_at", "lt:pickup_at"]));
  });

  it("reads a transfer with its passengers named through person_names, primary first", async () => {
    const { db } = fakeClient({
      "from:transfer_board": [okResponse(boardRow)],
      "from:transfer_passengers": [
        okResponse([
          { id: "q2", person_id: "sam", is_primary: false },
          { id: "q1", person_id: "kai", is_primary: true },
        ]),
      ],
      "rpc:person_names": [
        okResponse([
          { person_id: "kai", full_name: "Kai Morgan" },
          { person_id: "sam", full_name: "Sam Kowalski" },
        ]),
      ],
    });
    const r = await getTransfer(db, "t1");
    expect(r.ok && r.data.passengers.map((p) => p.personName)).toEqual(["Kai Morgan", "Sam Kowalski"]);
  });

  it("creates, edits with a conflict check, cancels and restores", async () => {
    const { db, calls } = fakeClient({
      "from:transfers": [okResponse([{ id: "t1" }]), okResponse([]), okResponse([{ id: "t1" }]), okResponse([{ id: "t1" }])],
    });
    expect(await createTransfer(db, "p1", input)).toEqual({ ok: true, data: { id: "t1" } });
    expect(await updateTransfer(db, "t1", input, "2027-05-01T00:00:00Z")).toEqual({
      ok: false,
      error: { kind: "conflict", message: "transfer_changed" },
    });
    expect((await cancelTransfer(db, "t1")).ok).toBe(true);
    expect((await restoreTransfer(db, "t1")).ok).toBe(true);
    const restore = calls[3]?.steps.find(([m]) => m === "update")?.[1][0];
    expect(restore).toEqual({ deleted_at: null });
  });

  it("passes the database's refusal through", async () => {
    const { db } = fakeClient({
      "from:transfer_passengers": [errorResponse("XR001", "transfer_vehicle_full: The vehicle seats 2 passengers.", "transfer_vehicle_full")],
    });
    const r = await addTransferPassenger(db, "t1", "mo");
    expect(r.ok).toBe(false);
  });

  it("clears the current primary before marking another", async () => {
    const { db, calls } = fakeClient({ "from:transfer_passengers": [okResponse([{ id: "q1" }]), okResponse([{ id: "q2" }])] });
    expect((await setPrimaryPassenger(db, "t1", "q2")).ok).toBe(true);
    expect(calls[0]?.steps.find(([m]) => m === "update")?.[1][0]).toEqual({ is_primary: false });
    expect(calls[1]?.steps.find(([m]) => m === "update")?.[1][0]).toEqual({ is_primary: true });
  });

  it("lists the people a transfer may carry", async () => {
    const { db } = fakeClient({
      "rpc:transfer_person_options": [
        okResponse([
          { person_id: "kai", full_name: "Kai Morgan", party_name: "Bayside Audio", roster_entry_id: "e1", membership_id: null, engagement_id: "g1" },
        ]),
      ],
    });
    const r = await listTransferPersonOptions(db, "p1");
    expect(r.ok && r.data[0]).toMatchObject({ personId: "kai", partyName: "Bayside Audio", rosterEntryId: "e1" });
  });
});

describe("the flight grid", () => {
  it("reads Flight rows by default and filters phases", async () => {
    const { db, calls } = fakeClient({
      "from:travel_grid": [
        okResponse([
          {
            id: "f1",
            project_id: "p1",
            person_id: "kai",
            traveler_name: "Kai Morgan",
            travel_mode: "Flight",
            operator_name: "Northwind Air",
            service_identifier: "NW101",
            confirmation_identifier: "ABC",
            departs_from: "LHR",
            departs_at: "2027-06-01T08:00:00Z",
            departs_time_zone: "Europe/London",
            arrives_at_place: "JFK",
            arrives_at: "2027-06-01T15:00:00Z",
            arrives_time_zone: "America/New_York",
            phase: "In Flight",
            journey_id: "f1",
            leg_number: 1,
            leg_count: 3,
            final_arrival_at: "2027-06-01T23:00:00Z",
            final_arrival_place: "MIA",
            final_arrival_time_zone: "America/New_York",
          },
        ]),
      ],
    });
    const r = await listTravelGrid(db, { orgId: "o1", phases: ["In Flight", "Departed"] });
    expect(r.ok && r.data[0]).toMatchObject({ phase: "In Flight", legNumber: 1, legCount: 3, finalArrivalPlace: "MIA" });
    const steps = calls[0]?.steps ?? [];
    expect(steps).toContainEqual(["eq", ["travel_mode", "Flight"]]);
    expect(steps).toContainEqual(["in", ["phase", ["In Flight", "Departed"]]]);
  });
});

describe("space bookings", () => {
  it("opens 90 minutes before a set and closes 60 minutes after it ends", () => {
    expect(setTimeWindow("2027-06-05T01:00:00Z", 75)).toEqual({
      startsAt: "2027-06-04T23:30:00.000Z",
      endsAt: "2027-06-05T03:15:00.000Z",
    });
    expect(setTimeWindow(null, 75)).toBeNull();
  });

  it("groups overlapping bookings by their conflict group", () => {
    const base = {
      id: "a",
      project_id: "p1",
      space_id: "s1",
      space_name: "Green Room A",
      space_capacity: 10,
      venue_name: null,
      engagement_id: null,
      engagement_cue_id: null,
      act_name: null,
      purpose: "Green Room",
      booking_mode: "Shared",
      party_size: 6,
      starts_at: "2027-06-05T18:00:00Z",
      ends_at: "2027-06-05T20:00:00Z",
      set_label: null,
      set_planned_at: null,
      set_ends_at: null,
      set_moved: null,
      conflict_group: "a",
      group_size: 2,
      group_party_total: 11,
      group_peak_party: 11,
      over_capacity: true,
      notes: null,
    } as const;
    const rows = [
      toSpaceBooking({ ...base, id: "b", starts_at: "2027-06-05T19:00:00Z" } as never),
      toSpaceBooking(base as never),
      toSpaceBooking({ ...base, id: "c", conflict_group: null, group_size: 1 } as never),
    ];
    const groups = conflictGroups(rows);
    expect(groups.map((g) => g.map((b) => b.id))).toEqual([["a", "b"]]);
    expect(rows[2]?.setMoved).toBe(false);
  });
});

describe("local contacts", () => {
  it("normalizes a typed phone to E.164 and refuses what cannot dial", () => {
    expect(toE164("+1 (305) 555-0100")).toBe("+13055550100");
    expect(toE164("305-555-0100")).toBeNull();
    expect(E164.test("+13055550100")).toBe(true);
  });

  it("sorts by role, then name", () => {
    expect(
      sortLocalContacts([
        { role: "Medical", displayName: "Bay Medical" },
        { role: "Promoter", displayName: "Zed" },
        { role: "Promoter", displayName: "Ann" },
      ] as const).map((c) => c.displayName),
    ).toEqual(["Ann", "Zed", "Bay Medical"]);
  });

  it("lists a day's contacts: every day and that day, active members only", async () => {
    const { db, calls } = fakeClient({ "from:project_local_contacts": [okResponse([])] });
    await listProjectLocalContacts(db, "p1", "2027-06-02");
    const steps = calls[0]?.steps ?? [];
    expect(steps).toContainEqual(["or", ["day.is.null,day.eq.2027-06-02"]]);
    expect(steps).toContainEqual(["eq", ["member_active", true]]);
  });

  it("writes a member row with nothing copied, and a typed row with its phone and lowercased email", async () => {
    const { db, calls } = fakeClient({ "from:local_contacts": [okResponse([{ id: "c1" }]), okResponse([{ id: "c2" }])] });
    await createLocalContact(db, { projectId: "p1", day: null }, {
      role: "Transport",
      title: "Dispatch",
      audience: "Shared",
      notes: null,
      who: { membershipId: "m1" },
    });
    await updateLocalContact(
      db,
      "c2",
      { role: "Venue", title: null, audience: "Internal", notes: null, who: { name: "Desk", phone: "+13055550100", email: "Desk@Pier.test", supplierId: null } },
      "2027-06-02",
    );
    expect(calls[0]?.steps.find(([m]) => m === "insert")?.[1][0]).toMatchObject({
      project_id: "p1",
      membership_id: "m1",
      phone: null,
      email: null,
      contact_name: null,
    });
    expect(calls[1]?.steps.find(([m]) => m === "update")?.[1][0]).toMatchObject({
      phone: "+13055550100",
      email: "desk@pier.test",
      day: "2027-06-02",
    });
  });
});

describe("lodging", () => {
  const night = (blockId: string, n: string, assigned: number, held = 2, releaseOn: string | null = null): BlockNight => ({
    blockId,
    projectId: "p1",
    blockNumber: blockId === "b1" ? 1 : 2,
    title: blockId,
    night: n,
    roomsHeld: held,
    assigned,
    free: held - assigned,
    releaseOn,
    nightlyRateMinor: null,
    currencyCode: null,
  });

  it("builds blocks by nights, marking free rooms near the release date", () => {
    const m = buildNightsMatrix(
      [night("b1", "2027-06-01", 1, 2, "2027-05-20"), night("b1", "2027-06-02", 2, 2, "2027-05-20"), night("b2", "2027-06-02", 0, 1)],
      "2027-05-10",
    );
    expect(m.nights).toEqual(["2027-06-01", "2027-06-02"]);
    expect(m.blocks[0]?.cells.map((c) => c?.releaseDue)).toEqual([true, false]);
    expect(m.blocks[1]?.cells[0]).toBeNull();
    expect(m.blocks[1]?.cells[1]?.releaseDue).toBe(false);
    expect(daysUntil("2027-05-20", "2027-05-10")).toBe(10);
  });

  it("parses a rooming entry", () => {
    const e = parseRoomingEntry({
      roster_entry_id: "e1",
      engagement_id: "g1",
      person_id: "kai",
      suggested_stays: [{ check_in_on: "2027-06-01", check_out_on: "2027-06-04", source: "Credentials" }],
      assigned_stays: [],
      uncovered_nights: 3,
      status: "Missing",
      cost: [{ currency_code: "USD", nights: 0, amount_minor: null }],
      lodging_allocation_id: "a1",
    });
    expect(e).toMatchObject({ status: "Missing", uncoveredNights: 3, lodgingAllocationId: "a1" });
    expect(e.suggestedStays[0]?.source).toBe("Credentials");
    expect(parseRoomingEntry({ status: "Odd" }).status).toBe("No Dates");
  });

  it("reads the rooming list and the budget line lodging", async () => {
    const { db } = fakeClient({
      "rpc:rooming_list": [okResponse([{ roster_entry_id: "e1", status: "Covered" }])],
      "from:budget_line_lodging": [
        okResponse([
          {
            budget_line_id: "bl1",
            currency_code: "USD",
            is_lodging_withheld: true,
            block_count: null,
            other_currency_block_count: null,
            held_room_nights: null,
            held_minor: null,
            assigned_room_nights: null,
            assigned_minor: null,
          },
        ]),
      ],
      "from:accommodation_blocks": [okResponse([{ id: "b1" }])],
    });
    const list = await listRoomingList(db, "p1");
    expect(list.ok && list.data[0]?.status).toBe("Covered");
    const lodging = await listBudgetLineLodging(db, "bud1");
    expect(lodging.ok && lodging.data[0]).toMatchObject({ withheld: true, heldMinor: null });
    expect((await setBlockBudgetLine(db, "b1", "bl1")).ok).toBe(true);
  });
});
