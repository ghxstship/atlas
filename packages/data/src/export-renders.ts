import type { SupabaseClient } from "@supabase/supabase-js";
import { csvField } from "./csv.ts";
import { preferReplica } from "./read-replica.ts";
import { defaultWatermark, renderTablePdf, type DataClassification } from "./report-files.ts";

/**
 * The export.render worker (A102, RRR-146; migration 2030; Section 4.6.4, 8.6). Atlas asks for an
 * export of a collection's current view through app.request_export, which records its columns,
 * headers, filters, classification and watermark and queues an export.render job. This worker, the
 * same loop as report-runs.ts, claims those jobs (app.claim_export_renders), reads each export's
 * rows as the person who asked for it (app.export_job_rows: their row level security, from the read
 * replica when there is one), writes CSV, .xlsx or PDF to the private export-files bucket and records
 * the outcome (app.finish_export_render). A Confidential or Restricted PDF carries the requester's
 * email and the time on every page. A failed attempt goes back to Queued while the job has attempts
 * left, then the export is marked Failed with the reason. Each pass also removes the files whose
 * 7-day download expired and marks those exports Expired.
 *
 * Values leave as stored: text and codes as text, numbers as numbers, money in minor units beside its
 * currency column, and NULL as an empty cell, never zero (Section 3.11). CSV fields are neutralized
 * against formulas (A69-005).
 */
export const EXPORT_RENDER_JOB = "export.render";
export const EXPORT_FILES_BUCKET = "export-files";

export type ExportFormat = "CSV" | "XLSX" | "PDF";

/** Rows a file holds at most; a PDF is meant for reading, so it stops sooner. The file says when it is cut. */
export const EXPORT_ROW_LIMITS: Readonly<Record<ExportFormat, number>> = {
  CSV: 50_000,
  XLSX: 50_000,
  PDF: 2_000,
};

/** Media type of each export format. */
export const EXPORT_CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = {
  CSV: "text/csv",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  PDF: "application/pdf",
};

/** An export the worker claimed, with what its file needs. */
export interface ClaimedExport {
  readonly jobId: string;
  readonly exportId: string;
  readonly orgId: string;
  readonly format: ExportFormat;
  readonly label: string;
  readonly classification: DataClassification;
  /** Set for Confidential and Restricted exports (Section 8.6). */
  readonly watermark: boolean;
  readonly requestedAt: string;
  readonly requesterEmail: string | null;
  readonly locale: string;
  readonly timeZone: string;
}

/** One column of an export, in file order. */
export interface ExportColumn {
  readonly name: string;
  readonly header: string;
}

export type ExportOutcome =
  | { readonly ok: true; readonly path: string; readonly rowCount: number }
  | { readonly ok: false; readonly error: string };

/** The database side of the worker; supabaseExportRenderStore implements it over the service role. */
export interface ExportRenderStore {
  claim(worker: string, limit: number): Promise<readonly ClaimedExport[]>;
  columns(exportId: string): Promise<readonly ExportColumn[]>;
  /** At most `limit` rows; fewer only when the export has no more (the worker tells a cut file by limit + 1). */
  rows(exportId: string, limit: number): Promise<readonly Record<string, unknown>[]>;
  /** Records the attempt; answers the export's status after it (Queued means it will retry). */
  finish(jobId: string, outcome: ExportOutcome): Promise<string>;
  /** Ready exports whose download expired, with their files. */
  expired(limit: number): Promise<readonly { readonly exportId: string; readonly path: string }[]>;
  markExpired(exportId: string): Promise<void>;
}

export interface ExportFiles {
  upload(
    bucket: string,
    name: string,
    body: string | Uint8Array,
    contentType: string,
  ): Promise<void>;
  remove(bucket: string, names: readonly string[]): Promise<void>;
}

/** The copy of an export file, in the requester's language and time zone. */
export interface ExportCopy {
  /** The line under the title of a PDF: how many rows and when. */
  subtitle(input: { readonly rows: number; readonly at: Date; readonly timeZone: string }): string;
  /** The note under a table cut at the format's row limit. */
  truncated(input: { readonly limit: number }): string;
  /** The Section 8.6 watermark: who the file was made for and when. */
  watermark(input: {
    readonly email: string;
    readonly at: Date;
    readonly timeZone: string;
  }): string;
}

