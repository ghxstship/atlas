/**
 * Contract tests for R7's advance allocations (RRR-187, migrations 2690 to 2697): the computed status read back, every
 * allocation action through its RPC, an issue replayed with the same Idempotency-Key, the parity reads and writes
 * (allowances, radio channels, conflicts, class availability) and the holds. Requests run through `contractApp`
 * against the in-memory client and every success is checked against openapi/v1.json with `expectContract`.
 */
import { describe, expect, it } from "vitest";
import { handlers as advancing } from "../src/handlers/advancing.ts";
import { handlers as assets } from "../src/handlers/assets.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { MemoryDb, Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(28000 + n).padStart(12, "0")}`;
const PROJECT = id(1);
const ENGAGEMENT = id(2);
const ENTRY = id(3);
const POOL = id(4);
const SHARE = id(5);
const CLASS = id(6);
const HOLD = id(7);
const CHANNEL = id(8);
const WINDOW = '["2027-06-01 12:00:00+00","2027-06-05 12:00:00+00")';

const status = (allocationId: string, over: Row = {}): Row => ({
  allocation_id: allocationId,
  org_id: ORG,
  project_id: PROJECT,
  holder_engagement_id: ENGAGEMENT,
  roster_entry_id: null,
  parent_allocation_id: null,
  kind: "Asset",
  offering: "Radios",
  item_name: "Two-way radios",
  quantity: 6,
  allocation_state: "Approved",
  origin: "Requested",
  needed_during: WINDOW,
  needed_time_zone: "America/New_York",
  requested_by: ME,
  decided_at: "2027-05-01T00:00:00.000Z",
  decided_by: id(90),
  decline_reason: null,
  reserved_quantity: 6,
  on_order_quantity: 2,
  confirmed: false,
  awaiting_order: false,
  received_quantity: 0,
  issued_quantity: 0,
  returned_quantity: 0,
  lost_quantity: 0,
  revoked_quantity: 0,
  display_status: "On Order",
  ...over,
});

function world() {
  const db: MemoryDb = memoryDb(
    {
      advance_allocation_status: [
        status(POOL),
        status(SHARE, {
          holder_engagement_id: null,
          roster_entry_id: ENTRY,
          parent_allocation_id: POOL,
          quantity: 2,
          origin: "Split",
          display_status: "Reserved",
        }),
      ],
      asset_reservation_conflicts: [
        {
          reservation_id: HOLD,
          allocation_id: POOL,
          org_id: ORG,
          project_id: PROJECT,
          asset_class_id: CLASS,
          asset_unit_id: null,
          asset_lot_id: null,
          po_line_id: id(20),
          quantity: 2,
          conflict: "Order Short",
        },
      ],
      asset_reservations: [
        tenantRow(HOLD, ORG, {
          project_id: PROJECT,
          advance_allocation_id: POOL,
          asset_unit_id: null,
          asset_lot_id: null,
          po_line_id: id(20),
          quantity: 2,
          released_at: null,
          release_reason: null,
          created_by: ME,
          updated_by: ME,
        }),
      ],
    },
    {
      request_allocation: (args) => {
        if (Number(args["p_quantity"]) > 6)
          throw refusal("allocation_cap_engagement", "Over the cap.");
        return POOL;
      },
      assign_allocation: () => SHARE,
      decide_allocation: (args) => {
        if (args["p_decision"] === "Rejected" && !args["p_reason"]) {
          throw refusal("allocation_reason_required", "Say why.");
        }
        return true;
      },
      reserve_allocation: () => 1,
      split_allocation: () => [SHARE],
      unsplit_allocation: () => 1,
      withdraw_allocation: () => null,
      issue_allocation: (args) => ({
        outcome: "applied",
        possession: { asset_custody: [args["p_event_id"]] },
      }),
      allocation_allowances: () => [
        {
          offering: "Radios",
          roster_entry_id: null,
          mode: "Provided",
          cap: 6,
          requested: 0,
          approved: 6,
          remaining: 0,
          beyond: 0,
        },
        {
          offering: "Radios",
          roster_entry_id: ENTRY,
          mode: "Provided",
          cap: 2,
          requested: 0,
          approved: 2,
          remaining: 0,
          beyond: 0,
        },
      ],
      set_allocation_radio_channels: (args) => {
        if ((args["p_radio_channel_ids"] as string[]).length > 16)
          throw refusal("allocation_channel_count", "Too many.");
        return null;
      },
      release_reservation: () => null,
      asset_class_availability: () => [
        {
          serviceable_units: 4,
          lot_quantity: 0,
          on_order_quantity: 2,
          total: 6,
          peak_reserved: 6,
          available: 0,
          unit_basis: "each",
        },
      ],
    },
  );
  const app = contractApp({ handlers: [advancing, assets], db });
  return { db, app, http: requests(app) };
}

