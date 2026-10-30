"use server";

import type { DataError } from "@xos/data";
import { registerMcpConnector } from "@xos/data/agent-proposals";
import {
  addBlocklistEntry,
  blocklistRefusal,
  removeBlocklistEntry,
} from "@xos/data/member-blocklist";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { applyAgentProposal, rejectAgentProposal } from "@/lib/mcp/apply";
import { mcpPreset, mcpServerUrl } from "@/lib/mcp/connectors";
import { contextFor } from "@/lib/platform/action-context";
import { observability } from "@/lib/observability";

/**
 * B16's settings actions (RRR-240, ADR 0155): the member blocklist (3050), registering an MCP connector (3052) and
 * confirming or rejecting what a connected app proposed (3052). Each resolves the viewer's org context again (404 when
 * gone) and lets the database decide; refusals come back as copy of their namespace, never a raw message.
 */

export interface B16State {
  readonly ok?: boolean;
  /** Copy to show: the outcome, or why it was refused. */
  readonly message?: string;
  readonly at?: number;
  /** A registered connector's values, shown once. */
  readonly connector?: {
    readonly kind: string;
    readonly clientId: string;
    readonly serverUrl: string;
  };
}

type T = ((key: string, values?: Record<string, string | number>) => string) & {
  has?: (key: string) => boolean;
};

async function copy(namespace: string): Promise<T> {
  return (await getTranslations(namespace as never)) as unknown as T;
}

function refusalKey(error: DataError, known: (rule: string) => boolean): string {
  if (error.kind === "refusal") return known(error.rule) ? error.rule : "unexpected";
  if (error.kind === "not-found") return "denied";
  observability.logger.error("a B16 settings action failed", { error });
  return "unexpected";
}

// Blocklist ------------------------------------------------------------------------------------------------------

const blocklistSchema = z.object({
  kind: z.enum(["Email", "Domain"]),
  value: z.string().trim().min(1).max(320),
  reason: z.string().trim().max(500).optional(),
});

export async function addBlocklistEntryAction(_: B16State, form: FormData): Promise<B16State> {
  const ctx = await contextFor(form);
  const t = await copy("memberBlocklist");
  const parsed = blocklistSchema.safeParse({
    kind: form.get("kind"),
    value: form.get("value"),
    reason: (form.get("reason") as string | null) ?? undefined,
  });
  if (!parsed.success) return { message: t("errors.blocklist_value_invalid"), at: Date.now() };
  const result = await addBlocklistEntry(ctx.viewer.db, {
    orgId: ctx.org.id,
    kind: parsed.data.kind,
    value: parsed.data.value,
    reason: parsed.data.reason || null,
  });
  if (!result.ok) {
    const key = refusalKey(
      result.error,
      (r) => blocklistRefusal(r) !== null || r === "org_read_only",
    );
    return { message: t(`errors.${key}`), at: Date.now() };
  }
  revalidatePath(`/${ctx.org.slug}/settings/members`);
  return {
    ok: true,
    message: t("added", {
      invites: result.data.invitesRevoked,
      requests: result.data.requestsDeclined,
    }),
    at: Date.now(),
  };
}

export async function removeBlocklistEntryAction(_: B16State, form: FormData): Promise<B16State> {
  const ctx = await contextFor(form);
  const t = await copy("memberBlocklist");
  const id = z.uuid().safeParse(form.get("entryId"));
  if (!id.success) return { message: t("errors.unexpected"), at: Date.now() };
  const result = await removeBlocklistEntry(ctx.viewer.db, id.data);
  if (!result.ok) {
    return {
      message: t(`errors.${refusalKey(result.error, (r) => r === "org_read_only")}`),
      at: Date.now(),
    };
  }
  revalidatePath(`/${ctx.org.slug}/settings/members`);
  return { ok: true, message: t("removed"), at: Date.now() };
}

// MCP connectors -----------------------------------------------------------------------------------------------

const CONNECTOR_REFUSALS = new Set([
  "mcp_scope_restricted",
  "mcp_redirect_uri_invalid",
  "mcp_client_kind_required",
  "oauth_scope_unknown",
  "oauth_scope_missing",
  "org_read_only",
]);

export async function registerMcpConnectorAction(_: B16State, form: FormData): Promise<B16State> {
  const ctx = await contextFor(form);
  const t = await copy("mcpConnectors");
  const parsed = z
    .object({
      kind: z.enum(["Claude", "ChatGPT", "Other"]),
      name: z.string().trim().max(120).optional(),
      redirectUri: z.string().trim().max(2000).optional(),
      scopes: z
        .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
        .min(1)
        .max(40),
    })
    .safeParse({
      kind: form.get("kind"),
      name: (form.get("name") as string | null) ?? undefined,
      redirectUri: (form.get("redirectUri") as string | null) ?? undefined,
      scopes: form.getAll("scope"),
    });
  if (!parsed.success) return { message: t("errors.oauth_scope_missing"), at: Date.now() };
  const preset = mcpPreset(parsed.data.kind);
  const redirectUri = preset?.redirectUri ?? parsed.data.redirectUri ?? "";
  const result = await registerMcpConnector(ctx.viewer.db, {
    orgId: ctx.org.id,
    kind: parsed.data.kind,
    name: parsed.data.name || null,
    redirectUri,
    defaultScopes: parsed.data.scopes,
  });
  if (!result.ok) {
    return {
      message: t(`errors.${refusalKey(result.error, (r) => CONNECTOR_REFUSALS.has(r))}`),
      at: Date.now(),
    };
  }
  revalidatePath(`/${ctx.org.slug}/settings/integrations`);
  return {
    ok: true,
    message: t("registered"),
    connector: {
      kind: parsed.data.kind,
      clientId: result.data.clientId,
      serverUrl: mcpServerUrl(env()),
    },
    at: Date.now(),
  };
}

// Proposals ----------------------------------------------------------------------------------------------------

async function decide(form: FormData, confirm: boolean): Promise<B16State> {
  const ctx = await contextFor(form);
  const t = await copy("agentChanges");
  const id = z.uuid().safeParse(form.get("suggestionId"));
  if (!id.success) return { message: t("refusals.ai_suggestion_not_proposed"), at: Date.now() };
  const outcome = confirm
    ? await applyAgentProposal(ctx.viewer.db, id.data, {
        org: { id: ctx.org.id, slug: ctx.org.slug },
        incoming: await headers(),
      })
    : await rejectAgentProposal(ctx.viewer.db, id.data);
  // The list keeps the decided proposal until the next visit, so its outcome stays where the person read it.
  if (outcome.ok)
    return { ok: true, message: t(confirm ? "confirmed" : "rejected"), at: Date.now() };
  const key = `refusals.${outcome.rule}`;
  const known = (t as { has?: (k: string) => boolean }).has?.(key) ?? false;
  return {
    message:
      known && outcome.rule !== "other"
        ? t(key)
        : t("refusals.other", { detail: outcome.detail ?? outcome.rule }),
    at: Date.now(),
  };
}

export async function confirmAgentProposalAction(_: B16State, form: FormData): Promise<B16State> {
  return decide(form, true);
}

export async function rejectAgentProposalAction(_: B16State, form: FormData): Promise<B16State> {
  return decide(form, false);
}
