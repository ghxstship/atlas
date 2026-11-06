"use server";

import {
  addLegalAlertContact,
  addLegalQueueItem,
  appointOutsideReviewer,
  endOutsideReviewer,
  extendLegalQueueItem,
  noteLegalQueueItem,
  recordLegalFirstResponse,
  removeLegalAlertContact,
  transitionLegalQueueItem,
  type LegalQueueState,
} from "@xos/data/console-legal-queue";
import * as enums from "@xos/data/enums";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { failed, field, fromResult, localDateTime, type ActionState } from "@/lib/action-state";
import { actionContext } from "@/lib/operator";

/**
 * The legal queue (ADR 0167, migrations 6165 to 6168). Each action checks the operator, legal.queue and the second factor,
 * and the database checks them again, computes every clock, and logs what was done.
 */

const Uuid = z.uuid();
const STATES: readonly LegalQueueState[] = enums.legalQueueState;

function refresh(itemId?: string): void {
  revalidatePath("/legal-queue");
  if (itemId) revalidatePath(`/legal-queue/${itemId}`);
}

export async function addLegalQueueItemAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("legal.queue");
  if (!ctx.ok) return failed(ctx.key);
  // Typed in the zone the queue counts in; the database applies that zone's offset for the day entered.
  const dueRaw = field(form, "dueAt");
  const receivedLocal = localDateTime(field(form, "receivedAt"));
  const dueLocal = dueRaw === "" ? null : localDateTime(dueRaw);
  if (!receivedLocal) return failed("refusals.legal_queue_received");
  if (dueRaw !== "" && !dueLocal) return failed("refusals.legal_queue_due");
  const result = await addLegalQueueItem(ctx.db, {
    ruleCode: field(form, "ruleCode"),
    title: field(form, "title"),
    receivedLocal,
    details: field(form, "details") || null,
    requesterContact: field(form, "requesterContact") || null,
    subjectEmail: field(form, "subjectEmail") || null,
    relatedReference: field(form, "relatedReference") || null,
    dueLocal,
  });
  if (result.ok) refresh();
  return fromResult(result);
}

export async function moveLegalQueueItemAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("legal.queue");
  if (!ctx.ok) return failed(ctx.key);
  const itemId = field(form, "itemId");
  const expected = STATES.find((s) => s === field(form, "expected"));
  const next = STATES.find((s) => s === field(form, "next"));
  if (!Uuid.safeParse(itemId).success || !expected || !next) return failed("errors.invalid");
  const result = await transitionLegalQueueItem(ctx.db, {
    itemId,
    expected,
    next,
    reason: field(form, "reason"),
    courtActionFiled: form.get("courtActionFiled") === "on",
    reReviewNotes: field(form, "reReviewNotes") || null,
    toldHow: field(form, "toldHow") || null,
    samePerson: form.get("samePerson") === "on",
    outsideReviewerDecided: field(form, "outsideReviewerDecided") === "yes",
  });
  if (result.ok) refresh(itemId);
  return fromResult(result);
}

export async function recordLegalFirstResponseAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("legal.queue");
  if (!ctx.ok) return failed(ctx.key);
  const itemId = field(form, "itemId");
  if (!Uuid.safeParse(itemId).success) return failed("errors.invalid");
  const result = await recordLegalFirstResponse(ctx.db, itemId, field(form, "note"));
  if (result.ok) refresh(itemId);
  return fromResult(result);
}

export async function extendLegalQueueItemAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("legal.queue");
  if (!ctx.ok) return failed(ctx.key);
  const itemId = field(form, "itemId");
  if (!Uuid.safeParse(itemId).success) return failed("errors.invalid");
  const result = await extendLegalQueueItem(ctx.db, itemId, field(form, "reason"));
  if (result.ok) refresh(itemId);
  return fromResult(result);
}

export async function noteLegalQueueItemAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("legal.queue");
  if (!ctx.ok) return failed(ctx.key);
  const itemId = field(form, "itemId");
  if (!Uuid.safeParse(itemId).success) return failed("errors.invalid");
  const result = await noteLegalQueueItem(ctx.db, itemId, field(form, "note"));
  if (result.ok) refresh(itemId);
  return fromResult(result);
}

export async function addLegalAlertContactAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("legal.queue");
  if (!ctx.ok) return failed(ctx.key);
  const result = await addLegalAlertContact(ctx.db, field(form, "name"), field(form, "email"));
  if (result.ok) refresh();
  return fromResult(result);
}

export async function removeLegalAlertContactAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("legal.queue");
  if (!ctx.ok) return failed(ctx.key);
  const contactId = field(form, "contactId");
  if (!Uuid.safeParse(contactId).success) return failed("errors.invalid");
  const result = await removeLegalAlertContact(ctx.db, contactId);
  if (result.ok) refresh();
  return fromResult(result);
}

export async function appointOutsideReviewerAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("legal.queue");
  if (!ctx.ok) return failed(ctx.key);
  const result = await appointOutsideReviewer(ctx.db, {
    name: field(form, "name"),
    organization: field(form, "organization") || null,
    email: field(form, "email"),
    reason: field(form, "reason"),
  });
  if (result.ok) refresh();
  return fromResult(result);
}

export async function endOutsideReviewerAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("legal.queue");
  if (!ctx.ok) return failed(ctx.key);
  const reviewerId = field(form, "reviewerId");
  if (!Uuid.safeParse(reviewerId).success) return failed("errors.invalid");
  const result = await endOutsideReviewer(ctx.db, reviewerId, field(form, "reason"));
  if (result.ok) refresh();
  return fromResult(result);
}
