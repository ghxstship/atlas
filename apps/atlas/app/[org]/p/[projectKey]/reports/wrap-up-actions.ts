"use server";

import {
  addDebriefItem,
  completeProjectDebrief,
  DEBRIEF_AREAS,
  DEBRIEF_ITEM_KINDS,
  DEBRIEF_RULES,
  deleteDebriefItem,
  MAX_DEBRIEF_POINT,
  MAX_MANAGEMENT_SUMMARY,
  reopenProjectDebrief,
  restoreDebriefItem,
  saveProjectDebrief,
  updateDebriefItem,
} from "@xos/data/debriefs";
import type { DataError, Result } from "@xos/data/result";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getProjectContextFor, type ProjectContext } from "@/lib/projects/context";

/**
 * The project wrap-up on the Reports tab (B7, migration 2965, ADR 0146 decisions 5 and 6): save the management
 * summary (with the Aurora request it was drafted from, when it was), add, edit and delete debrief points with Undo,
 * and complete or reopen the debrief. app.save_project_debrief, the guards and row level security decide; a refusal
 * comes back as its rule, shown from `reports.wrapUp.errors`.
 */

export type WrapUpResult =
  { readonly ok: true; readonly id?: string } | { readonly ok: false; readonly key: string };

const KNOWN = new Set<string>(DEBRIEF_RULES);

function keyOf(error: DataError): string {
  if (error.kind === "refusal") return KNOWN.has(error.rule) ? error.rule : "refused";
  if (error.kind === "not-found") return "notFound";
  if (error.kind === "invalid") return "invalid";
  return "unexpected";
}

const Where = z.object({ org: z.string().min(1).max(100), projectKey: z.string().min(1).max(40) });

async function run(
  raw: unknown,
  act: (ctx: ProjectContext) => Promise<Result<unknown>>,
): Promise<WrapUpResult> {
  const where = Where.safeParse(raw);
  if (!where.success) return { ok: false, key: "invalid" };
  const ctx = await getProjectContextFor(where.data);
  if (!ctx) return { ok: false, key: "notFound" };
  const result = await act(ctx);
  if (!result.ok) return { ok: false, key: keyOf(result.error) };
  revalidatePath(`/${where.data.org}/p/${where.data.projectKey}/reports`);
  const id = (result.data as { id?: unknown } | null)?.id;
  return typeof id === "string" ? { ok: true, id } : { ok: true };
}

const Summary = Where.extend({
  summary: z.string().max(MAX_MANAGEMENT_SUMMARY + 1000),
  aiRequestId: z.uuid().nullable(),
});

/** Saves the management summary; blank clears it. Nothing is written by "Use as management summary" alone. */
export async function saveDebriefSummaryAction(raw: unknown): Promise<WrapUpResult> {
  const parsed = Summary.safeParse(raw);
  if (!parsed.success) return { ok: false, key: "invalid" };
  return run(parsed.data, (ctx) =>
    saveProjectDebrief(ctx.org.viewer.db, {
      projectId: ctx.project.id,
      summary: parsed.data.summary,
      aiRequestId: parsed.data.aiRequestId,
    }),
  );
}

const Point = Where.extend({
  id: z.uuid().nullable(),
  area: z.enum(DEBRIEF_AREAS),
  kind: z.enum(DEBRIEF_ITEM_KINDS),
  body: z.string().trim().min(1).max(MAX_DEBRIEF_POINT),
  ownerMembershipId: z.uuid().nullable(),
});

/** Adds a point (starting the debrief when there is none) or changes one. */
export async function saveDebriefPointAction(raw: unknown): Promise<WrapUpResult> {
  const parsed = Point.safeParse(raw);
  if (!parsed.success) return { ok: false, key: "invalid" };
  const p = parsed.data;
  const input = {
    area: p.area,
    kind: p.kind,
    body: p.body,
    ownerMembershipId: p.ownerMembershipId,
  };
  return run(p, async (ctx) => {
    if (p.id) return updateDebriefItem(ctx.org.viewer.db, p.id, input);
    const debrief = await saveProjectDebrief(ctx.org.viewer.db, { projectId: ctx.project.id });
    if (!debrief.ok) return debrief;
    return addDebriefItem(ctx.org.viewer.db, debrief.data.id, input);
  });
}

const Target = Where.extend({ id: z.uuid() });

/** Moves a point to Trash; restoreDebriefPointAction is its Undo. */
export async function deleteDebriefPointAction(raw: unknown): Promise<WrapUpResult> {
  const parsed = Target.safeParse(raw);
  if (!parsed.success) return { ok: false, key: "invalid" };
  return run(parsed.data, (ctx) => deleteDebriefItem(ctx.org.viewer.db, parsed.data.id));
}

export async function restoreDebriefPointAction(raw: unknown): Promise<WrapUpResult> {
  const parsed = Target.safeParse(raw);
  if (!parsed.success) return { ok: false, key: "invalid" };
  return run(parsed.data, (ctx) => restoreDebriefItem(ctx.org.viewer.db, parsed.data.id));
}

export async function completeDebriefAction(raw: unknown): Promise<WrapUpResult> {
  const parsed = Target.safeParse(raw);
  if (!parsed.success) return { ok: false, key: "invalid" };
  return run(parsed.data, (ctx) => completeProjectDebrief(ctx.org.viewer.db, parsed.data.id));
}

export async function reopenDebriefAction(raw: unknown): Promise<WrapUpResult> {
  const parsed = Target.safeParse(raw);
  if (!parsed.success) return { ok: false, key: "invalid" };
  return run(parsed.data, (ctx) => reopenProjectDebrief(ctx.org.viewer.db, parsed.data.id));
}
