import type { Database, XosClient } from "./client.ts";
import { Constants, type Json } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import type { GarmentLetterSize, SeatPreference } from "./work-details.ts";

/**
 * Project facts on a roster entry (R5, migrations 2654 to 2657, ADR 0102), imported as `@xos/data/roster-facts`. The
 * rostered person enters a travel request, uniform sizes and a vehicle for one project, each only while its offering
 * is on; the company that rosters them may enter them on their behalf when the project allows it. Facts never reach the
 * profile and leave keep_days after the engagement closes.
 *
 * Values are read only through app.roster_project_facts and its bulk and travel-party forms, which log every read by
 * anyone but the person. app.roster_project_fact_status carries presence flags only and is not logged. Nothing here is
 * exported, searched, synced or queued offline.
 */

type Enums = Database["app"]["Enums"];
export type ProjectFactKind = Enums["project_fact_kind"];
export type ShoeSizeSystem = Enums["shoe_size_system"];
export type ProjectFactStanding = "Person" | "Company" | "Producer";

export const PROJECT_FACT_KINDS: readonly ProjectFactKind[] = Constants.app.Enums.project_fact_kind;
export const SHOE_SIZE_SYSTEMS: readonly ShoeSizeSystem[] = Constants.app.Enums.shoe_size_system;

/** Refusal rules of the project fact RPCs; the apps label each with `workDetails.errors.<rule>`. */
export const ROSTER_FACT_RULES = [
  "project_fact_not_yours",
  "roster_entry_withdrawn",
  "roster_entry_declined",
  "project_fact_closed",
  "org_read_only",
  "offering_not_offered",
  "project_fact_company_write_off",
  "project_fact_person_entered",
  "airport_unknown",
  "travel_dates_order",
  "project_fact_empty",
  "project_fact_text_length",
  "shoe_size_format",
  "shoe_size_system_required",
  "pants_measure_range",
  "vehicle_fields_required",
  "plate_format",
  "plate_region_format",
  "project_fact_kind_required",
] as const;
export type RosterFactRule = (typeof ROSTER_FACT_RULES)[number];

export interface RosterTravelRequest {
  readonly inboundAirportCode: string | null;
  readonly inboundAirportName: string | null;
  readonly outboundAirportCode: string | null;
  readonly outboundAirportName: string | null;
  readonly inboundOn: string | null;
  readonly outboundOn: string | null;
  readonly seatPreference: SeatPreference | null;
  readonly mealPreference: string | null;
  readonly needsGroundTransport: boolean;
  readonly needsLodging: boolean;
  readonly travelNotes: string | null;
  readonly updatedAt: string | null;
}

export interface RosterUniformSizes {
  readonly shirtSize: GarmentLetterSize | null;
  readonly jacketSize: GarmentLetterSize | null;
  readonly pantsSize: GarmentLetterSize | null;
  readonly gloveSize: GarmentLetterSize | null;
  readonly hatSize: GarmentLetterSize | null;
  readonly pantsWaistIn: number | null;
  readonly pantsInseamIn: number | null;
  readonly shoeSize: number | null;
  readonly shoeSizeSystem: ShoeSizeSystem | null;
  readonly updatedAt: string | null;
}

export interface RosterVehicle {
  readonly make: string;
  readonly model: string;
  readonly color: string | null;
  readonly plate: string;
  readonly plateRegion: string;
  readonly updatedAt: string | null;
}

type ByKind<T> = { readonly travel: T; readonly uniform: T; readonly vehicle: T };

/** The project facts of one roster entry as the caller may read them. */
export interface RosterProjectFacts {
  readonly rosterEntryId: string;
  readonly engagementId: string;
  readonly orgId: string;
  readonly personId: string | null;
  readonly standing: ProjectFactStanding;
  readonly offered: {
    readonly travel: boolean;
    readonly lodging: boolean;
    readonly uniforms: boolean;
    readonly parking: boolean;
  };
  readonly present: ByKind<boolean>;
  readonly enteredByPerson: ByKind<boolean>;
  readonly readable: readonly ProjectFactKind[];
  readonly travel: RosterTravelRequest | null;
  readonly uniform: RosterUniformSizes | null;
  readonly vehicle: RosterVehicle | null;
}

