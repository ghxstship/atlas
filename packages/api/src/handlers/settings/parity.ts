/**
 * Settings handlers added for API parity (A04P, ADR 0023), beside A30's settings registry handlers
 * in settings.ts: subscriptions and plans, workspaces and teams with their members, branding, roles
 * and capabilities, grants, delegations, spend authority, the access registries, API keys, service
 * accounts, webhooks, the audit ledger, consent records, data subject requests and retention.
 * Tables are read and written as the caller within its column grants; API keys, service accounts
 * and webhook endpoints are created through their RPCs, which return a secret once, and webhook
 * replays go through app.replay_webhook_delivery. Fields without an update grant are refused with
 * 422 before they reach the database.
 */
import type { Components } from "../../contract/operations.generated.ts";
import { requireOrg } from "../../runtime/context.ts";
import type { RequestContext } from "../../runtime/context.ts";
import { assertIfMatch } from "../../runtime/etag.ts";
import type { HandlerSet } from "../../runtime/handler.ts";
import { accepted, created, noContent, ok } from "../../runtime/handler.ts";
import { from, handlersFor, rpc, run, tableResource } from "../support/table.ts";
import type { Row } from "../support/table.ts";

// API keys ------------------------------------------------------------------------------------------

const orgExports = tableResource("orgExports", { softDelete: false, verbs: ["list", "get"] });

const apiKeys = tableResource("apiKeys", {
  verbs: ["list", "get", "update"],
  fixed: ["service_account_id"],
});

async function createKey(
  context: RequestContext,
  input: {
    name: string;
    scopes: readonly string[];
    expires_at: string;
    service_account_id?: string | null;
  },
) {
  const rows = await run<{ api_key_id: string; secret: string }[]>(
    rpc(context.db, "create_api_key", {
      p_org_id: requireOrg(context).id,
      p_name: input.name,
      p_scopes: [...input.scopes],
      p_expires_at: input.expires_at,
      ...((input.service_account_id ?? null) === null
        ? {}
        : { p_service_account_id: input.service_account_id }),
    }),
  );
  const row = rows[0];
  if (row === undefined) throw new Error("create_api_key returned no row.");
  return row;
}

// Service accounts and webhook endpoints -------------------------------------------------------------

const serviceAccounts = tableResource("serviceAccounts", { verbs: ["list", "get", "update"] });

async function eventsOf(context: RequestContext, endpointId: unknown): Promise<string[]> {
  const rows = await run<{ event_type: string }[]>(
    from(context.db, "webhook_endpoint_events")
      .select("event_type")
      .eq("webhook_endpoint_id", endpointId)
      .is("deleted_at", null)
      .order("event_type", { ascending: true }),
  );
  return rows.map((r) => r.event_type);
}

const webhookEndpoints = tableResource("webhookEndpoints", {
  verbs: ["list", "get", "delete"],
  derived: ["events"],
  toContract: async (row, context) => ({ ...row, events: await eventsOf(context, row["id"]) }),
});

const webhookDeliveries = tableResource("webhookDeliveries", { verbs: ["list", "get"] });

// Handlers ----------------------------------------------------------------------------------------------

const tenantWithDerivedOrg = { orgColumn: false } as const;

