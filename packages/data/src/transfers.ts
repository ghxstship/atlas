import type { Database, XosClient } from "./client.ts";
import type { OperationsScope } from "./logistics.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Ground transfers repository (B5, RRR-229, ADR 0144; migrations 2941 and 2942): vehicle runs with a driver and a
 * passenger list. Reads come from app.transfer_board (hospitality.fulfillment.read), whose status and warnings are
 * computed on every read; writes need hospitality.fulfillment.write. The database refuses an overlapping driver,
 * vehicle or passenger (transfer_driver_double_booked, transfer_vehicle_double_booked, transfer_passenger_double_booked),
 * a full vehicle (transfer_vehicle_full), the driver as a passenger (transfer_driver_is_passenger), a person off the
 * project (transfer_person_not_on_project), a fulfillment that is not Travel (travel_fulfillment_kind) and a met
 * segment that is not a Flight of the project (transfer_meets_flight). A canceled transfer is restored in place.
 */

type Tables = Database["app"]["Tables"];
type Derived<T> = Omit<T, "org_id">;

export type VehicleType = Database["app"]["Enums"]["vehicle_type"];
export const VEHICLE_TYPES: readonly VehicleType[] = [
  "Sedan",
  "SUV",
  "Van",
  "Sprinter",
  "Minibus",
  "Coach",
  "Other",
];

export type TransferStatus = "Unassigned" | "Assigned" | "Underway" | "Done";
export const TRANSFER_STATUSES: readonly TransferStatus[] = [
  "Unassigned",
  "Assigned",
  "Underway",
  "Done",
];

export interface Transfer {
  readonly id: string;
  readonly projectId: string;
  readonly number: number;
  readonly key: string;
  readonly fulfillmentId: string | null;
  readonly vehicleId: string | null;
  readonly vehicleLabel: string | null;
  readonly vehicleType: VehicleType | null;
  /** Passenger seats; the driver is not counted. */
  readonly seats: number | null;
  readonly driverPersonId: string | null;
  readonly driverName: string | null;
  readonly pickupPlace: string;
  readonly pickupAt: string;
  readonly pickupTimeZone: string;
  readonly dropoffPlace: string;
  readonly dropoffAt: string;
  readonly dropoffTimeZone: string;
  readonly meetsSegmentId: string | null;
  readonly meetsServiceIdentifier: string | null;
  readonly meetsArrivesAt: string | null;
  readonly flightLandsAfterPickup: boolean;
  readonly passengerCount: number;
  readonly primaryPassengerId: string | null;
  readonly primaryPassengerName: string | null;
  readonly tightTurnaround: boolean;
  readonly status: TransferStatus;
  readonly notes: string | null;
}

export interface TransferPassenger {
  readonly id: string;
  readonly personId: string;
  readonly personName: string | null;
  readonly isPrimary: boolean;
}

export interface TransferDetail extends Transfer {
  readonly passengers: readonly TransferPassenger[];
}

interface BoardRow {
  id: string;
  project_id: string;
  transfer_number: number;
  transfer_key: string | null;
  fulfillment_id: string | null;
  vehicle_id: string | null;
  vehicle_label: string | null;
  vehicle_type: VehicleType | null;
  seats: number | null;
  driver_person_id: string | null;
  driver_name: string | null;
  pickup_place: string;
  pickup_at: string;
  pickup_time_zone: string;
  dropoff_place: string;
  dropoff_at: string;
  dropoff_time_zone: string;
  meets_travel_segment_id: string | null;
  meets_service_identifier: string | null;
  meets_flight_arrives_at: string | null;
  meets_flight_after_pickup: boolean | null;
  passenger_count: number | null;
  primary_passenger_id: string | null;
  primary_passenger_name: string | null;
  tight_turnaround: boolean | null;
  status: string | null;
  notes: string | null;
}

