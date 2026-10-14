import type { Database, XosClient } from "./client";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result";

/**
 * Logistics repository (Section 4.2, RRR-23): shipments and their lines, dock slots, the gate
 * queue and the append-only marshalling yard log of migration 0351. Reads run under row level
 * security with logistics.shipment.read; writes need logistics.shipment.write, .dock_slot.write,
 * .yard.write or .release.approve, and the database refuses anything else. Dock slots at one zone
 * never overlap (XR001 dock_slot_overlap); a vehicle release is stamped once by the database.
 */

type Tables = Database["app"]["Tables"];
/** Inserts whose org_id the database derives from the parent row (ADR 0002 tenant guards). */
type Derived<T> = Omit<T, "org_id">;
type ShipmentInsert = Derived<Tables["shipments"]["Insert"]>;
type ShipmentLineInsert = Derived<Tables["shipment_lines"]["Insert"]>;
type DockSlotInsert = Derived<Tables["dock_slots"]["Insert"]>;
type GateQueueInsert = Derived<Tables["gate_queue"]["Insert"]>;
type MarshallingInsert = Derived<Tables["marshalling_log"]["Insert"]>;

export type ShipmentDirection = Database["app"]["Enums"]["shipment_direction"];
export const SHIPMENT_DIRECTIONS: readonly ShipmentDirection[] = ["Inbound", "Outbound"];

/**
 * Where a shipment stands, derived from its dock slots and gate queue entries, never stored
 * (Section 3.15): Logged, then Booked once a dock slot holds it, At Gate while its vehicle waits in
 * the marshalling yard, Checked In once it checks in at its dock, Released once the vehicle is
 * released from the yard.
 */
export const SHIPMENT_PROGRESS = ["logged", "booked", "at-gate", "checked-in", "released"] as const;
export type ShipmentProgress = (typeof SHIPMENT_PROGRESS)[number];

// Shared lookups ---------------------------------------------------------------------------------

/** A project the viewer may pick when logging operations work; the key and zone come with it. */
export interface OperationsProject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly timeZone: string;
  readonly venueId: string | null;
}

interface ProjectRow {
  id: string;
  project_key: string;
  name: string;
  time_zone: string;
  venue_id: string | null;
}

const PROJECT_COLUMNS = "id, project_key, name, time_zone, venue_id";

function toProject(row: ProjectRow): OperationsProject {
  return {
    id: row.id,
    key: row.project_key,
    name: row.name,
    timeZone: row.time_zone,
    venueId: row.venue_id,
  };
}

/** Projects of the org the viewer can read, in key order. */
export async function listOperationsProjects(
  db: XosClient,
  orgId: string,
): Promise<Result<OperationsProject[]>> {
  const { data, error } = await db
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .is("archived_at", null)
    .order("project_key");
  if (error) return fail(toDataError(error));
  return ok(data.map(toProject));
}

/** One project by its key; not-found when it does not exist or the viewer may not read it. */
export async function findOperationsProject(
  db: XosClient,
  orgId: string,
  projectKey: string,
): Promise<Result<OperationsProject>> {
  const { data, error } = await db
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("org_id", orgId)
    .eq("project_key", projectKey)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return data ? ok(toProject(data)) : fail({ kind: "not-found" });
}

/** A counterparty the org holds a relationship with, named from its one home (ADR 0016, item 13). */
export interface CounterpartyOption {
  readonly id: string;
  readonly name: string | null;
  readonly type: string | null;
}

