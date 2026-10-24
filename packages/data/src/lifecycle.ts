import type { XosClient } from "./client.ts";
import { csvField } from "./csv.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { num, rows, rpc, str, strOrNull, type Raw } from "./platform-common.ts";
import { untyped } from "./untyped.ts";
import { zip, type ZipEntry } from "./zip.ts";

/**
 * Org lifecycle (A36, migration 1063; Section 14.7 and 14.8): cancel an org, read its cancellation for
 * the read-only banner, reactivate it within 30 days, and build the full export: one archive with JSON
 * and CSV of every tenant table, the org's stored files and a manifest, read with the Owner's own row
 * level security.
 */

export interface Cancellation {
  readonly id: string;
  readonly reason: string;
  readonly canceledAt: string;
  readonly readOnlyUntil: string;
  readonly purgeAfter: string;
}

/** The org's live cancellation, or null when the org is not canceled. */
export async function getCancellation(
  db: XosClient,
  orgId: string,
): Promise<Result<Cancellation | null>> {
  const result = await rows(
    untyped(db)
      .from("org_cancellations")
      .select("id, reason, canceled_at, read_only_until, purge_after")
      .eq("org_id", orgId)
      .is("reactivated_at", null)
      .is("deleted_at", null)
      .limit(1),
  );
  if (!result.ok) return result;
  const r = result.data[0];
  return ok(
    r
      ? {
          id: str(r["id"]),
          reason: str(r["reason"]),
          canceledAt: str(r["canceled_at"]),
          readOnlyUntil: str(r["read_only_until"]),
          purgeAfter: str(r["purge_after"]),
        }
      : null,
  );
}

/** Whole days left until a moment, never below zero. */
export function daysUntil(iso: string, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now.getTime()) / 86_400_000));
}

export function cancelOrganization(
  db: XosClient,
  input: { orgId: string; confirmName: string; reason: string },
): Promise<Result<string>> {
  return rpc(
    db,
    "cancel_organization",
    { p_org_id: input.orgId, p_confirm_name: input.confirmName, p_reason: input.reason },
    str,
  );
}

export function reactivateOrganization(db: XosClient, orgId: string): Promise<Result<string>> {
  return rpc(db, "reactivate_organization", { p_org_id: orgId }, str);
}

export function canExportOrg(db: XosClient, orgId: string): Promise<Result<boolean>> {
  return rpc(db, "can_export_org", { p_org_id: orgId }, (d) => d === true);
}

export interface ExportTable {
  readonly table: string;
  readonly columns: readonly string[];
}

/** As GET, which a read replica serves: org_export_tables is stable (migration 1063). */
export async function listExportTables(
  db: XosClient,
  orgId: string,
): Promise<Result<ExportTable[]>> {
  const { data, error } = await untyped(db).rpc(
    "org_export_tables",
    { p_org_id: orgId },
    { get: true },
  );
  if (error) return fail(toDataError(error));
  return ok(
    ((data as Raw[] | null) ?? []).map((r) => ({
      table: str(r["table_name"]),
      columns: Array.isArray(r["columns"]) ? (r["columns"] as unknown[]).map(str) : [],
    })),
  );
}

export interface OrgExportLog {
  readonly id: string;
  readonly createdAt: string;
  readonly tableCount: number;
  readonly rowCount: number;
  readonly fileCount: number;
}

export async function listOrgExports(
  db: XosClient,
  orgId: string,
): Promise<Result<OrgExportLog[]>> {
  const result = await rows(
    untyped(db)
      .from("org_exports")
      .select("id, created_at, table_count, row_count, file_count")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(10),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      id: str(r["id"]),
      createdAt: str(r["created_at"]),
      tableCount: num(r["table_count"]),
      rowCount: num(r["row_count"]),
      fileCount: num(r["file_count"]),
    })),
  );
}

// CSV ---------------------------------------------------------------------------------------------------------

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return csvField(typeof value === "object" ? JSON.stringify(value) : String(value));
}

/**
 * RFC 4180 CSV of rows with a header line, in the given column order. Cells a spreadsheet would run
 * as formulas are neutralized (A69-005); the archive's JSON keeps every value exactly.
 */
