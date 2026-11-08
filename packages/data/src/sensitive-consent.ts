import type { XosClient } from "./client.ts";
import { Constants, type Database, type Json } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Consent for sensitive data (ADR 0164, migrations 6850 to 6853): allergies, dietary needs, accessibility needs and
 * supplier diversity status are saved only under a standing consent, or an attestation when someone else enters them.
 * The database refuses a new value without one (`sensitive_consent_required`), so the apps show the step before the
 * first save and the API, imports and direct writes meet the same rule. Withdrawing stops use and clears the values.
 *
 * The wording lives in `workDetails.consent.notices` of the en-US and es-US catalogs. Each version's hash is in
 * private.sensitive_notice_versions, and a test fails when the wording changes without a new version.
 */

type Enums = Database["app"]["Enums"];
export type SensitiveCategory = Enums["sensitive_data_category"];
export type SensitiveSurface = Enums["sensitive_consent_surface"];
export type SensitiveStanding = Enums["sensitive_consent_standing"];

export const SENSITIVE_CATEGORIES: readonly SensitiveCategory[] =
  Constants.app.Enums.sensitive_data_category;
export const SENSITIVE_STANDINGS: readonly SensitiveStanding[] =
  Constants.app.Enums.sensitive_consent_standing;

/** The catalog key of a category's notice, `workDetails.consent.notices.<key>`. */
export const SENSITIVE_NOTICE_KEYS: Readonly<Record<SensitiveCategory, string>> = {
  "Dietary and Allergies": "dietary",
  Accessibility: "accessibility",
  "Supplier Diversity": "diversity",
};

/** The version of the wording each category shows now. Changing the wording needs a new version here and in the database. */
export const SENSITIVE_NOTICE_VERSIONS: Readonly<Record<SensitiveCategory, string>> = {
  "Dietary and Allergies": "2026-11-06",
  Accessibility: "2026-11-06",
  "Supplier Diversity": "2026-11-06",
};

/** Refusals of migrations 6850 to 6852 the apps explain with their own sentence. */
export const SENSITIVE_CONSENT_RULES = [
  "sensitive_consent_required",
  "sensitive_notice_version",
  "sensitive_notice_locale",
  "sensitive_attestation_required",
  "sensitive_person_only",
  "sensitive_entry_not_yours",
  "sensitive_entry_not_guest",
  "sensitive_consent_category",
  "guest_needs_declined",
] as const;

/**
 * The exact text a version's hash covers: the notice's keys in order, as compact UTF-8 JSON. The notice holds everything
 * a person reads or ticks: what a person consents to, and what someone attesting for them reads and states.
 */
export function canonicalNotice(notice: Readonly<Record<string, string>>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(notice).sort()) sorted[key] = notice[key] as string;
  return JSON.stringify(sorted);
}

export interface StandingConsent {
  readonly category: SensitiveCategory;
  readonly noticeVersion: string;
  readonly givenAt: string;
}

/** The standing grants of the signed-in person, or of a company they are an Owner or Admin of. */
export async function listMySensitiveConsents(
  db: XosClient,
  accountId: string | null = null,
): Promise<Result<StandingConsent[]>> {
  const { data, error } = await db.rpc(
    "my_sensitive_consents",
    accountId ? { p_account_id: accountId } : {},
  );
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((row) => ({
      category: row.category,
      noticeVersion: row.notice_version,
      givenAt: row.given_at,
    })),
  );
}

/** A category with a value of the person's that no own grant covers (app.my_sensitive_states). */
export interface SensitiveState {
  readonly category: SensitiveCategory;
  /** From before consent was recorded: hidden from everyone else, and cleared 30 days after they are told unless they agree. */
  readonly waiting: boolean;
  /** They withdrew, and a legal hold keeps it hidden until it ends. */
  readonly held: boolean;
  /** Meal preferences on their roster entries that no grant covers. */
  readonly mealPreferences: readonly string[];
}

