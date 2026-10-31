import type { Database, XosClient } from "./client.ts";
import type { Subject } from "./comments.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Attachments repository (Section 7.3, Section 9 file uploads). Files attach to any subject the caller
 * can read (migration 0590). An upload is three steps the database checks: begin (type, size and the
 * object name are issued), upload to the private attachments bucket at exactly that name, and complete
 * with the file's SHA-256, which queues the virus scan. Only Clean versions can be downloaded.
 */

type Tables = Database["app"]["Tables"];
export type ScanStatus = Database["app"]["Enums"]["scan_status"];
/** Section 8.3 classification of a file (migration 1380). */
export type FileClassification = Database["app"]["Enums"]["data_classification"];

export const ATTACHMENTS_BUCKET = "attachments";

export interface AttachmentVersion {
  readonly id: string;
  readonly versionNumber: number;
  readonly objectName: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly scanStatus: ScanStatus;
  readonly uploadedBy: string | null;
  readonly uploadedAt: string | null;
  /** The file's classification, which decides how it downloads (Section 8.6). */
  readonly classification: FileClassification;
}

export interface Attachment {
  readonly id: string;
  readonly title: string;
  /** Public, Internal (the default), Confidential or Restricted (Section 8.6, migration 1380). */
  readonly classification: FileClassification;
  readonly createdBy: string | null;
  readonly createdAt: string;
  /** Newest first. */
  readonly versions: readonly AttachmentVersion[];
  /** The newest Clean version: the file a download serves, or null while none has scanned clean. */
  readonly current: AttachmentVersion | null;
}

type AttachmentRow = Pick<
  Tables["attachments"]["Row"],
  "id" | "title" | "created_by" | "created_at" | "classification"
> & {
  attachment_versions:
    | Pick<
        Tables["attachment_versions"]["Row"],
        | "id"
        | "version_number"
        | "object_name"
        | "filename"
        | "content_type"
        | "size_bytes"
        | "scan_status"
        | "uploaded_by"
        | "uploaded_at"
        | "deleted_at"
      >[]
    | null;
};

function toAttachment(row: AttachmentRow): Attachment {
  const versions = (row.attachment_versions ?? [])
    .filter((v) => v.deleted_at === null)
    .sort((a, b) => b.version_number - a.version_number)
    .map((v): AttachmentVersion => ({
      id: v.id,
      versionNumber: v.version_number,
      objectName: v.object_name,
      filename: v.filename,
      contentType: v.content_type,
      sizeBytes: v.size_bytes,
      scanStatus: v.scan_status,
      uploadedBy: v.uploaded_by,
      uploadedAt: v.uploaded_at,
      classification: row.classification,
    }));
  return {
    id: row.id,
    title: row.title,
    classification: row.classification,
    createdBy: row.created_by,
    createdAt: row.created_at,
    versions,
    current: versions.find((v) => v.scanStatus === "Clean") ?? null,
  };
}

