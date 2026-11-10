import { describe, expect, it } from "vitest";
import {
  bulkAssignFromPool,
  getMyRosterEngagement,
  listEngagementAllocations,
  listMyAllocations,
  listMyParkingPasses,
  listRequestableItems,
  parkingLine,
  parseRequestableValue,
  poolAllocations,
  requestableValue,
  requestEngagedAllocation,
  shareOf,
  splitEngagedAllocation,
  unsplitEngagedAllocation,
  withdrawEngagedAllocation,
  type EngagedAllocation,
  type ParkingPass,
} from "../src/gateway-allocations.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const row = {
  allocation_id: "a1",
  engagement_id: "e1",
  roster_entry_id: null,
  person_name: null,
  kind: "Asset",
  item_name: "Radios",
  quantity: 6,
  allocation_state: "Approved",
  display_status: "Reserved",
  reserved_quantity: 6,
  issued_quantity: 0,
  returned_quantity: 0,
  parent_allocation_id: null,
  needed_from: "2027-06-01T12:00:00Z",
  needed_to: "2027-06-05T12:00:00Z",
  needed_time_zone: "America/New_York",
  requested_by_me: true,
  decline_reason: null,
  names_due_at: null,
};

const allocation = (over: Partial<EngagedAllocation>): EngagedAllocation => ({
  id: "x",
  engagementId: "e1",
  rosterEntryId: null,
  personName: null,
  kind: "Asset",
  itemName: "Radios",
  quantity: 1,
  state: "Approved",
  status: "Approved",
  reservedQuantity: 0,
  issuedQuantity: 0,
  returnedQuantity: 0,
  parentAllocationId: null,
  neededFrom: "2027-06-01T12:00:00Z",
  neededTo: "2027-06-05T12:00:00Z",
  neededTimeZone: "America/New_York",
  requestedByMe: false,
  declineReason: null,
  namesDueAt: null,
  ...over,
});

const pass: ParkingPass = {
  credentialId: "c1",
  projectId: "p1",
  credentialNumber: "P-001",
  categoryName: "Crew Parking",
  validFrom: null,
  validTo: null,
  revokedAt: null,
  zoneCodes: ["LOT-A"],
  zoneNames: ["Lot A"],
  vehicleMake: "Ford",
  vehicleModel: "Transit",
  vehicleColor: "White",
};