export async function listMySensitiveStates(
  db: XosClient,
  accountId: string | null = null,
): Promise<Result<SensitiveState[]>> {
  const { data, error } = await db.rpc(
    "my_sensitive_states",
    accountId ? { p_account_id: accountId } : {},
  );
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((row) => ({
      category: row.category,
      waiting: row.waiting,
      held: row.held,
      mealPreferences: row.meal_preferences,
    })),
  );
}

/** What a category's section shows: the form under a standing grant, or the step, worded for what is on file. */
export type SensitiveStep = "form" | "first" | "waiting" | "held";

export function sensitiveStepFor(
  category: SensitiveCategory,
  consents: readonly StandingConsent[],
  states: readonly SensitiveState[],
): SensitiveStep {
  if (consents.some((c) => c.category === category)) return "form";
  const state = states.find((s) => s.category === category);
  if (state?.waiting) return "waiting";
  return state?.held ? "held" : "first";
}

/** The meal preferences no grant covers, for the step to show the person what it is about. */
export function ungrantedMealPreferences(states: readonly SensitiveState[]): readonly string[] {
  return states.find((s) => s.category === "Dietary and Allergies")?.mealPreferences ?? [];
}

/** A category's standing grant among those read, or null. */
export function standingFor(
  consents: readonly StandingConsent[],
  category: SensitiveCategory,
): StandingConsent | null {
  return consents.find((c) => c.category === category) ?? null;
}

export interface GiveConsentInput {
  readonly category: SensitiveCategory;
  readonly locale: string;
  readonly surface: SensitiveSurface;
  /** For a company's supplier diversity status: the account, and the two statements of whoever declares it. */
  readonly accountId?: string | null;
  readonly authorityConfirmed?: boolean;
  readonly noticeConfirmed?: boolean;
  /** The address the platform server saw, on the web apps, whose request to the database carries their own. */
  readonly clientIp?: string | null;
}

