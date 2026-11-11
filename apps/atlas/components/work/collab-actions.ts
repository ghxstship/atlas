"use server";

import {
  downloadUrl,
  listAttachments,
  removeAttachment,
  uploadAttachment,
} from "@xos/data/attachments";
import { deleteComment, postComment } from "@xos/data/comments";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { done, failed, invalid, type ActionResult } from "./action-result";

/**
 * Comments and attachments on Schedule, Work and Show rows (Section 19.6) and on custom object
 * records (Section 4.6.3), through A18's unified comment system and attachment service (0580, 0590).
 * Only the subject tables these panels serve are accepted; whether the person may read or post is
 * decided by each subject's read policy in the database.
 */

const SUBJECT_TABLES = [
  "app.records",
  "app.work_orders",
  "app.punch_items",
  "app.run_of_show",
  "app.day_sheets",
  "app.call_sheets",
  "app.schedule_baselines",
  "app.custom_object_records",
] as const;

const subjectSchema = z.object({ table: z.enum(SUBJECT_TABLES), id: z.uuid() });
export type CollabSubject = z.infer<typeof subjectSchema>;

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

async function context(org: string) {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  return ctx;
}

export async function postCommentAction(
  org: string,
  subject: CollabSubject,
  body: string,
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsedSubject = subjectSchema.safeParse(subject);
  const text = z.string().trim().min(1).max(10_000).safeParse(body);
  if (!parsedSubject.success) return invalid();
  if (!text.success) return invalid("commentRequired");
  const result = await postComment(ctx.viewer.db, { subject: parsedSubject.data, body: text.data });
  if (!result.ok) return failed(result.error);
  revalidatePath(`/${org}`, "layout");
  return done(null);
}

export async function deleteCommentAction(org: string, commentId: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(commentId).success) return invalid();
  const result = await deleteComment(ctx.viewer.db, commentId);
  if (!result.ok) return failed(result.error);
  revalidatePath(`/${org}`, "layout");
  return done(null);
}

export async function uploadAttachmentAction(form: FormData): Promise<ActionResult> {
  const org = form.get("org");
  const ctx = await context(typeof org === "string" ? org : "");
  const subject = subjectSchema.safeParse({ table: form.get("table"), id: form.get("id") });
  const file = form.get("file");
  if (!subject.success) return invalid();
  if (!(file instanceof File) || file.size === 0) return invalid("fileRequired");
  if (file.size > MAX_UPLOAD_BYTES) return invalid("fileTooLarge");
  const result = await uploadAttachment(ctx.viewer.db, {
    subject: subject.data,
    file,
    filename: file.name,
  });
  if (!result.ok) return failed(result.error);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return done(null);
}

export async function removeAttachmentAction(
  org: string,
  attachmentId: string,
): Promise<ActionResult> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(attachmentId).success) return invalid();
  const result = await removeAttachment(ctx.viewer.db, attachmentId);
  if (!result.ok) return failed(result.error);
  revalidatePath(`/${org}`, "layout");
  return done(null);
}

/** A short-lived link to the current clean version of an attachment. */
export async function attachmentLinkAction(
  org: string,
  subject: CollabSubject,
  attachmentId: string,
): Promise<ActionResult<string>> {
  const ctx = await context(org);
  const parsed = subjectSchema.safeParse(subject);
  if (!parsed.success) return invalid();
  const list = await listAttachments(ctx.viewer.db, parsed.data);
  if (!list.ok) return failed(list.error);
  const current = list.data.find((a) => a.id === attachmentId)?.current;
  if (!current) return invalid("fileScanning");
  const url = await downloadUrl(ctx.viewer.db, current);
  if (!url.ok) return failed(url.error);
  return done(url.data);
}
