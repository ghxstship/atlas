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
import type { ActionState } from "@/app/[org]/finance/actions";
import { getOrgContext } from "@/lib/shell/context";
import { observability } from "@/lib/observability";

/**
 * Comments and attachments on finance documents (Section 19.6), through A18's unified comment system
 * and attachment service (0580, 0590). The subject must be a finance table registered as a comment
 * subject (0580 and 0990); the database checks the person can read the row through its own policy.
 */

const SUBJECT_TABLES = [
  "app.budgets",
  "app.budget_lines",
  "app.expenses",
  "app.change_orders",
  "app.invoices",
  "app.payments",
  "app.journal_entries",
  "app.accounting_periods",
  "app.cost_centers",
  "app.settlements",
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

function done(slug: string, result: { ok: boolean; error?: unknown }): ActionState {
  if (!result.ok) {
    const error = result.error as { kind: string; rule?: string; message?: string };
    if (error.kind === "refusal")
      return {
        error: { kind: "refusal", rule: error.rule ?? "refused", message: error.message ?? "" },
        at: Date.now(),
      };
    if (error.kind === "unexpected")
      observability.logger.error("finance collaboration action failed", { error: error });
    return {
      error: { kind: error.kind === "not-found" ? "not-found" : "unexpected" },
      at: Date.now(),
    };
  }
  revalidatePath(`/${slug}`, "layout");
  return { ok: true, at: Date.now() };
}

export async function postCommentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { ctx, subject } = await resolve(form);
  if (!subject) return { error: { kind: "not-found" } };
  const body = z.string().trim().min(1).max(10_000).safeParse(form.get("body"));
  if (!body.success) return { error: { kind: "input" }, fieldErrors: { body: "comment" } };
  return done(ctx.org.slug, await postComment(ctx.viewer.db, { subject, body: body.data }));
}

export async function deleteCommentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { ctx } = await resolve(form);
  const id = z.uuid().safeParse(form.get("commentId"));
  if (!id.success) return { error: { kind: "not-found" } };
  return done(ctx.org.slug, await deleteComment(ctx.viewer.db, id.data));
}

export async function uploadAttachmentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { ctx, subject } = await resolve(form);
  if (!subject) return { error: { kind: "not-found" } };
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    return { error: { kind: "input" }, fieldErrors: { file: "file" } };
  if (file.size > MAX_UPLOAD_BYTES)
    return { error: { kind: "input" }, fieldErrors: { file: "fileSize" } };
  return done(
    ctx.org.slug,
    await uploadAttachment(ctx.viewer.db, { subject, file, filename: file.name }),
  );
}

export async function removeAttachmentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { ctx } = await resolve(form);
  const id = z.uuid().safeParse(form.get("attachmentId"));
  if (!id.success) return { error: { kind: "not-found" } };
  return done(ctx.org.slug, await removeAttachment(ctx.viewer.db, id.data));
}

/** A short-lived link to the current clean version of an attachment, or null when none is ready. */
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
