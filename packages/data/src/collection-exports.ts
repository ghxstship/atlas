import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Exports of a collection's current view (A102, RRR-146; migration 1680; Section 4.6.4, 8.6). Atlas's export menu
 * asks for one through {@link requestCollectionExport}: the columns of one table or view, their headers in the
 * viewer's language and the view's filters. The database classifies the columns (Confidential needs the export
 * capability, Restricted the restricted capability and step-up), refuses medical data and queues the export.render
 * job; the worker writes the file. {@link getCollectionExport} follows it, and {@link collectionExportDownload}
 * logs the download and answers a short-lived signed link, which the storage policy holds to the same rules.
 */

export const EXPORT_FILES_BUCKET = "export-files";

export type ExportFormat = Database["app"]["Enums"]["export_format"];
export type ExportStatus = Database["app"]["Enums"]["export_status"];
export type ExportClassification = Database["app"]["Enums"]["data_classification"];

export const EXPORT_FORMATS: readonly ExportFormat[] = ["CSV", "XLSX", "PDF"];

/**
 * An equality on a column of the source, a list of values one of which it holds (comma-separated, as the
 * collections' URLs carry them), or the collection's search across the exported columns.
 */
export type ExportFilter =
  | { readonly operator: "eq" | "in"; readonly column: string; readonly value: string }
  | { readonly operator: "search"; readonly value: string };

export interface CollectionExportRequest {
  readonly orgId: string;
  readonly format: ExportFormat;
  /** What is exported, as the export list shows it: the collection's name. */
  readonly label: string;
  /** Schema-qualified relation of every column: app.<name> or xpms.<name>. */
  readonly relation: string;
  readonly columns: readonly string[];
  /** One header per column, in the viewer's language. */
  readonly headers: readonly string[];
  readonly filters: readonly ExportFilter[];
}

export interface CollectionExport {
  readonly id: string;
  readonly status: ExportStatus;
  readonly format: ExportFormat;
  readonly label: string;
  readonly classification: ExportClassification;
  readonly watermark: boolean;
  readonly rowCount: number | null;
  readonly expiresAt: string | null;
  readonly error: string | null;
}

/** Asks for an export; answers its id. Refusals (step_up_required, export_restricted, ...) come back typed. */
export async function requestCollectionExport(
  db: XosClient,
  request: CollectionExportRequest,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("request_export", {
    p_org_id: request.orgId,
    p_format: request.format,
    p_source_label: request.label.slice(0, 200),
    p_columns: request.columns.map((c) => `${request.relation}.${c}`),
    p_headers: [...request.headers],
    p_filters: request.filters.map((f) =>
      f.operator === "search"
        ? { operator: "search", value: f.value }
        : { operator: f.operator, column: f.column, value: f.value },
    ),
  });
  if (error) return fail(toDataError(error));
  if (typeof data !== "string") return fail({ kind: "unexpected", message: "no export id" });
  return ok(data);
}

/** One of the viewer's exports, with its progress. Another person's export is not found. */
export async function getCollectionExport(
  db: XosClient,
  id: string,
): Promise<Result<CollectionExport>> {
  const { data, error } = await db
    .from("export_jobs")
    .select(
      "id, export_status, export_format, source_label, classification, watermark, row_count, expires_at, last_error",
    )
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok({
    id: data.id,
    status: data.export_status,
    format: data.export_format,
    label: data.source_label,
    classification: data.classification,
    watermark: data.watermark,
    rowCount: data.row_count,
    expiresAt: data.expires_at,
    error: data.last_error,
  });
}

/** A file name for the download: the label in plain characters and the format's extension. */
export function exportFileName(label: string, format: ExportFormat): string {
  const base = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || "export"}.${format.toLowerCase()}`;
}

/**
 * Logs the download of the viewer's Ready export (app.record_export_download) and answers a signed link that
 * downloads it under a readable name for `expiresInSeconds`.
 */
export async function collectionExportDownload(
  db: XosClient,
  id: string,
  expiresInSeconds = 60,
): Promise<Result<{ readonly url: string; readonly fileName: string }>> {
  const { data, error } = await db.rpc("record_export_download", { p_export_job_id: id });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : null) as {
    storage_object_path: string;
    export_format: ExportFormat;
    source_label: string;
  } | null;
  if (!row) return fail({ kind: "not-found" });
  const fileName = exportFileName(row.source_label, row.export_format);
  const signed = await db.storage
    .from(EXPORT_FILES_BUCKET)
    .createSignedUrl(row.storage_object_path, expiresInSeconds, { download: fileName });
  if (signed.error || !signed.data) return fail({ kind: "not-found" });
  return ok({ url: signed.data.signedUrl, fileName });
}
