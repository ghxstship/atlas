import type { XosClient } from "./client.ts";
import { Constants, type Database, type Json } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Work Details (Section 4.5.6 item 10, migration 1340, A78): a person's uniform sizes, dietary and
 * accessibility needs, travel profile, emergency contacts and loyalty programs, and the per-engagement
 * consent that shares chosen categories with the engaging org. Every read and write runs as the
 * caller: the owner reads and writes their own rows, an engaging org reads only what was shared
 * through app.shared_work_details, and the passport number is never read except through an audited
 * reveal. Refusals come back as typed errors.
 */

type Enums = Database["app"]["Enums"];
export type WorkDetailCategory = Enums["work_detail_category"];
export type GarmentLetterSize = Enums["garment_letter_size"];
export type DietaryNeed = Enums["dietary_need"];
export type AccessibilityNeed = Enums["accessibility_need"];
export type SeatPreference = Enums["seat_preference"];
export type LoyaltyProgramKind = Enums["loyalty_program_kind"];

export const WORK_DETAIL_CATEGORIES: readonly WorkDetailCategory[] =
  Constants.app.Enums.work_detail_category;
export const GARMENT_LETTER_SIZES: readonly GarmentLetterSize[] =
  Constants.app.Enums.garment_letter_size;
export const DIETARY_NEEDS: readonly DietaryNeed[] = Constants.app.Enums.dietary_need;
export const ACCESSIBILITY_NEEDS: readonly AccessibilityNeed[] =
  Constants.app.Enums.accessibility_need;
export const SEAT_PREFERENCES: readonly SeatPreference[] = Constants.app.Enums.seat_preference;
export const LOYALTY_PROGRAM_KINDS: readonly LoyaltyProgramKind[] =
  Constants.app.Enums.loyalty_program_kind;

/** Refusal rules of migration 1340 that the apps explain with their own sentence. */
export const WORK_DETAIL_RULES = [
  "passport_number_format",
  "passport_number_missing",
  "passport_number_rpc_only",
  "passport_reveal_reason",
  "step_up_required",
  "emergency_contact_limit",
  "loyalty_program_limit",
  "work_detail_share_not_yours",
  "work_detail_share_closed",
  "work_detail_share_categories",
  "work_detail_not_shared",
  "org_read_only",
] as const;

/**
 * The catalog key of an enum label, in camel case: "Emergency Contacts" is `emergencyContacts`,
 * "Step-Free Access" is `stepFreeAccess`. The apps label categories, needs and kinds with it.
 */
export function workDetailLabelKey(label: string): string {
  return label
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) =>
      next ? next.toUpperCase() : "",
    )
    .replace(/^./, (first) => first.toLowerCase());
}

const LOG_KEYS: Readonly<Record<string, string>> = {
  "person_work_details.insert": "detailsCreated",
  "person_work_details.update": "detailsChanged",
  "person_work_details.delete": "detailsRemoved",
  "person_emergency_contacts.insert": "contactAdded",
  "person_emergency_contacts.update": "contactChanged",
  "person_emergency_contacts.delete": "contactRemoved",
  "person_loyalty_programs.insert": "programAdded",
  "person_loyalty_programs.update": "programChanged",
  "person_loyalty_programs.delete": "programRemoved",
  "passport.number_set": "passportSet",
  "passport.number_cleared": "passportCleared",
  "passport.revealed": "passportRevealed",
  "work_details.shared": "shared",
  "work_details.share_changed": "shareChanged",
  "work_details.share_revoked": "shareRevoked",
  "work_details.viewed": "viewed",
  "work_details.erased": "erased",
};

/** The `workDetails.log.actions.*` key of an access log action; unknown actions are `other`. */
export function workDetailLogKey(action: string): string {
  return LOG_KEYS[action] ?? "other";
}

// Work details --------------------------------------------------------------------------------------

export interface UniformSizes {
  readonly shirtSize: GarmentLetterSize | null;
  readonly jacketSize: GarmentLetterSize | null;
  readonly pantsSize: string | null;
  readonly shoeSize: string | null;
  readonly gloveSize: GarmentLetterSize | null;
  readonly hatSize: string | null;
  readonly uniformNotes: string | null;
}

