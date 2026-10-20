"use server";

import type { DataError, Result } from "@xos/data/result";
import {
  ACCESSIBILITY_NEEDS,
  DIETARY_NEEDS,
  GARMENT_LETTER_SIZES,
  LOYALTY_PROGRAM_KINDS,
  SEAT_PREFERENCES,
  WORK_DETAIL_CATEGORIES,
  WORK_DETAIL_RULES,
  addEmergencyContact,
  addLoyaltyProgram,
  removeEmergencyContact,
  removeLoyaltyProgram,
  revealMyPassportNumber,
  revealSharedPassportNumber,
  revokeWorkDetailShare,
  saveMyNameParts,
  saveMyWorkDetails,
  setMyPassportNumber,
  shareWorkDetails,
  type WorkDetailsPatch,
} from "@xos/data/work-details";
import { regionFromLocale, toE164 } from "@xos/i18n/formats";
import { getLocale } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getOrgContext, getViewer } from "@/lib/shell/context";

/**
 * Server actions for Work Details (Section 4.5.6 item 10, migration 1340): the viewer's own sizes,
 * needs, travel profile, passport, emergency contacts and loyalty programs, their per-engagement
 * shares, their Section 15 name parts, and the engaging org's passport reveal. Each runs with the
 * viewer's client, so the owner-only policies and the RPCs decide; refusals come back as
 * `workDetails.errors.*` keys. Phones are stored in E.164, read in the viewer's region when typed
 * without a country code.
 */

export interface WorkDetailsFormState {
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, "invalid" | "phone">>;
  readonly ok?: boolean;
  /** A revealed passport number, shown once. */
  readonly revealed?: string;
}

const RULES: ReadonlySet<string> = new Set(WORK_DETAIL_RULES);

function errorKey(error: DataError): string {
  if (error.kind === "refusal") return RULES.has(error.rule) ? error.rule : "unexpected";
  if (error.kind === "not-found") return "denied";
  if (error.kind === "conflict") return "conflict";
  if (error.kind === "invalid") return "invalid";
  return "unexpected";
}

async function viewerPerson() {
  const viewer = await getViewer();
  if (!viewer?.person) redirect("/auth/sign-in");
  return { db: viewer.db, personId: viewer.person.id };
}

function text(form: FormData, name: string, max: number): string | null | undefined {
  const value = form.get(name);
  if (value === null) return undefined;
  const trimmed = String(value).trim();
  if (trimmed === "") return null;
  return trimmed.length > max ? undefined : trimmed;
}

const pick = <T extends string>(
  allowed: readonly T[],
  value: FormDataEntryValue | null,
): T | null =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;

const pickAll = <T extends string>(allowed: readonly T[], form: FormData, name: string): T[] =>
  form
    .getAll(name)
    .filter((v): v is string => typeof v === "string" && (allowed as readonly string[]).includes(v))
    .map((v) => v as T);

function done(form: FormData, result: Result<unknown>): WorkDetailsFormState {
  if (!result.ok) return { error: errorKey(result.error) };
  const slug = form.get("org");
  revalidatePath(typeof slug === "string" ? `/${slug}/me` : "/", "layout");
  return { ok: true };
}

function invalid(
  fields: readonly string[],
  code: "invalid" | "phone" = "invalid",
): WorkDetailsFormState {
  return { fieldErrors: Object.fromEntries(fields.map((f) => [f, code])) };
}

async function save(form: FormData, patch: WorkDetailsPatch, bad: string[]) {
  if (bad.length > 0) return invalid(bad);
  const { db } = await viewerPerson();
  return done(form, await saveMyWorkDetails(db, patch));
}

// Work details ------------------------------------------------------------------------------------------

export async function saveUniformAction(
  _: WorkDetailsFormState,
  form: FormData,
): Promise<WorkDetailsFormState> {
  const bad: string[] = [];
  const free = (name: string, max: number) => {
    const value = text(form, name, max);
    if (value === undefined) bad.push(name);
    return value ?? null;
  };
  return save(
    form,
    {
      shirtSize: pick(GARMENT_LETTER_SIZES, form.get("shirtSize")),
      jacketSize: pick(GARMENT_LETTER_SIZES, form.get("jacketSize")),
      gloveSize: pick(GARMENT_LETTER_SIZES, form.get("gloveSize")),
      pantsSize: free("pantsSize", 20),
      shoeSize: free("shoeSize", 20),
      hatSize: free("hatSize", 20),
      uniformNotes: free("uniformNotes", 500),
    },
    bad,
  );
}

