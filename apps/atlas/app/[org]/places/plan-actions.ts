"use server";

import { uploadAttachment } from "@xos/data/attachments";
import { postComment, setThreadResolved } from "@xos/data/comments";
import { pointAnchor, metersToFeet, type PlanPoint } from "@xos/data/places-geometry";
import {
  PLACE_SPEC_FIELDS,
  providePlaceSpecs,
  reorderVenueLevels,
  saveSitePlanShape,
  savePlaceSpec,
  saveVenueLevel,
  setPlaceArchived,
  setSitePlanCalibration,
  setSitePlanDrawing,
  SHAPE_KINDS,
  SHAPE_TONES,
  SITE_PLAN_STATES,
  transitionSitePlan,
  type PlaceSpecInput,
  type SitePlanShapeKind,
  type SitePlanShapeTone,
  type SitePlanState,
} from "@xos/data/places";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { errorKey, text, type ActionState } from "@/components/places/kit/action-state";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Site plan depth actions (B1, ADR 0140): plan states, the stored drawing, the scale, shapes, point notes, venue levels
 * and place specs. Each resolves the viewer's org context again (404 when it is gone) and validates the form; row level
 * security, the RPCs and the guards of migrations 2900 to 2905 decide every write, and their refusals come back as
 * catalog keys under `places.errors`.
 */

async function contextFor(org: unknown) {
  const ctx = typeof org === "string" ? await getOrgContext(org) : null;
  if (!ctx) notFound();
  return ctx;
}

function refresh(slug: string) {
  revalidatePath(`/${slug}/places`, "layout");
}

const uuid = z.uuid();
const MAX_DRAWING_BYTES = 50 * 1024 * 1024;
const DRAWING_TYPES = new Set(["image/png", "image/jpeg", "application/pdf"]);

// States ---------------------------------------------------------------------------------------------

export async function transitionSitePlanAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form.get("org"));
  const id = uuid.safeParse(form.get("id"));
  const expected = text(form, "expected") as SitePlanState | null;
  const next = text(form, "next") as SitePlanState | null;
  const reason = text(form, "reason");
  if (!reason || reason.length > 500) return { fieldErrors: { reason: "reason" } };
  if (
    !id.success ||
    !expected ||
    !next ||
    !SITE_PLAN_STATES.includes(expected) ||
    !SITE_PLAN_STATES.includes(next)
  ) {
    return { error: "notFound" };
  }
  const result = await transitionSitePlan(ctx.viewer.db, { id: id.data, expected, next, reason });
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: id.data };
}

// Drawings -------------------------------------------------------------------------------------------

export type PlanFileResult =
  | { readonly ok: true; readonly versionId: string; readonly scanStatus: string }
  | { readonly ok: false; readonly error: string };

/** Uploads one drawing file (the drawing, or a PDF page's PNG) as its own attachment on the plan. */
export async function uploadPlanFileAction(form: FormData): Promise<PlanFileResult> {
  const ctx = await contextFor(form.get("org"));
  const id = uuid.safeParse(form.get("sitePlanId"));
  const file = form.get("file");
  if (!id.success) return { ok: false, error: "notFound" };
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "fileRequired" };
  if (file.size > MAX_DRAWING_BYTES) return { ok: false, error: "fileTooLarge" };
  if (!DRAWING_TYPES.has(file.type)) return { ok: false, error: "site_plan_drawing_type" };
  const result = await uploadAttachment(ctx.viewer.db, {
    subject: { table: "app.site_plans", id: id.data },
    file,
    filename: file.name,
  });
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  return { ok: true, versionId: result.data.versionId, scanStatus: result.data.scanStatus };
}

/** The scan state of uploaded drawing files, for the "Checking the file for viruses" step. */
export async function planFileStatusAction(
  org: string,
  versionIds: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const ctx = await contextFor(org);
  const ids = versionIds.filter((v) => uuid.safeParse(v).success);
  if (ids.length === 0) return {};
  const { data } = await ctx.viewer.db
    .from("attachment_versions")
    .select("id, scan_status")
    .in("id", ids);
  return Object.fromEntries((data ?? []).map((v) => [v.id, v.scan_status]));
}

export async function setDrawingAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form.get("org"));
  const id = uuid.safeParse(form.get("sitePlanId"));
  const drawing = uuid.safeParse(form.get("drawingVersionId"));
  const rasterRaw = text(form, "rasterVersionId");
  const raster = rasterRaw ? uuid.safeParse(rasterRaw) : null;
  const pageRaw = text(form, "page");
  const page = pageRaw === null ? null : Number(pageRaw);
  if (!id.success || !drawing.success || (raster && !raster.success)) return { error: "notFound" };
  if (page !== null && (!Number.isInteger(page) || page < 1))
    return { fieldErrors: { page: "page" } };
  const result = await setSitePlanDrawing(ctx.viewer.db, {
    sitePlanId: id.data,
    drawingVersionId: drawing.data,
    rasterVersionId: raster?.success ? raster.data : null,
    page,
  });
  if (!result.ok) {
    if (result.error.kind === "invalid") return { error: `drawing_${result.error.message}` };
    return { error: errorKey(result.error) };
  }
  refresh(ctx.org.slug);
  return { ok: true, id: id.data };
}