export const settingsParity = {
  ...handlersFor("Settings", tableResource("subscriptions", { verbs: ["list", "get"] })),
  ...handlersFor("Settings", tableResource("plans", { softDelete: false })),

  ...handlersFor("Settings", tableResource("workspaces")),
  ...handlersFor("Settings", tableResource("workspaceMembers", tenantWithDerivedOrg)),
  ...handlersFor("Settings", tableResource("teams")),
  ...handlersFor("Settings", tableResource("teamMembers", tenantWithDerivedOrg)),
  ...handlersFor("Settings", tableResource("orgBrandings")),

  ...handlersFor("Settings", tableResource("roles", { fixed: ["band"] })),
  ...handlersFor("Settings", tableResource("capabilities", { softDelete: false })),
  ...handlersFor("Settings", tableResource("roleCapabilities", tenantWithDerivedOrg)),
  ...handlersFor(
    "Settings",
    tableResource("userCapabilityGrants", {
      orgColumn: false,
      fixed: ["valid_from", "scope_kind", "scope_id", "reason"],
    }),
  ),
  ...handlersFor(
    "Settings",
    tableResource("recordGrants", {
      orgColumn: false,
      fixed: ["capability_code", "grantee_person_id", "grantee_org_id", "valid_from", "reason"],
    }),
  ),
  ...handlersFor(
    "Settings",
    tableResource("delegations", {
      orgColumn: false,
      fixed: ["valid_from", "capability_code", "reason"],
    }),
  ),
  ...handlersFor("Settings", tableResource("spendAuthorityLimits")),
  ...handlersFor("Settings", tableResource("separationOfDutiesRules", { softDelete: false })),
  ...handlersFor(
    "Settings",
    tableResource("columnClassifications", { softDelete: false, key: "column_name" }),
  ),

  ...handlersFor("Settings", apiKeys),
  "apiKeys.create": async ({ body }, context) => created(await createKey(context, body)),
  "apiKeys.revoke": async ({ params }, context) => {
    await apiKeys.read(context, params.id, ["id"]);
    await run(rpc(context.db, "revoke_api_key", { p_api_key_id: params.id }));
    return ok((await apiKeys.read(context, params.id)) as Components["ApiKey"]);
  },
  // Rotation issues a new key with the same name, scopes, expiry and service account, then revokes
  // the old one; the new secret is shown once.
  "apiKeys.rotate": async ({ params }, context) => {
    const current = (await apiKeys.read(context, params.id)) as Components["ApiKey"];
    const next = await createKey(context, current);
    await run(rpc(context.db, "revoke_api_key", { p_api_key_id: params.id }));
    return ok(next);
  },

  ...handlersFor("Settings", serviceAccounts),
  "serviceAccounts.create": async ({ body }, context) => {
    const id = await run<string>(
      rpc(context.db, "create_service_account", {
        p_org_id: requireOrg(context).id,
        p_name: body.name,
        p_role_id: body.role_id,
        ...((body.expires_at ?? null) === null ? {} : { p_expires_at: body.expires_at }),
      }),
    );
    return created((await serviceAccounts.read(context, id)) as Components["ServiceAccount"]);
  },
  // A service account is never deleted; removing it retires it (app.retire_service_account),
  // which revokes its keys and ends its membership.
  "serviceAccounts.delete": async ({ params }, context) => {
    await serviceAccounts.read(context, params.id, ["id"]);
    await run(rpc(context.db, "retire_service_account", { p_service_account_id: params.id }));
    return noContent();
  },

  ...handlersFor("Settings", webhookEndpoints),
  "webhookEndpoints.create": async ({ body }, context) => {
    const rows = await run<{ webhook_endpoint_id: string; signing_secret: string }[]>(
      rpc(context.db, "create_webhook_endpoint", {
        p_org_id: requireOrg(context).id,
        p_url: body.url,
        p_event_types: [...body.events],
        ...((body.description ?? null) === null ? {} : { p_description: body.description }),
      }),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("create_webhook_endpoint returned no row.");
    return created(row);
  },
  "webhookEndpoints.update": async ({ params, body, ifMatch }, context) => {
    const current = await webhookEndpoints.read(context, params.id);
    assertIfMatch(ifMatch ?? "*", current);
    const patch: Row = {};
    for (const field of ["url", "description", "disabled_at"] as const) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (Object.keys(patch).length > 0) {
      await run(from(context.db, "webhook_endpoints").update(patch).eq("id", params.id));
    }
    if (body.events !== undefined) {
      const held = current["events"] as string[];
      const removed = held.filter((e) => !body.events?.includes(e));
      const added = body.events.filter((e) => !held.includes(e));
      if (removed.length > 0) {
        await run(
          from(context.db, "webhook_endpoint_events")
            .update({ deleted_at: new Date().toISOString() })
            .eq("webhook_endpoint_id", params.id)
            .in("event_type", removed)
            .is("deleted_at", null),
        );
      }
      if (added.length > 0) {
        await run(
          from(context.db, "webhook_endpoint_events").insert(
            added.map((event_type) => ({ webhook_endpoint_id: params.id, event_type })),
          ),
        );
      }
    }
    return ok((await webhookEndpoints.read(context, params.id)) as Components["WebhookEndpoint"]);
  },

  ...handlersFor("Settings", webhookDeliveries),
  "webhookDeliveries.replay": async ({ params }, context) => {
    await webhookDeliveries.read(context, params.id, ["id"]);
    await run(rpc(context.db, "replay_webhook_delivery", { p_delivery_id: params.id }));
    return accepted(
      (await webhookDeliveries.read(context, params.id)) as Components["WebhookDelivery"],
    );
  },
  ...handlersFor("Settings", tableResource("webhookEventTypes", { softDelete: false })),

  ...handlersFor("Settings", tableResource("auditEvents", { softDelete: false })),
  ...handlersFor("Settings", tableResource("consentRecords", { orgColumn: true })),
  ...handlersFor("Settings", tableResource("dsarRequests")),
  ...handlersFor("Settings", tableResource("retentionPolicies", { softDelete: false })),

  // Full org exports (Section 14.7): the Owner builds the archive with their own row level security
  // and logs it with its counts and manifest hash (app.record_org_export, 1063). Append-only.
  ...handlersFor("Settings", orgExports),
  "orgExports.create": async ({ body }, context) => {
    const exportId = await run<string>(
      rpc(context.db, "record_org_export", {
        p_org_id: requireOrg(context).id,
        p_table_count: body.table_count,
        p_row_count: body.row_count,
        p_file_count: body.file_count,
        p_manifest_sha256: body.manifest_sha256,
      }),
    );
    return created((await orgExports.read(context, exportId)) as Components["OrgExport"]);
  },
} satisfies HandlerSet<"Settings">;
