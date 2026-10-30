"use server";

import {
  addCertification,
  addLanguage,
  addLink,
  addSkill,
  carryCertification,
  getMyProfile,
  listMySkills,
  joinByVerifiedDomain,
  removeProfileItem,
  setSectionVisibility,
  updateMyProfile,
  PROFILE_SECTIONS,
  type ProfileSection,
} from "@xos/data/profiles";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { settingErrorKey } from "@/lib/settings/registry";
import { getOrgContext, getViewer } from "@/lib/shell/context";

/**
 * Personal profile actions (Section 4.8.2, 4.8.3): profile facts, visibility per section, skills,
 * languages, links and certifications, carrying an org's verified certification to the profile,
 * and automatic join. Row level security makes every write the person's own; refusals come back
 * as `profiles.errors.*` or `settings.errors.*` keys.
 */

export interface ProfileFormState {
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly ok?: boolean;
}

const KNOWN = new Set([
  "handle_format",
  "handle_reserved",
  "handle_taken",
  "handle_change_too_soon",
  "certification_verified_immutable",
  "certification_not_yours",
  "email_unconfirmed",
  "auto_join_unavailable",
  // The org's blocklist (B16, 3050) refuses the join with a generic sentence.
  "member_blocked",
]);

function errorKey(error: Parameters<typeof settingErrorKey>[0]): string {
  if (error.kind === "refusal" && KNOWN.has(error.rule)) return error.rule;
  if (error.kind === "conflict") return "handle_in_use";
  return settingErrorKey(error);
}

function text(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx?.viewer.person) notFound();
  return { ctx, personId: ctx.viewer.person.id };
}

function done(org: string): ProfileFormState {
  revalidatePath(`/${org}/me`, "layout");
  return { ok: true };
}

const profileSchema = z.object({
  handle: z.string().regex(/^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$/),
  preferredName: z.string().max(100).nullable(),
  pronouns: z.string().max(40).nullable(),
  headline: z.string().max(120).nullable(),
  bio: z.string().max(2000).nullable(),
  city: z.string().max(100).nullable(),
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  rate: z
    .string()
    .regex(/^\d{1,12}(\.\d{1,4})?$/)
    .nullable(),
  rateCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  rateUnit: z.enum(["Hour", "Day", "Week", "Project"]).nullable(),
});

export async function saveProfileAction(
  _: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const { ctx } = await contextFor(form);
  const parsed = profileSchema.safeParse({
    handle: text(form, "handle")?.toLowerCase() ?? "",
    preferredName: text(form, "preferredName"),
    pronouns: text(form, "pronouns"),
    headline: text(form, "headline"),
    bio: text(form, "bio"),
    city: text(form, "city"),
    countryCode: text(form, "countryCode")?.toUpperCase() ?? null,
    rate: text(form, "rate"),
    rateCurrency: text(form, "rateCurrency"),
    rateUnit: text(form, "rateUnit"),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues)
      fieldErrors[String(issue.path[0])] = String(issue.path[0]);
    return { fieldErrors };
  }
  const p = parsed.data;
  if (p.rate !== null && (p.rateCurrency === null || p.rateUnit === null)) {
    return { fieldErrors: { rate: "rateIncomplete" } };
  }
  let rateMinor: number | null = null;
  if (p.rate !== null) {
    // Minor units of the rate's currency (Section 7.1); the exponent comes from the currency table.
    const { data, error } = await ctx.viewer.db
      .from("currencies")
      .select("minor_unit_exponent")
      .eq("currency_code", p.rateCurrency ?? "")
      .maybeSingle();
    if (error) return { error: "unexpected" };
    const exponent = data?.minor_unit_exponent;
    if (exponent === null || exponent === undefined)
      return { fieldErrors: { rateCurrency: "rateCurrency" } };
    const decimals = p.rate.split(".")[1]?.length ?? 0;
    if (decimals > exponent) return { fieldErrors: { rate: "rateDecimals" } };
    rateMinor = Math.round(Number(p.rate) * 10 ** exponent);
  }
  const current = await getMyProfile(ctx.viewer.db);
  if (!current.ok) return { error: errorKey(current.error) };
  const result = await updateMyProfile(ctx.viewer.db, current.data.id, {
    ...current.data,
    handle: p.handle,
    preferredName: p.preferredName,
    pronouns: p.pronouns,
    headline: p.headline,
    bio: p.bio,
    city: p.city,
    countryCode: p.countryCode,
    // Null means no published rate, never zero.
    rateMinor,
    rateCurrency: p.rate === null ? null : p.rateCurrency,
    rateUnit: p.rate === null ? null : p.rateUnit,
  });
  if (!result.ok) return { error: errorKey(result.error) };
  return done(ctx.org.slug);
}

const VISIBILITY = z.enum(["Private", "Network", "Public"]);