export interface DietaryDetails {
  readonly dietaryNeeds: readonly DietaryNeed[];
  readonly allergies: string | null;
  readonly dietaryNotes: string | null;
}

export interface AccessibilityDetails {
  readonly accessibilityNeeds: readonly AccessibilityNeed[];
  readonly accessibilityNotes: string | null;
}

export interface TravelPreferences {
  readonly seatPreference: SeatPreference | null;
  readonly mealPreference: string | null;
  readonly homeAirport: string | null;
}

export interface PassportDetails {
  /** Always null outside an explicit reveal; the number is Restricted (Section 8.3). */
  readonly passportNumber: null;
  readonly passportNumberLast4: string | null;
  /** A number is recorded and withheld. */
  readonly passportNumberMasked: boolean;
  readonly passportIssuingCountry: string | null;
  readonly passportExpiresOn: string | null;
  readonly passportName: string | null;
}

export interface WorkDetails
  extends UniformSizes, DietaryDetails, AccessibilityDetails, TravelPreferences, PassportDetails {
  readonly id: string;
  readonly personId: string;
  readonly updatedAt: string;
}

const DETAIL_COLUMNS =
  "id, person_id, shirt_size, jacket_size, pants_size, shoe_size, glove_size, hat_size, uniform_notes, dietary_needs, allergies, dietary_notes, accessibility_needs, accessibility_notes, seat_preference, meal_preference, home_airport, passport_number_last4, passport_issuing_country, passport_expires_on, passport_name, updated_at";

type DetailRow = Pick<
  Database["app"]["Tables"]["person_work_details"]["Row"],
  | "id"
  | "person_id"
  | "shirt_size"
  | "jacket_size"
  | "pants_size"
  | "shoe_size"
  | "glove_size"
  | "hat_size"
  | "uniform_notes"
  | "dietary_needs"
  | "allergies"
  | "dietary_notes"
  | "accessibility_needs"
  | "accessibility_notes"
  | "seat_preference"
  | "meal_preference"
  | "home_airport"
  | "passport_number_last4"
  | "passport_issuing_country"
  | "passport_expires_on"
  | "passport_name"
  | "updated_at"
>;

function toWorkDetails(r: DetailRow): WorkDetails {
  return {
    id: r.id,
    personId: r.person_id,
    updatedAt: r.updated_at,
    shirtSize: r.shirt_size,
    jacketSize: r.jacket_size,
    pantsSize: r.pants_size,
    shoeSize: r.shoe_size,
    gloveSize: r.glove_size,
    hatSize: r.hat_size,
    uniformNotes: r.uniform_notes,
    dietaryNeeds: r.dietary_needs,
    allergies: r.allergies,
    dietaryNotes: r.dietary_notes,
    accessibilityNeeds: r.accessibility_needs,
    accessibilityNotes: r.accessibility_notes,
    seatPreference: r.seat_preference,
    mealPreference: r.meal_preference,
    homeAirport: r.home_airport,
    passportNumber: null,
    passportNumberLast4: r.passport_number_last4,
    passportNumberMasked: r.passport_number_last4 !== null,
    passportIssuingCountry: r.passport_issuing_country,
    passportExpiresOn: r.passport_expires_on,
    passportName: r.passport_name,
  };
}

/** The signed-in person's work details, or null before they record any. */
export async function getMyWorkDetails(db: XosClient): Promise<Result<WorkDetails | null>> {
  const { data, error } = await db
    .from("person_work_details")
    .select(DETAIL_COLUMNS)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return ok(data ? toWorkDetails(data as DetailRow) : null);
}

/** Fields the owner writes directly; the passport number goes through `setMyPassportNumber`. */
export type WorkDetailsPatch = Partial<
  UniformSizes &
    DietaryDetails &
    AccessibilityDetails &
    TravelPreferences &
    Omit<PassportDetails, "passportNumber" | "passportNumberLast4" | "passportNumberMasked">
>;

