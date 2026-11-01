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
import { errorKey } from "./action-state";

/**
 * Comments and attachments on Places and Safety rows (Section 19.6), through A18's unified comment
 * system and attachment service (0580, 0590). Only the subject tables A09 owns are accepted; whether
 * the person may read or post is decided by each subject's read policy in the database.
 */

const SUBJECT_TABLES = [
  "app.venues",
  "app.spaces",
  "app.zones",
  "app.capability_documents",
  "app.site_plans",
  "app.permit_requirements",
  "app.inspections",
  "app.inspection_templates",
  "app.capability_statements",
  "app.site_plan_pins",
  "app.site_plan_shapes",
  "app.signs",
] as const;

const subjectSchema = z.object({ table: z.enum(SUBJECT_TABLES), id: z.uuid() });
export type CollabSubject = z.infer<typeof subjectSchema>;

export type CollabResult<T = null> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

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
): Promise<CollabResult> {
  const ctx = await context(org);
  const parsed = subjectSchema.safeParse(subject);
  const text = z.string().trim().min(1).max(10_000).safeParse(body);
  if (!parsed.success) return { ok: false, error: "notFound" };
  if (!text.success) return { ok: false, error: "commentRequired" };
  const result = await postComment(ctx.viewer.db, { subject: parsed.data, body: text.data });
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  revalidatePath(`/${org}`, "layout");
  return { ok: true, data: null };
}

export async function deleteCommentAction(org: string, commentId: string): Promise<CollabResult> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(commentId).success) return { ok: false, error: "notFound" };
  const result = await deleteComment(ctx.viewer.db, commentId);
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  revalidatePath(`/${org}`, "layout");
  return { ok: true, data: null };
}

export async function uploadAttachmentAction(form: FormData): Promise<CollabResult> {
  const org = form.get("org");
  const ctx = await context(typeof org === "string" ? org : "");
  const subject = subjectSchema.safeParse({ table: form.get("table"), id: form.get("id") });
  const file = form.get("file");
  if (!subject.success) return { ok: false, error: "notFound" };
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "fileRequired" };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: "fileTooLarge" };
  const result = await uploadAttachment(ctx.viewer.db, {
    subject: subject.data,
    file,
    filename: file.name,
  });
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true, data: null };
}

export async function removeAttachmentAction(
  org: string,
  attachmentId: string,
): Promise<CollabResult> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(attachmentId).success) return { ok: false, error: "notFound" };
  const result = await removeAttachment(ctx.viewer.db, attachmentId);
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  revalidatePath(`/${org}`, "layout");
  return { ok: true, data: null };
}

/** A short-lived link to the current clean version of an attachment. */
export async function attachmentLinkAction(
  org: string,
  subject: CollabSubject,
  attachmentId: string,
): Promise<CollabResult<string>> {
  const ctx = await context(org);
  const parsed = subjectSchema.safeParse(subject);
  if (!parsed.success) return { ok: false, error: "notFound" };
  const list = await listAttachments(ctx.viewer.db, parsed.data);
  if (!list.ok) return { ok: false, error: errorKey(list.error) };
  const current = list.data.find((a) => a.id === attachmentId)?.current;
  if (!current) return { ok: false, error: "fileScanning" };
  const url = await downloadUrl(ctx.viewer.db, current);
  if (!url.ok) return { ok: false, error: errorKey(url.error) };
  return { ok: true, data: url.data };
}
