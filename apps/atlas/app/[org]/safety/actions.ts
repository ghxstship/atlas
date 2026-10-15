"use server";

import {
  addInspectionItem,
  createInspection,
  createInspectionTemplate,
  generatePermitRequirements,
  recordInspectionResult,
  renameInspectionTemplate,
  setSafetyArchived,
  signOffInspection,
  swapInspectionItems,
  trackPermitRequirement,
  transitionRecord,
  updateInspectionItem,
  updatePermitDetails,
  type SafetyTable,
} from "@xos/data/safety-permits";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { errorKey, text, type ActionState } from "@/components/places/kit/action-state";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Safety actions for the permit engine and inspections. Each resolves the viewer's org context again
 * (404 when it is gone), validates the form, and calls the repository; the RPCs of migrations 0353,
 * 0420 and 0421 and the record lifecycle decide every write, and their refusals come back as catalog
 * keys under `places.errors` (the shared Places and Safety error copy).
 */

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

function refresh(slug: string) {
  revalidatePath(`/${slug}/safety`, "layout");
  revalidatePath(`/${slug}/p`, "layout");
}

const uuid = z.uuid();

// Permits ------------------------------------------------------------------------------------------

export async function generatePermitsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const projectId = uuid.safeParse(form.get("projectId"));
  if (!projectId.success) return { fieldErrors: { projectId: "project" } };
  const result = await generatePermitRequirements(ctx.viewer.db, projectId.data);
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: String(result.data.added) };
}

export async function trackPermitAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const result = await trackPermitRequirement(ctx.viewer.db, id.data);
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: result.data.recordId };
}

export async function transitionPermitAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const recordId = uuid.safeParse(form.get("recordId"));
  const expected = text(form, "expected");
  const next = text(form, "next");
  const reason = text(form, "reason");
  const fieldErrors: Record<string, string> = {};
  if (!next) fieldErrors["next"] = "state";
  if (!reason) fieldErrors["reason"] = "reason";
  const blocker = text(form, "blocker");
  const replanReason = text(form, "replanReason");
  if (next === "Blocked" && !blocker) fieldErrors["blocker"] = "blocker";
  if (next === "Deferred" && !replanReason) fieldErrors["replanReason"] = "replanReason";
  if (!recordId.success || !expected) return { error: "notFound" };
  if (Object.keys(fieldErrors).length > 0 || !next || !reason) return { fieldErrors };
  const result = await transitionRecord(ctx.viewer.db, {
    recordId: recordId.data,
    expected,
    next,
    reason,
    blocker,
    replanReason,
  });
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: recordId.data };
}

/** The board's move: the reason is the move itself; a move to Blocked or Deferred is refused there. */
export async function movePermitAction(
  org: string,
  recordId: string,
  from: string,
  to: string,
  reason: string,
): Promise<ActionState> {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  if (!uuid.safeParse(recordId).success) return { error: "notFound" };
  const result = await transitionRecord(ctx.viewer.db, {
    recordId,
    expected: from,
    next: to,
    reason,
  });
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true };
}

const isoDate = z.iso.date();

export async function permitDetailsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const recordId = uuid.safeParse(form.get("recordId"));
  if (!recordId.success) return { error: "notFound" };
  const issued = text(form, "issuedOn");
  const expires = text(form, "expiresOn");
  const fieldErrors: Record<string, string> = {};
  if (issued !== null && !isoDate.safeParse(issued).success) fieldErrors["issuedOn"] = "date";
  if (expires !== null && !isoDate.safeParse(expires).success) fieldErrors["expiresOn"] = "date";
  if (issued !== null && expires !== null && expires < issued)
    fieldErrors["expiresOn"] = "validity";
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  const result = await updatePermitDetails(ctx.viewer.db, recordId.data, {
    permitIdentifier: text(form, "permitIdentifier"),
    issuedAt: issued === null ? null : `${issued}T12:00:00Z`,
    expiresAt: expires === null ? null : `${expires}T12:00:00Z`,
  });
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: recordId.data };
}

// Archive and restore -----------------------------------------------------------------------------------