const BOARD_COLUMNS =
  "id, project_id, transfer_number, transfer_key, fulfillment_id, vehicle_id, vehicle_label, vehicle_type, seats, " +
  "driver_person_id, driver_name, pickup_place, pickup_at, pickup_time_zone, dropoff_place, dropoff_at, dropoff_time_zone, " +
  "meets_travel_segment_id, meets_service_identifier, meets_flight_arrives_at, meets_flight_after_pickup, passenger_count, " +
  "primary_passenger_id, primary_passenger_name, tight_turnaround, status, notes";

const asStatus = (v: string | null): TransferStatus =>
  (TRANSFER_STATUSES as readonly string[]).includes(v ?? "") ? (v as TransferStatus) : "Unassigned";

export function toTransfer(row: BoardRow): Transfer {
  return {
    id: row.id,
    projectId: row.project_id,
    number: row.transfer_number,
    key: row.transfer_key ?? "",
    fulfillmentId: row.fulfillment_id,
    vehicleId: row.vehicle_id,
    vehicleLabel: row.vehicle_label,
    vehicleType: row.vehicle_type,
    seats: row.seats,
    driverPersonId: row.driver_person_id,
    driverName: row.driver_name,
    pickupPlace: row.pickup_place,
    pickupAt: row.pickup_at,
    pickupTimeZone: row.pickup_time_zone,
    dropoffPlace: row.dropoff_place,
    dropoffAt: row.dropoff_at,
    dropoffTimeZone: row.dropoff_time_zone,
    meetsSegmentId: row.meets_travel_segment_id,
    meetsServiceIdentifier: row.meets_service_identifier,
    meetsArrivesAt: row.meets_flight_arrives_at,
    flightLandsAfterPickup: row.meets_flight_after_pickup === true,
    passengerCount: row.passenger_count ?? 0,
    primaryPassengerId: row.primary_passenger_id,
    primaryPassengerName: row.primary_passenger_name,
    tightTurnaround: row.tight_turnaround === true,
    status: asStatus(row.status),
    notes: row.notes,
  };
}

export interface TransferScope extends OperationsScope {
  /** Transfers picking up on or after this instant. */
  readonly from?: string | undefined;
  /** Transfers picking up before this instant. */
  readonly to?: string | undefined;
  readonly driverPersonId?: string | undefined;
}

function one<T>(data: T[] | null): Result<T> {
  const row = data?.[0];
  return row === undefined ? fail({ kind: "not-found" }) : ok(row);
}

/** Live transfers in pickup order. */
export async function listTransfers(
  db: XosClient,
  scope: TransferScope,
): Promise<Result<Transfer[]>> {
  let query = db.from("transfer_board").select(BOARD_COLUMNS).eq("org_id", scope.orgId);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  if (scope.driverPersonId) query = query.eq("driver_person_id", scope.driverPersonId);
  if (scope.from) query = query.gte("pickup_at", scope.from);
  if (scope.to) query = query.lt("pickup_at", scope.to);
  const { data, error } = await query.order("pickup_at").order("transfer_number");
  if (error) return fail(toDataError(error));
  return ok((data as unknown as BoardRow[]).map(toTransfer));
}