/** Copy for callers without a catalog, such as tests and scripts. */
export const DEFAULT_EXPORT_COPY: ExportCopy = {
  subtitle: ({ rows, at }) => `${rows} rows, ${at.toISOString().slice(0, 10)}`,
  truncated: ({ limit }) => `Only the first ${limit} rows are in this file.`,
  watermark: ({ email, at }) => defaultWatermark({ email, at }),
};

export interface ExportRenderResult {
  readonly jobId: string;
  readonly exportId: string;
  readonly status: "Ready" | "Queued" | "Failed";
  readonly error?: string;
}

/** The object name of an export's file, the same as private.export_file_path. */
export function exportFilePath(orgId: string, exportId: string, format: ExportFormat): string {
  return `${orgId}/${exportId}.${format.toLowerCase()}`;
}

/** A stored value as a spreadsheet cell: NULL stays empty, numbers and booleans keep their type. */
export function exportCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string")
    return value;
  return JSON.stringify(value);
}

/** A stored value as display text: empty for NULL. */
export function exportText(value: unknown): string {
  const cell = exportCell(value);
  return cell === null ? "" : String(cell);
}

/** The CSV: one header row, then one line per row, every field neutralized (A69-005). */
export function renderExportCsv(
  columns: readonly ExportColumn[],
  rows: readonly Record<string, unknown>[],
): string {
  const lines = [columns.map((c) => csvField(c.header)).join(",")];
  for (const row of rows)
    lines.push(columns.map((c) => csvField(exportText(row[c.name]))).join(","));
  return `${lines.join("\n")}\n`;
}

/** A sheet name Excel accepts: at most 31 characters, none of \ / ? * [ ] : */
export function sheetName(label: string): string {
  return (
    label
      .replace(/[\\/?*[\]:]/g, " ")
      .trim()
      .slice(0, 31) || "Export"
  );
}

