"use server";

import type { DataError } from "@xos/data";
import {
  COVERAGE_MEDIUMS,
  COVERAGE_TONES,
  MEASUREMENT_CRITERION,
  OBJECTIVE_DIRECTIONS,
  OBJECTIVES_CRITERION,
  correctProjectMeasurement,
  measurementEvidenceUri,
  recordEarnedMediaItem,
  recordProjectMeasurement,
  saveProjectObjective,
  withdrawEarnedMediaItem,
  withdrawProjectMeasurement,
  withdrawProjectObjective,
} from "@xos/data/measurements";
import { attestEvidence } from "@xos/data/projects";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getProjectContextFor, type ProjectContext } from "@/lib/projects/context";

/**
 * Server actions for project measurement (A98, Section 4.10): gate 1 objectives, measured figures and their
 * corrections, earned media coverage, and recording the objectives or the measurement on the evidence spine. Each
 * resolves the project context again (404 when it is gone), validates input and calls the repository; row level
 * security and the 1550 and 1551 guards decide every write, and their refusals come back as keys under
 * `measurement.errors`.
 */

export interface MeasurementActionState {
  readonly ok?: boolean;
  /** A key under `measurement.errors`. */
  readonly error?: string;
  readonly values?: Readonly<Record<string, string | number>>;
  /** Field name to a key under `measurement.errors`. */
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /** What the person typed, returned on failure so the form can show it again. */
  readonly echo?: Readonly<Record<string, string>>;
}

const KNOWN_REFUSALS = new Set([
  "measurement_unit_dimension",
  "measurement_unit_required",
  "measurement_out_of_range",
  "measurement_whole_count",
  "measurement_in_future",
  "measurement_metric_derived",
  "measurement_correction_reason",
  "project_objectives_locked",
  "project_objective_immutable",
  "project_measurement_immutable",
  "earned_media_in_future",
  "earned_media_item_immutable",
]);

function errorState(error: DataError): MeasurementActionState {
  switch (error.kind) {
    case "refusal":
      return KNOWN_REFUSALS.has(error.rule)
        ? { error: error.rule }
        : { error: "refused", values: { rule: error.rule } };
    case "conflict":
    case "invalid":
    case "not-found":
      return { error: error.kind };
    case "unexpected":
      return { error: "unexpected" };
  }
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function withEcho(form: FormData, state: MeasurementActionState): MeasurementActionState {
  if (state.ok) return state;
  const echo: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") echo[k] = v;
  return { ...state, echo };
}

async function projectFor(form: FormData): Promise<ProjectContext> {
  const ctx = await getProjectContextFor({
    org: field(form, "org"),
    projectKey: field(form, "projectKey"),
  });
  if (!ctx) notFound();
  return ctx;
}

function refresh(ctx: ProjectContext) {
  revalidatePath(`/${ctx.org.org.slug}`, "layout");
}

/** Field error keys under `measurement.errors`; any other issue reads as a general invalid entry. */
const FIELD_ERRORS = new Set(["required", "tooLong", "number", "date", "url", "wholeNumber"]);

function invalid(issues: readonly z.core.$ZodIssue[]): MeasurementActionState {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    const name = String(issue.path[0] ?? "");
    fieldErrors[name] ??= FIELD_ERRORS.has(issue.message) ? issue.message : "invalid";
  }
  return { error: "invalid", fieldErrors };
}

const code = z.string().regex(/^[a-z][a-z0-9_]*$/, "required");
const id = z.uuid("not-found");
const day = z.iso.date("date");
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "tooLong")
    .transform((v) => (v === "" ? null : v));
const required = (max: number) => z.string().trim().min(1, "required").max(max, "tooLong");
const number = z
  .string()
  .trim()
  .min(1, "number")
  .transform((v) => Number(v))
  .refine((v) => Number.isFinite(v), "number");
const link = z
  .string()
  .trim()
  .max(2000, "tooLong")
  .refine((v) => v === "" || /^https?:\/\/\S+$/i.test(v), "url")
  .transform((v) => (v === "" ? null : v));
