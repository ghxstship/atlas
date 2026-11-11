"use server";

import {
  acceptEngagedShift,
  acknowledgePurchaseOrder,
  agreeSelfBilling,
  APP_ENUMS,
  decideClientApproval,
  onboardingObjectName,
  openThread,
  revokeSelfBilling,
  submitAdvanceAnswer,
  submitDeliverable,
  submitEngagedSubmittal,
  submitEngagementInvoice,
  submitTaxForm,
  submitTimesheet,
  uploadOnboardingFile,
} from "@xos/data/gateway";
import { createHash } from "node:crypto";
import { z } from "zod";
import { outcomeFor, toAction, type ActionResult } from "@/lib/action-result";
import { parseMoneyInput } from "@/lib/format";
import { getGatewayContext } from "@/lib/shell/context";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Server actions for the engagement tabs (A28b RPCs). Each validates its input and lets the
 * database decide; refusals come back as catalog copy through the shared outcome keys.
 */
const id = z.uuid();

export interface FormResult {
  readonly outcome?: string;
  readonly fieldError?: string;
  readonly done?: boolean;
}

function done(result: { ok: boolean; error?: Parameters<typeof outcomeFor>[0] }): FormResult {
  return result.ok || !result.error ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function acceptShiftAction(shiftId: string): Promise<ActionResult> {
  return toAction(await acceptEngagedShift(await createServerSupabase(), id.parse(shiftId)));
}

export async function submitTimesheetAction(timesheetId: string): Promise<ActionResult> {
  return toAction(await submitTimesheet(await createServerSupabase(), id.parse(timesheetId)));
}

export async function acknowledgePurchaseOrderAction(
  purchaseOrderId: string,
): Promise<ActionResult> {
  return toAction(
    await acknowledgePurchaseOrder(await createServerSupabase(), id.parse(purchaseOrderId)),
  );
}

export async function agreeSelfBillingAction(engagementId: string): Promise<ActionResult> {
  return toAction(await agreeSelfBilling(await createServerSupabase(), id.parse(engagementId)));
}

export async function revokeSelfBillingAction(engagementId: string): Promise<ActionResult> {
  return toAction(await revokeSelfBilling(await createServerSupabase(), id.parse(engagementId)));
}

export async function answerAdvanceAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = z
    .object({ recipientId: id, sectionId: id, body: z.string().trim().min(1).max(20000) })
    .safeParse({
      recipientId: form.get("recipientId"),
      sectionId: form.get("sectionId"),
      body: form.get("body"),
    });
  if (!parsed.success) return { fieldError: "answer" };
  const result = await submitAdvanceAnswer(await createServerSupabase(), parsed.data);
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function decideApprovalAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = z
    .object({
      requestId: id,
      decision: z.enum(APP_ENUMS.approval_decision),
      response: z.string().trim().max(2000),
    })
    .safeParse({
      requestId: form.get("requestId"),
      decision: form.get("decision"),
      response: form.get("response") ?? "",
    });
  if (!parsed.success) return { fieldError: "decision" };
  if (parsed.data.decision === "Rejected" && parsed.data.response === "")
    return { fieldError: "reason" };
  const result = await decideClientApproval(await createServerSupabase(), parsed.data);
  return done(result);
}

