import type { XosClient } from "./client.ts";
import { personNames } from "./person-names.ts";
import type { Result } from "./result.ts";
import { untyped } from "./untyped.ts";
import {
  args,
  call,
  callId,
  callRows,
  list,
  memberName,
  MEMBER_EMBED,
  num,
  numOrNull,
  rows,
  single,
  str,
  strOrNull,
  type Raw,
} from "./workforce-shared.ts";

/**
 * Site operations (Section 4.9 production-specific additions; migration 0806), imported as
 * `@xos/data/workforce-site`: live occupancy against the permitted load with alerts at 80, 90 and
 * 100 percent, weather thresholds, readings and alerts, guest check-in at doors, and the lost and
 * found log. Configuring needs safety.emergency_code.write; counting, readings and logging need
 * safety.incident.write on the project; claims are settled with safety.incident.close.
 */

export type OccupancyLoadBasis = "Space Capacity" | "Occupant Load Factor" | "Permit";
export type WeatherHazard = "Wind" | "Lightning" | "Heat";
export type WeatherAlertLevel = "Monitor" | "Restrict" | "Evacuate";
export type LostItemCategory =
  "Bag" | "Clothing" | "Electronics" | "Jewelry" | "Keys" | "Documents" | "Wallet" | "Other";
export type LostItemState = "Logged" | "Claimed" | "Returned" | "Disposed";

export const WEATHER_HAZARDS: readonly WeatherHazard[] = ["Wind", "Lightning", "Heat"];
export const WEATHER_LEVELS: readonly WeatherAlertLevel[] = ["Monitor", "Restrict", "Evacuate"];
export const LOST_ITEM_CATEGORIES: readonly LostItemCategory[] = [
  "Bag",
  "Clothing",
  "Electronics",
  "Jewelry",
  "Keys",
  "Documents",
  "Wallet",
  "Other",
];
export const LOST_ITEM_STATES: readonly LostItemState[] = [
  "Logged",
  "Claimed",
  "Returned",
  "Disposed",
];

/** The unit each hazard is read in, and how a reading meets a threshold. */
export const HAZARD_UNITS: Readonly<
  Record<WeatherHazard, { unit: "mph" | "mi" | "F"; comparison: "At or Above" | "At or Below" }>
> = {
  Wind: { unit: "mph", comparison: "At or Above" },
  Lightning: { unit: "mi", comparison: "At or Below" },
  Heat: { unit: "F", comparison: "At or Above" },
};

/**
 * The Intl unit each stored hazard unit is (Section 15 units): readings and thresholds stay stored in mph, miles
 * and degrees Fahrenheit, and screens convert them to the person's units (locale.units) for display and input.
 */
export const HAZARD_MEASURES: Readonly<
  Record<(typeof HAZARD_UNITS)[WeatherHazard]["unit"], "mile-per-hour" | "mile" | "fahrenheit">
> = { mph: "mile-per-hour", mi: "mile", F: "fahrenheit" };

/** The alert thresholds of Section 4.9, in percent of the permitted load. */
export const OCCUPANCY_LEVELS = [80, 90, 100] as const;

// Occupancy ---------------------------------------------------------------------------------------

export interface OccupancyCounter {
  readonly id: string;
  readonly projectId: string;
  readonly spaceId: string | null;
  readonly name: string;
  readonly basis: OccupancyLoadBasis;
  readonly metricItem: string | null;
  readonly permittedLoad: number;
  readonly count: number;
  readonly alertLevel: number;
  readonly closedAt: string | null;
}

export async function listOccupancyCounters(
  db: XosClient,
  projectId: string,
): Promise<Result<OccupancyCounter[]>> {
  return rows(
    untyped(db)
      .from("occupancy_counters")
      .select(
        "id, project_id, space_id, name, load_basis, metric_item, permitted_load, current_count, alert_level_percent, closed_at",
      )
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("name"),
    (r) => ({
      id: str(r["id"]),
      projectId: str(r["project_id"]),
      spaceId: strOrNull(r["space_id"]),
      name: str(r["name"]),
      basis: str(r["load_basis"]) as OccupancyLoadBasis,
      metricItem: strOrNull(r["metric_item"]),
      permittedLoad: num(r["permitted_load"]),
      count: num(r["current_count"]),
      alertLevel: num(r["alert_level_percent"]),
      closedAt: strOrNull(r["closed_at"]),
    }),
  );
}

