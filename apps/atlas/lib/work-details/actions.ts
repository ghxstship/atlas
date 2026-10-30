"use server";

import type { Result } from "@xos/data/result";
import {
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
  workDetailErrorKey,
  type Parsed,
} from "@xos/data/work-details-forms";
import type { WorkDetailsPatch } from "@xos/data/work-details";
import { regionFromLocale, toE164 } from "@xos/i18n/formats";
import { getLocale } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getOrgContext, getViewer } from "@/lib/shell/context";

/**
 * Server actions for Work Details (Section 4.5.6 item 10, migration 1340): the viewer's own needs,
 * passport, emergency contacts and loyalty programs (sizes and travel preferences are asked per
 * project since R6a), their per-engagement
 * shares, their Section 15 name parts, and the engaging org's passport reveal. Each runs with the
 * viewer's client, so the owner-only policies and the RPCs decide; the field parsers are shared with
 * Gateway (@xos/data/work-details-forms) and refusals come back as `workDetails.errors.*` keys.
 * Phones are stored in E.164, read in the viewer's region when typed without a country code.
 */

export interface WorkDetailsFormState {
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, "invalid" | "phone">>;
  readonly ok?: boolean;
  /** A revealed passport number, shown once and never stored. */
  readonly revealed?: string;
}

type State = WorkDetailsFormState;

async function viewerPerson() {
  const viewer = await getViewer();
  if (!viewer?.person) redirect("/auth/sign-in");
  return { db: viewer.db, personId: viewer.person.id };
}

function rejected(parsed: Extract<Parsed<unknown>, { ok: false }>): State {
  return { fieldErrors: Object.fromEntries(parsed.fields.map((f) => [f, parsed.code])) };
}

function done(form: FormData, result: Result<unknown>): State {
  if (!result.ok) return { error: workDetailErrorKey(result.error) };
  const slug = form.get("org");
  // Work Details and name parts render under Settings (/{org}/me/...); nothing else reads them.
  if (typeof slug === "string") revalidatePath(`/${slug}/me`, "layout");
  return { ok: true };
}

async function savePatch(form: FormData, parsed: Parsed<WorkDetailsPatch>): Promise<State> {
  if (!parsed.ok) return rejected(parsed);
  const { db } = await viewerPerson();
  return done(form, await saveMyWorkDetails(db, parsed.value));
}

// Work details ------------------------------------------------------------------------------------------

export async function saveDietaryAction(_: State, form: FormData): Promise<State> {
  return savePatch(form, parseDietaryForm(form));
}

export async function saveAccessibilityAction(_: State, form: FormData): Promise<State> {
  return savePatch(form, parseAccessibilityForm(form));
}

export async function savePassportAction(_: State, form: FormData): Promise<State> {
  const parsed = parsePassportForm(form);
  if (!parsed.ok) return rejected(parsed);
  const { db } = await viewerPerson();
  const saved = await saveMyWorkDetails(db, parsed.value.patch);
  if (!saved.ok || parsed.value.number === null) return done(form, saved);
  return done(form, await setMyPassportNumber(db, parsed.value.number));
}

export async function clearPassportNumberAction(_: State, form: FormData): Promise<State> {
  const { db } = await viewerPerson();
  return done(form, await setMyPassportNumber(db, null));
}

/** The owner's explicit reveal; the database writes it to their access log. Shown once, never stored. */
export async function revealMyPassportAction(): Promise<State> {
  const { db } = await viewerPerson();
  const result = await revealMyPassportNumber(db);
  return result.ok ? { revealed: result.data } : { error: workDetailErrorKey(result.error) };
}

// Emergency contacts and loyalty programs ---------------------------------------------------------------

export async function addContactAction(_: State, form: FormData): Promise<State> {
  const region = regionFromLocale(await getLocale());
  const parsed = parseContactForm(form, (input) => toE164(input, region));
  if (!parsed.ok) return rejected(parsed);
  const { db, personId } = await viewerPerson();
  return done(form, await addEmergencyContact(db, personId, parsed.value));
}

export async function removeContactAction(_: State, form: FormData): Promise<State> {
  const id = parseId(form, "id");
  if (!id) return { error: "invalid" };
  const { db } = await viewerPerson();
  return done(form, await removeEmergencyContact(db, id));
}

export async function addLoyaltyAction(_: State, form: FormData): Promise<State> {
  const parsed = parseLoyaltyForm(form);
  if (!parsed.ok) return rejected(parsed);
  const { db, personId } = await viewerPerson();
  return done(form, await addLoyaltyProgram(db, personId, parsed.value));
}

export async function removeLoyaltyAction(_: State, form: FormData): Promise<State> {
  const id = parseId(form, "id");
  if (!id) return { error: "invalid" };
  const { db } = await viewerPerson();
  return done(form, await removeLoyaltyProgram(db, id));
}

// Sharing ------------------------------------------------------------------------------------------------

export async function shareAction(_: State, form: FormData): Promise<State> {
  const parsed = parseShareForm(form);
  if (!parsed.ok) {
    return {
      error: parsed.fields.includes("categories") ? "work_detail_share_categories" : "invalid",
    };
  }
  const { db } = await viewerPerson();
  return done(form, await shareWorkDetails(db, parsed.value.engagementId, parsed.value.categories));
}

export async function revokeShareAction(_: State, form: FormData): Promise<State> {
  const id = parseId(form, "shareId");
  if (!id) return { error: "invalid" };
  const { db } = await viewerPerson();
  return done(form, await revokeWorkDetailShare(db, id));
}

// Section 15 names ---------------------------------------------------------------------------------------

export async function saveNamePartsAction(_: State, form: FormData): Promise<State> {
  const parsed = parseNamePartsForm(form);
  if (!parsed.ok) return rejected(parsed);
  const { db, personId } = await viewerPerson();
  return done(form, await saveMyNameParts(db, personId, parsed.value));
}

// The engaging org ---------------------------------------------------------------------------------------

export async function revealSharedPassportAction(_: State, form: FormData): Promise<State> {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) return { error: "denied" };
  const engagement = parseId(form, "engagementId");
  const reason = String(form.get("reason") ?? "").trim();
  if (!engagement) return { error: "invalid" };
  if (reason.length < 10 || reason.length > 500) return { error: "passport_reveal_reason" };
  const result = await revealSharedPassportNumber(ctx.viewer.db, engagement, reason);
  return result.ok ? { revealed: result.data } : { error: workDetailErrorKey(result.error) };
}
