"use server";

import {
  addCue,
  callCue,
  createCallSheet,
  createRunOfShow,
  deleteRunOfShow,
  deleteSheet,
  getRunOfShow,
  moveCue,
  publishSheet,
  removeCue,
  saveDaySheet,
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
 * needs show.call_sheet.publish. Refusals come back as catalog keys under `work.errors`.
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
  input: { name: string; showDate: string },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({ name: z.string().trim().min(1).max(200), showDate: day })
    .safeParse(input);
  if (!id.safeParse(runId).success || !parsed.success) return invalid();
  const result = await updateRunOfShow(ctx.viewer.db, runId, parsed.data);
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
  },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({
      runOfShowId: id,
      label: z.string().trim().min(1).max(200),
      plannedAt: instant,
      durationSeconds: z.number().int().min(0).max(86_400).nullable(),
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
  });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function updateCueAction(
  org: string,
  cueId: string,
  input: { label: string; plannedAt: string | null; durationSeconds: number | null },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({
      label: z.string().trim().min(1).max(200),
      plannedAt: instant,
      durationSeconds: z.number().int().min(0).max(86_400).nullable(),
    })
    .safeParse(input);
  if (!id.safeParse(cueId).success || !parsed.success) return invalid("cueLabel");
  const result = await updateCue(ctx.viewer.db, cueId, {
    label: parsed.data.label,
    plannedAt: parsed.data.plannedAt ?? null,
    durationSeconds: parsed.data.durationSeconds,
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