/** A count as a whole percent of the permitted load. */
export function occupancyPercent(c: Pick<OccupancyCounter, "count" | "permittedLoad">): number {
  return c.permittedLoad <= 0 ? 0 : Math.round((100 * c.count) / c.permittedLoad);
}

/** The highest alert level a count meets: 0, 80, 90 or 100. */
export function occupancyLevel(c: Pick<OccupancyCounter, "count" | "permittedLoad">): number {
  const pct = c.permittedLoad <= 0 ? 0 : (100 * c.count) / c.permittedLoad;
  return [...OCCUPANCY_LEVELS].reverse().find((l) => pct >= l) ?? 0;
}

export async function createOccupancyCounter(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly name: string;
    readonly spaceId?: string | null;
    readonly metricItem?: string | null;
    readonly permittedLoad?: number | null;
  },
): Promise<Result<{ id: string }>> {
  return callId(db, "create_occupancy_counter", {
    p_project_id: input.projectId,
    p_name: input.name,
    ...args({
      p_space_id: input.spaceId ?? undefined,
      p_metric_item: input.metricItem ?? undefined,
      p_permitted_load: input.permittedLoad ?? undefined,
    }),
  });
}

export async function closeOccupancyCounter(
  db: XosClient,
  counterId: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "close_occupancy_counter", { p_counter_id: counterId });
}

/** Counts people in (positive) or out (negative); returns the new count. */
export async function recordOccupancyCount(
  db: XosClient,
  counterId: string,
  delta: number,
  door?: string | null,
): Promise<Result<number>> {
  return call<number>(
    db,
    "record_occupancy_count",
    args({ p_counter_id: counterId, p_delta: delta, p_door: door ?? undefined }),
  );
}

export interface OccupantLoadFactor {
  readonly item: string;
  readonly squareFeetPerPerson: number;
  readonly qualifier: string | null;
}

/** The Bible occupant load factors (xpms.dim_metric domain capacity, square feet per person). */
export async function listOccupantLoadFactors(
  db: XosClient,
): Promise<Result<OccupantLoadFactor[]>> {
  const result = await rows(
    db
      .schema("xpms")
      .from("dim_metric")
      .select("item, value_numeric, qualifier, ordinal")
      .eq("domain", "capacity")
      .order("ordinal"),
    (r) => ({
      item: str(r["item"]),
      squareFeetPerPerson: num(r["value_numeric"]),
      qualifier: strOrNull(r["qualifier"]),
    }),
  );
  if (!result.ok) return result;
  return {
    ok: true,
    data: result.data.filter((f) => f.qualifier === "net" || f.qualifier === "gross"),
  };
}

export interface SpaceOption {
  readonly id: string;
  readonly name: string;
  readonly areaSqFt: number | null;
  readonly capacity: number | null;
}

/** Spaces of a project's venue, for sizing counters. */
export async function listProjectSpaces(
  db: XosClient,
  projectId: string,
): Promise<Result<SpaceOption[]>> {
  const project = await single(
    untyped(db).from("projects").select("venue_id").eq("id", projectId).maybeSingle(),
    (r) => strOrNull(r["venue_id"]),
  );
  if (!project.ok) return project;
  if (project.data === null) return { ok: true, data: [] };
  return rows(
    untyped(db)
      .from("spaces")
      .select("id, name, area_sq_ft, capacity")
      .eq("venue_id", project.data)
      .is("deleted_at", null)
      .order("name"),
    (r) => ({
      id: str(r["id"]),
      name: str(r["name"]),
      areaSqFt: numOrNull(r["area_sq_ft"]),
      capacity: numOrNull(r["capacity"]),
    }),
  );
}

// Weather -----------------------------------------------------------------------------------------

export interface WeatherThreshold {
  readonly id: string;
  readonly hazard: WeatherHazard;
  readonly level: WeatherAlertLevel;
  readonly value: number;
  readonly unit: string;
  readonly sourceNote: string;
}

export interface WeatherReading {
  readonly id: string;
  readonly hazard: WeatherHazard;
  readonly value: number;
  readonly observedAt: string;
  readonly recordedBy: string | null;
  /** Manual for a reading on site, NWS for one the official feed recorded (B8, 2976). */
  readonly source: "Manual" | "NWS";
}

