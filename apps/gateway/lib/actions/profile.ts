"use server";

import {
  addAvailabilityBlock,
  APP_ENUMS,
  createAvailabilityCalendar,
  createExternalAccount,
  endAccountMembership,
  removeAvailabilityBlock,
} from "@xos/data/gateway";
import {
  fetchProfilePhoto,
  isBadgePhotoBytes,
  myProfilePhotoPath,
  removeCredentialPhotoObjects,
  storeMyCredentialPhoto,
  withdrawMyCredentialPhotos,
} from "@xos/data/credential-photos";
import { updateMyName } from "@xos/data/identity";
import {
  addCertification,
  addLanguage,
  addLink,
  addSkill,
  carryCertification,
  getMyProfile,
  removeProfileItem,
  setSectionVisibility,
  updateMyProfile,
  updateOrganizationProfile,
  type ProfileSection,
} from "@xos/data/profiles";
import { z } from "zod";
import type { SimpleFormState } from "@/components/forms/simple-form";
import { outcomeFor, toAction, type ActionResult } from "@/lib/action-result";
import { parseMoneyInput } from "@/lib/format";
import { getGatewayContext } from "@/lib/shell/context";

/**
 * Profile and account actions (Section 4.4.1, Section 4.8.2, A30 0860): the person's own profile
 * facts and sections, availability, external accounts and the company profile. Row level security
 * limits every write to the person's own rows; the database refuses anything else.
 */

async function ctxOr(): Promise<NonNullable<Awaited<ReturnType<typeof getGatewayContext>>>> {
  const ctx = await getGatewayContext();
  if (!ctx) throw new Error("A signed-in person is required.");
  return ctx;
}

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

const nullable = (v: string) => (v === "" ? null : v);

