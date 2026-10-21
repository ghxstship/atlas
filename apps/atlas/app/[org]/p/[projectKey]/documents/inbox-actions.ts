"use server";

import {
  createProjectInbox,
  disableProjectInbox,
  discardInboundMessage,
  fileInboundMessage,
  replaceProjectInbox,
} from "@xos/data/project-inbox";
import type { Result } from "@xos/data/result";
import { revalidatePath } from "next/cache";
import { actionContext } from "@/lib/collection-kit/actions";
import {
  fromDataError,
  requiredText,
  text,
  uuid,
  type ActionState,
} from "@/lib/collection-kit/forms";
import type { OrgContext } from "@/lib/shell/context";

/**
 * The project inbox (Section 4.6.5, migration 1411): create, replace or turn off the project's
 * address (projects.settings.write), and file mail as a Document record of the project, optionally
 * on one of its records, or discard it with a reason (knowledge.document.write on the project).
 * Every write runs as the viewer; row level security and the 1411 guard decide.
 */

const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;

function finish(result: Result<unknown>, ctx: OrgContext, form: FormData): ActionState {
  if (!result.ok) return fromDataError(result.error);
  const key = text(form, "projectKey");
  if (key && PROJECT_KEY.test(key)) revalidatePath(`/${ctx.org.slug}/p/${key}`, "layout");
  return { ok: true };
}

export async function fileInboxMessageAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  const title = text(form, "title");
  if (title !== null && title.length > 200) return { fieldErrors: { title: "range" } };
  const record = text(form, "recordId");
  const recordId = record === null ? null : uuid(form, "recordId");
  if (record !== null && recordId === null) return { fieldErrors: { recordId: "shape" } };
  return finish(await fileInboundMessage(ctx.viewer.db, { id, title, recordId }), ctx, form);
}

export async function discardInboxMessageAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  const reason = requiredText(form, "reason", 500);
  if (reason === null) return { fieldErrors: { reason: "required" } };
  return finish(await discardInboundMessage(ctx.viewer.db, { id, reason }), ctx, form);
}

async function addressAction(
  form: FormData,
  call: typeof createProjectInbox,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const projectId = uuid(form, "projectId");
  if (projectId === null) return { error: "notFound" };
  return finish(await call(ctx.viewer.db, projectId), ctx, form);
}

export async function createProjectInboxAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  return addressAction(form, createProjectInbox);
}

export async function replaceProjectInboxAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  return addressAction(form, replaceProjectInbox);
}

export async function disableProjectInboxAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  return addressAction(form, disableProjectInbox);
}
