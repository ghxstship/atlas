"use server";

import {
  downloadUrl,
  listAttachments,
  removeAttachment,
  uploadAttachment,
} from "@xos/data/attachments";
import { deleteComment, postComment } from "@xos/data/comments";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "./actions";
import { fromDataError, type ActionState } from "./forms";

/**
 * Comments and attachments on procurement, vendor, knowledge and canon extension rows (Section
 * 19.6), through A18's unified comment system and attachment service (0580, 0590). Only A16's
 * subject tables are accepted; each subject's read policy decides who reads and posts.
 */

const SUBJECT_TABLES = [
  "app.vendors",
  "app.prequalifications",
  "app.insurance_certificates",
  "app.vendor_scorecards",
  "app.sponsor_entitlements",
  "app.sponsor_assets",
  "app.entitlement_deliveries",
  "app.rfqs",
  "app.purchase_orders",
  "app.goods_receipts",
  "app.invoice_matches",
  "app.submittals",
  "app.catalog_bindings",
  "app.sops",
  "app.documents",
  "app.canon_extension_proposals",
  // A29 workforce subjects (0801, 0807).
  "app.feed_posts",
  "app.groups",
  "app.workforce_events",
  "app.form_submissions",
  "app.handbook_articles",
  "app.lost_found_items",
] as const;

const subjectSchema = z.object({ table: z.enum(SUBJECT_TABLES), id: z.uuid() });
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface CollabState extends ActionState {
  /** A short-lived download link. */
  readonly link?: string;
}

function refresh(slug: string) {
  revalidatePath(`/${slug}`, "layout");
}

export async function postCommentAction(_: CollabState, form: FormData): Promise<CollabState> {
  const ctx = await actionContext(form);
  const subject = subjectSchema.safeParse({ table: form.get("table"), id: form.get("id") });
  const body = z.string().trim().min(1).max(10_000).safeParse(form.get("body"));
  if (!subject.success) return { error: "notFound" };
  if (!body.success) return { fieldErrors: { body: "required" } };
  const result = await postComment(ctx.viewer.db, { subject: subject.data, body: body.data });
  if (!result.ok) return fromDataError(result.error);
  refresh(ctx.org.slug);
  return { ok: true };
}

export async function deleteCommentAction(_: CollabState, form: FormData): Promise<CollabState> {
  const ctx = await actionContext(form);
  const id = z.uuid().safeParse(form.get("commentId"));
  if (!id.success) return { error: "notFound" };
  const result = await deleteComment(ctx.viewer.db, id.data);
  if (!result.ok) return fromDataError(result.error);
  refresh(ctx.org.slug);
  return { ok: true };
}

export async function uploadAttachmentAction(_: CollabState, form: FormData): Promise<CollabState> {
  const ctx = await actionContext(form);
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
  if (!result.ok) return fromDataError(result.error);
  refresh(ctx.org.slug);
  return { ok: true };
}

export async function removeAttachmentAction(_: CollabState, form: FormData): Promise<CollabState> {
  const ctx = await actionContext(form);
  const id = z.uuid().safeParse(form.get("attachmentId"));
  if (!id.success) return { error: "notFound" };
  const result = await removeAttachment(ctx.viewer.db, id.data);
  if (!result.ok) return fromDataError(result.error);
  refresh(ctx.org.slug);
  return { ok: true };
}

export async function attachmentLinkAction(_: CollabState, form: FormData): Promise<CollabState> {
  const ctx = await actionContext(form);
  const subject = subjectSchema.safeParse({ table: form.get("table"), id: form.get("id") });
  const attachmentId = form.get("attachmentId");
  if (!subject.success || typeof attachmentId !== "string") return { error: "notFound" };
  const list = await listAttachments(ctx.viewer.db, subject.data);
  if (!list.ok) return fromDataError(list.error);
  const current = list.data.find((a) => a.id === attachmentId)?.current;
  if (!current) return { error: "fileScanning" };
  const url = await downloadUrl(ctx.viewer.db, current);
  if (!url.ok) return fromDataError(url.error);
  return { ok: true, link: url.data };
}
