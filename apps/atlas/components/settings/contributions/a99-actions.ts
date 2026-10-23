"use server";

import type { DataError } from "@xos/data";
import { registerOAuthApp, removeOAuthApp } from "@xos/data/oauth";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";

/**
 * OAuth apps on org settings (A99, RRR-144; ADR 0055). Each action resolves the viewer's org context again (404 when
 * gone); the RPCs and row level security decide every write. Org API keys are A86's panel and actions
 * (app/[org]/settings/surface-actions.ts). Refusals come back as `authSecurity.errors.*` keys.
 */

export interface OrgSecurityState {
  readonly ok?: boolean;
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly at?: number;
}

const KNOWN = new Set(["step_up_required", "plan_feature_required"]);

function errorKey(error: DataError): string {
  if (error.kind === "refusal") return KNOWN.has(error.rule) ? error.rule : "unexpected";
  if (error.kind === "not-found") return "denied";
  if (error.kind === "invalid") return "invalid";
  if (error.kind === "conflict") return "conflict";
  console.error("org security action failed", error);
  return "unexpected";
}

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

const refused = (error: string): OrgSecurityState => ({ error, at: Date.now() });

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