describe("gateway allocations", () => {
  it("reads an engagement's allocations with their computed status", async () => {
    const { db, calls } = moduleClient({
      "api_external:from:advance_allocations": [
        okResponse([row, { ...row, allocation_id: null }]),
        errorResponse("42501", "denied"),
      ],
    });
    const result = await listEngagementAllocations(db, "e1");
    expect(result.ok && result.data).toEqual([
      expect.objectContaining({ id: "a1", status: "Reserved", quantity: 6, requestedByMe: true }),
    ]);
    expect(stepsOf(calls[0], "eq")).toEqual([["engagement_id", "e1"]]);
    expect(await listEngagementAllocations(db, "e1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("reads the caller's own rows by entry, and nothing without one", async () => {
    const { db, calls } = moduleClient({
      "api_external:from:advance_allocations": [
        okResponse([{ ...row, roster_entry_id: "r1", person_name: "Kai Morgan" }]),
      ],
    });
    expect(await listMyAllocations(db, [])).toEqual({ ok: true, data: [] });
    const mine = await listMyAllocations(db, ["r1"]);
    expect(mine.ok && mine.data[0]?.personName).toBe("Kai Morgan");
    expect(stepsOf(calls[0], "in")).toEqual([["roster_entry_id", ["r1"]]]);
  });

  it("finds the pool and a person's share of it", () => {
    const rows = [
      allocation({ id: "pool" }),
      allocation({ id: "s1", rosterEntryId: "r1", parentAllocationId: "pool", quantity: 1 }),
      allocation({ id: "s2", rosterEntryId: "r1", parentAllocationId: "pool", quantity: 2 }),
      allocation({
        id: "s3",
        rosterEntryId: "r1",
        parentAllocationId: "pool",
        quantity: 5,
        state: "Withdrawn",
      }),
      allocation({ id: "req", state: "Requested" }),
    ];
    expect(poolAllocations(rows).map((a) => a.id)).toEqual(["pool"]);
    expect(shareOf(rows, "pool", "r1")).toBe(3);
    expect(shareOf(rows, "pool", "r2")).toBe(0);
  });

  it("lists requestable items and round-trips their form values", async () => {
    const { db } = moduleClient({
      "api_external:from:requestable_items": [
        okResponse([
          {
            engagement_id: "e1",
            item_kind: "asset_class",
            item_id: "cls",
            name: "Radios",
            offering: "Radios",
            cap_per_engagement: 6,
            cap_per_person: 2,
            requested_quantity: "4",
          },
          {
            engagement_id: "e1",
            item_kind: "service",
            item_id: null,
            name: "Per Diem",
            offering: "Per Diem",
            cap_per_engagement: null,
            cap_per_person: null,
            requested_quantity: 0,
          },
        ]),
      ],
    });
    const result = await listRequestableItems(db, "e1");
    expect(result.ok && result.data.map(requestableValue)).toEqual([
      "asset_class:cls",
      "service:Per Diem",
    ]);
    expect(result.ok && result.data[0]?.requestedQuantity).toBe(4);
    expect(parseRequestableValue("asset_class:cls")).toEqual({
      itemKind: "asset_class",
      itemId: "cls",
      serviceKind: null,
    });
    expect(parseRequestableValue("service:Travel")).toEqual({
      itemKind: "service",
      itemId: null,
      serviceKind: "Travel",
    });
    expect(parseRequestableValue("service:Valet")).toBeNull();
    expect(parseRequestableValue("gadget:1")).toBeNull();
    expect(parseRequestableValue("asset_class:")).toBeNull();
  });

  it("requests, splits, gives back and withdraws through the RPCs", async () => {
    const { db, calls } = moduleClient({
      "rpc:request_engaged_allocation": [
        okResponse("a9"),
        errorResponse(
          "XR001",
          "allocation_not_your_engagement: Only the people who answer.",
          "allocation_not_your_engagement",
        ),
      ],
      "rpc:split_engaged_allocation": [okResponse(["s1"])],
      "rpc:unsplit_engaged_allocation": [okResponse(1)],
      "rpc:withdraw_engaged_allocation": [okResponse(null)],
    });
    const input = {
      engagementId: "e1",
      rosterEntryId: null,
      itemKind: "asset_class" as const,
      itemId: "cls",
      serviceKind: null,
      quantity: 6,
      neededFrom: "2027-06-01T12:00:00Z",
      neededTo: "2027-06-05T12:00:00Z",
      timeZone: "America/New_York",
      note: null,
    };
    expect(await requestEngagedAllocation(db, input)).toEqual({ ok: true, data: "a9" });
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({
      p_engagement_id: "e1",
      p_item_kind: "asset_class",
      p_quantity: 6,
      p_needed_from: "2027-06-01T12:00:00Z",
      p_needed_to: "2027-06-05T12:00:00Z",
      p_time_zone: "America/New_York",
      p_item_id: "cls",
    });
    const refused = await requestEngagedAllocation(db, input);
    expect(!refused.ok && refused.error).toEqual(
      expect.objectContaining({ kind: "refusal", rule: "allocation_not_your_engagement" }),
    );
    expect(
      await splitEngagedAllocation(db, "pool", [{ rosterEntryId: "r1", quantity: 1 }]),
    ).toEqual({ ok: true, data: ["s1"] });
    expect(stepsOf(calls[2], "args")[0]?.[0]).toEqual({
      p_pool_allocation_id: "pool",
      p_parts: [{ roster_entry_id: "r1", quantity: 1 }],
    });
    expect(await unsplitEngagedAllocation(db, "s1")).toEqual({ ok: true, data: 1 });
    expect(await withdrawEngagedAllocation(db, "a9", "Not needed.")).toEqual({
      ok: true,
      data: null,
    });
  });

  it("assigns from the pool in bulk and returns the outcome", async () => {
    const { db, calls } = moduleClient({
      "rpc:bulk_update_engaged_allocation_assignments": [
        okResponse({
          preview: true,
          committed: false,
          changed: 2,
          unchanged: 0,
          refused: [],
          inverse: [],
        }),
      ],
    });
    const result = await bulkAssignFromPool(
      db,
      [{ id: "r1", set: { pool_allocation_id: "pool", quantity: "1" } }],
      { preview: true },
    );
    expect(result.ok && result.data.changed).toBe(2);
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual(expect.objectContaining({ p_preview: true }));
  });

  it("reads the caller's parking passes and says one in a line, never a plate", async () => {
    const { db, calls } = moduleClient({
      "api_external:from:my_parking_passes": [
        okResponse([
          {
            credential_id: "c1",
            project_id: "p1",
            credential_number: "P-001",
            category_name: "Crew Parking",
            valid_from: null,
            valid_to: null,
            revoked_at: null,
            zone_codes: null,
            zone_names: null,
            vehicle_make: null,
            vehicle_model: null,
            vehicle_color: null,
          },
        ]),
      ],
    });
    const result = await listMyParkingPasses(db, "p1");
    expect(result.ok && result.data[0]?.zoneNames).toEqual([]);
    expect(stepsOf(calls[0], "eq")).toEqual([["project_id", "p1"]]);
    expect(parkingLine(pass)).toBe("Lot A · Ford Transit White");
    expect(
      parkingLine({
        ...pass,
        zoneNames: [],
        vehicleMake: null,
        vehicleModel: null,
        vehicleColor: null,
      }),
    ).toBe("Crew Parking");
  });

  it("reads an engagement reached through a roster entry, without the party's rate", async () => {
    const { db } = moduleClient({
      "api_external:from:my_roster_engagements": [
        okResponse({
          id: "01920000-0000-7000-8700-0000000000e1",
          org_id: "o1",
          org_name: "Northwind Live",
          project_id: "p1",
          project_name: "Summer Series",
          role_type: "Vendor",
          role_code: null,
          job_title: null,
          person_id: "sam",
          account_id: "acct",
          pay_basis: null,
          arrangement: null,
          start_date: "2027-06-01",
          end_date: null,
          engagement_state: "Active",
          areas: ["onboarding", "operational", "roster"],
          project_time_zone: "America/New_York",
          roster_locks_at: null,
          roster_entry_id: "r1",
          entry_role_code: "9000.50.02",
          arrival_window_start: "2027-06-01T12:00:00Z",
          arrival_window_end: "2027-06-01T14:00:00Z",
          arrival_time_zone: "America/New_York",
          lead_name: "Pia Larsen",
        }),
        okResponse(null),
      ],
    });
    const result = await getMyRosterEngagement(db, "e1");
    expect(result.ok && result.data).toEqual(
      expect.objectContaining({ rosterEntryId: "r1", rateMinor: null, leadName: "Pia Larsen" }),
    );
    expect(await getMyRosterEngagement(db, "e2")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});
