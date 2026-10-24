"use server";

import type { DataError } from "@xos/data";
import { createApiKey, revokeApiKey } from "@xos/data/api-keys";
import { requireSecondFactor } from "@xos/data/auth-assurance";
import { registerOAuthApp, removeOAuthApp } from "@xos/data/oauth";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { observability } from "@/lib/observability";

/**
 * API keys and OAuth apps on org settings (A99, RRR-144; ADR 0055). Each action resolves the viewer's org context again
 * (404 when gone); the RPCs and row level security decide every write. Creating an API key asks for step-up (S9-08):
 * the action checks first so the form opens the step-up dialog at once, and app.create_api_key refuses on its own.
 * Refusals come back as `authSecurity.errors.*` keys.
 */

export interface OrgSecurityState {
  readonly ok?: boolean;
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /** A new API key's secret, shown once. */
  readonly secret?: string;
  readonly at?: number;
}

const KNOWN = new Set([
  "step_up_required",
  "plan_feature_required",
  "api_key_scope_unknown",
  "api_key_expiry_invalid",
  "api_key_revoked",
]);

function errorKey(error: DataError): string {
  if (error.kind === "refusal") return KNOWN.has(error.rule) ? error.rule : "unexpected";
  if (error.kind === "not-found") return "denied";
  if (error.kind === "invalid") return "invalid";
  if (error.kind === "conflict") return "conflict";
  observability.logger.error("org security action failed", { error: error });
  return "unexpected";
}

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

const refused = (error: string): OrgSecurityState => ({ error, at: Date.now() });

const keySchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z
    .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
    .min(1)
    .max(40),
  days: z.coerce
    .number()
    .int()
    .refine((d) => [30, 90, 180, 365].includes(d)),
});

export async function createApiKeyAction(
  _: OrgSecurityState,
  form: FormData,
): Promise<OrgSecurityState> {
  const ctx = await contextFor(form);
  const parsed = keySchema.safeParse({
    name: form.get("name"),
    scopes: form.getAll("scopes"),
    days: form.get("days"),
  });
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[String(issue.path[0])] = "invalid";
    return { fieldErrors: fields, at: Date.now() };
  }
  const check = await requireSecondFactor(ctx.viewer.db);
  if (!check.ok) return refused(check.rule);
  const result = await createApiKey(ctx.viewer.db, {
    orgId: ctx.org.id,
    name: parsed.data.name,
    scopes: parsed.data.scopes,
    expiresAt: new Date(Date.now() + parsed.data.days * 86_400_000).toISOString(),
  });
  if (!result.ok) return refused(errorKey(result.error));
  // No revalidation yet: the secret stays on screen until the person saved it.
  return { ok: true, secret: result.data.secret, at: Date.now() };
}

export async function apiKeySavedAction(form: FormData): Promise<void> {
  const ctx = await contextFor(form);
  revalidatePath(`/${ctx.org.slug}/settings/api-keys-and-service-accounts`);
}

export async function revokeApiKeyAction(
  _: OrgSecurityState,
  form: FormData,
): Promise<OrgSecurityState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("apiKeyId"));
  if (!id.success) return refused("unexpected");
  const result = await revokeApiKey(ctx.viewer.db, id.data);
  if (!result.ok) return refused(errorKey(result.error));
  revalidatePath(`/${ctx.org.slug}/settings/api-keys-and-service-accounts`);
  return { ok: true, at: Date.now() };
}

const appSchema = z.object({
  name: z.string().trim().min(1).max(120),
  redirectUri: z
    .string()
    .trim()
    .max(2000)
    .refine(
      (uri) =>
        !uri.includes("#") &&
        (/^https:\/\/[^/?#\s]+/.test(uri) ||
          /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]+)?(\/|$)/.test(uri)),
    ),
});

export async function registerOAuthAppAction(
  _: OrgSecurityState,
  form: FormData,
): Promise<OrgSecurityState> {
  const ctx = await contextFor(form);
  const parsed = appSchema.safeParse({
    name: form.get("name"),
    redirectUri: form.get("redirectUri"),
  });
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[String(issue.path[0])] = "invalid";
    return { fieldErrors: fields, at: Date.now() };
  }
  const result = await registerOAuthApp(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return refused(errorKey(result.error));
  revalidatePath(`/${ctx.org.slug}/settings/integrations`);
  return { ok: true, at: Date.now() };
}

export async function removeOAuthAppAction(
  _: OrgSecurityState,
  form: FormData,
): Promise<OrgSecurityState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("appId"));
  if (!id.success) return refused("unexpected");
  const result = await removeOAuthApp(ctx.viewer.db, id.data);
  if (!result.ok) return refused(errorKey(result.error));
  revalidatePath(`/${ctx.org.slug}/settings/integrations`);
  return { ok: true, at: Date.now() };
}