// Scale and shapes -------------------------------------------------------------------------------------

/** A point list field: JSON [[x, y], ...] with each value 0 to 1. */
function points(form: FormData, key: string): PlanPoint[] | null {
  try {
    const raw = JSON.parse(String(form.get(key) ?? "")) as unknown;
    if (!Array.isArray(raw)) return null;
    const out = raw.map((p) =>
      Array.isArray(p) &&
      p.length === 2 &&
      p.every((v) => typeof v === "number" && v >= 0 && v <= 1)
        ? ([p[0], p[1]] as PlanPoint)
        : null,
    );
    return out.every((p) => p !== null) ? (out as PlanPoint[]) : null;
  } catch {
    return null;
  }
}

export async function setCalibrationAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form.get("org"));
  const id = uuid.safeParse(form.get("sitePlanId"));
  const pair = points(form, "points");
  const distance = Number(text(form, "distance"));
  const unit = text(form, "unit");
  if (!id.success) return { error: "notFound" };
  if (!pair || pair.length !== 2) return { fieldErrors: { points: "scalePoints" } };
  if (!Number.isFinite(distance) || distance <= 0) return { fieldErrors: { distance: "distance" } };
  const [a, b] = pair as [PlanPoint, PlanPoint];
  const feet = unit === "m" ? metersToFeet(distance) : distance;
  const result = await setSitePlanCalibration(ctx.viewer.db, id.data, {
    ax: a[0],
    ay: a[1],
    bx: b[0],
    by: b[1],
    feet,
  });
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: id.data };
}

export async function saveShapeAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form.get("org"));
  const planId = uuid.safeParse(form.get("sitePlanId"));
  const idRaw = text(form, "id");
  const kind = text(form, "kind") as SitePlanShapeKind | null;
  const tone = text(form, "tone") as SitePlanShapeTone | null;
  const label = text(form, "label");
  const shape = points(form, "points");
  if (!planId.success || !kind || !SHAPE_KINDS.includes(kind)) return { error: "notFound" };
  if (!label || label.length > 200) return { fieldErrors: { label: "label" } };
  if (!shape) return { fieldErrors: { points: "percent" } };
  const result = await saveSitePlanShape(ctx.viewer.db, {
    id: idRaw && uuid.safeParse(idRaw).success ? idRaw : null,
    sitePlanId: planId.data,
    kind,
    label,
    tone: tone && SHAPE_TONES.includes(tone) ? tone : null,
    points: shape,
  });
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: result.data };
}

export async function archiveShapeAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form.get("org"));
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const result = await setPlaceArchived(ctx.viewer.db, "site_plan_shapes", id.data, true);
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: id.data };
}

// Point notes and threads ----------------------------------------------------------------------------------

/** A note at a point of the plan: a comment in the plan's thread anchored at that point (ADR 0140 D5). */
export async function postPointNoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form.get("org"));
  const id = uuid.safeParse(form.get("sitePlanId"));
  const at = points(form, "points");
  const body = text(form, "body");
  const mentions = form
    .getAll("mentions")
    .filter((m): m is string => typeof m === "string" && uuid.safeParse(m).success);
  if (!id.success) return { error: "notFound" };
  if (!at || at.length !== 1) return { fieldErrors: { points: "percent" } };
  if (!body || body.length > 10_000) return { fieldErrors: { body: "commentRequired" } };
  const result = await postComment(ctx.viewer.db, {
    subject: { table: "app.site_plans", id: id.data },
    body,
    mentions,
    anchor: pointAnchor(at[0] as PlanPoint),
  });
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: id.data };
}

const PLAN_SUBJECTS = ["app.site_plans", "app.site_plan_pins", "app.site_plan_shapes"] as const;

/** A comment on a pin, a shape or a point note of a plan, with mentions (ADR 0140 D5). */
export async function postPlanCommentAction(
  org: string,
  subject: { readonly table: string; readonly id: string; readonly anchor: string | null },
  body: string,
  mentions: readonly string[],
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  const ctx = await contextFor(org);
  const table = z.enum(PLAN_SUBJECTS).safeParse(subject.table);
  const text = z.string().trim().min(1).max(10_000).safeParse(body);
  if (!table.success || !uuid.safeParse(subject.id).success)
    return { ok: false, error: "notFound" };
  if (!text.success) return { ok: false, error: "commentRequired" };
  const anchor = table.data === "app.site_plans" ? subject.anchor : null;
  if (table.data === "app.site_plans" && !anchor) return { ok: false, error: "site_plan_anchor" };
  const result = await postComment(ctx.viewer.db, {
    subject: { table: table.data, id: subject.id },
    body: text.data,
    mentions: mentions.filter((m) => uuid.safeParse(m).success),
    ...(anchor ? { anchor } : {}),
  });
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  revalidatePath(`/${org}`, "layout");
  return { ok: true };
}

