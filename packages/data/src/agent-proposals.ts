import type { XosClient } from "./client.ts";
import type { Json } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Hosted MCP connectors and the changes they propose (B16, migration 3052, ADR 0155 D1 and D2; Sections 10.2 and
 * 4.7). An Admin registers a connector for Claude, ChatGPT or another MCP client: an OAuth app with default capability
 * groups. Every write the connector's session asks for becomes a Proposed ai_suggestion; the person confirms each one
 * in Personal settings, Connected apps, where Atlas runs the named public operation with their own session. The
 * database refuses a connector's direct writes (agent_write_needs_review) and any app session confirming
 * (ai_suggestion_needs_person); suggestion transitions reuse transitionAiSuggestion from ./ai.ts.
 */

export type McpClientKind = "Claude" | "ChatGPT" | "Other";

export interface McpConnector {
  readonly oauthAppId: string;
  readonly name: string;
  readonly kind: McpClientKind;
  readonly redirectUri: string;
  readonly defaultScopes: readonly string[];
  /** The Supabase Auth client id the Admin pastes into the assistant, when the reader may see it. */
  readonly clientId: string | null;
  readonly createdAt: string;
}

export interface ProposedField {
  readonly fieldPath: string;
  /** The JSON value proposed; null clears the field. */
  readonly value: unknown;
}

/** How Atlas calls the proposed operation: its path values, the etag the app read and an idempotency key. */
export interface OperationRequest {
  readonly path: Readonly<Record<string, string | number>>;
  readonly ifMatch: string | null;
}

export interface AgentProposal {
  readonly suggestionId: string;
  readonly oauthAppId: string;
  readonly appName: string;
  readonly operationId: string;
  /** The app's own note about the change; the UI shows the operation's summary as the action. */
  readonly summary: string;
  readonly targetId: string | null;
  readonly fields: readonly ProposedField[];
  readonly request: OperationRequest;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ProposalForApply {
  readonly suggestionId: string;
  readonly orgId: string;
  readonly operationId: string;
  readonly targetId: string | null;
  readonly request: OperationRequest;
  readonly fields: readonly ProposedField[];
  /** Capability groups of the person's live grant to the app. */
  readonly grantScopes: readonly string[];
}

/** Refusals of the proposal queue, each with its own copy in the agentChanges namespace. */
export const AGENT_REFUSALS = [
  "agent_session_required",
  "agent_operation_not_allowed",
  "agent_outside_grant",
  "agent_operation_restricted",
  "agent_proposals_limit",
  "agent_write_needs_review",
  "agent_grant_revoked",
  "ai_suggestion_needs_person",
  "ai_suggestion_not_proposed",
  "ai_suggestion_expired",
  "mcp_scope_restricted",
  "mcp_redirect_uri_invalid",
  "mcp_client_kind_required",
  "oauth_scope_unknown",
  "oauth_scope_missing",
  "org_read_only",
  "plan_limit_read_only",
] as const;

function fieldsOf(value: unknown): ProposedField[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((f): f is { field_path: string; value?: unknown } => {
      return (
        typeof f === "object" &&
        f !== null &&
        typeof (f as { field_path?: unknown }).field_path === "string"
      );
    })
    .map((f) => ({ fieldPath: f.field_path, value: f.value ?? null }));
}

function requestOf(value: unknown): OperationRequest {
  const raw = (typeof value === "object" && value !== null ? value : {}) as {
    path?: unknown;
    if_match?: unknown;
  };
  const path: Record<string, string | number> = {};
  if (typeof raw.path === "object" && raw.path !== null) {
    for (const [k, v] of Object.entries(raw.path as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number") path[k] = v;
    }
  }
  return { path, ifMatch: typeof raw.if_match === "string" ? raw.if_match : null };
}

/** Builds a proposal's fields from a request body: each top-level key is one field. */
export function fieldsFromBody(
  body: Readonly<Record<string, unknown>> | undefined,
): ProposedField[] {
  return Object.entries(body ?? {}).map(([fieldPath, value]) => ({
    fieldPath,
    value: value ?? null,
  }));
}

/** A request body from a proposal's fields, for applying it: the inverse of fieldsFromBody. */
export function bodyFromFields(fields: readonly ProposedField[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f.fieldPath, f.value]));
}

/** app.register_mcp_connector: registers the connector's OAuth app and returns it with its client id. */
export async function registerMcpConnector(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly kind: McpClientKind;
    readonly name?: string | null;
    readonly redirectUri: string;
    readonly defaultScopes: readonly string[];
  },
): Promise<Result<{ readonly oauthAppId: string; readonly clientId: string }>> {
  const { data, error } = await db.rpc("register_mcp_connector", {
    p_org_id: input.orgId,
    p_kind: input.kind,
    p_name: input.name ?? "",
    p_redirect_uri: input.redirectUri,
    p_default_scopes: [...input.defaultScopes],
  });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (row === undefined) {
    return fail({ kind: "unexpected", message: "register_mcp_connector returned no row" });
  }
  return ok({ oauthAppId: row.oauth_app_id, clientId: row.client_id });
}

