"use server";

import {
  addAllowedNetwork,
  addLegalEntity,
  blockProfile,
  cancelAccessReview,
  decideAccessReviewItem,
  endBreakGlass,
  makeLegalEntityPrimary,
  openAccessReview,
  removeAllowedNetwork,
  removeLegalEntity,
  startBreakGlass,
  unblock,
} from "@xos/data/access-controls";
import type { DataError, Result } from "@xos/data/result";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Settings actions for the features A52 built (RRR-97): legal entities, the IP allow-list,
 * break-glass, access reviews and blocks. Each resolves the viewer's org context again (404 when
 * gone), so the org's IP allow-list applies here too; row level security and the guards of
 * migrations 1200 to 1207 decide every write, and refusals come back as
 * `settings.accessControls.errors.*` keys.
 */

export interface AccessControlFormState {
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly ok?: boolean;
}

/** Refusal rules with their own sentence in the catalogs; anything else is `unexpected`. */
const KNOWN_RULES = new Set([
  "legal_entity_primary",
  "tax_identifier_format",
  "plan_feature_ip_allowlist",
  "ip_allowlist_last_entry",
  "ip_allowlist_empty",
  "break_glass_reason",
  "break_glass_open",
  "break_glass_closed",
  "break_glass_session_only",
  "step_up_required",
  "access_review_due_past",
  "access_review_decided",
  "access_review_closed",
  "sod_self_review",
  "role_band",
  "block_handle_unknown",
  "block_self",
  "block_own_org",
]);