export async function saveDietaryAction(
  _: WorkDetailsFormState,
  form: FormData,
): Promise<WorkDetailsFormState> {
  const allergies = text(form, "allergies", 500);
  const notes = text(form, "dietaryNotes", 500);
  return save(
    form,
    {
      dietaryNeeds: pickAll(DIETARY_NEEDS, form, "dietaryNeeds"),
      allergies: allergies ?? null,
      dietaryNotes: notes ?? null,
    },
    [
      ...(allergies === undefined ? ["allergies"] : []),
      ...(notes === undefined ? ["dietaryNotes"] : []),
    ],
  );
}

export async function saveAccessibilityAction(
  _: WorkDetailsFormState,
  form: FormData,
): Promise<WorkDetailsFormState> {
  const notes = text(form, "accessibilityNotes", 1000);
  return save(
    form,
    {
      accessibilityNeeds: pickAll(ACCESSIBILITY_NEEDS, form, "accessibilityNeeds"),
      accessibilityNotes: notes ?? null,
    },
    notes === undefined ? ["accessibilityNotes"] : [],
  );
}

export async function saveTravelAction(
  _: WorkDetailsFormState,
  form: FormData,
): Promise<WorkDetailsFormState> {
  const meal = text(form, "mealPreference", 100);
  const airport = text(form, "homeAirport", 3)?.toUpperCase();
  const bad = [
    ...(meal === undefined ? ["mealPreference"] : []),
    ...(airport === undefined || (airport !== null && !/^[A-Z]{3}$/.test(airport))
      ? ["homeAirport"]
      : []),
  ];
  return save(
    form,
    {
      seatPreference: pick(SEAT_PREFERENCES, form.get("seatPreference")),
      mealPreference: meal ?? null,
      homeAirport: airport ?? null,
    },
    bad,
  );
}

export async function savePassportAction(
  _: WorkDetailsFormState,
  form: FormData,
): Promise<WorkDetailsFormState> {
  const country = text(form, "passportIssuingCountry", 2)?.toUpperCase();
  const expires = text(form, "passportExpiresOn", 10);
  const name = text(form, "passportName", 200);
  const number = text(form, "passportNumber", 40);
  const bad = [
    ...(country === undefined || (country !== null && !/^[A-Z]{2}$/.test(country))
      ? ["passportIssuingCountry"]
      : []),
    ...(expires === undefined || (expires !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expires))
      ? ["passportExpiresOn"]
      : []),
    ...(name === undefined ? ["passportName"] : []),
    ...(number === undefined ? ["passportNumber"] : []),
  ];
  if (bad.length > 0) return invalid(bad);
  const { db } = await viewerPerson();
  const saved = await saveMyWorkDetails(db, {
    passportIssuingCountry: country ?? null,
    passportExpiresOn: expires ?? null,
    passportName: name ?? null,
  });
  if (!saved.ok || !number) return done(form, saved);
  return done(form, await setMyPassportNumber(db, number));
}

export async function clearPassportNumberAction(
  _: WorkDetailsFormState,
  form: FormData,
): Promise<WorkDetailsFormState> {
  const { db } = await viewerPerson();
  return done(form, await setMyPassportNumber(db, null));
}

/** The owner's explicit reveal; the database writes it to their access log. Shown once, never stored. */
export async function revealMyPassportAction(): Promise<WorkDetailsFormState> {
  const { db } = await viewerPerson();
  const result = await revealMyPassportNumber(db);
  return result.ok ? { revealed: result.data } : { error: errorKey(result.error) };
}

// Emergency contacts and loyalty programs ---------------------------------------------------------------