export async function listCounterpartyOptions(
  db: XosClient,
  orgId: string,
): Promise<Result<CounterpartyOption[]>> {
  const { data, error } = await db
    .from("counterparties")
    .select("id, counterparty_type, counterparty_name")
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((r) => ({ id: r.id, name: r.counterparty_name ?? null, type: r.counterparty_type }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
  );
}

/** A canon enumeration value: the row id is stored, the canon label is shown (ADR 0016, item 8). */
export interface EnumerationOption {
  readonly id: string;
  readonly code: string | null;
  readonly label: string | null;
}

/** Canon Freight Type values in canon order (Section 3.6 ordering). */
export async function listFreightTypes(db: XosClient): Promise<Result<EnumerationOption[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("std_enumeration")
    .select("record_id, enum_code, enum_label, sort_order")
    .eq("enum_domain", "Freight Type")
    .order("sort_order");
  if (error) return fail(toDataError(error));
  return ok(data.map((r) => ({ id: r.record_id, code: r.enum_code, label: r.enum_label })));
}

/** A dock or yard zone at the venue of a project. */
export interface ZoneOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly venueId: string;
}

/** Zones of the given venues in code order; the zones a dock slot or yard entry may name. */
export async function listZoneOptions(
  db: XosClient,
  venueIds: readonly string[],
): Promise<Result<ZoneOption[]>> {
  if (venueIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("zones")
    .select("id, code, name, venue_id")
    .in("venue_id", [...venueIds])
    .is("deleted_at", null)
    .order("code");
  if (error) return fail(toDataError(error));
  return ok(data.map((z) => ({ id: z.id, code: z.code, name: z.name, venueId: z.venue_id })));
}

/** Soft delete: sets deleted_at, which the retention job later purges (ADR 0002). */
async function softDelete(
  db: XosClient,
  table: "shipments" | "shipment_lines" | "dock_slots" | "gate_queue",
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

/** Rows a write affected: none means the row is missing or the viewer may not write it. */
function one<T>(data: T[] | null): Result<T> {
  const row = data?.[0];
  return row === undefined ? fail({ kind: "not-found" }) : ok(row);
}

/** {projectKey}-{number}, the display key of a numbered row (Section 4.5.1). */
export function displayKey(projectKey: string | undefined, number: number): string {
  return `${projectKey ?? ""}-${number}`;
}

const DISPLAY_KEY = /^([A-Z]{2,5})-([1-9][0-9]{0,17})$/;

/** A display key split into its project key and number, or null when it is not one. */
export function parseDisplayKey(key: string): { projectKey: string; number: number } | null {
  const m = DISPLAY_KEY.exec(key);
  return m ? { projectKey: m[1] as string, number: Number(m[2]) } : null;
}

// Time zones ---------------------------------------------------------------------------------------

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Offset of an IANA zone from UTC at an instant, in minutes. */
function zoneOffsetMinutes(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - instant) / 60_000);
}

/**
 * A wall-clock time typed in a project's zone (`2026-11-02T08:00`) as an ISO instant, or null when
 * the text is not a local date and time. Section 7.1: typed local times keep the zone they were
 * entered in; the project zone is that zone for logistics and hospitality windows.
 */
export function localToInstant(local: string, timeZone: string): string | null {
  const m = LOCAL_DATE_TIME.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(wall).getUTCDate() !== d) return null;
  let instant = wall - zoneOffsetMinutes(wall, timeZone) * 60_000;
  instant = wall - zoneOffsetMinutes(instant, timeZone) * 60_000;
  return new Date(instant).toISOString();
}

/** An ISO instant as the wall-clock `YYYY-MM-DDTHH:mm` of a zone, for datetime-local inputs. */
export function instantToLocal(instant: string, timeZone: string): string {
  const at = Date.parse(instant);
  const shifted = new Date(at + zoneOffsetMinutes(at, timeZone) * 60_000);
  return shifted.toISOString().slice(0, 16);
}

// Shipments ---------------------------------------------------------------------------------------

export interface Shipment {
  readonly id: string;
  /** Display key {projectKey}-{number} (Section 4.5.1). */
  readonly key: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly timeZone: string;
  readonly direction: ShipmentDirection;
  readonly carrierId: string | null;
  readonly carrierName: string | null;
  readonly freightTypeId: string | null;
  readonly trackingIdentifier: string | null;
  readonly shipsAt: string | null;
  readonly arrivesAt: string | null;
  readonly createdAt: string;
  readonly progress: ShipmentProgress;
  readonly lineCount: number;
}

