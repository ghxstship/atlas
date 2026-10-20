import { csvField } from "@xos/data/csv";
import { isPublicAddress, type HostResolver } from "@xos/platform";
import { StoreError, unwrap, type DbClient } from "../framework/db.ts";
import { asIntegrationError, IntegrationError } from "../framework/errors.ts";
import type { HttpClient } from "../framework/http.ts";
import type { JobQueue } from "../framework/runner.ts";
import { sha256Hex } from "../framework/support.ts";
import { toParquetValue, writeParquet, type ParquetColumn, type ParquetType } from "./parquet.ts";
import type { WarehouseProvider, WarehouseProviderName, WarehouseTarget } from "./provider.ts";

/**
 * The warehouse delivery worker (A83, finding A65-029; Section 4.6.4). It claims warehouse.deliver jobs and
 * runs one attempt of each delivery (migration 1401):
 *   1. app.claim_warehouse_delivery fixes the snapshot time and says where the files go;
 *   2. app.warehouse_delivery_columns says which columns are delivered: never a Restricted or encrypted column,
 *      a Confidential one only when the destination includes them (the column registry, Section 8.3);
 *   3. each table is read a page at a time through app.warehouse_table_rows (the org's own live rows created
 *      by the snapshot, delivered columns only) and written as Parquet or CSV, in parts of PART_ROWS rows;
 *   4. every file is put in the customer's bucket and recorded with its SHA-256, rows and bytes;
 *   5. `_schema.json` (the published schema of this delivery) and, last, `_manifest.json` are written, so a
 *      loader that waits for the manifest never reads a half-written delivery;
 *   6. the delivery is completed (audited, warehouse_delivery.finished), or failed with a retry and backoff.
 * A retried attempt writes the same object keys again, so nothing is left half-delivered under another name.
 */

export const WAREHOUSE_DELIVER_JOB = "warehouse.deliver";
export const WAREHOUSE_SCHEMA_VERSION = "1";
/** Rows per file part; a table with more rows is written as several parts. */
export const PART_ROWS = 50_000;
const PAGE_ROWS = 2_000;

export type WarehouseFormat = "Parquet" | "CSV";

export interface ClaimedDelivery {
  readonly id: string;
  readonly orgId: string;
  readonly destinationId: string;
  readonly target: WarehouseTarget;
  readonly pathPrefix: string;
  readonly format: WarehouseFormat;
  readonly includeConfidential: boolean;
  readonly attempt: number;
  readonly snapshotAt: string;
}

export interface DeliveryColumn {
  readonly tableKey: string;
  readonly columnName: string;
  readonly ordinal: number;
  readonly dataType: ParquetType | "binary";
  readonly classification: string | null;
  readonly delivered: boolean;
  readonly withheldReason: string | null;
}

export interface DeliveryFile {
  readonly tableKey: string;
  readonly objectKey: string;
  readonly rowCount: number;
  readonly byteCount: number;
  readonly sha256: string;
  readonly columnsDelivered: number;
  readonly columnsWithheld: number;
}

export interface WarehouseStore {
  queueDue(): Promise<number>;
  /** Null when the delivery could not run (its destination or plan went away) and was failed by the claim. */
  claim(deliveryId: string): Promise<ClaimedDelivery | null>;
  columns(deliveryId: string): Promise<readonly DeliveryColumn[]>;
  rows(
    deliveryId: string,
    tableKey: string,
    after: string | null,
    limit: number,
  ): Promise<readonly Record<string, unknown>[]>;
  credential(destinationId: string): Promise<string>;
  recordFile(deliveryId: string, file: DeliveryFile): Promise<void>;
  complete(deliveryId: string, objectPrefix: string, schemaVersion: string): Promise<void>;
  fail(deliveryId: string, code: string, message: string, retryable: boolean): Promise<string>;
}

export interface WarehouseWorkerOptions {
  readonly queue: JobQueue;
  readonly store: WarehouseStore;
  readonly providers: ReadonlyMap<WarehouseProviderName, WarehouseProvider>;
  readonly worker: string;
  readonly limit?: number;
  readonly partRows?: number;
  readonly now?: () => Date;
}

