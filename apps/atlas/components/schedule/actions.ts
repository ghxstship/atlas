"use server";

import {
  addDependency,
  createBaseline,
  lockBaseline,
  removeDependency,
  rescheduleRecord,
  setActual,
  updateBaseline,
  type RescheduleMove,
} from "@xos/data/schedule";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { done, failed, invalid, type ActionResult } from "@/components/work/action-result";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Schedule actions (A08): dependencies, actuals, baselines and timeline reschedules (A133). Row level security and the guards
 * of migrations 0310, 0350 and 0412 decide every write; a cycle, a link across projects or a change
 * to a locked baseline comes back as a refusal with its catalog sentence.
 */

async function context(org: string) {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  return ctx;
}

const DEPENDENCY_TYPES = [
  "Finish to Start",
  "Start to Start",
  "Finish to Finish",
  "Start to Finish",
] as const;

export async function addDependencyAction(
  org: string,
  input: { predecessorId: string; successorId: string; type: string; lagMinutes: number },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({
      predecessorId: z.uuid(),
      successorId: z.uuid(),
      type: z.enum(DEPENDENCY_TYPES),
      lagMinutes: z.number().int().min(-100_000).max(100_000),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await addDependency(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return failed(result.error);
  revalidatePath(`/${org}`, "layout");
  return done(null);
}

export async function removeDependencyAction(org: string, id: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(id).success) return invalid();
  const result = await removeDependency(ctx.viewer.db, id);
  if (!result.ok) return failed(result.error);
  revalidatePath(`/${org}`, "layout");
  return done(null);
}

/**
 * Moves or resizes a record on the timeline by whole days and pushes its successors
 * (app.reschedule_record, ADR 0111). A preview writes nothing and leaves the page as it is; a commit
 * writes every moved record in one transaction and refreshes the org's pages. The database refuses
 * cycles, locked records and impossible windows the same way in both modes.
 */
export async function rescheduleRecordAction(
  org: string,
  input: { recordId: string; startDays: number; endDays: number; commit: boolean },
): Promise<ActionResult<RescheduleMove[]>> {
  const ctx = await context(org);
  const days = z.number().int().min(-3660).max(3660);
  const parsed = z
    .object({ recordId: z.uuid(), startDays: days, endDays: days, commit: z.boolean() })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await rescheduleRecord(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  if (parsed.data.commit) revalidatePath(`/${org}`, "layout");
  return done(result.data);
}

const instant = z.iso.datetime({ offset: true }).nullable();

export async function setActualAction(
  org: string,
  input: { recordId: string; startedAt: string | null; finishedAt: string | null },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({ recordId: z.uuid(), startedAt: instant, finishedAt: instant })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await setActual(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return failed(result.error);
  revalidatePath(`/${org}`, "layout");
  return done(null);
}

/** Captures a baseline: creates it and locks it, which snapshots every dated record (journey 14). */
export async function captureBaselineAction(
  org: string,
  input: { projectId: string; name: string },
): Promise<ActionResult<{ id: string; captured: number }>> {
  const ctx = await context(org);
  const parsed = z
    .object({ projectId: z.uuid(), name: z.string().trim().min(1).max(100) })
    .safeParse(input);
  if (!parsed.success) return invalid("baselineName");
  const created = await createBaseline(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!created.ok) return failed(created.error);
  const locked = await lockBaseline(ctx.viewer.db, created.data.id);
  if (!locked.ok) {
    await updateBaseline(ctx.viewer.db, created.data.id, { deleted: true });
    return failed(locked.error);
  }
  revalidatePath(`/${org}`, "layout");
  return done({ id: created.data.id, captured: locked.data.captured });
}