describe("Allocations contract: reads", () => {
  it("lists and reads allocations with the window as two instants", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/advance-allocations")),
      "advanceAllocations.list",
    )) as { data: Row[] };
    expect(page.data.map((r) => r["allocation_id"])).toEqual(expect.arrayContaining([POOL, SHARE]));
    const one = (await expectContract(
      await success(http.get(`/advance-allocations/${POOL}`)),
      "advanceAllocations.get",
    )) as Row;
    expect(one).toMatchObject({
      display_status: "On Order",
      needed_from: "2027-06-01T12:00:00.000Z",
      needed_to: "2027-06-05T12:00:00.000Z",
    });
    expect(one).not.toHaveProperty("needed_during");
  });

  it("lists reservation conflicts and the holds", async () => {
    const { http } = world();
    const conflicts = (await expectContract(
      await success(http.get("/asset-reservation-conflicts")),
      "assetReservationConflicts.list",
    )) as { data: Row[] };
    expect(conflicts.data[0]).toMatchObject({ conflict: "Order Short" });
    await expectContract(await success(http.get("/asset-reservations")), "assetReservations.list");
    await expectContract(
      await success(http.get(`/asset-reservations/${HOLD}`)),
      "assetReservations.get",
    );
  });
});

describe("Allocations contract: writes", () => {
  const body = {
    project_id: PROJECT,
    engagement_id: ENGAGEMENT,
    asset_class_id: CLASS,
    quantity: 6,
    needed_from: "2027-06-01T12:00:00Z",
    needed_to: "2027-06-05T12:00:00Z",
    time_zone: "America/New_York",
  };

  it("requests and assigns through their RPCs, with the holds of an assignment", async () => {
    const { db, http } = world();
    const made = await success(http.post("/advance-allocations/request", body));
    expect(made.status).toBe(201);
    await expectContract(made, "advanceAllocations.request");
    expect(db.calls.find((c) => c.name === "request_allocation")?.args).toMatchObject({
      p_project_id: PROJECT,
      p_engagement_id: ENGAGEMENT,
      p_roster_entry_id: null,
      p_asset_class_id: CLASS,
      p_service_kind: null,
      p_quantity: 6,
    });
    const over = await http.post("/advance-allocations/request", { ...body, quantity: 7 });
    expect(over.status).toBe(422);
    expect(await over.json()).toMatchObject({ rule: "allocation_cap_engagement" });
    const assigned = await success(
      http.post("/advance-allocations/assign", {
        ...body,
        engagement_id: undefined,
        roster_entry_id: ENTRY,
        quantity: 2,
        sources: [
          { source: "Class Stock", quantity: 1 },
          { source: "Order Line", quantity: 1, po_line_id: id(20) },
        ],
      }),
    );
    await expectContract(assigned, "advanceAllocations.assign");
    expect(db.calls.find((c) => c.name === "assign_allocation")?.args).toMatchObject({
      p_roster_entry_id: ENTRY,
      p_sources: [
        { source: "Class Stock", quantity: 1 },
        { source: "Order Line", quantity: 1, po_line_id: id(20) },
      ],
    });
  });

  it("decides, reserves, splits, unsplits and withdraws", async () => {
    const { db, http } = world();
    const decided = await success(
      http.post(`/advance-allocations/${POOL}/decide`, { decision: "Approved" }),
    );
    await expectContract(decided, "advanceAllocations.decide");
    const declined = await http.post(`/advance-allocations/${POOL}/decide`, {
      decision: "Rejected",
    });
    expect(await declined.json()).toMatchObject({ rule: "allocation_reason_required" });
    const reserved = await success(
      http.post(`/advance-allocations/${POOL}/reserve`, {
        sources: [{ source: "Class Stock", quantity: 6 }],
      }),
    );
    await expectContract(reserved, "advanceAllocations.reserve");
    const splitting = await success(
      http.post(`/advance-allocations/${POOL}/split`, {
        parts: [{ roster_entry_id: ENTRY, quantity: 2, asset_unit_ids: [id(30)] }],
      }),
    );
    const split = (await expectContract(splitting, "advanceAllocations.split")) as Row;
    expect(split).toEqual({ allocation_ids: [SHARE] });
    expect(db.calls.find((c) => c.name === "split_allocation")?.args).toEqual({
      p_allocation_id: POOL,
      p_parts: [{ roster_entry_id: ENTRY, quantity: 2, asset_unit_ids: [id(30)] }],
    });
    const unsplitting = await success(http.post(`/advance-allocations/${SHARE}/unsplit`, {}));
    const back = (await expectContract(unsplitting, "advanceAllocations.unsplit")) as Row;
    expect(back).toEqual({ quantity: 1 });
    const withdrawn = await success(
      http.post(`/advance-allocations/${SHARE}/withdraw`, { reason: "Not needed." }),
    );
    await expectContract(withdrawn, "advanceAllocations.withdraw");
  });

  it("issues one event per Idempotency-Key", async () => {
    const { db, app } = world();
    const send = () =>
      app.request(`/advance-allocations/${SHARE}/issue`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "r7-issue-1" },
        body: JSON.stringify({ items: [{ asset_tag: "nwl-rad-001" }] }),
      });
    const first = (await expectContract(await success(send()), "advanceAllocations.issue")) as Row;
    const again = (await expectContract(await success(send()), "advanceAllocations.issue")) as Row;
    expect(again).toEqual(first);
    const calls = db.calls.filter((c) => c.name === "issue_allocation");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toMatchObject({
      p_allocation_id: SHARE,
      p_items: [{ asset_tag: "NWL-RAD-001" }],
    });
  });
});

