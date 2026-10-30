import { Constants, type Database } from "./database.types.ts";
import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Assets repository (Section 4.2 Assets, Section 3.9 grain, migration 0352): asset classes bound to
 * canon elements, units with asset tags and the nine-value lifecycle, lots, external identifiers,
 * the append-only custody ledger, maintenance and damage, and the scan resolution back end that
 * Compass calls (code to unit or lot to custody event, idempotent on a device-minted event id).
 *
 * Reads go through row level security, so every function sees exactly what the signed-in person
 * may see. Writes go through the table policies and app.transition_asset; the database decides and
 * its refusals come back as typed errors (ADR 0008).
 */

export type AssetState = Database["app"]["Enums"]["asset_state"];

/** The ten asset states in lifecycle order, from the generated enum (Section 3.15, rule 3; Returned is R7a's). */
export const ASSET_STATES: readonly AssetState[] = Constants.app.Enums.asset_state;

export function isAssetState(value: string): value is AssetState {
  return (ASSET_STATES as readonly string[]).includes(value);
}

/** Catalog key segment of a stored asset state: `In Maintenance` becomes `inMaintenance`. */
export function assetStateKey(state: AssetState): string {
  const [first = "", ...rest] = state.split(" ");
  return first.toLowerCase() + rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const ASSET_TAG = /^[A-Z0-9][A-Z0-9-]{1,31}$/;
const SCHEME = /^[a-z][a-z0-9_]{1,31}$/;

function invalid<T>(message: string): Result<T> {
  return fail({ kind: "invalid", message });
}

function refuse<T>(rule: string, message: string): Result<T> {
  return fail({ kind: "refusal", rule, message });
}

/** An asset tag as typed or scanned: trimmed and uppercased. */
export function normalizeAssetTag(value: string): string {
  return value.trim().toUpperCase();
}

export function isAssetTag(value: string): boolean {
  return ASSET_TAG.test(value);
}

// Reference data -----------------------------------------------------------------------------------

export interface CanonOption {
  readonly id: string;
  readonly label: string;
}

/** Rows of the canon Asset Condition enumeration (Bible tab 13) in canon sort order. */
export async function listAssetConditions(db: XosClient): Promise<Result<CanonOption[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("std_enumeration")
    .select("record_id, enum_label, sort_order")
    .eq("enum_domain", "Asset Condition")
    .order("sort_order", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(data.map((r) => ({ id: r.record_id, label: r.enum_label ?? r.record_id })));
}

export interface ElementOption {
  readonly elementId: string;
  readonly urid: string;
  readonly item: string;
}

/** Canon elements matching a search, by element ID or item name, in element ID order. */
export async function searchAssetElements(
  db: XosClient,
  query: string,
  limit = 20,
): Promise<Result<ElementOption[]>> {
  const term = query.trim().replace(/[%,()]/g, " ");
  let request = db
    .schema("xpms")
    .from("elements")
    .select("element_id, urid, item")
    .order("element_id", { ascending: true })
    .limit(limit);
  if (term.length > 0) request = request.or(`item.ilike.%${term}%,element_id.ilike.%${term}%`);
  const { data, error } = await request;
  if (error) return fail(toDataError(error));
  return ok(data.map((r) => ({ elementId: r.element_id, urid: r.urid, item: r.item })));
}

async function elementsById(
  db: XosClient,
  ids: readonly string[],
): Promise<Result<Map<string, ElementOption>>> {
  if (ids.length === 0) return ok(new Map());
  const { data, error } = await db
    .schema("xpms")
    .from("elements")
    .select("element_id, urid, item")
    .in("element_id", [...new Set(ids)]);
  if (error) return fail(toDataError(error));
  return ok(
    new Map(
      data.map((r) => [r.element_id, { elementId: r.element_id, urid: r.urid, item: r.item }]),
    ),
  );
}

export interface VenueOption {
  readonly id: string;
  readonly name: string;
}

/** Venues of the org by name, for home venues, lot places and check-in places. */
export async function listAssetVenues(
  db: XosClient,
  orgId: string,
): Promise<Result<VenueOption[]>> {
  const { data, error } = await db
    .from("venues")
    .select("id, name")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(data.map((r) => ({ id: r.id, name: r.name })));
}

export interface ProjectRef {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

/** Live projects of the org in key order, for custody and damage pickers. */
export async function listAssetProjects(
  db: XosClient,
  orgId: string,
): Promise<Result<ProjectRef[]>> {
  const { data, error } = await db
    .from("projects")
    .select("id, project_key, name")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .is("archived_at", null)
    .order("project_key", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(data.map((r) => ({ id: r.id, key: r.project_key, name: r.name })));
}

/** The project a project Assets tab names, or not-found (shown as 404). */
export async function resolveAssetsProject(
  db: XosClient,
  orgId: string,
  projectKey: string,
): Promise<Result<ProjectRef>> {
  const { data, error } = await db
    .from("projects")
    .select("id, project_key, name")
    .eq("org_id", orgId)
    .eq("project_key", projectKey)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok({ id: data.id, key: data.project_key, name: data.name });
}

/** Allowed asset transitions from the database rules, so screens offer only accepted moves. */
export async function listAssetTransitions(
  db: XosClient,
): Promise<Result<ReadonlyMap<AssetState, readonly AssetState[]>>> {
  const { data, error } = await db
    .from("lifecycle_transition_rules")
    .select("from_state, to_state")
    .eq("lifecycle", "asset");
  if (error) return fail(toDataError(error));
  const map = new Map<AssetState, AssetState[]>();
  for (const row of data) {
    const from = row.from_state ?? "";
    const to = row.to_state ?? "";
    if (!isAssetState(from) || !isAssetState(to)) continue;
    map.set(from, [...(map.get(from) ?? []), to]);
  }
  for (const [from, next] of map) {
    map.set(
      from,
      next.sort((a, b) => ASSET_STATES.indexOf(a) - ASSET_STATES.indexOf(b)),
    );
  }
  return ok(map);
}

// Classes ------------------------------------------------------------------------------------------

export interface AssetClass {
  readonly id: string;
  readonly name: string;
  readonly elementId: string;
  readonly urid: string | null;
  readonly elementItem: string | null;
  readonly unitCount: number;
  readonly lotCount: number;
  readonly createdAt: string;
}

/** Asset classes of the org by name, with their canon element and unit and lot counts. */
export async function listAssetClasses(
  db: XosClient,
  orgId: string,
): Promise<Result<AssetClass[]>> {
  const { data, error } = await db
    .from("asset_classes")
    .select(
      "id, name, element_id, created_at, asset_units(id, deleted_at), asset_lots(id, deleted_at)",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name", { ascending: true });
  if (error) return fail(toDataError(error));
  const elements = await elementsById(
    db,
    data.map((r) => r.element_id),
  );
  if (!elements.ok) return elements;
  return ok(
    data.map((r) => {
      const element = elements.data.get(r.element_id);
      return {
        id: r.id,
        name: r.name,
        elementId: r.element_id,
        urid: element?.urid ?? null,
        elementItem: element?.item ?? null,
        unitCount: r.asset_units.filter((u) => u.deleted_at === null).length,
        lotCount: r.asset_lots.filter((l) => l.deleted_at === null).length,
        createdAt: r.created_at,
      };
    }),
  );
}

function checkName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 200 ? trimmed : null;
}

/** Defines an asset class for a canon element (one per element per org). */
export async function createAssetClass(
  db: XosClient,
  input: { readonly orgId: string; readonly elementId: string; readonly name: string },
): Promise<Result<{ id: string }>> {
  const name = checkName(input.name);
  if (!name) return invalid("name");
  const { data, error } = await db
    .from("asset_classes")
    .insert({ org_id: input.orgId, element_id: input.elementId, name })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Renames an asset class; the canon element it is stays fixed. */
export async function renameAssetClass(
  db: XosClient,
  id: string,
  name: string,
): Promise<Result<null>> {
  const trimmed = checkName(name);
  if (!trimmed) return invalid("name");
  const { error } = await db.from("asset_classes").update({ name: trimmed }).eq("id", id);
  return error ? fail(toDataError(error)) : ok(null);
}

/** Archives an asset class that holds no live units or lots (soft delete, ADR 0002). */
export async function archiveAssetClass(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("asset_classes")
    .select("id, asset_units(id, deleted_at), asset_lots(id, deleted_at)")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const live =
    data.asset_units.some((u) => u.deleted_at === null) ||
    data.asset_lots.some((l) => l.deleted_at === null);
  if (live) {
    return refuse("asset_class_in_use", "An asset class with units or lots stays until they go.");
  }
  const { error: updateError } = await db
    .from("asset_classes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  return updateError ? fail(toDataError(updateError)) : ok(null);
}

// Units --------------------------------------------------------------------------------------------

export interface CustodyHolder {
  readonly custodyId: string;
  readonly membershipId: string | null;
  /** External engagement holding the unit (migration 0975); never set with membershipId. */
  readonly engagementId: string | null;
  readonly custodianName: string | null;
  readonly venueId: string | null;
  readonly venueName: string | null;
  readonly projectId: string | null;
  readonly projectKey: string | null;
  readonly since: string;
}

export interface AssetUnit {
  readonly id: string;
  readonly assetTag: string;
  readonly classId: string;
  readonly className: string;
  readonly state: AssetState;
  readonly conditionEnumId: string | null;
  readonly homeVenueId: string | null;
  readonly homeVenueName: string | null;
  readonly custody: CustodyHolder | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const CUSTODY_COLUMNS =
  "id, created_at, custodian_membership_id, custodian_engagement_id, venue_id, project_id, note, custodian:memberships!asset_custody_custodian_membership_id_fkey(person:people!memberships_person_id_fkey(full_name)), engagement:engagements!asset_custody_custodian_engagement_id_fkey(person:people!engagements_person_id_fkey(full_name)), venue:venues!asset_custody_venue_id_fkey(name), project:projects!asset_custody_project_id_fkey(project_key)";

const UNIT_COLUMNS = `id, asset_tag, asset_class_id, asset_state, condition_enum_id, home_venue_id, created_at, updated_at, asset_class:asset_classes!asset_units_asset_class_id_fkey(name), home_venue:venues!asset_units_home_venue_id_fkey(name), asset_custody(${CUSTODY_COLUMNS})`;

interface CustodyRow {
  id: string;
  created_at: string;
  custodian_membership_id: string | null;
  custodian_engagement_id: string | null;
  venue_id: string | null;
  project_id: string | null;
  note: string | null;
  custodian: { person: { full_name: string | null } | null } | null;
  engagement: { person: { full_name: string | null } | null } | null;
  venue: { name: string } | null;
  project: { project_key: string } | null;
}

interface UnitRow {
  id: string;
  asset_tag: string;
  asset_class_id: string;
  asset_state: AssetState;
  condition_enum_id: string | null;
  home_venue_id: string | null;
  created_at: string;
  updated_at: string;
  asset_class: { name: string } | null;
  home_venue: { name: string } | null;
  asset_custody: CustodyRow[];
}

function toHolder(row: CustodyRow): CustodyHolder {
  return {
    custodyId: row.id,
    membershipId: row.custodian_membership_id,
    engagementId: row.custodian_engagement_id ?? null,
    custodianName: row.custodian?.person?.full_name ?? row.engagement?.person?.full_name ?? null,
    venueId: row.venue_id,
    venueName: row.venue?.name ?? null,
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? null,
    since: row.created_at,
  };
}

/** The latest custody row: the current custodian (0352, asset_custody). */
function latestCustody(rows: readonly CustodyRow[]): CustodyRow | null {
  let latest: CustodyRow | null = null;
  for (const row of rows) {
    if (
      !latest ||
      row.created_at > latest.created_at ||
      (row.created_at === latest.created_at && row.id > latest.id)
    ) {
      latest = row;
    }
  }
  return latest;
}

function toUnit(row: UnitRow): AssetUnit {
  const current = latestCustody(row.asset_custody);
  return {
    id: row.id,
    assetTag: row.asset_tag,
    classId: row.asset_class_id,
    className: row.asset_class?.name ?? "",
    state: row.asset_state,
    conditionEnumId: row.condition_enum_id,
    homeVenueId: row.home_venue_id,
    homeVenueName: row.home_venue?.name ?? null,
    custody: current ? toHolder(current) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UnitFilter {
  readonly classId?: string;
  readonly state?: AssetState;
  /** Units whose current custody is for this project (the project Assets tab). */
  readonly projectId?: string;
}

/** Asset units in asset tag order, with class, home venue and current custodian. */
export async function listAssetUnits(
  db: XosClient,
  orgId: string,
  filter: UnitFilter = {},
): Promise<Result<AssetUnit[]>> {
  let request = db
    .from("asset_units")
    .select(UNIT_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("asset_tag", { ascending: true });
  if (filter.classId) request = request.eq("asset_class_id", filter.classId);
  if (filter.state) request = request.eq("asset_state", filter.state);
  const { data, error } = await request;
  if (error) return fail(toDataError(error));
  const units = (data as unknown as UnitRow[]).map(toUnit);
  return ok(
    filter.projectId ? units.filter((u) => u.custody?.projectId === filter.projectId) : units,
  );
}

export interface AssetIdentifier {
  readonly id: string;
  readonly scheme: string;
  readonly value: string;
}

export interface CustodyEntry extends CustodyHolder {
  readonly note: string | null;
}

export interface StateTransition {
  readonly id: string;
  readonly fromState: AssetState | null;
  readonly toState: AssetState;
  readonly reason: string | null;
  readonly at: string;
}

export interface AssetUnitDetail extends AssetUnit {
  readonly elementId: string | null;
  readonly identifiers: readonly AssetIdentifier[];
  readonly custodyHistory: readonly CustodyEntry[];
  readonly transitions: readonly StateTransition[];
  readonly maintenance: readonly MaintenanceEntry[];
  readonly damage: readonly DamageEntry[];
}

/** One unit by asset tag with its identifiers, custody history, transitions, maintenance and damage. */
export async function getAssetUnit(
  db: XosClient,
  orgId: string,
  assetTag: string,
): Promise<Result<AssetUnitDetail>> {
  const tag = normalizeAssetTag(assetTag);
  if (!isAssetTag(tag)) return fail({ kind: "not-found" });
  const { data, error } = await db
    .from("asset_units")
    .select(
      `${UNIT_COLUMNS}, asset_class_element:asset_classes!asset_units_asset_class_id_fkey(element_id), asset_identifiers(id, scheme, value, deleted_at), asset_state_transitions(id, from_state, to_state, reason, created_at)`,
    )
    .eq("org_id", orgId)
    .eq("asset_tag", tag)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const row = data as unknown as UnitRow & {
    asset_class_element: { element_id: string } | null;
    asset_identifiers: { id: string; scheme: string; value: string; deleted_at: string | null }[];
    asset_state_transitions: {
      id: string;
      from_state: AssetState | null;
      to_state: AssetState;
      reason: string | null;
      created_at: string;
    }[];
  };
  const [maintenance, damage] = await Promise.all([
    listAssetMaintenance(db, orgId, { unitId: row.id }),
    listAssetDamage(db, orgId, { unitId: row.id }),
  ]);
  if (!maintenance.ok) return maintenance;
  if (!damage.ok) return damage;
  return ok({
    ...toUnit(row),
    elementId: row.asset_class_element?.element_id ?? null,
    identifiers: row.asset_identifiers
      .filter((i) => i.deleted_at === null)
      .map((i) => ({ id: i.id, scheme: i.scheme, value: i.value }))
      .sort((a, b) => a.scheme.localeCompare(b.scheme) || a.value.localeCompare(b.value)),
    custodyHistory: [...row.asset_custody]
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .map((c) => ({ ...toHolder(c), note: c.note })),
    transitions: [...row.asset_state_transitions]
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .map((t) => ({
        id: t.id,
        fromState: t.from_state,
        toState: t.to_state,
        reason: t.reason,
        at: t.created_at,
      })),
    maintenance: maintenance.data,
    damage: damage.data,
  });
}

/** Registers a unit of a class under an asset tag; it starts Proposed (Section 3.12). */
export async function createAssetUnit(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly classId: string;
    readonly assetTag: string;
    readonly conditionEnumId: string | null;
    readonly homeVenueId: string | null;
  },
): Promise<Result<{ id: string; assetTag: string }>> {
  const tag = normalizeAssetTag(input.assetTag);
  if (!isAssetTag(tag)) return invalid("assetTag");
  const { data, error } = await db
    .from("asset_units")
    .insert({
      org_id: input.orgId,
      asset_class_id: input.classId,
      asset_tag: tag,
      condition_enum_id: input.conditionEnumId,
      home_venue_id: input.homeVenueId,
    })
    .select("id, asset_tag")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id, assetTag: data.asset_tag });
}

/** Edits a unit's condition and home venue. The tag and class stay fixed (0352 guard). */
export async function updateAssetUnit(
  db: XosClient,
  id: string,
  input: { readonly conditionEnumId: string | null; readonly homeVenueId: string | null },
): Promise<Result<null>> {
  const { error } = await db
    .from("asset_units")
    .update({ condition_enum_id: input.conditionEnumId, home_venue_id: input.homeVenueId })
    .eq("id", id);
  return error ? fail(toDataError(error)) : ok(null);
}

/** Moves a unit along its lifecycle with compare-and-set (app.transition_asset). */
export async function transitionAssetUnit(
  db: XosClient,
  input: {
    readonly unitId: string;
    readonly expected: AssetState;
    readonly next: AssetState;
    readonly reason: string;
  },
): Promise<Result<{ transitionId: string }>> {
  const reason = input.reason.trim();
  if (reason.length === 0)
    return refuse("transition_reason_required", "Every state change carries a reason.");
  const { data, error } = await db.rpc("transition_asset", {
    p_asset_unit_id: input.unitId,
    p_expected: input.expected,
    p_next: input.next,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok({ transitionId: data });
}

/** Records an identifier an external authority issued for a unit (serial, GTIN, MPN). */
export async function addAssetIdentifier(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly unitId: string;
    readonly scheme: string;
    readonly value: string;
  },
): Promise<Result<{ id: string }>> {
  const scheme = input.scheme.trim().toLowerCase();
  const value = input.value.trim();
  if (!SCHEME.test(scheme)) return invalid("scheme");
  if (value.length === 0 || value.length > 100) return invalid("value");
  const { data, error } = await db
    .from("asset_identifiers")
    .insert({ org_id: input.orgId, asset_unit_id: input.unitId, scheme, value })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Removes a recorded identifier (soft delete). */
export async function removeAssetIdentifier(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db
    .from("asset_identifiers")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  return error ? fail(toDataError(error)) : ok(null);
}

// Lots ---------------------------------------------------------------------------------------------

export interface AssetLot {
  readonly id: string;
  readonly classId: string;
  readonly className: string;
  readonly venueId: string;
  readonly venueName: string;
  /** Opening count when the lot was created. */
  readonly openingQuantity: number;
  /** Quantity on hand: the opening count plus the lot ledger (app.asset_lot_balances). */
  readonly onHand: number;
  readonly updatedAt: string;
}

/** Lots by class then place: a quantity of a class at a venue (Section 3.9 lot grain). */
export async function listAssetLots(
  db: XosClient,
  orgId: string,
  filter: { readonly classId?: string } = {},
): Promise<Result<AssetLot[]>> {
  let request = db
    .from("asset_lots")
    .select(
      "id, asset_class_id, venue_id, quantity, updated_at, asset_class:asset_classes!asset_lots_asset_class_id_fkey(name), venue:venues!asset_lots_venue_id_fkey(name)",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (filter.classId) request = request.eq("asset_class_id", filter.classId);
  const { data, error } = await request;
  if (error) return fail(toDataError(error));
  const balances = await lotBalances(
    db,
    data.map((r) => r.id),
  );
  if (!balances.ok) return balances;
  return ok(
    data
      .map((r) => ({
        id: r.id,
        classId: r.asset_class_id,
        className: r.asset_class?.name ?? "",
        venueId: r.venue_id,
        venueName: r.venue?.name ?? "",
        openingQuantity: Number(r.quantity),
        onHand: balances.data.get(r.id) ?? Number(r.quantity),
        updatedAt: r.updated_at,
      }))
      .sort(
        (a, b) => a.className.localeCompare(b.className) || a.venueName.localeCompare(b.venueName),
      ),
  );
}

interface LotMovementRow {
  id: string;
  movement_kind: LotMovementKind;
  delta: number | string;
  custodian_membership_id: string | null;
  custodian_engagement_id: string | null;
  project_id: string | null;
  note: string | null;
  created_at: string;
  custodian: { person: { full_name: string | null } | null } | null;
  engagement: { person: { full_name: string | null } | null } | null;
  project: { project_key: string } | null;
}

async function lotBalances(
  db: XosClient,
  ids: readonly string[],
): Promise<Result<Map<string, number>>> {
  if (ids.length === 0) return ok(new Map());
  const { data, error } = await db
    .from("asset_lot_balances")
    .select("asset_lot_id, on_hand")
    .in("asset_lot_id", [...ids]);
  if (error) return fail(toDataError(error));
  return ok(
    new Map(
      data.flatMap((r) => (r.asset_lot_id === null ? [] : [[r.asset_lot_id, Number(r.on_hand)]])),
    ),
  );
}

export type LotMovementKind = Database["app"]["Enums"]["asset_lot_movement_kind"];

export interface LotMovement {
  readonly id: string;
  readonly kind: LotMovementKind;
  readonly delta: number;
  readonly membershipId: string | null;
  /** Engagement that took or returned the quantity (migration 2602). */
  readonly engagementId: string | null;
  /** The member's or the engaged person's name. */
  readonly custodianName: string | null;
  readonly projectId: string | null;
  readonly projectKey: string | null;
  readonly note: string | null;
  readonly at: string;
}

/** The lot ledger of one lot, newest first. */
export async function listAssetLotMovements(
  db: XosClient,
  lotId: string,
): Promise<Result<LotMovement[]>> {
  const { data, error } = await db
    .from("asset_lot_movements")
    .select(
      "id, movement_kind, delta, custodian_membership_id, custodian_engagement_id, project_id, note, created_at, custodian:memberships!asset_lot_movements_custodian_membership_id_fkey(person:people!memberships_person_id_fkey(full_name)), engagement:engagements!asset_lot_movements_custodian_engagement_id_fkey(person:people!engagements_person_id_fkey(full_name)), project:projects!asset_lot_movements_project_id_fkey(project_key)",
    )
    .eq("asset_lot_id", lotId)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    ((data ?? []) as unknown as LotMovementRow[]).map((r) => ({
      id: r.id,
      kind: r.movement_kind,
      delta: Number(r.delta),
      membershipId: r.custodian_membership_id,
      engagementId: r.custodian_engagement_id ?? null,
      custodianName: r.custodian?.person?.full_name ?? r.engagement?.person?.full_name ?? null,
      projectId: r.project_id,
      projectKey: r.project?.project_key ?? null,
      note: r.note,
      at: r.created_at,
    })),
  );
}

function checkQuantity(quantity: number): boolean {
  return Number.isFinite(quantity) && quantity >= 0;
}

/** Counts a class at a place: one lot per class per venue. */
export async function createAssetLot(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly classId: string;
    readonly venueId: string;
    readonly quantity: number;
  },
): Promise<Result<{ id: string }>> {
  if (!checkQuantity(input.quantity)) return invalid("quantity");
  const { data, error } = await db
    .from("asset_lots")
    .insert({
      org_id: input.orgId,
      asset_class_id: input.classId,
      venue_id: input.venueId,
      quantity: input.quantity,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

// Custody ledger -----------------------------------------------------------------------------------

export interface CustodyLedgerEntry extends CustodyEntry {
  readonly unitId: string;
  readonly assetTag: string;
  readonly className: string;
}

/** The custody ledger, newest first: who or where held which unit, for which project. */
export async function listAssetCustody(
  db: XosClient,
  orgId: string,
  filter: { readonly unitId?: string; readonly projectId?: string; readonly limit?: number } = {},
): Promise<Result<CustodyLedgerEntry[]>> {
  let request = db
    .from("asset_custody")
    .select(
      `${CUSTODY_COLUMNS}, asset_unit_id, unit:asset_units!asset_custody_asset_unit_id_fkey(asset_tag, asset_class:asset_classes!asset_units_asset_class_id_fkey(name))`,
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(filter.limit ?? 200);
  if (filter.unitId) request = request.eq("asset_unit_id", filter.unitId);
  if (filter.projectId) request = request.eq("project_id", filter.projectId);
  const { data, error } = await request;
  if (error) return fail(toDataError(error));
  const rows = data as unknown as (CustodyRow & {
    asset_unit_id: string;
    unit: { asset_tag: string; asset_class: { name: string } | null } | null;
  })[];
  return ok(
    rows.map((r) => ({
      ...toHolder(r),
      note: r.note,
      unitId: r.asset_unit_id,
      assetTag: r.unit?.asset_tag ?? "",
      className: r.unit?.asset_class?.name ?? "",
    })),
  );
}

export interface CustodyInput {
  readonly orgId: string;
  readonly unitId: string;
  readonly membershipId: string | null;
  readonly engagementId?: string | null;
  readonly venueId: string | null;
  readonly projectId: string | null;
  readonly note: string | null;
  /** The person on the custodian engagement's roster who takes the unit (R7). */
  readonly rosterEntryId?: string | null;
  /** The hold of an allocation the hand-over is issued against (R7). */
  readonly reservationId?: string | null;
}

/**
 * Records a custody hand-over through app.record_asset_custody (R7, 2692): a check-out or transfer to one
 * custodian, or a check-in to a place, written by app.apply_asset_scan so the unit's state moves with it and the
 * holder guards apply. Signed-in users no longer insert custody rows directly.
 */
export async function recordAssetCustody(
  db: XosClient,
  input: CustodyInput,
): Promise<Result<{ id: string }>> {
  const engagementId = input.engagementId ?? null;
  if (input.membershipId !== null && engagementId !== null) {
    return refuse(
      "asset_custody_one_custodian",
      "Custody goes to a member or an engagement, not both.",
    );
  }
  if (input.membershipId === null && engagementId === null && input.venueId === null) {
    return refuse("asset_custody_somewhere", "A custody move names a person or a place.");
  }
  const note = input.note?.trim() ? input.note.trim() : null;
  const { data, error } = await db.rpc("record_asset_custody", {
    p_asset_unit_id: input.unitId,
    ...(input.membershipId ? { p_custodian_membership_id: input.membershipId } : {}),
    ...(engagementId ? { p_custodian_engagement_id: engagementId } : {}),
    ...(input.venueId ? { p_venue_id: input.venueId } : {}),
    ...(input.projectId ? { p_project_id: input.projectId } : {}),
    ...(note ? { p_note: note } : {}),
    ...(input.rosterEntryId ? { p_roster_entry_id: input.rosterEntryId } : {}),
    ...(input.reservationId ? { p_reservation_id: input.reservationId } : {}),
    ...(input.rosterEntryId ? { p_roster_entry_id: input.rosterEntryId } : {}),
    ...(input.reservationId ? { p_reservation_id: input.reservationId } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

// Maintenance --------------------------------------------------------------------------------------

export interface MaintenanceEntry {
  readonly id: string;
  readonly unitId: string;
  readonly assetTag: string;
  readonly performedOn: string;
  readonly description: string;
  /** Minor units; null when the cost is unknown (never zero for unknown, Section 3.7). */
  readonly costMinor: number | null;
  readonly currencyCode: string | null;
  readonly createdAt: string;
}

/** Maintenance work, newest first. */
export async function listAssetMaintenance(
  db: XosClient,
  orgId: string,
  filter: { readonly unitId?: string } = {},
): Promise<Result<MaintenanceEntry[]>> {
  let request = db
    .from("asset_maintenance")
    .select(
      "id, asset_unit_id, performed_on, description, cost_minor, currency_code, created_at, unit:asset_units!asset_maintenance_asset_unit_id_fkey(asset_tag)",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("performed_on", { ascending: false })
    .order("created_at", { ascending: false });
  if (filter.unitId) request = request.eq("asset_unit_id", filter.unitId);
  const { data, error } = await request;
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      unitId: r.asset_unit_id,
      assetTag: r.unit?.asset_tag ?? "",
      performedOn: r.performed_on,
      description: r.description,
      costMinor: r.cost_minor,
      currencyCode: r.currency_code,
      createdAt: r.created_at,
    })),
  );
}

/** Records maintenance on a unit. An unknown cost stays null, never zero. */
export async function recordAssetMaintenance(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly unitId: string;
    readonly performedOn: string;
    readonly description: string;
    readonly costMinor: number | null;
    readonly currencyCode: string | null;
  },
): Promise<Result<{ id: string }>> {
  const description = input.description.trim();
  if (description.length === 0) return invalid("description");
  if (!ISO_DATE.test(input.performedOn)) return invalid("performedOn");
  if (input.costMinor !== null) {
    if (!Number.isSafeInteger(input.costMinor) || input.costMinor < 0) return invalid("cost");
    if (!input.currencyCode || !CURRENCY.test(input.currencyCode)) return invalid("currency");
  }
  const { data, error } = await db
    .from("asset_maintenance")
    .insert({
      org_id: input.orgId,
      asset_unit_id: input.unitId,
      performed_on: input.performedOn,
      description,
      cost_minor: input.costMinor,
      currency_code: input.costMinor === null ? null : input.currencyCode,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

// Damage -------------------------------------------------------------------------------------------

export interface DamageEntry {
  readonly id: string;
  readonly unitId: string;
  readonly assetTag: string;
  readonly unitState: AssetState | null;
  readonly projectId: string | null;
  readonly projectKey: string | null;
  readonly counterpartyId: string | null;
  readonly reportedAt: string;
  readonly description: string;
}

/** Damage reports, newest first. */
export async function listAssetDamage(
  db: XosClient,
  orgId: string,
  filter: { readonly unitId?: string; readonly projectId?: string } = {},
): Promise<Result<DamageEntry[]>> {
  let request = db
    .from("asset_damage")
    .select(
      "id, asset_unit_id, project_id, responsible_counterparty_id, reported_at, description, unit:asset_units!asset_damage_asset_unit_id_fkey(asset_tag, asset_state), project:projects!asset_damage_project_id_fkey(project_key)",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("reported_at", { ascending: false });
  if (filter.unitId) request = request.eq("asset_unit_id", filter.unitId);
  if (filter.projectId) request = request.eq("project_id", filter.projectId);
  const { data, error } = await request;
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      unitId: r.asset_unit_id,
      assetTag: r.unit?.asset_tag ?? "",
      unitState: r.unit?.asset_state ?? null,
      projectId: r.project_id,
      projectKey: r.project?.project_key ?? null,
      counterpartyId: r.responsible_counterparty_id,
      reportedAt: r.reported_at,
      description: r.description,
    })),
  );
}

/** Reports damage against a unit, optionally during a project. */
export async function reportAssetDamage(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly unitId: string;
    readonly projectId: string | null;
    readonly description: string;
  },
): Promise<Result<{ id: string }>> {
  const description = input.description.trim();
  if (description.length === 0) return invalid("description");
  const { data, error } = await db
    .from("asset_damage")
    .insert({
      org_id: input.orgId,
      asset_unit_id: input.unitId,
      project_id: input.projectId,
      description,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

// Scan resolution (the Compass back end) ---------------------------------------------------------

export type ScanAction = "check-out" | "check-in" | "transfer";
export const SCAN_ACTIONS: readonly ScanAction[] = ["check-out", "check-in", "transfer"];

/** The states each scan action starts from, mirroring app.apply_asset_scan (migration 0975). */
const SCAN_FROM: Record<ScanAction, readonly AssetState[]> = {
  "check-out": ["Available", "Reserved"],
  "check-in": ["Deployed"],
  transfer: ["Deployed"],
};

/** The scan actions a unit in this state accepts, so Compass offers only moves the RPC takes. */
export function scanActionsFor(state: AssetState): ScanAction[] {
  return SCAN_ACTIONS.filter((a) => SCAN_FROM[a].includes(state));
}

/** The code printed on a lot label (lots carry no code column, so the label carries the id). */
export function lotScanCode(lotId: string): string {
  return `LOT:${lotId}`;
}

export interface ScannedUnit {
  readonly id: string;
  readonly assetTag: string;
  readonly className: string;
  readonly state: AssetState;
  readonly homeVenueId: string | null;
  readonly custodianMembershipId: string | null;
  readonly custodianEngagementId: string | null;
  readonly custodyVenueId: string | null;
  readonly custodyProjectId: string | null;
  readonly custodySince: string | null;
}

export interface ScannedLot {
  readonly id: string;
  readonly className: string;
  readonly venueId: string;
  readonly onHand: number;
}

export type ScanResolution =
  | { readonly kind: "unit"; readonly unit: ScannedUnit; readonly actions: readonly ScanAction[] }
  | { readonly kind: "lot"; readonly lot: ScannedLot };

interface ResolveRow {
  subject_kind: string | null;
  subject_id: string | null;
  asset_tag: string | null;
  class_name: string | null;
  asset_state: AssetState | null;
  home_venue_id: string | null;
  custodian_membership_id: string | null;
  custodian_engagement_id: string | null;
  custody_venue_id: string | null;
  custody_project_id: string | null;
  custody_since: string | null;
  lot_venue_id: string | null;
  on_hand: number | string | null;
  refusal: string | null;
  reason: string | null;
}

interface ApplyRow {
  outcome: "applied" | "duplicate";
  subject_kind: "unit" | "lot";
  subject_id: string;
  ledger_id: string;
  asset_state: AssetState | null;
  on_hand: number | string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a scanned code to a unit or lot (app.resolve_asset_code): a lot label, then an asset
 * tag, then an external identifier, GTINs also tried as GTIN-14. A code nothing carries, or one two
 * units carry, comes back as a refusal (NO_ANSWER), never a guess (Section 3.7). External parties
 * resolve only the gear their engagements hold.
 */
export async function resolveAssetScan(
  db: XosClient,
  input: { readonly orgId: string; readonly code: string },
): Promise<Result<ScanResolution>> {
  const { data, error } = await db.rpc("resolve_asset_code", {
    p_org_id: input.orgId,
    p_code: input.code,
  });
  if (error) return fail(toDataError(error));
  // Refusal rows carry nulls the generated row type does not admit.
  const row = (data as unknown as ResolveRow[] | null)?.[0];
  if (!row || row.refusal !== null || row.subject_id === null) {
    return fail({
      kind: "refusal",
      rule: row?.reason ?? "asset_code_unknown",
      message: "NO_ANSWER",
    });
  }
  if (row.subject_kind === "lot") {
    return ok({
      kind: "lot",
      lot: {
        id: row.subject_id,
        className: row.class_name ?? "",
        venueId: row.lot_venue_id ?? "",
        onHand: Number(row.on_hand ?? 0),
      },
    });
  }
  const state = row.asset_state ?? "Proposed";
  return ok({
    kind: "unit",
    unit: {
      id: row.subject_id,
      assetTag: row.asset_tag ?? "",
      className: row.class_name ?? "",
      state,
      homeVenueId: row.home_venue_id,
      custodianMembershipId: row.custodian_membership_id,
      custodianEngagementId: row.custodian_engagement_id,
      custodyVenueId: row.custody_venue_id,
      custodyProjectId: row.custody_project_id,
      custodySince: row.custody_since,
    },
    actions: scanActionsFor(state),
  });
}

export interface ScanEventInput {
  /** UUID v7 minted on the device when the scan happened; kept in the offline queue. */
  readonly eventId: string;
  readonly orgId: string;
  readonly code: string;
  readonly action: ScanAction;
  readonly membershipId?: string | null;
  readonly engagementId?: string | null;
  readonly venueId?: string | null;
  readonly projectId?: string | null;
  readonly note?: string | null;
  /** Lots only: how many move. */
  readonly quantity?: number | null;
  /** The person on the custodian engagement's roster who takes or returns the item (R7). */
  readonly rosterEntryId?: string | null;
  /** The allocation hold the hand-over is issued against (R7). */
  readonly reservationId?: string | null;
}

export interface ScanEventResult {
  readonly outcome: "applied" | "duplicate";
  readonly kind: "unit" | "lot";
  readonly subjectId: string;
  readonly ledgerId: string;
  /** Units: the state after the scan. */
  readonly state: AssetState | null;
  /** Lots: the quantity on hand after the scan. */
  readonly onHand: number | null;
}

/**
 * Applies one scan event from Compass in one transaction (app.apply_asset_scan): the custody row or
 * lot movement keyed by the device's event id, then the state move the action implies. Replaying
 * the same event id, after any delay, returns `duplicate` and changes nothing. The server wins
 * conflicts: a unit moved by someone else while the device was offline is refused with its current
 * state (asset_scan_state_conflict).
 */
export async function applyAssetScanEvent(
  db: XosClient,
  input: ScanEventInput,
): Promise<Result<ScanEventResult>> {
  if (!UUID.test(input.eventId)) return invalid("eventId");
  const note = input.note?.trim();
  const { data, error } = await db.rpc("apply_asset_scan", {
    p_event_id: input.eventId,
    p_org_id: input.orgId,
    p_code: input.code,
    p_action: input.action,
    ...(input.membershipId ? { p_custodian_membership_id: input.membershipId } : {}),
    ...(input.engagementId ? { p_custodian_engagement_id: input.engagementId } : {}),
    ...(input.venueId ? { p_venue_id: input.venueId } : {}),
    ...(input.projectId ? { p_project_id: input.projectId } : {}),
    ...(note ? { p_note: note } : {}),
    ...(input.quantity !== null && input.quantity !== undefined
      ? { p_quantity: input.quantity }
      : {}),
  });
  if (error) return fail(toDataError(error));
  const row = (data as unknown as ApplyRow[] | null)?.[0];
  if (!row) return fail({ kind: "unexpected", message: "apply_asset_scan returned no row" });
  return ok({
    outcome: row.outcome,
    kind: row.subject_kind,
    subjectId: row.subject_id,
    ledgerId: row.ledger_id,
    state: row.asset_state,
    onHand: row.on_hand === null ? null : Number(row.on_hand),
  });
}

/** Records a recount of a lot (app.count_asset_lot); a count that matches what is on hand records nothing. */
export async function countAssetLot(
  db: XosClient,
  input: { readonly lotId: string; readonly counted: number; readonly note: string | null },
): Promise<Result<{ movementId: string | null }>> {
  if (!Number.isFinite(input.counted) || input.counted < 0) return invalid("quantity");
  const note = input.note?.trim();
  const { data, error } = await db.rpc("count_asset_lot", {
    p_asset_lot_id: input.lotId,
    p_counted: input.counted,
    ...(note ? { p_note: note } : {}),
  });
  if (error) return fail(toDataError(error));
  // A count that matches what is on hand returns null.
  return ok({ movementId: (data as string | null) ?? null });
}

// Provenance and hire (R7a) ---------------------------------------------------------------------------------

export interface AssetUnitProvenance {
  readonly receiptLineId: string;
  readonly goodsReceiptId: string;
  readonly receivedAt: string;
  readonly purchaseOrderId: string;
  readonly poNumber: number;
  readonly projectId: string;
  readonly vendorId: string;
  readonly acquisitionKind: Database["app"]["Enums"]["acquisition_kind"];
  /** Rental units: when the hire ends and the unit is due back (ISO instant). */
  readonly hireEndsAt: string | null;
  readonly unitPriceMinor: number | null;
  readonly currencyCode: string;
}

/** The upper bound of a tstzrange as PostgREST returns it, as an ISO instant. */
function rangeEnd(value: unknown): string | null {
  const match = typeof value === "string" ? value.match(/,"?([^",)\]]+)"?[)\]]$/) : null;
  if (!match?.[1]) return null;
  const at = new Date(match[1].replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * Where a unit came from (app.asset_unit_provenance): its receipt, order, vendor and price. The view runs as the
 * reader, so a person without procurement.po.read on the order's project gets null and never sees cost.
 */
export async function getAssetUnitProvenance(
  db: XosClient,
  assetUnitId: string,
): Promise<Result<AssetUnitProvenance | null>> {
  const { data, error } = await db
    .from("asset_unit_provenance")
    .select(
      "receipt_line_id, goods_receipt_id, received_at, purchase_order_id, po_number, project_id, vendor_id, acquisition_kind, hire_period, unit_price_minor, currency_code",
    )
    .eq("asset_unit_id", assetUnitId)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return ok(null);
  return ok({
    receiptLineId: data.receipt_line_id ?? "",
    goodsReceiptId: data.goods_receipt_id ?? "",
    receivedAt: data.received_at ?? "",
    purchaseOrderId: data.purchase_order_id ?? "",
    poNumber: data.po_number ?? 0,
    projectId: data.project_id ?? "",
    vendorId: data.vendor_id ?? "",
    acquisitionKind: data.acquisition_kind ?? "Purchase",
    hireEndsAt: rangeEnd(data.hire_period),
    unitPriceMinor: data.unit_price_minor,
    currencyCode: data.currency_code ?? "",
  });
}

export interface AssetUnitHire {
  readonly assetUnitId: string;
  readonly acquisitionKind: Database["app"]["Enums"]["acquisition_kind"];
  readonly hireEndsAt: string | null;
  readonly offHireDue: boolean;
}

/**
 * Whether each unit of an org is hired in and when it goes back (app.asset_unit_hire, G-96). Readable with
 * assets.asset.read alone: it carries no vendor, cost or order.
 */
export async function listAssetUnitHire(
  db: XosClient,
  orgId: string,
): Promise<Result<AssetUnitHire[]>> {
  const { data, error } = await db
    .from("asset_unit_hire")
    .select("asset_unit_id, acquisition_kind, hire_ends_at, off_hire_due")
    .eq("org_id", orgId);
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).flatMap((r) =>
      r.asset_unit_id === null
        ? []
        : [
            {
              assetUnitId: r.asset_unit_id,
              acquisitionKind: r.acquisition_kind ?? "Purchase",
              hireEndsAt: r.hire_ends_at,
              offHireDue: r.off_hire_due ?? false,
            },
          ],
    ),
  );
}

export interface ReceiptUnit {
  readonly id: string;
  readonly assetTag: string;
  readonly receiptLineId: string;
  readonly state: AssetState;
}

/** The units that arrived on some receipt lines (R7a), by tag, for the receipt page and the return dialog. */
export async function listReceiptUnits(
  db: XosClient,
  receiptLineIds: readonly string[],
): Promise<Result<ReceiptUnit[]>> {
  if (receiptLineIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("asset_units")
    .select("id, asset_tag, receipt_line_id, asset_state")
    .in("receipt_line_id", [...receiptLineIds])
    .is("deleted_at", null)
    .order("asset_tag");
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((u) => ({
      id: u.id,
      assetTag: u.asset_tag,
      receiptLineId: u.receipt_line_id ?? "",
      state: u.asset_state,
    })),
  );
}

export interface ReceiptStock {
  readonly receiptLineId: string;
  readonly venueId: string;
}

/**
 * Where some receipt lines brought a quantity into stock (their Receipt movements, R7a), for the return dialog: a
 * line goes back the way it came in, so a stocked line goes back out of a lot and any other quantity without one.
 */
export async function listReceiptStock(
  db: XosClient,
  receiptLineIds: readonly string[],
): Promise<Result<ReceiptStock[]>> {
  if (receiptLineIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("asset_lot_movements")
    .select("receipt_line_id, lot:asset_lots!asset_lot_movements_asset_lot_id_fkey(venue_id)")
    .in("receipt_line_id", [...receiptLineIds])
    .eq("movement_kind", "Receipt");
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).flatMap((m) =>
      m.receipt_line_id === null || !m.lot
        ? []
        : [{ receiptLineId: m.receipt_line_id, venueId: m.lot.venue_id }],
    ),
  );
}