/** Records the signed-in person's consent, or a company's attestation, with the version and language shown. */
export async function giveSensitiveConsent(
  db: XosClient,
  input: GiveConsentInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("give_sensitive_consent", {
    p_category: input.category,
    p_notice_version: SENSITIVE_NOTICE_VERSIONS[input.category],
    p_locale: input.locale,
    p_surface: input.surface,
    ...(input.accountId ? { p_account_id: input.accountId } : {}),
    ...(input.authorityConfirmed ? { p_authority_confirmed: true } : {}),
    ...(input.noticeConfirmed ? { p_notice_confirmed: true } : {}),
    ...(input.clientIp ? { p_client_ip: input.clientIp } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/**
 * Withdraws a category in one call: use stops at once and the values are cleared. `erased` is false when a legal hold
 * reaches the person, so the values stay hidden until it ends.
 */
export async function withdrawSensitiveConsent(
  db: XosClient,
  category: SensitiveCategory,
  accountId: string | null = null,
): Promise<Result<{ erased: boolean }>> {
  const { data, error } = await db.rpc("withdraw_sensitive_consent", {
    p_category: category,
    ...(accountId ? { p_account_id: accountId } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ erased: data !== false });
}

// What someone else entered about the person -----------------------------------------------------------------------

export interface SensitiveEntryAboutMe {
  readonly consentId: string;
  readonly category: SensitiveCategory;
  readonly givenByName: string | null;
  readonly orgName: string | null;
  readonly guestName: string | null;
  readonly givenAt: string;
  /** The values, for a guest list entry; null for a roster meal preference, which the person sees on the roster entry. */
  readonly details: Json | null;
}

export async function listSensitiveEntriesAboutMe(
  db: XosClient,
): Promise<Result<SensitiveEntryAboutMe[]>> {
  const { data, error } = await db.rpc("sensitive_entries_about_me");
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((row) => ({
      consentId: row.consent_id,
      category: row.category,
      givenByName: row.given_by_name,
      orgName: row.org_name,
      guestName: row.guest_name,
      givenAt: row.given_at,
      details: row.details,
    })),
  );
}

export async function removeSensitiveEntry(
  db: XosClient,
  consentId: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("remove_sensitive_entry", { p_consent_id: consentId });
  return error ? fail(toDataError(error)) : ok(null);
}

/**
 * The person a guest list entry names by their email says the guest is someone else: their name and email come off it, the
 * guest's needs stay with whoever keeps the list, and the entry never names them again. Only for a guest list entry.
 */
export async function disownSensitiveEntry(
  db: XosClient,
  consentId: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("disown_sensitive_entry", { p_consent_id: consentId });
  return error ? fail(toDataError(error)) : ok(null);
}

// A company attesting for a person it rosters ----------------------------------------------------------------------

export async function attestRosterMealPreference(
  db: XosClient,
  input: {
    readonly rosterEntryId: string;
    readonly locale: string;
    readonly surface: SensitiveSurface;
    readonly authorityConfirmed: boolean;
    readonly noticeConfirmed: boolean;
    readonly clientIp?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("attest_roster_meal_preference", {
    p_roster_entry_id: input.rosterEntryId,
    p_notice_version: SENSITIVE_NOTICE_VERSIONS["Dietary and Allergies"],
    p_locale: input.locale,
    p_surface: input.surface,
    p_authority_confirmed: input.authorityConfirmed,
    p_notice_confirmed: input.noticeConfirmed,
    ...(input.clientIp ? { p_client_ip: input.clientIp } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** Whether the signed-in person may enter a meal preference on this roster entry now; the form shows the field only then. */
export async function rosterMealConsentStands(
  db: XosClient,
  rosterEntryId: string,
): Promise<boolean> {
  const { data, error } = await db.rpc("roster_meal_consent_stands", {
    p_roster_entry_id: rosterEntryId,
  });
  return !error && data === true;
}

// A guest's needs --------------------------------------------------------------------------------------------------

export type GuestDietaryNeed = Enums["dietary_need"];
export type GuestAccessibilityNeed = Enums["accessibility_need"];

export interface GuestNeedsInput {
  readonly guestListEntryId: string;
  readonly dietaryNeeds: readonly GuestDietaryNeed[];
  readonly allergies: string | null;
  readonly dietaryNotes: string | null;
  readonly accessibilityNeeds: readonly GuestAccessibilityNeed[];
  readonly accessibilityNotes: string | null;
  /** Null keeps the email on file, which never comes back to a form; `clearGuestEmail` removes it. */
  readonly guestEmail: string | null;
  readonly clearGuestEmail?: boolean;
  readonly authorityConfirmed: boolean;
  readonly noticeConfirmed: boolean;
  readonly locale: string;
  readonly surface: SensitiveSurface;
  readonly clientIp?: string | null;
}

/** Sets a guest's needs as a full replacement under an attestation; nothing given clears them. */
export async function setGuestNeeds(
  db: XosClient,
  input: GuestNeedsInput,
): Promise<Result<{ id: string | null }>> {
  const { data, error } = await db.rpc("set_guest_care_needs", {
    p_guest_list_entry_id: input.guestListEntryId,
    p_dietary_needs: [...input.dietaryNeeds],
    p_accessibility_needs: [...input.accessibilityNeeds],
    p_authority_confirmed: input.authorityConfirmed,
    p_notice_confirmed: input.noticeConfirmed,
    // Each category stands on its own wording.
    p_dietary_notice_version: SENSITIVE_NOTICE_VERSIONS["Dietary and Allergies"],
    p_accessibility_notice_version: SENSITIVE_NOTICE_VERSIONS.Accessibility,
    p_locale: input.locale,
    p_surface: input.surface,
    ...(input.allergies ? { p_allergies: input.allergies } : {}),
    ...(input.dietaryNotes ? { p_dietary_notes: input.dietaryNotes } : {}),
    ...(input.accessibilityNotes ? { p_accessibility_notes: input.accessibilityNotes } : {}),
    ...(input.guestEmail ? { p_guest_email: input.guestEmail } : {}),
    ...(input.clearGuestEmail ? { p_clear_guest_email: true } : {}),
    ...(input.clientIp ? { p_client_ip: input.clientIp } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data ?? null });
}

export async function clearGuestNeeds(
  db: XosClient,
  guestListEntryId: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("clear_guest_care_needs", {
    p_guest_list_entry_id: guestListEntryId,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

export interface GuestNeedsState {
  readonly guestListEntryId: string;
  readonly categories: readonly SensitiveCategory[];
  readonly givenByName: string | null;
  readonly givenAt: string;
  /** An email is on file. The form shows that, so a blank field reads as keeping it; the email itself never comes back. */
  readonly hasEmail: boolean;
}

/** Which guests of a project have attested needs, for whoever keeps the list; never the values. */
export async function listGuestNeedsStates(
  db: XosClient,
  projectId: string,
): Promise<Result<GuestNeedsState[]>> {
  const { data, error } = await db.rpc("guest_care_needs_states", { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((row) => ({
      guestListEntryId: row.guest_list_entry_id,
      categories: row.categories,
      givenByName: row.given_by_name,
      givenAt: row.given_at,
      hasEmail: row.has_email,
    })),
  );
}

export interface GuestNeeds {
  readonly guestListEntryId: string;
  readonly guestName: string;
  readonly dietaryNeeds: readonly GuestDietaryNeed[];
  readonly allergies: string | null;
  readonly dietaryNotes: string | null;
  readonly accessibilityNeeds: readonly GuestAccessibilityNeed[];
  readonly accessibilityNotes: string | null;
}

/** Whether the signed-in person holds data.restricted.read.medical on the project, so the page offers the read. */
export async function canReadGuestNeeds(db: XosClient, projectId: string): Promise<boolean> {
  const { data, error } = await db.rpc("can_read_guest_care_needs", { p_project_id: projectId });
  return !error && data === true;
}

/** The guests' needs on a project, for holders of data.restricted.read.medical on it; every call is logged. */
export async function readGuestNeeds(
  db: XosClient,
  projectId: string,
  forExport = false,
): Promise<Result<GuestNeeds[]>> {
  const { data, error } = await db.rpc("read_guest_care_needs", {
    p_project_id: projectId,
    p_for_export: forExport,
  });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((row) => ({
      guestListEntryId: row.guest_list_entry_id,
      guestName: row.guest_name,
      dietaryNeeds: row.dietary_needs,
      allergies: row.allergies,
      dietaryNotes: row.dietary_notes,
      accessibilityNeeds: row.accessibility_needs,
      accessibilityNotes: row.accessibility_notes,
    })),
  );
}

// The report -------------------------------------------------------------------------------------------------------

export interface SensitiveConsentReportRow {
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly subjectName: string | null;
  readonly category: SensitiveCategory;
  readonly fieldCode: string;
  readonly standing: SensitiveStanding;
  readonly noticeVersion: string | null;
  readonly givenAt: string | null;
  readonly givenByName: string | null;
  readonly withdrawnAt: string | null;
}

/** Consent state per subject and field, for holders of data.request.manage; never a value. */
export async function readSensitiveConsentReport(
  db: XosClient,
  orgId: string,
): Promise<Result<SensitiveConsentReportRow[]>> {
  const { data, error } = await db.rpc("sensitive_consent_report", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((row) => ({
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      subjectName: row.subject_name,
      category: row.category,
      fieldCode: row.field_code,
      standing: row.standing,
      noticeVersion: row.notice_version,
      givenAt: row.given_at,
      givenByName: row.given_by_name,
      withdrawnAt: row.withdrawn_at,
    })),
  );
}
