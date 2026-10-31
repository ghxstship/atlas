import { fail, ok, toDataError, type Result } from "@xos/data";
import type {
  ConnectionState,
  IntegrationCategory,
  IntegrationEntity,
  SyncDirection,
  SyncRunState,
  SyncScope,
} from "./catalog.ts";
import type { DbClient, DbResponse } from "./db.ts";
import type { Database } from "@xos/data/database.types";

/**
 * Repository functions for signed-in callers (Atlas settings and the API handlers). They run under
 * the caller's session, so row level security and the RPC checks decide what each person may do;
 * every outcome comes back as a typed Result (refusal, not-found, conflict, invalid, unexpected).
 */

export interface ProviderRow {
  readonly provider_code: string;
  readonly category: IntegrationCategory;
  readonly sort_order: number;
  readonly required_feature: string | null;
  readonly needs_credential: boolean;
}

export interface ConnectionSummary {
  readonly id: string;
  readonly provider_code: string;
  readonly display_name: string;
  readonly external_account_id: string | null;
  readonly external_account_name: string | null;
  readonly connection_state: ConnectionState;
  readonly credential_kind: string | null;
  readonly credential_stored_at: string | null;
  readonly credential_expires_at: string | null;
  readonly last_synced_at: string | null;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly provider_settings: Record<string, unknown>;
}

export interface SyncRunSummary {
  readonly id: string;
  readonly integration_connection_id: string;
  readonly sync_scope: SyncScope;
  readonly direction: SyncDirection;
  readonly sync_run_state: SyncRunState;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly next_attempt_at: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly items_read: number;
  readonly items_written: number;
  readonly items_skipped: number;
  readonly items_failed: number;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly created_at: string;
}

export interface SyncErrorRow {
  readonly id: string;
  readonly attempt: number;
  readonly entity: IntegrationEntity | null;
  readonly local_id: string | null;
  readonly external_id: string | null;
  readonly error_code: string;
  readonly error_message: string;
  readonly created_at: string;
}

const CONNECTION_COLUMNS =
  "id, provider_code, display_name, external_account_id, external_account_name, connection_state, credential_kind, credential_stored_at, credential_expires_at, last_synced_at, last_error_code, last_error_message, provider_settings";

const RUN_COLUMNS =
  "id, integration_connection_id, sync_scope, direction, sync_run_state, attempt, max_attempts, next_attempt_at, started_at, finished_at, items_read, items_written, items_skipped, items_failed, error_code, error_message, created_at";

async function settle<T>(response: PromiseLike<DbResponse>): Promise<Result<T>> {
  const { data, error } = await response;
  return error ? fail(toDataError(error)) : ok(data as T);
}

async function settleSingle<T>(response: PromiseLike<DbResponse>): Promise<Result<T>> {
  const result = await settle<T | null>(response);
  if (!result.ok) return result;
  return result.data === null ? fail({ kind: "not-found" }) : ok(result.data);
}

export function listProviders(db: DbClient): Promise<Result<ProviderRow[]>> {
  return settle(db.from("integration_providers").select("*").order("sort_order"));
}

export function listConnections(db: DbClient): Promise<Result<ConnectionSummary[]>> {
  return settle(
    db
      .from("integration_connections")
      .select(CONNECTION_COLUMNS)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
  );
}

export function getConnection(db: DbClient, id: string): Promise<Result<ConnectionSummary>> {
  return settleSingle(
    db.from("integration_connections").select(CONNECTION_COLUMNS).eq("id", id).maybeSingle(),
  );
}

export interface NewConnection {
  readonly orgId: string;
  readonly providerCode: string;
  readonly displayName: string;
  readonly externalAccountId?: string | null;
  readonly settings?: Record<string, unknown>;
}

export function createConnection(
  db: DbClient,
  input: NewConnection,
): Promise<Result<ConnectionSummary>> {
  return settleSingle(
    db
      .from("integration_connections")
      .insert({
        org_id: input.orgId,
        provider_code: input.providerCode,
        display_name: input.displayName.trim(),
        external_account_id: input.externalAccountId ?? null,
        provider_settings: input.settings ?? {},
      })
      .select(CONNECTION_COLUMNS)
      .single(),
  );
}

