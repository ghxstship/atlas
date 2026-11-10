/**
 * Compass logistics (Section 4.3 item 8: dock slot check-in, marshalling yard log, delivery receipt;
 * More > Logistics). Every write is one of A11's field RPCs (0442), allowlisted for app.apply_sync_mutation,
 * so a queued act replays exactly once by its mutation id and the server's policies decide it as for Atlas.
 * Fulfillments move through app.transition_fulfillment with compare-and-set and a reason.
 */
import { uuidv7, type MutationInput } from "@xos/sync";
import type { Database } from "@xos/data/database.types";

export interface DockSlotRow {
  readonly id: string;
  readonly project_id: string;
  readonly zone_id: string;
  readonly shipment_id: string | null;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly checked_in_at?: string | null;
  readonly deleted_at?: string | null;
}

export interface GateQueueRow {
  readonly id: string;
  readonly project_id: string;
  readonly shipment_id: string | null;
  readonly vehicle_identifier: string;
  readonly arrived_at: string;
  readonly released_at: string | null;
  readonly deleted_at?: string | null;
}

export interface MarshallingRow {
  readonly id: string;
  readonly project_id: string;
  readonly shipment_id: string | null;
  readonly zone_id: string | null;
  readonly entry: string;
  readonly logged_at: string;
  readonly deleted_at?: string | null;
}

export type FulfillmentState = Database["app"]["Enums"]["fulfillment_state"];

export interface FulfillmentRow {
  readonly id: string;
  readonly project_id: string;
  readonly fulfillment_kind: string;
  readonly title: string;
  readonly starts_at: string | null;
  readonly fulfillment_state: FulfillmentState;
  readonly deleted_at?: string | null;
}

/** The fulfillment lifecycle (private.lifecycle_transition_rules, A11 0440). */
const FULFILLMENT_MOVES: Readonly<Record<FulfillmentState, readonly FulfillmentState[]>> = {
  Proposed: ["Active", "Canceled"],
  Active: ["Blocked", "Complete", "Canceled"],
  Blocked: ["Active", "Canceled"],
  Complete: ["Active"],
  Canceled: [],
};

export function fulfillmentMoves(state: FulfillmentState): readonly FulfillmentState[] {
  return FULFILLMENT_MOVES[state];
}

const live = <T extends { deleted_at?: string | null; project_id: string }>(
  rows: readonly T[],
  projectId: string | null,
) => rows.filter((r) => !r.deleted_at && (projectId === null || r.project_id === projectId));

/** Slots still to check in first, by start; checked-in slots after them. */
export function dockBoard(rows: readonly DockSlotRow[], projectId: string | null): DockSlotRow[] {
  return [...live(rows, projectId)].sort((a, b) => {
    const open = Number(Boolean(a.checked_in_at)) - Number(Boolean(b.checked_in_at));
    return open !== 0 ? open : a.starts_at.localeCompare(b.starts_at);
  });
}

/** Vehicles waiting at the gate, longest wait first. */
export function waitingVehicles(
  rows: readonly GateQueueRow[],
  projectId: string | null,
): GateQueueRow[] {
  return live(rows, projectId)
    .filter((r) => r.released_at === null)
    .sort((a, b) => a.arrived_at.localeCompare(b.arrived_at));
}

/** The yard log, newest first. */
export function yardLog(
  rows: readonly MarshallingRow[],
  projectId: string | null,
): MarshallingRow[] {
  return [...live(rows, projectId)].sort((a, b) => b.logged_at.localeCompare(a.logged_at));
}

/** Fulfillments that can still move, by start. */
export function openFulfillments(
  rows: readonly FulfillmentRow[],
  projectId: string | null,
): FulfillmentRow[] {
  return live(rows, projectId)
    .filter((r) => fulfillmentMoves(r.fulfillment_state).length > 0)
    .sort((a, b) => (a.starts_at ?? "").localeCompare(b.starts_at ?? ""));
}

const VEHICLE = /^[A-Za-z0-9][A-Za-z0-9 -]{0,39}$/;

export function vehicleProblem(value: string): "required" | "format" | null {
  const v = value.trim();
  if (v.length === 0) return "required";
  return VEHICLE.test(v) ? null : "format";
}

export function buildDockCheckIn(slot: DockSlotRow, nowMs: number): MutationInput {
  return {
    op: "rpc",
    target: "app.check_in_dock_slot",
    table: "dock_slots",
    rowId: slot.id,
    payload: { p_dock_slot_id: slot.id },
    policy: "cas",
    optimistic: { ...slot, checked_in_at: new Date(nowMs).toISOString() },
  };
}

export function buildGateArrival(
  input: { projectId: string; vehicle: string; shipmentId: string | null },
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput {
  const id = newId(nowMs);
  const vehicle = input.vehicle.trim();
  return {
    op: "rpc",
    target: "app.record_gate_arrival",
    table: "gate_queue",
    rowId: id,
    payload: {
      p_project_id: input.projectId,
      p_vehicle_identifier: vehicle,
      p_shipment_id: input.shipmentId,
    },
    policy: "append",
    optimistic: {
      id,
      project_id: input.projectId,
      shipment_id: input.shipmentId,
      vehicle_identifier: vehicle,
      arrived_at: new Date(nowMs).toISOString(),
      released_at: null,
    },
  };
}

export function buildRelease(entry: GateQueueRow, nowMs: number): MutationInput {
  return {
    op: "rpc",
    target: "app.release_vehicle",
    table: "gate_queue",
    rowId: entry.id,
    payload: { p_gate_queue_id: entry.id },
    policy: "cas",
    optimistic: { ...entry, released_at: new Date(nowMs).toISOString() },
  };
}

export function buildYardEntry(
  input: { projectId: string; entry: string; shipmentId: string | null; zoneId: string | null },
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput {
  const id = newId(nowMs);
  const entry = input.entry.trim();
  return {
    op: "rpc",
    target: "app.add_marshalling_entry",
    table: "marshalling_log",
    rowId: id,
    payload: {
      p_project_id: input.projectId,
      p_entry: entry,
      p_shipment_id: input.shipmentId,
      p_zone_id: input.zoneId,
    },
    policy: "append",
    optimistic: {
      id,
      project_id: input.projectId,
      shipment_id: input.shipmentId,
      zone_id: input.zoneId,
      entry,
      logged_at: new Date(nowMs).toISOString(),
    },
  };
}

export function buildFulfillmentMove(
  row: FulfillmentRow,
  next: FulfillmentState,
  reason: string,
): MutationInput {
  if (!fulfillmentMoves(row.fulfillment_state).includes(next))
    throw new Error(`fulfillment cannot move from ${row.fulfillment_state} to ${next}`);
  return {
    op: "rpc",
    target: "app.transition_fulfillment",
    table: "fulfillments",
    rowId: row.id,
    payload: {
      p_fulfillment_id: row.id,
      p_expected: row.fulfillment_state,
      p_next: next,
      p_reason: reason.trim(),
    },
    policy: "cas",
    optimistic: { ...row, fulfillment_state: next },
  };
}
