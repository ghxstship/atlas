import { ATTACHMENTS_BUCKET } from "./attachments.ts";
import type { Database, XosClient } from "./client.ts";
import { imageSize } from "./image-size.ts";
import type { PlanCalibration, PlanPoint } from "./places-geometry.ts";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result.ts";

/**
 * Places repository (Section 4.2 Places, Section 7.4 Places): venues, spaces, zones, capability
 * documents, site plans and their pins. Reads go through row level security, so each function sees
 * exactly what the signed-in person may see; writes go through the table policies of migrations
 * 0301 and 0350 (places.venue.write, places.space.write, places.capability_document.write,
 * places.site_plan.write) and their guards. Rows are archived through deleted_at, never deleted.
 * Canon (jurisdictions, URID categories) is read from xpms and never retyped here.
 */

// Shared ---------------------------------------------------------------------------------------

/** Whether a list shows live rows only, archived rows only, or both. */
export type ArchiveFilter = "live" | "archived" | "all";

/** The first written row's id, or not-found when row level security filtered the write out. */
export function writeResult(
  data: readonly { id: string }[] | null,
  error: DatabaseErrorLike | null,
): Result<{ id: string }> {
  if (error) return fail(toDataError(error));
  const row = data?.[0];
  return row ? ok({ id: row.id }) : fail({ kind: "not-found" });
}

/**
 * Calls an RPC of migration 0420 or later whose signature reaches database.types.ts when the types
 * are regenerated after merge. Argument and result shapes are declared at each call site from the
 * migration.
 */