/** Presence of project facts on one entry: no value, so reading it is not logged. */
export interface RosterFactStatus {
  readonly rosterEntryId: string;
  readonly offered: RosterProjectFacts["offered"];
  readonly present: ByKind<boolean>;
  readonly enteredByPerson: ByKind<boolean>;
}

/** What a status chip shows for a kind: On file, Missing, or Not offered. */
export type RosterFactChip = "onFile" | "missing" | "notOffered";

const OFFERING_OF: Readonly<Record<keyof ByKind<boolean>, keyof RosterProjectFacts["offered"]>> = {
  travel: "travel",
  uniform: "uniforms",
  vehicle: "parking",
};

export function rosterFactChip(
  status: Pick<RosterFactStatus, "offered" | "present">,
  kind: keyof ByKind<boolean>,
): RosterFactChip {
  if (!status.offered[OFFERING_OF[kind]]) return "notOffered";
  return status.present[kind] ? "onFile" : "missing";
}

/** The kinds a person is asked for on an entry: those whose offering is on. */
export function offeredFactKinds(offered: RosterProjectFacts["offered"]): ProjectFactKind[] {
  return [
    ...(offered.travel ? (["Travel"] as const) : []),
    ...(offered.uniforms ? (["Uniform"] as const) : []),
    ...(offered.parking ? (["Vehicle"] as const) : []),
  ];
}

// Parsing ------------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : null;
const bool = (v: unknown): boolean => v === true;
const obj = (v: unknown): Obj | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;

export function parseTravel(v: unknown): RosterTravelRequest | null {
  const o = obj(v);
  if (!o) return null;
  return {
    inboundAirportCode: str(o["inbound_airport_code"])?.trim() ?? null,
    inboundAirportName: str(o["inbound_airport_name"]),
    outboundAirportCode: str(o["outbound_airport_code"])?.trim() ?? null,
    outboundAirportName: str(o["outbound_airport_name"]),
    inboundOn: str(o["inbound_on"]),
    outboundOn: str(o["outbound_on"]),
    seatPreference: str(o["seat_preference"]) as SeatPreference | null,
    mealPreference: str(o["meal_preference"]),
    needsGroundTransport: bool(o["needs_ground_transport"]),
    needsLodging: bool(o["needs_lodging"]),
    travelNotes: str(o["travel_notes"]),
    updatedAt: str(o["updated_at"]),
  };
}

export function parseUniform(v: unknown): RosterUniformSizes | null {
  const o = obj(v);
  if (!o) return null;
  return {
    shirtSize: str(o["shirt_size"]) as GarmentLetterSize | null,
    jacketSize: str(o["jacket_size"]) as GarmentLetterSize | null,
    pantsSize: str(o["pants_size"]) as GarmentLetterSize | null,
    gloveSize: str(o["glove_size"]) as GarmentLetterSize | null,
    hatSize: str(o["hat_size"]) as GarmentLetterSize | null,
    pantsWaistIn: num(o["pants_waist_in"]),
    pantsInseamIn: num(o["pants_inseam_in"]),
    shoeSize: num(o["shoe_size"]),
    shoeSizeSystem: str(o["shoe_size_system"]) as ShoeSizeSystem | null,
    updatedAt: str(o["updated_at"]),
  };
}

export function parseVehicle(v: unknown): RosterVehicle | null {
  const o = obj(v);
  if (!o) return null;
  return {
    make: str(o["make"]) ?? "",
    model: str(o["model"]) ?? "",
    color: str(o["color"]),
    plate: str(o["plate"]) ?? "",
    plateRegion: str(o["plate_region"]) ?? "",
    updatedAt: str(o["updated_at"]),
  };
}

const byKind = (v: unknown): ByKind<boolean> => {
  const o = obj(v) ?? {};
  return { travel: bool(o["travel"]), uniform: bool(o["uniform"]), vehicle: bool(o["vehicle"]) };
};