export interface ShipmentLine {
  readonly id: string;
  readonly description: string;
  readonly elementId: string | null;
  readonly quantity: number;
}

export interface DockSlot {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly timeZone: string;
  readonly zoneId: string;
  readonly zoneCode: string | null;
  readonly zoneName: string | null;
  readonly shipmentId: string | null;
  readonly engagementId: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly checkedInAt: string | null;
  readonly checkedInByName: string | null;
}

export interface GateEntry {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly timeZone: string;
  readonly shipmentId: string | null;
  readonly vehicleIdentifier: string;
  readonly arrivedAt: string;
  readonly releasedAt: string | null;
  readonly releasedByName: string | null;
}

export interface MarshallingEntry {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly timeZone: string;
  readonly shipmentId: string | null;
  readonly zoneId: string | null;
  readonly zoneCode: string | null;
  readonly entry: string;
  readonly loggedAt: string;
  readonly loggedByName: string | null;
}

export interface ShipmentDetail extends Shipment {
  readonly lines: readonly ShipmentLine[];
  readonly dockSlots: readonly DockSlot[];
  readonly gateEntries: readonly GateEntry[];
  readonly log: readonly MarshallingEntry[];
  readonly updatedAt: string;
}

/** Progress from the facts that decide it: live slots and gate entries (deleted ones ignored). */
export function shipmentProgress(
  slots: readonly { deleted_at: string | null; checked_in_at: string | null }[],
  gate: readonly { deleted_at: string | null; released_at: string | null }[],
): ShipmentProgress {
  const liveGate = gate.filter((g) => g.deleted_at === null);
  const liveSlots = slots.filter((s) => s.deleted_at === null);
  if (liveGate.some((g) => g.released_at !== null)) return "released";
  if (liveSlots.some((s) => s.checked_in_at !== null)) return "checked-in";
  if (liveGate.length > 0) return "at-gate";
  if (liveSlots.length > 0) return "booked";
  return "logged";
}

const SHIPMENT_COLUMNS =
  "id, shipment_number, project_id, direction, carrier_counterparty_id, freight_type_enum_id, tracking_identifier, ships_at, arrives_at, created_at, updated_at, " +
  "project:projects!shipments_project_id_fkey(project_key, name, time_zone), " +
  "carrier:counterparties!shipments_carrier_counterparty_id_fkey(counterparty_name), " +
  "dock_slots(deleted_at, checked_in_at), gate_queue(deleted_at, released_at), shipment_lines(deleted_at)";

interface ShipmentRow {
  id: string;
  shipment_number: number;
  project_id: string;
  direction: ShipmentDirection;
  carrier_counterparty_id: string | null;
  freight_type_enum_id: string | null;
  tracking_identifier: string | null;
  ships_at: string | null;
  arrives_at: string | null;
  created_at: string;
  updated_at: string;
  project: { project_key: string; name: string; time_zone: string } | null;
  carrier: { counterparty_name: string | null } | null;
  dock_slots: { deleted_at: string | null; checked_in_at: string | null }[];
  gate_queue: { deleted_at: string | null; released_at: string | null }[];
  shipment_lines: { deleted_at: string | null }[];
}

function toShipment(row: ShipmentRow): Shipment {
  return {
    id: row.id,
    key: displayKey(row.project?.project_key, row.shipment_number),
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? "",
    projectName: row.project?.name ?? "",
    timeZone: row.project?.time_zone ?? "UTC",
    direction: row.direction,
    carrierId: row.carrier_counterparty_id,
    carrierName: row.carrier?.counterparty_name ?? null,
    freightTypeId: row.freight_type_enum_id,
    trackingIdentifier: row.tracking_identifier,
    shipsAt: row.ships_at,
    arrivesAt: row.arrives_at,
    createdAt: row.created_at,
    progress: shipmentProgress(row.dock_slots, row.gate_queue),
    lineCount: row.shipment_lines.filter((l) => l.deleted_at === null).length,
  };
}