/** The .xlsx workbook: the header row frozen at the top, then the rows, numbers as numbers. */
export async function renderExportXlsx(input: {
  readonly label: string;
  readonly columns: readonly ExportColumn[];
  readonly rows: readonly Record<string, unknown>[];
  readonly note: string | null;
}): Promise<Uint8Array> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "XOS";
  const sheet = workbook.addWorksheet(sheetName(input.label), {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.addRow(input.columns.map((c) => c.header)).font = { bold: true };
  for (const row of input.rows) sheet.addRow(input.columns.map((c) => exportCell(row[c.name])));
  if (input.note) {
    sheet.addRow([]);
    sheet.addRow([input.note]);
  }
  sheet.columns.forEach((column) => {
    column.width = 20;
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

/** The PDF: the label, the row count and time, then the table, watermarked when the export asks for it. */
export async function renderExportPdf(input: {
  readonly label: string;
  readonly subtitle: string;
  readonly columns: readonly ExportColumn[];
  readonly rows: readonly Record<string, unknown>[];
  readonly note: string | null;
  readonly watermark: string | null;
}): Promise<Uint8Array> {
  const numeric = input.columns.map((c) => {
    const values = input.rows.map((r) => r[c.name]).filter((v) => v !== null && v !== undefined);
    return values.length > 0 && values.every((v) => typeof v === "number");
  });
  return renderTablePdf({
    title: input.label,
    subtitle: input.subtitle,
    header: input.columns.map((c) => c.header),
    rows: input.rows.map((r) => input.columns.map((c) => exportText(r[c.name]).slice(0, 500))),
    numeric,
    note: input.note,
    watermark: input.watermark,
    fontSize: 8,
  });
}

/** Builds the file of one claimed export; throws an Error whose message is for the requester. */
async function renderClaimed(
  store: ExportRenderStore,
  copy: ExportCopy,
  claimed: ClaimedExport,
  now: Date,
): Promise<{ body: string | Uint8Array; rowCount: number }> {
  const columns = await store.columns(claimed.exportId);
  if (columns.length === 0) throw new Error("The export names no columns.");
  const limit = EXPORT_ROW_LIMITS[claimed.format];
  const read = await store.rows(claimed.exportId, limit + 1);
  const rows = read.length > limit ? read.slice(0, limit) : read;
  const note = read.length > limit ? copy.truncated({ limit }) : null;
  if (claimed.format === "CSV")
    return { body: renderExportCsv(columns, rows), rowCount: rows.length };
  if (claimed.format === "XLSX") {
    return {
      body: await renderExportXlsx({ label: claimed.label, columns, rows, note }),
      rowCount: rows.length,
    };
  }
  if (claimed.watermark && !claimed.requesterEmail) {
    throw new Error("The watermark needs the email of the person who asked for the export.");
  }
  const watermark =
    claimed.watermark && claimed.requesterEmail
      ? copy.watermark({ email: claimed.requesterEmail, at: now, timeZone: claimed.timeZone })
      : null;
  return {
    body: await renderExportPdf({
      label: claimed.label,
      subtitle: copy.subtitle({ rows: rows.length, at: now, timeZone: claimed.timeZone }),
      columns,
      rows,
      note,
      watermark,
    }),
    rowCount: rows.length,
  };
}

/**
 * One pass of the worker: claims ready export.render jobs and runs one attempt of each, then removes
 * the files whose download expired. `copy` gives the file copy for the requester's language.
 */
export async function runExportRenders(options: {
  readonly store: ExportRenderStore;
  readonly files: ExportFiles;
  readonly copy: (locale: string) => ExportCopy | Promise<ExportCopy>;
  readonly worker: string;
  readonly limit?: number;
  readonly now?: () => Date;
  readonly warn?: (message: string) => void;
}): Promise<{ readonly renders: readonly ExportRenderResult[]; readonly expired: number }> {
  const { store, files, worker } = options;
  const now = options.now ?? (() => new Date());
  const renders: ExportRenderResult[] = [];
  for (const claimed of await store.claim(worker, options.limit ?? 5)) {
    try {
      const out = await renderClaimed(store, await options.copy(claimed.locale), claimed, now());
      const path = exportFilePath(claimed.orgId, claimed.exportId, claimed.format);
      await files.upload(EXPORT_FILES_BUCKET, path, out.body, EXPORT_CONTENT_TYPES[claimed.format]);
      await store.finish(claimed.jobId, { ok: true, path, rowCount: out.rowCount });
      renders.push({ jobId: claimed.jobId, exportId: claimed.exportId, status: "Ready" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The queue retries with backoff until the kind's attempts are used, then the export is Failed.
      const status = await store.finish(claimed.jobId, { ok: false, error: message });
      renders.push({
        jobId: claimed.jobId,
        exportId: claimed.exportId,
        status: status === "Queued" ? "Queued" : "Failed",
        error: message,
      });
    }
  }
  let expired = 0;
  for (const due of await store.expired(50)) {
    try {
      await files.remove(EXPORT_FILES_BUCKET, [due.path]);
      await store.markExpired(due.exportId);
      expired += 1;
    } catch (error) {
      // Left Ready past its expiry, which no policy serves; the next pass tries again.
      options.warn?.(`export-render: ${due.path} not removed (${String(error)})`);
    }
  }
  return { renders, expired };
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string")
    throw new Error(`Expected text in ${key} of the database response.`);
  return value;
}

/** The one jsonb array export_job_rows answers; null reads as no rows. */
function exportRowsArray(data: unknown): readonly unknown[] {
  if (data === null || data === undefined) return [];
  if (!Array.isArray(data))
    throw new Error("export_job_rows answered something other than an array of rows.");
  return data;
}

const FORMATS: readonly ExportFormat[] = ["CSV", "XLSX", "PDF"];
const CLASSES: readonly DataClassification[] = ["Public", "Internal", "Confidential", "Restricted"];

export interface ExportRenderStoreOptions {
  /**
   * A service-role client on the read replica (`read-replica.ts`, Section 5.1). Row reads prefer it and
   * fall back to `client` when it errors or lags; claims, columns and writes stay on `client`.
   */
  readonly replica?: SupabaseClient | null;
  /** Called when the primary answers a read the replica could not. */
  readonly onReplicaFallback?: (label: string, reason: unknown) => void;
}

/** ExportRenderStore over the service-role client: the 2030 worker RPCs and export_job_columns. */
export function supabaseExportRenderStore(
  client: SupabaseClient,
  options: ExportRenderStoreOptions = {},
): ExportRenderStore {
  const app = client.schema("app");
  const call = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await app.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  return {
    async claim(worker, limit) {
      const rows = (await call("claim_export_renders", { p_worker: worker, p_limit: limit })) as
        Record<string, unknown>[] | null;
      return (rows ?? []).map((r) => {
        const format = text(r, "export_format") as ExportFormat;
        const level = text(r, "classification") as DataClassification;
        if (!FORMATS.includes(format)) throw new Error(`Unknown export format ${format}.`);
        if (!CLASSES.includes(level)) throw new Error(`Unknown classification ${level}.`);
        const email = r["requester_email"];
        return {
          jobId: text(r, "job_id"),
          exportId: text(r, "export_job_id"),
          orgId: text(r, "org_id"),
          format,
          label: text(r, "source_label"),
          classification: level,
          watermark: r["watermark"] === true,
          requestedAt: text(r, "requested_at"),
          requesterEmail: typeof email === "string" ? email : null,
          locale: typeof r["locale"] === "string" ? r["locale"] : "en-US",
          timeZone: typeof r["time_zone"] === "string" ? r["time_zone"] : "UTC",
        };
      });
    },
    async columns(exportId) {
      const { data, error } = await app
        .from("export_job_columns")
        .select("column_name, header_label")
        .eq("export_job_id", exportId)
        .is("deleted_at", null)
        .order("column_position", { ascending: true, nullsFirst: false })
        .order("id", { ascending: true });
      if (error) throw new Error(`export_job_columns: ${error.message}`);
      return ((data ?? []) as Record<string, unknown>[]).map((r) => {
        const header = r["header_label"];
        return {
          name: text(r, "column_name"),
          header:
            typeof header === "string" && header.trim() !== "" ? header : text(r, "column_name"),
        };
      });
    },
    async rows(exportId, limit) {
      const args = { p_export_job_id: exportId, p_limit: limit };
      // export_job_rows answers one jsonb array (2360), never a set: PostgREST caps a set-returning function
      // at max_rows (1,000), which would cut a larger export short without a note.
      // On the replica the read goes as GET, which a read-only standby serves (export_job_rows is stable).
      // An export the replica does not yet see as Rendering is refused there, and the primary answers.
      const rows = await preferReplica(
        client,
        options.replica,
        async (c, onReplica) => {
          if (!onReplica) return exportRowsArray(await call("export_job_rows", args));
          const { data, error } = await c.schema("app").rpc("export_job_rows", args, { get: true });
          if (error) throw new Error(`export_job_rows on the replica: ${error.message}`);
          return exportRowsArray(data);
        },
        { label: "export rows", onFallback: options.onReplicaFallback },
      );
      return rows.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
    },
    async finish(jobId, outcome) {
      return String(
        await call(
          "finish_export_render",
          outcome.ok
            ? {
                p_job_id: jobId,
                p_succeeded: true,
                p_storage_object_path: outcome.path,
                p_row_count: outcome.rowCount,
              }
            : { p_job_id: jobId, p_succeeded: false, p_error: outcome.error },
        ),
      );
    },
    async expired(limit) {
      const rows = (await call("expired_export_files", { p_limit: limit })) as
        Record<string, unknown>[] | null;
      return (rows ?? []).map((r) => ({
        exportId: text(r, "export_job_id"),
        path: text(r, "storage_object_path"),
      }));
    },
    async markExpired(exportId) {
      await call("mark_export_expired", { p_export_job_id: exportId });
    },
  };
}

/** ExportFiles over Supabase Storage of the service-role client; an existing file is replaced. */
export function supabaseExportFiles(client: SupabaseClient): ExportFiles {
  return {
    async upload(bucket, name, body, contentType) {
      const { error } = await client.storage
        .from(bucket)
        .upload(
          name,
          new Blob([typeof body === "string" ? body : new Uint8Array(body)], { type: contentType }),
          { contentType, upsert: true },
        );
      if (error) throw new Error(`storage ${bucket}: ${error.message}`);
    },
    async remove(bucket, names) {
      const { error } = await client.storage.from(bucket).remove([...names]);
      if (error) throw new Error(`storage ${bucket}: ${error.message}`);
    },
  };
}
