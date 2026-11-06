"use server";

import type { DataError } from "@xos/data";
import {
  assignRecordToPosition,
  fillPosition,
  listPositions,
  listRecordPositions,
  markNoShow,
  respondReconfirmation,
  retirePosition,
  savePosition,
  unassignRecordFromPosition,
  vacatePosition,
  withdrawNoShow,
} from "@xos/data/crew";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { CrewActionState } from "@/lib/crew/action-state";
import { errorMessage } from "@/lib/crew/errors";
import { getOrgContext } from "@/lib/shell/context";
import { getTranslate, type Translate } from "@/lib/shell/translate";

/**
 * Crew coverage actions (B9, migrations 2981, 2982 and 2984; ADR 0148): no-shows, "Still coming?" answers from the
 * shift's record, project positions and the records assigned to them. Each resolves the viewer's org context again and
 * writes as the viewer, so row level security and the RPCs decide; a refusal comes back as a sentence, beside the field
 * it is about.
 */

type State = CrewActionState;

const uuid = z.uuid();
const reason = z.string().trim().min(1).max(500);

async function context(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return { ctx, db: ctx.viewer.db, t: await getTranslate() };
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function refresh(slug: string): void {
  revalidatePath(`/${slug}/crew`, "layout");
  revalidatePath(`/${slug}/p`, "layout");
}

function failed(t: Translate, error: DataError, field?: string): State {
  const message = errorMessage(t, error);
  return {
    error: message,
    ...(error.kind === "refusal" ? { rule: error.rule } : {}),
    ...(field ? { fieldErrors: { [field]: message } } : {}),
  };
}

function invalid(t: Translate, field: string, key: string): State {
  return { error: t("crew.errors.fixFields"), fieldErrors: { [field]: t(key) } };
}

// No-shows ----------------------------------------------------------------------------------------------------------

/** Marks the worker of a started shift as a no-show. The client id comes with the form, so a retry is recognized. */
export async function markNoShowAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ noShowId: uuid, shiftId: uuid, reason })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, "reason", "crew.noShow.errors.reason");
  const result = await markNoShow(db, {
    id: parsed.data.noShowId,
    shiftId: parsed.data.shiftId,
    reason: parsed.data.reason,
    openReplacement: text(form, "openReplacement") === "yes",
  });
  if (!result.ok) return failed(t, result.error, "reason");
  refresh(ctx.org.slug);
  return { ok: true };
}

export async function withdrawNoShowAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z.object({ id: uuid, reason }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, "reason", "crew.errors.reason");
  const result = await withdrawNoShow(db, parsed.data.id, parsed.data.reason);
  if (!result.ok) return failed(t, result.error, "reason");
  refresh(ctx.org.slug);
  return { ok: true };
}

// Still coming? -----------------------------------------------------------------------------------------------------

export async function confirmComingAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return { error: t("crew.errors.notFound") };
  const result = await respondReconfirmation(db, id.data, true);
  if (!result.ok) return failed(t, result.error);
  refresh(ctx.org.slug);
  return { ok: true };
}

export async function declineComingAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return { error: t("crew.errors.notFound") };
  const result = await respondReconfirmation(db, id.data, false, text(form, "reason").trim() || null);
  if (!result.ok) return failed(t, result.error);
  refresh(ctx.org.slug);
  return { ok: true };
}

// Positions ---------------------------------------------------------------------------------------------------------

/** Creates a position, or edits one when `id` comes with the form. */
export async function savePositionAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ projectId: uuid, title: z.string().trim().min(1).max(120) })
    .safeParse({ projectId: form.get("projectId"), title: form.get("title") });
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]);
      fields[key] = t(key === "projectId" ? "crew.errors.project" : "crew.positions.errors.title");
    }
    return { error: t("crew.errors.fixFields"), fieldErrors: fields };
  }
  const id = uuid.safeParse(form.get("id"));
  const engagement = uuid.safeParse(form.get("engagementId"));
  const role = text(form, "roleCode");
  const result = await savePosition(db, ctx.org.id, {
    ...(id.success ? { id: id.data } : {}),
    projectId: parsed.data.projectId,
    title: parsed.data.title,
    roleCode: role === "" ? null : role,
    engagementId: engagement.success ? engagement.data : null,
  });
  if (!result.ok) {
    if (result.error.kind === "conflict") {
      return invalid(t, "title", "crew.positions.errors.duplicate");
    }
    return failed(
      t,
      result.error,
      result.error.kind === "refusal" && result.error.rule.startsWith("position_engagement")
        ? "engagementId"
        : undefined,
    );
  }
  refresh(ctx.org.slug);
  return { ok: true };
}

