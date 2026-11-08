"use server";

import type { Result } from "@xos/data/result";
import {
  addEmergencyContact,
  addLoyaltyProgram,
  removeEmergencyContact,
  removeLoyaltyProgram,
  revealMyPassportNumber,
  revokeWorkDetailShare,
  saveMyNameParts,
  saveMyWorkDetails,
  setMyPassportNumber,
  shareWorkDetails,
  type WorkDetailsPatch,
} from "@xos/data/work-details";
import {
  parseAccessibilityForm,
  parseContactForm,
  parseDietaryForm,
  parseId,
  parseLoyaltyForm,
  parseNamePartsForm,
  parsePassportForm,
  parseShareForm,
  shareFormError,
  workDetailErrorKey,
  type Parsed,
} from "@xos/data/work-details-forms";
import {
  disownSensitiveEntry,
  giveSensitiveConsent,
  removeSensitiveEntry,
  SENSITIVE_CATEGORIES,
  withdrawSensitiveConsent,
  type SensitiveCategory,
} from "@xos/data/sensitive-consent";
import { regionFromLocale, toE164 } from "@xos/i18n/formats";
import { getLocale } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { clientIp } from "@/lib/auth/legal";
import { redirect } from "next/navigation";
import { getGatewayContext } from "@/lib/shell/context";

/**
 * Gateway server actions for Work Details (Section 4.5.6 item 10, Section 4.5.8 settings and
 * sharing consents, migration 1340): the person's own details and the per-engagement shares they
 * give or revoke from Settings or an engagement's Overview. The field parsers are shared with
 * Atlas (@xos/data/work-details-forms); every write runs as the person, so the owner-only policies
 * and the share RPCs decide, and refusals come back as `workDetails.errors.*` keys.
 */

export interface WorkDetailsFormState {
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, "invalid" | "phone">>;
  readonly ok?: boolean;
  /** A revealed passport number, shown once and never stored. */
  readonly revealed?: string;
  /** A consent was withdrawn while a legal hold keeps the values, hidden, until it ends (ADR 0164). */
  readonly held?: boolean;
}

type State = WorkDetailsFormState;

async function person() {
  const ctx = await getGatewayContext();
  if (!ctx) redirect("/auth/sign-in");
  return { db: ctx.db, personId: ctx.personId };
}

function rejected(parsed: Extract<Parsed<unknown>, { ok: false }>): State {
  return { fieldErrors: Object.fromEntries(parsed.fields.map((f) => [f, parsed.code])) };
}

function done(result: Result<unknown>): State {
  if (!result.ok) return { error: workDetailErrorKey(result.error) };
  revalidatePath("/settings/work-details");
  revalidatePath("/work/engagements", "layout");
  // Supplier diversity lives on the profile, under the same consent step.
  revalidatePath("/profile", "layout");
  return { ok: true };
}

async function savePatch(parsed: Parsed<WorkDetailsPatch>): Promise<State> {
  if (!parsed.ok) return rejected(parsed);
  const { db } = await person();
  return done(await saveMyWorkDetails(db, parsed.value));
}

// Consent for sensitive data (ADR 0164) --------------------------------------------------------------------------------

const CATEGORY_NAMES: readonly string[] = SENSITIVE_CATEGORIES;

function categoryOf(form: FormData): SensitiveCategory | null {
  const value = form.get("category");
  return typeof value === "string" && CATEGORY_NAMES.includes(value)
    ? (value as SensitiveCategory)
    : null;
}

function accountOf(form: FormData): string | null {
  return parseId(form, "accountId");
}

/**
 * Records the person's consent with the wording's version, the language it was shown in and the surface; with an
 * account, the attestation of the Owner or Admin who declares for the company.
 */
export async function giveSensitiveConsentAction(_: State, form: FormData): Promise<State> {
  const category = categoryOf(form);
  if (!category) return { error: "invalid" };
  const { db } = await person();
  return done(
    await giveSensitiveConsent(db, {
      category,
      locale: await getLocale(),
      surface: "Gateway",
      accountId: accountOf(form),
      authorityConfirmed: form.get("authorityConfirmed") === "true",
      noticeConfirmed: form.get("noticeConfirmed") === "true",
      clientIp: clientIp(await headers()),
    }),
  );
}

