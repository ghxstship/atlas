"use server";

import { isOrgSlug } from "@xos/data/slug";
import {
  createClientOrg,
  endSupportSession,
  runWholesaleBilling,
  saveDefaultBrand,
  setClientPrice,
  type RadiusScale,
} from "@xos/data/partner";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { checkAccent } from "@/lib/brand/contrast";
import { env } from "@/lib/env";
import {
  contextFor,
  done,
  field,
  fromDataError,
  inputError,
  type PlatformActionState,
} from "@/lib/platform/state";

/**
 * Partner console actions (A36, Section 4.6.1): create a client org, save the default client brand,
 * price a client, run wholesale billing and end a support session. The RPCs and row level security
 * decide every rule; refusals return their rule for catalog copy.
 */

const PLANS = ["access", "core", "pro", "team", "enterprise"] as const;

export async function createClientOrgAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      name: z.string().min(1).max(200),
      slug: z.string().refine(isOrgSlug),
      ownerEmail: z.email().max(320),
      plan: z.enum(PLANS),
    })
    .safeParse({
      name: field(form, "name"),
      slug: field(form, "slug").toLowerCase(),
      ownerEmail: field(form, "ownerEmail").toLowerCase(),
      plan: field(form, "plan"),
    });
  if (!parsed.success) return inputError();
  const result = await createClientOrg(ctx.viewer.db, {
    partnerOrgId: ctx.org.id,
    name: parsed.data.name,
    slug: parsed.data.slug,
    ownerEmail: parsed.data.ownerEmail,
    planCode: parsed.data.plan,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/partner/${ctx.org.slug}`, "layout");
  const link = new URL(`/auth/invite/${result.data.inviteToken}`, env().ATLAS_SITE_URL).toString();
  return done(result.data.orgId, link);
}

const HEX = /^#[0-9A-F]{6}$/;

export async function saveDefaultBrandAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const accent = field(form, "accent").toUpperCase();
  const tint = field(form, "tint").toUpperCase();
  const parsed = z
    .object({
      accent: z.string().regex(HEX).nullable(),
      tint: z.string().regex(HEX).nullable(),
      font: z.string().max(100).nullable(),
      radius: z.enum(["Compact", "Default", "Rounded"]),
      sender: z.string().max(100).nullable(),
      support: z.email().nullable(),
    })
    .safeParse({
      accent: accent || null,
      tint: tint || null,
      font: field(form, "font") || null,
      radius: field(form, "radius") || "Default",
      sender: field(form, "sender") || null,
      support: field(form, "support").toLowerCase() || null,
    });
  if (!parsed.success) return inputError();
  // The white-label contrast gate (Section 12): an accent failing WCAG 2.2 AA in any theme is blocked.
  if (parsed.data.accent && !checkAccent(parsed.data.accent).passes) {
    return { rule: "brand_contrast", at: Date.now() };
  }
  const result = await saveDefaultBrand(ctx.viewer.db, ctx.org.id, {
    accentHex: parsed.data.accent,
    neutralTintHex: parsed.data.tint,
    fontFamily: parsed.data.font,
    radiusScale: parsed.data.radius as RadiusScale,
    emailSenderName: parsed.data.sender,
    supportEmail: parsed.data.support,
    allowClientOverride: form.get("allowOverride") === "on",
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/partner/${ctx.org.slug}`, "layout");
  return done(result.data);
}

export async function setClientPriceAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      client: z.uuid(),
      amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
      currency: z.string().regex(/^[A-Z]{3}$/),
    })
    .safeParse({
      client: field(form, "client"),
      amount: field(form, "amount"),
      currency: field(form, "currency"),
    });
  if (!parsed.success) return inputError();
  const [whole, cents = ""] = parsed.data.amount.split(".");
  const minor = Number(whole) * 100 + Number(cents.padEnd(2, "0"));
  const result = await setClientPrice(ctx.viewer.db, {
    partnerOrgId: ctx.org.id,
    clientOrgId: parsed.data.client,
    monthlyMinor: minor,
    currency: parsed.data.currency,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/partner/${ctx.org.slug}`, "layout");
  return done(result.data);
}

export async function runWholesaleBillingAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const period = field(form, "period");
  if (!/^\d{4}-\d{2}-01$/.test(period)) return inputError();
  const result = await runWholesaleBilling(ctx.viewer.db, ctx.org.id, period);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/partner/${ctx.org.slug}`, "layout");
  return done(result.data);
}

export async function endSupportSessionAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const id = field(form, "session");
  if (!z.uuid().safeParse(id).success) return inputError();
  const result = await endSupportSession(ctx.viewer.db, id);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/partner/${ctx.org.slug}`, "layout");
  revalidatePath(`/${ctx.org.slug}/settings/security`);
  return done(result.data);
}
