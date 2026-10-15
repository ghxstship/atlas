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
import type { AssetActionState } from "./actions";

/**
 * Comments and attachments on asset classes, units, lots, maintenance and damage (Section 19.6)
 * through A18's unified comment system and attachment service (0580, 0590). Only the subject tables
 * registered in private.comment_subjects (0580 and 0976) are accepted; each subject's read policy
 * decides who reads and posts. Errors come back as `assets.errors` keys.
 */

const SUBJECT_TABLES = [
  "app.asset_classes",
  "app.asset_units",
  "app.asset_lots",
  "app.asset_maintenance",
  "app.asset_damage",
] as const;

const subject = z.object({ table: z.enum(SUBJECT_TABLES), id: z.uuid() });
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface CollabState extends AssetActionState {
  readonly link?: string;
}

async function context(form: FormData) {
  const org = form.get("org");
  const ctx = typeof org === "string" ? await getOrgContext(org) : null;
  if (!ctx) notFound();
  return ctx;
}

function subjectOf(form: FormData) {
  return subject.safeParse({ table: form.get("table"), id: form.get("id") });
}

function failed(error: { kind: string }): CollabState {
  if (error.kind === "not-found") return { error: "notFound" };
  if (error.kind === "refusal") return { error: "refused" };
  console.error("asset collaboration failed", error);
  return { error: "unexpected" };
}

function done(slug: string): CollabState {
  revalidatePath(`/${slug}/assets`, "layout");
  return { ok: true };
}

export async function postCommentAction(_: CollabState, form: FormData): Promise<CollabState> {
  const ctx = await context(form);
  const s = subjectOf(form);
  const body = z.string().trim().min(1).max(10_000).safeParse(form.get("body"));
  if (!s.success) return { error: "notFound" };
  if (!body.success) return { error: "invalid", field: "comment" };
  const result = await postComment(ctx.viewer.db, { subject: s.data, body: body.data });
  return result.ok ? done(ctx.org.slug) : failed(result.error);
}

export async function deleteCommentAction(_: CollabState, form: FormData): Promise<CollabState> {
  const ctx = await context(form);
  const id = z.uuid().safeParse(form.get("commentId"));
  if (!id.success) return { error: "notFound" };
  const result = await deleteComment(ctx.viewer.db, id.data);
  return result.ok ? done(ctx.org.slug) : failed(result.error);
}

export async function uploadAttachmentAction(_: CollabState, form: FormData): Promise<CollabState> {
  const ctx = await context(form);
  const s = subjectOf(form);
  const file = form.get("file");
  if (!s.success) return { error: "notFound" };
  if (!(file instanceof File) || file.size === 0) return { error: "invalid", field: "file" };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "fileTooLarge" };
  const result = await uploadAttachment(ctx.viewer.db, {
    subject: s.data,
    file,
    filename: file.name,
  });
  return result.ok ? done(ctx.org.slug) : failed(result.error);
}

export async function removeAttachmentAction(_: CollabState, form: FormData): Promise<CollabState> {
  const ctx = await context(form);
  const id = z.uuid().safeParse(form.get("attachmentId"));
  if (!id.success) return { error: "notFound" };
  const result = await removeAttachment(ctx.viewer.db, id.data);
  return result.ok ? done(ctx.org.slug) : failed(result.error);
}

/** A short-lived link to the current clean version of an attachment. */
export async function attachmentLinkAction(_: CollabState, form: FormData): Promise<CollabState> {
  const ctx = await context(form);
  const s = subjectOf(form);
  const id = form.get("attachmentId");
  if (!s.success) return { error: "notFound" };
  const list = await listAttachments(ctx.viewer.db, s.data);
  if (!list.ok) return failed(list.error);
  const current = list.data.find((a) => a.id === id)?.current;
  if (!current) return { error: "scanning" };
  const url = await downloadUrl(ctx.viewer.db, current);
  if (!url.ok) return failed(url.error);
  return { ok: true, link: url.data };
}
