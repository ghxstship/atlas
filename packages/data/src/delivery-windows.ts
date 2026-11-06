import type { Database, XosClient } from "./client.ts";
import { readRows, rpcValue } from "./commercial-common.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Delivery windows (B11, RRR-235, G-115, ADR 0150): a gate open for a time for a number of vehicles. A booking is a dock
 * slot, so check-in, approvals, the Gateway tab and sync keep one source. Bookings are made only through
 * app.book_delivery_window, whose event id is the slot id; a replay creates nothing. The refusals (delivery_window_full,
 * delivery_window_closed, delivery_booking_shipment and the rest) come back as the database raises them.
 */

type Tables = Database["app"]["Tables"];
type ExternalViews = Database["api_external"]["Views"];

export interface DeliveryBooking {
  readonly id: string;
  readonly referenceCode: string | null;
  readonly engagementId: string | null;
  readonly vendorName: string | null;
  readonly vehicleIdentifier: string | null;
  readonly checkedInAt: string | null;
}

export interface DeliveryWindow {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly timeZone: string;
  readonly zoneId: string;
  readonly zoneName: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly vehicleLimit: number;
  readonly isOpen: boolean;
  readonly bookings: readonly DeliveryBooking[];
}

interface WindowRow {
  id: string;
  project_id: string;
  zone_id: string;
  starts_at: string;
  ends_at: string;
  vehicle_limit: number;
  is_open: boolean;
  project: { project_key: string; time_zone: string } | null;
  zone: { name: string | null } | null;
  bookings: {
    id: string;
    reference_code: string | null;
    engagement_id: string | null;
    vehicle_identifier: string | null;
    checked_in_at: string | null;
    deleted_at: string | null;
    engagement: {
      counterparty: { organization: { name: string | null } | null } | null;
    } | null;
  }[];
}

const WINDOW_COLUMNS =
  "id, project_id, zone_id, starts_at, ends_at, vehicle_limit, is_open, project:projects(project_key, time_zone), zone:zones(name), bookings:dock_slots!dock_slots_delivery_window_id_fkey(id, reference_code, engagement_id, vehicle_identifier, checked_in_at, deleted_at, engagement:engagements(counterparty:counterparties(organization:organizations(name))))";

function toWindow(row: WindowRow): DeliveryWindow {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? "",
    timeZone: row.project?.time_zone ?? "UTC",
    zoneId: row.zone_id,
    zoneName: row.zone?.name ?? null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    vehicleLimit: row.vehicle_limit,
    isOpen: row.is_open,
    bookings: row.bookings
      .filter((b) => b.deleted_at === null)
      .map((b) => ({
        id: b.id,
        referenceCode: b.reference_code,
        engagementId: b.engagement_id,
        vendorName: b.engagement?.counterparty?.organization?.name ?? null,
        vehicleIdentifier: b.vehicle_identifier,
        checkedInAt: b.checked_in_at,
      })),
  };
}

/** Live windows of an org or one project, in start order, with their live bookings. */
export async function listDeliveryWindows(
  db: XosClient,
  scope: { readonly orgId: string; readonly projectId?: string; readonly from?: string; readonly to?: string },
): Promise<Result<DeliveryWindow[]>> {
  let query = db
    .from("delivery_windows")
    .select(WINDOW_COLUMNS)
    .eq("org_id", scope.orgId)
    .is("deleted_at", null);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  if (scope.from) query = query.gte("ends_at", scope.from);
  if (scope.to) query = query.lt("starts_at", scope.to);
  const { data, error } = await query.order("starts_at");
  if (error) return fail(toDataError(error));
  return ok((data as unknown as WindowRow[]).map(toWindow));
}

export interface DeliveryWindowSchedule {
  readonly projectId: string;
  readonly zoneId: string;
  readonly firstDay: string;
  readonly lastDay: string;
  readonly fromTime: string;
  readonly toTime: string;
  readonly slotMinutes: number;
  readonly vehicleLimit: number;
}

/** Adds windows at a gate for each day on the project's calendar, DST safe, at most 500. */
export async function createDeliveryWindows(
  db: XosClient,
  input: DeliveryWindowSchedule,
): Promise<Result<string[]>> {
  const result = await rpcValue(
    db.rpc("create_delivery_windows", {
      p_project_id: input.projectId,
      p_zone_id: input.zoneId,
      p_first_day: input.firstDay,
      p_last_day: input.lastDay,
      p_from_time: input.fromTime,
      p_to_time: input.toTime,
      p_slot_minutes: input.slotMinutes,
      p_vehicle_limit: input.vehicleLimit,
    }),
  );
  return result.ok ? ok(result.data as string[]) : result;
}

export async function setDeliveryWindowOpen(
  db: XosClient,
  id: string,
  isOpen: boolean,
): Promise<Result<null>> {
  const { error } = await db
    .from("delivery_windows")
    .update({ is_open: isOpen } as Tables["delivery_windows"]["Update"])
    .eq("id", id);
  return error ? fail(toDataError(error)) : ok(null);
}

export interface BookDeliveryInput {
  readonly eventId: string;
  readonly windowId: string;
  readonly engagementId: string | null;
  readonly vehicleIdentifier: string | null;
  readonly shipmentId: string | null;
}

export async function bookDeliveryWindow(
  db: XosClient,
  input: BookDeliveryInput,
): Promise<Result<{ id: string }>> {
  const result = await rpcValue(
    db.rpc("book_delivery_window", {
      p_event_id: input.eventId,
      p_window_id: input.windowId,
      ...(input.engagementId ? { p_engagement_id: input.engagementId } : {}),
      ...(input.vehicleIdentifier ? { p_vehicle_identifier: input.vehicleIdentifier } : {}),
      ...(input.shipmentId ? { p_shipment_id: input.shipmentId } : {}),
    }),
  );
  return result.ok ? ok({ id: result.data as string }) : result;
}

export async function cancelDeliveryBooking(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db.rpc("cancel_delivery_booking", { p_dock_slot_id: id });
  return error ? fail(toDataError(error)) : ok(null);
}

export async function setDeliveryBookingVehicle(
  db: XosClient,
  id: string,
  vehicleIdentifier: string | null,
): Promise<Result<null>> {
  const { error } = await db.rpc("set_delivery_booking_vehicle", {
    p_dock_slot_id: id,
    p_vehicle_identifier: vehicleIdentifier as string,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

// What an external account reads --------------------------------------------------------------------------------------

export interface OpenDeliveryWindow {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly timeZone: string;
  readonly zoneName: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly placesLeft: number;
}

/** Open, future windows of the projects the caller supplies as a vendor; never another vendor. */
export async function listOpenDeliveryWindows(
  db: XosClient,
  projectId: string,
): Promise<Result<OpenDeliveryWindow[]>> {
  return readRows(
    db
      .schema("api_external")
      .from("delivery_windows")
      .select("*")
      .eq("project_id", projectId)
      .order("starts_at"),
    (row: ExternalViews["delivery_windows"]["Row"]) => ({
      id: row.id ?? "",
      projectId: row.project_id ?? "",
      projectName: row.project_name ?? "",
      timeZone: row.time_zone ?? "UTC",
      zoneName: row.zone_name ?? row.zone_code ?? "",
      startsAt: row.starts_at ?? "",
      endsAt: row.ends_at ?? "",
      placesLeft: row.places_left ?? 0,
    }),
  );
}
