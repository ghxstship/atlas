import { checkContent } from "./content.ts";
import { ScannerUnavailableError, type VirusScanner } from "./scanner.ts";

/**
 * The upload scan worker (A22-011): one pass claims due scans, checks each file's bytes against its
 * declared type and checksum, scans it, and records the verdict.
 *
 * - Attachments: the A18 job `attachment.scan` (migration 0590), claimed from the job queue; the
 *   verdict goes to `app.record_attachment_scan`, so a Clean version becomes downloadable.
 * - The field-media, onboarding-uploads, imports, support-screenshots and upload-staging buckets (and
 *   any service-role write to profile-media or org-brand): `app.claim_object_scans` and
 *   `app.record_object_scan` (migrations 1041, 1240, 1265).
 * - Files for the public buckets profile-media and org-brand are uploaded to the private upload-staging
 *   bucket as `<bucket>/<name>` (1265). A staged file that scans Clean is published: written to its
 *   public bucket, recorded Clean, and removed from staging. Nothing reaches a public bucket unscanned.
 *
 * An infected or refused file is removed from storage after its verdict is recorded; a staged one is
 * never published, and its verdict stays for the uploader (app.my_upload_scan_status). When the scanner
 * or storage cannot answer, the scan is retried with backoff and recorded as Scan Failed after
 * `MAX_SCAN_ATTEMPTS`, so a file never stays in Scanning for ever and is never served unscanned.
 */
export const ATTACHMENT_SCAN_JOB = "attachment.scan";
/** Matches private.job_kinds.max_attempts for attachment.scan and app.release_object_scan. */
export const MAX_SCAN_ATTEMPTS = 5;

export interface ClaimedAttachmentScan {
  readonly jobId: string;
  readonly attachmentVersionId: string;
  readonly attempts: number;
}

export interface AttachmentVersionToScan {
  readonly objectName: string;
  readonly filename: string;
  readonly contentType: string;
  readonly checksumSha256: string | null;
  readonly scanStatus: string;
}

export interface ClaimedObjectScan {
  readonly objectScanId: string;
  readonly bucketId: string;
  readonly objectName: string;
  readonly contentType: string | null;
  readonly attempts: number;
}

export interface ScanStore {
  claimAttachmentScans(worker: string, limit: number): Promise<readonly ClaimedAttachmentScan[]>;
  attachmentVersion(attachmentVersionId: string): Promise<AttachmentVersionToScan | null>;
  recordAttachmentScan(
    attachmentVersionId: string,
    clean: boolean | null,
    detail: string | null,
  ): Promise<string>;
  finishJob(jobId: string, succeeded: boolean, error: string | null): Promise<string>;
  claimObjectScans(worker: string, limit: number): Promise<readonly ClaimedObjectScan[]>;
  recordObjectScan(
    objectScanId: string,
    clean: boolean | null,
    detail: string | null,
  ): Promise<string>;
  releaseObjectScan(objectScanId: string, error: string): Promise<string>;
}

export interface ObjectStorage {
  download(bucket: string, name: string): Promise<Uint8Array>;
  /** Writes an object, replacing one of the same name (publishing a staged upload). */
  upload(
    bucket: string,
    name: string,
    bytes: Uint8Array,
    contentType: string | null,
  ): Promise<void>;
  remove(bucket: string, name: string): Promise<void>;
}

/** The private bucket files for the public buckets are uploaded to first (migration 1265). */
export const UPLOAD_STAGING_BUCKET = "upload-staging";
/** The public buckets a staged upload may be published to. */
export const PUBLIC_UPLOAD_BUCKETS = ["org-brand", "profile-media"] as const;

/**
 * Where a staged upload is published: `org-brand/<org id>/logo.png` goes to org-brand as
 * `<org id>/logo.png`. Null for a name that names no public bucket.
 */
