import type { SupabaseClient } from "@supabase/supabase-js";
import { PlatformDbError, type PlatformDb } from "../stores.ts";
import {
  ATTACHMENT_SCAN_JOB,
  type ClaimedAttachmentScan,
  type ClaimedObjectScan,
  type ObjectStorage,
  type ScanStore,
} from "./worker.ts";

function rows(data: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(data) ? (data as Readonly<Record<string, unknown>>[]) : [];
}

function text(row: Readonly<Record<string, unknown>> | null | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string")
    throw new PlatformDbError(key, "expected text in the database response");
  return value;
}

function optionalText(
  row: Readonly<Record<string, unknown>> | null | undefined,
  key: string,
): string | null {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
}

function count(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

/** ScanStore over the 0510 job queue, the 0590 attachment RPC and the 1041 object scan RPCs. */
export function scanStore(db: PlatformDb): ScanStore {
  return {
    async claimAttachmentScans(worker, limit) {
      return rows(
        await db.rpc("claim_jobs", {
          p_worker: worker,
          p_job_kind: ATTACHMENT_SCAN_JOB,
          p_limit: limit,
        }),
      ).map((row): ClaimedAttachmentScan => ({
        jobId: text(row, "id"),
        attachmentVersionId: text(row, "subject_id"),
        attempts: count(row, "attempts"),
      }));
    },
    async attachmentVersion(attachmentVersionId) {
      const row = await db.selectOne(
        "attachment_versions",
        "object_name, filename, content_type, checksum_sha256, scan_status",
        { id: attachmentVersionId },
      );
      if (row === null) return null;
      return {
        objectName: text(row, "object_name"),
        filename: text(row, "filename"),
        contentType: text(row, "content_type"),
        checksumSha256: optionalText(row, "checksum_sha256"),
        scanStatus: text(row, "scan_status"),
      };
    },
    async recordAttachmentScan(attachmentVersionId, clean, detail) {
      return String(
        await db.rpc("record_attachment_scan", {
          p_attachment_version_id: attachmentVersionId,
          p_clean: clean,
          p_detail: detail,
        }),
      );
    },
    async finishJob(jobId, succeeded, error) {
      return String(
        await db.rpc("finish_job", { p_job_id: jobId, p_succeeded: succeeded, p_error: error }),
      );
    },
    async claimObjectScans(worker, limit) {
      return rows(await db.rpc("claim_object_scans", { p_worker: worker, p_limit: limit })).map(
        (row): ClaimedObjectScan => ({
          objectScanId: text(row, "object_scan_id"),
          bucketId: text(row, "bucket_id"),
          objectName: text(row, "object_name"),
          contentType: optionalText(row, "content_type"),
          attempts: count(row, "attempts"),
        }),
      );
    },
    async recordObjectScan(objectScanId, clean, detail) {
      return String(
        await db.rpc("record_object_scan", {
          p_object_scan_id: objectScanId,
          p_clean: clean,
          p_detail: detail,
        }),
      );
    },
    async releaseObjectScan(objectScanId, error) {
      return String(
        await db.rpc("release_object_scan", { p_object_scan_id: objectScanId, p_error: error }),
      );
    },
  };
}

/** ObjectStorage over a service-role Supabase client's Storage API. */
export function supabaseStorage(client: SupabaseClient): ObjectStorage {
  return {
    async download(bucket, name) {
      const { data, error } = await client.storage.from(bucket).download(name);
      if (error !== null) throw new PlatformDbError(`storage ${bucket}`, error.message);
      return new Uint8Array(await data.arrayBuffer());
    },
    async remove(bucket, name) {
      const { error } = await client.storage.from(bucket).remove([name]);
      if (error !== null) throw new PlatformDbError(`storage ${bucket}`, error.message);
    },
  };
}