export type DeliveryOutcome =
  | {
      readonly deliveryId: string;
      readonly result: "delivered";
      readonly files: number;
      readonly rows: number;
    }
  | { readonly deliveryId: string; readonly result: "retrying" | "failed"; readonly code: string }
  | { readonly deliveryId: string; readonly result: "skipped"; readonly reason: string };

function csvFile(
  columns: readonly ParquetColumn[],
  rows: readonly (readonly unknown[])[],
): Uint8Array {
  const cell = (value: unknown) =>
    value === null || value === undefined
      ? ""
      : csvField(typeof value === "object" ? JSON.stringify(value) : String(value));
  const lines = [
    columns.map((c) => csvField(c.name)).join(","),
    ...rows.map((r) => r.map(cell).join(",")),
  ];
  return new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
}

function encodeFile(
  format: WarehouseFormat,
  columns: readonly ParquetColumn[],
  rows: readonly Record<string, unknown>[],
) {
  if (format === "CSV") {
    return {
      body: csvFile(
        columns,
        rows.map((r) => columns.map((c) => r[c.name])),
      ),
      contentType: "text/csv",
    };
  }
  const values = rows.map((r) => columns.map((c) => toParquetValue(c.type, r[c.name])));
  return { body: writeParquet(columns, values), contentType: "application/vnd.apache.parquet" };
}

/** `<prefix>/<snapshot date>/<delivery id>`: one folder per delivery, sorted by date. */
export function deliveryPrefix(delivery: ClaimedDelivery): string {
  return `${delivery.pathPrefix}/${delivery.snapshotAt.slice(0, 10)}/${delivery.id}`;
}

