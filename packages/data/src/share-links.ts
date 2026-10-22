import type { Database, XosClient } from "./client.ts";
import type { DatabaseErrorLike } from "./result.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Share links and classified downloads (Section 8.6, finding A65-016; migration 1380).
 *
 * - A file carries a classification. Anyone who can read it may raise it; lowering it needs the
 *   uploader or data.classification.write.
 * - A share link opens one clean version of a file without an account: Public files may have a link
 *   without an expiry, Internal links need an expiry, Confidential links need an expiry, an access
 *   code and the recipient's email, and Restricted files never get one. The token and the code come
 *   back once from {@link createShareLink}; the database keeps only their hashes.
 * - {@link openShareLink} runs as an anonymous caller and answers a single-use download ticket, which
 *   {@link fetchTicketFile} trades at the file-download Edge Function for the bytes. Confidential
 *   images are watermarked by the web shell before the visitor gets them.
 * - {@link recordFileDownload} logs an in-app download of a classified file and says whether the copy
 *   needs the watermark.
 */

export type DataClassification = Database["app"]["Enums"]["data_classification"];

export const CLASSIFICATIONS: readonly DataClassification[] = [
  "Public",
  "Internal",
  "Confidential",
  "Restricted",
];

export function isClassification(value: unknown): value is DataClassification {
  return typeof value === "string" && (CLASSIFICATIONS as readonly string[]).includes(value);
}

/** Longest a link may last, by classification (the share link guard enforces the same). */
export function maxShareDays(classification: DataClassification): number | null {
  if (classification === "Restricted") return null;
  return classification === "Confidential" ? 30 : 90;
}

/** True when a link to a file of this classification must have an expiry. */
export function shareNeedsExpiry(classification: DataClassification): boolean {
  return classification !== "Public";
}