const PATCH_COLUMNS: Readonly<Record<keyof WorkDetailsPatch, string>> = {
  shirtSize: "shirt_size",
  jacketSize: "jacket_size",
  pantsSize: "pants_size",
  shoeSize: "shoe_size",
  gloveSize: "glove_size",
  hatSize: "hat_size",
  uniformNotes: "uniform_notes",
  dietaryNeeds: "dietary_needs",
  allergies: "allergies",
  dietaryNotes: "dietary_notes",
  accessibilityNeeds: "accessibility_needs",
  accessibilityNotes: "accessibility_notes",
  seatPreference: "seat_preference",
  mealPreference: "meal_preference",
  homeAirport: "home_airport",
  passportIssuingCountry: "passport_issuing_country",
  passportExpiresOn: "passport_expires_on",
  passportName: "passport_name",
};

/** Saves the given fields of the signed-in person's work details, creating the row the first time. */
export async function saveMyWorkDetails(
  db: XosClient,
  patch: WorkDetailsPatch,
): Promise<Result<WorkDetails>> {
  const ensured = await db.rpc("ensure_my_work_details");
  if (ensured.error) return fail(toDataError(ensured.error));
  const row: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
    const value = patch[key as keyof WorkDetailsPatch];
    if (value !== undefined) row[column] = value;
  }
  const { data, error } = await db
    .from("person_work_details")
    .update(row as Database["app"]["Tables"]["person_work_details"]["Update"])
    .eq("id", ensured.data)
    .select(DETAIL_COLUMNS)
    .single();
  if (error) return fail(toDataError(error));
  return ok(toWorkDetails(data as DetailRow));
}

