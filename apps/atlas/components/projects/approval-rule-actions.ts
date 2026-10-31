"use server";

import {
  APPROVAL_RULE_SUBJECTS,
  deleteApprovalRule,
  removeApprovalRuleStep,
  saveApprovalRule,
  saveApprovalRuleStep,
  transitionApprovalRule,
  type ApprovalRuleApprover,
} from "@xos/data/workflow";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { fromDataError } from "@/lib/workflow/data-error";
import type { WorkflowActionState } from "@/lib/workflow/state";

/**
 * Approval rule actions (P9, migration 2860): add a rule to a project, add and remove its steps
 * while it is a Draft, activate, retire and delete it. They run as the viewer, so the
 * app.approval_rules policies decide (projects.settings.write on the project or
 * org.approval_policies.write), and app.transition_approval_rule checks that every step can be
 * reached. Refusals come back with their rule, shown in workflow.refusals copy.
 */

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function done(org: string, projectKey: string, id?: string): WorkflowActionState {
  revalidatePath(`/${org}/p/${projectKey}/settings`);
  return { ok: true, ...(id ? { id } : {}), at: Date.now() };
}

const projectKey = z.string().min(1).max(40);

export async function createApprovalRuleAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      projectId: z.uuid(),
      projectKey,
      subject: z.enum(APPROVAL_RULE_SUBJECTS),
      filterId: z.union([z.literal(""), z.uuid()]),
      name: z.string().min(1).max(200),
      description: z.string().max(2000),
    })
    .safeParse({
      projectId: text(form, "projectId"),
      projectKey: text(form, "projectKey"),
      subject: text(form, "subject"),
      filterId: text(form, "filterId"),
      name: text(form, "name"),
      description: text(form, "description"),
    });
  if (!parsed.success) return { error: "input", at: Date.now() };
  const result = await saveApprovalRule(ctx.viewer.db, {
    projectId: parsed.data.projectId,
    subject: parsed.data.subject,
    name: parsed.data.name,
    description: parsed.data.description === "" ? null : parsed.data.description,
    filterId: parsed.data.filterId === "" ? null : parsed.data.filterId,
  });
  return result.ok
    ? done(ctx.org.slug, parsed.data.projectKey, result.data)
    : fromDataError(result.error);
}

/** The step's approver from the picker's value: role:<id>, member:<id> or engagement:<id>. */
function approverOf(value: string, signedOut: boolean): ApprovalRuleApprover | null {
  const [kind, id] = value.split(":");
  if (!id || !z.uuid().safeParse(id).success) return null;
  if (kind === "role") return { kind: "role", id };
  if (kind === "member") return { kind: "member", id };
  if (kind === "engagement") return { kind: "engagement", id, signedOutLinks: signedOut };
  return null;
}

export async function addApprovalRuleStepAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ ruleId: z.uuid(), projectKey, name: z.string().min(1).max(200) })
    .safeParse({
      ruleId: text(form, "ruleId"),
      projectKey: text(form, "projectKey"),
      name: text(form, "name"),
    });
  const approver = approverOf(text(form, "approver"), form.get("signedOutLinks") === "on");
  if (!parsed.success || !approver) return { error: "input", at: Date.now() };
  const result = await saveApprovalRuleStep(ctx.viewer.db, {
    ruleId: parsed.data.ruleId,
    name: parsed.data.name,
    approver,
  });
  return result.ok
    ? done(ctx.org.slug, parsed.data.projectKey, result.data)
    : fromDataError(result.error);
}

export async function removeApprovalRuleStepAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ id: z.uuid(), projectKey })
    .safeParse({ id: text(form, "id"), projectKey: text(form, "projectKey") });
  if (!parsed.success) return { error: "input", at: Date.now() };
  const result = await removeApprovalRuleStep(ctx.viewer.db, parsed.data.id);
  return result.ok ? done(ctx.org.slug, parsed.data.projectKey) : fromDataError(result.error);
}

export async function transitionApprovalRuleAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const state = z.enum(["Draft", "Active", "Retired"]);
  const parsed = z
    .object({
      id: z.uuid(),
      projectKey,
      from: state,
      to: state,
      reason: z.string().min(1).max(500),
    })
    .safeParse({
      id: text(form, "id"),
      projectKey: text(form, "projectKey"),
      from: text(form, "from"),
      to: text(form, "to"),
      reason: text(form, "reason"),
    });
  if (!parsed.success) return { error: "input", at: Date.now() };
  const result = await transitionApprovalRule(ctx.viewer.db, parsed.data);
  return result.ok ? done(ctx.org.slug, parsed.data.projectKey) : fromDataError(result.error);
}

export async function deleteApprovalRuleAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ id: z.uuid(), projectKey })
    .safeParse({ id: text(form, "id"), projectKey: text(form, "projectKey") });
  if (!parsed.success) return { error: "input", at: Date.now() };
  const result = await deleteApprovalRule(ctx.viewer.db, parsed.data.id);
  return result.ok ? done(ctx.org.slug, parsed.data.projectKey) : fromDataError(result.error);
}