/** The org's live connectors with their apps (org.settings.read) and Supabase Auth client ids. */
export async function listMcpConnectors(
  db: XosClient,
  orgId: string,
): Promise<Result<McpConnector[]>> {
  const [connectors, clients] = await Promise.all([
    db
      .from("mcp_connectors")
      .select(
        "oauth_app_id, client_kind, default_scopes, created_at, oauth_apps!inner(name, redirect_uri, deleted_at)",
      )
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("created_at"),
    db.rpc("oauth_app_client_ids", { p_org_id: orgId }),
  ]);
  if (connectors.error) return fail(toDataError(connectors.error));
  const clientIds = new Map(
    (clients.data ?? []).map((c) => [c.oauth_app_id, c.auth_client_id] as const),
  );
  return ok(
    (
      connectors.data as unknown as {
        oauth_app_id: string;
        client_kind: McpClientKind;
        default_scopes: string[];
        created_at: string;
        oauth_apps: { name: string; redirect_uri: string; deleted_at: string | null } | null;
      }[]
    )
      .filter((r) => r.oauth_apps !== null && r.oauth_apps.deleted_at === null)
      .map((r) => ({
        oauthAppId: r.oauth_app_id,
        name: r.oauth_apps?.name ?? "",
        kind: r.client_kind,
        redirectUri: r.oauth_apps?.redirect_uri ?? "",
        defaultScopes: r.default_scopes,
        clientId: clientIds.get(r.oauth_app_id) ?? null,
        createdAt: r.created_at,
      })),
  );
}

/**
 * app.propose_agent_change, from the connector's own session (the hosted MCP endpoint's bearer client): records the
 * proposal and returns its id, expiry and the org slug for the review link.
 */
export async function proposeAgentChange(
  db: XosClient,
  input: {
    readonly operationId: string;
    readonly operationScopes: readonly string[];
    readonly targetId: string | null;
    readonly summary: string;
    readonly path: Readonly<Record<string, string | number>>;
    readonly ifMatch: string | null;
    readonly fields: readonly ProposedField[];
  },
): Promise<
  Result<{ readonly suggestionId: string; readonly expiresAt: string; readonly orgSlug: string }>
> {
  const { data, error } = await db.rpc("propose_agent_change", {
    p_operation_id: input.operationId,
    p_operation_scopes: [...input.operationScopes],
    // Both are nullable in SQL; the generator types every argument without a default as non-null.
    p_target_id: input.targetId as string,
    p_summary: input.summary,
    p_path: input.path,
    p_if_match: input.ifMatch as string,
    p_fields: input.fields.map((f) => ({
      field_path: f.fieldPath,
      value: (f.value ?? null) as Json,
    })),
  });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (row === undefined) {
    return fail({ kind: "unexpected", message: "propose_agent_change returned no row" });
  }
  return ok({ suggestionId: row.suggestion_id, expiresAt: row.expires_at, orgSlug: row.org_slug });
}

/** app.my_agent_proposals: what the caller's connected apps proposed in the org and still waits for them. */
export async function listMyAgentProposals(
  db: XosClient,
  orgId: string,
): Promise<Result<AgentProposal[]>> {
  const { data, error } = await db.rpc("my_agent_proposals", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      suggestionId: r.suggestion_id,
      oauthAppId: r.oauth_app_id,
      appName: r.app_name,
      operationId: r.operation_id,
      summary: r.summary,
      targetId: typeof r.target_id === "string" ? r.target_id : null,
      fields: fieldsOf(r.fields),
      request: requestOf(r.operation_request),
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    })),
  );
}

/** app.agent_proposal_for_apply: what Atlas needs to apply a proposal with the person's own session. */
export async function getProposalForApply(
  db: XosClient,
  suggestionId: string,
): Promise<Result<ProposalForApply>> {
  const { data, error } = await db.rpc("agent_proposal_for_apply", {
    p_suggestion_id: suggestionId,
  });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (row === undefined) return fail({ kind: "not-found" });
  return ok({
    suggestionId: row.suggestion_id,
    orgId: row.org_id,
    operationId: row.operation_id,
    targetId: typeof row.target_id === "string" ? row.target_id : null,
    request: requestOf(row.operation_request),
    fields: fieldsOf(row.fields),
    grantScopes: row.grant_scopes ?? [],
  });
}
