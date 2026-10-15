"use server";

import { downloadUrl, listAttachments, removeAttachment, uploadAttachment } from "@xos/data/attachments";
import { deleteComment, postComment } from "@xos/data/comments";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "./actions";
import { getProjectContextFor, type ProjectContext } from "./context";

/**
 * Comments and attachments on a project (Section 19.6), through A18's unified comment system and
 * attachment service (migrations 0580 and 0590). The subject is always the project the route names,
 * resolved again here, so a form can never point a comment at another row.
 */

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

async function projectFor(form: FormData): Promise<ProjectContext> {
  const ctx = await getProjectContextFor({
    org: field(form, "org"),
    projectKey: field(form, "projectKey"),
  });
  if (!ctx) notFound();
  return ctx;
}

function subject(ctx: ProjectContext) {
  return { table: "app.projects", id: ctx.project.id } as const;
}

function refresh(ctx: ProjectContext) {
  revalidatePath(`/${ctx.org.org.slug}/p/${ctx.project.key}`, "layout");
}

function failed(kind: string, rule?: string): ActionState {
  if (kind === "refusal") return { error: "refused", values: { rule: rule ?? "refused" } };
  return { error: kind === "not-found" ? "not-found" : "unexpected" };
}

export async function postCommentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await projectFor(form);
  const body = z.string().trim().min(1).max(10_000).safeParse(field(form, "body"));
  if (!body.success) return { fieldErrors: { body: "comment" } };
  const result = await postComment(ctx.org.viewer.db, { subject: subject(ctx), body: body.data });
  if (!result.ok) {
    return failed(result.error.kind, result.error.kind === "refusal" ? result.error.rule : undefined);
  }
  refresh(ctx);
  return { ok: true };
}

export async function deleteCommentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await projectFor(form);
  const id = z.uuid().safeParse(field(form, "commentId"));
  if (!id.success) return { error: "not-found" };
  const result = await deleteComment(ctx.org.viewer.db, id.data);
  if (!result.ok) return failed(result.error.kind);
  refresh(ctx);
  return { ok: true };
}

export async function uploadAttachmentAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await projectFor(form);
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { fieldErrors: { file: "file" } };
  if (file.size > MAX_UPLOAD_BYTES) return { fieldErrors: { file: "fileSize" } };
  const result = await uploadAttachment(ctx.org.viewer.db, {
    subject: subject(ctx),
    file,
    filename: file.name,
  });
  if (!result.ok) {
    return failed(result.error.kind, result.error.kind === "refusal" ? result.error.rule : undefined);
  }
  refresh(ctx);
  return { ok: true };
}

export async function removeAttachmentAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await projectFor(form);
  const id = z.uuid().safeParse(field(form, "attachmentId"));
  if (!id.success) return { error: "not-found" };
  const result = await removeAttachment(ctx.org.viewer.db, id.data);
  if (!result.ok) return failed(result.error.kind);
  refresh(ctx);
  return { ok: true };
}

/** A short-lived link to the current clean version of a project attachment, or null. */
export async function attachmentLinkAction(
  org: string,
  projectKey: string,
  attachmentId: string,
): Promise<string | null> {
  const ctx = await getProjectContextFor({ org, projectKey });
  if (!ctx) return null;
  const list = await listAttachments(ctx.org.viewer.db, subject(ctx));
  if (!list.ok) return null;
  const current = list.data.find((a) => a.id === attachmentId)?.current;
  if (!current) return null;
  const url = await downloadUrl(ctx.org.viewer.db, current);
  return url.ok ? url.data : null;
}
