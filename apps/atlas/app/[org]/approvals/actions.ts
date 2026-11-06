"use server";

import {
  APPROVAL_DOCUMENT_TYPES,
  cancelApproval,
  cancelSubjectApproval,
  decideApproval,
  decideSubjectApproval,
  remindApprovers,
  requestApproval,
} from "@xos/data/workflow";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { type WorkflowActionState } from "@/lib/workflow/state";
import { fromDataError } from "@/lib/workflow/data-error";

/**
 * Approvals actions (A33): submit a spend document for approval, decide the step an approval waits
 * on, and withdraw one. P9 adds the same decision and withdrawal for a pass, dock booking or
 * equipment approval (kind "subject", app.decide_subject_approval and app.cancel_subject_approval),
 * and Remind approvers (app.remind_approvers). The approval RPCs decide every rule; refusals return
 * their rule.
 */

/** Which approval a form names: a spend approval instance, or a subject approval (P9, 2860). */
function kindOf(form: FormData): "spend" | "subject" {
  return form.get("kind") === "subject" ? "subject" : "spend";
}

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

const documentShape = z
  .string()
  .transform((v) => v.split("|"))
  .pipe(z.tuple([z.enum(APPROVAL_DOCUMENT_TYPES), z.uuid()]));

export async function requestApprovalAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = documentShape.safeParse(form.get("document"));
  if (!parsed.success) return { error: "input", at: Date.now() };
  const [documentType, documentId] = parsed.data;
  const result = await requestApproval(ctx.viewer.db, { documentType, documentId });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/approvals`);
  return { ok: true, id: result.data, at: Date.now() };
}

export async function decideApprovalAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      id: z.uuid(),
      decision: z.enum(["approve", "reject"]),
      comment: z.string().trim().max(2000),
    })
    .safeParse({
      id: form.get("id"),
      decision: form.get("decision"),
      comment: form.get("comment") ?? "",
    });
  if (!parsed.success) return { error: "input", at: Date.now() };
  const decision = {
    id: parsed.data.id,
    approved: parsed.data.decision === "approve",
    comment: parsed.data.comment === "" ? null : parsed.data.comment,
  };
  const result =
    kindOf(form) === "subject"
      ? await decideSubjectApproval(ctx.viewer.db, decision)
      : await decideApproval(ctx.viewer.db, decision);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/approvals`);
  return { ok: true, id: result.data, at: Date.now() };
}

export async function cancelApprovalAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ id: z.uuid(), reason: z.string().trim().min(1).max(500) })
    .safeParse({ id: form.get("id"), reason: form.get("reason") });
  if (!parsed.success) return { error: "input", at: Date.now() };
  const result =
    kindOf(form) === "subject"
      ? await cancelSubjectApproval(ctx.viewer.db, parsed.data)
      : await cancelApproval(ctx.viewer.db, parsed.data);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/approvals`);
  return { ok: true, id: result.data, at: Date.now() };
}

/**
 * Remind approvers (P9, G-261): a manual reminder to the approvers of the step a spend approval, a
 * timesheet or a subject approval waits on. The database allows one every 4 hours, counts it toward
 * the org's limit and names the next allowed time when it refuses.
 */
export async function remindApproversAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      subjectTable: z.enum(["approval_instances", "timesheets", "subject_approvals"]),
      subjectId: z.uuid(),
    })
    .safeParse({ subjectTable: form.get("subjectTable"), subjectId: form.get("subjectId") });
  if (!parsed.success) return { error: "input", at: Date.now() };
  const result = await remindApprovers(ctx.viewer.db, parsed.data);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/approvals`);
  return { ok: true, id: parsed.data.subjectId, at: Date.now() };
}