/**
 * Fills a position with the one holder its picker names (`m:<membership>` or `r:<roster entry>`). What filling did goes
 * on the page as a notice: the drawer leaves after a refresh, so a confirmation inside it would never be seen.
 */
export async function fillPositionAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return { error: t("crew.errors.notFound") };
  const holder = /^(m|r):([0-9a-f-]{36})$/.exec(text(form, "holder"));
  if (!holder) return invalid(t, "holder", "crew.positions.errors.holder");
  const result = await fillPosition(
    db,
    id.data,
    holder[1] === "m" ? { membershipId: holder[2] as string } : { rosterEntryId: holder[2] as string },
  );
  if (!result.ok) return failed(t, result.error, "holder");
  refresh(ctx.org.slug);
  const back = new URL(text(form, "back") || `/${ctx.org.slug}/crew/positions`, "http://local");
  back.searchParams.delete("fill");
  back.searchParams.set("filled", String(result.data.shiftsFilled));
  back.searchParams.set("skipped", String(result.data.shiftsSkipped.length));
  back.searchParams.set("warned", String(result.data.policyWarnings.length));
  back.searchParams.set("records", String(result.data.recordsResolved));
  return { ok: true, redirect: `${back.pathname}${back.search}` };
}

export async function vacatePositionAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z.object({ id: uuid, reason }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, "reason", "crew.errors.reason");
  const result = await vacatePosition(db, parsed.data.id, parsed.data.reason);
  if (!result.ok) return failed(t, result.error, "reason");
  refresh(ctx.org.slug);
  return { ok: true };
}

export async function trashPositionAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return { error: t("crew.errors.notFound") };
  const result = await retirePosition(db, id.data);
  if (!result.ok) return failed(t, result.error);
  refresh(ctx.org.slug);
  return { ok: true, redirect: text(form, "back") || `/${ctx.org.slug}/crew/positions` };
}

// Records on a position ---------------------------------------------------------------------------------------------

export interface RecordPositionsResult {
  readonly assigned: readonly { readonly id: string; readonly title: string }[];
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

/** What the record's position panel shows, read when it opens, so the record page itself reads nothing more. */
export async function recordPositionsAction(
  org: string,
  recordId: string,
  projectId: string,
): Promise<RecordPositionsResult | null> {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  if (!uuid.safeParse(recordId).success || !uuid.safeParse(projectId).success) return null;
  const db = ctx.viewer.db;
  const [assigned, positions] = await Promise.all([
    listRecordPositions(db, recordId),
    listPositions(db, { orgId: ctx.org.id, projectId }),
  ]);
  if (!assigned.ok || !positions.ok) return null;
  const taken = new Set(assigned.data.map((a) => a.positionId));
  return {
    assigned: assigned.data.map((a) => ({ id: a.assignmentId, title: a.title })),
    options: positions.data
      .filter((p) => !taken.has(p.id))
      .map((p) => ({ value: p.id, label: p.title })),
  };
}

export async function assignRecordToPositionAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ recordId: uuid, positionId: uuid })
    .safeParse({ recordId: form.get("recordId"), positionId: form.get("positionId") });
  if (!parsed.success) return invalid(t, "positionId", "crew.positions.errors.position");
  const result = await assignRecordToPosition(
    db,
    ctx.org.id,
    parsed.data.recordId,
    parsed.data.positionId,
  );
  if (!result.ok) {
    if (result.error.kind === "conflict") {
      return invalid(t, "positionId", "crew.positions.errors.alreadyAssigned");
    }
    return failed(t, result.error, "positionId");
  }
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

export async function unassignRecordFromPositionAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return { error: t("crew.errors.notFound") };
  const result = await unassignRecordFromPosition(db, id.data);
  if (!result.ok) return failed(t, result.error);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}
