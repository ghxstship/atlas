import { describe, expect, it } from "vitest";
import {
  buildDockCheckIn,
  buildFulfillmentMove,
  buildGateArrival,
  buildRelease,
  buildYardEntry,
  dockBoard,
  fulfillmentMoves,
  openFulfillments,
  vehicleProblem,
  waitingVehicles,
  yardLog,
  type DockSlotRow,
  type FulfillmentRow,
  type GateQueueRow,
  type MarshallingRow,
} from "../src/domain/logistics";

const now = Date.parse("2027-06-01T12:00:00Z");

const slot = (id: string, starts: string, checked: string | null = null): DockSlotRow => ({
  id,
  project_id: "p1",
  zone_id: "z1",
  shipment_id: null,
  starts_at: starts,
  ends_at: starts,
  checked_in_at: checked,
});

describe("dock board", () => {
  it("lists open slots by start, then checked-in slots, for the current project", () => {
    const board = dockBoard(
      [
        slot("late", "2027-06-01T14:00:00Z"),
        slot("done", "2027-06-01T08:00:00Z", "2027-06-01T08:05:00Z"),
        slot("early", "2027-06-01T09:00:00Z"),
        { ...slot("other", "2027-06-01T07:00:00Z"), project_id: "p2" },
        { ...slot("gone", "2027-06-01T07:00:00Z"), deleted_at: "2027-05-30T00:00:00Z" },
      ],
      "p1",
    );
    expect(board.map((s) => s.id)).toEqual(["early", "late", "done"]);
  });

  it("checks a slot in through app.check_in_dock_slot with compare-and-set", () => {
    const m = buildDockCheckIn(slot("s1", "2027-06-01T09:00:00Z"), now);
    expect(m).toMatchObject({
      op: "rpc",
      target: "app.check_in_dock_slot",
      table: "dock_slots",
      rowId: "s1",
      policy: "cas",
      payload: { p_dock_slot_id: "s1" },
      optimistic: { checked_in_at: "2027-06-01T12:00:00.000Z" },
    });
  });
});

describe("gate and yard", () => {
  const vehicle = (id: string, arrived: string, released: string | null = null): GateQueueRow => ({
    id,
    project_id: "p1",
    shipment_id: null,
    vehicle_identifier: id,
    arrived_at: arrived,
    released_at: released,
  });

  it("shows waiting vehicles longest wait first", () => {
    expect(
      waitingVehicles(
        [
          vehicle("b", "2027-06-01T10:00:00Z"),
          vehicle("a", "2027-06-01T09:00:00Z"),
          vehicle("in", "2027-06-01T08:00:00Z", "2027-06-01T08:30:00Z"),
        ],
        "p1",
      ).map((v) => v.id),
    ).toEqual(["a", "b"]);
  });

  it("checks the vehicle identifier as the marshal types", () => {
    expect(vehicleProblem(" ")).toBe("required");
    expect(vehicleProblem("TX 4KL-221")).toBeNull();
    expect(vehicleProblem("bad/plate")).toBe("format");
  });

  it("records an arrival, a release and a yard entry through A11's RPCs", () => {
    const arrival = buildGateArrival(
      { projectId: "p1", vehicle: " TX 4KL-221 ", shipmentId: "sh1" },
      now,
      () => "g1",
    );
    expect(arrival).toMatchObject({
      target: "app.record_gate_arrival",
      table: "gate_queue",
      rowId: "g1",
      payload: { p_project_id: "p1", p_vehicle_identifier: "TX 4KL-221", p_shipment_id: "sh1" },
      optimistic: { released_at: null },
    });
    expect(buildRelease(vehicle("g1", "2027-06-01T10:00:00Z"), now)).toMatchObject({
      target: "app.release_vehicle",
      policy: "cas",
      payload: { p_gate_queue_id: "g1" },
    });
    const entry = buildYardEntry(
      { projectId: "p1", entry: " Truck 4 staged in lane C ", shipmentId: null, zoneId: "z1" },
      now,
      () => "y1",
    );
    expect(entry).toMatchObject({
      target: "app.add_marshalling_entry",
      table: "marshalling_log",
      payload: { p_entry: "Truck 4 staged in lane C", p_zone_id: "z1" },
    });
    expect(
      yardLog(
        [
          { ...(entry.optimistic as unknown as MarshallingRow), logged_at: "2027-06-01T09:00:00Z" },
          {
            id: "y2",
            project_id: "p1",
            shipment_id: null,
            zone_id: null,
            entry: "x",
            logged_at: "2027-06-01T11:00:00Z",
          },
        ],
        "p1",
      ).map((r) => r.id),
    ).toEqual(["y2", "y1"]);
  });
});

describe("fulfillments", () => {
  const row = (id: string, state: FulfillmentRow["fulfillment_state"]): FulfillmentRow => ({
    id,
    project_id: "p1",
    fulfillment_kind: "Catering",
    title: id,
    starts_at: null,
    fulfillment_state: state,
  });

  it("offers only the moves the lifecycle allows", () => {
    expect(fulfillmentMoves("Proposed")).toEqual(["Active", "Canceled"]);
    expect(fulfillmentMoves("Canceled")).toEqual([]);
    expect(
      openFulfillments([row("a", "Active"), row("x", "Canceled")], "p1").map((r) => r.id),
    ).toEqual(["a"]);
  });

  it("moves with compare-and-set and a reason, and refuses a move the lifecycle forbids", () => {
    expect(buildFulfillmentMove(row("f1", "Active"), "Complete", " Served. ")).toMatchObject({
      target: "app.transition_fulfillment",
      policy: "cas",
      payload: { p_expected: "Active", p_next: "Complete", p_reason: "Served." },
      optimistic: { fulfillment_state: "Complete" },
    });
    expect(() => buildFulfillmentMove(row("f1", "Proposed"), "Complete", "x")).toThrow(
      "cannot move",
    );
  });
});