const offerings = (v: unknown): RosterProjectFacts["offered"] => {
  const o = obj(v) ?? {};
  return {
    travel: bool(o["travel"]),
    lodging: bool(o["lodging"]),
    uniforms: bool(o["uniforms"]),
    parking: bool(o["parking"]),
  };
};

export function parseRosterProjectFacts(v: Json | unknown): RosterProjectFacts | null {
  const o = obj(v);
  if (!o) return null;
  const readable = Array.isArray(o["readable"])
    ? (o["readable"] as unknown[]).filter((k): k is ProjectFactKind =>
        (PROJECT_FACT_KINDS as readonly unknown[]).includes(k),
      )
    : [];
  return {
    rosterEntryId: str(o["roster_entry_id"]) ?? "",
    engagementId: str(o["engagement_id"]) ?? "",
    orgId: str(o["org_id"]) ?? "",
    personId: str(o["person_id"]),
    standing: (str(o["standing"]) ?? "Producer") as ProjectFactStanding,
    offered: offerings(o["offered"]),
    present: byKind(o["present"]),
    enteredByPerson: byKind(o["entered_by_person"]),
    readable,
    travel: parseTravel(o["travel"]),
    uniform: parseUniform(o["uniform"]),
    vehicle: parseVehicle(o["vehicle"]),
  };
}

// Reads --------------------------------------------------------------------------------------------------------------

/** One entry's facts; logged for a company or producer reader. Not-found without standing. */
export async function getRosterProjectFacts(
  db: XosClient,
  rosterEntryId: string,
): Promise<Result<RosterProjectFacts>> {
  const { data, error } = await db.rpc("roster_project_facts", {
    p_roster_entry_id: rosterEntryId,
  });
  if (error) {
    if (error.code === "42501") return fail({ kind: "not-found" });
    return fail(toDataError(error));
  }
  const facts = parseRosterProjectFacts(data);
  return facts ? ok(facts) : fail({ kind: "not-found" });
}

/** The facts of every entry of an engagement the caller has standing on; one logged read per entry. */
export async function listRosterProjectFacts(
  db: XosClient,
  engagementId: string,
): Promise<Result<RosterProjectFacts[]>> {
  const { data, error } = await db.rpc("roster_project_facts_for_engagement", {
    p_engagement_id: engagementId,
  });
  if (error) return fail(toDataError(error));
  return ok(
    ((data ?? []) as unknown[])
      .map(parseRosterProjectFacts)
      .filter((f): f is RosterProjectFacts => f !== null),
  );
}

/** Presence flags per entry of an engagement; not logged. */
export async function listRosterFactStatus(
  db: XosClient,
  engagementId: string,
): Promise<Result<RosterFactStatus[]>> {
  const { data, error } = await db.rpc("roster_project_fact_status", {
    p_engagement_id: engagementId,
  });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      rosterEntryId: r.roster_entry_id,
      offered: {
        travel: r.travel_offered,
        lodging: r.lodging_offered,
        uniforms: r.uniforms_offered,
        parking: r.parking_offered,
      },
      present: { travel: r.has_travel, uniform: r.has_uniform, vehicle: r.has_vehicle },
      enteredByPerson: {
        travel: r.travel_entered_by_person,
        uniform: r.uniform_entered_by_person,
        vehicle: r.vehicle_entered_by_person,
      },
    })),
  );
}

export type PreviousRosterFacts =
  | { readonly kind: "Travel"; readonly value: RosterTravelRequest | null }
  | { readonly kind: "Uniform"; readonly value: RosterUniformSizes | null }
  | { readonly kind: "Vehicle"; readonly value: RosterVehicle | null };

/** The caller's last values of a kind on any of their entries, as an unsaved pre-fill; null when none. */
export async function getMyPreviousRosterFacts(
  db: XosClient,
  kind: ProjectFactKind,
): Promise<Result<PreviousRosterFacts>> {
  const { data, error } = await db.rpc("my_previous_roster_facts", { p_kind: kind });
  if (error) return fail(toDataError(error));
  if (kind === "Travel") return ok({ kind, value: parseTravel(data) });
  if (kind === "Uniform") return ok({ kind, value: parseUniform(data) });
  return ok({ kind, value: parseVehicle(data) });
}

