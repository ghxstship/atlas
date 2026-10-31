"use server";

import {
  downloadUrl,
  listAttachments,
  removeAttachment,
  uploadAttachment,
} from "@xos/data/attachments";
import { deleteComment, postComment } from "@xos/data/comments";
import { z } from "zod";
import {
  contextForSlug,
  failed,
  refresh,
  type ActionState,
} from "@/lib/logistics-hospitality/actions-kit";

/**
 * Comments and attachments on Logistics and Hospitality records (Section 19.6), through A18's unified
 * comment system and attachment service (0580, 0590). Only A11's subject tables are accepted; who may
 * read or post is decided by each subject's read policy in the database.
 */

const SUBJECT_TABLES = [
  "app.shipments",
  "app.dock_slots",
  "app.fulfillments",
  "app.beos",
  "app.accommodation_blocks",
  "app.travel_segments",
  // B5 (2941, 2943): ground transfers and space bookings.
  "app.transfers",
  "app.space_bookings",
] as const;

const subjectSchema = z.object({ table: z.enum(SUBJECT_TABLES), id: z.uuid() });
export type CollabSubject = z.infer<typeof subjectSchema>;

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export async function postCommentAction(
  org: string,
  subject: CollabSubject,
  body: string,
): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const parsed = subjectSchema.safeParse(subject);
  const text = z.string().trim().min(1).max(10_000).safeParse(body);
  if (!parsed.success) return { error: "notFound" };
  if (!text.success) return { fieldErrors: { body: "required" } };
  const result = await postComment(ctx.viewer.db, { subject: parsed.data, body: text.data });
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function deleteCommentAction(org: string, commentId: string): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  if (!z.uuid().safeParse(commentId).success) return { error: "notFound" };
  const result = await deleteComment(ctx.viewer.db, commentId);
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function uploadAttachmentAction(form: FormData): Promise<ActionState> {
  const org = form.get("org");
  const ctx = await contextForSlug(typeof org === "string" ? org : "");
  const subject = subjectSchema.safeParse({ table: form.get("table"), id: form.get("id") });
  const file = form.get("file");
  if (!subject.success) return { error: "notFound" };
  if (!(file instanceof File) || file.size === 0) return { fieldErrors: { file: "file" } };
  if (file.size > MAX_UPLOAD_BYTES) return { fieldErrors: { file: "fileSize" } };
  const result = await uploadAttachment(ctx.viewer.db, {
    subject: subject.data,
    file,
    filename: file.name,
  });
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

export async function removeAttachmentAction(
  org: string,
  attachmentId: string,
): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  if (!z.uuid().safeParse(attachmentId).success) return { error: "notFound" };
  const result = await removeAttachment(ctx.viewer.db, attachmentId);
  if (!result.ok) return failed(result);
  refresh(ctx);
  return { ok: true };
}

/** A short-lived link to the current clean version of an attachment, in `key`. */
export async function attachmentLinkAction(
  org: string,
  subject: CollabSubject,
  attachmentId: string,
): Promise<ActionState> {
  const ctx = await contextForSlug(org);
  const parsed = subjectSchema.safeParse(subject);
  if (!parsed.success) return { error: "notFound" };
  const list = await listAttachments(ctx.viewer.db, parsed.data);
  if (!list.ok) return failed(list);
  const current = list.data.find((a) => a.id === attachmentId)?.current;
  if (!current) return { error: "fileScanning" };
  const url = await downloadUrl(ctx.viewer.db, current);
  if (!url.ok) return failed(url);
  return { ok: true, key: url.data };
}