/** One live transfer with its passengers, or not-found. */
export async function getTransfer(db: XosClient, id: string): Promise<Result<TransferDetail>> {
  const { data, error } = await db
    .from("transfer_board")
    .select(BOARD_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const passengers = await listTransferPassengers(db, id);
  if (!passengers.ok) return passengers;
  return ok({ ...toTransfer(data as unknown as BoardRow), passengers: passengers.data });
}

/** Live passengers of a transfer, primary first, then by name. Names come through app.person_names. */
export async function listTransferPassengers(
  db: XosClient,
  transferId: string,
): Promise<Result<TransferPassenger[]>> {
  const { data, error } = await db
    .from("transfer_passengers")
    .select("id, person_id, is_primary")
    .eq("transfer_id", transferId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as { id: string; person_id: string; is_primary: boolean }[];
  const names = new Map<string, string>();
  if (rows.length > 0) {
    const named = await db.rpc("person_names", { p_person_ids: rows.map((r) => r.person_id) });
    if (named.error) return fail(toDataError(named.error));
    for (const n of named.data ?? []) names.set(n.person_id, n.full_name);
  }
  return ok(
    rows
      .map((r) => ({
        id: r.id,
        personId: r.person_id,
        personName: names.get(r.person_id) ?? null,
        isPrimary: r.is_primary,
      }))
      .sort(
        (a, b) =>
          Number(b.isPrimary) - Number(a.isPrimary) ||
          (a.personName ?? "").localeCompare(b.personName ?? ""),
      ),
  );
}

export interface TransferInput {
  readonly fulfillmentId: string | null;
  readonly vehicleId: string | null;
  readonly driverPersonId: string | null;
  readonly pickupPlace: string;
  readonly pickupAt: string;
  readonly pickupTimeZone: string;
  readonly dropoffPlace: string;
  readonly dropoffAt: string;
  readonly dropoffTimeZone: string;
  readonly meetsSegmentId: string | null;
  readonly notes: string | null;
}

function transferColumns(input: TransferInput) {
  return {
    fulfillment_id: input.fulfillmentId,
    vehicle_id: input.vehicleId,
    driver_person_id: input.driverPersonId,
    pickup_place: input.pickupPlace,
    pickup_at: input.pickupAt,
    pickup_time_zone: input.pickupTimeZone,
    dropoff_place: input.dropoffPlace,
    dropoff_at: input.dropoffAt,
    dropoff_time_zone: input.dropoffTimeZone,
    meets_travel_segment_id: input.meetsSegmentId,
    notes: input.notes,
  };
}

/** Books a transfer on the project. */
export async function createTransfer(
  db: XosClient,
  projectId: string,
  input: TransferInput,
): Promise<Result<{ id: string }>> {
  const row: Derived<Tables["transfers"]["Insert"]> = {
    project_id: projectId,
    ...transferColumns(input),
  };
  const { data, error } = await db
    .from("transfers")
    .insert(row as Tables["transfers"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  return one(data);
}

/** Edits a transfer, refusing with a conflict when it changed since `expectedUpdatedAt`. */
export async function updateTransfer(
  db: XosClient,
  id: string,
  input: TransferInput,
  expectedUpdatedAt?: string,
): Promise<Result<null>> {
  let query = db.from("transfers").update(transferColumns(input)).eq("id", id);
  if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error } = await query.select("id");
  if (error) return fail(toDataError(error));
  if (data.length === 1) return ok(null);
  return expectedUpdatedAt
    ? fail({ kind: "conflict", message: "transfer_changed" })
    : fail({ kind: "not-found" });
}

async function setDeleted(
  db: XosClient,
  table: "transfers" | "transfer_vehicles" | "transfer_passengers",
  id: string,
  deleted: boolean,
): Promise<Result<null>> {
  const { data, error } = await db
    .from(table)
    .update({ deleted_at: deleted ? new Date().toISOString() : null })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/** Cancels a transfer; its passengers stay with it. */
export function cancelTransfer(db: XosClient, id: string): Promise<Result<null>> {
  return setDeleted(db, "transfers", id, true);
}

/** Restores a canceled transfer in place; the guard checks every person and the vehicle again. */
export function restoreTransfer(db: XosClient, id: string): Promise<Result<null>> {
  return setDeleted(db, "transfers", id, false);
}

// Passengers ---------------------------------------------------------------------------------------------------------

export async function addTransferPassenger(
  db: XosClient,
  transferId: string,
  personId: string,
  isPrimary = false,
): Promise<Result<{ id: string }>> {
  const row: Derived<Tables["transfer_passengers"]["Insert"]> = {
    transfer_id: transferId,
    person_id: personId,
    is_primary: isPrimary,
  };
  const { data, error } = await db
    .from("transfer_passengers")
    .insert(row as Tables["transfer_passengers"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  return one(data);
}

export function removeTransferPassenger(db: XosClient, passengerId: string): Promise<Result<null>> {
  return setDeleted(db, "transfer_passengers", passengerId, true);
}

/** Marks one passenger primary: clears the current primary first, as the unique index allows only one. */
export async function setPrimaryPassenger(
  db: XosClient,
  transferId: string,
  passengerId: string,
): Promise<Result<null>> {
  const cleared = await db
    .from("transfer_passengers")
    .update({ is_primary: false })
    .eq("transfer_id", transferId)
    .eq("is_primary", true)
    .is("deleted_at", null)
    .select("id");
  if (cleared.error) return fail(toDataError(cleared.error));
  const { data, error } = await db
    .from("transfer_passengers")
    .update({ is_primary: true })
    .eq("id", passengerId)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export interface TransferPersonOption {
  readonly personId: string;
  readonly fullName: string;
  readonly partyName: string | null;
  readonly rosterEntryId: string | null;
  readonly membershipId: string | null;
  readonly engagementId: string | null;
}

/** People a transfer of the project may carry or be driven by (app.transfer_person_options). */
export async function listTransferPersonOptions(
  db: XosClient,
  projectId: string,
): Promise<Result<TransferPersonOption[]>> {
  const { data, error } = await db.rpc("transfer_person_options", { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      personId: r.person_id,
      fullName: r.full_name,
      partyName: r.party_name,
      rosterEntryId: r.roster_entry_id,
      membershipId: r.membership_id,
      engagementId: r.engagement_id,
    })),
  );
}

// Vehicles -----------------------------------------------------------------------------------------------------------

export interface TransferVehicle {
  readonly id: string;
  readonly projectId: string;
  readonly label: string;
  readonly vehicleType: VehicleType;
  readonly seats: number;
  readonly supplierId: string | null;
}

export interface TransferVehicleInput {
  readonly label: string;
  readonly vehicleType: VehicleType;
  readonly seats: number;
  readonly supplierId: string | null;
}

/** Live vehicles of a project, by label. */
export async function listTransferVehicles(
  db: XosClient,
  scope: OperationsScope,
): Promise<Result<TransferVehicle[]>> {
  let query = db
    .from("transfer_vehicles")
    .select("id, project_id, label, vehicle_type, seats, counterparty_id")
    .eq("org_id", scope.orgId)
    .is("deleted_at", null);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  const { data, error } = await query.order("label");
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      id: r.id,
      projectId: r.project_id,
      label: r.label,
      vehicleType: r.vehicle_type,
      seats: r.seats,
      supplierId: r.counterparty_id,
    })),
  );
}

export async function createTransferVehicle(
  db: XosClient,
  projectId: string,
  input: TransferVehicleInput,
): Promise<Result<{ id: string }>> {
  const row: Derived<Tables["transfer_vehicles"]["Insert"]> = {
    project_id: projectId,
    label: input.label,
    vehicle_type: input.vehicleType,
    seats: input.seats,
    counterparty_id: input.supplierId,
  };
  const { data, error } = await db
    .from("transfer_vehicles")
    .insert(row as Tables["transfer_vehicles"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  return one(data);
}

/** Edits a vehicle; fewer seats than a live transfer carries is refused (transfer_vehicle_full). */
export async function updateTransferVehicle(
  db: XosClient,
  id: string,
  input: TransferVehicleInput,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("transfer_vehicles")
    .update({
      label: input.label,
      vehicle_type: input.vehicleType,
      seats: input.seats,
      counterparty_id: input.supplierId,
    })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/** Moves a vehicle to Trash, or restores it with `deleted` false. */
export function deleteTransferVehicle(
  db: XosClient,
  id: string,
  deleted = true,
): Promise<Result<null>> {
  return setDeleted(db, "transfer_vehicles", id, deleted);
}