export async function setThreadResolvedAction(
  org: string,
  threadId: string,
  resolved: boolean,
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  const ctx = await contextFor(org);
  if (!uuid.safeParse(threadId).success) return { ok: false, error: "notFound" };
  const result = await setThreadResolved(ctx.viewer.db, threadId, resolved);
  if (!result.ok) return { ok: false, error: errorKey(result.error) };
  revalidatePath(`/${org}`, "layout");
  return { ok: true };
}

// Venue levels -----------------------------------------------------------------------------------------------

export async function saveVenueLevelAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form.get("org"));
  const venueId = uuid.safeParse(form.get("venueId"));
  const idRaw = text(form, "id");
  const name = text(form, "name");
  const order = Number(text(form, "order") ?? "0");
  const fieldErrors: Record<string, string> = {};
  if (!name || name.length > 100) fieldErrors["name"] = "name";
  if (!Number.isInteger(order) || order < -20 || order > 200) fieldErrors["order"] = "levelOrder";
  if (!venueId.success) return { error: "notFound" };
  if (Object.keys(fieldErrors).length > 0 || !name) return { fieldErrors };
  const result = await saveVenueLevel(ctx.viewer.db, {
    id: idRaw && uuid.safeParse(idRaw).success ? idRaw : null,
    venueId: venueId.data,
    name,
    order,
  });
  if (!result.ok) {
    return result.error.kind === "conflict"
      ? { fieldErrors: { name: "levelName" } }
      : { error: errorKey(result.error) };
  }
  refresh(ctx.org.slug);
  return { ok: true, id: result.data.id };
}

export async function moveVenueLevelAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form.get("org"));
  const venueId = uuid.safeParse(form.get("venueId"));
  const order = String(form.get("order") ?? "")
    .split(",")
    .filter((v) => uuid.safeParse(v).success);
  if (!venueId.success || order.length === 0) return { error: "notFound" };
  const result = await reorderVenueLevels(ctx.viewer.db, venueId.data, order);
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true };
}

// Place specs ------------------------------------------------------------------------------------------------

const BOOLEAN_FIELDS = new Set(["forkliftOnSite", "wifiAvailable", "hardlineAvailable"]);
const TEXT_FIELDS = new Set([
  "powerConnections",
  "dockNotes",
  "riggingNotes",
  "networkNotes",
  "specDocumentId",
]);
const INTEGER_FIELDS = new Set([
  "housePowerAmps",
  "housePowerVoltage",
  "housePowerPhase",
  "loadingDockCount",
  "occupantLoad",
  "riggingPointCount",
]);

export async function savePlaceSpecAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form.get("org"));
  const venueId = uuid.safeParse(form.get("venueId"));
  const spaceRaw = text(form, "spaceId");
  if (!venueId.success || (spaceRaw && !uuid.safeParse(spaceRaw).success))
    return { error: "notFound" };
  const fieldErrors: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  for (const field of PLACE_SPEC_FIELDS) {
    const raw = text(form, field);
    if (BOOLEAN_FIELDS.has(field)) {
      values[field] = raw === "yes" ? true : raw === "no" ? false : null;
    } else if (TEXT_FIELDS.has(field)) {
      if (raw && raw.length > (field === "powerConnections" ? 300 : 500))
        fieldErrors[field] = "tooLong";
      values[field] = raw;
    } else if (raw === null) {
      values[field] = null;
    } else {
      const n = Number(raw);
      const ok =
        Number.isFinite(n) && n >= 0 && (!INTEGER_FIELDS.has(field) || Number.isInteger(n));
      if (!ok) fieldErrors[field] = "invalid";
      values[field] = n;
    }
  }
  if (spaceRaw) values["occupantLoad"] = null;
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  const result = await savePlaceSpec(ctx.viewer.db, {
    ...(values as unknown as PlaceSpecInput),
    venueId: venueId.data,
    spaceId: spaceRaw,
  });
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: result.data.id };
}

export async function providePlaceSpecsAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form.get("org"));
  const projectId = uuid.safeParse(form.get("projectId"));
  if (!projectId.success) return { error: "notFound" };
  const result = await providePlaceSpecs(ctx.viewer.db, projectId.data);
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true, id: String(result.data) };
}
