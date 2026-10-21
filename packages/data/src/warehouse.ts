import type { XosClient } from "./client.ts";
import { ok, type Result } from "./result.ts";
import {
  bool,
  num,
  numOrNull,
  rows,
  rpc,
  str,
  strOrNull,
  writtenId,
  type Raw,
} from "./platform-common.ts";
import { untyped } from "./untyped.ts";

/**
 * Settings, Integrations: warehouse delivery and provider webhooks, as the signed-in person (A83, RRR-128;
 * migrations 1400 and 1401). Row level security and the RPCs decide everything: destinations need the
 * Enterprise plan and reports.schedule.write, Confidential columns need data.export.confidential, and inbound
 * events and webhook secrets need org.integrations.manage.
 */

export type WarehouseProvider =
  "S3" | "Google Cloud Storage" | "Azure Blob" | "BigQuery" | "Snowflake";
export type WarehouseFormat = "Parquet" | "CSV";
export type WarehouseDeliveryState = "Queued" | "Running" | "Delivered" | "Retrying" | "Failed";

export interface WarehouseProviderOption {
  readonly provider: WarehouseProvider;
  readonly available: boolean;
}

export interface WarehouseDestination {
  readonly id: string;
  readonly provider: WarehouseProvider;
  readonly displayName: string;
  readonly bucketName: string;
  readonly region: string | null;
  readonly endpointUrl: string | null;
  readonly pathPrefix: string;
  readonly fileFormat: WarehouseFormat;
  readonly includeConfidential: boolean;
  readonly deliveryHour: number;
  readonly state: "Active" | "Paused";
  readonly nextDeliveryAt: string | null;
  readonly credentialStoredAt: string | null;
  readonly lastDeliveredAt: string | null;
  readonly lastErrorMessage: string | null;
}

export interface WarehouseDelivery {
  readonly id: string;
  readonly destinationId: string;
  readonly state: WarehouseDeliveryState;
  readonly manual: boolean;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly tablesDelivered: number;
  readonly rowsDelivered: number;
  readonly columnsWithheld: number;
  readonly errorMessage: string | null;
}

export interface WithheldColumn {
  readonly tableKey: string;
  readonly columnName: string;
  readonly classification: "Confidential" | "Restricted";
  readonly deliveredWithConfidential: boolean;
}

export async function listWarehouseProviders(
  db: XosClient,
): Promise<Result<WarehouseProviderOption[]>> {
  const result = await rows(
    untyped(db)
      .from("warehouse_providers")
      .select("provider, available, sort_order")
      .order("sort_order"),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      provider: str(r["provider"]) as WarehouseProvider,
      available: bool(r["available"]),
    })),
  );
}

function toDestination(r: Raw): WarehouseDestination {
  return {
    id: str(r["id"]),
    provider: str(r["provider"]) as WarehouseProvider,
    displayName: str(r["display_name"]),
    bucketName: str(r["bucket_name"]),
    region: strOrNull(r["region"]),
    endpointUrl: strOrNull(r["endpoint_url"]),
    pathPrefix: str(r["path_prefix"]),
    fileFormat: str(r["file_format"]) as WarehouseFormat,
    includeConfidential: bool(r["include_confidential"]),
    deliveryHour: num(r["delivery_hour"]),
    state: str(r["destination_state"]) as WarehouseDestination["state"],
    nextDeliveryAt: strOrNull(r["next_delivery_at"]),
    credentialStoredAt: strOrNull(r["credential_stored_at"]),
    lastDeliveredAt: strOrNull(r["last_delivered_at"]),
    lastErrorMessage: strOrNull(r["last_error_message"]),
  };
}

export async function listWarehouseDestinations(
  db: XosClient,
  orgId: string,
): Promise<Result<WarehouseDestination[]>> {
  const result = await rows(
    untyped(db)
      .from("warehouse_destinations")
      .select(
        "id, provider, display_name, bucket_name, region, endpoint_url, path_prefix, file_format, include_confidential, delivery_hour, destination_state, next_delivery_at, credential_stored_at, last_delivered_at, last_error_message",
      )
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("created_at"),
  );
  if (!result.ok) return result;
  return ok(result.data.map(toDestination));
}

export async function listWarehouseDeliveries(
  db: XosClient,
  orgId: string,
  limit = 10,
): Promise<Result<WarehouseDelivery[]>> {
  const result = await rows(
    untyped(db)
      .from("warehouse_deliveries")
      .select(
        "id, warehouse_destination_id, delivery_state, requested_manually, created_at, finished_at, tables_delivered, rows_delivered, columns_withheld, error_message",
      )
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(limit),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      id: str(r["id"]),
      destinationId: str(r["warehouse_destination_id"]),
      state: str(r["delivery_state"]) as WarehouseDeliveryState,
      manual: bool(r["requested_manually"]),
      createdAt: str(r["created_at"]),
      finishedAt: strOrNull(r["finished_at"]),
      tablesDelivered: num(r["tables_delivered"]),
      rowsDelivered: num(r["rows_delivered"]),
      columnsWithheld: num(r["columns_withheld"]),
      errorMessage: strOrNull(r["error_message"]),
    })),
  );
}

/** The classified columns of the published schema: what a delivery never writes, or writes only when Confidential columns are on. */
export async function listWithheldColumns(db: XosClient): Promise<Result<WithheldColumn[]>> {
  return rpc(db, "warehouse_published_schema", {}, (d) =>
    ((d as Raw[] | null) ?? [])
      .filter((r) => r["classification"] === "Confidential" || r["classification"] === "Restricted")
      .map((r) => ({
        tableKey: str(r["table_key"]),
        columnName: str(r["column_name"]),
        classification: str(r["classification"]) as WithheldColumn["classification"],
        deliveredWithConfidential: bool(r["delivered_with_confidential"]),
      })),
  );
}

