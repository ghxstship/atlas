import { describe, expect, it } from "vitest";
import {
  bookingStatus,
  bookingsOf,
  buildBookingArrival,
  dayInZone,
  findBookings,
  gateRowOf,
  windowsToday,
  type BookingRow,
  type DeliveryWindowRow,
  type GateRow,
} from "../src/domain/gate";
import { buildRelease } from "../src/domain/logistics";

const slot = (over: Partial<BookingRow> = {}): BookingRow => ({
  id: "s1",
  project_id: "p1",
  zone_id: "z1",
  shipment_id: null,
  starts_at: "2027-06-01T12:00:00Z",
  ends_at: "2027-06-01T14:00:00Z",
  delivery_window_id: "w1",
  reference_code: "ABC234",
  vehicle_identifier: "FL ABC-123",
  ...over,
});

const window = (over: Partial<DeliveryWindowRow> = {}): DeliveryWindowRow => ({
  id: "w1",
  project_id: "p1",
  zone_id: "z1",
  starts_at: "2027-06-01T12:00:00Z",
  ends_at: "2027-06-01T14:00:00Z",
  vehicle_limit: 5,
  is_open: true,
  ...over,
});

const gateRow = (over: Partial<GateRow> = {}): GateRow => ({
  id: "g1",
  project_id: "p1",
  shipment_id: null,
  vehicle_identifier: "FL ABC-123",
  arrived_at: "2027-06-01T12:10:00Z",
  released_at: null,
  dock_slot_id: "s1",
  ...over,
});

describe("the gate view (B11, G-115)", () => {
  it("reads today in the project's time zone, not UTC's", () => {
    // 02:00 UTC on June 2 is still June 1 in New York.
    expect(dayInZone("2027-06-02T02:00:00Z", "America/New_York")).toBe("2027-06-01");
    const late = window({
      id: "late",
      starts_at: "2027-06-02T02:00:00Z",
      ends_at: "2027-06-02T03:00:00Z",
    });
    const next = window({
      id: "next",
      starts_at: "2027-06-02T12:00:00Z",
      ends_at: "2027-06-02T13:00:00Z",
    });
    const rows = windowsToday([next, late, window()], {
      projectId: "p1",
      zoneId: "z1",
      timeZone: "America/New_York",
      nowMs: Date.parse("2027-06-01T20:00:00Z"),
    });
    expect(rows.map((w) => w.id)).toEqual(["w1", "late"]);
  });

  it("leaves out deleted windows, other gates and other projects", () => {
    const rows = windowsToday(
      [
        window({ id: "a", deleted_at: "2027-01-01T00:00:00Z" }),
        window({ id: "b", zone_id: "z2" }),
        window({ id: "c", project_id: "p2" }),
      ],
      { projectId: "p1", zoneId: "z1", timeZone: "UTC", nowMs: Date.parse("2027-06-01T12:00:00Z") },
    );
    expect(rows).toEqual([]);
  });

  it("counts only a window's live bookings", () => {
    expect(
      bookingsOf(
        [
          slot(),
          slot({ id: "s2", deleted_at: "2027-01-01T00:00:00Z" }),
          slot({ id: "s3", delivery_window_id: "w2" }),
        ],
        "w1",
      ).map((s) => s.id),
    ).toEqual(["s1"]);
  });

  it("computes each status from the gate row and check-in", () => {
    expect(bookingStatus(slot(), null)).toBe("Expected");
    expect(bookingStatus(slot(), gateRow())).toBe("Waiting");
    expect(bookingStatus(slot(), gateRow({ released_at: "2027-06-01T12:20:00Z" }))).toBe(
      "Released",
    );
    expect(bookingStatus(slot({ checked_in_at: "2027-06-01T12:30:00Z" }), gateRow())).toBe(
      "Checked In",
    );
  });

  it("finds a gate row by its slot, and never a deleted one", () => {
    expect(gateRowOf([gateRow()], "s1")?.id).toBe("g1");
    expect(gateRowOf([gateRow({ deleted_at: "2027-01-01T00:00:00Z" })], "s1")).toBeNull();
  });

  it("finds by reference code or plate, ignoring case, spaces and dashes", () => {
    const rows = [slot(), slot({ id: "s2", reference_code: "XYZ789", vehicle_identifier: null })];
    expect(findBookings(rows, { projectId: "p1", query: "abc234" }).map((s) => s.id)).toEqual([
      "s1",
    ]);
    expect(findBookings(rows, { projectId: "p1", query: "fl abc 123" }).map((s) => s.id)).toEqual([
      "s1",
    ]);
    expect(findBookings(rows, { projectId: "p1", query: "XYZ" }).map((s) => s.id)).toEqual(["s2"]);
    expect(findBookings(rows, { projectId: "p2", query: "XYZ" })).toEqual([]);
    expect(findBookings(rows, { projectId: "p1", query: "  " })).toEqual([]);
  });

  it("does not find a direct slot, which has no code to quote", () => {
    expect(
      findBookings([slot({ delivery_window_id: null })], { projectId: "p1", query: "ABC" }),
    ).toEqual([]);
  });

  it("queues Arrived with an id of its own, so it replays once", () => {
    const arrived = buildBookingArrival(
      slot(),
      null,
      Date.parse("2027-06-01T12:00:00Z"),
      () => "m1",
    );
    expect(arrived).toMatchObject({
      op: "rpc",
      target: "app.record_booking_arrival",
      rowId: "m1",
      policy: "append",
      payload: { p_dock_slot_id: "s1", p_vehicle_identifier: null, p_event_id: "m1" },
    });
    expect(arrived.optimistic).toMatchObject({
      vehicle_identifier: "FL ABC-123",
      dock_slot_id: "s1",
    });
  });

  it("releases the row the server was told to make, online or queued", () => {
    const arrived = buildBookingArrival(slot(), null, 1000, () => "m1");
    const row = arrived.optimistic as unknown as GateRow;
    const released = buildRelease(row, 2000);
    expect(row.id).toBe(arrived.payload?.["p_event_id"]);
    expect(released.payload).toEqual({ p_gate_queue_id: arrived.payload?.["p_event_id"] });
  });

  it("sends the plate typed, trimmed, ahead of the slot's", () => {
    const arrived = buildBookingArrival(slot(), " TX 1 ", 0, () => "m2");
    expect(arrived.payload).toMatchObject({ p_vehicle_identifier: "TX 1" });
    expect(arrived.optimistic).toMatchObject({ vehicle_identifier: "TX 1" });
  });
});