export async function savePrivacyAction(
  _: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const { ctx, personId } = await contextFor(form);
  const visibility = VISIBILITY.safeParse(form.get("visibility"));
  if (!visibility.success) return { error: "invalid" };
  const current = await getMyProfile(ctx.viewer.db);
  if (!current.ok) return { error: errorKey(current.error) };
  const indexing = form.get("searchIndexing") === "on" && visibility.data === "Public";
  const saved = await updateMyProfile(ctx.viewer.db, current.data.id, {
    ...current.data,
    visibility: visibility.data,
    searchIndexing: indexing,
    marketplaceDiscoverable: form.get("marketplaceDiscoverable") === "on",
  });
  if (!saved.ok) return { error: errorKey(saved.error) };
  for (const section of PROFILE_SECTIONS) {
    const raw = form.get(`section-${section}`);
    const value = raw === "inherit" || raw === null ? null : VISIBILITY.safeParse(raw);
    if (value !== null && !value.success) return { error: "invalid" };
    const result = await setSectionVisibility(ctx.viewer.db, {
      personId,
      section: section as ProfileSection,
      visibility: value === null ? null : value.data,
    });
    if (!result.ok) return { error: errorKey(result.error) };
  }
  return done(ctx.org.slug);
}

export async function addProfileItemAction(
  _: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const { ctx, personId } = await contextFor(form);
  const kind = form.get("kind");
  const db = ctx.viewer.db;
  let result;
  if (kind === "skill") {
    const urid = z
      .string()
      .regex(/^\d{4}\.\d{2}\.\d{2}$/)
      .safeParse(form.get("catUrid"));
    if (!urid.success) return { fieldErrors: { catUrid: "catUrid" } };
    const skills = await listMySkills(db, personId);
    if (!skills.ok) return { error: errorKey(skills.error) };
    result = await addSkill(db, {
      personId,
      catUrid: urid.data,
      sortOrder: skills.data.length + 1,
    });
  } else if (kind === "language") {
    const parsed = z
      .object({
        tag: z.string().regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/),
        proficiency: z.enum(["Basic", "Conversational", "Fluent", "Native"]),
      })
      .safeParse({ tag: text(form, "tag"), proficiency: form.get("proficiency") });
    if (!parsed.success) return { fieldErrors: { tag: "tag" } };
    result = await addLanguage(db, { personId, ...parsed.data });
  } else if (kind === "link") {
    const parsed = z
      .object({ label: z.string().min(1).max(60), url: z.url().startsWith("https://").max(2000) })
      .safeParse({ label: text(form, "label"), url: text(form, "url") });
    if (!parsed.success) return { fieldErrors: { url: "url" } };
    result = await addLink(db, { personId, ...parsed.data });
  } else if (kind === "certification") {
    const parsed = z
      .object({
        name: z.string().min(1).max(200),
        issuingBody: z.string().min(1).max(200),
        issuedOn: z.iso.date(),
        expiresOn: z.iso.date().nullable(),
      })
      .safeParse({
        name: text(form, "name"),
        issuingBody: text(form, "issuingBody"),
        issuedOn: text(form, "issuedOn"),
        expiresOn: text(form, "expiresOn"),
      });
    if (!parsed.success) return { fieldErrors: { name: "certification" } };
    if (parsed.data.expiresOn !== null && parsed.data.expiresOn < parsed.data.issuedOn) {
      return { fieldErrors: { name: "certificationDates" } };
    }
    result = await addCertification(db, { personId, ...parsed.data });
  } else {
    return { error: "invalid" };
  }
  if (!result.ok) return { error: errorKey(result.error) };
  return done(ctx.org.slug);
}

const TABLES = {
  skill: "person_skills",
  language: "person_languages",
  link: "person_links",
  certification: "person_certifications",
} as const;

export async function removeProfileItemAction(
  _: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const { ctx } = await contextFor(form);
  const parsed = z
    .object({ kind: z.enum(["skill", "language", "link", "certification"]), id: z.uuid() })
    .safeParse({ kind: form.get("kind"), id: form.get("id") });
  if (!parsed.success) return { error: "invalid" };
  const result = await removeProfileItem(ctx.viewer.db, TABLES[parsed.data.kind], parsed.data.id);
  if (!result.ok) return { error: errorKey(result.error) };
  return done(ctx.org.slug);
}

export async function carryCertificationAction(
  _: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const { ctx } = await contextFor(form);
  const id = z.uuid().safeParse(form.get("holderId"));
  if (!id.success) return { error: "invalid" };
  const result = await carryCertification(ctx.viewer.db, id.data);
  if (!result.ok) return { error: errorKey(result.error) };
  return done(ctx.org.slug);
}

/** Joins an org the person's confirmed email domain lets them join, then opens it. */
export async function autoJoinAction(
  _: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const viewer = await getViewer();
  if (!viewer) redirect("/auth/sign-in");
  const parsed = z
    .object({ orgId: z.uuid(), slug: z.string().min(1) })
    .safeParse({ orgId: form.get("orgId"), slug: form.get("slug") });
  if (!parsed.success) return { error: "invalid" };
  const result = await joinByVerifiedDomain(viewer.db, parsed.data.orgId);
  if (!result.ok) return { error: errorKey(result.error) };
  redirect(`/${parsed.data.slug}/home`);
}