export interface NewWarehouseDestination {
  readonly orgId: string;
  readonly provider: WarehouseProvider;
  readonly displayName: string;
  readonly bucketName: string;
  readonly region: string | null;
  readonly endpointUrl: string | null;
  readonly pathPrefix: string;
  readonly fileFormat: WarehouseFormat;
  readonly includeConfidential: boolean;
  readonly deliveryHour: number;
}

export function createWarehouseDestination(
  db: XosClient,
  input: NewWarehouseDestination,
): Promise<Result<string>> {
  return writtenId(
    untyped(db)
      .from("warehouse_destinations")
      .insert({
        org_id: input.orgId,
        provider: input.provider,
        display_name: input.displayName,
        bucket_name: input.bucketName,
        region: input.region,
        endpoint_url: input.endpointUrl,
        path_prefix: input.pathPrefix,
        file_format: input.fileFormat,
        include_confidential: input.includeConfidential,
        delivery_hour: input.deliveryHour,
      })
      .select("id"),
  );
}

/** Pauses, resumes or deletes a destination; deleting destroys its Vault credential. */
export function changeWarehouseDestination(
  db: XosClient,
  id: string,
  change: { readonly state: "Active" | "Paused" } | { readonly deleted: true },
): Promise<Result<string>> {
  const values =
    "deleted" in change
      ? { deleted_at: new Date().toISOString() }
      : { destination_state: change.state };
  return writtenId(
    untyped(db).from("warehouse_destinations").update(values).eq("id", id).select("id"),
  );
}

export function storeWarehouseCredential(
  db: XosClient,
  destinationId: string,
  secret: string,
): Promise<Result<null>> {
  return rpc(
    db,
    "store_warehouse_credential",
    { p_destination_id: destinationId, p_secret: secret },
    () => null,
  );
}

export function requestWarehouseDelivery(
  db: XosClient,
  destinationId: string,
): Promise<Result<string>> {
  return rpc(db, "request_warehouse_delivery", { p_destination_id: destinationId }, str);
}

// Provider webhooks ---------------------------------------------------------------------------------------------

export interface DeadLetter {
  readonly id: string;
  readonly providerCode: string;
  readonly kind: "Link Unfurl" | "Change Notice";
  readonly receivedAt: string;
  readonly attempts: number;
  readonly errorMessage: string | null;
}

export async function listDeadLetters(
  db: XosClient,
  orgId: string,
  limit = 20,
): Promise<Result<DeadLetter[]>> {
  const result = await rows(
    untyped(db)
      .from("integration_inbound_events")
      .select("id, provider_code, inbound_kind, received_at, attempt, error_message")
      .eq("org_id", orgId)
      .eq("inbound_state", "Dead Letter")
      .is("deleted_at", null)
      .order("received_at", { ascending: false })
      .limit(limit),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      id: str(r["id"]),
      providerCode: str(r["provider_code"]),
      kind: str(r["inbound_kind"]) as DeadLetter["kind"],
      receivedAt: str(r["received_at"]),
      attempts: num(r["attempt"]),
      errorMessage: strOrNull(r["error_message"]),
    })),
  );
}

export function retryDeadLetter(
  db: XosClient,
  eventId: string,
  reason: string,
): Promise<Result<null>> {
  return rpc(
    db,
    "retry_integration_inbound_event",
    { p_event_id: eventId, p_reason: reason },
    () => null,
  );
}

/** Connections whose provider signs webhooks with a per-connection secret. */
export const INBOUND_SECRET_PROVIDERS = [
  "microsoft_teams",
  "google_calendar",
  "microsoft_365",
] as const;

export interface InboundSecretConnection {
  readonly connectionId: string;
  readonly providerCode: string;
  readonly displayName: string;
  readonly storedAt: string | null;
}

export async function listInboundSecretConnections(
  db: XosClient,
  orgId: string,
): Promise<Result<InboundSecretConnection[]>> {
  const [connections, stored] = await Promise.all([
    rows(
      untyped(db)
        .from("integration_connections")
        .select("id, provider_code, display_name, connection_state")
        .eq("org_id", orgId)
        .in("provider_code", [...INBOUND_SECRET_PROVIDERS])
        .neq("connection_state", "Disconnected")
        .is("deleted_at", null)
        .order("created_at"),
    ),
    rpc(
      db,
      "integration_inbound_secrets_stored",
      { p_org_id: orgId },
      (d) =>
        new Map(
          ((d as Raw[] | null) ?? []).map((r) => [
            str(r["integration_connection_id"]),
            strOrNull(r["stored_at"]),
          ]),
        ),
    ),
  ]);
  if (!connections.ok) return connections;
  if (!stored.ok) return stored;
  return ok(
    connections.data.map((c) => ({
      connectionId: str(c["id"]),
      providerCode: str(c["provider_code"]),
      displayName: str(c["display_name"]),
      storedAt: stored.data.get(str(c["id"])) ?? null,
    })),
  );
}

export function storeInboundSecret(
  db: XosClient,
  connectionId: string,
  secret: string,
): Promise<Result<null>> {
  return rpc(
    db,
    "store_integration_inbound_secret",
    { p_connection_id: connectionId, p_secret: secret },
    () => null,
  );
}

/** Parses an hour field (0 to 23), or null when it is not one. */
export function deliveryHour(value: string): number | null {
  const hour = numOrNull(value.trim() === "" ? null : value);
  return hour !== null && Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}