/** Attachments on a subject the caller can read, newest first. */
export async function listAttachments(
  db: XosClient,
  subject: Subject,
): Promise<Result<Attachment[]>> {
  const { data, error } = await db
    .from("attachments")
    .select(
      "id, title, created_by, created_at, classification, attachment_versions(id, version_number, object_name, filename, content_type, size_bytes, scan_status, uploaded_by, uploaded_at, deleted_at)",
    )
    .eq("subject_table", subject.table)
    .eq("subject_id", subject.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok((data as unknown as AttachmentRow[]).map(toAttachment));
}

export interface BeginUpload {
  readonly subject: Subject;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** An existing attachment, to add a new version of it. */
  readonly attachmentId?: string;
}

export interface UploadTicket {
  readonly attachmentId: string;
  readonly versionId: string;
  /** The only object name the caller may upload to. */
  readonly objectName: string;
}

/** Starts an upload: the database checks type and size and issues the object name. */
export async function beginUpload(
  db: XosClient,
  input: BeginUpload,
): Promise<Result<UploadTicket>> {
  const { data, error } = await db.rpc("begin_attachment_upload", {
    p_subject_table: input.subject.table,
    p_subject_id: input.subject.id,
    p_filename: input.filename,
    p_content_type: input.contentType,
    p_size_bytes: input.sizeBytes,
    ...(input.attachmentId === undefined ? {} : { p_attachment_id: input.attachmentId }),
  });
  if (error) return fail(toDataError(error));
  const row = data?.[0];
  if (!row)
    return fail({ kind: "unexpected", message: "begin_attachment_upload returned no ticket" });
  return ok({
    attachmentId: row.attachment_id,
    versionId: row.attachment_version_id,
    objectName: row.object_name,
  });
}

/** SHA-256 of a file, lowercase hex, as complete_attachment_upload expects. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Confirms a finished upload; the version moves to Scanning. */
export async function completeUpload(
  db: XosClient,
  versionId: string,
  checksumSha256: string,
): Promise<Result<ScanStatus>> {
  const { data, error } = await db.rpc("complete_attachment_upload", {
    p_attachment_version_id: versionId,
    p_checksum_sha256: checksumSha256,
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

export interface UploadAttachment {
  readonly subject: Subject;
  readonly file: Blob;
  readonly filename: string;
  readonly attachmentId?: string;
}

/**
 * Begins, uploads and completes one file. A storage failure leaves the version waiting for its file,
 * and the error says so; nothing is retried silently.
 */
export async function uploadAttachment(
  db: XosClient,
  input: UploadAttachment,
): Promise<Result<UploadTicket & { readonly scanStatus: ScanStatus }>> {
  const ticket = await beginUpload(db, {
    subject: input.subject,
    filename: input.filename,
    contentType: input.file.type,
    sizeBytes: input.file.size,
    ...(input.attachmentId === undefined ? {} : { attachmentId: input.attachmentId }),
  });
  if (!ticket.ok) return ticket;
  const bytes = await input.file.arrayBuffer();
  const stored = await db.storage
    .from(ATTACHMENTS_BUCKET)
    .upload(ticket.data.objectName, bytes, { contentType: input.file.type, upsert: false });
  if (stored.error)
    return fail({ kind: "unexpected", message: `Upload failed: ${stored.error.message}` });
  const completed = await completeUpload(db, ticket.data.versionId, await sha256Hex(bytes));
  if (!completed.ok) return completed;
  return ok({ ...ticket.data, scanStatus: completed.data });
}

/**
 * The route that delivers a Confidential or Restricted version (Section 8.6): the web shell logs the
 * download, holds it to the export capability and watermarks PDFs and images, so no signed URL is
 * issued.
 */
export function classifiedDownloadPath(versionId: string): string {
  return `/files/${versionId}`;
}

/**
 * A download link for a Clean version; any other version is not found. Public and Internal files get
 * a short-lived signed URL; Confidential and Restricted files go through {@link classifiedDownloadPath}.
 */
export async function downloadUrl(
  db: XosClient,
  version: AttachmentVersion,
  expiresInSeconds = 60,
): Promise<Result<string>> {
  if (version.scanStatus !== "Clean") return fail({ kind: "not-found" });
  if (version.classification === "Confidential" || version.classification === "Restricted") {
    return ok(classifiedDownloadPath(version.id));
  }
  const { data, error } = await db.storage
    .from(ATTACHMENTS_BUCKET)
    .createSignedUrl(version.objectName, expiresInSeconds);
  if (error || !data) return fail({ kind: "not-found" });
  return ok(data.signedUrl);
}

/** Removes an attachment the caller added (soft). */
export async function removeAttachment(
  db: XosClient,
  attachmentId: string,
  now: Date = new Date(),
): Promise<Result<void>> {
  const { data, error } = await db
    .from("attachments")
    .update({ deleted_at: now.toISOString() })
    .eq("id", attachmentId)
    .select("id");
  if (error) return fail(toDataError(error));
  if (!data || data.length === 0) return fail({ kind: "not-found" });
  return ok(undefined);
}

// File version reviews (B14, G-268, migration 3035) ----------------------------------------------------

export type FileReviewDecision = "Approved" | "Changes Requested";

export interface VersionReview {
  readonly id: string;
  readonly attachmentVersionId: string;
  readonly decision: FileReviewDecision;
  readonly note: string | null;
  readonly reviewerId: string | null;
  readonly reviewerName: string | null;
  readonly reviewedAt: string;
}

/**
 * Every review of the versions of the files on a subject, newest first (app.attachment_version_reviews). The latest
 * review of a version is its decision; a new version starts unreviewed. Reviews are append-only.
 */
export async function listVersionReviews(
  db: XosClient,
  versionIds: readonly string[],
): Promise<Result<VersionReview[]>> {
  if (versionIds.length === 0) return ok([]);
  const { data, error } = await untyped(db)
    .from("attachment_version_reviews")
    .select(
      "id, attachment_version_id, decision, note, created_by, created_at, reviewer:people!attachment_version_reviews_created_by_fkey(full_name)",
    )
    .in("attachment_version_id", [...versionIds])
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as unknown as {
        id: string;
        attachment_version_id: string;
        decision: FileReviewDecision;
        note: string | null;
        created_by: string | null;
        created_at: string;
        reviewer: { full_name: string | null } | null;
      }[]
    ).map((r) => ({
      id: r.id,
      attachmentVersionId: r.attachment_version_id,
      decision: r.decision,
      note: r.note,
      reviewerId: r.created_by,
      reviewerName: r.reviewer?.full_name ?? null,
      reviewedAt: r.created_at,
    })),
  );
}

/** A version's decision: its latest review, or null while unreviewed. */
export function latestReview(
  reviews: readonly VersionReview[],
  versionId: string,
): VersionReview | null {
  return reviews.find((r) => r.attachmentVersionId === versionId) ?? null;
}

/**
 * Approves a Clean version of a file on a submittal or a record, or asks for changes with a note
 * (app.review_attachment_version). The uploader never reviews their own version (sod_file_review_uploader).
 */
export async function reviewAttachmentVersion(
  db: XosClient,
  input: {
    readonly versionId: string;
    readonly decision: FileReviewDecision;
    readonly note?: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await untyped(db).rpc("review_attachment_version", {
    p_attachment_version_id: input.versionId,
    p_decision: input.decision,
    p_note: input.note?.trim() ? input.note.trim() : null,
  });
  if (error) return fail(toDataError(error));
  return typeof data === "string"
    ? ok({ id: data })
    : fail({ kind: "unexpected", message: "no review id" });
}
