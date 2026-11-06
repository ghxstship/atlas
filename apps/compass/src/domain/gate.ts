/**
 * The phone gate view (B11, G-115, ADR 0150; More > Logistics > Gate): a marshal picks a gate, sees today's delivery
 * windows in the project's time zone and finds a booking by its reference code or plate on the device's rows, so a dead
 * signal at the gate still works. Arrived queues app.record_booking_arrival; Release and Check in are the existing
 * builders in logistics.ts, not copies of them. Each replays once by its mutation id.
 */
import { uuidv7, type MutationInput } from "@xos/sync";
import type { DockSlotRow, GateQueueRow } from "./logistics";

export interface DeliveryWindowRow {
  readonly id: string;
  readonly project_id: string;
  readonly zone_id: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly vehicle_limit: number;
  readonly is_open: boolean;
  readonly deleted_at?: string | null;
}

export interface BookingRow extends DockSlotRow {
  readonly delivery_window_id?: string | null;
  readonly reference_code?: string | null;
  readonly vehicle_identifier?: string | null;
}

export interface GateRow extends GateQueueRow {
  readonly dock_slot_id?: string | null;
}

/** Where a booking stands at the gate, computed from its gate row and check-in; never stored. */
export type BookingStatus = "Expected" | "Waiting" | "Released" | "Checked In";

/** The calendar day of an instant in a time zone, as YYYY-MM-DD. */
export function dayInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Live windows at a gate on the project's day, by start. */
export function windowsToday(
  rows: readonly DeliveryWindowRow[],
  input: { projectId: string; zoneId: string; timeZone: string; nowMs: number },
): DeliveryWindowRow[] {
  const today = dayInZone(new Date(input.nowMs).toISOString(), input.timeZone);
  return rows
    .filter(
      (w) =>
        !w.deleted_at &&
        w.project_id === input.projectId &&
        w.zone_id === input.zoneId &&
        dayInZone(w.starts_at, input.timeZone) === today,
    )
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

/** The live bookings of a window. */
export function bookingsOf(rows: readonly BookingRow[], windowId: string): BookingRow[] {
  return rows.filter((s) => !s.deleted_at && s.delivery_window_id === windowId);
}

/** The live gate row of a booking, if it has arrived. */
export function gateRowOf(rows: readonly GateRow[], slotId: string): GateRow | null {
  return rows.find((g) => !g.deleted_at && g.dock_slot_id === slotId) ?? null;
}

export function bookingStatus(slot: BookingRow, gate: GateRow | null): BookingStatus {
  if (slot.checked_in_at) return "Checked In";
  if (!gate) return "Expected";
  return gate.released_at ? "Released" : "Waiting";
}

const normal = (value: string) => value.replace(/[\s-]+/g, "").toUpperCase();

/** Live bookings of the project whose reference code or plate contains what was typed, ignoring spaces and case. */
export function findBookings(
  rows: readonly BookingRow[],
  input: { projectId: string; query: string },
): BookingRow[] {
  const wanted = normal(input.query);
  if (wanted === "") return [];
  return rows.filter(
    (s) =>
      !s.deleted_at &&
      s.project_id === input.projectId &&
      s.delivery_window_id &&
      (normal(s.reference_code ?? "").includes(wanted) ||
        normal(s.vehicle_identifier ?? "").includes(wanted)),
  );
}

/**
 * Arrived: one gate row for the booking, with the plate typed, or the slot's when none is. The row's id goes to the server
 * as the event id, because the RPC returns a bare id the uploader cannot merge: Release must name the row the server has.
 */
export function buildBookingArrival(
  slot: BookingRow,
  vehicle: string | null,
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput {
  const id = newId(nowMs);
  const typed = vehicle?.trim() || null;
  return {
    op: "rpc",
    target: "app.record_booking_arrival",
    table: "gate_queue",
    rowId: id,
    payload: { p_dock_slot_id: slot.id, p_vehicle_identifier: typed, p_event_id: id },
    policy: "append",
    optimistic: {
      id,
      project_id: slot.project_id,
      shipment_id: slot.shipment_id,
      vehicle_identifier: typed ?? slot.vehicle_identifier ?? "",
      arrived_at: new Date(nowMs).toISOString(),
      released_at: null,
      dock_slot_id: slot.id,
    },
  };
}
