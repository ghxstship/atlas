import { describe, expect, it } from "vitest";
import {
  ALLOCATION_STATES,
  allowanceFor,
  assignAllocation,
  beyondAllowance,
  bulkDecideAllocations,
  cateringCounts,
  decideAllocation,
  defaultChannelHint,
  ensureOfferingAssetClass,
  getAllocation,
  getAssetClassAvailability,
  issueAllocation,
  issueItemsJson,
  listAllocationAllowances,
  listAllocationHolders,
  listAllocations,
  listProjectRadioChannels,
  listReservationConflicts,
  radioHandout,
  rangeBounds,
  releaseReservation,
  requestAllocation,
  reserveAllocation,
  setAllocationRadioChannels,
  sourcesJson,
  splitAllocation,
  unsplitAllocation,
  withdrawAllocation,
  type AllocationAllowance,
} from "../src/allocations.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const statusRow = {
  allocation_id: "a1",
  project_id: "p1",
  holder_engagement_id: null,
  roster_entry_id: "r1",
  parent_allocation_id: "pool",
  kind: "Asset",
  offering: "Radios",
  item_name: "Two-way radios",
  quantity: "2",
  allocation_state: "Approved",
  origin: "Split",
  needed_during: '["2027-06-01 12:00:00+00","2027-06-05 12:00:00+00")',
  needed_time_zone: "America/New_York",
  requested_by: "dave",
  decided_at: "2027-05-01T00:00:00Z",
  decided_by: "carol",
  decline_reason: null,
  reserved_quantity: 2,
  on_order_quantity: 0,
  confirmed: false,
  awaiting_order: false,
  received_quantity: 0,
  issued_quantity: 1,
  returned_quantity: 0,
  lost_quantity: 0,
  revoked_quantity: 0,
  display_status: "Partly Issued",
};

const allowance = (over: Partial<AllocationAllowance>): AllocationAllowance => ({
  offering: "Radios",
  rosterEntryId: null,
  mode: "Provided",
  cap: 6,
  requested: 0,
  approved: 4,
  remaining: 2,
  beyond: 0,
  ...over,
});