function errorKey(error: DataError): string {
  if (error.kind === "refusal") return KNOWN_RULES.has(error.rule) ? error.rule : "unexpected";
  if (error.kind === "not-found") return "denied";
  if (error.kind === "conflict") return "conflict";
  if (error.kind === "invalid") return "invalid";
  return "unexpected";
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

function fieldErrors(issues: readonly { path: readonly PropertyKey[] }[]): AccessControlFormState {
  const out: Record<string, string> = {};
  for (const issue of issues) out[String(issue.path[0])] = "invalid";
  return { fieldErrors: out };
}

async function finish(
  slug: string,
  page: string,
  result: Result<unknown>,
): Promise<AccessControlFormState> {
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${slug}/${page}`);
  return { ok: true };
}

const uuid = z.uuid();

// Legal entities ----------------------------------------------------------------------------------------

const entitySchema = z.object({
  legalName: z.string().min(1).max(200),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  taxIdentifier: z.string().min(4).max(40).nullable(),
});

export async function addLegalEntityAction(
  _: AccessControlFormState,
  form: FormData,
): Promise<AccessControlFormState> {
  const ctx = await contextFor(form);
  const parsed = entitySchema.safeParse({
    legalName: text(form, "legalName"),
    countryCode: text(form, "countryCode")?.toUpperCase() ?? null,
    fiscalYearStartMonth: text(form, "fiscalYearStartMonth") ?? "1",
    baseCurrency: text(form, "baseCurrency")?.toUpperCase() ?? null,
    taxIdentifier: text(form, "taxIdentifier"),
  });
  if (!parsed.success) return fieldErrors(parsed.error.issues);
  return finish(
    ctx.org.slug,
    "settings/legal-entities-and-fiscal",
    await addLegalEntity(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data }),
  );
}

export async function legalEntityAction(
  _: AccessControlFormState,
  form: FormData,
): Promise<AccessControlFormState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(form.get("legalEntityId"));
  if (!id.success) return { error: "unexpected" };
  const result =
    form.get("intent") === "remove"
      ? await removeLegalEntity(ctx.viewer.db, id.data)
      : await makeLegalEntityPrimary(ctx.viewer.db, id.data);
  return finish(ctx.org.slug, "settings/legal-entities-and-fiscal", result);
}

// IP allow-list -------------------------------------------------------------------------------------------

const networkSchema = z.object({
  cidr: z
    .string()
    .max(49)
    .regex(/^[0-9A-Fa-f:.]+(\/\d{1,3})?$/),
  label: z.string().min(1).max(100),
});

export async function addNetworkAction(
  _: AccessControlFormState,
  form: FormData,
): Promise<AccessControlFormState> {
  const ctx = await contextFor(form);
  const parsed = networkSchema.safeParse({ cidr: text(form, "cidr"), label: text(form, "label") });
  if (!parsed.success) return fieldErrors(parsed.error.issues);
  const result = await addAllowedNetwork(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok && result.error.kind === "unexpected" && /cidr|inet/i.test(result.error.message)) {
    return { fieldErrors: { cidr: "invalid" } };
  }
  return finish(ctx.org.slug, "settings/security", result);
}

export async function removeNetworkAction(
  _: AccessControlFormState,
  form: FormData,
): Promise<AccessControlFormState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(form.get("networkId"));
  if (!id.success) return { error: "unexpected" };
  return finish(
    ctx.org.slug,
    "settings/security",
    await removeAllowedNetwork(ctx.viewer.db, id.data),
  );
}

// Break-glass ---------------------------------------------------------------------------------------------

export async function startBreakGlassAction(
  _: AccessControlFormState,
  form: FormData,
): Promise<AccessControlFormState> {
  const ctx = await contextFor(form);
  const reason = text(form, "reason");
  if (reason === null || reason.length < 20) return { fieldErrors: { reason: "reason" } };
  return finish(
    ctx.org.slug,
    "settings/security",
    await startBreakGlass(ctx.viewer.db, ctx.org.id, reason),
  );
}

export async function endBreakGlassAction(
  _: AccessControlFormState,
  form: FormData,
): Promise<AccessControlFormState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(form.get("sessionId"));
  if (!id.success) return { error: "unexpected" };
  return finish(ctx.org.slug, "settings/security", await endBreakGlass(ctx.viewer.db, id.data));
}

// Access reviews ------------------------------------------------------------------------------------------

const campaignSchema = z.object({
  name: z.string().min(1).max(200),
  dueOn: z.iso.date(),
});

export async function openAccessReviewAction(
  _: AccessControlFormState,
  form: FormData,
): Promise<AccessControlFormState> {
  const ctx = await contextFor(form);
  const parsed = campaignSchema.safeParse({ name: text(form, "name"), dueOn: text(form, "dueOn") });
  if (!parsed.success) return fieldErrors(parsed.error.issues);
  return finish(
    ctx.org.slug,
    "settings/access-reviews",
    await openAccessReview(ctx.viewer.db, {
      orgId: ctx.org.id,
      ...parsed.data,
      autoRemoveUnreviewed: form.get("autoRemove") === "on",
    }),
  );
}

export async function cancelAccessReviewAction(
  _: AccessControlFormState,
  form: FormData,
): Promise<AccessControlFormState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(form.get("campaignId"));
  if (!id.success) return { error: "unexpected" };
  return finish(
    ctx.org.slug,
    "settings/access-reviews",
    await cancelAccessReview(ctx.viewer.db, id.data),
  );
}

export async function decideAccessReviewAction(
  _: AccessControlFormState,
  form: FormData,
): Promise<AccessControlFormState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(form.get("itemId"));
  const decision = z.enum(["Confirmed", "Removed"]).safeParse(form.get("decision"));
  if (!id.success || !decision.success) return { error: "unexpected" };
  return finish(
    ctx.org.slug,
    "settings/access-reviews",
    await decideAccessReviewItem(ctx.viewer.db, id.data, decision.data),
  );
}

// Blocks ----------------------------------------------------------------------------------------------------

const blockSchema = z.object({
  kind: z.enum(["person", "organization"]),
  handle: z
    .string()
    .min(1)
    .max(80)
    .transform((h) => h.replace(/^@/, "").replace(/^.*\/(u|c)\//, "")),
});

export async function blockProfileAction(
  _: AccessControlFormState,
  form: FormData,
): Promise<AccessControlFormState> {
  const ctx = await contextFor(form);
  const parsed = blockSchema.safeParse({ kind: text(form, "kind"), handle: text(form, "handle") });
  if (!parsed.success) return fieldErrors(parsed.error.issues);
  return finish(
    ctx.org.slug,
    "me/profile-privacy",
    await blockProfile(ctx.viewer.db, parsed.data.kind, parsed.data.handle),
  );
}

export async function unblockAction(
  _: AccessControlFormState,
  form: FormData,
): Promise<AccessControlFormState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(form.get("blockId"));
  if (!id.success) return { error: "unexpected" };
  return finish(ctx.org.slug, "me/profile-privacy", await unblock(ctx.viewer.db, id.data));
}