export interface WeatherAlert {
  readonly id: string;
  readonly hazard: WeatherHazard;
  readonly level: WeatherAlertLevel;
  readonly issuedAt: string;
  readonly clearedAt: string | null;
}

export interface WeatherAlertRole {
  readonly id: string;
  readonly level: WeatherAlertLevel;
  readonly roleCode: string;
}

export interface WeatherBoard {
  readonly thresholds: readonly WeatherThreshold[];
  readonly readings: readonly WeatherReading[];
  readonly alerts: readonly WeatherAlert[];
  readonly roles: readonly WeatherAlertRole[];
}

/** Thresholds, the latest readings, alerts and alert roles of a project. */
export async function getWeatherBoard(
  db: XosClient,
  projectId: string,
): Promise<Result<WeatherBoard>> {
  const [thresholds, readings, alerts, roles] = await Promise.all([
    rows(
      untyped(db)
        .from("weather_thresholds")
        .select("id, hazard, alert_level, threshold_value, unit, source_note")
        .eq("project_id", projectId)
        .is("deleted_at", null),
      (r) => ({
        id: str(r["id"]),
        hazard: str(r["hazard"]) as WeatherHazard,
        level: str(r["alert_level"]) as WeatherAlertLevel,
        value: num(r["threshold_value"]),
        unit: str(r["unit"]),
        sourceNote: str(r["source_note"]),
      }),
    ),
    rows(
      untyped(db)
        .from("weather_readings")
        .select(
          `id, hazard, reading_value, observed_at, source, recorder:memberships(${MEMBER_EMBED})`,
        )
        .eq("project_id", projectId)
        .order("observed_at", { ascending: false })
        .limit(50),
      (r) => ({
        id: str(r["id"]),
        hazard: str(r["hazard"]) as WeatherHazard,
        value: num(r["reading_value"]),
        observedAt: str(r["observed_at"]),
        recordedBy: memberName(r["recorder"]),
        source: r["source"] === "NWS" ? ("NWS" as const) : ("Manual" as const),
      }),
    ),
    rows(
      untyped(db)
        .from("weather_alerts")
        .select("id, hazard, alert_level, issued_at, cleared_at")
        .eq("project_id", projectId)
        .order("issued_at", { ascending: false })
        .limit(50),
      (r) => ({
        id: str(r["id"]),
        hazard: str(r["hazard"]) as WeatherHazard,
        level: str(r["alert_level"]) as WeatherAlertLevel,
        issuedAt: str(r["issued_at"]),
        clearedAt: strOrNull(r["cleared_at"]),
      }),
    ),
    rows(
      untyped(db)
        .from("weather_alert_roles")
        .select("id, alert_level, role_code")
        .eq("project_id", projectId)
        .is("deleted_at", null),
      (r) => ({
        id: str(r["id"]),
        level: str(r["alert_level"]) as WeatherAlertLevel,
        roleCode: str(r["role_code"]),
      }),
    ),
  ]);
  if (!thresholds.ok) return thresholds;
  if (!readings.ok) return readings;
  if (!alerts.ok) return alerts;
  if (!roles.ok) return roles;
  return {
    ok: true,
    data: {
      thresholds: thresholds.data,
      readings: readings.data,
      alerts: alerts.data,
      roles: roles.data,
    },
  };
}

