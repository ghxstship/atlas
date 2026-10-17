"use server";

import {
  addOrgDomain,
  getOrgBrand,
  recordLegalAcceptances,
  removeOrgDomain,
  saveOrgBrand,
  setModuleEnabled,
  type BrandInput,
} from "@xos/data/settings";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { z } from "zod";
import { clientIp } from "@/lib/auth/legal";
import { HEX_COLOR, checkAccent } from "@/lib/brand/contrast";
import { LEGAL_DOCUMENTS } from "@/lib/legal.generated";
import { settingErrorKey } from "@/lib/settings/registry";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Org settings actions owned by A30: brand and logos (Section 12), domains, module switches
 * (Section 4.5.2) and re-acceptance of legal documents (Section 14.4). Each resolves the viewer's
 * org context again (404 when gone); row level security and the guards of migration 0850 decide
 * every write, and refusals come back as `settings.errors.*` keys.
 */

export interface IdentityFormState {
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly ok?: boolean;
}

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

function text(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// Brand ---------------------------------------------------------------------------------------------

const brandSchema = z.object({
  displayName: z.string().max(200).nullable(),
  accentHex: z.string().regex(HEX_COLOR).nullable(),
  neutralTintHex: z.string().regex(HEX_COLOR).nullable(),
  fontFamily: z.string().max(80).nullable(),
  radiusScale: z.enum(["Compact", "Default", "Rounded"]),
  emailSenderName: z.string().max(100).nullable(),
  supportEmail: z.email().max(320).nullable(),
  legalEntityName: z.string().max(200).nullable(),
});

export async function saveBrandAction(
  _: IdentityFormState,
  form: FormData,
): Promise<IdentityFormState> {
  const ctx = await contextFor(form);
  const parsed = brandSchema.safeParse({
    displayName: text(form, "displayName"),
    accentHex: text(form, "accentHex")?.toUpperCase() ?? null,
    neutralTintHex: text(form, "neutralTintHex")?.toUpperCase() ?? null,
    fontFamily: text(form, "fontFamily"),
    radiusScale: text(form, "radiusScale") ?? "Default",
    emailSenderName: text(form, "emailSenderName"),
    supportEmail: text(form, "supportEmail")?.toLowerCase() ?? null,
    legalEntityName: text(form, "legalEntityName"),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = "invalid";
    return { fieldErrors };
  }
  if (parsed.data.accentHex && !checkAccent(parsed.data.accentHex).passes) {
    return { fieldErrors: { accentHex: "contrast" } };
  }
  const current = await getOrgBrand(ctx.viewer.db, ctx.org.id);
  if (!current.ok) return { error: settingErrorKey(current.error) };
  const brand: BrandInput = {
    ...current.data,
    ...parsed.data,
    suppressPoweredBy: form.get("suppressPoweredBy") === "on",
  };
  const result = await saveOrgBrand(ctx.viewer.db, ctx.org.id, brand);
  if (!result.ok) return { error: settingErrorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

const LOGO_SLOTS = {
  logoLight: "logoLightPath",
  logoDark: "logoDarkPath",
  favicon: "faviconPath",
  appIcon: "appIconPath",
} as const;
const LOGO_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/webp": "webp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** Uploads one logo or icon to the org-brand bucket and points the brand at it. */
export async function uploadBrandAssetAction(
  _: IdentityFormState,
  form: FormData,
): Promise<IdentityFormState> {
  const ctx = await contextFor(form);
  const slot = z.enum(["logoLight", "logoDark", "favicon", "appIcon"]).safeParse(form.get("slot"));
  const file = form.get("file");
  if (!slot.success || !(file instanceof File) || file.size === 0) {
    return { fieldErrors: { file: "fileMissing" } };
  }
  const extension = LOGO_TYPES[file.type];
  if (!extension) return { fieldErrors: { file: "fileType" } };
  if (file.size > LOGO_MAX_BYTES) return { fieldErrors: { file: "fileSize" } };
  const path = `${ctx.org.id}/${slot.data}-${Date.now()}.${extension}`;
  const upload = await ctx.viewer.db.storage
    .from("org-brand")
    .upload(path, file, { contentType: file.type, upsert: false });
  if (upload.error) return { error: "uploadFailed" };
  const current = await getOrgBrand(ctx.viewer.db, ctx.org.id);
  if (!current.ok) return { error: settingErrorKey(current.error) };
  const brand: BrandInput = { ...current.data, [LOGO_SLOTS[slot.data]]: path };
  const result = await saveOrgBrand(ctx.viewer.db, ctx.org.id, brand);
  if (!result.ok) return { error: settingErrorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

// Domains -------------------------------------------------------------------------------------------

const HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export async function addDomainAction(
  _: IdentityFormState,
  form: FormData,
): Promise<IdentityFormState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      hostname: z.string().max(253).regex(HOSTNAME),
      purpose: z.enum(["Atlas", "Gateway", "Email Sending", "Verified Domain"]),
      autoJoinRoleId: z.uuid().nullable(),
    })
    .safeParse({
      hostname: text(form, "hostname")?.toLowerCase() ?? "",
      purpose: form.get("purpose"),
      autoJoinRoleId: text(form, "autoJoinRoleId"),
    });
  if (!parsed.success) return { fieldErrors: { hostname: "hostname" } };
  const result = await addOrgDomain(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return { error: settingErrorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}/settings`, "layout");
  return { ok: true };
}

export async function removeDomainAction(
  _: IdentityFormState,
  form: FormData,
): Promise<IdentityFormState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("domainId"));
  if (!id.success) return { error: "denied" };
  const result = await removeOrgDomain(ctx.viewer.db, id.data);
  if (!result.ok) return { error: settingErrorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}/settings`, "layout");
  return { ok: true };
}

// Modules -------------------------------------------------------------------------------------------

export async function saveModulesAction(
  _: IdentityFormState,
  form: FormData,
): Promise<IdentityFormState> {
  const ctx = await contextFor(form);
  const modules = form.getAll("module").filter((m): m is string => typeof m === "string");
  const enabled = new Set(form.getAll("enabled").filter((m): m is string => typeof m === "string"));
  for (const code of modules) {
    // Only switches the person changed are written: an unchanged module may be one the database
    // keeps always on (module_not_switchable), and rewriting it would refuse the whole save.
    const was = form.get(`was-${code}`);
    if (was === (enabled.has(code) ? "on" : "off")) continue;
    const result = await setModuleEnabled(ctx.viewer.db, {
      orgId: ctx.org.id,
      module: code,
      enabled: enabled.has(code),
    });
    if (!result.ok) return { error: settingErrorKey(result.error) };
  }
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

// Legal ------------------------------------------------------------------------------------------------

/** An Owner accepts the current version of the documents the org must accept (re-acceptance). */
export async function acceptLegalAction(
  _: IdentityFormState,
  form: FormData,
): Promise<IdentityFormState> {
  const ctx = await contextFor(form);
  const slugs = new Set(form.getAll("document").filter((d): d is string => typeof d === "string"));
  const documents = LEGAL_DOCUMENTS.filter((d) => slugs.has(d.slug)).map((d) => ({
    slug: d.slug,
    version: d.version,
  }));
  if (documents.length === 0) return { error: "unexpected" };
  const result = await recordLegalAcceptances(ctx.viewer.db, {
    orgId: ctx.org.id,
    documents,
    clientIp: clientIp(await headers()),
  });
  if (!result.ok) return { error: settingErrorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}/settings/legal`);
  return { ok: true };
}
