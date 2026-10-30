"use server";

import {
  addDependency,
  createBaseline,
  lockBaseline,
  placeRecord,
  removeDependency,
  rescheduleRecord,
  setActual,
  shiftRecords,
  updateBaseline,
  type RescheduleMove,
  type ShiftMove,
} from "@xos/data/schedule";
import { listRecords } from "@xos/data/work";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { done, failed, invalid, type ActionResult } from "@/components/work/action-result";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Schedule actions (A08): dependencies, actuals, baselines, timeline reschedules (A133), and minute
 * shifts and backlog placements (P8). Row level security and the guards
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
 * Moves or resizes a record on the timeline by whole days, and then whole minutes, and pushes its
 * successors (app.reschedule_record, ADR 0111). A preview writes nothing and leaves the page as it
 * is; a commit writes every moved record in one transaction and refreshes the org's pages. The
 * database refuses cycles, locked records and impossible windows the same way in both modes.
 */
export async function rescheduleRecordAction(
  org: string,
  input: {
    recordId: string;
    startDays: number;
    endDays: number;
    startMinutes?: number;
    endMinutes?: number;
    commit: boolean;
  },
): Promise<ActionResult<RescheduleMove[]>> {
  const ctx = await context(org);
  const days = z.number().int().min(-3660).max(3660);
  const minutes = z.number().int().min(-20_160).max(20_160).optional();
  const parsed = z
    .object({
      recordId: z.uuid(),
      startDays: days,
      endDays: days,
      startMinutes: minutes,
      endMinutes: minutes,
      commit: z.boolean(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const { startMinutes, endMinutes, ...rest } = parsed.data;
  const result = await rescheduleRecord(ctx.viewer.db, {
    ...rest,
    ...(startMinutes ? { startMinutes } : {}),
    ...(endMinutes ? { endMinutes } : {}),
  });
  if (!result.ok) return failed(result.error);
  if (parsed.data.commit) revalidatePath(`/${org}`, "layout");
  return done(result.data);
}

/** A preview or commit of a shift or placement, with the key and title of every record it moves. */
export interface MovePlan<M extends RescheduleMove = RescheduleMove> {
  readonly moves: readonly M[];
  /** "KEY Title" by record id, for naming the successors a change pushes. */
  readonly labels: Readonly<Record<string, string>>;
}

async function withLabels<M extends RescheduleMove>(
  ctx: Awaited<ReturnType<typeof context>>,
  moves: readonly M[],
): Promise<MovePlan<M>> {
  const labels: Record<string, string> = {};
  if (moves.length > 0) {
    const records = await listRecords(ctx.viewer.db, {
      orgId: ctx.org.id,
      ids: moves.map((m) => m.recordId),
      limit: moves.length,
    });
    if (records.ok) for (const r of records.data) labels[r.id] = `${r.key} ${r.title}`;
  }
  return { moves, labels };
}

/**
 * Shifts the selected records by the same minutes and pushes their successors outside the
 * selection (app.shift_records, P8). A preview writes nothing; a commit writes every moved record
 * in one transaction. Undated and Canceled records in the selection stay where they are.
 */
export async function shiftRecordsAction(
  org: string,
  input: { recordIds: string[]; minutes: number; commit: boolean },
): Promise<ActionResult<MovePlan<ShiftMove>>> {
  const ctx = await context(org);
  const parsed = z
    .object({
      recordIds: z.array(z.uuid()).min(1).max(500),
      minutes: z
        .number()
        .int()
        .min(-10_080)
        .max(10_080)
        .refine((n) => n !== 0),
      commit: z.boolean(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid("shiftMinutes");
  const result = await shiftRecords(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  if (parsed.data.commit) revalidatePath(`/${org}`, "layout");
  return done(await withLabels(ctx, result.data));
}

/**
 * Places an undated record from the schedule's Unscheduled list on a day of its project
 * (app.place_record, P8) and pushes its successors by whole days. A preview writes nothing.
 */
export async function placeRecordAction(
  org: string,
  input: { recordId: string; day: string; commit: boolean },
): Promise<ActionResult<MovePlan>> {
  const ctx = await context(org);
  const parsed = z
    .object({ recordId: z.uuid(), day: z.iso.date(), commit: z.boolean() })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await placeRecord(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  if (parsed.data.commit) revalidatePath(`/${org}`, "layout");
  return done(await withLabels(ctx, result.data));
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