export function stagedUploadTarget(stagedName: string): { bucket: string; name: string } | null {
  const slash = stagedName.indexOf("/");
  if (slash <= 0 || slash === stagedName.length - 1) return null;
  const bucket = stagedName.slice(0, slash);
  if (!(PUBLIC_UPLOAD_BUCKETS as readonly string[]).includes(bucket)) return null;
  return { bucket, name: stagedName.slice(slash + 1) };
}

/** Storage could not return or delete an object; the scan is retried. */
export class StorageUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageUnavailableError";
  }
}

export type ScanResult =
  "clean" | "published" | "infected" | "refused" | "retrying" | "failed" | "skipped";

export interface ScanOutcome {
  readonly kind: "attachment" | "object";
  readonly id: string;
  readonly result: ScanResult;
  readonly detail?: string;
}

export interface ScanRunOptions {
  readonly store: ScanStore;
  readonly storage: ObjectStorage;
  readonly scanner: VirusScanner;
  readonly worker: string;
  readonly limit?: number;
}

type Verdict =
  | { readonly result: "clean"; readonly bytes: Uint8Array }
  | { readonly result: "infected" | "refused"; readonly detail: string };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fileNameOf(objectName: string): string {
  return objectName.split("/").at(-1) ?? objectName;
}

/** Checks and scans one file. Throws only when the scanner or storage could not answer. */
async function judge(
  options: ScanRunOptions,
  file: {
    bucket: string;
    objectName: string;
    filename: string;
    contentType: string | null;
    checksum?: string | null;
  },
): Promise<Verdict> {
  let bytes: Uint8Array;
  try {
    bytes = await options.storage.download(file.bucket, file.objectName);
  } catch (error) {
    throw new StorageUnavailableError(`could not download ${file.bucket} object`, { cause: error });
  }
  if (
    file.checksum !== undefined &&
    file.checksum !== null &&
    (await sha256Hex(bytes)) !== file.checksum
  ) {
    return {
      result: "refused",
      detail: "The stored file does not match the checksum given at upload.",
    };
  }
  const content = checkContent({ bytes, contentType: file.contentType, filename: file.filename });
  if (!content.ok) return { result: "refused", detail: content.reason };
  const verdict = await options.scanner.scan(bytes);
  return verdict.clean
    ? { result: "clean", bytes }
    : { result: "infected", detail: verdict.signature };
}

function transient(error: unknown): error is ScannerUnavailableError | StorageUnavailableError {
  return error instanceof ScannerUnavailableError || error instanceof StorageUnavailableError;
}