const enumOf = <T extends string>(values: readonly T[]) =>
  z.string().refine((v): v is T => (values as readonly string[]).includes(v), "required");

/** A figure, or Unmeasured when the not-measured box is ticked. */
function figureOf(form: FormData) {
  if (field(form, "notMeasured") === "on") return { value: null, unitCode: null } as const;
  const parsed = z
    .object({ value: number, unitCode: code })
    .safeParse({ value: field(form, "value"), unitCode: field(form, "unitCode") });
  return parsed.success ? parsed.data : parsed.error;
}

async function done<T>(
  ctx: ProjectContext,
  result: { ok: true; data: T } | { ok: false; error: DataError },
): Promise<MeasurementActionState> {
  if (!result.ok) return errorState(result.error);
  refresh(ctx);
  return { ok: true };
}

// Objectives ---------------------------------------------------------------------------------------------------------

export async function saveObjectiveAction(
  _: MeasurementActionState,
  form: FormData,
): Promise<MeasurementActionState> {
  const ctx = await projectFor(form);
  const parsed = z
    .object({
      objectiveId: z.union([z.literal(""), id]),
      metricCode: code,
      direction: enumOf(OBJECTIVE_DIRECTIONS),
      targetValue: number,
      unitCode: code,
      note: optionalText(2000),
    })
    .safeParse({
      objectiveId: field(form, "objectiveId"),
      metricCode: field(form, "metricCode"),
      direction: field(form, "direction"),
      targetValue: field(form, "targetValue"),
      unitCode: field(form, "unitCode"),
      note: field(form, "note"),
    });
  if (!parsed.success) return withEcho(form, invalid(parsed.error.issues));
  const { objectiveId, ...rest } = parsed.data;
  const result = await saveProjectObjective(ctx.org.viewer.db, {
    id: objectiveId === "" ? null : objectiveId,
    projectId: ctx.project.id,
    ...rest,
  });
  return withEcho(form, await done(ctx, result));
}

export async function withdrawObjectiveAction(
  _: MeasurementActionState,
  form: FormData,
): Promise<MeasurementActionState> {
  const ctx = await projectFor(form);
  const objective = id.safeParse(field(form, "objectiveId"));
  if (!objective.success) return { error: "not-found" };
  return done(ctx, await withdrawProjectObjective(ctx.org.viewer.db, objective.data));
}

// Figures ------------------------------------------------------------------------------------------------------------

export async function recordFigureAction(
  _: MeasurementActionState,
  form: FormData,
): Promise<MeasurementActionState> {
  const ctx = await projectFor(form);
  const figure = figureOf(form);
  const parsed = z
    .object({
      metricCode: code,
      measuredOn: day,
      source: enumOf(["Manual", "Import"] as const),
      sourceReference: optionalText(300),
      sourceUri: link,
      note: optionalText(2000),
    })
    .safeParse({
      metricCode: field(form, "metricCode"),
      measuredOn: field(form, "measuredOn"),
      source: field(form, "source") || "Manual",
      sourceReference: field(form, "sourceReference"),
      sourceUri: field(form, "sourceUri"),
      note: field(form, "note"),
    });
  const issues = [
    ...(parsed.success ? [] : parsed.error.issues),
    ...(figure instanceof z.ZodError ? figure.issues : []),
  ];
  if (!parsed.success || figure instanceof z.ZodError) return withEcho(form, invalid(issues));
  const result = await recordProjectMeasurement(ctx.org.viewer.db, {
    projectId: ctx.project.id,
    ...parsed.data,
    ...figure,
  });
  return withEcho(form, await done(ctx, result));
}

