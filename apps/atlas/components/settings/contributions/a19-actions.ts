"use server";

import {
  asDbClient,
  createConnection,
  enqueueSync,
  isProviderCode,
  SYNC_SCOPES,
  scopesFor,
  storeCredential,
  transitionConnection,
} from "@xos/integrations";
import type { IntegrationActionState } from "@xos/integrations/settings";
import type { DataError } from "@xos/data";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Server actions of A19's integrations panel (settings.integrations). Each resolves the viewer's org
 * context again (404 when gone) and writes with the viewer's client, so row level security and the
 * RPCs of migration 0600 decide; a refusal comes back as a sentence from `integrations.errors`.
 */

const RULES = new Set([
  "integration_plan_feature",
  "integration_credential_required",
  "integration_credential_expired",
  "integration_credential_empty",
  "integration_credential_too_large",
  "integration_not_connected",
  "integration_sync_in_progress",
  "integration_scope_mismatch",
  "integration_disconnected",
  "integration_connection_state_conflict",
  "integration_connection_transition_not_allowed",
]);

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

async function failure(error: DataError): Promise<IntegrationActionState> {
  const t = await getTranslate();
  const key =
    error.kind === "refusal" && RULES.has(error.rule)
      ? error.rule
      : error.kind === "conflict"
        ? "conflict"
        : error.kind === "invalid"
          ? "invalid"
          : error.kind === "not-found"
            ? "denied"
            : "default";
  return { error: t(`integrations.errors.${key}`) };
}

async function invalid(): Promise<IntegrationActionState> {
  const t = await getTranslate();
  return { error: t("integrations.errors.invalid") };
}

function done(slug: string): IntegrationActionState {
  revalidatePath(`/${slug}/settings/integrations`);
  return { ok: true };
}

export async function createIntegrationAction(
  _: IntegrationActionState,
  form: FormData,
): Promise<IntegrationActionState> {
  const ctx = await contextFor(form);
  const provider = form.get("provider");
  const name = z.string().trim().min(1).max(120).safeParse(form.get("displayName"));
  if (typeof provider !== "string" || !isProviderCode(provider) || !name.success) return invalid();
  const result = await createConnection(asDbClient(ctx.viewer.db), {
    orgId: ctx.org.id,
    providerCode: provider,
    displayName: name.data,
  });
  return result.ok ? done(ctx.org.slug) : failure(result.error);
}

export async function storeIntegrationCredentialAction(
  _: IntegrationActionState,
  form: FormData,
): Promise<IntegrationActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      connectionId: z.uuid(),
      secret: z.string().max(16384),
      kind: z.enum(["OAuth Token", "API Key", "Service Account"]),
    })
    .safeParse({
      connectionId: form.get("connectionId"),
      secret: form.get("secret") ?? "",
      kind: form.get("kind"),
    });
  if (!parsed.success) return invalid();
  const result = await storeCredential(
    asDbClient(ctx.viewer.db),
    parsed.data.connectionId,
    parsed.data.secret.trim(),
    parsed.data.kind,
  );
  return result.ok ? done(ctx.org.slug) : failure(result.error);
}

const STATES = ["Pending", "Connected", "Error", "Paused", "Disconnected"] as const;

export async function transitionIntegrationAction(
  _: IntegrationActionState,
  form: FormData,
): Promise<IntegrationActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ connectionId: z.uuid(), expected: z.enum(STATES), next: z.enum(STATES) })
    .safeParse({
      connectionId: form.get("connectionId"),
      expected: form.get("expected"),
      next: form.get("next"),
    });
  if (!parsed.success) return invalid();
  const t = await getTranslate();
  const reason =
    parsed.data.next === "Disconnected"
      ? t("integrations.settings.reasonDisconnect")
      : parsed.data.next === "Paused"
        ? t("integrations.settings.reasonPause")
        : parsed.data.expected === "Paused"
          ? t("integrations.settings.reasonResume")
          : t("integrations.settings.reasonConnect");
  const result = await transitionConnection(
    asDbClient(ctx.viewer.db),
    parsed.data.connectionId,
    parsed.data.expected,
    parsed.data.next,
    reason,
  );
  return result.ok ? done(ctx.org.slug) : failure(result.error);
}

export async function syncIntegrationAction(
  _: IntegrationActionState,
  form: FormData,
): Promise<IntegrationActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ connectionId: z.uuid(), scope: z.enum(SYNC_SCOPES), provider: z.string() })
    .safeParse({
      connectionId: form.get("connectionId"),
      scope: form.get("scope"),
      provider: form.get("provider") ?? "",
    });
  if (!parsed.success) return invalid();
  const db = asDbClient(ctx.viewer.db);
  const providerScopes = isProviderCode(parsed.data.provider)
    ? scopesFor(parsed.data.provider)
    : SYNC_SCOPES;
  if (!providerScopes.includes(parsed.data.scope)) return invalid();
  const direction =
    parsed.data.scope === "Calendar Sync" || parsed.data.scope === "Payment Sync"
      ? "Two Way"
      : parsed.data.scope === "Ledger Export" ||
          parsed.data.scope === "Notification Delivery" ||
          parsed.data.scope === "Payroll Export"
        ? "Outbound"
        : "Inbound";
  const result = await enqueueSync(db, {
    connectionId: parsed.data.connectionId,
    scope: parsed.data.scope,
    direction,
    idempotencyKey: `atlas-${randomUUID()}`,
  });
  return result.ok ? done(ctx.org.slug) : failure(result.error);
}
