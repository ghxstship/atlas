/**
 * The integrations part of the Settings module (A19): corrections to the frozen integrations and
 * SCIM group mapping resources (ADR 0023) so each shape matches its table in 0600 and 0638, and the
 * actions that connect, credential and sync an integration. catalog/modules/settings.ts spreads these
 * beside A30's Settings corrections. OAuth apps and grants already match app.oauth_apps and
 * app.oauth_grants (0638) and need no correction.
 */
import { z } from "@hono/zod-openapi";
import { fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import type { CorrectionInput } from "../../corrections.ts";
import { all, editShape, orNull, setTable } from "../../correct.ts";
import { itemAction } from "../../define.ts";
import type { ActionSpec } from "../../types.ts";

const SINCE = "1.0.0-draft.2";

const CONNECTION_STATES = ["Pending", "Connected", "Error", "Paused", "Disconnected"] as const;
const SYNC_SCOPES = [
  "Ledger Export",
  "Payment Sync",
  "Calendar Sync",
  "File Import",
  "Notification Delivery",
  "Payroll Export",
  "Tracking Refresh",
  "Attendance Import",
] as const;

const connectionState = (description: string) =>
  z.enum(CONNECTION_STATES).meta({ description, example: "Connected" });

const errorCode = (description: string) =>
  orNull(
    z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .meta({ description, example: "credential_refused" }),
  );

export const integrationCorrections: readonly CorrectionInput[] = [
  {
    id: "integration-connection-columns",
    since: SINCE,
    resources: ["integrations"],
    change:
      "Serves app.integration_connections: `provider` becomes `provider_code`; adds `display_name` (required on create), `external_account_id`, and the server-set `connection_state`, `credential_kind`, `credential_expires_at`, `last_error_code` and `last_error_message`; removes `enabled` and `sync_status` (the connection state carries both).",
    reason:
      "app.integration_connections (0600) has a lifecycle (Pending, Connected, Error, Paused, Disconnected) instead of an enabled flag and sync status, a display name, the provider account id and non-secret credential metadata. Credentials stay in Vault.",
    apply: all(
      setTable("app.integration_connections"),
      editShape({
        rename: { provider: "provider_code" },
        remove: ["enabled", "sync_status"],
        add: {
          display_name: {
            schema: fields.text("Name the org gives the connection.", "Northwind Xero", 120),
            create: "required",
          },
          external_account_id: {
            schema: orNull(
              fields.text("Provider tenant, company or workspace id.", "tenant-nwl", 255),
            ),
            create: "optional",
          },
          connection_state: {
            schema: connectionState("Connection state; changes through the transitions action."),
          },
          credential_kind: {
            schema: orNull(
              z.enum(["OAuth Token", "API Key", "Service Account"]).meta({
                description: "Kind of the stored Vault credential.",
                example: "OAuth Token",
              }),
            ),
          },
          credential_expires_at: {
            schema: orNull(fields.instant("When the stored credential expires.")),
          },
          last_error_code: { schema: errorCode("Rule code of the last connection error.") },
          last_error_message: {
            schema: orNull(
              fields.text(
                "Provider message of the last connection error.",
                "Xero refused the token.",
                1000,
              ),
            ),
          },
        },
        serverSet: [
          "connection_state",
          "credential_kind",
          "credential_expires_at",
          "last_error_code",
          "last_error_message",
        ],
        immutable: ["provider_code"],
        description:
          "An integration connection (Section 17). Credentials are stored in Supabase Vault through the credential action and never returned.",
      }),
    ),
  },
  {
    id: "scim-group-mapping-provider",
    since: SINCE,
    resources: ["scimGroupMappings"],
    change: "Adds `identity_provider_id` (required on create, immutable).",
    reason:
      "app.scim_group_mappings (0638) belongs to one identity provider; its NOT NULL identity_provider_id has no default.",
    apply: editShape({
      add: {
        identity_provider_id: {
          schema: fields.ref("identity provider"),
          create: "required",
          update: false,
        },
      },
    }),
  },
];

const TransitionBody = z
  .object({
    expected_state: connectionState("State the connection is in now (compare-and-set)."),
    next_state: connectionState("State to move to."),
    reason: fields.text("Why the connection changes state.", "Authorized in Xero.", 500),
  })
  .meta({
    id: "IntegrationTransition",
    description: "A connection state change with compare-and-set.",
  });

const CredentialBody = z
  .object({
    secret: z.string().min(1).max(16384).meta({
      description:
        "The provider secret or OAuth token set. Write-only: stored in Vault, never returned.",
      example: '{"access_token":"..."}',
    }),
    kind: z
      .enum(["OAuth Token", "API Key", "Service Account"])
      .meta({ description: "Kind of secret.", example: "OAuth Token" }),
    expires_at: orNull(
      fields.instant("When the secret expires, when the provider says."),
    ).optional(),
  })
  .meta({
    id: "IntegrationCredential",
    description: "A credential to store in Vault for a connection.",
  });

const SyncBody = z
  .object({
    scope: z.enum(SYNC_SCOPES).meta({
      description: "What to sync; must belong to the connection's category.",
      example: "Ledger Export",
    }),
    direction: z
      .enum(["Inbound", "Outbound", "Two Way"])
      .meta({ description: "Direction of the sync.", example: "Outbound" }),
    project_id: orNull(fields.ref("project")).optional(),
  })
  .meta({
    id: "IntegrationSyncRequest",
    description: "A sync run to queue. The Idempotency-Key makes queueing safe to repeat.",
  });

const SyncQueued = z
  .object({ sync_run_id: fields.ref("sync run") })
  .meta({ id: "IntegrationSyncQueued", description: "The queued sync run." });

export const integrationActions: Readonly<Record<string, readonly ActionSpec[]>> = {
  integrations: [
    itemAction("transition", {
      segment: "transitions",
      summary: "Change an integration's state",
      description:
        "Moves a connection with compare-and-set: connect (needs a stored, unexpired credential unless the provider needs none), pause, resume or disconnect (destroys the Vault secret and cancels queued runs).",
      body: TransitionBody,
    }),
    itemAction("storeCredential", {
      segment: "credential",
      summary: "Store an integration credential",
      description:
        "Stores or rotates the connection's secret in Supabase Vault. The secret is never returned.",
      body: CredentialBody,
    }),
    itemAction("sync", {
      segment: "syncs",
      summary: "Queue an integration sync",
      description:
        "Queues a sync run on a Connected connection; the run is attempted by the platform job queue with retries.",
      body: SyncBody,
      response: SyncQueued,
      status: 202,
    }),
  ],
};

export const integrationCapabilities: Readonly<Record<string, CapabilityRule>> = {
  integrations: {
    actions: {
      transition: "org.integrations.manage",
      storeCredential: "org.integrations.manage",
      sync: "org.integrations.manage",
    },
  },
};
