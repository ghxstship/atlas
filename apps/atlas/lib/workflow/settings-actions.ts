"use server";

import {
  addApprovalStep,
  APPROVAL_DOCUMENT_TYPES,
  createApprovalPolicy,
  deleteApprovalPolicy,
  removeApprovalStep,
  setStateLabel,
  transitionApprovalPolicy,
} from "@xos/data/workflow";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { fromDataError } from "./data-error";
import type { WorkflowActionState } from "./state";
import * as enums from "@xos/data/enums";

/**
 * A33's settings panel actions (ADR 0021 item 7): approval policies and their steps on Settings,
 * Approval policies, and record state labels on Settings, Views and defaults. The database decides
 * (org.approval_policies.write, org.views.write); refusals return their rule.
 */

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

const blank = (v: FormDataEntryValue | null) =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

function done(slug: string, id?: string | null): WorkflowActionState {
  revalidatePath(`/${slug}/settings`, "layout");
  revalidatePath(`/${slug}/approvals`);
  return { ok: true, ...(id ? { id } : {}), at: Date.now() };
}

export async function createPolicyAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      name: z.string().min(1).max(200),
      description: z.string().max(2000).nullable(),
      documentType: z.enum(APPROVAL_DOCUMENT_TYPES),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .nullable(),
      threshold: z.coerce.number().min(0).max(1e13).nullable(),
      exponent: z.coerce.number().int().min(0).max(4),
    })
    .safeParse({
      name: blank(form.get("name")),
      description: blank(form.get("description")),
      documentType: form.get("documentType"),
      currency: blank(form.get("currency")),
      threshold: blank(form.get("threshold")),
      exponent: form.get("exponent") ?? "2",
    });
  if (!parsed.success) return { error: "input", at: Date.now() };
  const d = parsed.data;
  if ((d.threshold === null) !== (d.currency === null)) return { error: "input", at: Date.now() };
  const result = await createApprovalPolicy(ctx.viewer.db, {
    orgId: ctx.org.id,
    name: d.name,
    description: d.description,
    documentType: d.documentType,
    currency: d.currency,
    appliesAboveMinor: d.threshold === null ? null : Math.round(d.threshold * 10 ** d.exponent),
  });
  return result.ok ? done(ctx.org.slug, result.data) : fromDataError(result.error);
}

export async function deletePolicyAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "input", at: Date.now() };
  const result = await deleteApprovalPolicy(ctx.viewer.db, id.data);
  return result.ok ? done(ctx.org.slug) : fromDataError(result.error);
}

export async function addStepAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      policyId: z.uuid(),
      name: z.string().min(1).max(200),
      approver: z.string().regex(/^(role|member):[0-9a-f-]{36}$/),
    })
    .safeParse({
      policyId: form.get("policyId"),
      name: blank(form.get("name")),
      approver: form.get("approver"),
    });
  if (!parsed.success) return { error: "input", at: Date.now() };
  const [kind, value] = parsed.data.approver.split(":") as [string, string];
  const result = await addApprovalStep(ctx.viewer.db, {
    policyId: parsed.data.policyId,
    name: parsed.data.name,
    roleId: kind === "role" ? value : null,
    membershipId: kind === "member" ? value : null,
  });
  return result.ok ? done(ctx.org.slug, result.data) : fromDataError(result.error);
}

export async function removeStepAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "input", at: Date.now() };
  const result = await removeApprovalStep(ctx.viewer.db, id.data);
  return result.ok ? done(ctx.org.slug) : fromDataError(result.error);
}

export async function transitionPolicyAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const state = z.enum(enums.approvalPolicyState);
  const parsed = z
    .object({ id: z.uuid(), from: state, to: state, reason: z.string().min(1).max(500) })
    .safeParse({
      id: form.get("id"),
      from: form.get("from"),
      to: form.get("to"),
      reason: blank(form.get("reason")),
    });
  if (!parsed.success) return { error: "input", at: Date.now() };
  const result = await transitionApprovalPolicy(ctx.viewer.db, parsed.data);
  return result.ok ? done(ctx.org.slug) : fromDataError(result.error);
}

export async function setStateLabelAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      state: z.string().min(1).max(40),
      label: z.string().max(40).nullable(),
      labelId: z.uuid().nullable(),
    })
    .safeParse({
      state: form.get("state"),
      label: blank(form.get("label")),
      labelId: blank(form.get("labelId")),
    });
  if (!parsed.success) return { error: "input", at: Date.now() };
  const result = await setStateLabel(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  return result.ok ? done(ctx.org.slug, result.data) : fromDataError(result.error);
}
