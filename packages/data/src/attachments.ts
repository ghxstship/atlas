import type { Database, XosClient } from "./client";
import type { Subject } from "./comments";
import { fail, ok, toDataError, type Result } from "./result";

/**
 * Attachments repository (Section 7.3, Section 9 file uploads). Files attach to any subject the caller
 * can read (migration 0590). An upload is three steps the database checks: begin (type, size and the
 * object name are issued), upload to the private attachments bucket at exactly that name, and complete
 * with the file's SHA-256, which queues the virus scan. Only Clean versions can be downloaded.
 */

type Tables = Database["app"]["Tables"];
export type ScanStatus = Database["app"]["Enums"]["scan_status"];

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
}

export interface Attachment {
  readonly id: string;
  readonly title: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  /** Newest first. */
  readonly versions: readonly AttachmentVersion[];
  /** The newest Clean version: the file a download serves, or null while none has scanned clean. */
  readonly current: AttachmentVersion | null;
}

type AttachmentRow = Pick<
  Tables["attachments"]["Row"],
  "id" | "title" | "created_by" | "created_at"
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
    }));
  return {
    id: row.id,
    title: row.title,
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
      "id, title, created_by, created_at, attachment_versions(id, version_number, object_name, filename, content_type, size_bytes, scan_status, uploaded_by, uploaded_at, deleted_at)",
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

/** A short-lived download link for a Clean version; any other version is not found. */
export async function downloadUrl(
  db: XosClient,
  version: AttachmentVersion,
  expiresInSeconds = 60,
): Promise<Result<string>> {
  if (version.scanStatus !== "Clean") return fail({ kind: "not-found" });
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