/** Withdraws a category in one call: use stops at once and the values are cleared. */
export async function withdrawSensitiveConsentAction(_: State, form: FormData): Promise<State> {
  const category = categoryOf(form);
  if (!category) return { error: "invalid" };
  const { db } = await person();
  const result = await withdrawSensitiveConsent(db, category, accountOf(form));
  const state = done(result);
  return result.ok && !result.data.erased ? { ...state, held: true } : state;
}

/** Removes what someone else entered about the person. */
export async function removeSensitiveEntryAction(_: State, form: FormData): Promise<State> {
  const id = parseId(form, "consentId");
  if (!id) return { error: "invalid" };
  const { db } = await person();
  return done(await removeSensitiveEntry(db, id));
}

/** The person says a guest list entry their email matched is about someone else; the guest's needs stay with the keeper. */
export async function disownSensitiveEntryAction(_: State, form: FormData): Promise<State> {
  const id = parseId(form, "consentId");
  if (!id) return { error: "invalid" };
  const { db } = await person();
  return done(await disownSensitiveEntry(db, id));
}

export async function saveDietaryAction(_: State, form: FormData): Promise<State> {
  return savePatch(parseDietaryForm(form));
}

export async function saveAccessibilityAction(_: State, form: FormData): Promise<State> {
  return savePatch(parseAccessibilityForm(form));
}

export async function savePassportAction(_: State, form: FormData): Promise<State> {
  const parsed = parsePassportForm(form);
  if (!parsed.ok) return rejected(parsed);
  const { db } = await person();
  const saved = await saveMyWorkDetails(db, parsed.value.patch);
  if (!saved.ok || parsed.value.number === null) return done(saved);
  return done(await setMyPassportNumber(db, parsed.value.number));
}

export async function clearPassportNumberAction(): Promise<State> {
  const { db } = await person();
  return done(await setMyPassportNumber(db, null));
}

/** The owner's explicit reveal; the database writes it to their access log. Shown once, never stored. */
export async function revealMyPassportAction(): Promise<State> {
  const { db } = await person();
  const result = await revealMyPassportNumber(db);
  return result.ok ? { revealed: result.data } : { error: workDetailErrorKey(result.error) };
}

export async function addContactAction(_: State, form: FormData): Promise<State> {
  const region = regionFromLocale(await getLocale());
  const parsed = parseContactForm(form, (input) => toE164(input, region));
  if (!parsed.ok) return rejected(parsed);
  const { db, personId } = await person();
  return done(await addEmergencyContact(db, personId, parsed.value));
}

export async function removeContactAction(_: State, form: FormData): Promise<State> {
  const id = parseId(form, "id");
  if (!id) return { error: "invalid" };
  const { db } = await person();
  return done(await removeEmergencyContact(db, id));
}

export async function addLoyaltyAction(_: State, form: FormData): Promise<State> {
  const parsed = parseLoyaltyForm(form);
  if (!parsed.ok) return rejected(parsed);
  const { db, personId } = await person();
  return done(await addLoyaltyProgram(db, personId, parsed.value));
}

export async function removeLoyaltyAction(_: State, form: FormData): Promise<State> {
  const id = parseId(form, "id");
  if (!id) return { error: "invalid" };
  const { db } = await person();
  return done(await removeLoyaltyProgram(db, id));
}

export async function shareAction(_: State, form: FormData): Promise<State> {
  const parsed = parseShareForm(form);
  if (!parsed.ok) {
    return { error: shareFormError(parsed.fields) };
  }
  const { db } = await person();
  return done(await shareWorkDetails(db, parsed.value.engagementId, parsed.value.categories));
}

export async function revokeShareAction(_: State, form: FormData): Promise<State> {
  const id = parseId(form, "shareId");
  if (!id) return { error: "invalid" };
  const { db } = await person();
  return done(await revokeWorkDetailShare(db, id));
}

export async function saveNamePartsAction(_: State, form: FormData): Promise<State> {
  const parsed = parseNamePartsForm(form);
  if (!parsed.ok) return rejected(parsed);
  const { db, personId } = await person();
  const result = await saveMyNameParts(db, personId, parsed.value);
  if (result.ok) revalidatePath("/settings/account");
  return done(result);
}