/** Which rows a list covers: one org, optionally narrowed to one project. */
export interface OperationsScope {
  readonly orgId: string;
  readonly projectId?: string | undefined;
}

/** Live shipments, soonest arrival first; shipments without a date follow, newest first. */
export async function listShipments(
  db: XosClient,
  scope: OperationsScope,
): Promise<Result<Shipment[]>> {
  let query = db
    .from("shipments")
    .select(SHIPMENT_COLUMNS)
    .eq("org_id", scope.orgId)
    .is("deleted_at", null);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  const { data, error } = await query
    .order("arrives_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok((data as unknown as ShipmentRow[]).map(toShipment));
}

/** One shipment with its lines, slots, gate entries and yard log, or not-found. */
export async function getShipment(db: XosClient, id: string): Promise<Result<ShipmentDetail>> {
  const { data, error } = await db
    .from("shipments")
    .select(SHIPMENT_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const row = data as unknown as ShipmentRow;
  const [lines, slots, gate, log] = await Promise.all([
    db
      .from("shipment_lines")
      .select("id, description, element_id, quantity")
      .eq("shipment_id", id)
      .is("deleted_at", null)
      .order("created_at"),
    listDockSlots(db, { orgId: "", shipmentId: id }),
    listGateQueue(db, { orgId: "", shipmentId: id }),
    listMarshallingLog(db, { orgId: "", shipmentId: id }),
  ]);
  if (lines.error) return fail(toDataError(lines.error));
  if (!slots.ok) return slots;
  if (!gate.ok) return gate;
  if (!log.ok) return log;
  return ok({
    ...toShipment(row),
    updatedAt: row.updated_at,
    lines: lines.data.map((l) => ({
      id: l.id,
      description: l.description,
      elementId: l.element_id,
      quantity: Number(l.quantity),
    })),
    dockSlots: slots.data,
    gateEntries: gate.data,
    log: log.data,
  });
}

export interface ShipmentInput {
  readonly direction: ShipmentDirection;
  readonly carrierId: string | null;
  readonly freightTypeId: string | null;
  readonly trackingIdentifier: string | null;
  readonly shipsAt: string | null;
  readonly arrivesAt: string | null;
}

function shipmentColumns(input: ShipmentInput) {
  return {
    direction: input.direction,
    carrier_counterparty_id: input.carrierId,
    freight_type_enum_id: input.freightTypeId,
    tracking_identifier: input.trackingIdentifier,
    ships_at: input.shipsAt,
    arrives_at: input.arrivesAt,
  };
}

/** Logs a shipment on a project; the database derives its org from the project. */
export async function createShipment(
  db: XosClient,
  projectId: string,
  input: ShipmentInput,
): Promise<Result<{ id: string }>> {
  const row: ShipmentInsert = { project_id: projectId, ...shipmentColumns(input) };
  const { data, error } = await db
    .from("shipments")
    .insert(row as Tables["shipments"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  return one(data);
}

/**
 * Edits a shipment. `expectedUpdatedAt` is the version the edit started from: when someone else
 * saved in between, the update matches no row and the result is a conflict (Section 11.7).
 */
export async function updateShipment(
  db: XosClient,
  id: string,
  input: ShipmentInput,
  expectedUpdatedAt?: string,
): Promise<Result<null>> {
  let query = db.from("shipments").update(shipmentColumns(input)).eq("id", id);
  if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error } = await query.select("id");
  if (error) return fail(toDataError(error));
  if (data.length === 1) return ok(null);
  return expectedUpdatedAt
    ? fail({ kind: "conflict", message: "shipment_changed" })
    : fail({ kind: "not-found" });
}

/** Moves a shipment to Trash (restorable for its retention period). */
export function deleteShipment(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "shipments", id, true);
}

/** Restores a shipment from Trash: the Undo of deleteShipment. */
export function restoreShipment(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "shipments", id, false);
}

export interface ShipmentLineInput {
  readonly description: string;
  readonly quantity: number;
  readonly elementId?: string | null;
}

/** Adds a manifest line to a shipment. Quantities must be positive (database check). */
export async function addShipmentLine(
  db: XosClient,
  shipmentId: string,
  input: ShipmentLineInput,
): Promise<Result<{ id: string }>> {
  const row: ShipmentLineInsert = {
    shipment_id: shipmentId,
    description: input.description,
    quantity: input.quantity,
    element_id: input.elementId ?? null,
  };
  const { data, error } = await db
    .from("shipment_lines")
    .insert(row as Tables["shipment_lines"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  return one(data);
}

export function removeShipmentLine(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "shipment_lines", id, true);
}

// Dock slots --------------------------------------------------------------------------------------

export interface DockScope extends OperationsScope {
  readonly shipmentId?: string;
  /** Slots that end after this instant. */
  readonly from?: string;
  /** Slots that start before this instant. */
  readonly to?: string;
}

const DOCK_COLUMNS =
  "id, project_id, zone_id, shipment_id, engagement_id, starts_at, ends_at, checked_in_at, " +
  "project:projects!dock_slots_project_id_fkey(project_key, time_zone), zone:zones!dock_slots_zone_id_fkey(code, name), " +
  "checker:people!dock_slots_checked_in_by_fkey(full_name)";

interface DockRow {
  id: string;
  project_id: string;
  zone_id: string;
  shipment_id: string | null;
  engagement_id: string | null;
  starts_at: string;
  ends_at: string;
  checked_in_at: string | null;
  project: { project_key: string; time_zone: string } | null;
  zone: { code: string; name: string } | null;
  checker: { full_name: string | null } | null;
}

function toDockSlot(row: DockRow): DockSlot {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? "",
    timeZone: row.project?.time_zone ?? "UTC",
    zoneId: row.zone_id,
    zoneCode: row.zone?.code ?? null,
    zoneName: row.zone?.name ?? null,
    shipmentId: row.shipment_id,
    engagementId: row.engagement_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    checkedInAt: row.checked_in_at,
    checkedInByName: row.checker?.full_name ?? null,
  };
}

/** Live dock slots in start order. An empty orgId means the scope is a shipment. */
export async function listDockSlots(db: XosClient, scope: DockScope): Promise<Result<DockSlot[]>> {
  let query = db.from("dock_slots").select(DOCK_COLUMNS).is("deleted_at", null);
  if (scope.orgId) query = query.eq("org_id", scope.orgId);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  if (scope.shipmentId) query = query.eq("shipment_id", scope.shipmentId);
  if (scope.from) query = query.gt("ends_at", scope.from);
  if (scope.to) query = query.lt("starts_at", scope.to);
  const { data, error } = await query.order("starts_at");
  if (error) return fail(toDataError(error));
  return ok((data as unknown as DockRow[]).map(toDockSlot));
}

export interface DockSlotInput {
  readonly zoneId: string;
  readonly shipmentId: string | null;
  /** Vendor engagement of the same project the slot serves (migration 0970). */
  readonly engagementId?: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
}

/** Books a dock slot. An overlap at the same dock is refused with dock_slot_overlap. */
export async function bookDockSlot(
  db: XosClient,
  projectId: string,
  input: DockSlotInput,
): Promise<Result<{ id: string }>> {
  const row: DockSlotInsert = {
    project_id: projectId,
    zone_id: input.zoneId,
    shipment_id: input.shipmentId,
    engagement_id: input.engagementId ?? null,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
  };
  const { data, error } = await db
    .from("dock_slots")
    .insert(row as Tables["dock_slots"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  return one(data);
}

/** Moves or reassigns a dock slot; the same overlap rule applies. */
export async function updateDockSlot(
  db: XosClient,
  id: string,
  input: DockSlotInput,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("dock_slots")
    .update({
      zone_id: input.zoneId,
      shipment_id: input.shipmentId,
      engagement_id: input.engagementId ?? null,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
    })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/**
 * Checks a shipment in at its dock slot. The database needs logistics.yard.write or
 * logistics.dock_slot.write, stamps the time and person once, and freezes the slot afterwards.
 */
export async function checkInDockSlot(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("dock_slots")
    .update({ checked_in_at: new Date().toISOString() })
    .eq("id", id)
    .is("checked_in_at", null)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export function cancelDockSlot(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "dock_slots", id, true);
}

export function restoreDockSlot(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "dock_slots", id, false);
}

// Gate queue -------------------------------------------------------------------------------------

export interface GateScope extends OperationsScope {
  readonly shipmentId?: string;
  /** Only vehicles still waiting. */
  readonly waiting?: boolean;
}

const GATE_COLUMNS =
  "id, project_id, shipment_id, vehicle_identifier, arrived_at, released_at, " +
  "project:projects!gate_queue_project_id_fkey(project_key, time_zone), releaser:people!gate_queue_released_by_fkey(full_name)";

interface GateRow {
  id: string;
  project_id: string;
  shipment_id: string | null;
  vehicle_identifier: string;
  arrived_at: string;
  released_at: string | null;
  project: { project_key: string; time_zone: string } | null;
  releaser: { full_name: string | null } | null;
}

function toGateEntry(row: GateRow): GateEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? "",
    timeZone: row.project?.time_zone ?? "UTC",
    shipmentId: row.shipment_id,
    vehicleIdentifier: row.vehicle_identifier,
    arrivedAt: row.arrived_at,
    releasedAt: row.released_at,
    releasedByName: row.releaser?.full_name ?? null,
  };
}

/** Gate queue entries in arrival order. */
export async function listGateQueue(db: XosClient, scope: GateScope): Promise<Result<GateEntry[]>> {
  let query = db.from("gate_queue").select(GATE_COLUMNS).is("deleted_at", null);
  if (scope.orgId) query = query.eq("org_id", scope.orgId);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  if (scope.shipmentId) query = query.eq("shipment_id", scope.shipmentId);
  if (scope.waiting) query = query.is("released_at", null);
  const { data, error } = await query.order("arrived_at");
  if (error) return fail(toDataError(error));
  return ok((data as unknown as GateRow[]).map(toGateEntry));
}

/** Records a vehicle arriving at the gate, with the shipment it carries when known. */
export async function recordGateArrival(
  db: XosClient,
  projectId: string,
  input: { readonly vehicleIdentifier: string; readonly shipmentId: string | null },
): Promise<Result<{ id: string }>> {
  const row: GateQueueInsert = {
    project_id: projectId,
    vehicle_identifier: input.vehicleIdentifier,
    shipment_id: input.shipmentId,
  };
  const { data, error } = await db
    .from("gate_queue")
    .insert(row as Tables["gate_queue"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  return one(data);
}

/**
 * Releases a waiting vehicle into the site. The database needs logistics.release.approve and
 * stamps the time and releasing person once; a second release keeps the first stamp.
 */
export async function releaseVehicle(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("gate_queue")
    .update({ released_at: new Date().toISOString() })
    .eq("id", id)
    .is("released_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export function removeGateEntry(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "gate_queue", id, true);
}

// Marshalling yard log ------------------------------------------------------------------------------

export interface LogScope extends OperationsScope {
  readonly shipmentId?: string;
}

const LOG_COLUMNS =
  "id, project_id, shipment_id, zone_id, entry, logged_at, " +
  "project:projects!marshalling_log_project_id_fkey(project_key, time_zone), zone:zones!marshalling_log_zone_id_fkey(code), " +
  "author:people!marshalling_log_created_by_fkey(full_name)";

interface LogRow {
  id: string;
  project_id: string;
  shipment_id: string | null;
  zone_id: string | null;
  entry: string;
  logged_at: string;
  project: { project_key: string; time_zone: string } | null;
  zone: { code: string } | null;
  author: { full_name: string | null } | null;
}

function toLogEntry(row: LogRow): MarshallingEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? "",
    timeZone: row.project?.time_zone ?? "UTC",
    shipmentId: row.shipment_id,
    zoneId: row.zone_id,
    zoneCode: row.zone?.code ?? null,
    entry: row.entry,
    loggedAt: row.logged_at,
    loggedByName: row.author?.full_name ?? null,
  };
}

/** The yard log, newest first. */
export async function listMarshallingLog(
  db: XosClient,
  scope: LogScope,
): Promise<Result<MarshallingEntry[]>> {
  let query = db.from("marshalling_log").select(LOG_COLUMNS);
  if (scope.orgId) query = query.eq("org_id", scope.orgId);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  if (scope.shipmentId) query = query.eq("shipment_id", scope.shipmentId);
  const { data, error } = await query.order("logged_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok((data as unknown as LogRow[]).map(toLogEntry));
}

/** Appends a yard log entry. The log is append-only: entries are never edited or removed. */
export async function addMarshallingEntry(
  db: XosClient,
  projectId: string,
  input: {
    readonly entry: string;
    readonly shipmentId: string | null;
    readonly zoneId: string | null;
  },
): Promise<Result<{ id: string }>> {
  const row: MarshallingInsert = {
    project_id: projectId,
    entry: input.entry,
    shipment_id: input.shipmentId,
    zone_id: input.zoneId,
  };
  const { data, error } = await db
    .from("marshalling_log")
    .insert(row as Tables["marshalling_log"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  return one(data);
}

// Display key lookup --------------------------------------------------------------------------------

/** Tables whose rows carry a display number from the project record sequence (migration 0440). */
export type NumberedTable = "shipments" | "fulfillments" | "beos" | "accommodation_blocks";

const NUMBER_COLUMN = {
  shipments: "shipment_number",
  fulfillments: "fulfillment_number",
  beos: "beo_number",
  accommodation_blocks: "block_number",
} as const satisfies Record<NumberedTable, string>;

interface KeyQuery {
  eq(column: string, value: string | number): KeyQuery;
  is(column: string, value: null): KeyQuery;
  maybeSingle(): PromiseLike<{ data: { id: string } | null; error: DatabaseErrorLike | null }>;
}

/**
 * The id of a live row of `table` with the display key `key` in the org, or not-found. Pages use it
 * for `?peek={key}`: a key that names a row in another table, another org or nothing at all is the
 * same not-found (ADR 0003).
 */
export async function findIdByKey(
  db: XosClient,
  orgId: string,
  table: NumberedTable,
  key: string,
): Promise<Result<string>> {
  const parsed = parseDisplayKey(key);
  if (!parsed) return fail({ kind: "not-found" });
  const project = await findOperationsProject(db, orgId, parsed.projectKey);
  if (!project.ok) return project;
  // The number column differs per table, which the builder's generated types cannot express for a
  // union of tables, so the query is typed by the columns it touches.
  const { data, error } = await (db.from(table).select("id") as unknown as KeyQuery)
    .eq("project_id", project.data.id)
    .eq(NUMBER_COLUMN[table], parsed.number)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return data ? ok(data.id) : fail({ kind: "not-found" });
}

// Access ---------------------------------------------------------------------------------------------

/** Logistics and hospitality capabilities the viewer may use, per project (migration 0441). */
export interface OperationsAccess {
  /** True when the viewer may use the capability on the project. */
  can(projectId: string, capability: string): boolean;
  /** Projects on which the viewer may use the capability. */
  projectsWith(capability: string): ReadonlySet<string>;
}

export async function getOperationsAccess(
  db: XosClient,
  orgId: string,
): Promise<Result<OperationsAccess>> {
  const { data, error } = await db.rpc("operations_project_capabilities", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  const byCapability = new Map<string, Set<string>>();
  for (const row of data) {
    const set = byCapability.get(row.capability_code) ?? new Set<string>();
    set.add(row.project_id);
    byCapability.set(row.capability_code, set);
  }
  const none: ReadonlySet<string> = new Set();
  return ok({
    can: (projectId, capability) => byCapability.get(capability)?.has(projectId) ?? false,
    projectsWith: (capability) => byCapability.get(capability) ?? none,
  });
}