/** Sets or clears (null) the signed-in person's passport number; the database encrypts it. */
export async function setMyPassportNumber(
  db: XosClient,
  passportNumber: string | null,
): Promise<Result<null>> {
  const { error } = await db.rpc("set_my_passport_number", {
    p_passport_number: passportNumber as string,
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

/** The owner's explicit reveal of their own passport number; the database logs it. */
export async function revealMyPassportNumber(db: XosClient): Promise<Result<string>> {
  const { data, error } = await db.rpc("reveal_my_passport_number");
  if (error) return fail(toDataError(error));
  return ok(data);
}

// Emergency contacts --------------------------------------------------------------------------------

export interface EmergencyContact {
  readonly id: string;
  readonly fullName: string;
  readonly relationship: string | null;
  /** E.164 (Section 15); the apps show it in national or international format. */
  readonly phoneE164: string;
  readonly alternatePhoneE164: string | null;
  readonly email: string | null;
  readonly sortOrder: number;
}

export interface EmergencyContactInput {
  readonly fullName: string;
  readonly relationship: string | null;
  readonly phoneE164: string;
  readonly alternatePhoneE164: string | null;
  readonly email: string | null;
  readonly sortOrder?: number;
}

const CONTACT_COLUMNS =
  "id, full_name, relationship, phone_e164, alternate_phone_e164, email, sort_order";

type ContactRow = Pick<
  Database["app"]["Tables"]["person_emergency_contacts"]["Row"],
  | "id"
  | "full_name"
  | "relationship"
  | "phone_e164"
  | "alternate_phone_e164"
  | "email"
  | "sort_order"
>;

function toContact(r: ContactRow): EmergencyContact {
  return {
    id: r.id,
    fullName: r.full_name,
    relationship: r.relationship,
    phoneE164: r.phone_e164,
    alternatePhoneE164: r.alternate_phone_e164,
    email: r.email,
    sortOrder: r.sort_order,
  };
}

/** The signed-in person's live emergency contacts, in calling order. */
export async function listMyEmergencyContacts(db: XosClient): Promise<Result<EmergencyContact[]>> {
  const { data, error } = await db
    .from("person_emergency_contacts")
    .select(CONTACT_COLUMNS)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  if (error) return fail(toDataError(error));
  return ok((data as ContactRow[]).map(toContact));
}

export async function addEmergencyContact(
  db: XosClient,
  personId: string,
  input: EmergencyContactInput,
): Promise<Result<string>> {
  const { data, error } = await db
    .from("person_emergency_contacts")
    .insert({
      person_id: personId,
      full_name: input.fullName,
      relationship: input.relationship,
      phone_e164: input.phoneE164,
      alternate_phone_e164: input.alternatePhoneE164,
      email: input.email,
      sort_order: input.sortOrder ?? 0,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok(data.id);
}

export async function updateEmergencyContact(
  db: XosClient,
  id: string,
  input: Partial<EmergencyContactInput>,
): Promise<Result<null>> {
  const row: Database["app"]["Tables"]["person_emergency_contacts"]["Update"] = {
    ...(input.fullName !== undefined ? { full_name: input.fullName } : {}),
    ...(input.relationship !== undefined ? { relationship: input.relationship } : {}),
    ...(input.phoneE164 !== undefined ? { phone_e164: input.phoneE164 } : {}),
    ...(input.alternatePhoneE164 !== undefined
      ? { alternate_phone_e164: input.alternatePhoneE164 }
      : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
  };
  const { data, error } = await db
    .from("person_emergency_contacts")
    .update(row)
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}

export async function removeEmergencyContact(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("person_emergency_contacts")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}

// Loyalty programs ----------------------------------------------------------------------------------

export interface LoyaltyProgram {
  readonly id: string;
  readonly programKind: LoyaltyProgramKind;
  readonly programName: string;
  readonly memberNumber: string;
  readonly sortOrder: number;
}

export interface LoyaltyProgramInput {
  readonly programKind: LoyaltyProgramKind;
  readonly programName: string;
  readonly memberNumber: string;
  readonly sortOrder?: number;
}

type LoyaltyRow = Pick<
  Database["app"]["Tables"]["person_loyalty_programs"]["Row"],
  "id" | "program_kind" | "program_name" | "member_number" | "sort_order"
>;

export async function listMyLoyaltyPrograms(db: XosClient): Promise<Result<LoyaltyProgram[]>> {
  const { data, error } = await db
    .from("person_loyalty_programs")
    .select("id, program_kind, program_name, member_number, sort_order")
    .is("deleted_at", null)
    .order("sort_order")
    .order("program_kind")
    .order("program_name");
  if (error) return fail(toDataError(error));
  return ok(
    (data as LoyaltyRow[]).map((r) => ({
      id: r.id,
      programKind: r.program_kind,
      programName: r.program_name,
      memberNumber: r.member_number,
      sortOrder: r.sort_order,
    })),
  );
}

export async function addLoyaltyProgram(
  db: XosClient,
  personId: string,
  input: LoyaltyProgramInput,
): Promise<Result<string>> {
  const { data, error } = await db
    .from("person_loyalty_programs")
    .insert({
      person_id: personId,
      program_kind: input.programKind,
      program_name: input.programName,
      member_number: input.memberNumber,
      sort_order: input.sortOrder ?? 0,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok(data.id);
}

export async function updateLoyaltyProgram(
  db: XosClient,
  id: string,
  input: Partial<LoyaltyProgramInput>,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("person_loyalty_programs")
    .update({
      ...(input.programKind !== undefined ? { program_kind: input.programKind } : {}),
      ...(input.programName !== undefined ? { program_name: input.programName } : {}),
      ...(input.memberNumber !== undefined ? { member_number: input.memberNumber } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
    })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}

export async function removeLoyaltyProgram(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("person_loyalty_programs")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}

// Sharing -------------------------------------------------------------------------------------------

export interface WorkDetailSharing {
  readonly engagementId: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly projectName: string;
  readonly roleType: Enums["external_role_type"];
  readonly engagementState: Enums["engagement_state"];
  readonly startDate: string;
  readonly endDate: string | null;
  /** The engagement is Onboarding to Closing, so it can take or change a share. */
  readonly sharingOpen: boolean;
  readonly shareId: string | null;
  readonly categories: readonly WorkDetailCategory[];
  readonly sharedAt: string | null;
}

/** The signed-in person's engagements with what each shares, open engagements first. */
export async function listMyWorkDetailSharing(db: XosClient): Promise<Result<WorkDetailSharing[]>> {
  const { data, error } = await db.rpc("my_work_detail_sharing");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      engagementId: r.engagement_id,
      orgId: r.org_id,
      orgName: r.org_name,
      projectName: r.project_name,
      roleType: r.role_type,
      engagementState: r.engagement_state,
      startDate: r.start_date,
      endDate: r.end_date,
      sharingOpen: r.sharing_open,
      shareId: r.work_detail_share_id,
      categories: r.categories,
      sharedAt: r.shared_at,
    })),
  );
}

/** Shares the given categories with one engagement, or replaces what it shares. Returns the share id. */
export async function shareWorkDetails(
  db: XosClient,
  engagementId: string,
  categories: readonly WorkDetailCategory[],
): Promise<Result<string>> {
  const { data, error } = await db.rpc("share_work_details", {
    p_engagement_id: engagementId,
    p_categories: [...categories],
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

export async function revokeWorkDetailShare(db: XosClient, shareId: string): Promise<Result<null>> {
  const { error } = await db.rpc("revoke_work_detail_share", { p_work_detail_share_id: shareId });
  if (error) return fail(toDataError(error));
  return ok(null);
}

// What an engaging org reads ------------------------------------------------------------------------

export interface SharedEmergencyContact {
  readonly fullName: string;
  readonly relationship: string | null;
  readonly phoneE164: string;
  readonly alternatePhoneE164: string | null;
  readonly email: string | null;
}

export interface SharedLoyaltyProgram {
  readonly programKind: LoyaltyProgramKind;
  readonly programName: string;
  readonly memberNumber: string;
}

export interface SharedWorkDetails {
  readonly engagementId: string;
  readonly personId: string | null;
  readonly shareId: string | null;
  readonly sharedAt: string | null;
  /** Engagement is Onboarding to Closing; a closed engagement reads nothing. */
  readonly sharingOpen: boolean;
  /** Categories the person shared. */
  readonly categories: readonly WorkDetailCategory[];
  /** Shared categories the viewer's project capabilities cover; the others come back null. */
  readonly readable: readonly WorkDetailCategory[];
  readonly emergencyContacts: readonly SharedEmergencyContact[] | null;
  readonly uniform: UniformSizes | null;
  readonly dietary: DietaryDetails | null;
  readonly accessibility: AccessibilityDetails | null;
  readonly travel:
    (TravelPreferences & { loyaltyPrograms: readonly SharedLoyaltyProgram[] }) | null;
  readonly passport: PassportDetails | null;
}

type JsonObject = { readonly [key: string]: Json | undefined };

const obj = (v: Json | undefined): JsonObject | null =>
  v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v)
    ? (v as JsonObject)
    : null;
const str = (v: Json | undefined): string | null => (typeof v === "string" ? v : null);
const list = <T>(v: Json | undefined): T[] => (Array.isArray(v) ? (v as unknown as T[]) : []);

/** Parses the jsonb app.shared_work_details returns into camel case. */
export function parseSharedWorkDetails(raw: Json): SharedWorkDetails {
  const d = obj(raw) ?? {};
  const uniform = obj(d["uniform"]);
  const dietary = obj(d["dietary"]);
  const accessibility = obj(d["accessibility"]);
  const travel = obj(d["travel"]);
  const passport = obj(d["passport"]);
  const contacts = d["emergency_contacts"];
  return {
    engagementId: str(d["engagement_id"]) ?? "",
    personId: str(d["person_id"]),
    shareId: str(d["work_detail_share_id"]),
    sharedAt: str(d["shared_at"]),
    sharingOpen: d["sharing_open"] === true,
    categories: list<WorkDetailCategory>(d["categories"]),
    readable: list<WorkDetailCategory>(d["readable"]),
    emergencyContacts: Array.isArray(contacts)
      ? contacts.map((c) => {
          const o = obj(c) ?? {};
          return {
            fullName: str(o["full_name"]) ?? "",
            relationship: str(o["relationship"]),
            phoneE164: str(o["phone_e164"]) ?? "",
            alternatePhoneE164: str(o["alternate_phone_e164"]),
            email: str(o["email"]),
          };
        })
      : null,
    uniform: uniform
      ? {
          shirtSize: str(uniform["shirt_size"]) as GarmentLetterSize | null,
          jacketSize: str(uniform["jacket_size"]) as GarmentLetterSize | null,
          pantsSize: str(uniform["pants_size"]),
          shoeSize: str(uniform["shoe_size"]),
          gloveSize: str(uniform["glove_size"]) as GarmentLetterSize | null,
          hatSize: str(uniform["hat_size"]),
          uniformNotes: str(uniform["uniform_notes"]),
        }
      : null,
    dietary: dietary
      ? {
          dietaryNeeds: list<DietaryNeed>(dietary["dietary_needs"]),
          allergies: str(dietary["allergies"]),
          dietaryNotes: str(dietary["dietary_notes"]),
        }
      : null,
    accessibility: accessibility
      ? {
          accessibilityNeeds: list<AccessibilityNeed>(accessibility["accessibility_needs"]),
          accessibilityNotes: str(accessibility["accessibility_notes"]),
        }
      : null,
    travel: travel
      ? {
          seatPreference: str(travel["seat_preference"]) as SeatPreference | null,
          mealPreference: str(travel["meal_preference"]),
          homeAirport: str(travel["home_airport"]),
          loyaltyPrograms: list<JsonObject>(travel["loyalty_programs"]).map((l) => ({
            programKind: str(l["program_kind"]) as LoyaltyProgramKind,
            programName: str(l["program_name"]) ?? "",
            memberNumber: str(l["member_number"]) ?? "",
          })),
        }
      : null,
    passport: passport
      ? {
          passportNumber: null,
          passportNumberLast4: str(passport["passport_number_last4"]),
          passportNumberMasked: passport["passport_number_masked"] === true,
          passportIssuingCountry: str(passport["passport_issuing_country"]),
          passportExpiresOn: str(passport["passport_expires_on"]),
          passportName: str(passport["passport_name"]),
        }
      : null,
  };
}

/** What the engagement's person shared, as the viewer may read it. Each read is logged. */
export async function getSharedWorkDetails(
  db: XosClient,
  engagementId: string,
): Promise<Result<SharedWorkDetails>> {
  const { data, error } = await db.rpc("shared_work_details", { p_engagement_id: engagementId });
  if (error) return fail(toDataError(error));
  return ok(parseSharedWorkDetails(data));
}

/** The org's audited reveal of a shared passport number: needs step-up and a reason. */
export async function revealSharedPassportNumber(
  db: XosClient,
  engagementId: string,
  reason: string,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("reveal_shared_passport_number", {
    p_engagement_id: engagementId,
    p_reason: reason,
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

// Access log ----------------------------------------------------------------------------------------

export interface WorkDetailEvent {
  readonly id: string;
  readonly action: string;
  readonly actorPersonId: string | null;
  readonly orgId: string | null;
  readonly engagementId: string | null;
  readonly categories: readonly WorkDetailCategory[];
  readonly changedColumns: readonly string[];
  readonly reason: string | null;
  readonly createdAt: string;
}

/** The signed-in person's work details access log, newest first. */
export async function listMyWorkDetailEvents(
  db: XosClient,
  personId: string,
  limit = 50,
): Promise<Result<WorkDetailEvent[]>> {
  const { data, error } = await db
    .from("work_detail_events")
    .select(
      "id, action, actor_person_id, org_id, engagement_id, categories, changed_columns, reason, created_at",
    )
    .eq("person_id", personId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      action: r.action,
      actorPersonId: r.actor_person_id,
      orgId: r.org_id,
      engagementId: r.engagement_id,
      categories: r.categories,
      changedColumns: r.changed_columns,
      reason: r.reason,
      createdAt: r.created_at,
    })),
  );
}

// Section 15 names --------------------------------------------------------------------------------------

export interface NameParts {
  readonly fullName: string | null;
  readonly givenName: string | null;
  readonly familyName: string | null;
}

/** The signed-in person's full name and optional given and family names. */
export async function getMyNameParts(db: XosClient, personId: string): Promise<Result<NameParts>> {
  const { data, error } = await db
    .from("people")
    .select("full_name, given_name, family_name")
    .eq("id", personId)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok({ fullName: data.full_name, givenName: data.given_name, familyName: data.family_name });
}

/** Sets or clears (null) the signed-in person's given and family names; the full name is untouched. */
export async function saveMyNameParts(
  db: XosClient,
  personId: string,
  parts: { readonly givenName: string | null; readonly familyName: string | null },
): Promise<Result<null>> {
  const { data, error } = await db
    .from("people")
    .update({ given_name: parts.givenName, family_name: parts.familyName })
    .eq("id", personId)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}