export async function correctFigureAction(
  _: MeasurementActionState,
  form: FormData,
): Promise<MeasurementActionState> {
  const ctx = await projectFor(form);
  const figure = figureOf(form);
  const parsed = z.object({ measurementId: id, measuredOn: day, reason: required(500) }).safeParse({
    measurementId: field(form, "measurementId"),
    measuredOn: field(form, "measuredOn"),
    reason: field(form, "reason"),
  });
  const issues = [
    ...(parsed.success ? [] : parsed.error.issues),
    ...(figure instanceof z.ZodError ? figure.issues : []),
  ];
  if (!parsed.success || figure instanceof z.ZodError) return withEcho(form, invalid(issues));
  const result = await correctProjectMeasurement(ctx.org.viewer.db, {
    id: parsed.data.measurementId,
    measuredOn: parsed.data.measuredOn,
    reason: parsed.data.reason,
    ...figure,
  });
  return withEcho(form, await done(ctx, result));
}

export async function withdrawFigureAction(
  _: MeasurementActionState,
  form: FormData,
): Promise<MeasurementActionState> {
  const ctx = await projectFor(form);
  const parsed = z
    .object({ measurementId: id, reason: optionalText(500) })
    .safeParse({ measurementId: field(form, "measurementId"), reason: field(form, "reason") });
  if (!parsed.success) return withEcho(form, invalid(parsed.error.issues));
  const result = await withdrawProjectMeasurement(ctx.org.viewer.db, {
    id: parsed.data.measurementId,
    reason: parsed.data.reason,
  });
  return withEcho(form, await done(ctx, result));
}

// Earned media -------------------------------------------------------------------------------------------------------

export async function addCoverageAction(
  _: MeasurementActionState,
  form: FormData,
): Promise<MeasurementActionState> {
  const ctx = await projectFor(form);
  const parsed = z
    .object({
      title: required(300),
      outlet: required(200),
      medium: enumOf(COVERAGE_MEDIUMS),
      publishedOn: day,
      url: link,
      reach: z
        .string()
        .trim()
        .refine((v) => v === "" || /^\d{1,15}$/.test(v), "wholeNumber")
        .transform((v) => (v === "" ? null : Number(v))),
      tone: z
        .string()
        .refine((v) => v === "" || (COVERAGE_TONES as readonly string[]).includes(v), "required")
        .transform((v) => (v === "" ? null : (v as (typeof COVERAGE_TONES)[number]))),
      note: optionalText(2000),
    })
    .safeParse({
      title: field(form, "title"),
      outlet: field(form, "outlet"),
      medium: field(form, "medium"),
      publishedOn: field(form, "publishedOn"),
      url: field(form, "url"),
      reach: field(form, "reach"),
      tone: field(form, "tone"),
      note: field(form, "note"),
    });
  if (!parsed.success) return withEcho(form, invalid(parsed.error.issues));
  const result = await recordEarnedMediaItem(ctx.org.viewer.db, {
    projectId: ctx.project.id,
    ...parsed.data,
  });
  return withEcho(form, await done(ctx, result));
}

export async function withdrawCoverageAction(
  _: MeasurementActionState,
  form: FormData,
): Promise<MeasurementActionState> {
  const ctx = await projectFor(form);
  const item = id.safeParse(field(form, "itemId"));
  if (!item.success) return { error: "not-found" };
  return done(ctx, await withdrawEarnedMediaItem(ctx.org.viewer.db, item.data));
}

// Evidence -----------------------------------------------------------------------------------------------------------

/**
 * Records the project's objectives (G1.OBJECTIVES_STATED) or its measurement (G8.MEASUREMENT_REPORTED) on the
 * evidence spine, naming them by URN; the person attests them against this project (assertion rank 4).
 */
export async function attestMeasurementAction(
  _: MeasurementActionState,
  form: FormData,
): Promise<MeasurementActionState> {
  const ctx = await projectFor(form);
  const kind = field(form, "kind");
  if (kind !== "objectives" && kind !== "measurement") return { error: "invalid" };
  const note = optionalText(2000).safeParse(field(form, "note"));
  const result = await attestEvidence(ctx.org.viewer.db, {
    projectId: ctx.project.id,
    criterionId: kind === "objectives" ? OBJECTIVES_CRITERION : MEASUREMENT_CRITERION,
    uri: measurementEvidenceUri(kind, ctx.project.id),
    note: note.success ? note.data : null,
    rank: 4,
  });
  return done(ctx, result);
}