export async function submitDeliverableAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = z
    .object({ deliverableId: id, documentId: id, message: z.string().trim().min(1).max(2000) })
    .safeParse({
      deliverableId: form.get("deliverableId"),
      documentId: form.get("documentId"),
      message: form.get("message"),
    });
  if (!parsed.success) return { fieldError: "deliverable" };
  const result = await submitDeliverable(await createServerSupabase(), parsed.data);
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function respondSubmittalAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = z
    .object({
      submittalId: id,
      expected: z.enum(["Proposed", "Returned"]),
      note: z.string().trim().min(1).max(500),
    })
    .safeParse({
      submittalId: form.get("submittalId"),
      expected: form.get("expected"),
      note: form.get("note"),
    });
  if (!parsed.success) return { fieldError: "submittalNote" };
  const result = await submitEngagedSubmittal(await createServerSupabase(), parsed.data);
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function submitInvoiceAction(_: FormResult, form: FormData): Promise<FormResult> {
  const currency = String(form.get("currency") ?? "");
  const header = z
    .object({
      engagementId: id,
      invoiceNumber: z.string().trim().min(1).max(64),
      issuedOn: z.iso.date(),
      dueOn: z.iso.date(),
      currency: z.string().regex(/^[A-Z]{3}$/),
    })
    .safeParse({
      engagementId: form.get("engagementId"),
      invoiceNumber: form.get("invoiceNumber"),
      issuedOn: form.get("issuedOn"),
      dueOn: form.get("dueOn"),
      currency,
    });
  if (!header.success) return { fieldError: "header" };
  if (header.data.dueOn < header.data.issuedOn) return { fieldError: "dates" };
  const descriptions = form.getAll("lineDescription").map((v) => String(v).trim());
  const quantities = form.getAll("lineQuantity").map((v) => Number(v));
  const prices = form.getAll("linePrice").map((v) => parseMoneyInput(String(v), currency));
  const lines = descriptions
    .map((description, i) => ({
      description,
      quantity: quantities[i] ?? 0,
      unitPriceMinor: prices[i] ?? null,
    }))
    .filter((l) => l.description !== "");
  if (lines.length === 0 || lines.some((l) => !(l.quantity > 0) || l.unitPriceMinor === null)) {
    return { fieldError: "lines" };
  }
  const result = await submitEngagementInvoice(await createServerSupabase(), {
    ...header.data,
    lines: lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor as number,
    })),
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

const UPLOAD_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/webp"];
const UPLOAD_LIMIT = 26_214_400;

export async function uploadOnboardingAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = z
    .object({ orgId: id, engagementId: id, itemId: id, title: z.string().trim().min(1).max(200) })
    .safeParse({
      orgId: form.get("orgId"),
      engagementId: form.get("engagementId"),
      itemId: form.get("itemId"),
      title: form.get("title"),
    });
  const file = form.get("file");
  if (!parsed.success || !(file instanceof File) || file.size === 0) return { fieldError: "file" };
  if (!UPLOAD_TYPES.includes(file.type)) return { fieldError: "fileType" };
  if (file.size > UPLOAD_LIMIT) return { fieldError: "fileSize" };
  const bytes = Buffer.from(await file.arrayBuffer());
  const result = await uploadOnboardingFile(await createServerSupabase(), {
    objectName: onboardingObjectName({ ...parsed.data, fileName: file.name }),
    title: parsed.data.title,
    body: new Blob([bytes], { type: file.type }),
    contentType: file.type,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function submitTaxFormAction(_: FormResult, form: FormData): Promise<FormResult> {
  const ctx = await getGatewayContext();
  if (!ctx) return { outcome: "notFound" };
  const parsed = z
    .object({
      orgId: id,
      formKind: z.enum(APP_ENUMS.tax_form_kind),
      tin: z.string().trim().min(4).max(40),
      withholding: z.boolean(),
    })
    .safeParse({
      orgId: form.get("orgId"),
      formKind: form.get("formKind"),
      tin: form.get("tin"),
      withholding: form.get("withholding") === "on",
    });
  if (!parsed.success) return { fieldError: "tin" };
  const result = await submitTaxForm(ctx.db, {
    orgId: parsed.data.orgId,
    formKind: parsed.data.formKind,
    tin: parsed.data.tin,
    accountId: ctx.acting?.id ?? null,
    foreignPerformerWithholding: parsed.data.withholding,
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function openThreadAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = z
    .object({ engagementId: id, subject: z.string().trim().min(1).max(200) })
    .safeParse({ engagementId: form.get("engagementId"), subject: form.get("subject") });
  if (!parsed.success) return { fieldError: "subject" };
  const result = await openThread(await createServerSupabase(), parsed.data);
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}