describe("Allocations contract: parity", () => {
  it("reads allowances, sets radio channels and reads availability", async () => {
    const { db, http } = world();
    const page = (await expectContract(
      await success(http.get(`/advance-allocations/allowances?engagement_id=${ENGAGEMENT}`)),
      "advanceAllocations.allowances",
    )) as { data: Row[] };
    expect(page.data).toHaveLength(2);
    expect(page.data[1]).toMatchObject({ roster_entry_id: ENTRY, remaining: 0 });
    const programmed = await success(
      http.post(`/advance-allocations/${SHARE}/set-radio-channels`, {
        radio_channel_ids: [CHANNEL],
      }),
    );
    await expectContract(programmed, "advanceAllocations.setRadioChannels");
    expect(db.calls.find((c) => c.name === "set_allocation_radio_channels")?.args).toEqual({
      p_allocation_id: SHARE,
      p_radio_channel_ids: [CHANNEL],
    });
    const window = "from=2027-06-01T12:00:00Z&to=2027-06-05T12:00:00Z";
    const availability = await success(http.get(`/asset-classes/${CLASS}/availability?${window}`));
    const free = (await expectContract(availability, "assetClasses.availability")) as Row;
    expect(free).toMatchObject({ total: 6, available: 0, unit_basis: "each" });
  });

  it("releases a hold", async () => {
    const { db, http } = world();
    const released = await success(
      http.post(`/asset-reservations/${HOLD}/release`, { reason: "Ordering more." }),
    );
    await expectContract(released, "assetReservations.release");
    expect(db.calls.find((c) => c.name === "release_reservation")?.args).toEqual({
      p_reservation_id: HOLD,
      p_reason: "Ordering more.",
    });
  });
});