export interface ShareLink {
  readonly id: string;
  readonly attachmentId: string;
  readonly classification: DataClassification;
  readonly accessCodeRequired: boolean;
  readonly recipientEmail: string | null;
  readonly note: string | null;
  readonly expiresAt: string | null;
  readonly openCount: number;
  readonly lastOpenedAt: string | null;
  readonly locked: boolean;
  readonly revokedAt: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/** Whether a link still opens at `now`: not revoked, not locked and not past its expiry. */
export function shareLinkActive(link: ShareLink, now: Date = new Date()): boolean {
  if (link.revokedAt !== null || link.locked) return false;
  return link.expiresAt === null || Date.parse(link.expiresAt) > now.getTime();
}

const LINK_COLUMNS =
  "id, attachment_id, classification, access_code_required, recipient_email, note, expires_at, open_count, last_opened_at, failed_attempts, revoked_at, created_by, created_at";

interface LinkRow {
  id: string;
  attachment_id: string;
  classification: DataClassification;
  access_code_required: boolean;
  recipient_email: string | null;
  note: string | null;
  expires_at: string | null;
  open_count: number;
  last_opened_at: string | null;
  failed_attempts: number;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
}

function toLink(r: LinkRow): ShareLink {
  return {
    id: r.id,
    attachmentId: r.attachment_id,
    classification: r.classification,
    accessCodeRequired: r.access_code_required,
    recipientEmail: r.recipient_email,
    note: r.note,
    expiresAt: r.expires_at,
    openCount: r.open_count,
    lastOpenedAt: r.last_opened_at,
    locked: r.failed_attempts >= 5,
    revokedAt: r.revoked_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/** The share links of a file, newest first. Anyone who can read the file sees them. */
export async function listShareLinks(
  db: XosClient,
  attachmentId: string,
): Promise<Result<ShareLink[]>> {
  const { data, error } = await db
    .from("share_links")
    .select(LINK_COLUMNS)
    .eq("attachment_id", attachmentId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(((data ?? []) as unknown as LinkRow[]).map(toLink));
}

/** One share link, or not-found. */
export async function getShareLink(db: XosClient, id: string): Promise<Result<ShareLink>> {
  const { data, error } = await db
    .from("share_links")
    .select(LINK_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toLink(data as unknown as LinkRow));
}

export interface ShareLinkInput {
  readonly attachmentId: string;
  /** ISO instant; required unless the file is Public. */
  readonly expiresAt: string | null;
  readonly accessCodeRequired: boolean;
  readonly recipientEmail: string | null;
  readonly note: string | null;
}

export interface CreatedShareLink {
  readonly id: string;
  /** Shown once; only its hash is stored. */
  readonly token: string;
  /** Shown once, or null when the link asks for none. */
  readonly accessCode: string | null;
  readonly classification: DataClassification;
  readonly expiresAt: string | null;
}

/** Makes a share link (app.create_share_link); the database applies the Section 8.6 rules. */
export async function createShareLink(
  db: XosClient,
  input: ShareLinkInput,
): Promise<Result<CreatedShareLink>> {
  const { data, error } = await db.rpc("create_share_link", {
    p_attachment_id: input.attachmentId,
    ...(input.expiresAt === null ? {} : { p_expires_at: input.expiresAt }),
    p_access_code_required: input.accessCodeRequired,
    ...(input.recipientEmail === null ? {} : { p_recipient_email: input.recipientEmail }),
    ...(input.note === null ? {} : { p_note: input.note }),
  });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : null) as {
    share_link_id: string;
    token: string | null;
    access_code: string | null;
    classification: DataClassification;
    expires_at: string | null;
  } | null;
  if (!row?.token)
    return fail({ kind: "unexpected", message: "create_share_link returned no token" });
  return ok({
    id: row.share_link_id,
    token: row.token,
    accessCode: row.access_code,
    classification: row.classification,
    expiresAt: row.expires_at,
  });
}

/** Revokes a share link (app.revoke_share_link). Answers the revocation time. */
export async function revokeShareLink(db: XosClient, id: string): Promise<Result<string>> {
  const { data, error } = await db.rpc("revoke_share_link", { p_share_link_id: id });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

/** Raises or lowers a file's classification; the database refuses a lowering the caller may not make. */
export async function classifyAttachment(
  db: XosClient,
  attachmentId: string,
  classification: DataClassification,
): Promise<Result<DataClassification>> {
  const { data, error } = await db
    .from("attachments")
    .update({ classification })
    .eq("id", attachmentId)
    .select("classification");
  if (error) return fail(toDataError(error));
  const row = (data ?? [])[0] as { classification: DataClassification } | undefined;
  if (!row) return fail({ kind: "not-found" });
  return ok(row.classification);
}

// Opening a link (anonymous) -------------------------------------------------------------------------

export const SHARE_LINK_REFUSALS = [
  "share_link_invalid",
  "share_link_locked",
  "share_link_expired",
  "share_link_reclassified",
  "share_link_access_code_required",
  "share_link_access_code",
  "share_link_rate_limited",
] as const;

export type ShareLinkRefusal = (typeof SHARE_LINK_REFUSALS)[number];

export interface OpenedShareLink {
  readonly refused: false;
  readonly ticket: string;
  readonly orgName: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly classification: DataClassification;
  /** True when the copy must carry the viewer watermark (Section 8.6). */
  readonly watermark: boolean;
  readonly recipientEmail: string | null;
  readonly expiresAt: string | null;
}

export type ShareLinkOpen =
  OpenedShareLink | { readonly refused: true; readonly reason: ShareLinkRefusal };

type PublicRpc = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;
};

/** The shape a share link token has; anything else is refused without a database call. */
export const SHARE_TOKEN = /^xshr_[0-9a-f]{64}$/;

/**
 * Opens a share link with its access code (api_public.open_share_link) as an anonymous caller. The
 * call is a POST, as every token RPC must be (A69-001): a GET is refused before any lookup.
 */
export async function openShareLink(
  db: XosClient,
  input: { readonly token: string; readonly accessCode: string | null },
): Promise<Result<ShareLinkOpen>> {
  if (!SHARE_TOKEN.test(input.token)) return ok({ refused: true, reason: "share_link_invalid" });
  const api = (db as unknown as { schema(name: "api_public"): PublicRpc }).schema("api_public");
  const { data, error } = await api.rpc("open_share_link", {
    p_token: input.token,
    p_access_code: input.accessCode ?? null,
  });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : null) as {
    refusal: string | null;
    reason: string | null;
    ticket: string | null;
    org_name: string | null;
    filename: string | null;
    content_type: string | null;
    size_bytes: number | null;
    classification: DataClassification | null;
    watermark: boolean | null;
    recipient_email: string | null;
    expires_at: string | null;
  } | null;
  if (!row || row.refusal !== null || !row.ticket) {
    const reason = (SHARE_LINK_REFUSALS as readonly string[]).includes(row?.reason ?? "")
      ? (row?.reason as ShareLinkRefusal)
      : "share_link_invalid";
    return ok({ refused: true, reason });
  }
  return ok({
    refused: false,
    ticket: row.ticket,
    orgName: row.org_name ?? "",
    filename: row.filename ?? "file",
    contentType: row.content_type ?? "application/octet-stream",
    sizeBytes: row.size_bytes ?? 0,
    classification: row.classification ?? "Internal",
    watermark: row.watermark ?? false,
    recipientEmail: row.recipient_email,
    expiresAt: row.expires_at,
  });
}

/**
 * Trades a download ticket at the file-download Edge Function for the file's bytes. The function holds
 * the service role the anonymous visitor lacks and honors a ticket once, within 2 minutes.
 */
export async function fetchTicketFile(
  functionsUrl: string,
  ticket: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<{ readonly bytes: Uint8Array; readonly contentType: string }>> {
  let response: Response;
  try {
    response = await fetchImpl(`${functionsUrl.replace(/\/$/, "")}/file-download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
  } catch (error) {
    return fail({
      kind: "unexpected",
      message: `file-download: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (response.status === 404) return fail({ kind: "not-found" });
  if (!response.ok) {
    return fail({ kind: "unexpected", message: `file-download answered ${response.status}` });
  }
  return ok({
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get("Content-Type") ?? "application/octet-stream",
  });
}

// Classified downloads in the app ---------------------------------------------------------------

export interface FileDownload {
  readonly classification: DataClassification;
  /** True when the copy must carry the viewer watermark: a Confidential or Restricted PNG or JPEG. */
  readonly watermark: boolean;
  readonly viewerEmail: string | null;
}

/** Logs an in-app download of a file (app.record_file_download) and answers its watermark rule. */
export async function recordFileDownload(
  db: XosClient,
  attachmentVersionId: string,
): Promise<Result<FileDownload>> {
  const { data, error } = await db.rpc("record_file_download", {
    p_attachment_version_id: attachmentVersionId,
  });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : null) as {
    classification: DataClassification;
    watermark: boolean;
    viewer_email: string | null;
  } | null;
  if (!row) return fail({ kind: "not-found" });
  return ok({
    classification: row.classification,
    watermark: row.watermark,
    viewerEmail: row.viewer_email,
  });
}

/** True for a Confidential or Restricted file, which downloads through the watermarking route. */
export function isClassifiedFile(classification: DataClassification): boolean {
  return classification === "Confidential" || classification === "Restricted";
}
