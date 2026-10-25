"use server";

import { VIEW_AS_COOKIE } from "@xos/data/access";
import { cancelOrganization, reactivateOrganization } from "@xos/data/lifecycle";
import { grantSupportSession } from "@xos/data/partner";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { env } from "@/lib/env";
import { done, field, inputError, type PlatformActionState } from "@/lib/platform/state";
import { fromDataError } from "@/lib/platform/data-error";
import { contextFor } from "@/lib/platform/action-context";

/**
 * A36's settings actions: grant the partner a support session (Security), start and end View as role
 * (Roles and capabilities), and cancel or reactivate the org (Danger zone). The RPCs decide every rule.
 */

export async function grantSupportSessionAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ hours: z.coerce.number().int().min(1).max(24), reason: z.string().min(1).max(500) })
    .safeParse({ hours: field(form, "hours"), reason: field(form, "reason") });
  if (!parsed.success) return inputError();
  const result = await grantSupportSession(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/settings/security`);
  return done(result.data);
}

export async function startViewAsAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const role = field(form, "role");
  if (!z.uuid().safeParse(role).success) return inputError();
  if (!ctx.capabilities.has("org.view_as_role.use")) return { error: "notFound", at: Date.now() };
  (await cookies()).set(VIEW_AS_COOKIE, `${ctx.org.slug}:${role}`, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: env().ATLAS_SITE_URL.startsWith("https:"),
    maxAge: 60 * 60,
  });
  redirect(`/${ctx.org.slug}/home`);
}

/** Ends a preview from the banner; a plain form, so it works before hydration. */
export async function endViewAsAction(form: FormData): Promise<void> {
  const slug = field(form, "org");
  (await cookies()).delete(VIEW_AS_COOKIE);
  redirect(slug ? `/${slug}/settings/roles-and-capabilities` : "/");
}

export async function cancelOrganizationAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ confirm: z.string().min(1).max(200), reason: z.string().min(1).max(1000) })
    .safeParse({ confirm: field(form, "confirm"), reason: field(form, "reason") });
  if (!parsed.success) return inputError();
  const result = await cancelOrganization(ctx.viewer.db, {
    orgId: ctx.org.id,
    confirmName: parsed.data.confirm,
    reason: parsed.data.reason,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return done(result.data);
}

export async function reactivateOrganizationAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const result = await reactivateOrganization(ctx.viewer.db, ctx.org.id);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return done(result.data);
}