export async function callRpc<T>(
  db: XosClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<Result<T>> {
  // Cast the client, not db.rpc.bind(db), which exceeds TypeScript's depth limit as the schema grows (TS2589).
  const client = db as unknown as {
    rpc(
      name: string,
      params: Record<string, unknown>,
    ): PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;
  };
  const { data, error } = await client.rpc(fn, args);
  return error ? fail(toDataError(error)) : ok(data as T);
}

type Insert<T extends keyof Database["app"]["Tables"]> = Database["app"]["Tables"][T]["Insert"];

/**
 * An insert whose org_id the tenant guard derives from the parent row (ADR 0002). The database never
 * accepts a caller's org_id there, so none is sent.
 */
export function derivedOrg<T extends keyof Database["app"]["Tables"]>(
  row: Omit<Insert<T>, "org_id">,
): Insert<T> {
  return row as Insert<T>;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// Canon pickers ----------------------------------------------------------------------------------

export interface Jurisdiction {
  readonly id: string;
  readonly level: "country" | "region" | "ahj";
  readonly parent: string | null;
  /** False for a declared but unpopulated jurisdiction: permit and code questions have no answer. */
  readonly populated: boolean;
}

/** Canon jurisdictions (Bible tab 11) in canon order. */
export async function listJurisdictions(db: XosClient): Promise<Result<Jurisdiction[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("jurisdiction")
    .select("jurisdiction_id, level, parent, status")
    .order("ordinal");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((j) => ({
      id: j.jurisdiction_id,
      level: j.level as Jurisdiction["level"],
      parent: j.parent,
      populated: j.status === "populated",
    })),
  );
}

export interface UridCategory {
  readonly urid: string;
  readonly name: string;
}

/** Canon URID categories (Bible tab 03) in URID order, for space types and requirements. */
export async function listUridCategories(db: XosClient): Promise<Result<UridCategory[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("dim_category")
    .select("cat_urid, category")
    .order("cat_urid");
  if (error) return fail(toDataError(error));
  return ok(data.map((c) => ({ urid: c.cat_urid, name: c.category })));
}

// Venues -----------------------------------------------------------------------------------------

export interface Venue {
  readonly id: string;
  readonly name: string;
  readonly jurisdictionId: string;
  readonly timeZone: string;
  readonly streetAddress: string | null;
  readonly locality: string | null;
  readonly postalCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  /** Latitude in degrees; NULL when the venue is not located. A map never guesses a position. */
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly spaceCount: number;
  readonly zoneCount: number;
  readonly documentCount: number;
}

export interface VenueInput {
  readonly name: string;
  readonly jurisdictionId: string;
  readonly timeZone: string;
  readonly streetAddress?: string | null;
  readonly locality?: string | null;
  readonly postalCode?: string | null;
}

const VENUE_COLUMNS =
  "id, name, jurisdiction_id, time_zone, street_address, locality, postal_code, created_at, updated_at, deleted_at, latitude:venue_latitude, longitude:venue_longitude, spaces(count), zones(count), capability_documents(count)";

interface VenueRow {
  id: string;
  name: string;
  jurisdiction_id: string;
  time_zone: string;
  street_address: string | null;
  locality: string | null;
  postal_code: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  latitude: number | null;
  longitude: number | null;
  spaces: { count: number }[];
  zones: { count: number }[];
  capability_documents: { count: number }[];
}

function toVenue(row: VenueRow): Venue {
  return {
    id: row.id,
    name: row.name,
    jurisdictionId: row.jurisdiction_id,
    timeZone: row.time_zone,
    streetAddress: row.street_address,
    locality: row.locality,
    postalCode: row.postal_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.deleted_at,
    latitude: row.latitude,
    longitude: row.longitude,
    spaceCount: row.spaces[0]?.count ?? 0,
    zoneCount: row.zones[0]?.count ?? 0,
    documentCount: row.capability_documents[0]?.count ?? 0,
  };
}

/** Venues of the org by name, filtered by archive state. */
export async function listVenues(
  db: XosClient,
  orgId: string,
  archive: ArchiveFilter = "live",
): Promise<Result<Venue[]>> {
  let query = db.from("venues").select(VENUE_COLUMNS).eq("org_id", orgId);
  if (archive === "live") query = query.is("deleted_at", null);
  if (archive === "archived") query = query.not("deleted_at", "is", null);
  const { data, error } = await query.order("name");
  if (error) return fail(toDataError(error));
  return ok((data as unknown as VenueRow[]).map(toVenue));
}

/** One venue by id, or not-found when it does not exist or the caller may not see it. */
export async function getVenue(db: XosClient, id: string): Promise<Result<Venue>> {
  const { data, error } = await db.from("venues").select(VENUE_COLUMNS).eq("id", id).maybeSingle();
  if (error) return fail(toDataError(error));
  return data ? ok(toVenue(data as unknown as VenueRow)) : fail({ kind: "not-found" });
}

export async function createVenue(
  db: XosClient,
  orgId: string,
  input: VenueInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("venues")
    .insert({
      org_id: orgId,
      name: input.name.trim(),
      jurisdiction_id: input.jurisdictionId,
      time_zone: input.timeZone,
      street_address: trimmedOrNull(input.streetAddress),
      locality: trimmedOrNull(input.locality),
      postal_code: trimmedOrNull(input.postalCode),
    })
    .select("id");
  return writeResult(data, error);
}

export async function updateVenue(
  db: XosClient,
  id: string,
  input: VenueInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("venues")
    .update({
      name: input.name.trim(),
      jurisdiction_id: input.jurisdictionId,
      time_zone: input.timeZone,
      street_address: trimmedOrNull(input.streetAddress),
      locality: trimmedOrNull(input.locality),
      postal_code: trimmedOrNull(input.postalCode),
    })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

/** Sets or clears a venue location in degrees (app.set_venue_location: both or neither, in range). */
export async function setVenueLocation(
  db: XosClient,
  id: string,
  location: { readonly latitude: number; readonly longitude: number } | null,
): Promise<Result<{ id: string }>> {
  const result = await callRpc<string>(db, "set_venue_location", {
    p_venue_id: id,
    p_longitude: location?.longitude ?? null,
    p_latitude: location?.latitude ?? null,
  });
  return result.ok ? ok({ id: result.data }) : result;
}

/** The places tables that archive and restore through deleted_at. */
export type PlacesTable =
  | "venues"
  | "spaces"
  | "zones"
  | "capability_documents"
  | "site_plans"
  | "site_plan_pins"
  | "venue_levels"
  | "site_plan_shapes";

/** Archives (soft deletes) or restores a Places row. Rows are never hard deleted. */
export async function setPlaceArchived(
  db: XosClient,
  table: PlacesTable,
  id: string,
  archived: boolean,
  now: Date = new Date(),
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from(table)
    .update({ deleted_at: archived ? now.toISOString() : null })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

// Spaces and zones ---------------------------------------------------------------------------------

export interface Space {
  readonly id: string;
  readonly venueId: string;
  readonly urid: string | null;
  readonly name: string;
  /** Floor area in square feet; NULL when unmeasured, never zero. */
  readonly areaSqFt: number | null;
  /** Occupant capacity; NULL when unknown, never zero. */
  readonly capacity: number | null;
  /** Level of the venue the space is on (B1); NULL when not recorded. */
  readonly venueLevelId: string | null;
  readonly archivedAt: string | null;
}

export interface Zone {
  readonly id: string;
  readonly venueId: string;
  readonly spaceId: string | null;
  readonly code: string;
  readonly name: string;
  readonly archivedAt: string | null;
}

export interface SpaceInput {
  readonly venueId: string;
  readonly name: string;
  readonly urid?: string | null;
  readonly areaSqFt?: number | null;
  readonly capacity?: number | null;
  readonly venueLevelId?: string | null;
}

export interface ZoneInput {
  readonly venueId: string;
  readonly spaceId?: string | null;
  readonly code: string;
  readonly name: string;
}

/** Spaces of the org's venues (or one venue) by name. */
export async function listSpaces(
  db: XosClient,
  filter: { readonly orgId: string; readonly venueId?: string; readonly archive?: ArchiveFilter },
): Promise<Result<Space[]>> {
  let query = db
    .from("spaces")
    .select("id, venue_id, urid, name, area_sq_ft, capacity, venue_level_id, deleted_at")
    .eq("org_id", filter.orgId);
  if (filter.venueId) query = query.eq("venue_id", filter.venueId);
  const archive = filter.archive ?? "live";
  if (archive === "live") query = query.is("deleted_at", null);
  if (archive === "archived") query = query.not("deleted_at", "is", null);
  const { data, error } = await query.order("name");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((s) => ({
      id: s.id,
      venueId: s.venue_id,
      urid: s.urid,
      name: s.name,
      areaSqFt: s.area_sq_ft,
      capacity: s.capacity,
      venueLevelId: s.venue_level_id,
      archivedAt: s.deleted_at,
    })),
  );
}

/** Zones of the org's venues (or one venue) in code order (Section 3.6, coded lists). */
export async function listZones(
  db: XosClient,
  filter: { readonly orgId: string; readonly venueId?: string; readonly archive?: ArchiveFilter },
): Promise<Result<Zone[]>> {
  let query = db
    .from("zones")
    .select("id, venue_id, space_id, code, name, deleted_at")
    .eq("org_id", filter.orgId);
  if (filter.venueId) query = query.eq("venue_id", filter.venueId);
  const archive = filter.archive ?? "live";
  if (archive === "live") query = query.is("deleted_at", null);
  if (archive === "archived") query = query.not("deleted_at", "is", null);
  const { data, error } = await query.order("code");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((z) => ({
      id: z.id,
      venueId: z.venue_id,
      spaceId: z.space_id,
      code: z.code,
      name: z.name,
      archivedAt: z.deleted_at,
    })),
  );
}

export async function createSpace(
  db: XosClient,
  input: SpaceInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("spaces")
    .insert(
      derivedOrg<"spaces">({
        venue_id: input.venueId,
        name: input.name.trim(),
        urid: input.urid ?? null,
        area_sq_ft: input.areaSqFt ?? null,
        capacity: input.capacity ?? null,
        venue_level_id: input.venueLevelId ?? null,
      }),
    )
    .select("id");
  return writeResult(data, error);
}

export async function updateSpace(
  db: XosClient,
  id: string,
  input: Omit<SpaceInput, "venueId">,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("spaces")
    .update({
      name: input.name.trim(),
      urid: input.urid ?? null,
      area_sq_ft: input.areaSqFt ?? null,
      capacity: input.capacity ?? null,
      venue_level_id: input.venueLevelId ?? null,
    })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

export async function createZone(db: XosClient, input: ZoneInput): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("zones")
    .insert(
      derivedOrg<"zones">({
        venue_id: input.venueId,
        space_id: input.spaceId ?? null,
        code: input.code.trim().toUpperCase(),
        name: input.name.trim(),
      }),
    )
    .select("id");
  return writeResult(data, error);
}

export async function updateZone(
  db: XosClient,
  id: string,
  input: Omit<ZoneInput, "venueId">,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("zones")
    .update({
      space_id: input.spaceId ?? null,
      code: input.code.trim().toUpperCase(),
      name: input.name.trim(),
    })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

// Capability documents ------------------------------------------------------------------------------

export interface CapabilityDocument {
  readonly id: string;
  readonly venueId: string;
  readonly title: string;
  readonly documentUri: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly frozen: boolean;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}

export interface CapabilityDocumentInput {
  readonly venueId: string;
  readonly title: string;
  readonly documentUri: string;
  readonly validFrom: string;
  readonly validTo?: string | null;
}

/** Validity of a capability document on a given day (G3.NO_STALE_DOCS reads the same rule). */
export type DocumentValidity = "upcoming" | "valid" | "stale";

/** A document is upcoming before valid_from, stale after valid_to, valid otherwise. */
export function documentValidity(
  doc: Pick<CapabilityDocument, "validFrom" | "validTo">,
  today: string,
): DocumentValidity {
  if (today < doc.validFrom) return "upcoming";
  if (doc.validTo !== null && today > doc.validTo) return "stale";
  return "valid";
}

export async function listCapabilityDocuments(
  db: XosClient,
  filter: { readonly orgId: string; readonly venueId?: string; readonly archive?: ArchiveFilter },
): Promise<Result<CapabilityDocument[]>> {
  let query = db
    .from("capability_documents")
    .select(
      "id, venue_id, title, document_uri, valid_from, valid_to, is_frozen, deleted_at, updated_at",
    )
    .eq("org_id", filter.orgId);
  if (filter.venueId) query = query.eq("venue_id", filter.venueId);
  const archive = filter.archive ?? "live";
  if (archive === "live") query = query.is("deleted_at", null);
  if (archive === "archived") query = query.not("deleted_at", "is", null);
  const { data, error } = await query.order("valid_from", { ascending: false }).order("title");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((d) => ({
      id: d.id,
      venueId: d.venue_id,
      title: d.title,
      documentUri: d.document_uri,
      validFrom: d.valid_from,
      validTo: d.valid_to,
      frozen: d.is_frozen,
      archivedAt: d.deleted_at,
      updatedAt: d.updated_at,
    })),
  );
}

export async function createCapabilityDocument(
  db: XosClient,
  input: CapabilityDocumentInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("capability_documents")
    .insert(
      derivedOrg<"capability_documents">({
        venue_id: input.venueId,
        title: input.title.trim(),
        document_uri: input.documentUri.trim(),
        valid_from: input.validFrom,
        valid_to: input.validTo ?? null,
      }),
    )
    .select("id");
  return writeResult(data, error);
}

/** Edits a document; the database refuses any change to a frozen one (capability_document_frozen). */
export async function updateCapabilityDocument(
  db: XosClient,
  id: string,
  input: Omit<CapabilityDocumentInput, "venueId">,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("capability_documents")
    .update({
      title: input.title.trim(),
      document_uri: input.documentUri.trim(),
      valid_from: input.validFrom,
      valid_to: input.validTo ?? null,
    })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

/** Freezes a document (G1.CAPABILITY_FROZEN). A frozen document never changes or unfreezes. */
export async function freezeCapabilityDocument(
  db: XosClient,
  id: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("capability_documents")
    .update({ is_frozen: true })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

// Site plans ------------------------------------------------------------------------------------------

/** A site plan's lifecycle state (ADR 0140 D1); only a Draft plan takes layout writes. */
export type SitePlanState = "Draft" | "Locked" | "Live" | "Archived";

export const SITE_PLAN_STATES: readonly SitePlanState[] = ["Draft", "Locked", "Live", "Archived"];

/** The image_uri of a plan created to receive an upload, before its drawing is set (ADR 0140 D3). */
export const PENDING_DRAWING_URI = "attachments/pending";

export interface SitePlanPin {
  readonly id: string;
  readonly label: string;
  /** Horizontal position, 0 to 1 from the left of the drawing. */
  readonly x: number;
  /** Vertical position, 0 to 1 from the top of the drawing. */
  readonly y: number;
  readonly zoneId: string | null;
  readonly recordId: string | null;
}

/**
 * A plan's stored drawing (ADR 0140 D3). `shownVersionId` is the image the canvas and the export draw: the PNG raster
 * of a PDF, else the drawing itself. A drawing whose file was later raised above Internal or removed is unavailable:
 * the plan shows and exports the ruled frame instead (`unavailable` says why).
 */
export interface SitePlanDrawing {
  readonly versionId: string;
  readonly rasterVersionId: string | null;
  readonly page: number | null;
  readonly contentType: string;
  readonly filename: string;
  readonly shownVersionId: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly unavailable: "classified" | "removed" | null;
}

export interface SitePlan {
  readonly id: string;
  readonly projectId: string;
  readonly venueId: string | null;
  readonly venueLevelId: string | null;
  readonly title: string;
  readonly imageUri: string;
  readonly planState: SitePlanState;
  /** True while the plan waits for its first drawing (image_uri 'attachments/pending'). */
  readonly awaitingDrawing: boolean;
  readonly drawing: SitePlanDrawing | null;
  /** The scale, set on a stored drawing; null while uncalibrated. */
  readonly calibration: PlanCalibration | null;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
  readonly pins: readonly SitePlanPin[];
}

/** A legacy plan: a web image (or a stored path from before B1) with no stored drawing. It gets no drawing tools. */
export function isLegacyPlan(plan: Pick<SitePlan, "drawing" | "awaitingDrawing">): boolean {
  return plan.drawing === null && !plan.awaitingDrawing;
}

export interface SitePlanInput {
  readonly projectId: string;
  readonly venueId?: string | null;
  readonly venueLevelId?: string | null;
  readonly title: string;
  /** A web image address for a legacy plan; omitted for a plan whose drawing is uploaded. */
  readonly imageUri?: string | null;
}

export interface PinInput {
  readonly sitePlanId: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly zoneId?: string | null;
}

interface DrawingVersionRow {
  id: string;
  filename: string;
  content_type: string;
  deleted_at: string | null;
  attachments: { classification: string; deleted_at: string | null } | null;
}

interface SitePlanRow {
  id: string;
  project_id: string;
  venue_id: string | null;
  venue_level_id: string | null;
  title: string;
  image_uri: string;
  plan_state: SitePlanState;
  drawing_version_id: string | null;
  raster_version_id: string | null;
  drawing_page: number | null;
  image_width_px: number | null;
  image_height_px: number | null;
  calibration_ax: number | string | null;
  calibration_ay: number | string | null;
  calibration_bx: number | string | null;
  calibration_by: number | string | null;
  calibration_feet: number | string | null;
  deleted_at: string | null;
  updated_at: string;
  drawing: DrawingVersionRow | null;
  raster: DrawingVersionRow | null;
  site_plan_pins: {
    id: string;
    label: string;
    x_ratio: number;
    y_ratio: number;
    zone_id: string | null;
    record_id: string | null;
    deleted_at: string | null;
  }[];
}

/** Why a stored file cannot be drawn: raised above Internal later (allowed, Section 8.6), or removed. */
function unavailability(version: DrawingVersionRow | null): SitePlanDrawing["unavailable"] {
  if (
    !version ||
    version.deleted_at !== null ||
    !version.attachments ||
    version.attachments.deleted_at !== null
  ) {
    return "removed";
  }
  const c = version.attachments.classification;
  return c === "Public" || c === "Internal" ? null : "classified";
}

function toDrawing(row: SitePlanRow): SitePlanDrawing | null {
  if (!row.drawing_version_id || row.image_width_px === null || row.image_height_px === null)
    return null;
  const raster = row.raster_version_id ? unavailability(row.raster) : null;
  return {
    versionId: row.drawing_version_id,
    rasterVersionId: row.raster_version_id,
    page: row.drawing_page,
    contentType: row.drawing?.content_type ?? "",
    filename: row.drawing?.filename ?? "",
    shownVersionId: row.raster_version_id ?? row.drawing_version_id,
    widthPx: row.image_width_px,
    heightPx: row.image_height_px,
    unavailable: unavailability(row.drawing) ?? raster,
  };
}

function toCalibration(row: SitePlanRow): PlanCalibration | null {
  if (row.calibration_feet === null) return null;
  return {
    ax: Number(row.calibration_ax),
    ay: Number(row.calibration_ay),
    bx: Number(row.calibration_bx),
    by: Number(row.calibration_by),
    feet: Number(row.calibration_feet),
  };
}

function toSitePlan(row: SitePlanRow): SitePlan {
  return {
    id: row.id,
    projectId: row.project_id,
    venueId: row.venue_id,
    venueLevelId: row.venue_level_id ?? null,
    title: row.title,
    imageUri: row.image_uri,
    planState: row.plan_state ?? "Draft",
    awaitingDrawing: row.image_uri === PENDING_DRAWING_URI,
    drawing: toDrawing(row),
    calibration: toCalibration(row),
    archivedAt: row.deleted_at,
    updatedAt: row.updated_at,
    pins: row.site_plan_pins
      .filter((p) => p.deleted_at === null)
      .map((p) => ({
        id: p.id,
        label: p.label,
        x: Number(p.x_ratio),
        y: Number(p.y_ratio),
        zoneId: p.zone_id,
        recordId: p.record_id,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

const DRAWING_EMBED =
  "id, filename, content_type, deleted_at, attachments(classification, deleted_at)";

const SITE_PLAN_COLUMNS = [
  "id, project_id, venue_id, venue_level_id, title, image_uri, plan_state",
  "drawing_version_id, raster_version_id, drawing_page, image_width_px, image_height_px",
  "calibration_ax, calibration_ay, calibration_bx, calibration_by, calibration_feet, deleted_at, updated_at",
  `drawing:attachment_versions!site_plans_drawing_version_id_fkey(${DRAWING_EMBED})`,
  `raster:attachment_versions!site_plans_raster_version_id_fkey(${DRAWING_EMBED})`,
  "site_plan_pins(id, label, x_ratio, y_ratio, zone_id, record_id, deleted_at)",
].join(", ");

/**
 * Site plans the caller can read (project members and venue readers), newest first. `archive` is about Trash
 * (deleted_at); the Archived state is a plan state, filtered with `states`.
 */
export async function listSitePlans(
  db: XosClient,
  filter: {
    readonly orgId: string;
    readonly projectId?: string;
    readonly archive?: ArchiveFilter;
    readonly states?: readonly SitePlanState[];
  },
): Promise<Result<SitePlan[]>> {
  let query = db.from("site_plans").select(SITE_PLAN_COLUMNS).eq("org_id", filter.orgId);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  if (filter.states && filter.states.length > 0) query = query.in("plan_state", [...filter.states]);
  const archive = filter.archive ?? "live";
  if (archive === "live") query = query.is("deleted_at", null);
  if (archive === "archived") query = query.not("deleted_at", "is", null);
  const { data, error } = await query.order("updated_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok((data as unknown as SitePlanRow[]).map(toSitePlan));
}

/** One site plan by id, or not-found when the caller cannot read it. */
export async function getSitePlan(db: XosClient, id: string): Promise<Result<SitePlan>> {
  const { data, error } = await db
    .from("site_plans")
    .select(SITE_PLAN_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return data ? ok(toSitePlan(data as unknown as SitePlanRow)) : fail({ kind: "not-found" });
}

/**
 * Plans in the order the Plans list shows them (ADR 0140): by their level's order (plans with no level last), then
 * by title.
 */
export function sortPlansByLevel(
  plans: readonly SitePlan[],
  levels: readonly VenueLevel[],
): SitePlan[] {
  const order = new Map(levels.map((l) => [l.id, l]));
  return [...plans].sort((a, b) => {
    const la = a.venueLevelId ? order.get(a.venueLevelId) : undefined;
    const lb = b.venueLevelId ? order.get(b.venueLevelId) : undefined;
    if (la && lb && la.id !== lb.id) return compareLevels(la, lb);
    if (la && !lb) return -1;
    if (!la && lb) return 1;
    return a.title.localeCompare(b.title);
  });
}

export async function createSitePlan(
  db: XosClient,
  input: SitePlanInput,
): Promise<Result<{ id: string }>> {
  const imageUri = trimmedOrNull(input.imageUri);
  const { data, error } = await db
    .from("site_plans")
    .insert(
      derivedOrg<"site_plans">({
        project_id: input.projectId,
        venue_id: input.venueId ?? null,
        venue_level_id: input.venueLevelId ?? null,
        title: input.title.trim(),
        image_uri: imageUri ?? PENDING_DRAWING_URI,
      }),
    )
    .select("id");
  return writeResult(data, error);
}

/**
 * Edits a plan's title, venue and level, and a legacy plan's image address. A plan with a stored drawing keeps its
 * image_uri, which the database derives from the drawing; changing the venue or level is refused outside Draft.
 */
export async function updateSitePlan(
  db: XosClient,
  id: string,
  input: Omit<SitePlanInput, "projectId">,
): Promise<Result<{ id: string }>> {
  const imageUri = trimmedOrNull(input.imageUri);
  const { data, error } = await db
    .from("site_plans")
    .update({
      venue_id: input.venueId ?? null,
      venue_level_id: input.venueLevelId ?? null,
      title: input.title.trim(),
      ...(imageUri ? { image_uri: imageUri } : {}),
    })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

/** Renames a plan, the one edit every state but Archived takes (ADR 0140 D1). */
export async function renameSitePlan(
  db: XosClient,
  id: string,
  title: string,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("site_plans")
    .update({ title: title.trim() })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

/** The moves the D1 graph allows from each state, in the order the plan's actions offer them. */
export const SITE_PLAN_MOVES: Readonly<Record<SitePlanState, readonly SitePlanState[]>> = {
  Draft: ["Locked", "Archived"],
  Locked: ["Live", "Draft", "Archived"],
  Live: ["Locked", "Archived"],
  Archived: ["Draft"],
};

/** Moves a plan along the lifecycle with compare-and-set on its current state; returns the ledger entry id. */
export async function transitionSitePlan(
  db: XosClient,
  input: {
    readonly id: string;
    readonly expected: SitePlanState;
    readonly next: SitePlanState;
    readonly reason: string;
  },
): Promise<Result<string>> {
  return callRpc<string>(db, "transition_site_plan", {
    p_site_plan_id: input.id,
    p_expected: input.expected,
    p_next: input.next,
    p_reason: input.reason.trim(),
  });
}

/** The largest drawing the database takes on either side, in pixels (site_plans_dimensions_range). */
export const MAX_DRAWING_PX = 20000;

/**
 * Sets a plan's stored drawing (ADR 0140 D3): reads the image the canvas will show (the raster of a PDF, else the
 * drawing) as the caller, measures it from its header bytes and updates the plan; the database checks the files,
 * derives image_uri and clears the scale. A JPEG whose EXIF orientation is not upright is refused with `orientation`,
 * since a browser would turn it and a PDF would not.
 */
export async function setSitePlanDrawing(
  db: XosClient,
  input: {
    readonly sitePlanId: string;
    readonly drawingVersionId: string;
    readonly rasterVersionId?: string | null;
    readonly page?: number | null;
  },
): Promise<Result<{ id: string }>> {
  const shown = input.rasterVersionId ?? input.drawingVersionId;
  const { data: version, error: versionError } = await db
    .from("attachment_versions")
    .select("object_name, scan_status")
    .eq("id", shown)
    .maybeSingle();
  if (versionError) return fail(toDataError(versionError));
  if (!version) return fail({ kind: "not-found" });
  if (version.scan_status !== "Clean") {
    return fail({
      kind: "refusal",
      rule: "site_plan_drawing_scan",
      message: "site_plan_drawing_scan",
    });
  }
  const { data: blob, error: downloadError } = await db.storage
    .from(ATTACHMENTS_BUCKET)
    .download(version.object_name);
  if (downloadError || !blob) return fail({ kind: "not-found" });
  const size = imageSize(new Uint8Array(await blob.arrayBuffer()));
  if (!size) {
    return fail({
      kind: "refusal",
      rule: "site_plan_drawing_type",
      message: "site_plan_drawing_type",
    });
  }
  if (size.orientation !== 1) {
    return fail({ kind: "invalid", message: "orientation" });
  }
  if (size.width > MAX_DRAWING_PX || size.height > MAX_DRAWING_PX) {
    return fail({ kind: "invalid", message: "dimensions" });
  }
  const { data, error } = await db
    .from("site_plans")
    .update({
      drawing_version_id: input.drawingVersionId,
      raster_version_id: input.rasterVersionId ?? null,
      drawing_page: input.page ?? null,
      image_width_px: size.width,
      image_height_px: size.height,
    })
    .eq("id", input.sitePlanId)
    .select("id");
  return writeResult(data, error);
}

/** Sets the scale from two plan points and the real distance between them in feet, or clears it with null. */
export async function setSitePlanCalibration(
  db: XosClient,
  id: string,
  calibration: PlanCalibration | null,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("site_plans")
    .update({
      calibration_ax: calibration?.ax ?? null,
      calibration_ay: calibration?.ay ?? null,
      calibration_bx: calibration?.bx ?? null,
      calibration_by: calibration?.by ?? null,
      calibration_feet: calibration?.feet ?? null,
    })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

/** Places a pin; positions outside 0 to 1 are refused by the database check, and every pin write outside Draft. */
export async function addSitePlanPin(
  db: XosClient,
  input: PinInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("site_plan_pins")
    .insert(
      derivedOrg<"site_plan_pins">({
        site_plan_id: input.sitePlanId,
        label: input.label.trim(),
        x_ratio: input.x,
        y_ratio: input.y,
        zone_id: input.zoneId ?? null,
      }),
    )
    .select("id");
  return writeResult(data, error);
}

/** Moves a pin, for the keyboard path of pin placement as well as drag and drop. */
export async function moveSitePlanPin(
  db: XosClient,
  id: string,
  position: { readonly x: number; readonly y: number },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("site_plan_pins")
    .update({ x_ratio: position.x, y_ratio: position.y })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

// Site plan shapes -------------------------------------------------------------------------------------

export type SitePlanShapeKind = "Route" | "Barrier" | "Area" | "Label";
export type SitePlanShapeTone = "Accent" | "Info" | "Success" | "Warning" | "Danger" | "Neutral";

export const SHAPE_KINDS: readonly SitePlanShapeKind[] = ["Route", "Barrier", "Area", "Label"];
export const SHAPE_TONES: readonly SitePlanShapeTone[] = [
  "Accent",
  "Info",
  "Success",
  "Warning",
  "Danger",
  "Neutral",
];

/** The tone a shape takes when none is chosen, as the database defaults it (2901). */
export const DEFAULT_SHAPE_TONE: Readonly<Record<SitePlanShapeKind, SitePlanShapeTone>> = {
  Route: "Info",
  Barrier: "Danger",
  Area: "Accent",
  Label: "Neutral",
};

export interface SitePlanShape {
  readonly id: string;
  readonly sitePlanId: string;
  readonly kind: SitePlanShapeKind;
  readonly label: string;
  readonly tone: SitePlanShapeTone;
  /** Plan-space points: one for a label, the line for a route or barrier, the corners of an area (not repeated). */
  readonly points: readonly PlanPoint[];
  /** Length of a line or perimeter of an area in feet; null for a label and while uncalibrated. */
  readonly lengthFt: number | null;
  /** Area in square feet; null for other kinds and while uncalibrated. */
  readonly areaSqFt: number | null;
}

/** The plan-space points of a GeoJSON coordinates value: a point, a line, or the outer ring of a polygon. */
export function shapePoints(kind: SitePlanShapeKind, coordinates: unknown): PlanPoint[] {
  const pair = (v: unknown): PlanPoint | null =>
    Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number" ? [v[0], v[1]] : null;
  if (kind === "Label") {
    const p = pair(coordinates);
    return p ? [p] : [];
  }
  const line = kind === "Area" && Array.isArray(coordinates) ? coordinates[0] : coordinates;
  const points = Array.isArray(line)
    ? line.map(pair).filter((p): p is PlanPoint => p !== null)
    : [];
  if (kind === "Area" && points.length > 1) {
    const first = points[0] as PlanPoint;
    const last = points[points.length - 1] as PlanPoint;
    if (first[0] === last[0] && first[1] === last[1]) points.pop();
  }
  return points;
}

interface ShapeRow {
  id: string;
  site_plan_id: string;
  kind: SitePlanShapeKind;
  label: string;
  tone: SitePlanShapeTone;
  points_geojson: unknown;
  length_ft: number | string | null;
  area_sq_ft: number | string | null;
}

const numberOrNull = (v: number | string | null) => (v === null ? null : Number(v));

/** The live shapes of the given plans with their measurements (app.site_plan_shape_geometry), by label. */
export async function listSitePlanShapes(
  db: XosClient,
  sitePlanIds: readonly string[],
): Promise<Result<SitePlanShape[]>> {
  if (sitePlanIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("site_plan_shape_geometry")
    .select("id, site_plan_id, kind, label, tone, points_geojson, length_ft, area_sq_ft")
    .in("site_plan_id", [...sitePlanIds])
    .order("label");
  if (error) return fail(toDataError(error));
  return ok(
    (data as unknown as ShapeRow[]).map((r) => ({
      id: r.id,
      sitePlanId: r.site_plan_id,
      kind: r.kind,
      label: r.label,
      tone: r.tone,
      points: shapePoints(r.kind, r.points_geojson),
      lengthFt: numberOrNull(r.length_ft),
      areaSqFt: numberOrNull(r.area_sq_ft),
    })),
  );
}

export interface ShapeInput {
  readonly id?: string | null;
  readonly sitePlanId: string;
  readonly kind: SitePlanShapeKind;
  readonly label: string;
  readonly tone?: SitePlanShapeTone | null;
  readonly points: readonly PlanPoint[];
}

/** Draws or reshapes a shape through app.save_site_plan_shape; invalid geometry is refused (site_plan_shape_geometry). */
export async function saveSitePlanShape(db: XosClient, input: ShapeInput): Promise<Result<string>> {
  return callRpc<string>(db, "save_site_plan_shape", {
    p_id: input.id ?? null,
    p_site_plan_id: input.sitePlanId,
    p_kind: input.kind,
    p_label: input.label.trim(),
    p_tone: input.tone ?? null,
    p_points: input.points.map(([x, y]) => [x, y]),
  });
}

/** Archives or restores a shape; outside Draft it is refused like any layout write. */
export async function setSitePlanShapeArchived(
  db: XosClient,
  id: string,
  archived: boolean,
  now: Date = new Date(),
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("site_plan_shapes")
    .update({ deleted_at: archived ? now.toISOString() : null })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

// Venue levels ---------------------------------------------------------------------------------------

export interface VenueLevel {
  readonly id: string;
  readonly venueId: string;
  readonly name: string;
  /** Lowest first; basements take negative numbers. */
  readonly order: number;
  readonly archivedAt: string | null;
}

/** Levels sort by order, then name (ADR 0140): the order carries no uniqueness. */
export function compareLevels(a: VenueLevel, b: VenueLevel): number {
  return a.order - b.order || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

/** Levels of the org's venues, or of one venue, lowest first. */
export async function listVenueLevels(
  db: XosClient,
  filter: { readonly orgId?: string; readonly venueId?: string; readonly archive?: ArchiveFilter },
): Promise<Result<VenueLevel[]>> {
  let query = db.from("venue_levels").select("id, venue_id, name, level_order, deleted_at");
  if (filter.orgId) query = query.eq("org_id", filter.orgId);
  if (filter.venueId) query = query.eq("venue_id", filter.venueId);
  const archive = filter.archive ?? "live";
  if (archive === "live") query = query.is("deleted_at", null);
  if (archive === "archived") query = query.not("deleted_at", "is", null);
  const { data, error } = await query.order("level_order").order("name");
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((l) => ({
        id: l.id,
        venueId: l.venue_id,
        name: l.name,
        order: l.level_order,
        archivedAt: l.deleted_at,
      }))
      .sort(compareLevels),
  );
}

/** Adds a level to a venue (no id) or renames it and changes its order. */
export async function saveVenueLevel(
  db: XosClient,
  input: {
    readonly id?: string | null;
    readonly venueId: string;
    readonly name: string;
    readonly order: number;
  },
): Promise<Result<{ id: string }>> {
  const row = { name: input.name.trim(), level_order: input.order };
  const { data, error } = input.id
    ? await db.from("venue_levels").update(row).eq("id", input.id).select("id")
    : await db
        .from("venue_levels")
        .insert(derivedOrg<"venue_levels">({ venue_id: input.venueId, ...row }))
        .select("id");
  return writeResult(data, error);
}

/** Puts every live level of a venue in the given order in one call; returns how many moved. */
export async function reorderVenueLevels(
  db: XosClient,
  venueId: string,
  levelIds: readonly string[],
): Promise<Result<number>> {
  return callRpc<number>(db, "reorder_venue_levels", {
    p_venue_id: venueId,
    p_level_ids: [...levelIds],
  });
}

// Place specs -----------------------------------------------------------------------------------------

/**
 * The technical facts of a venue (spaceId null) or one of its spaces (ADR 0140 D8). Every field is null when unknown,
 * and unknown never passes (Section 3.7). There is no password field: network credentials belong in a Restricted
 * capability document.
 */
export interface PlaceSpec {
  readonly id: string | null;
  readonly venueId: string;
  readonly spaceId: string | null;
  readonly housePowerAmps: number | null;
  readonly housePowerVoltage: number | null;
  readonly housePowerPhase: 1 | 3 | null;
  readonly powerConnections: string | null;
  readonly loadingDockCount: number | null;
  readonly dockHeightIn: number | null;
  readonly dockDoorWidthIn: number | null;
  readonly dockDoorHeightIn: number | null;
  readonly forkliftOnSite: boolean | null;
  readonly dockNotes: string | null;
  readonly lengthFt: number | null;
  readonly widthFt: number | null;
  readonly clearHeightFt: number | null;
  readonly floorLoadPsf: number | null;
  /** Venue specs only; a space keeps its capacity. */
  readonly occupantLoad: number | null;
  readonly riggingPointCount: number | null;
  readonly riggingPointLoadLb: number | null;
  readonly riggingTotalLoadLb: number | null;
  readonly riggingNotes: string | null;
  readonly wifiAvailable: boolean | null;
  readonly internetBandwidthMbps: number | null;
  readonly hardlineAvailable: boolean | null;
  readonly networkNotes: string | null;
  readonly specDocumentId: string | null;
  readonly updatedAt: string | null;
}

export type PlaceSpecInput = Omit<PlaceSpec, "id" | "updatedAt">;

/** The spec's database columns, and its fields that are numbers (stored as numeric, read back as text or number). */
const SPEC_FIELDS = {
  housePowerAmps: "house_power_amps",
  housePowerVoltage: "house_power_voltage",
  housePowerPhase: "house_power_phase",
  powerConnections: "power_connections",
  loadingDockCount: "loading_dock_count",
  dockHeightIn: "dock_height_in",
  dockDoorWidthIn: "dock_door_width_in",
  dockDoorHeightIn: "dock_door_height_in",
  forkliftOnSite: "forklift_on_site",
  dockNotes: "dock_notes",
  lengthFt: "length_ft",
  widthFt: "width_ft",
  clearHeightFt: "clear_height_ft",
  floorLoadPsf: "floor_load_psf",
  occupantLoad: "occupant_load",
  riggingPointCount: "rigging_point_count",
  riggingPointLoadLb: "rigging_point_load_lb",
  riggingTotalLoadLb: "rigging_total_load_lb",
  riggingNotes: "rigging_notes",
  wifiAvailable: "wifi_available",
  internetBandwidthMbps: "internet_bandwidth_mbps",
  hardlineAvailable: "hardline_available",
  networkNotes: "network_notes",
  specDocumentId: "spec_document_id",
} as const;

type SpecField = keyof typeof SPEC_FIELDS;

const TEXT_SPEC_FIELDS = new Set<SpecField>([
  "powerConnections",
  "dockNotes",
  "riggingNotes",
  "networkNotes",
  "specDocumentId",
]);
const BOOLEAN_SPEC_FIELDS = new Set<SpecField>([
  "forkliftOnSite",
  "wifiAvailable",
  "hardlineAvailable",
]);

export const PLACE_SPEC_FIELDS = Object.keys(SPEC_FIELDS) as SpecField[];

/** An empty spec of a venue or space: every fact unknown. */
export function emptyPlaceSpec(venueId: string, spaceId: string | null = null): PlaceSpec {
  const blank = Object.fromEntries(PLACE_SPEC_FIELDS.map((f) => [f, null])) as Record<
    SpecField,
    null
  >;
  return { id: null, venueId, spaceId, updatedAt: null, ...blank };
}

function toPlaceSpec(row: Record<string, unknown>): PlaceSpec {
  const out: Record<string, unknown> = {
    id: row["id"],
    venueId: row["venue_id"],
    spaceId: row["space_id"] ?? null,
    updatedAt: row["updated_at"] ?? null,
  };
  for (const field of PLACE_SPEC_FIELDS) {
    const value = row[SPEC_FIELDS[field]];
    out[field] =
      value === null || value === undefined
        ? null
        : TEXT_SPEC_FIELDS.has(field) || BOOLEAN_SPEC_FIELDS.has(field)
          ? value
          : Number(value);
  }
  return out as unknown as PlaceSpec;
}

const SPEC_COLUMNS = `id, venue_id, space_id, updated_at, ${Object.values(SPEC_FIELDS).join(", ")}`;

/** The live spec of a venue (spaceId omitted) or of one space, or an empty one when none is recorded. */
export async function getPlaceSpec(
  db: XosClient,
  target: { readonly venueId: string; readonly spaceId?: string | null },
): Promise<Result<PlaceSpec>> {
  let query = db
    .from("place_specs")
    .select(SPEC_COLUMNS)
    .eq("venue_id", target.venueId)
    .is("deleted_at", null);
  query = target.spaceId ? query.eq("space_id", target.spaceId) : query.is("space_id", null);
  const { data, error } = await query.maybeSingle();
  if (error) return fail(toDataError(error));
  return ok(
    data
      ? toPlaceSpec(data as unknown as Record<string, unknown>)
      : emptyPlaceSpec(target.venueId, target.spaceId ?? null),
  );
}

/** Saves a venue's or space's spec: updates the live row, or inserts the first one. Blank text is stored as NULL. */
export async function savePlaceSpec(
  db: XosClient,
  input: PlaceSpecInput,
): Promise<Result<{ id: string }>> {
  const values: Record<string, unknown> = {};
  for (const field of PLACE_SPEC_FIELDS) {
    const value = input[field];
    values[SPEC_FIELDS[field]] = typeof value === "string" ? trimmedOrNull(value) : value;
  }
  const existing = await getPlaceSpec(db, input);
  if (!existing.ok) return existing;
  if (existing.data.id) {
    const { data, error } = await db
      .from("place_specs")
      .update(values as never)
      .eq("id", existing.data.id)
      .select("id");
    return writeResult(data, error);
  }
  const { data, error } = await db
    .from("place_specs")
    .insert({
      ...(input.spaceId ? { space_id: input.spaceId } : { venue_id: input.venueId }),
      ...values,
    } as never)
    .select("id");
  return writeResult(data, error);
}

/** Copies the project venue's known specs into Provide capabilities (app.provide_place_specs); returns how many. */
export async function providePlaceSpecs(db: XosClient, projectId: string): Promise<Result<number>> {
  return callRpc<number>(db, "provide_place_specs", { p_project_id: projectId });
}

/** The venue facts a permit reviewer reads for a project (app.project_place_facts). Null is not recorded. */
export interface ProjectPlaceFacts {
  readonly projectId: string;
  readonly venueId: string;
  readonly occupantLoad: number | null;
  readonly housePowerAmps: number | null;
  readonly housePowerVoltage: number | null;
  readonly housePowerPhase: number | null;
  readonly riggingPointCount: number | null;
  readonly riggingPointLoadLb: number | null;
  readonly riggingTotalLoadLb: number | null;
  readonly clearHeightFt: number | null;
  /** The sum of the spaces' capacity, only when every live space has one. */
  readonly spaceCapacityTotal: number | null;
  readonly spacesCapacityKnown: number;
  readonly spacesCount: number;
  readonly documented: boolean;
}

export async function listProjectPlaceFacts(
  db: XosClient,
  projectIds: readonly string[],
): Promise<Result<ProjectPlaceFacts[]>> {
  if (projectIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("project_place_facts")
    .select("*")
    .in("project_id", [...projectIds]);
  if (error) return fail(toDataError(error));
  return ok(
    (data as unknown as Record<string, number | string | boolean | null>[]).map((r) => ({
      projectId: String(r["project_id"]),
      venueId: String(r["venue_id"]),
      occupantLoad: numberOrNull(r["occupant_load"] as number | null),
      housePowerAmps: numberOrNull(r["house_power_amps"] as number | null),
      housePowerVoltage: numberOrNull(r["house_power_voltage"] as number | null),
      housePowerPhase: numberOrNull(r["house_power_phase"] as number | null),
      riggingPointCount: numberOrNull(r["rigging_point_count"] as number | null),
      riggingPointLoadLb: numberOrNull(r["rigging_point_load_lb"] as number | string | null),
      riggingTotalLoadLb: numberOrNull(r["rigging_total_load_lb"] as number | string | null),
      clearHeightFt: numberOrNull(r["clear_height_ft"] as number | string | null),
      spaceCapacityTotal: numberOrNull(r["space_capacity_total"] as number | string | null),
      spacesCapacityKnown: Number(r["spaces_capacity_known"] ?? 0),
      spacesCount: Number(r["spaces_count"] ?? 0),
      documented: r["documented"] === true,
    })),
  );
}

/** The fact group a person reads beside a canon permit rule. */
export type PermitFactGroup = "occupancy" | "power" | "rigging" | "dimensions";

/** Canon permit rule to its venue fact groups (app.permit_rule_place_facts). */
export async function listPermitRulePlaceFacts(
  db: XosClient,
): Promise<Result<ReadonlyMap<string, readonly PermitFactGroup[]>>> {
  const { data, error } = await db
    .from("permit_rule_place_facts")
    .select("permit_rule, fact_group");
  if (error) return fail(toDataError(error));
  const out = new Map<string, PermitFactGroup[]>();
  for (const r of data as unknown as { permit_rule: string; fact_group: PermitFactGroup }[]) {
    out.set(r.permit_rule, [...(out.get(r.permit_rule) ?? []), r.fact_group]);
  }
  return ok(out);
}

// Projects for pickers -----------------------------------------------------------------------------

export interface ProjectOption {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly jurisdictionId: string | null;
  readonly venueId: string | null;
}

/** Projects the caller can read, by key, for project pickers on org-level pages. */
export async function listProjectOptions(
  db: XosClient,
  orgId: string,
): Promise<Result<ProjectOption[]>> {
  const { data, error } = await db
    .from("projects")
    .select("id, project_key, name, jurisdiction_id, venue_id")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .is("archived_at", null)
    .order("project_key");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((p) => ({
      id: p.id,
      key: p.project_key,
      name: p.name,
      jurisdictionId: p.jurisdiction_id,
      venueId: p.venue_id,
    })),
  );
}