export function updateConnectionSettings(
  db: DbClient,
  id: string,
  changes: { readonly displayName?: string; readonly settings?: Record<string, unknown> },
): Promise<Result<ConnectionSummary>> {
  const patch: Record<string, unknown> = {};
  if (changes.displayName !== undefined) patch["display_name"] = changes.displayName.trim();
  if (changes.settings !== undefined) patch["provider_settings"] = changes.settings;
  return settleSingle(
    db
      .from("integration_connections")
      .update(patch)
      .eq("id", id)
      .select(CONNECTION_COLUMNS)
      .maybeSingle(),
  );
}

export async function storeCredential(
  db: DbClient,
  connectionId: string,
  secret: string,
  kind: Database["app"]["Enums"]["integration_credential_kind"],
  expiresAt: string | null = null,
): Promise<Result<null>> {
  const result = await settle<unknown>(
    db.rpc("store_integration_credential", {
      p_connection_id: connectionId,
      p_secret: secret,
      p_kind: kind,
      p_expires_at: expiresAt,
    }),
  );
  return result.ok ? ok(null) : result;
}

export function transitionConnection(
  db: DbClient,
  connectionId: string,
  expected: ConnectionState,
  next: ConnectionState,
  reason: string,
): Promise<Result<string>> {
  return settle(
    db.rpc("transition_integration_connection", {
      p_connection_id: connectionId,
      p_expected: expected,
      p_next: next,
      p_reason: reason,
    }),
  );
}

export interface SyncRequest {
  readonly connectionId: string;
  readonly scope: SyncScope;
  readonly direction: SyncDirection;
  readonly idempotencyKey: string;
  readonly projectId?: string | null;
  readonly maxAttempts?: number;
  readonly subject?: { readonly entity: IntegrationEntity; readonly id: string } | null;
  readonly sourceUri?: string | null;
}

export function enqueueSync(db: DbClient, request: SyncRequest): Promise<Result<string>> {
  return settle(
    db.rpc("enqueue_integration_sync", {
      p_connection_id: request.connectionId,
      p_scope: request.scope,
      p_direction: request.direction,
      p_idempotency_key: request.idempotencyKey,
      p_project_id: request.projectId ?? null,
      p_max_attempts: request.maxAttempts ?? 5,
      p_subject_entity: request.subject?.entity ?? null,
      p_subject_id: request.subject?.id ?? null,
      p_source_uri: request.sourceUri ?? null,
    }),
  );
}

export function cancelSync(db: DbClient, runId: string, reason: string): Promise<Result<string>> {
  return settle(db.rpc("cancel_integration_sync", { p_run_id: runId, p_reason: reason }));
}

export function retrySync(db: DbClient, runId: string, reason: string): Promise<Result<string>> {
  return settle(db.rpc("retry_integration_sync", { p_run_id: runId, p_reason: reason }));
}

export function listSyncRuns(
  db: DbClient,
  connectionId: string,
  limit = 50,
): Promise<Result<SyncRunSummary[]>> {
  return settle(
    db
      .from("integration_sync_runs")
      .select(RUN_COLUMNS)
      .eq("integration_connection_id", connectionId)
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 200)),
  );
}

export function listSyncErrors(db: DbClient, runId: string): Promise<Result<SyncErrorRow[]>> {
  return settle(
    db
      .from("integration_sync_errors")
      .select("id, attempt, entity, local_id, external_id, error_code, error_message, created_at")
      .eq("integration_sync_run_id", runId)
      .order("created_at"),
  );
}

export function mapExternalId(
  db: DbClient,
  connectionId: string,
  entity: IntegrationEntity,
  localId: string,
  externalId: string,
): Promise<Result<{ id: string }>> {
  return settleSingle(
    db
      .from("integration_external_ids")
      .insert({
        integration_connection_id: connectionId,
        entity,
        local_id: localId,
        external_id: externalId.trim(),
      })
      .select("id")
      .single(),
  );
}
