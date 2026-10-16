"use server";

import {
  APPROVAL_DOCUMENT_TYPES,
  cancelApproval,
  decideApproval,
  requestApproval,
} from "@xos/data/workflow";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { fromDataError, type WorkflowActionState } from "@/lib/workflow/state";

/**
 * Approvals actions (A33): submit a spend document for approval, decide the step an approval waits
 * on, and withdraw one. The approval RPCs decide every rule; refusals return their rule.
 */

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
  const result = await decideApproval(ctx.viewer.db, {
    id: parsed.data.id,
    approved: parsed.data.decision === "approve",
    comment: parsed.data.comment === "" ? null : parsed.data.comment,
  });
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
  const result = await cancelApproval(ctx.viewer.db, parsed.data);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/approvals`);
  return { ok: true, id: result.data, at: Date.now() };
}