async function deliver(
  delivery: ClaimedDelivery,
  options: WarehouseWorkerOptions,
): Promise<{ files: number; rows: number }> {
  const provider = options.providers.get(delivery.target.provider);
  if (provider === undefined || !provider.available) {
    throw new IntegrationError(
      "warehouse_provider_unavailable",
      `Delivery to ${delivery.target.provider} is not available yet. Use S3 or an S3-compatible bucket.`,
    );
  }
  const secret = await options.store.credential(delivery.destinationId);
  const columns = await options.store.columns(delivery.id);
  const prefix = deliveryPrefix(delivery);
  const extension = delivery.format === "CSV" ? "csv" : "parquet";
  const partRows = options.partRows ?? PART_ROWS;
  const tables = [...new Set(columns.map((c) => c.tableKey))];
  const files: DeliveryFile[] = [];
  for (const table of tables) {
    const tableColumns = columns.filter((c) => c.tableKey === table);
    const delivered: ParquetColumn[] = tableColumns
      .filter((c) => c.delivered && c.dataType !== "binary")
      .map((c) => ({ name: c.columnName, type: c.dataType as ParquetType }));
    const withheld = tableColumns.length - delivered.length;
    let after: string | null = null;
    let part = 0;
    let exhausted = false;
    while (!exhausted) {
      const rows: Record<string, unknown>[] = [];
      while (rows.length < partRows) {
        const want = Math.min(PAGE_ROWS, partRows - rows.length);
        const page = await options.store.rows(delivery.id, table, after, want);
        rows.push(...page);
        const last = page[page.length - 1];
        if (last !== undefined) after = String(last["id"]);
        if (page.length < want) {
          exhausted = true;
          break;
        }
      }
      // The previous part ended exactly at the last row: nothing is left to write.
      if (rows.length === 0 && part > 0) break;
      part += 1;
      const name =
        exhausted && part === 1
          ? `${table}.${extension}`
          : `${table}.part-${String(part).padStart(4, "0")}.${extension}`;
      const file = encodeFile(delivery.format, delivered, rows);
      const objectKey = `${prefix}/${name}`;
      await provider.put(delivery.target, secret, {
        key: objectKey,
        body: file.body,
        contentType: file.contentType,
      });
      const record: DeliveryFile = {
        tableKey: table,
        objectKey,
        rowCount: rows.length,
        byteCount: file.body.byteLength,
        sha256: sha256Hex(file.body),
        columnsDelivered: delivered.length,
        columnsWithheld: withheld,
      };
      await options.store.recordFile(delivery.id, record);
      files.push(record);
    }
  }
  const schema = publishedSchema(columns);
  const encoder = new TextEncoder();
  await provider.put(delivery.target, secret, {
    key: `${prefix}/_schema.json`,
    body: encoder.encode(JSON.stringify(schema, null, 2)),
    contentType: "application/json",
  });
  await provider.put(delivery.target, secret, {
    key: `${prefix}/_manifest.json`,
    body: encoder.encode(
      JSON.stringify(
        {
          delivery_id: delivery.id,
          org_id: delivery.orgId,
          snapshot_at: delivery.snapshotAt,
          format: delivery.format,
          schema_version: WAREHOUSE_SCHEMA_VERSION,
          files: files.map((f) => ({
            table: f.tableKey,
            key: f.objectKey,
            rows: f.rowCount,
            bytes: f.byteCount,
            sha256: f.sha256,
          })),
        },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });
  await options.store.complete(delivery.id, prefix, WAREHOUSE_SCHEMA_VERSION);
  return { files: files.length, rows: files.reduce((n, f) => n + f.rowCount, 0) };
}

/** The schema of one delivery: every table with its delivered columns and the columns withheld, with why. */
export function publishedSchema(columns: readonly DeliveryColumn[]) {
  const tables = [...new Set(columns.map((c) => c.tableKey))];
  return {
    schema_version: WAREHOUSE_SCHEMA_VERSION,
    tables: tables.map((table) => ({
      name: table,
      columns: columns
        .filter((c) => c.tableKey === table && c.delivered && c.dataType !== "binary")
        .map((c) => ({
          name: c.columnName,
          type: c.dataType,
          nullable: true,
          classification: c.classification,
        })),
      withheld: columns
        .filter((c) => c.tableKey === table && !(c.delivered && c.dataType !== "binary"))
        .map((c) => ({ name: c.columnName, reason: c.withheldReason ?? "encrypted" })),
    })),
  };
}

async function runOne(
  deliveryId: string,
  options: WarehouseWorkerOptions,
): Promise<DeliveryOutcome> {
  let delivery: ClaimedDelivery | null;
  try {
    delivery = await options.store.claim(deliveryId);
  } catch (error) {
    if (error instanceof StoreError && error.error.kind === "refusal") {
      return { deliveryId, result: "skipped", reason: error.error.rule };
    }
    throw error;
  }
  if (delivery === null)
    return { deliveryId, result: "skipped", reason: "warehouse_destination_unavailable" };
  try {
    const { files, rows } = await deliver(delivery, options);
    return { deliveryId, result: "delivered", files, rows };
  } catch (error) {
    const failure = asIntegrationError(error);
    const state = await options.store.fail(
      delivery.id,
      failure.code,
      failure.message,
      failure.retryable,
    );
    return { deliveryId, result: state === "Retrying" ? "retrying" : "failed", code: failure.code };
  }
}

/** One pass: queues the due nightly deliveries, then claims ready warehouse.deliver jobs and runs each once. */
export async function runWarehouseDeliveries(
  options: WarehouseWorkerOptions,
): Promise<{ readonly queued: number; readonly outcomes: readonly DeliveryOutcome[] }> {
  const queued = await options.store.queueDue();
  const jobs = await options.queue.claim(options.worker, WAREHOUSE_DELIVER_JOB, options.limit ?? 2);
  const outcomes: DeliveryOutcome[] = [];
  for (const job of jobs) {
    try {
      outcomes.push(await runOne(job.subjectId, options));
      await options.queue.finish(job.id, true, null);
    } catch (error) {
      await options.queue.finish(
        job.id,
        false,
        error instanceof Error ? error.message : String(error),
      );
      outcomes.push({ deliveryId: job.subjectId, result: "skipped", reason: "runner_error" });
    }
  }
  return { queued, outcomes };
}

/**
 * An HTTP client that refuses hosts resolving to private addresses: a customer names the bucket endpoint, so
 * the worker repeats the webhook SSRF guard (A69) after DNS resolution, as the webhook dispatcher does.
 */
export function publicHostHttp(http: HttpClient, resolve: HostResolver): HttpClient {
  return async (request) => {
    const host = new URL(request.url).hostname.replace(/^\[|\]$/g, "");
    const addresses = /^[\d.]+$|:/.test(host) ? [host] : await resolve(host);
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
      throw new IntegrationError(
        "warehouse_private_endpoint",
        "The bucket endpoint resolves to a private address.",
      );
    }
    return http(request);
  };
}

interface ClaimRow {
  delivery_id: string;
  org_id: string;
  destination_id: string;
  provider: WarehouseProviderName;
  bucket_name: string;
  region: string | null;
  endpoint_url: string | null;
  path_prefix: string;
  file_format: WarehouseFormat;
  include_confidential: boolean;
  attempt: number;
  snapshot_at: string;
}

interface ColumnRow {
  table_key: string;
  column_name: string;
  ordinal: number;
  data_type: ParquetType | "binary";
  classification: string | null;
  delivered: boolean;
  withheld_reason: string | null;
}

/** The delivery store over the service-role client (the RPCs of migration 1401). */
export function supabaseWarehouseStore(db: DbClient): WarehouseStore {
  return {
    async queueDue() {
      return unwrap<number>(db.rpc("queue_due_warehouse_deliveries"));
    },
    async claim(deliveryId) {
      const rows = await unwrap<ClaimRow[]>(
        db.rpc("claim_warehouse_delivery", { p_delivery_id: deliveryId }),
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        id: row.delivery_id,
        orgId: row.org_id,
        destinationId: row.destination_id,
        target: {
          provider: row.provider,
          bucket: row.bucket_name,
          region: row.region,
          endpointUrl: row.endpoint_url,
        },
        pathPrefix: row.path_prefix,
        format: row.file_format,
        includeConfidential: row.include_confidential,
        attempt: row.attempt,
        snapshotAt: row.snapshot_at,
      };
    },
    async columns(deliveryId) {
      const rows = await unwrap<ColumnRow[]>(
        db.rpc("warehouse_delivery_columns", { p_delivery_id: deliveryId }),
      );
      return rows.map((r) => ({
        tableKey: r.table_key,
        columnName: r.column_name,
        ordinal: r.ordinal,
        dataType: r.data_type,
        classification: r.classification,
        delivered: r.delivered,
        withheldReason: r.withheld_reason,
      }));
    },
    async rows(deliveryId, tableKey, after, limit) {
      return unwrap<Record<string, unknown>[]>(
        db.rpc("warehouse_table_rows", {
          p_delivery_id: deliveryId,
          p_table_key: tableKey,
          p_after: after,
          p_limit: limit,
        }),
      );
    },
    async credential(destinationId) {
      return unwrap<string>(
        db.rpc("read_warehouse_credential", { p_destination_id: destinationId }),
      );
    },
    async recordFile(deliveryId, file) {
      await unwrap(
        db.rpc("record_warehouse_delivery_file", {
          p_delivery_id: deliveryId,
          p_table_key: file.tableKey,
          p_object_key: file.objectKey,
          p_row_count: file.rowCount,
          p_byte_count: file.byteCount,
          p_sha256: file.sha256,
          p_columns_delivered: file.columnsDelivered,
          p_columns_withheld: file.columnsWithheld,
        }),
      );
    },
    async complete(deliveryId, objectPrefix, schemaVersion) {
      await unwrap(
        db.rpc("complete_warehouse_delivery", {
          p_delivery_id: deliveryId,
          p_object_prefix: objectPrefix,
          p_schema_version: schemaVersion,
        }),
      );
    },
    async fail(deliveryId, code, message, retryable) {
      return unwrap<string>(
        db.rpc("fail_warehouse_delivery", {
          p_delivery_id: deliveryId,
          p_error_code: code,
          p_error_message: message,
          p_retryable: retryable,
        }),
      );
    },
  };
}