export interface Airport {
  readonly iataCode: string;
  readonly name: string;
  readonly municipality: string | null;
  readonly countryCode: string;
}

/** Active airports for a query: an exact IATA code first, then names and cities containing it; at most `limit`. */
export async function searchAirports(
  db: XosClient,
  query: string,
  limit = 20,
): Promise<Result<Airport[]>> {
  const q = query.trim();
  if (q === "") return ok([]);
  const toAirport = (r: {
    iata_code: string;
    name: string;
    municipality: string | null;
    country_code: string;
  }) => ({
    iataCode: r.iata_code.trim(),
    name: r.name,
    municipality: r.municipality,
    countryCode: r.country_code.trim(),
  });
  const out: Airport[] = [];
  if (/^[A-Za-z]{3}$/.test(q)) {
    const exact = await db
      .from("airports")
      .select("iata_code, name, municipality, country_code")
      .eq("iata_code", q.toUpperCase())
      .maybeSingle();
    if (exact.error) return fail(toDataError(exact.error));
    if (exact.data) out.push(toAirport(exact.data));
  }
  // PostgREST or-filters take commas and parentheses as syntax, so they are dropped from the pattern.
  const pattern = `%${q.replace(/[%_,()]/g, " ")}%`;
  const { data, error } = await db
    .from("airports")
    .select("iata_code, name, municipality, country_code")
    .or(`name.ilike.${pattern},municipality.ilike.${pattern}`)
    .order("name")
    .limit(limit);
  if (error) return fail(toDataError(error));
  for (const row of data ?? []) {
    const airport = toAirport(row);
    if (!out.some((a) => a.iataCode === airport.iataCode)) out.push(airport);
  }
  return ok(out.slice(0, limit));
}

// Writes -------------------------------------------------------------------------------------------------------------

export interface RosterTravelInput {
  readonly inboundAirportCode: string | null;
  readonly outboundAirportCode: string | null;
  readonly inboundOn: string | null;
  readonly outboundOn: string | null;
  readonly seatPreference: SeatPreference | null;
  readonly mealPreference: string | null;
  readonly needsGroundTransport: boolean;
  readonly needsLodging: boolean;
  readonly travelNotes: string | null;
}

export interface RosterUniformInput {
  readonly shirtSize: GarmentLetterSize | null;
  readonly jacketSize: GarmentLetterSize | null;
  readonly pantsSize: GarmentLetterSize | null;
  readonly gloveSize: GarmentLetterSize | null;
  readonly hatSize: GarmentLetterSize | null;
  readonly pantsWaistIn: number | null;
  readonly pantsInseamIn: number | null;
  readonly shoeSize: number | null;
  readonly shoeSizeSystem: ShoeSizeSystem | null;
}

export interface RosterVehicleInput {
  readonly make: string;
  readonly model: string;
  readonly color: string | null;
  readonly plate: string;
  readonly plateRegion: string;
}

// The RPCs take every argument, so a cleared value is sent as null.
const nul = <T>(v: T | null): T => v as T;

