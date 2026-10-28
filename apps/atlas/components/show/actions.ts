"use server";

import {
  addCue,
  callCue,
  CUE_CALL_KINDS,
  createCallSheet,
  createRunOfShow,
  deleteRunOfShow,
  deleteSheet,
  getRunOfShow,
  linkCueToEngagement,
  moveCue,
  moveCueTo,
  publishSheet,
  removeCue,
  restoreSheet,
  saveCueCalls,
  saveDaySheet,
  shiftCuePlan,
  standbyCue,
  unlinkCueEngagement,
  updateCue,
  updateRunOfShow,
} from "@xos/data/show";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { done, failed, invalid, type ActionResult } from "@/components/work/action-result";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Show actions (A08): running orders, cues, live cue calls, day sheets and call sheets. Calling a
 * cue goes through app.call_cue (show.cue.call, once, stamped by the database); publishing a sheet
 * needs show.call_sheet.publish. Standby, moves, nudges and department calls go through their
 * definer functions, one transaction each (ADR 0131). Refusals come back as catalog keys under
 * `work.errors`.
 */

async function context(org: string) {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  return ctx;
}

function refresh(org: string) {
  revalidatePath(`/${org}`, "layout");
}

const id = z.uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.iso.datetime({ offset: true }).nullable().optional();