const ARCHIVABLE: readonly SafetyTable[] = [
  "inspection_templates",
  "inspection_items",
  "inspections",
];

export async function setSafetyArchivedAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const table = text(form, "table") as SafetyTable | null;
  const id = uuid.safeParse(form.get("id"));
  if (!table || !ARCHIVABLE.includes(table) || !id.success) return { error: "notFound" };
  const result = await setSafetyArchived(
    ctx.viewer.db,
    table,
    id.data,
    form.get("archived") === "true",
  );
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: id.data };
}

// Inspection templates ------------------------------------------------------------------------------------

export async function saveTemplateAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const name = text(form, "name");
  if (!name || name.length > 200) return { fieldErrors: { name: "name" } };
  const id = text(form, "id");
  const result =
    id === null
      ? await createInspectionTemplate(ctx.viewer.db, ctx.org.id, name)
      : await renameInspectionTemplate(ctx.viewer.db, id, name);
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: result.data.id };
}

export async function saveItemAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const prompt = text(form, "prompt");
  if (!prompt || prompt.length > 500) return { fieldErrors: { prompt: "prompt" } };
  const critical = form.get("critical") === "on";
  const id = text(form, "id");
  if (id !== null) {
    const result = await updateInspectionItem(ctx.viewer.db, id, { prompt, critical });
    if (!result.ok) return { error: errorKey(result.error) };
    refresh(ctx.org.slug);
    return { ok: true, id: result.data.id };
  }
  const templateId = uuid.safeParse(form.get("templateId"));
  const position = Number(text(form, "position"));
  if (!templateId.success || !Number.isInteger(position) || position < 1)
    return { error: "notFound" };
  const result = await addInspectionItem(ctx.viewer.db, {
    templateId: templateId.data,
    prompt,
    critical,
    position,
  });
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: result.data.id };
}

/** Moves an item one place up or down by swapping it with its neighbor (the keyboard reorder path). */
export async function moveItemAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const a = { id: text(form, "id") ?? "", position: Number(text(form, "position")) };
  const b = { id: text(form, "otherId") ?? "", position: Number(text(form, "otherPosition")) };
  const parking = Number(text(form, "parking"));
  if (
    !uuid.safeParse(a.id).success ||
    !uuid.safeParse(b.id).success ||
    !Number.isInteger(parking)
  ) {
    return { error: "notFound" };
  }
  const result = await swapInspectionItems(ctx.viewer.db, a, b, parking);
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true };
}

// Inspections -------------------------------------------------------------------------------------------------

export async function startInspectionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const projectId = uuid.safeParse(form.get("projectId"));
  const templateId = uuid.safeParse(form.get("templateId"));
  const when = text(form, "inspectedAt");
  const fieldErrors: Record<string, string> = {};
  if (!projectId.success) fieldErrors["projectId"] = "project";
  if (!templateId.success) fieldErrors["templateId"] = "template";
  const at = when === null ? new Date() : new Date(when);
  if (Number.isNaN(at.getTime())) fieldErrors["inspectedAt"] = "date";
  if (Object.keys(fieldErrors).length > 0 || !projectId.success || !templateId.success) {
    return { fieldErrors };
  }
  const result = await createInspection(ctx.viewer.db, {
    projectId: projectId.data,
    templateId: templateId.data,
    inspectedAt: at.toISOString(),
  });
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: result.data.id };
}

export async function recordResultAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const inspectionId = uuid.safeParse(form.get("inspectionId"));
  const itemId = uuid.safeParse(form.get("itemId"));
  const resultEnumId = text(form, "resultEnumId");
  if (!inspectionId.success || !itemId.success) return { error: "notFound" };
  if (!resultEnumId) return { fieldErrors: { resultEnumId: "result" } };
  const result = await recordInspectionResult(ctx.viewer.db, {
    inspectionId: inspectionId.data,
    itemId: itemId.data,
    resultEnumId,
    note: text(form, "note"),
  });
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: result.data.id };
}

export async function signOffAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const result = await signOffInspection(ctx.viewer.db, id.data);
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: id.data };
}
