import { buildNightsMatrix, type BlockNight, type RoomingEntry } from "@xos/data/lodging";
import type { Transfer } from "@xos/data/transfers";
import { describe, expect, it } from "vitest";
import { blocksFor, filterRooming, stayNights, stayToAssign } from "@/lib/hospitality/rooming";
import {
  FLIGHT_PRESETS,
  matchesTravelSearch,
  phasesOf,
  presetFilters,
  transferLanes,
  transferWarnings,
} from "@/lib/hospitality/travel";
import { EXPORT_SOURCES } from "@/lib/views/export-sources";

/** B5 (ADR 0144): the flight grid's built-in views, transfer lanes and warnings, the nights matrix and the rooming list. */

describe("the flight grid's built-in views", () => {
  it("filter the phase as the export does", () => {
    expect(FLIGHT_PRESETS.map((p) => [p.id, presetFilters(p.phases)])).toEqual([
      ["upcoming", [{ field: "phase", operator: "eq", value: "Upcoming" }]],
      ["inFlight", [{ field: "phase", operator: "eq", value: "In Flight,Departed" }]],
      ["all", []],
    ]);
    expect(phasesOf("In Flight,Departed,Teleported")).toEqual(["In Flight", "Departed"]);
    expect(phasesOf(undefined)).toEqual([]);
  });

  it("search covers traveller, flight, confirmation and places", () => {
    const row = {
      travelerName: "Kai Morgan",
      serviceIdentifier: "NW101",
      confirmationIdentifier: "QX7Y2B",
      operatorName: "Northwind Air",
      departsFrom: "LHR",
      arrivesAtPlace: "JFK",
      finalArrivalPlace: "MIA",
    } as never;
    expect(["kai", "nw101", "qx7", "lhr", "mia"].every((q) => matchesTravelSearch(row, q))).toBe(
      true,
    );
    expect(matchesTravelSearch(row, "ATL")).toBe(false);
  });

  it("exports Flight rows only, with the phase filter, on the page and the project tab", () => {
    const travel = EXPORT_SOURCES["hospitality/travel"];
    expect(
      travel && "relation" in travel
        ? [travel.relation, travel.fixed, travel.filters["phase"]]
        : null,
    ).toEqual(["app.travel_grid", { travel_mode: "Flight" }, { column: "phase" }]);
    const tab = EXPORT_SOURCES["project/hospitality"];
    expect(tab && "options" in tab ? Object.keys(tab.options) : []).toEqual(
      expect.arrayContaining(["travel", "transfers", "rooms"]),
    );
    expect(tab && "options" in tab ? Object.keys(tab.options) : []).not.toContain("rooming");
  });
});

describe("transfers", () => {
  const transfer = (over: Partial<Transfer>): Transfer =>
    ({
      id: "t",
      driverPersonId: null,
      driverName: null,
      vehicleId: null,
      vehicleLabel: null,
      tightTurnaround: false,
      flightLandsAfterPickup: false,
      ...over,
    }) as Transfer;

  it("warns of a tight turnaround and a flight landing after pickup", () => {
    expect(
      transferWarnings(transfer({ tightTurnaround: true, flightLandsAfterPickup: true })),
    ).toEqual(["tightTurnaround", "flightAfterPickup"]);
    expect(transferWarnings(transfer({}))).toEqual([]);
  });

  it("lays out lanes by driver, unassigned last", () => {
    const lanes = transferLanes(
      [
        transfer({ id: "a", driverPersonId: "p2", driverName: "Zoe" }),
        transfer({ id: "b" }),
        transfer({ id: "c", driverPersonId: "p1", driverName: "Ann" }),
        transfer({ id: "d", driverPersonId: "p1", driverName: "Ann" }),
      ],
      "driver",
    );
    expect(lanes.map((l) => [l.label, l.transfers.map((t) => t.id)])).toEqual([
      ["Ann", ["c", "d"]],
      ["Zoe", ["a"]],
      [null, ["b"]],
    ]);
  });
});

describe("the nights matrix", () => {
  it("matches the nights view and marks free rooms near release", () => {
    const night = (n: string, assigned: number): BlockNight => ({
      blockId: "b1",
      projectId: "p",
      blockNumber: 1,
      title: "Crew Hotel",
      night: n,
      roomsHeld: 2,
      assigned,
      free: 2 - assigned,
      releaseOn: "2027-05-25",
      nightlyRateMinor: null,
      currencyCode: null,
    });
    const m = buildNightsMatrix([night("2027-06-01", 2), night("2027-06-02", 1)], "2027-05-20");
    expect(m.blocks[0]?.cells.map((c) => [c?.assigned, c?.held, c?.releaseDue])).toEqual([
      [2, 2, false],
      [1, 2, true],
    ]);
    expect(
      buildNightsMatrix([night("2027-06-02", 1)], "2027-05-01").blocks[0]?.cells[0]?.releaseDue,
    ).toBe(false);
  });
});

describe("the rooming list", () => {
  const entry = (over: Partial<RoomingEntry>): RoomingEntry =>
    ({
      rosterEntryId: "e",
      engagementId: "g",
      partyName: null,
      personId: "p",
      personName: "Kai Morgan",
      roleCode: null,
      suggestedStays: [],
      assignedStays: [],
      uncoveredNights: 0,
      status: "No Dates",
      cost: [],
      lodgingAllocationId: null,
      ...over,
    }) as RoomingEntry;

  it("filters by status", () => {
    const rows = [
      entry({ status: "Missing" }),
      entry({ status: "Covered" }),
      entry({ status: "Partial" }),
    ];
    expect(filterRooming(rows, new Set(["Missing", "Partial"])).map((e) => e.status)).toEqual([
      "Missing",
      "Partial",
    ]);
    expect(filterRooming(rows, new Set())).toHaveLength(3);
  });

  it("proposes the first stay with an uncovered night, for the prefilled form", () => {
    const e = entry({
      suggestedStays: [
        { checkInOn: "2027-06-01", checkOutOn: "2027-06-04", source: "Credentials" },
        { checkInOn: "2027-06-05", checkOutOn: "2027-06-07", source: "Credentials" },
      ],
      assignedStays: [
        {
          assignmentId: "a",
          blockId: "b",
          blockTitle: null,
          checkInOn: "2027-06-01",
          checkOutOn: "2027-06-04",
          allocationId: null,
        },
      ],
    });
    expect(stayToAssign(e)).toEqual({
      checkInOn: "2027-06-05",
      checkOutOn: "2027-06-07",
      source: "Credentials",
    });
    expect(stayNights({ checkInOn: "2027-06-05", checkOutOn: "2027-06-07" })).toEqual([
      "2027-06-05",
      "2027-06-06",
    ]);
    expect(stayToAssign(entry({}))).toBeNull();
  });

  it("offers the blocks a stay fits in", () => {
    const blocks = [
      { id: "a", checkInOn: "2027-05-30", checkOutOn: "2027-06-10" },
      { id: "b", checkInOn: "2027-06-06", checkOutOn: "2027-06-08" },
    ];
    expect(
      blocksFor(blocks, {
        checkInOn: "2027-06-01",
        checkOutOn: "2027-06-04",
        source: "Travel",
      }).map((b) => b.id),
    ).toEqual(["a"]);
  });
});