/** Sets a threshold, replacing the one already set for the hazard and level. */
export async function setWeatherThreshold(
  db: XosClient,
  orgId: string,
  projectId: string,
  input: {
    readonly hazard: WeatherHazard;
    readonly level: WeatherAlertLevel;
    readonly value: number;
    readonly sourceNote: string;
  },
): Promise<Result<{ id: string }>> {
  const existing = await rows(
    untyped(db)
      .from("weather_thresholds")
      .select("id")
      .eq("project_id", projectId)
      .eq("hazard", input.hazard)
      .eq("alert_level", input.level)
      .is("deleted_at", null),
    (r) => str(r["id"]),
  );
  if (!existing.ok) return existing;
  const { unit, comparison } = HAZARD_UNITS[input.hazard];
  const values = { threshold_value: input.value, source_note: input.sourceNote };
  if (existing.data[0]) {
    return single(
      untyped(db)
        .from("weather_thresholds")
        .update(values)
        .eq("id", existing.data[0])
        .select("id")
        .single(),
      (r) => ({ id: str(r["id"]) }),
    );
  }
  return single(
    untyped(db)
      .from("weather_thresholds")
      .insert({
        org_id: orgId,
        project_id: projectId,
        hazard: input.hazard,
        alert_level: input.level,
        unit,
        comparison,
        ...values,
      })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function addWeatherAlertRole(
  db: XosClient,
  orgId: string,
  projectId: string,
  level: WeatherAlertLevel,
  roleCode: string,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("weather_alert_roles")
      .insert({ org_id: orgId, project_id: projectId, alert_level: level, role_code: roleCode })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function removeWeatherAlertRole(
  db: XosClient,
  id: string,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("weather_alert_roles")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function recordWeatherReading(
  db: XosClient,
  projectId: string,
  hazard: WeatherHazard,
  value: number,
  observedAt?: string | null,
): Promise<Result<{ id: string }>> {
  return callId(
    db,
    "record_weather_reading",
    args({
      p_project_id: projectId,
      p_hazard: hazard,
      p_value: value,
      p_observed_at: observedAt ?? undefined,
    }),
  );
}

/** The level a reading meets against a project's thresholds (mirrors app.record_weather_reading). */
export function weatherLevel(
  thresholds: readonly Pick<WeatherThreshold, "hazard" | "level" | "value">[],
  hazard: WeatherHazard,
  value: number,
): WeatherAlertLevel | null {
  const below = HAZARD_UNITS[hazard].comparison === "At or Below";
  const met = thresholds.filter(
    (t) => t.hazard === hazard && (below ? value <= t.value : value >= t.value),
  );
  return [...WEATHER_LEVELS].reverse().find((l) => met.some((t) => t.level === l)) ?? null;
}

// Guest check-in ----------------------------------------------------------------------------------

export interface DoorGuest {
  readonly entryId: string;
  readonly name: string;
  readonly plusOnes: number;
  readonly state: "Approved" | "Checked In";
  readonly note: string | null;
  readonly checkedInAt: string | null;
  readonly plusOnesAdmitted: number | null;
  readonly door: string | null;
  /** The guest's pass (B8, 2974): the code the door scans, the pass type, the table and the host. */
  readonly passCode: string | null;
  readonly passCategoryCode: string | null;
  readonly passCategoryName: string | null;
  readonly tableLabel: string | null;
  readonly hostPersonId: string | null;
}

/** The pass code a door scan carries: the guest pass's XOSGP1:<code>, or the code typed as printed. */
export function passCodeFromScan(raw: string): string | null {
  const text = raw.trim().toUpperCase();
  const match = /^(?:XOSGP1:)?(GP-[A-Z2-7]{10})$/.exec(text);
  return match ? (match[1] ?? null) : null;
}

/** The guest whose pass the door scanned (XOSGP1:<code>), or none: a pass not on tonight's list. */
export function guestByPassCode(
  guests: readonly DoorGuest[],
  passCode: string,
): DoorGuest | undefined {
  const code = passCode.trim().toUpperCase();
  return guests.find((g) => g.passCode === code);
}

/**
 * The project's door list (app.door_guest_list): approved and checked-in guests, filtered by name, or by the exact
 * pass code (B8).
 */
export async function listDoorGuests(
  db: XosClient,
  projectId: string,
  search?: string | null,
): Promise<Result<DoorGuest[]>> {
  return callRows(
    db,
    "door_guest_list",
    args({ p_project_id: projectId, p_search: search ?? undefined }),
    (r) => ({
      entryId: str(r["guest_list_entry_id"]),
      name: str(r["guest_name"]),
      plusOnes: num(r["plus_ones"]),
      state: str(r["entry_state"]) as DoorGuest["state"],
      note: strOrNull(r["note"]),
      checkedInAt: strOrNull(r["checked_in_at"]),
      plusOnesAdmitted: numOrNull(r["plus_ones_admitted"]),
      door: strOrNull(r["door"]),
      passCode: strOrNull(r["pass_code"]),
      passCategoryCode: strOrNull(r["pass_category_code"]),
      passCategoryName: strOrNull(r["pass_category_name"]),
      tableLabel: strOrNull(r["table_label"]),
      hostPersonId: strOrNull(r["host_person_id"]),
    }),
  );
}

export async function checkInGuest(
  db: XosClient,
  entryId: string,
  input: {
    readonly plusOnesAdmitted?: number;
    readonly door?: string | null;
    readonly credentialNumber?: string | null;
  } = {},
): Promise<Result<{ id: string }>> {
  return callId(
    db,
    "check_in_guest",
    args({
      p_guest_list_entry_id: entryId,
      p_plus_ones_admitted: input.plusOnesAdmitted,
      p_door: input.door ?? undefined,
      p_credential_number: input.credentialNumber ?? undefined,
    }),
  );
}

/** Guests and people through the door so far (guests plus admitted plus-ones). */
export function doorTotals(guests: readonly DoorGuest[]): {
  checkedIn: number;
  expected: number;
  people: number;
} {
  const checked = guests.filter((g) => g.state === "Checked In");
  return {
    checkedIn: checked.length,
    expected: guests.length,
    people: checked.reduce((sum, g) => sum + 1 + (g.plusOnesAdmitted ?? 0), 0),
  };
}

// Lost and found ----------------------------------------------------------------------------------

export interface LostItemClaim {
  readonly id: string;
  readonly claimantName: string;
  readonly claimantContact: string;
  readonly proof: string;
  readonly decidedAt: string | null;
  readonly returned: boolean | null;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface LostItem {
  readonly id: string;
  readonly projectId: string;
  readonly number: string;
  readonly category: LostItemCategory;
  readonly description: string;
  readonly foundAt: string;
  readonly foundLocation: string;
  readonly storageLocation: string | null;
  readonly loggedBy: string | null;
  readonly state: LostItemState;
  readonly claims: readonly LostItemClaim[];
}

export async function listLostItems(db: XosClient, projectId: string): Promise<Result<LostItem[]>> {
  return rows(
    untyped(db)
      .from("lost_found_items")
      .select(
        `id, project_id, item_number, category, description, found_at, found_location, storage_location, item_state,
         logger:memberships(${MEMBER_EMBED}),
         lost_found_claims(id, claimant_name, claimant_contact, proof_description, decided_at, returned, decision_note, created_at)`,
      )
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("found_at", { ascending: false }),
    (r: Raw): LostItem => ({
      id: str(r["id"]),
      projectId: str(r["project_id"]),
      number: str(r["item_number"]),
      category: str(r["category"]) as LostItemCategory,
      description: str(r["description"]),
      foundAt: str(r["found_at"]),
      foundLocation: str(r["found_location"]),
      storageLocation: strOrNull(r["storage_location"]),
      loggedBy: memberName(r["logger"]),
      state: str(r["item_state"]) as LostItemState,
      claims: list(r["lost_found_claims"])
        .map((c) => ({
          id: str(c["id"]),
          claimantName: str(c["claimant_name"]),
          claimantContact: str(c["claimant_contact"]),
          proof: str(c["proof_description"]),
          decidedAt: strOrNull(c["decided_at"]),
          returned: typeof c["returned"] === "boolean" ? c["returned"] : null,
          note: strOrNull(c["decision_note"]),
          createdAt: str(c["created_at"]),
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }),
  );
}

export async function logLostItem(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly category: LostItemCategory;
    readonly description: string;
    readonly foundLocation: string;
    readonly storageLocation?: string | null;
    readonly foundAt?: string | null;
  },
): Promise<Result<{ id: string }>> {
  return callId(db, "log_lost_item", {
    p_project_id: input.projectId,
    p_category: input.category,
    p_description: input.description,
    p_found_location: input.foundLocation,
    ...args({
      p_storage_location: input.storageLocation ?? undefined,
      p_found_at: input.foundAt ?? undefined,
    }),
  });
}

/** Edits the description, category or storage of a logged item. */
export async function updateLostItem(
  db: XosClient,
  id: string,
  input: {
    readonly category: LostItemCategory;
    readonly description: string;
    readonly storageLocation: string | null;
  },
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("lost_found_items")
      .update({
        category: input.category,
        description: input.description,
        storage_location: input.storageLocation,
      })
      .eq("id", id)
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function claimLostItem(
  db: XosClient,
  itemId: string,
  input: {
    readonly claimantName: string;
    readonly claimantContact: string;
    readonly proof: string;
  },
): Promise<Result<{ id: string }>> {
  return callId(db, "claim_lost_item", {
    p_item_id: itemId,
    p_claimant_name: input.claimantName,
    p_claimant_contact: input.claimantContact,
    p_proof_description: input.proof,
  });
}

export async function settleLostItemClaim(
  db: XosClient,
  claimId: string,
  returned: boolean,
  note?: string | null,
): Promise<Result<{ id: string }>> {
  return callId(
    db,
    "settle_lost_item_claim",
    args({ p_claim_id: claimId, p_returned: returned, p_note: note ?? undefined }),
  );
}

export async function disposeLostItem(
  db: XosClient,
  itemId: string,
  reason: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "dispose_lost_item", { p_item_id: itemId, p_reason: reason });
}

// Official weather feed, warnings, forecast and holds (B8, migrations 2976 and 2977) ------------------------------

export interface WeatherFeedStatus {
  /** The official feed covers the venue: it has a location in the US. */
  readonly supported: boolean;
  /** The feed, while it is on. */
  readonly feedId: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly lastError: string | null;
  readonly failuresSinceSuccess: number;
}

export type WeatherWarningSeverity = "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";

/** An official alert, in English as the US National Weather Service issued it. */
export interface WeatherWarning {
  readonly id: string;
  readonly event: string;
  readonly severity: WeatherWarningSeverity;
  readonly headline: string | null;
  readonly description: string | null;
  readonly instruction: string | null;
  readonly onset: string | null;
  readonly endsAt: string | null;
  readonly expiresAt: string | null;
}

export interface WeatherForecastPeriod {
  readonly startsAt: string;
  readonly temperatureF: number | null;
  readonly windSpeedMph: number | null;
  readonly precipitationPercent: number | null;
  readonly shortForecast: string | null;
}

export interface WeatherHold {
  readonly id: string;
  readonly hazard: WeatherHazard | null;
  readonly message: string;
  readonly calledAt: string;
  readonly clearedAt: string | null;
  readonly allClearMessage: string | null;
}

export type WeatherMessageKind = "Hold" | "All Clear";

export interface WeatherFeedBoard {
  readonly status: WeatherFeedStatus;
  /** Active warnings, newest first: not ended. */
  readonly warnings: readonly WeatherWarning[];
  /** The next 12 forecast hours. */
  readonly forecast: readonly WeatherForecastPeriod[];
  /** The open hold, if one is open. */
  readonly openHold: WeatherHold | null;
  /** The project's hold and all-clear texts; the page prefills its catalog default without one. */
  readonly templates: Readonly<Partial<Record<WeatherMessageKind, { id: string; body: string }>>>;
}

/** True when a warning should make Call hold the primary action: a Severe or Extreme alert. */
export function isSevereWarning(warning: Pick<WeatherWarning, "severity">): boolean {
  return warning.severity === "Severe" || warning.severity === "Extreme";
}

/** The official feed's status, active warnings, next 12 hours, open hold and templates of a project. */
export async function getWeatherFeedBoard(
  db: XosClient,
  projectId: string,
  now: Date = new Date(),
): Promise<Result<WeatherFeedBoard>> {
  const [status, warnings, forecast, holds, templates] = await Promise.all([
    callRows(db, "weather_feed_status", { p_project_id: projectId }, (r) => ({
      supported: r["supported"] === true,
      feedId: strOrNull(r["feed_id"]),
      lastSuccessAt: strOrNull(r["last_success_at"]),
      lastFailureAt: strOrNull(r["last_failure_at"]),
      lastError: strOrNull(r["last_error"]),
      failuresSinceSuccess: numOrNull(r["failures_since_success"]) ?? 0,
    })),
    rows(
      untyped(db)
        .from("weather_warnings")
        .select(
          "id, event, severity, headline, description, instruction, onset, ends_at, expires_at",
        )
        .eq("project_id", projectId)
        .is("ended_at", null)
        .order("sent_at", { ascending: false })
        .limit(20),
      (r): WeatherWarning => ({
        id: str(r["id"]),
        event: str(r["event"]),
        severity: str(r["severity"]) as WeatherWarningSeverity,
        headline: strOrNull(r["headline"]),
        description: strOrNull(r["description"]),
        instruction: strOrNull(r["instruction"]),
        onset: strOrNull(r["onset"]),
        endsAt: strOrNull(r["ends_at"]),
        expiresAt: strOrNull(r["expires_at"]),
      }),
    ),
    rows(
      untyped(db)
        .from("weather_forecast_periods")
        .select("starts_at, temperature_f, wind_speed_mph, precipitation_percent, short_forecast")
        .eq("project_id", projectId)
        .gte("ends_at", now.toISOString())
        .order("starts_at")
        .limit(12),
      (r): WeatherForecastPeriod => ({
        startsAt: str(r["starts_at"]),
        temperatureF: numOrNull(r["temperature_f"]),
        windSpeedMph: numOrNull(r["wind_speed_mph"]),
        precipitationPercent: numOrNull(r["precipitation_percent"]),
        shortForecast: strOrNull(r["short_forecast"]),
      }),
    ),
    rows(
      untyped(db)
        .from("weather_holds")
        .select("id, hazard, message, called_at, cleared_at, all_clear_message")
        .eq("project_id", projectId)
        .is("cleared_at", null)
        .limit(1),
      (r): WeatherHold => ({
        id: str(r["id"]),
        hazard: strOrNull(r["hazard"]) as WeatherHazard | null,
        message: str(r["message"]),
        calledAt: str(r["called_at"]),
        clearedAt: strOrNull(r["cleared_at"]),
        allClearMessage: strOrNull(r["all_clear_message"]),
      }),
    ),
    rows(
      untyped(db)
        .from("weather_message_templates")
        .select("id, message_kind, body")
        .eq("project_id", projectId)
        .is("deleted_at", null),
      (r) => ({
        id: str(r["id"]),
        kind: str(r["message_kind"]) as WeatherMessageKind,
        body: str(r["body"]),
      }),
    ),
  ]);
  if (!status.ok) return status;
  if (!warnings.ok) return warnings;
  if (!forecast.ok) return forecast;
  if (!holds.ok) return holds;
  if (!templates.ok) return templates;
  const byKind: Partial<Record<WeatherMessageKind, { id: string; body: string }>> = {};
  for (const tpl of templates.data) byKind[tpl.kind] = { id: tpl.id, body: tpl.body };
  return {
    ok: true,
    data: {
      status: status.data[0] ?? {
        supported: false,
        feedId: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastError: null,
        failuresSinceSuccess: 0,
      },
      warnings: warnings.data,
      forecast: forecast.data,
      openHold: holds.data[0] ?? null,
      templates: byKind,
    },
  };
}

/** Turns the official feed on (safety.emergency_code.write); a venue outside the US refuses weather_feed_unsupported. */
export async function turnOnWeatherFeed(
  db: XosClient,
  projectId: string,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db).from("weather_feeds").insert({ project_id: projectId }).select("id").single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

/** Turns the official feed off: its row is deleted, so the worker stops polling. */
export async function turnOffWeatherFeed(db: XosClient, feedId: string): Promise<Result<null>> {
  const result = await rows(
    untyped(db)
      .from("weather_feeds")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", feedId)
      .is("deleted_at", null)
      .select("id"),
    (r) => str(r["id"]),
  );
  if (!result.ok) return result;
  return result.data.length === 0
    ? { ok: false, error: { kind: "not-found" } }
    : { ok: true, data: null };
}

/**
 * Calls a weather hold (app.call_weather_hold, safety.incident.dispatch): notifies the alert-role people, the
 * dispatchers and everyone present in the project's zones. Refuses weather_hold_open and weather_hold_message. Atlas
 * sends no device time, so a hold called here is never refused as late.
 */
export async function callWeatherHold(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly message: string;
    readonly hazard?: WeatherHazard | null;
    readonly weatherAlertId?: string | null;
    readonly weatherWarningId?: string | null;
  },
): Promise<Result<{ id: string }>> {
  return callId(
    db,
    "call_weather_hold",
    args({
      p_project_id: input.projectId,
      p_message: input.message,
      p_hazard: input.hazard ?? undefined,
      p_weather_alert_id: input.weatherAlertId ?? undefined,
      p_weather_warning_id: input.weatherWarningId ?? undefined,
    }),
  );
}

/** Gives the all-clear on an open hold (app.give_weather_all_clear); refuses weather_hold_closed. */
export async function giveWeatherAllClear(
  db: XosClient,
  holdId: string,
  message: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "give_weather_all_clear", args({ p_hold_id: holdId, p_message: message }));
}

/** Saves the project's hold or all-clear text (safety.emergency_code.write), replacing the one it had. */
export async function saveWeatherTemplate(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly kind: WeatherMessageKind;
    readonly body: string;
    readonly id?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const body = input.body.trim();
  if (body.length === 0 || body.length > 1000)
    return { ok: false, error: { kind: "invalid", message: "body" } };
  if (input.id) {
    return single(
      untyped(db)
        .from("weather_message_templates")
        .update({ body })
        .eq("id", input.id)
        .select("id")
        .single(),
      (r) => ({ id: str(r["id"]) }),
    );
  }
  return single(
    untyped(db)
      .from("weather_message_templates")
      .insert({ project_id: input.projectId, message_kind: input.kind, body })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

// The muster list (B8, migration 2971) ------------------------------------------------------------------------------

export type MusterSource = "Scan" | "Clock In" | "Guest Check In";

/** One person in a zone now, or a guest checked in at a door in the last 24 hours (app.muster_list). */
export interface MusterRow {
  /** The person present; null for a guest. */
  readonly personId: string | null;
  /** The person's or the guest's name. */
  readonly name: string | null;
  readonly guestName: string | null;
  readonly plusOnes: number | null;
  readonly zoneId: string | null;
  readonly credentialCategoryId: string | null;
  readonly engagementId: string | null;
  readonly enteredAt: string;
  readonly source: MusterSource;
  readonly door: string | null;
}

/**
 * The muster list of a project, optionally one zone, read as the caller: scan rows need the project's scan log, clock-in
 * rows its time entries, guest rows both the guest list and the door check-ins. People's names come from
 * app.person_names, as the scan log's do.
 */
export async function listMuster(
  db: XosClient,
  input: { readonly projectId: string; readonly zoneId?: string | null },
): Promise<Result<MusterRow[]>> {
  let query = untyped(db)
    .from("muster_list")
    .select(
      "person_id, guest_name, plus_ones, zone_id, credential_category_id, engagement_id, entered_at, source, door",
    )
    .eq("project_id", input.projectId);
  if (input.zoneId) query = query.eq("zone_id", input.zoneId);
  const result = await rows(query.order("entered_at", { ascending: false }).limit(5000), (r) => ({
    personId: strOrNull(r["person_id"]),
    name: null as string | null,
    guestName: strOrNull(r["guest_name"]),
    plusOnes: numOrNull(r["plus_ones"]),
    zoneId: strOrNull(r["zone_id"]),
    credentialCategoryId: strOrNull(r["credential_category_id"]),
    engagementId: strOrNull(r["engagement_id"]),
    enteredAt: str(r["entered_at"]),
    source: str(r["source"]) as MusterSource,
    door: strOrNull(r["door"]),
  }));
  if (!result.ok) return result;
  const names = await personNames(
    db,
    result.data.map((r) => r.personId),
  );
  return {
    ok: true,
    data: result.data.map((r) => ({
      ...r,
      name: r.personId ? (names.get(r.personId) ?? null) : r.guestName,
    })),
  };
}

/** Muster rows grouped by zone, in the order of the zones given, then the door check-ins (zone null) last. */
export function musterByZone(
  rowsIn: readonly MusterRow[],
  zoneOrder: readonly string[],
): { readonly zoneId: string | null; readonly rows: readonly MusterRow[] }[] {
  const groups = new Map<string | null, MusterRow[]>();
  for (const r of rowsIn) groups.set(r.zoneId, [...(groups.get(r.zoneId) ?? []), r]);
  const rank = (id: string | null) =>
    id === null
      ? Number.MAX_SAFE_INTEGER
      : zoneOrder.indexOf(id) === -1
        ? zoneOrder.length
        : zoneOrder.indexOf(id);
  return [...groups]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([zoneId, list]) => ({
      zoneId,
      rows: [...list].sort((x, y) => (x.name ?? "").localeCompare(y.name ?? "")),
    }));
}

/**
 * Whether the viewer may see a project's muster list: the scan log (credentials.scan_log.read) for scan rows, time
 * entries (crew.time_entry.read) for clock-in rows. With neither the page shows its permission state.
 */
export async function musterAccess(
  db: XosClient,
  projectId: string,
): Promise<Result<{ readonly scans: boolean; readonly clockIns: boolean }>> {
  const result = await call<string[] | null>(db, "my_capabilities_on_project", {
    p_project_id: projectId,
    p_capabilities: ["credentials.scan_log.read", "crew.time_entry.read"],
  });
  if (!result.ok) return result;
  const held = new Set(result.data ?? []);
  return {
    ok: true,
    data: {
      scans: held.has("credentials.scan_log.read"),
      clockIns: held.has("crew.time_entry.read"),
    },
  };
}
