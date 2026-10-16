import { checkContent } from "./content.ts";
import { ScannerUnavailableError, type VirusScanner } from "./scanner.ts";

/**
 * The upload scan worker (A22-011): one pass claims due scans, checks each file's bytes against its
 * declared type and checksum, scans it, and records the verdict.
 *
 * - Attachments: the A18 job `attachment.scan` (migration 0590), claimed from the job queue; the
 *   verdict goes to `app.record_attachment_scan`, so a Clean version becomes downloadable.
 * - The field-media, onboarding-uploads, profile-media and org-brand buckets: `app.claim_object_scans`
 *   and `app.record_object_scan` (migration 1041).
 *
 * An infected or refused file is removed from storage after its verdict is recorded. When the scanner
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
  remove(bucket: string, name: string): Promise<void>;
}

/** Storage could not return or delete an object; the scan is retried. */
export class StorageUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageUnavailableError";
  }
}

export type ScanResult = "clean" | "infected" | "refused" | "retrying" | "failed" | "skipped";

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
  | { readonly result: "clean" }
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
  return verdict.clean ? { result: "clean" } : { result: "infected", detail: verdict.signature };
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
  if (verdict.result === "clean") {
    await options.store.recordObjectScan(id, true, null);
    return { kind: "object", id, result: "clean" };
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
