import type {
  ConnectionState,
  IntegrationEntity,
  SyncDirection,
  SyncRunState,
  SyncScope,
} from "./catalog.ts";
import { unwrap, type DbClient } from "./db.ts";
import type { IntegrationError } from "./errors.ts";

export interface SyncRun {
  readonly id: string;
  readonly orgId: string;
  readonly connectionId: string;
  readonly projectId: string | null;
  readonly scope: SyncScope;
  readonly direction: SyncDirection;
  readonly state: SyncRunState;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly cursorBefore: string | null;
  readonly subjectEntity: IntegrationEntity | null;
  readonly subjectId: string | null;
  readonly sourceUri: string | null;
}

export interface Connection {
  readonly id: string;
  readonly orgId: string;
  readonly providerCode: string;
  readonly displayName: string;
  readonly externalAccountId: string | null;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly state: ConnectionState;
}

export interface ExternalId {
  readonly entity: IntegrationEntity;
  readonly localId: string;
  readonly externalId: string;
  readonly externalVersion: string | null;
  readonly contentHash: string | null;
}

export interface SyncCounts {
  readonly read: number;
  readonly written: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface ItemRef {
  readonly entity?: IntegrationEntity;
  readonly localId?: string;
  readonly externalId?: string;
}

/** What the runner and connectors need from the framework tables (migration 0600). */
export interface IntegrationStore {
  claimRun(runId: string, jobId: string | null): Promise<SyncRun>;
  connection(connectionId: string): Promise<Connection>;
  credential(connectionId: string): Promise<string>;
  /** cursor_after of the connection's last Succeeded run of the scope, where the next run starts. */
  lastCursor(connectionId: string, scope: SyncScope): Promise<string | null>;
  completeRun(runId: string, counts: SyncCounts, cursorAfter: string | null): Promise<void>;
  failRun(runId: string, error: IntegrationError): Promise<SyncRunState>;
  recordItemError(runId: string, code: string, message: string, ref?: ItemRef): Promise<void>;
  externalIds(connectionId: string, entity: IntegrationEntity): Promise<readonly ExternalId[]>;
  upsertExternalId(connectionId: string, pair: ExternalId): Promise<void>;
}

interface RunRow {
  id: string;
  org_id: string;
  integration_connection_id: string;
  project_id: string | null;
  sync_scope: SyncScope;
  direction: SyncDirection;
  sync_run_state: SyncRunState;
  attempt: number;
  max_attempts: number;
  cursor_before: string | null;
  subject_entity: IntegrationEntity | null;
  subject_id: string | null;
  source_uri: string | null;
}

interface ConnectionRow {
  id: string;
  org_id: string;
  provider_code: string;
  display_name: string;
  external_account_id: string | null;
  provider_settings: Record<string, unknown> | null;
  connection_state: ConnectionState;
}

interface ExternalIdRow {
  entity: IntegrationEntity;
  local_id: string;
  external_id: string;
  external_version: string | null;
  content_hash: string | null;
}

function toRun(row: RunRow): SyncRun {
  return {
    id: row.id,
    orgId: row.org_id,
    connectionId: row.integration_connection_id,
    projectId: row.project_id,
    scope: row.sync_scope,
    direction: row.direction,
    state: row.sync_run_state,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    cursorBefore: row.cursor_before,
    subjectEntity: row.subject_entity,
    subjectId: row.subject_id,
    sourceUri: row.source_uri,
  };
}

/** The store over the framework RPCs, for a service-role client (the runner RPCs are service role only). */
export function supabaseIntegrationStore(db: DbClient): IntegrationStore {
  return {
    async claimRun(runId, jobId) {
      const row = await unwrap<RunRow>(
        db.rpc("claim_integration_sync", { p_run_id: runId, p_job_id: jobId }),
      );
      return toRun(row);
    },
    async connection(connectionId) {
      const row = await unwrap<ConnectionRow>(
        db
          .from("integration_connections")
          .select(
            "id, org_id, provider_code, display_name, external_account_id, provider_settings, connection_state",
          )
          .eq("id", connectionId)
          .single(),
      );
      return {
        id: row.id,
        orgId: row.org_id,
        providerCode: row.provider_code,
        displayName: row.display_name,
        externalAccountId: row.external_account_id,
        settings: row.provider_settings ?? {},
        state: row.connection_state,
      };
    },
    async credential(connectionId) {
      return unwrap<string>(
        db.rpc("read_integration_credential", { p_connection_id: connectionId }),
      );
    },
    async lastCursor(connectionId, scope) {
      const rows = await unwrap<{ cursor_after: string | null }[]>(
        db
          .from("integration_sync_runs")
          .select("cursor_after")
          .eq("integration_connection_id", connectionId)
          .eq("sync_scope", scope)
          .eq("sync_run_state", "Succeeded")
          .order("finished_at", { ascending: false })
          .limit(1),
      );
      return rows[0]?.cursor_after ?? null;
    },
    async completeRun(runId, counts, cursorAfter) {
      await unwrap(
        db.rpc("complete_integration_sync", {
          p_run_id: runId,
          p_items_read: counts.read,
          p_items_written: counts.written,
          p_items_skipped: counts.skipped,
          p_items_failed: counts.failed,
          p_cursor_after: cursorAfter,
        }),
      );
    },
    async failRun(runId, error) {
      return unwrap<SyncRunState>(
        db.rpc("fail_integration_sync", {
          p_run_id: runId,
          p_error_code: error.code,
          p_error_message: error.message,
          p_retryable: error.retryable,
          p_connection_error: error.connectionError,
        }),
      );
    },
    async recordItemError(runId, code, message, ref = {}) {
      await unwrap(
        db.rpc("record_integration_sync_error", {
          p_run_id: runId,
          p_error_code: code,
          p_error_message: message,
          p_entity: ref.entity ?? null,
          p_local_id: ref.localId ?? null,
          p_external_id: ref.externalId ?? null,
        }),
      );
    },
    async externalIds(connectionId, entity) {
      const rows = await unwrap<ExternalIdRow[]>(
        db
          .from("integration_external_ids")
          .select("entity, local_id, external_id, external_version, content_hash")
          .eq("integration_connection_id", connectionId)
          .eq("entity", entity)
          .is("deleted_at", null),
      );
      return rows.map((r) => ({
        entity: r.entity,
        localId: r.local_id,
        externalId: r.external_id,
        externalVersion: r.external_version,
        contentHash: r.content_hash,
      }));
    },
    async upsertExternalId(connectionId, pair) {
      await unwrap(
        db.rpc("upsert_integration_external_id", {
          p_connection_id: connectionId,
          p_entity: pair.entity,
          p_local_id: pair.localId,
          p_external_id: pair.externalId,
          p_external_version: pair.externalVersion,
          p_content_hash: pair.contentHash,
        }),
      );
    },
  };
}