export async function createRunAction(
  org: string,
  input: { projectId: string; name: string; showDate: string; scopeNodeId: string | null },
): Promise<ActionResult<{ id: string }>> {
  const ctx = await context(org);
  const parsed = z
    .object({
      projectId: id,
      name: z.string().trim().min(1).max(200),
      showDate: day,
      scopeNodeId: id.nullable(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await createRunOfShow(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(result.data);
}

export async function updateRunAction(
  org: string,
  runId: string,
  input: { name: string; showDate: string; curfewAt?: string | null },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({ name: z.string().trim().min(1).max(200), showDate: day, curfewAt: instant })
    .safeParse(input);
  if (!id.safeParse(runId).success || !parsed.success) return invalid();
  const { curfewAt, ...rest } = parsed.data;
  const result = await updateRunOfShow(ctx.viewer.db, runId, {
    ...rest,
    ...(curfewAt === undefined ? {} : { curfewAt }),
  });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function deleteRunAction(org: string, runId: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(runId).success) return invalid();
  const result = await deleteRunOfShow(ctx.viewer.db, runId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function addCueAction(
  org: string,
  input: {
    runOfShowId: string;
    label: string;
    plannedAt: string | null;
    durationSeconds: number | null;
    startTbc?: boolean;
  },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({
      runOfShowId: id,
      label: z.string().trim().min(1).max(200),
      plannedAt: instant,
      durationSeconds: z.number().int().min(0).max(86_400).nullable(),
      startTbc: z.boolean().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid("cueLabel");
  const run = await getRunOfShow(ctx.viewer.db, parsed.data.runOfShowId);
  if (!run.ok) return failed(run.error);
  const result = await addCue(ctx.viewer.db, {
    orgId: ctx.org.id,
    projectId: run.data.projectId,
    runOfShowId: parsed.data.runOfShowId,
    label: parsed.data.label,
    plannedAt: parsed.data.plannedAt ?? null,
    durationSeconds: parsed.data.durationSeconds,
    startTbc: parsed.data.startTbc ?? false,
  });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function updateCueAction(
  org: string,
  cueId: string,
  input: {
    label: string;
    plannedAt: string | null;
    durationSeconds: number | null;
    startTbc?: boolean;
  },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({
      label: z.string().trim().min(1).max(200),
      plannedAt: instant,
      durationSeconds: z.number().int().min(0).max(86_400).nullable(),
      startTbc: z.boolean().optional(),
    })
    .safeParse(input);
  if (!id.safeParse(cueId).success || !parsed.success) return invalid("cueLabel");
  const result = await updateCue(ctx.viewer.db, cueId, {
    label: parsed.data.label,
    plannedAt: parsed.data.plannedAt ?? null,
    durationSeconds: parsed.data.durationSeconds,
    ...(parsed.data.startTbc === undefined ? {} : { startTbc: parsed.data.startTbc }),
  });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function moveCueAction(
  org: string,
  runId: string,
  cueId: string,
  direction: "up" | "down",
): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(runId).success || !id.safeParse(cueId).success) return invalid();
  const result = await moveCue(ctx.viewer.db, runId, cueId, direction === "up" ? "up" : "down");
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

/**
 * Moves a cue to a 1-based place among its running order's live cues (app.move_cue): one
 * transaction. The database refuses a called cue (cue_move_called) and a place at or before the
 * last called cue (cue_move_before_called).
 */
export async function moveCueToAction(
  org: string,
  runId: string,
  cueId: string,
  position: number,
): Promise<ActionResult<{ position: number }>> {
  const ctx = await context(org);
  if (
    !id.safeParse(runId).success ||
    !id.safeParse(cueId).success ||
    !z.number().int().min(1).max(10_000).safeParse(position).success
  ) {
    return invalid();
  }
  const result = await moveCueTo(ctx.viewer.db, cueId, position);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(result.data);
}

/** The departments a cue's calls go to, from app.cue_call_kind (never written out again). */
const cueCallKind = z.enum(CUE_CALL_KINDS);

/**
 * Saves a cue's department calls in one call (app.save_cue_calls): an instruction per department,
 * or null to clear it. Needs show.run_of_show.write; an unknown department is refused.
 */
export async function saveCueCallsAction(
  org: string,
  cueId: string,
  calls: Record<string, string | null>,
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .partialRecord(cueCallKind, z.string().max(2000).nullable())
    .safeParse(calls);
  if (!id.safeParse(cueId).success || !parsed.success) return invalid("cueCall");
  const result = await saveCueCalls(ctx.viewer.db, cueId, parsed.data);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

/**
 * Puts a cue on standby, or clears the standby when `cueId` is null (app.standby_cue): followers
 * see "Standby" through Realtime. Needs show.cue.call; a called cue is refused.
 */
export async function standbyCueAction(
  org: string,
  runId: string,
  cueId: string | null,
): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(runId).success || (cueId !== null && !id.safeParse(cueId).success)) {
    return invalid();
  }
  const result = await standbyCue(ctx.viewer.db, runId, cueId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

/**
 * Nudges the planned time of every uncalled cue of a running order by `seconds`, between -3600 and
 * 3600 and not 0 (app.shift_cue_plan). The caller (show.cue.call) or an editor may nudge.
 */
export async function shiftCuePlanAction(
  org: string,
  runId: string,
  seconds: number,
): Promise<ActionResult<{ count: number }>> {
  const ctx = await context(org);
  const parsed = z
    .number()
    .int()
    .min(-3600)
    .max(3600)
    .refine((n) => n !== 0)
    .safeParse(seconds);
  if (!id.safeParse(runId).success || !parsed.success) return invalid();
  const result = await shiftCuePlan(ctx.viewer.db, runId, parsed.data);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(result.data);
}

/**
 * Marks a cue as an artist's set time (Set for). The database refuses a non-Artist engagement
 * (engagement_cue_artist_only) and another project's cue (engagement_cue_project_mismatch); a cue
 * already set for the artist comes back as a conflict.
 */
export async function linkCueAction(
  org: string,
  cueId: string,
  engagementId: string,
): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(cueId).success || !id.safeParse(engagementId).success) return invalid();
  const result = await linkCueToEngagement(ctx.viewer.db, { cueId, engagementId });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

/** Removes a cue's set time. */
export async function unlinkCueAction(org: string, engagementCueId: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(engagementCueId).success) return invalid();
  const result = await unlinkCueEngagement(ctx.viewer.db, engagementCueId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function removeCueAction(org: string, cueId: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(cueId).success) return invalid();
  const result = await removeCue(ctx.viewer.db, cueId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

/** Calls a cue now (journey 15). */
export async function callCueAction(org: string, cueId: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(cueId).success) return invalid();
  const result = await callCue(ctx.viewer.db, cueId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function saveDaySheetAction(
  org: string,
  input: { projectId: string; day: string; body: string },
): Promise<ActionResult<{ id: string }>> {
  const ctx = await context(org);
  const parsed = z.object({ projectId: id, day, body: z.string().max(20_000) }).safeParse(input);
  if (!parsed.success) return invalid();
  const result = await saveDaySheet(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(result.data);
}

export async function createCallSheetAction(
  org: string,
  input: { projectId: string; day: string },
): Promise<ActionResult<{ id: string }>> {
  const ctx = await context(org);
  const parsed = z.object({ projectId: id, day }).safeParse(input);
  if (!parsed.success) return invalid();
  const result = await createCallSheet(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(result.data);
}

export async function publishSheetAction(
  org: string,
  table: "day_sheets" | "call_sheets",
  sheetId: string,
): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(sheetId).success || (table !== "day_sheets" && table !== "call_sheets"))
    return invalid();
  const result = await publishSheet(ctx.viewer.db, table, sheetId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function deleteSheetAction(
  org: string,
  table: "day_sheets" | "call_sheets",
  sheetId: string,
): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(sheetId).success || (table !== "day_sheets" && table !== "call_sheets"))
    return invalid();
  const result = await deleteSheet(ctx.viewer.db, table, sheetId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

/** Restores a sheet from Trash: the Undo of deleteSheetAction (Section 11.7). */
export async function restoreSheetAction(
  org: string,
  table: "day_sheets" | "call_sheets",
  sheetId: string,
): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(sheetId).success || (table !== "day_sheets" && table !== "call_sheets"))
    return invalid();
  const result = await restoreSheet(ctx.viewer.db, table, sheetId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}
