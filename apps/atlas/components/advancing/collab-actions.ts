"use server";

import type { DataError } from "@xos/data";
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
import type { AdvancingState } from "./actions";

/**
 * Comments and attachments on Advancing rows (Section 19.6), through A18's unified comment system
 * and attachment service (0580, 0590). The subject must be one of Advancing's subject tables
 * (0580 and 0965 register them); the database then checks that the person can read the row through
 * its own read policy, so a hidden row answers not found.
 */

const SUBJECT_TABLES = [
  "app.advance_packets",
  "app.advance_submissions",
  "app.riders",
  "app.reconciliations",
  "app.guest_list_entries",
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

function failed(error: DataError): AdvancingState {
  return { error: error.kind === "refusal" ? "refused" : error.kind };
}

function refresh(slug: string): AdvancingState {
  revalidatePath(`/${slug}`, "layout");
  return { ok: true };
}

export async function postCommentAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const { ctx, subject } = await resolve(form);
  if (!subject) return { error: "not-found" };
  const body = z.string().trim().min(1).max(10_000).safeParse(form.get("body"));
  if (!body.success) return { fieldErrors: { body: "body" } };
  const result = await postComment(ctx.viewer.db, { subject, body: body.data });
  return result.ok ? refresh(ctx.org.slug) : failed(result.error);
}

export async function deleteCommentAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const { ctx } = await resolve(form);
  const id = z.uuid().safeParse(form.get("commentId"));
  if (!id.success) return { error: "not-found" };
  const result = await deleteComment(ctx.viewer.db, id.data);
  return result.ok ? refresh(ctx.org.slug) : failed(result.error);
}

export async function uploadAttachmentAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const { ctx, subject } = await resolve(form);
  if (!subject) return { error: "not-found" };
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { fieldErrors: { file: "file" } };
  if (file.size > MAX_UPLOAD_BYTES) return { fieldErrors: { file: "fileSize" } };
  const result = await uploadAttachment(ctx.viewer.db, { subject, file, filename: file.name });
  return result.ok ? refresh(ctx.org.slug) : failed(result.error);
}

export async function removeAttachmentAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const { ctx } = await resolve(form);
  const id = z.uuid().safeParse(form.get("attachmentId"));
  if (!id.success) return { error: "not-found" };
  const result = await removeAttachment(ctx.viewer.db, id.data);
  return result.ok ? refresh(ctx.org.slug) : failed(result.error);
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