export async function saveRosterTravelRequest(
  db: XosClient,
  rosterEntryId: string,
  input: RosterTravelInput,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("save_roster_travel_request", {
    p_roster_entry_id: rosterEntryId,
    p_inbound_airport_code: nul(input.inboundAirportCode),
    p_outbound_airport_code: nul(input.outboundAirportCode),
    p_inbound_on: nul(input.inboundOn),
    p_outbound_on: nul(input.outboundOn),
    p_seat_preference: nul(input.seatPreference),
    p_meal_preference: nul(input.mealPreference),
    p_needs_ground_transport: input.needsGroundTransport,
    p_needs_lodging: input.needsLodging,
    p_travel_notes: nul(input.travelNotes),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

export async function saveRosterUniformSizes(
  db: XosClient,
  rosterEntryId: string,
  input: RosterUniformInput,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("save_roster_uniform_sizes", {
    p_roster_entry_id: rosterEntryId,
    p_shirt_size: nul(input.shirtSize),
    p_jacket_size: nul(input.jacketSize),
    p_pants_size: nul(input.pantsSize),
    p_glove_size: nul(input.gloveSize),
    p_hat_size: nul(input.hatSize),
    p_pants_waist_in: nul(input.pantsWaistIn),
    p_pants_inseam_in: nul(input.pantsInseamIn),
    p_shoe_size: nul(input.shoeSize),
    p_shoe_size_system: nul(input.shoeSizeSystem),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

export async function saveRosterVehicle(
  db: XosClient,
  rosterEntryId: string,
  input: RosterVehicleInput,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("save_roster_vehicle", {
    p_roster_entry_id: rosterEntryId,
    p_make: input.make,
    p_model: input.model,
    p_color: nul(input.color),
    p_plate: input.plate,
    p_plate_region: input.plateRegion,
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

export async function clearRosterProjectFact(
  db: XosClient,
  rosterEntryId: string,
  kind: ProjectFactKind,
): Promise<Result<null>> {
  const { error } = await db.rpc("clear_roster_project_fact", {
    p_roster_entry_id: rosterEntryId,
    p_kind: kind,
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

// The travel party (G-175) ---------------------------------------------------------------------------------------------

export interface TravelPartyMember {
  readonly rosterEntryId: string;
  readonly engagementId: string;
  readonly partyName: string | null;
  readonly personId: string;
  readonly personName: string | null;
  readonly roleCode: string | null;
  readonly arrivalStartsAt: string | null;
  readonly arrivalEndsAt: string | null;
  readonly arrivalTimeZone: string | null;
  readonly travel: RosterTravelRequest | null;
  readonly room: {
    readonly assigned: boolean;
    readonly checkInOn: string | null;
    readonly checkOutOn: string | null;
    readonly blockName: string | null;
  };
  readonly pickupBooked: boolean;
  /** Null when the reader does not hold credentials.credential.read. */
  readonly passIssued: boolean | null;
}

/** The travel party of a project with what hospitality has arranged; every travel value returned is logged. */
export async function listRosterTravelParty(
  db: XosClient,
  projectId: string,
): Promise<Result<TravelPartyMember[]>> {
  const { data, error } = await db.rpc("roster_travel_party", { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  return ok(
    ((data ?? []) as unknown[]).map((v) => {
      const o = obj(v) ?? {};
      const room = obj(o["room"]) ?? {};
      const pass = obj(o["pass"]);
      return {
        rosterEntryId: str(o["roster_entry_id"]) ?? "",
        engagementId: str(o["engagement_id"]) ?? "",
        partyName: str(o["party_name"]),
        personId: str(o["person_id"]) ?? "",
        personName: str(o["person_name"]),
        roleCode: str(o["role_code"]),
        arrivalStartsAt: str(o["arrival_starts_at"]),
        arrivalEndsAt: str(o["arrival_ends_at"]),
        arrivalTimeZone: str(o["arrival_time_zone"]),
        travel: parseTravel(o["travel"]),
        room: {
          assigned: bool(room["assigned"]),
          checkInOn: str(room["check_in_on"]),
          checkOutOn: str(room["check_out_on"]),
          blockName: str(room["block_name"]),
        },
        pickupBooked: bool(obj(o["pickup"])?.["booked"]),
        passIssued: pass ? bool(pass["issued"]) : null,
      };
    }),
  );
}

export interface TravelDayCount {
  readonly day: string;
  readonly arriving: number;
  readonly departing: number;
  readonly onSite: number;
  readonly roomsNeeded: number;
  readonly pickupsNeeded: number;
  readonly truncated: boolean;
}

/** Daily counts of a project's travel party, at most 120 days; each call is logged. */
export async function listRosterTravelDayCounts(
  db: XosClient,
  projectId: string,
): Promise<Result<TravelDayCount[]>> {
  const { data, error } = await db.rpc("roster_travel_day_counts", { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      day: r.day,
      arriving: r.arriving,
      departing: r.departing,
      onSite: r.on_site,
      roomsNeeded: r.rooms_needed,
      pickupsNeeded: r.pickups_needed,
      truncated: r.truncated,
    })),
  );
}