describe("allocations", () => {
  it("names the stored states in the database's order", () => {
    expect(ALLOCATION_STATES).toEqual(["Requested", "Approved", "Declined", "Withdrawn"]);
  });

  it("reads a range's two bounds as instants", () => {
    expect(rangeBounds('["2027-06-01 12:00:00+00","2027-06-05 12:00:00+00")')).toEqual({
      from: "2027-06-01T12:00:00.000Z",
      to: "2027-06-05T12:00:00.000Z",
    });
    expect(rangeBounds("[2027-06-01 12:00:00-04,)")).toEqual({
      from: "2027-06-01T16:00:00.000Z",
      to: null,
    });
    expect(rangeBounds(null)).toEqual({ from: null, to: null });
    expect(rangeBounds("garbage")).toEqual({ from: null, to: null });
  });

  it("lists allocations with their computed status and drops rows of an unknown kind", async () => {
    const { db, calls } = moduleClient({
      "from:advance_allocation_status": [
        okResponse([statusRow, { ...statusRow, allocation_id: "a2", kind: "Spaceship" }]),
        okResponse(statusRow),
        okResponse(null),
        errorResponse("42501", "denied"),
      ],
    });
    const result = await listAllocations(db, { orgId: "o1", projectId: "p1", kind: "Asset", status: "Partly Issued" });
    expect(result.ok && result.data).toEqual([
      expect.objectContaining({
        id: "a1",
        kind: "Asset",
        quantity: 2,
        status: "Partly Issued",
        neededFrom: "2027-06-01T12:00:00.000Z",
        neededTo: "2027-06-05T12:00:00.000Z",
        issuedQuantity: 1,
      }),
    ]);
    expect(stepsOf(calls[0], "eq")).toEqual([
      ["org_id", "o1"],
      ["project_id", "p1"],
      ["kind", "Asset"],
      ["display_status", "Partly Issued"],
    ]);
    expect((await getAllocation(db, "a1")).ok).toBe(true);
    expect(await getAllocation(db, "a9")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect(await getAllocation(db, "a1")).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("lists holders, pools before people", async () => {
    const { db, calls } = moduleClient({
      "from:allocation_holders": [
        okResponse([
          {
            holder_kind: "Pool",
            engagement_id: "e1",
            roster_entry_id: null,
            project_id: "p1",
            holder_name: "Bayside Audio",
            party_name: "Bayside Audio",
            role_type: "Vendor",
            entry_state: null,
            person_response: null,
            role_code: null,
          },
          { holder_kind: "Person", engagement_id: null, project_id: "p1" },
        ]),
      ],
    });
    const result = await listAllocationHolders(db, "p1");
    expect(result.ok && result.data).toEqual([
      expect.objectContaining({ kind: "Pool", engagementId: "e1", holderName: "Bayside Audio" }),
    ]);
    expect(stepsOf(calls[0], "order")[1]).toEqual(["holder_kind", { ascending: false }]);
  });

  it("requests for one target and holder, sending only what is set", async () => {
    const { db, calls } = moduleClient({
      "rpc:request_allocation": [okResponse("a1"), errorResponse("XR001", "allocation_cap_engagement: over")],
    });
    const input = {
      projectId: "p1",
      holder: { engagementId: "e1" },
      target: { kind: "asset", assetClassId: "c1" },
      quantity: 6,
      neededFrom: "2027-06-01T12:00:00Z",
      neededTo: "2027-06-05T12:00:00Z",
      timeZone: "America/New_York",
    } as const;
    expect(await requestAllocation(db, input)).toEqual({ ok: true, data: "a1" });
    expect(calls[0]?.steps[0]?.[1]?.[0]).toEqual({
      p_project_id: "p1",
      p_engagement_id: "e1",
      p_roster_entry_id: null,
      p_credential_category_id: null,
      p_asset_class_id: "c1",
      p_fulfillment_id: null,
      p_accommodation_block_id: null,
      p_service_kind: null,
      p_quantity: 6,
      p_needed_from: "2027-06-01T12:00:00Z",
      p_needed_to: "2027-06-05T12:00:00Z",
      p_time_zone: "America/New_York",
    });
    const refused = await requestAllocation(db, input);
    expect(!refused.ok && refused.error).toMatchObject({ kind: "refusal", rule: "allocation_cap_engagement" });
  });

  it("assigns and decides with sources, mixed supply as one hold per source", async () => {
    const sources = [
      { source: "Class Stock", quantity: 4 },
      { source: "Order Line", quantity: 2, poLineId: "l1" },
    ] as const;
    expect(sourcesJson(sources)).toEqual([
      { source: "Class Stock", quantity: 4 },
      { source: "Order Line", quantity: 2, po_line_id: "l1" },
    ]);
    expect(sourcesJson([])).toBeNull();
    expect(sourcesJson([{ source: "Unit", quantity: 1, assetUnitId: "u1" }])).toEqual([
      { source: "Unit", quantity: 1, asset_unit_id: "u1" },
    ]);
    const { db, calls } = moduleClient({
      "rpc:assign_allocation": [okResponse("a2")],
      "rpc:decide_allocation": [okResponse(true), okResponse(true)],
      "rpc:reserve_allocation": [okResponse(2)],
    });
    await assignAllocation(db, {
      projectId: "p1",
      holder: { rosterEntryId: "r1" },
      target: { kind: "service", serviceKind: "Travel" },
      quantity: 1,
      neededFrom: "a",
      neededTo: "b",
      timeZone: "UTC",
      note: "Second leg.",
    });
    expect(calls[0]?.steps[0]?.[1]?.[0]).toMatchObject({ p_roster_entry_id: "r1", p_service_kind: "Travel", p_note: "Second leg." });
    expect(calls[0]?.steps[0]?.[1]?.[0]).not.toHaveProperty("p_sources");
    await decideAllocation(db, { allocationId: "a1", decision: "Approved", sources });
    expect(calls[1]?.steps[0]?.[1]?.[0]).toEqual({
      p_allocation_id: "a1",
      p_decision: "Approved",
      p_sources: sourcesJson(sources),
    });
    await decideAllocation(db, { allocationId: "a1", decision: "Rejected", reason: "No." });
    expect(calls[2]?.steps[0]?.[1]?.[0]).toEqual({ p_allocation_id: "a1", p_decision: "Rejected", p_reason: "No." });
    expect(await reserveAllocation(db, "a1", sources)).toEqual({ ok: true, data: 2 });
  });

  it("decides in bulk through the advance_allocations resource", async () => {
    const { db, calls } = moduleClient({ "rpc:bulk_update_advance_allocations": [okResponse({ changed: 2 })] });
    await bulkDecideAllocations(db, ["a1", "a2"], "Declined", { reason: "Over budget." });
    expect(calls[0]?.steps[0]?.[1]?.[0]).toEqual({
      p_rows: [
        { id: "a1", set: { allocation_state: "Declined" } },
        { id: "a2", set: { allocation_state: "Declined" } },
      ],
      p_preview: false,
      p_reason: "Over budget.",
    });
  });

  it("splits, unsplits, withdraws and releases", async () => {
    const { db, calls } = moduleClient({
      "rpc:split_allocation": [okResponse(["c1", "c2"])],
      "rpc:unsplit_allocation": [okResponse("1")],
      "rpc:withdraw_allocation": [okResponse(null)],
      "rpc:release_reservation": [okResponse(null)],
    });
    expect(
      await splitAllocation(db, "pool", [
        { rosterEntryId: "r1", quantity: 2, assetUnitIds: ["u1"] },
        { rosterEntryId: "r2", quantity: 1 },
      ]),
    ).toEqual({ ok: true, data: ["c1", "c2"] });
    expect(calls[0]?.steps[0]?.[1]?.[0]).toEqual({
      p_allocation_id: "pool",
      p_parts: [
        { roster_entry_id: "r1", quantity: 2, asset_unit_ids: ["u1"] },
        { roster_entry_id: "r2", quantity: 1 },
      ],
    });
    expect(await unsplitAllocation(db, "c1")).toEqual({ ok: true, data: 1 });
    expect(calls[1]?.steps[0]?.[1]?.[0]).toEqual({ p_child_id: "c1" });
    await withdrawAllocation(db, "a1", "Not needed.");
    expect(calls[2]?.steps[0]?.[1]?.[0]).toEqual({ p_allocation_id: "a1", p_reason: "Not needed." });
    await releaseReservation(db, "h1");
    expect(calls[3]?.steps[0]?.[1]?.[0]).toEqual({ p_reservation_id: "h1" });
  });

  it("issues with only the keys each kind takes, and reads a replay", async () => {
    expect(
      issueItemsJson([
        { kind: "unit", assetTag: " nwl-rad-001 " },
        { kind: "lot", assetLotId: "l1", quantity: 25.5, reservationId: "h1" },
        { kind: "credential", rosterVehicleId: "v1" },
        { kind: "lodging" },
        { kind: "per_diem", day: "2027-06-01", amountMinor: 5000, currencyCode: "USD" },
      ]),
    ).toEqual([
      { asset_tag: "NWL-RAD-001" },
      { asset_lot_id: "l1", quantity: 25.5, reservation_id: "h1" },
      { roster_vehicle_id: "v1" },
      {},
      { day: "2027-06-01", amount_minor: 5000, currency_code: "USD" },
    ]);
    const { db, calls } = moduleClient({
      "rpc:issue_allocation": [
        okResponse({ outcome: "duplicate", possession: { asset_custody: ["c1", 7] } }),
        errorResponse("XR001", "allocation_self_issue: never"),
      ],
    });
    expect(
      await issueAllocation(db, { eventId: "ev1", allocationId: "a1", items: [{ kind: "unit", assetTag: "NWL-RAD-001" }] }),
    ).toEqual({ ok: true, data: { outcome: "duplicate", possession: { asset_custody: ["c1"] } } });
    expect(calls[0]?.steps[0]?.[1]?.[0]).toEqual({
      p_event_id: "ev1",
      p_allocation_id: "a1",
      p_items: [{ asset_tag: "NWL-RAD-001" }],
    });
    const refused = await issueAllocation(db, { eventId: "ev2", allocationId: "a1", items: [{ kind: "credential" }] });
    expect(!refused.ok && refused.error).toMatchObject({ rule: "allocation_self_issue" });
  });

  it("reads catering counts with suppression and finds or creates the radios class", async () => {
    const { db } = moduleClient({
      "rpc:catering_counts": [
        okResponse([
          { dietary_need: null, headcount: 12, suppressed: false },
          { dietary_need: "Halal", headcount: null, suppressed: true },
        ]),
      ],
      "rpc:ensure_offering_asset_class": [okResponse("cls")],
    });
    expect(await cateringCounts(db, "f1")).toEqual({
      ok: true,
      data: [
        { dietaryNeed: null, headcount: 12, suppressed: false },
        { dietaryNeed: "Halal", headcount: null, suppressed: true },
      ],
    });
    expect(await ensureOfferingAssetClass(db, "o1", "Radios")).toEqual({ ok: true, data: "cls" });
  });

  it("reads allowances and says what goes beyond them", async () => {
    const { db } = moduleClient({
      "rpc:allocation_allowances": [
        okResponse([
          { offering: "Radios", roster_entry_id: null, mode: "Provided", cap: "6", requested: 0, approved: "4", remaining: "2", beyond: "0" },
          { offering: "Radios", roster_entry_id: "r1", mode: "Provided", cap: 2, requested: 0, approved: 2, remaining: 0, beyond: 0 },
          { offering: "Travel", roster_entry_id: null, mode: "Provided", cap: null, requested: 1, approved: 0, remaining: null, beyond: null },
        ]),
      ],
    });
    const result = await listAllocationAllowances(db, "e1");
    const rows = result.ok ? result.data : [];
    expect(rows[0]).toEqual(allowance({}));
    expect(allowanceFor(rows, "Radios", "r1")?.rosterEntryId).toBe("r1");
    expect(allowanceFor(rows, "Radios", "r9")?.rosterEntryId).toBeNull();
    expect(allowanceFor(rows, null, null)).toBeNull();
    expect(beyondAllowance(allowance({ remaining: 2 }), 3)).toBe(1);
    expect(beyondAllowance(allowance({ remaining: null }), 3)).toBe(0);
    expect(beyondAllowance(null, 3)).toBe(0);
  });

  it("sets radio channels, reads the picker and hints the role's default", async () => {
    const { db, calls } = moduleClient({
      "rpc:set_allocation_radio_channels": [okResponse(null)],
      "rpc:project_radio_channels": [
        okResponse([
          { id: "c1", channel_number: 1, name: "Production" },
          { id: "c3", channel_number: 3, name: "Audio" },
        ]),
      ],
    });
    await setAllocationRadioChannels(db, "a1", ["c1", "c3"]);
    expect(calls[0]?.steps[0]?.[1]?.[0]).toEqual({ p_allocation_id: "a1", p_radio_channel_ids: ["c1", "c3"] });
    const channels = await listProjectRadioChannels(db, "p1");
    const list = channels.ok ? channels.data : [];
    expect(defaultChannelHint("CH 3", list)?.id).toBe("c3");
    expect(defaultChannelHint("production", list)?.id).toBe("c1");
    expect(defaultChannelHint("Audio and comms", list)?.id).toBe("c3");
    expect(defaultChannelHint(null, list)).toBeNull();
    expect(defaultChannelHint("Security", list)).toBeNull();
  });

  it("reads the hand-out, availability and conflicts", async () => {
    const { db, calls } = moduleClient({
      "rpc:radio_handout": [
        okResponse([
          {
            allocation_id: "a1",
            roster_entry_id: "r1",
            person_name: "Kai Morgan",
            party_name: "Bayside Audio",
            class_name: "Two-way radios",
            quantity: 2,
            tags_issued: ["NWL-RAD-001"],
            channel_numbers: [1, 3],
            channel_names: ["Production", "Audio"],
            display_status: "Partly Issued",
          },
        ]),
      ],
      "rpc:asset_class_availability": [
        okResponse([
          { serviceable_units: 4, lot_quantity: 0, on_order_quantity: 2, total: 6, peak_reserved: 2, available: 4, unit_basis: "each" },
        ]),
        okResponse([]),
      ],
      "from:asset_reservation_conflicts": [
        okResponse([
          {
            reservation_id: "h1",
            allocation_id: "a1",
            project_id: "p1",
            asset_class_id: "c1",
            asset_unit_id: "u1",
            asset_lot_id: null,
            po_line_id: null,
            quantity: 1,
            conflict: "Unit Unavailable",
          },
          { reservation_id: "h2", allocation_id: "a2", project_id: "p1", asset_class_id: "c1", conflict: "Something else" },
        ]),
      ],
    });
    const handout = await radioHandout(db, "p1");
    expect(handout.ok && handout.data[0]).toMatchObject({ personName: "Kai Morgan", channelNumbers: [1, 3], status: "Partly Issued" });
    expect(await getAssetClassAvailability(db, { assetClassId: "c1", from: "a", to: "b" })).toEqual({
      ok: true,
      data: { serviceableUnits: 4, lotQuantity: 0, onOrderQuantity: 2, total: 6, peakReserved: 2, available: 4, unitBasis: "each" },
    });
    expect(await getAssetClassAvailability(db, { assetClassId: "c1", from: "a", to: "b" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    const conflicts = await listReservationConflicts(db, { orgId: "o1", projectId: "p1" });
    expect(conflicts.ok && conflicts.data.map((c) => c.conflict)).toEqual(["Unit Unavailable"]);
    expect(stepsOf(calls.find((c) => c.target === "from:asset_reservation_conflicts"), "eq")).toEqual([
      ["org_id", "o1"],
      ["project_id", "p1"],
    ]);
  });
});