function describe(error: Error): string {
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`.slice(0, 500);
}

async function removeQuietly(
  options: ScanRunOptions,
  bucket: string,
  name: string,
): Promise<string | undefined> {
  try {
    await options.storage.remove(bucket, name);
    return undefined;
  } catch (error) {
    // The verdict is recorded and keeps the file closed; report the leftover object for cleanup.
    return `The file stays in storage: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function scanAttachment(
  options: ScanRunOptions,
  job: ClaimedAttachmentScan,
): Promise<ScanOutcome> {
  const id = job.attachmentVersionId;
  const version = await options.store.attachmentVersion(id);
  if (version === null || version.scanStatus !== "Scanning") {
    await options.store.finishJob(job.jobId, true, null);
    return { kind: "attachment", id, result: "skipped" };
  }
  let verdict: Verdict;
  try {
    verdict = await judge(options, {
      bucket: "attachments",
      objectName: version.objectName,
      filename: version.filename,
      contentType: version.contentType,
      checksum: version.checksumSha256,
    });
  } catch (error) {
    if (!transient(error)) throw error;
    const detail = describe(error);
    if (job.attempts >= MAX_SCAN_ATTEMPTS) {
      await options.store.recordAttachmentScan(id, null, detail);
      await options.store.finishJob(job.jobId, true, null);
      return { kind: "attachment", id, result: "failed", detail };
    }
    await options.store.finishJob(job.jobId, false, detail);
    return { kind: "attachment", id, result: "retrying", detail };
  }
  if (verdict.result === "clean") {
    await options.store.recordAttachmentScan(id, true, null);
    await options.store.finishJob(job.jobId, true, null);
    return { kind: "attachment", id, result: "clean" };
  }
  await options.store.recordAttachmentScan(
    id,
    verdict.result === "infected" ? false : null,
    verdict.detail,
  );
  const leftover = await removeQuietly(options, "attachments", version.objectName);
  await options.store.finishJob(job.jobId, true, null);
  return { kind: "attachment", id, result: verdict.result, detail: leftover ?? verdict.detail };
}

async function scanObject(options: ScanRunOptions, scan: ClaimedObjectScan): Promise<ScanOutcome> {
  const id = scan.objectScanId;
  let verdict: Verdict;
  try {
    verdict = await judge(options, {
      bucket: scan.bucketId,
      objectName: scan.objectName,
      filename: fileNameOf(scan.objectName),
      contentType: scan.contentType,
    });
  } catch (error) {
    if (!transient(error)) throw error;
    const detail = describe(error);
    const status = await options.store.releaseObjectScan(id, detail);
    return { kind: "object", id, result: status === "Scan Failed" ? "failed" : "retrying", detail };
  }
  const staged = scan.bucketId === UPLOAD_STAGING_BUCKET;
  const target = staged ? stagedUploadTarget(scan.objectName) : null;
  if (staged && target === null && verdict.result === "clean") {
    verdict = {
      result: "refused",
      detail: "A staged upload must name the public bucket it is for.",
    };
  }
  if (verdict.result === "clean") {
    if (target !== null) {
      // Publish before recording Clean: the public copy is written while this scan still holds the
      // staged original, so the database records it Clean too (1265). A failed write is retried.
      try {
        await options.storage.upload(target.bucket, target.name, verdict.bytes, scan.contentType);
      } catch (error) {
        const detail = describe(
          new StorageUnavailableError(`could not publish to ${target.bucket}`, { cause: error }),
        );
        const status = await options.store.releaseObjectScan(id, detail);
        return {
          kind: "object",
          id,
          result: status === "Scan Failed" ? "failed" : "retrying",
          detail,
        };
      }
    }
    await options.store.recordObjectScan(id, true, null);
    if (target === null) return { kind: "object", id, result: "clean" };
    const leftover = await removeQuietly(options, scan.bucketId, scan.objectName);
    return {
      kind: "object",
      id,
      result: "published",
      detail: leftover ?? `Published to ${target.bucket}.`,
    };
  }
  await options.store.recordObjectScan(
    id,
    verdict.result === "infected" ? false : null,
    verdict.detail,
  );
  const leftover = await removeQuietly(options, scan.bucketId, scan.objectName);
  return { kind: "object", id, result: verdict.result, detail: leftover ?? verdict.detail };
}

/** One pass of the worker over attachments and the scanned buckets. */
export async function runUploadScans(options: ScanRunOptions): Promise<readonly ScanOutcome[]> {
  const limit = options.limit ?? 10;
  const outcomes: ScanOutcome[] = [];
  for (const job of await options.store.claimAttachmentScans(options.worker, limit)) {
    try {
      outcomes.push(await scanAttachment(options, job));
    } catch (error) {
      // An unexpected failure: the job keeps the error and the queue retries it with backoff.
      const detail = error instanceof Error ? error.message.slice(0, 500) : String(error);
      await options.store.finishJob(job.jobId, false, detail);
      outcomes.push({
        kind: "attachment",
        id: job.attachmentVersionId,
        result: "retrying",
        detail,
      });
    }
  }
  for (const scan of await options.store.claimObjectScans(options.worker, limit)) {
    try {
      outcomes.push(await scanObject(options, scan));
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 500) : String(error);
      const status = await options.store.releaseObjectScan(scan.objectScanId, detail);
      outcomes.push({
        kind: "object",
        id: scan.objectScanId,
        result: status === "Scan Failed" ? "failed" : "retrying",
        detail,
      });
    }
  }
  return outcomes;
}
