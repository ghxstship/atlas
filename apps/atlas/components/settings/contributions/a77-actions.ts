"use server";

import type { DataError } from "@xos/data";
import {
  addIdentityProvider,
  issueScimToken,
  updateIdentityProvider,
} from "@xos/data/identity-providers";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { observability } from "@/lib/observability";

/**
 * Enterprise single sign-on and SCIM on Settings, Security (A77, Section 9). Each action resolves the viewer's org
 * context again (404 when gone); row level security and the 0638 guards decide every write, and refusals come back
 * as `authSecurity.errors.*` keys. Issuing a SCIM token needs step-up; the form answers that with the step-up dialog.
 */

export interface ProviderState {
  readonly ok?: boolean;
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /** A SCIM token, shown once. */
  readonly token?: string;
  readonly at?: number;
}

const KNOWN = new Set([
  "integration_plan_feature",
  "sso_default_role_owner",
  "step_up_required",
  "cross_org_reference",
]);

function errorKey(error: DataError): string {
  if (error.kind === "refusal") {
    return KNOWN.has(error.rule)
      ? error.rule === "cross_org_reference"
        ? "invalid"
        : error.rule
      : "unexpected";
  }
  if (error.kind === "not-found") return "denied";
  if (error.kind === "conflict") return "conflict";
  if (error.kind === "invalid") return "invalid";
  observability.logger.error("identity provider action failed", { error: error });
  return "unexpected";
}

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

const finished = (slug: string, extra: ProviderState = {}): ProviderState => {
  revalidatePath(`/${slug}/settings/security`);
  return { ok: true, at: Date.now(), ...extra };
};

const uuid = z.uuid();
const providerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  protocol: z.enum(["SAML", "OIDC"]),
  authProviderId: z.string().trim().min(1).max(200),
  defaultRoleId: uuid,
});

export async function addProviderAction(_: ProviderState, form: FormData): Promise<ProviderState> {
  const ctx = await contextFor(form);
  const parsed = providerSchema.safeParse({
    name: form.get("name"),
    protocol: form.get("protocol"),
    authProviderId: form.get("authProviderId"),
    defaultRoleId: form.get("defaultRoleId"),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = "invalid";
    return { fieldErrors, at: Date.now() };
  }
  const result = await addIdentityProvider(ctx.viewer.db, {
    orgId: ctx.org.id,
    ...parsed.data,
    jitEnabled: form.get("jit") === "on",
    scimEnabled: form.get("scim") === "on",
  });
  if (!result.ok) return { error: errorKey(result.error), at: Date.now() };
  return finished(ctx.org.slug);
}

export async function updateProviderAction(
  _: ProviderState,
  form: FormData,
): Promise<ProviderState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(form.get("providerId"));
  const role = uuid.safeParse(form.get("defaultRoleId"));
  if (!id.success || !role.success) return { error: "invalid", at: Date.now() };
  const result = await updateIdentityProvider(ctx.viewer.db, id.data, {
    defaultRoleId: role.data,
    jitEnabled: form.get("jit") === "on",
    scimEnabled: form.get("scim") === "on",
  });
  if (!result.ok) return { error: errorKey(result.error), at: Date.now() };
  return finished(ctx.org.slug);
}

export async function issueScimTokenAction(
  _: ProviderState,
  form: FormData,
): Promise<ProviderState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(form.get("providerId"));
  if (!id.success) return { error: "invalid", at: Date.now() };
  const result = await issueScimToken(ctx.viewer.db, id.data);
  if (!result.ok) return { error: errorKey(result.error), at: Date.now() };
  return finished(ctx.org.slug, { token: result.data });
}
