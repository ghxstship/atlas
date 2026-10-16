/**
 * The integrations part of the Settings handlers (A19): integration connections (0600), OAuth apps
 * and consent grants and SCIM group mappings (0638). handlers/settings.ts spreads them beside A30's
 * Settings handlers. Every call runs as the caller: row level security and the RPCs of 0600 and 0638
 * decide, and their refusals come back as 422 with the rule. Credentials go to Vault and are never
 * returned.
 */
import { badRequest } from "../../problem.ts";
import type { RequestContext } from "../../runtime/context.ts";
import { accepted, noContent, ok, type HandlerSet } from "../../runtime/handler.ts";
import { from, handlersFor, rpc, run, tableResource } from "../support/table.ts";

const integrations = tableResource("integrations");
const oauthApps = tableResource("oauthApps");
const oauthGrants = tableResource("oauthGrants", { verbs: ["list", "get", "delete"] });
const scimGroupMappings = tableResource("scimGroupMappings");

async function disconnectAndRemove(context: RequestContext, id: string): Promise<void> {
  const current = await integrations.read(context, id, ["id", "connection_state"]);
  if (current["connection_state"] !== "Disconnected") {
    await run(
      rpc(context.db, "transition_integration_connection", {
        p_connection_id: id,
        p_expected: current["connection_state"],
        p_next: "Disconnected",
        p_reason: "Removed through the API.",
      }),
    );
  }
  await run(
    from(context.db, "integration_connections")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .select("id"),
  );
}

export const integrationHandlers: HandlerSet<"Settings"> = {
  ...handlersFor("Settings", integrations),
  "integrations.delete": async ({ params }, context) => {
    await disconnectAndRemove(context, String(params.id));
    return noContent();
  },
  "integrations.transition": async ({ params, body }, context) => {
    const id = String(params.id);
    await integrations.read(context, id, ["id"]);
    await run(
      rpc(context.db, "transition_integration_connection", {
        p_connection_id: id,
        p_expected: body.expected_state,
        p_next: body.next_state,
        p_reason: body.reason,
      }),
    );
    return ok((await integrations.read(context, id)) as never);
  },
  "integrations.storeCredential": async ({ params, body }, context) => {
    const id = String(params.id);
    await integrations.read(context, id, ["id"]);
    await run(
      rpc(context.db, "store_integration_credential", {
        p_connection_id: id,
        p_secret: body.secret,
        p_kind: body.kind,
        p_expires_at: body.expires_at ?? null,
      }),
    );
    return ok((await integrations.read(context, id)) as never);
  },
  "integrations.sync": async ({ params, body, idempotencyKey }, context) => {
    const id = String(params.id);
    if (idempotencyKey === undefined)
      throw badRequest("Send an Idempotency-Key with every sync request.");
    await integrations.read(context, id, ["id"]);
    const runId = await run<string>(
      rpc(context.db, "enqueue_integration_sync", {
        p_connection_id: id,
        p_scope: body.scope,
        p_direction: body.direction,
        p_idempotency_key: idempotencyKey,
        p_project_id: body.project_id ?? null,
      }),
    );
    return accepted({ sync_run_id: runId });
  },
  ...handlersFor("Settings", oauthApps),
  ...handlersFor("Settings", oauthGrants),
  ...handlersFor("Settings", scimGroupMappings),
};
