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
import type { CrewActionState } from "@/lib/crew/action-state";
import { errorMessage } from "@/lib/crew/errors";
import { getOrgContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Comments and attachments on People and Crew records (Section 19.6) through A18's unified comment
 * system and attachment service (0580, 0590). Only the subject tables A13 registered in
 * private.comment_subjects are accepted; each subject's read policy decides who reads and posts.
 */

const SUBJECT_TABLES = [
  "app.shifts",
  "app.shift_swaps",
  "app.time_entries",
  "app.timesheets",
  "app.rate_cards",
  "app.pay_periods",
  "app.payroll_runs",
  "app.time_off_requests",
  "app.requisitions",
  "app.agreements",
  "app.role_assignments",
  "app.offers",
] as const;

const subject = z.object({ table: z.enum(SUBJECT_TABLES), id: z.uuid() });
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

async function context(form: FormData) {
  const org = form.get("org");
  const ctx = typeof org === "string" ? await getOrgContext(org) : null;
  if (!ctx) notFound();
  return { ctx, t: await getTranslate() };
}

function subjectOf(form: FormData) {
  return subject.safeParse({ table: form.get("table"), id: form.get("id") });
}

export async function postCommentAction(
  _: CrewActionState,
  form: FormData,
): Promise<CrewActionState> {
  const { ctx, t } = await context(form);
  const s = subjectOf(form);
  const body = z.string().trim().min(1).max(10_000).safeParse(form.get("body"));
  if (!s.success) return { error: t("crew.errors.notFound") };
  if (!body.success) return { error: t("crew.collab.commentRequired") };
  const result = await postComment(ctx.viewer.db, { subject: s.data, body: body.data });
  if (!result.ok) return { error: errorMessage(t, result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

export async function deleteCommentAction(
  _: CrewActionState,
  form: FormData,
): Promise<CrewActionState> {
  const { ctx, t } = await context(form);
  const id = z.uuid().safeParse(form.get("commentId"));
  if (!id.success) return { error: t("crew.errors.notFound") };
  const result = await deleteComment(ctx.viewer.db, id.data);
  if (!result.ok) return { error: errorMessage(t, result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

export async function uploadAttachmentAction(
  _: CrewActionState,
  form: FormData,
): Promise<CrewActionState> {
  const { ctx, t } = await context(form);
  const s = subjectOf(form);
  const file = form.get("file");
  if (!s.success) return { error: t("crew.errors.notFound") };
  if (!(file instanceof File) || file.size === 0) return { error: t("crew.collab.fileRequired") };
  if (file.size > MAX_UPLOAD_BYTES) return { error: t("crew.collab.fileTooLarge") };
  const result = await uploadAttachment(ctx.viewer.db, {
    subject: s.data,
    file,
    filename: file.name,
  });
  if (!result.ok) return { error: errorMessage(t, result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

export async function removeAttachmentAction(
  _: CrewActionState,
  form: FormData,
): Promise<CrewActionState> {
  const { ctx, t } = await context(form);
  const id = z.uuid().safeParse(form.get("attachmentId"));
  if (!id.success) return { error: t("crew.errors.notFound") };
  const result = await removeAttachment(ctx.viewer.db, id.data);
  if (!result.ok) return { error: errorMessage(t, result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

/** A short-lived link to the current clean version of an attachment. */
export async function attachmentLinkAction(
  _: CrewActionState,
  form: FormData,
): Promise<CrewActionState> {
  const { ctx, t } = await context(form);
  const s = subjectOf(form);
  const id = form.get("attachmentId");
  if (!s.success) return { error: t("crew.errors.notFound") };
  const list = await listAttachments(ctx.viewer.db, s.data);
  if (!list.ok) return { error: errorMessage(t, list.error) };
  const current = list.data.find((a) => a.id === id)?.current;
  if (!current) return { error: t("crew.collab.scanning") };
  const url = await downloadUrl(ctx.viewer.db, current);
  if (!url.ok) return { error: errorMessage(t, url.error) };
  return { ok: true, redirect: url.data };
}