export function toCsv(columns: readonly string[], data: readonly Raw[]): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of data) lines.push(columns.map((c) => csvCell(row[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

// The archive ------------------------------------------------------------------------------------------------

/** Rows read per request; PostgREST caps a response at its max rows. */
export const EXPORT_PAGE = 1000;
/** Stored files included at most, and their total size, so one archive stays downloadable. */
export const EXPORT_FILE_LIMIT = 500;
export const EXPORT_FILE_BYTES = 500 * 1024 * 1024;

export interface ExportManifest {
  readonly format: "xos-org-export";
  readonly version: 1;
  readonly orgId: string;
  readonly orgSlug: string;
  readonly createdAt: string;
  readonly tables: readonly { table: string; rows: number; json: string; csv: string }[];
  readonly files: readonly { path: string; bytes: number; sha256: string | null; source: string }[];
  readonly filesOmitted: number;
  readonly unreadableTables: readonly string[];
}

export interface OrgExport {
  readonly archive: Uint8Array;
  readonly manifest: ExportManifest;
  readonly manifestSha256: string;
  readonly rowCount: number;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readTable(db: XosClient, orgId: string, t: ExportTable): Promise<Result<Raw[]>> {
  const out: Raw[] = [];
  for (let from = 0; ; from += EXPORT_PAGE) {
    const page = await rows(
      untyped(db)
        .from(t.table)
        .select(t.columns.join(","))
        .eq("org_id", orgId)
        .order(t.columns.includes("id") ? "id" : (t.columns[0] ?? "org_id"))
        .range(from, from + EXPORT_PAGE - 1),
    );
    if (!page.ok) return page;
    out.push(...page.data);
    if (page.data.length < EXPORT_PAGE) return ok(out);
  }
}

/**
 * Builds the full export of an org as the caller (the Owner): every tenant table the caller may read,
 * filtered to the org, as JSON and CSV; the org's clean attachment files; and manifest.json with counts
 * and file hashes. Tables the caller cannot read at all are listed in the manifest, never skipped
 * silently.
 */
export async function buildOrgExport(
  db: XosClient,
  org: { id: string; slug: string },
  now: Date = new Date(),
  /** Downloads the stored files; the primary when `db` is a read replica, which serves no Storage. */
  storageClient: XosClient = db,
): Promise<Result<OrgExport>> {
  const tables = await listExportTables(db, org.id);
  if (!tables.ok) return tables;
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  const manifestTables: { table: string; rows: number; json: string; csv: string }[] = [];
  const unreadable: string[] = [];
  let rowCount = 0;
  for (const t of tables.data) {
    const data = await readTable(db, org.id, t);
    if (!data.ok) {
      unreadable.push(t.table);
      continue;
    }
    const json = `records/${t.table}.json`;
    const csv = `records/${t.table}.csv`;
    entries.push({ name: json, data: encoder.encode(JSON.stringify(data.data, null, 2)) });
    entries.push({ name: csv, data: encoder.encode(toCsv(t.columns, data.data)) });
    manifestTables.push({ table: t.table, rows: data.data.length, json, csv });
    rowCount += data.data.length;
  }

  const files: { path: string; bytes: number; sha256: string | null; source: string }[] = [];
  let omitted = 0;
  const versions = await rows(
    untyped(db)
      .from("attachment_versions")
      .select("id, object_name, filename, size_bytes, checksum_sha256")
      .eq("org_id", org.id)
      .eq("scan_status", "Clean")
      .is("deleted_at", null)
      .order("id")
      .limit(5000),
  );
  if (!versions.ok) return versions;
  let bytes = 0;
  for (const v of versions.data) {
    const size = num(v["size_bytes"]);
    if (files.length >= EXPORT_FILE_LIMIT || bytes + size > EXPORT_FILE_BYTES) {
      omitted += 1;
      continue;
    }
    const { data, error } = await storageClient.storage
      .from("attachments")
      .download(str(v["object_name"]));
    if (error || !data) {
      omitted += 1;
      continue;
    }
    const body = new Uint8Array(await data.arrayBuffer());
    const path = `files/attachments/${str(v["id"])}-${str(v["filename"]).replace(/[^A-Za-z0-9._-]+/g, "_")}`;
    entries.push({ name: path, data: body });
    files.push({
      path,
      bytes: body.length,
      sha256: strOrNull(v["checksum_sha256"]),
      source: "attachments",
    });
    bytes += body.length;
  }

  const manifest: ExportManifest = {
    format: "xos-org-export",
    version: 1,
    orgId: org.id,
    orgSlug: org.slug,
    createdAt: now.toISOString(),
    tables: manifestTables,
    files,
    filesOmitted: omitted,
    unreadableTables: unreadable,
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest, null, 2));
  const manifestSha256 = await sha256Hex(manifestBytes);
  return ok({
    archive: zip([{ name: "manifest.json", data: manifestBytes }, ...entries], now),
    manifest,
    manifestSha256,
    rowCount,
  });
}

/** Logs a downloaded export with its counts and manifest hash. */
export async function recordOrgExport(
  db: XosClient,
  orgId: string,
  built: OrgExport,
): Promise<Result<string>> {
  const { data, error } = await untyped(db).rpc("record_org_export", {
    p_org_id: orgId,
    p_table_count: built.manifest.tables.length,
    p_row_count: built.rowCount,
    p_file_count: built.manifest.files.length,
    p_manifest_sha256: built.manifestSha256,
  });
  if (error) return fail(toDataError(error));
  return ok(str(data));
}
