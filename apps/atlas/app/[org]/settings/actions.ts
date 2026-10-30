"use server";

import {
  endMembership,
  inviteMember,
  renameOrganization,
  revokeInvite,
  setMemberRole,
  type DataError,
} from "@xos/data";
import { requireSecondFactor } from "@xos/data/auth-assurance";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { checkAccent, HEX_COLOR, type AccentCheck } from "@/lib/brand/contrast";
import { getOrgContext } from "@/lib/shell/context";
import { env } from "@/lib/env";

/**
 * Org settings actions. Each one resolves the viewer's org context again (404 when it is gone) and
 * calls the repository; row level security, the RPCs and the guards of migrations 0204 to 0206
 * decide every write and their refusals come back as catalog keys under
 * `shell.settings.members.errors`.
 */

export interface SettingsState {
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly ok?: boolean;
  readonly invite?: { readonly email: string; readonly link: string; readonly expiresAt: string };
}

const KNOWN_REFUSALS = new Set([
  "role_band",
  "role_unknown",
  "sod_self_grant",
  "invite_expiry_range",
  "grant_exceeds_holder",
  "sole_owner",
  "plan_limit_exceeded",
  "seat_limit_reached",
  "seat_limit_upgrade",
  "not_member",
  "step_up_required",
  // The org blocklist (B16, 3050): the inviter hears why.
  "invite_blocked",
]);

function errorKey(error: DataError): string {
  if (error.kind === "refusal") return KNOWN_REFUSALS.has(error.rule) ? error.rule : "unexpected";
  if (error.kind === "not-found") return "not-found";
  return "unexpected";
}

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

export async function renameOrganizationAction(
  _: SettingsState,
  form: FormData,
): Promise<SettingsState> {
  const ctx = await contextFor(form);
  const name = z.string().trim().min(1).max(200).safeParse(form.get("name"));
  if (!name.success) return { fieldErrors: { name: "orgName" } };
  const result = await renameOrganization(ctx.viewer.db, ctx.org.id, name.data);
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

export async function inviteMemberAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      email: z.email().max(320),
      roleId: z.uuid(),
      days: z.coerce.number().int().min(1).max(30),
    })
    .safeParse({ email: form.get("email"), roleId: form.get("roleId"), days: form.get("days") });
  if (!parsed.success) return { fieldErrors: { email: "email" } };
  const result = await inviteMember(ctx.viewer.db, {
    orgId: ctx.org.id,
    email: parsed.data.email,
    roleId: parsed.data.roleId,
    validForHours: parsed.data.days * 24,
  });
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}/settings/members`);
  return {
    ok: true,
    invite: {
      email: parsed.data.email,
      link: new URL(`/auth/invite/${result.data.token}`, env().ATLAS_SITE_URL).toString(),
      expiresAt: new Date(Date.now() + parsed.data.days * 86_400_000).toISOString(),
    },
  };
}

export async function revokeInviteAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("inviteId"));
  if (!id.success) return { error: "not-found" };
  const result = await revokeInvite(ctx.viewer.db, id.data);
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}/settings/members`);
  return { ok: true };
}

export async function setMemberRoleAction(
  _: SettingsState,
  form: FormData,
): Promise<SettingsState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ membershipId: z.uuid(), roleId: z.uuid() })
    .safeParse({ membershipId: form.get("membershipId"), roleId: form.get("roleId") });
  if (!parsed.success) return { error: "not-found" };
  // A role change asks for a second factor in the last 15 minutes (S9-08, migration 1562); checking first opens the
  // step-up dialog before any write, and the role guard refuses on its own.
  const check = await requireSecondFactor(ctx.viewer.db);
  if (!check.ok) return { error: check.rule };
  const result = await setMemberRole(ctx.viewer.db, parsed.data);
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}/settings/members`);
  return { ok: true };
}

export async function removeMemberAction(_: SettingsState, form: FormData): Promise<SettingsState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("membershipId"));
  if (!id.success) return { error: "not-found" };
  const result = await endMembership(ctx.viewer.db, id.data);
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}/settings/members`);
  return { ok: true };
}

/** The live contrast gate behind the White Label editor (Section 12). */
export async function checkAccentAction(accent: string): Promise<AccentCheck | null> {
  return HEX_COLOR.test(accent) ? checkAccent(accent) : null;
}
