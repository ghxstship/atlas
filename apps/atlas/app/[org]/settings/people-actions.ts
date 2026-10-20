"use server";

import {
  completeOffboarding,
  createInviteLink,
  decideJoinRequest,
  getOrganizationProfile,
  reassignOffboardingRecords,
  revokeInviteLink,
  updateOrganizationProfile,
} from "@xos/data/profiles";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { env } from "@/lib/env";
import { settingErrorKey } from "@/lib/settings/registry";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Org actions for joining, offboarding and the organization profile (Section 4.8.1, 4.8.2): links,
 * join request decisions, record reassignment, and the profile editor. The RPCs of migrations 0860
 * and 0861 decide every act; refusals come back as `profiles.errors.*` or `settings.errors.*` keys.
 */

export interface PeopleFormState {
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly ok?: boolean;
  readonly link?: string;
}

const KNOWN = new Set([
  "role_band",
  "role_unknown",
  "invite_link_role_band",
  "invite_expiry_range",
  "grant_exceeds_holder",
  "join_request_decided",
  "sod_self_grant",
  "plan_limit_exceeded",
  "seat_limit_reached",
  "seat_limit_upgrade",
  "not_member",
  "offboarding_open_records",
  "offboarding_completed",
  "handle_format",
  "handle_reserved",
  "handle_taken",
  "handle_change_too_soon",
]);

function errorKey(error: Parameters<typeof settingErrorKey>[0]): string {
  if (error.kind === "refusal" && KNOWN.has(error.rule)) return error.rule;
  if (error.kind === "conflict") return "handle_in_use";
  return settingErrorKey(error);
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

export async function createInviteLinkAction(
  _: PeopleFormState,
  form: FormData,
): Promise<PeopleFormState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      roleId: z.uuid(),
      days: z.coerce.number().int().min(1).max(30),
      maxUses: z.coerce.number().int().min(1).max(1000),
    })
    .safeParse({
      roleId: form.get("roleId"),
      days: form.get("days"),
      maxUses: form.get("maxUses"),
    });
  if (!parsed.success) return { fieldErrors: { maxUses: "maxUses" } };
  const result = await createInviteLink(ctx.viewer.db, {
    orgId: ctx.org.id,
    roleId: parsed.data.roleId,
    validForHours: parsed.data.days * 24,
    maxUses: parsed.data.maxUses,
  });
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}/settings/members`);
  return {
    ok: true,
    link: new URL(`/auth/invite/${result.data.token}`, env().ATLAS_SITE_URL).toString(),
  };
}

export async function revokeInviteLinkAction(
  _: PeopleFormState,
  form: FormData,
): Promise<PeopleFormState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("linkId"));
  if (!id.success) return { error: "invalid" };
  const result = await revokeInviteLink(ctx.viewer.db, id.data);
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}/settings/members`);
  return { ok: true };
}

export async function decideJoinRequestAction(
  _: PeopleFormState,
  form: FormData,
): Promise<PeopleFormState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      requestId: z.uuid(),
      decision: z.enum(["approve", "decline"]),
      roleId: z.uuid().optional(),
    })
    .safeParse({
      requestId: form.get("requestId"),
      decision: form.get("decision"),
      roleId: text(form, "roleId") ?? undefined,
    });
  if (!parsed.success) return { error: "invalid" };
  const approve = parsed.data.decision === "approve";
  if (approve && !parsed.data.roleId) return { error: "role_unknown" };
  const result = await decideJoinRequest(ctx.viewer.db, {
    requestId: parsed.data.requestId,
    approve,
    ...(approve && parsed.data.roleId ? { roleId: parsed.data.roleId } : {}),
  });
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}/settings/members`);
  return { ok: true };
}

export async function offboardingAction(
  _: PeopleFormState,
  form: FormData,
): Promise<PeopleFormState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      offboardingId: z.uuid(),
      intent: z.enum(["reassign", "complete"]),
      toPersonId: z.uuid().optional(),
    })
    .safeParse({
      offboardingId: form.get("offboardingId"),
      intent: form.get("intent"),
      toPersonId: text(form, "toPersonId") ?? undefined,
    });
  if (!parsed.success) return { error: "invalid" };
  if (parsed.data.intent === "reassign") {
    if (!parsed.data.toPersonId) return { error: "not_member" };
    const moved = await reassignOffboardingRecords(ctx.viewer.db, {
      offboardingId: parsed.data.offboardingId,
      toPersonId: parsed.data.toPersonId,
    });
    if (!moved.ok) return { error: errorKey(moved.error) };
  } else {
    const completed = await completeOffboarding(ctx.viewer.db, parsed.data.offboardingId);
    if (!completed.ok) return { error: errorKey(completed.error) };
  }
  revalidatePath(`/${ctx.org.slug}/settings/members`);
  return { ok: true };
}

export async function saveOrganizationProfileAction(
  _: PeopleFormState,
  form: FormData,
): Promise<PeopleFormState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      handle: z.string().regex(/^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$/),
      about: z.string().max(4000).nullable(),
      websiteUrl: z.url().startsWith("https://").max(2000).nullable(),
      contactEmail: z.email().max(320).nullable(),
      visibility: z.enum(["Private", "Network", "Public"]),
    })
    .safeParse({
      handle: text(form, "handle")?.toLowerCase() ?? "",
      about: text(form, "about"),
      websiteUrl: text(form, "websiteUrl"),
      contactEmail: text(form, "contactEmail")?.toLowerCase() ?? null,
      visibility: form.get("visibility"),
    });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues)
      fieldErrors[String(issue.path[0])] = String(issue.path[0]);
    return { fieldErrors };
  }
  const current = await getOrganizationProfile(ctx.viewer.db, ctx.org.id, true);
  if (!current.ok) return { error: errorKey(current.error) };
  if (!current.data) return { error: "denied" };
  const result = await updateOrganizationProfile(ctx.viewer.db, current.data.id, {
    ...parsed.data,
    searchIndexing: parsed.data.visibility === "Public" && form.get("searchIndexing") === "on",
  });
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}/settings/organization-profile`);
  return { ok: true };
}
