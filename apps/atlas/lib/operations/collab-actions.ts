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
import { failed, type ActionState } from "./state";

/**
 * Comments and attachments on Credentials and Safety incident records (Section 19.6), through
 * A18's unified comment system and attachment service (migrations 0580 and 0590). The subject
 * table must be one of this module's subjects (0986 registers them); the database then checks that
 * the person can read the subject row through its own read policy.
 */

const SUBJECT_TABLES = [
  "app.incidents",
  "app.credentials",
  "app.credential_categories",
  "app.crisis_alerts",
  "app.radio_channels",
] as const;

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const Subject = z.object({ table: z.enum(SUBJECT_TABLES), id: z.uuid() });

async function resolve(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  const subject = Subject.safeParse({ table: form.get("subjectTable"), id: form.get("subjectId") });
  return { ctx, subject: subject.success ? subject.data : null };
}

function refresh(slug: string): ActionState {
  revalidatePath(`/${slug}`, "layout");
  return { ok: true };
}

export async function postCommentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { ctx, subject } = await resolve(form);
  if (!subject) return { error: "notFound" };
  const body = z.string().trim().min(1).max(10_000).safeParse(form.get("body"));
  if (!body.success) return { error: "commentInput" };
  const result = await postComment(ctx.viewer.db, { subject, body: body.data });
  if (!result.ok) return failed(result.error);
  return refresh(ctx.org.slug);
}

export async function deleteCommentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { ctx } = await resolve(form);
  const id = z.uuid().safeParse(form.get("commentId"));
  if (!id.success) return { error: "notFound" };
  const result = await deleteComment(ctx.viewer.db, id.data);
  if (!result.ok) return failed(result.error);
  return refresh(ctx.org.slug);
}

export async function uploadAttachmentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { ctx, subject } = await resolve(form);
  if (!subject) return { error: "notFound" };
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "fileInput" };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "fileSize" };
  const result = await uploadAttachment(ctx.viewer.db, { subject, file, filename: file.name });
  if (!result.ok) return failed(result.error);
  return refresh(ctx.org.slug);
}

export async function removeAttachmentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { ctx } = await resolve(form);
  const id = z.uuid().safeParse(form.get("attachmentId"));
  if (!id.success) return { error: "notFound" };
  const result = await removeAttachment(ctx.viewer.db, id.data);
  if (!result.ok) return failed(result.error);
  return refresh(ctx.org.slug);
}

/** A short-lived link to the current clean version of an attachment, or null when none. */
export async function attachmentLinkAction(input: {
  org: string;
  subjectTable: string;
  subjectId: string;
  attachmentId: string;
}): Promise<string | null> {
  const ctx = await getOrgContext(input.org);
  if (!ctx) return null;
  const subject = Subject.safeParse({ table: input.subjectTable, id: input.subjectId });
  if (!subject.success) return null;
  const list = await listAttachments(ctx.viewer.db, subject.data);
  if (!list.ok) return null;
  const current = list.data.find((a) => a.id === input.attachmentId)?.current;
  if (!current) return null;
  const url = await downloadUrl(ctx.viewer.db, current);
  return url.ok ? url.data : null;
}
