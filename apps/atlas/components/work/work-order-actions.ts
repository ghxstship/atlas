"use server";

import {
  addBid,
  awardWorkOrder,
  createPunchItem,
  createWorkOrder,
  deleteWorkOrder,
  transitionWorkOrder,
  updateBid,
  updateWorkOrder,
} from "@xos/data/work-orders";
import { duplicateRecord, getRecord } from "@xos/data/work";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { done, failed, invalid, type ActionResult } from "./action-result";

/**
 * Work order, bid and punch item actions (A08, migrations 0410, 0411, 0413), and record
 * duplication. Awarding goes through app.award_work_order, which refuses the work order's creator
 * and unpriced or withdrawn bids; those refusals come back as catalog keys under `work.errors`.
 */

async function context(org: string) {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  return ctx;
}

function refresh(org: string) {
  revalidatePath(`/${org}`, "layout");
}

const instant = z.iso.datetime({ offset: true }).nullable().optional();
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional();

const workOrderSchema = z.object({
  title: z.string().trim().min(1).max(200),
  scopeOfWork: z.string().max(5000).nullable().optional(),
  locationText: z.string().max(300).nullable().optional(),
  scheduledStartsAt: instant,
  scheduledEndsAt: instant,
  estimatedHours: z.number().min(0).max(100_000).nullable().optional(),
  bidDueAt: instant,
  budgetMinor: minor,
  currencyCode: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  recordId: z.uuid().nullable().optional(),
});

export type WorkOrderFormInput = z.input<typeof workOrderSchema>;

function clean<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

export async function createWorkOrderAction(
  org: string,
  projectId: string,
  input: WorkOrderFormInput,
): Promise<ActionResult<{ id: string }>> {
  const ctx = await context(org);
  const parsed = workOrderSchema.safeParse(input);
  if (!z.uuid().safeParse(projectId).success || !parsed.success) return invalid();
  const result = await createWorkOrder(ctx.viewer.db, {
    orgId: ctx.org.id,
    projectId,
    ...clean(parsed.data),
  });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done({ id: result.data.id });
}

export async function updateWorkOrderAction(
  org: string,
  id: string,
  input: WorkOrderFormInput,
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = workOrderSchema.partial().safeParse(input);
  if (!z.uuid().safeParse(id).success || !parsed.success) return invalid();
  const result = await updateWorkOrder(ctx.viewer.db, id, clean(parsed.data));
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function transitionWorkOrderAction(
  org: string,
  input: { id: string; expected: string; next: string; reason: string },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({
      id: z.uuid(),
      expected: z.string().min(1),
      next: z.string().min(1),
      reason: z.string().trim().min(1).max(500),
    })
    .safeParse(input);
  if (!parsed.success) return invalid("reasonRequired");
  const result = await transitionWorkOrder(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function deleteWorkOrderAction(org: string, id: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(id).success) return invalid();
  const result = await deleteWorkOrder(ctx.viewer.db, id);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function addBidAction(
  org: string,
  input: {
    workOrderId: string;
    bidderOrganizationId: string;
    amountMinor: number | null;
    currencyCode: string;
    note: string | null;
  },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({
      workOrderId: z.uuid(),
      bidderOrganizationId: z.uuid(),
      amountMinor: z.number().int().min(0).nullable(),
      currencyCode: z.string().regex(/^[A-Z]{3}$/),
      note: z.string().max(2000).nullable(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await addBid(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function withdrawBidAction(org: string, bidId: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(bidId).success) return invalid();
  const result = await updateBid(ctx.viewer.db, bidId, { withdraw: true });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function priceBidAction(
  org: string,
  bidId: string,
  amountMinor: number | null,
): Promise<ActionResult> {
  const ctx = await context(org);
  const amount = z.number().int().min(0).nullable().safeParse(amountMinor);
  if (!z.uuid().safeParse(bidId).success || !amount.success) return invalid();
  const result = await updateBid(ctx.viewer.db, bidId, { amountMinor: amount.data });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function awardBidAction(
  org: string,
  input: { workOrderId: string; bidId: string; reason: string },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({ workOrderId: z.uuid(), bidId: z.uuid(), reason: z.string().trim().min(1).max(500) })
    .safeParse(input);
  if (!parsed.success) return invalid("reasonRequired");
  const result = await awardWorkOrder(ctx.viewer.db, {
    id: parsed.data.workOrderId,
    bidId: parsed.data.bidId,
    reason: parsed.data.reason,
  });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function createPunchItemAction(
  org: string,
  input: {
    projectId: string;
    what: string;
    locationText: string | null;
    ownerId: string | null;
    dueAt: string | null;
  },
): Promise<ActionResult<{ id: string }>> {
  const ctx = await context(org);
  const parsed = z
    .object({
      projectId: z.uuid(),
      what: z.string().trim().min(1).max(190),
      locationText: z.string().trim().max(300).nullable(),
      ownerId: z.uuid().nullable(),
      dueAt: z.iso.datetime({ offset: true }).nullable(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid("punchWhat");
  const result = await createPunchItem(ctx.viewer.db, {
    ...parsed.data,
    locationText: parsed.data.locationText || null,
  });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(result.data);
}

/** Copies a record with its checklist into a new Proposed record (journey 70). */
export async function duplicateRecordAction(
  org: string,
  recordId: string,
): Promise<ActionResult<{ key: string }>> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(recordId).success) return invalid();
  const result = await duplicateRecord(ctx.viewer.db, {
    orgId: ctx.org.id,
    recordId,
    withChildren: true,
  });
  if (!result.ok) return failed(result.error);
  const copy = await getRecord(ctx.viewer.db, result.data.id);
  if (!copy.ok) return failed(copy.error);
  refresh(org);
  return done({ key: copy.data.key });
}