export async function saveProfileAction(
  _: SimpleFormState,
  form: FormData,
): Promise<SimpleFormState> {
  const ctx = await ctxOr();
  const current = await getMyProfile(ctx.db);
  if (!current.ok) return { outcome: outcomeFor(current.error) };
  const handle = text(form, "handle").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(handle)) return { fieldError: "handle" };
  const currency = text(form, "rateCurrency").toUpperCase();
  const rateText = text(form, "rate");
  const rateMinor = rateText === "" ? null : parseMoneyInput(rateText, currency || "USD");
  if (rateText !== "" && rateMinor === null) return { fieldError: "rate" };
  const rateUnit = z.enum(APP_ENUMS.rate_unit).safeParse(text(form, "rateUnit"));
  const country = text(form, "countryCode").toUpperCase();
  if (country !== "" && !/^[A-Z]{2}$/.test(country)) return { fieldError: "country" };
  const result = await updateMyProfile(ctx.db, current.data.id, {
    handle,
    preferredName: nullable(text(form, "preferredName")),
    pronouns: nullable(text(form, "pronouns")),
    headline: nullable(text(form, "headline")),
    bio: nullable(text(form, "bio")),
    city: nullable(text(form, "city")),
    countryCode: nullable(country),
    visibility: current.data.visibility,
    searchIndexing: current.data.searchIndexing,
    marketplaceDiscoverable: current.data.marketplaceDiscoverable,
    rateMinor,
    rateCurrency: rateMinor === null ? null : currency || "USD",
    rateUnit: rateMinor === null ? null : rateUnit.success ? rateUnit.data : "Day",
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function savePrivacyAction(
  _: SimpleFormState,
  form: FormData,
): Promise<SimpleFormState> {
  const ctx = await ctxOr();
  const current = await getMyProfile(ctx.db);
  if (!current.ok) return { outcome: outcomeFor(current.error) };
  const visibility = z.enum(APP_ENUMS.profile_visibility).safeParse(text(form, "visibility"));
  if (!visibility.success) return { fieldError: "visibility" };
  const result = await updateMyProfile(ctx.db, current.data.id, {
    ...current.data,
    visibility: visibility.data,
    searchIndexing: form.get("searchIndexing") === "on",
    marketplaceDiscoverable: form.get("marketplaceDiscoverable") === "on",
  });
  if (!result.ok) return { outcome: outcomeFor(result.error) };
  for (const section of APP_ENUMS.profile_section) {
    const value = text(form, `section_${section}`);
    if (value === "") continue;
    const parsed =
      value === "inherit" ? null : z.enum(APP_ENUMS.profile_visibility).safeParse(value);
    if (parsed !== null && !parsed.success) return { fieldError: "visibility" };
    const saved = await setSectionVisibility(ctx.db, {
      personId: ctx.personId,
      section: section as ProfileSection,
      visibility: parsed === null ? null : parsed.data,
    });
    if (!saved.ok) return { outcome: outcomeFor(saved.error) };
  }
  return { done: true };
}

export async function addSkillAction(_: SimpleFormState, form: FormData): Promise<SimpleFormState> {
  const ctx = await ctxOr();
  const urid = text(form, "catUrid");
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(urid)) return { fieldError: "urid" };
  const result = await addSkill(ctx.db, {
    personId: ctx.personId,
    catUrid: urid,
    sortOrder: Number(text(form, "sortOrder") || "0"),
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function addLanguageAction(
  _: SimpleFormState,
  form: FormData,
): Promise<SimpleFormState> {
  const ctx = await ctxOr();
  const tag = text(form, "tag");
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) return { fieldError: "language" };
  const proficiency = z.enum(APP_ENUMS.language_proficiency).safeParse(text(form, "proficiency"));
  const result = await addLanguage(ctx.db, {
    personId: ctx.personId,
    tag,
    proficiency: proficiency.success ? proficiency.data : "Conversational",
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function addLinkAction(_: SimpleFormState, form: FormData): Promise<SimpleFormState> {
  const ctx = await ctxOr();
  const parsed = z
    .object({ label: z.string().min(1).max(100), url: z.url({ protocol: /^https?$/ }) })
    .safeParse({
      label: text(form, "label"),
      url: text(form, "url"),
    });
  if (!parsed.success) return { fieldError: "link" };
  const result = await addLink(ctx.db, { personId: ctx.personId, ...parsed.data });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function addCertificationAction(
  _: SimpleFormState,
  form: FormData,
): Promise<SimpleFormState> {
  const ctx = await ctxOr();
  const name = text(form, "name");
  const issuingBody = text(form, "issuingBody");
  const date = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const issuedOn = date(text(form, "issuedOn"));
  if (name === "" || issuingBody === "" || issuedOn === null)
    return { fieldError: "certification" };
  const result = await addCertification(ctx.db, {
    personId: ctx.personId,
    name,
    issuingBody,
    issuedOn,
    expiresOn: date(text(form, "expiresOn")),
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

const PROFILE_TABLES = [
  "person_skills",
  "person_languages",
  "person_links",
  "person_certifications",
] as const;

export async function removeProfileItemAction(
  table: (typeof PROFILE_TABLES)[number],
  id: string,
): Promise<ActionResult> {
  const ctx = await ctxOr();
  return toAction(
    await removeProfileItem(ctx.db, z.enum(PROFILE_TABLES).parse(table), z.uuid().parse(id)),
  );
}

export async function carryCertificationAction(holderId: string): Promise<ActionResult> {
  const ctx = await ctxOr();
  return toAction(await carryCertification(ctx.db, z.uuid().parse(holderId)));
}

export async function addAvailabilityAction(
  _: SimpleFormState,
  form: FormData,
): Promise<SimpleFormState> {
  const ctx = await ctxOr();
  const parsed = z
    .object({ start: z.iso.date(), end: z.iso.date(), kind: z.enum(APP_ENUMS.availability_kind) })
    .safeParse({ start: text(form, "start"), end: text(form, "end"), kind: text(form, "kind") });
  if (!parsed.success || parsed.data.end < parsed.data.start) return { fieldError: "availability" };
  let calendarId = text(form, "calendarId");
  if (calendarId === "") {
    const timeZone = text(form, "timeZone") || "UTC";
    const created = await createAvailabilityCalendar(ctx.db, {
      personId: ctx.personId,
      timeZone,
      visibility: "Shared on Application",
    });
    if (!created.ok) return { outcome: outcomeFor(created.error) };
    calendarId = created.data.calendarId;
  }
  const end = new Date(`${parsed.data.end}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const result = await addAvailabilityBlock(ctx.db, {
    calendarId,
    startsAt: `${parsed.data.start}T00:00:00Z`,
    endsAt: end.toISOString(),
    kind: parsed.data.kind,
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function removeAvailabilityAction(blockId: string): Promise<ActionResult> {
  const ctx = await ctxOr();
  return toAction(await removeAvailabilityBlock(ctx.db, z.uuid().parse(blockId)));
}

export async function saveNameAction(_: SimpleFormState, form: FormData): Promise<SimpleFormState> {
  const ctx = await ctxOr();
  const name = text(form, "fullName");
  if (name.length < 1 || name.length > 200) return { fieldError: "name" };
  const result = await updateMyName(ctx.db, ctx.personId, name);
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function createAccountAction(
  _: SimpleFormState,
  form: FormData,
): Promise<SimpleFormState> {
  const ctx = await ctxOr();
  const name = text(form, "name");
  const slug = text(form, "slug").toLowerCase();
  if (
    name === "" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
    slug.length < 2 ||
    slug.length > 48
  ) {
    return { fieldError: "account" };
  }
  const result = await createExternalAccount(ctx.db, { name, slug });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function leaveAccountAction(membershipId: string): Promise<ActionResult> {
  const ctx = await ctxOr();
  return toAction(await endAccountMembership(ctx.db, z.uuid().parse(membershipId)));
}

export async function saveCompanyProfileAction(
  _: SimpleFormState,
  form: FormData,
): Promise<SimpleFormState> {
  const ctx = await ctxOr();
  if (!ctx.acting) return { outcome: "notFound" };
  const profileId = z.uuid().safeParse(text(form, "profileId"));
  const visibility = z.enum(APP_ENUMS.profile_visibility).safeParse(text(form, "visibility"));
  const handle = text(form, "handle").toLowerCase();
  if (
    !profileId.success ||
    !visibility.success ||
    !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(handle)
  ) {
    return { fieldError: "company" };
  }
  const website = text(form, "websiteUrl");
  if (website !== "" && !z.url({ protocol: /^https?$/ }).safeParse(website).success)
    return { fieldError: "website" };
  const email = text(form, "contactEmail");
  if (email !== "" && !z.email().safeParse(email).success) return { fieldError: "email" };
  const result = await updateOrganizationProfile(ctx.db, profileId.data, {
    handle,
    about: nullable(text(form, "about")),
    websiteUrl: nullable(website),
    contactEmail: nullable(email),
    visibility: visibility.data,
    searchIndexing: form.get("searchIndexing") === "on",
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

// Badge photos (P5) --------------------------------------------------------------------------------

const ORG_ID = z.uuid();

/**
 * The holder saves the photo they cropped in Gateway (badge-photo-upload.tsx) as their badge photo for one org:
 * a JPEG or PNG of at most 2 MiB, uploaded into their own folder and recorded with their consent (2822).
 */
export async function uploadBadgePhotoAction(orgId: string, form: FormData): Promise<ActionResult> {
  const ctx = await ctxOr();
  if (!ORG_ID.safeParse(orgId).success) return { ok: false, outcome: "invalid" };
  const file = form.get("photo");
  if (!(file instanceof Blob)) return { ok: false, outcome: "invalid" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isBadgePhotoBytes(bytes)) return { ok: false, outcome: "invalid" };
  return toAction(
    await storeMyCredentialPhoto(ctx.db, {
      orgId,
      personId: ctx.personId,
      bytes,
      source: "Holder Upload",
    }),
  );
}

/**
 * "Use my profile photo": a copy of the holder's own profile photo becomes their badge photo for the org. The bytes
 * come from its public URL on the same project (profile-media has no select policy, 0860) and are checked again for
 * the 2 MiB cap and the JPEG or PNG signature before they are stored.
 */
export async function chooseProfilePhotoAction(orgId: string): Promise<ActionResult> {
  const ctx = await ctxOr();
  if (!ORG_ID.safeParse(orgId).success) return { ok: false, outcome: "invalid" };
  const path = await myProfilePhotoPath(ctx.db, ctx.personId);
  const bytes = path ? await fetchProfilePhoto(ctx.db, path) : null;
  if (!bytes) return { ok: false, outcome: "invalid" };
  return toAction(
    await storeMyCredentialPhoto(ctx.db, {
      orgId,
      personId: ctx.personId,
      bytes,
      source: "Holder Profile Photo",
    }),
  );
}

/** "Remove": the holder withdraws their badge photo and consent for the org, and every object of theirs goes. */
export async function removeBadgePhotoAction(orgId: string): Promise<ActionResult> {
  const ctx = await ctxOr();
  if (!ORG_ID.safeParse(orgId).success) return { ok: false, outcome: "invalid" };
  const withdrawn = await withdrawMyCredentialPhotos(ctx.db, orgId);
  if (!withdrawn.ok) return toAction(withdrawn);
  return toAction(
    await removeCredentialPhotoObjects(
      ctx.db,
      withdrawn.data.map((p) => p.photoPath),
    ),
  );
}
