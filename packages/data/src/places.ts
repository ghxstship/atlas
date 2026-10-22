import type { Database, XosClient } from "./client.ts";
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
  // Typed through `unknown` before `rpc` is read: resolving the generated client's overloads for
  // `db.rpc.bind` instantiates every function of the generated Database type, past TypeScript's depth.
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
  "venues" | "spaces" | "zones" | "capability_documents" | "site_plans" | "site_plan_pins";

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
    .select("id, venue_id, urid, name, area_sq_ft, capacity, deleted_at")
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

export interface SitePlan {
  readonly id: string;
  readonly projectId: string;
  readonly venueId: string | null;
  readonly title: string;
  readonly imageUri: string;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
  readonly pins: readonly SitePlanPin[];
}

export interface SitePlanInput {
  readonly projectId: string;
  readonly venueId?: string | null;
  readonly title: string;
  readonly imageUri: string;
}

export interface PinInput {
  readonly sitePlanId: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly zoneId?: string | null;
}

interface SitePlanRow {
  id: string;
  project_id: string;
  venue_id: string | null;
  title: string;
  image_uri: string;
  deleted_at: string | null;
  updated_at: string;
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

function toSitePlan(row: SitePlanRow): SitePlan {
  return {
    id: row.id,
    projectId: row.project_id,
    venueId: row.venue_id,
    title: row.title,
    imageUri: row.image_uri,
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

const SITE_PLAN_COLUMNS =
  "id, project_id, venue_id, title, image_uri, deleted_at, updated_at, site_plan_pins(id, label, x_ratio, y_ratio, zone_id, record_id, deleted_at)";

/** Site plans the caller can read (project members and venue readers), newest first. */
export async function listSitePlans(
  db: XosClient,
  filter: { readonly orgId: string; readonly projectId?: string; readonly archive?: ArchiveFilter },
): Promise<Result<SitePlan[]>> {
  let query = db.from("site_plans").select(SITE_PLAN_COLUMNS).eq("org_id", filter.orgId);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  const archive = filter.archive ?? "live";
  if (archive === "live") query = query.is("deleted_at", null);
  if (archive === "archived") query = query.not("deleted_at", "is", null);
  const { data, error } = await query.order("updated_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok((data as unknown as SitePlanRow[]).map(toSitePlan));
}

export async function createSitePlan(
  db: XosClient,
  input: SitePlanInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("site_plans")
    .insert(
      derivedOrg<"site_plans">({
        project_id: input.projectId,
        venue_id: input.venueId ?? null,
        title: input.title.trim(),
        image_uri: input.imageUri.trim(),
      }),
    )
    .select("id");
  return writeResult(data, error);
}

export async function updateSitePlan(
  db: XosClient,
  id: string,
  input: Omit<SitePlanInput, "projectId">,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("site_plans")
    .update({
      venue_id: input.venueId ?? null,
      title: input.title.trim(),
      image_uri: input.imageUri.trim(),
    })
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

/** Places a pin; positions outside 0 to 1 are refused by the database check. */
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