export async function addContactAction(
  _: WorkDetailsFormState,
  form: FormData,
): Promise<WorkDetailsFormState> {
  const region = regionFromLocale(await getLocale());
  const fullName = text(form, "fullName", 200);
  const relationship = text(form, "relationship", 60);
  const phone = toE164(String(form.get("phone") ?? ""), region);
  const alternateRaw = text(form, "alternatePhone", 40);
  const alternate = alternateRaw ? toE164(alternateRaw, region) : null;
  const email = text(form, "email", 320);
  const emailOk = email === null || (email !== undefined && z.email().safeParse(email).success);
  if (!fullName || relationship === undefined || !emailOk) {
    return invalid([
      ...(!fullName ? ["fullName"] : []),
      ...(relationship === undefined ? ["relationship"] : []),
      ...(!emailOk ? ["email"] : []),
    ]);
  }
  if (!phone || (alternateRaw && !alternate)) {
    return invalid(
      [...(!phone ? ["phone"] : []), ...(alternateRaw && !alternate ? ["alternatePhone"] : [])],
      "phone",
    );
  }
  const order = z.coerce.number().int().min(0).max(99).safeParse(form.get("sortOrder"));
  const { db, personId } = await viewerPerson();
  return done(
    form,
    await addEmergencyContact(db, personId, {
      fullName,
      relationship,
      phoneE164: phone,
      alternatePhoneE164: alternate,
      email: email ?? null,
      sortOrder: order.success ? order.data : 0,
    }),
  );
}

export async function removeContactAction(
  _: WorkDetailsFormState,
  form: FormData,
): Promise<WorkDetailsFormState> {
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "invalid" };
  const { db } = await viewerPerson();
  return done(form, await removeEmergencyContact(db, id.data));
}

export async function addLoyaltyAction(
  _: WorkDetailsFormState,
  form: FormData,
): Promise<WorkDetailsFormState> {
  const kind = pick(LOYALTY_PROGRAM_KINDS, form.get("programKind"));
  const program = text(form, "programName", 100);
  const member = text(form, "memberNumber", 40);
  if (!kind || !program || !member) {
    return invalid([
      ...(!kind ? ["programKind"] : []),
      ...(!program ? ["programName"] : []),
      ...(!member ? ["memberNumber"] : []),
    ]);
  }
  const { db, personId } = await viewerPerson();
  return done(
    form,
    await addLoyaltyProgram(db, personId, {
      programKind: kind,
      programName: program,
      memberNumber: member,
    }),
  );
}

export async function removeLoyaltyAction(
  _: WorkDetailsFormState,
  form: FormData,
): Promise<WorkDetailsFormState> {
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "invalid" };
  const { db } = await viewerPerson();
  return done(form, await removeLoyaltyProgram(db, id.data));
}

// Sharing ------------------------------------------------------------------------------------------------

export async function shareAction(
  _: WorkDetailsFormState,
  form: FormData,
): Promise<WorkDetailsFormState> {
  const engagement = z.uuid().safeParse(form.get("engagementId"));
  if (!engagement.success) return { error: "invalid" };
  const categories = pickAll(WORK_DETAIL_CATEGORIES, form, "categories");
  if (categories.length === 0) return { error: "work_detail_share_categories" };
  const { db } = await viewerPerson();
  return done(form, await shareWorkDetails(db, engagement.data, categories));
}

export async function revokeShareAction(
  _: WorkDetailsFormState,
  form: FormData,
): Promise<WorkDetailsFormState> {
  const share = z.uuid().safeParse(form.get("shareId"));
  if (!share.success) return { error: "invalid" };
  const { db } = await viewerPerson();
  return done(form, await revokeWorkDetailShare(db, share.data));
}

// Section 15 names ---------------------------------------------------------------------------------------

export async function saveNamePartsAction(
  _: WorkDetailsFormState,
  form: FormData,
): Promise<WorkDetailsFormState> {
  const given = text(form, "givenName", 100);
  const family = text(form, "familyName", 100);
  if (given === undefined || family === undefined) {
    return invalid([
      ...(given === undefined ? ["givenName"] : []),
      ...(family === undefined ? ["familyName"] : []),
    ]);
  }
  const { db, personId } = await viewerPerson();
  return done(form, await saveMyNameParts(db, personId, { givenName: given, familyName: family }));
}

// The engaging org ---------------------------------------------------------------------------------------

export async function revealSharedPassportAction(
  _: WorkDetailsFormState,
  form: FormData,
): Promise<WorkDetailsFormState> {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) return { error: "denied" };
  const engagement = z.uuid().safeParse(form.get("engagementId"));
  const reason = text(form, "reason", 500);
  if (!engagement.success) return { error: "invalid" };
  if (!reason || reason.length < 10) return { error: "passport_reveal_reason" };
  const result = await revealSharedPassportNumber(ctx.viewer.db, engagement.data, reason);
  return result.ok ? { revealed: result.data } : { error: errorKey(result.error) };
}
