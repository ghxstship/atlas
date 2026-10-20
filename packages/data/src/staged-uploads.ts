import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Uploads for the public buckets (migration 1265, ADR 0034 amendment). profile-media and org-brand are
 * read by public URL, so a file cannot wait there for its virus scan. It is uploaded to the private
 * upload-staging bucket as `<bucket>/<name>` instead, under the public bucket's own rules; the upload-scan
 * worker publishes it under `<name>` once it scans Clean, and removes it otherwise. The public object is
 * missing until then, so readers treat a path without an object as no file yet.
 */
export const UPLOAD_STAGING_BUCKET = "upload-staging";

export type PublicUploadBucket = "org-brand" | "profile-media";

/** The upload-staging name of a file meant for `name` in a public bucket. */
export function stagedUploadName(bucket: PublicUploadBucket, name: string): string {
  return `${bucket}/${name}`;
}

/** The scan of a staged upload, as its uploader sees it. */
export type StagedUploadStatus = "Scanning" | "Clean" | "Infected" | "Scan Failed";

const STATUSES: readonly string[] = ["Scanning", "Clean", "Infected", "Scan Failed"];

/**
 * Uploads a file for a public bucket into upload-staging. It appears at `name` in `bucket` once it scans
 * Clean; the storage policy refuses a file the caller may not put there, active content, and a type or
 * size the public bucket does not take.
 */
export async function stagePublicUpload(
  db: XosClient,
  bucket: PublicUploadBucket,
  name: string,
  file: Blob,
  contentType: string,
): Promise<Result<string>> {
  const staged = stagedUploadName(bucket, name);
  const { error } = await db.storage
    .from(UPLOAD_STAGING_BUCKET)
    .upload(staged, file, { contentType, upsert: false });
  if (error) return fail({ kind: "unexpected", message: error.message });
  return ok(staged);
}

/**
 * The uploader's view of the scan of a file staged for `name` in a public bucket (app.my_upload_scan_status):
 * Scanning while it waits, Infected or Scan Failed when it was removed instead of published. Null once it was
 * published (the staged row goes with the staged file), and for anyone but the uploader.
 */
export async function myStagedUploadStatus(
  db: XosClient,
  bucket: PublicUploadBucket,
  name: string,
): Promise<Result<StagedUploadStatus | null>> {
  const { data, error } = await untyped(db).rpc("my_upload_scan_status", {
    p_bucket_id: UPLOAD_STAGING_BUCKET,
    p_object_name: stagedUploadName(bucket, name),
  });
  if (error) return fail(toDataError(error));
  return ok(
    typeof data === "string" && STATUSES.includes(data) ? (data as StagedUploadStatus) : null,
  );
}
