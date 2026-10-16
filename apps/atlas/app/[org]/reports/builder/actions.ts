"use server";

import { listProjects } from "@xos/data/finance";
import {
  AGGREGATES,
  CHART_TYPES,
  FILTER_OPERATORS,
  deleteReportDefinition,
  previewReport,
  saveReportDefinition,
  sourceOf,
  type ReportDefinition,
  type ReportPreview,
} from "@xos/data/report-builder";
import { runReport } from "@xos/data/reports";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { fromDataError, type WorkflowActionState } from "@/lib/workflow/state";

/**
 * Report builder actions (A33 on A18's report definitions, 0550): preview a definition as the
 * viewer, save it, delete it and queue a run. Row level security decides every row.
 */

const field = z.string().regex(/^[a-z][a-z0-9_.]*$/);

const definitionShape = z.object({
  id: z.uuid().nullable(),
  name: z.string().trim().min(1).max(200),
  sourceCode: z.string().regex(/^[a-z][a-z_]*$/),
  customObjectTypeId: z.uuid().nullable(),
  chart: z.enum(CHART_TYPES as [string, ...string[]]),
  groupBy: field.nullable(),
  shared: z.boolean(),
  fields: z
    .array(z.object({ field, aggregate: z.enum(AGGREGATES as [string, ...string[]]) }))
    .max(20),
  filters: z
    .array(
      z.object({
        field,
        operator: z.enum(FILTER_OPERATORS as [string, ...string[]]),
        value: z.string().max(1000).nullable(),
      }),
    )
    .max(20),
});

export type DefinitionInput = z.input<typeof definitionShape>;

async function contextFor(org: string) {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  return ctx;
}

function parse(input: DefinitionInput): ReportDefinition | null {
  const parsed = definitionShape.safeParse(input);
  if (!parsed.success) return null;
  const source = sourceOf(parsed.data.sourceCode);
  if (!source) return null;
  const known = new Set(source.fields.map((f) => f.key));
  if (parsed.data.fields.some((f) => !known.has(f.field))) return null;
  if (parsed.data.filters.some((f) => !known.has(f.field))) return null;
  if (parsed.data.groupBy !== null && !known.has(parsed.data.groupBy)) return null;
  return { ...(parsed.data as Omit<ReportDefinition, "mine">), mine: true };
}

export type PreviewOutcome =
  | { readonly ok: true; readonly preview: ReportPreview }
  | { readonly ok: false; readonly state: WorkflowActionState };

export async function previewAction(org: string, input: DefinitionInput): Promise<PreviewOutcome> {
  const ctx = await contextFor(org);
  const definition = parse(input);
  if (!definition) return { ok: false, state: { error: "input", at: Date.now() } };
  const projects = await listProjects(ctx.viewer.db, ctx.org.id);
  if (!projects.ok) return { ok: false, state: fromDataError(projects.error) };
  const result = await previewReport(ctx.viewer.db, {
    orgId: ctx.org.id,
    projectIds: projects.data.map((p) => p.id),
    definition,
  });
  return result.ok
    ? { ok: true, preview: result.data }
    : { ok: false, state: fromDataError(result.error) };
}

export async function saveDefinitionAction(
  org: string,
  input: DefinitionInput,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(org);
  const definition = parse(input);
  if (!definition) return { error: "input", at: Date.now() };
  const result = await saveReportDefinition(ctx.viewer.db, {
    orgId: ctx.org.id,
    membershipId: ctx.org.membershipId,
    definition,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/reports`, "layout");
  return { ok: true, id: result.data, at: Date.now() };
}

export async function deleteDefinitionAction(
  org: string,
  id: string,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(org);
  if (!z.uuid().safeParse(id).success) return { error: "input", at: Date.now() };
  const result = await deleteReportDefinition(ctx.viewer.db, id);
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/reports`, "layout");
  return { ok: true, at: Date.now() };
}

export async function queueRunAction(
  org: string,
  id: string,
  format: string,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(org);
  const parsed = z
    .object({ id: z.uuid(), format: z.enum(["CSV", "XLSX", "PDF"]) })
    .safeParse({ id, format });
  if (!parsed.success) return { error: "input", at: Date.now() };
  const result = await runReport(ctx.viewer.db, {
    reportDefinitionId: parsed.data.id,
    format: parsed.data.format,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/reports`, "layout");
  return { ok: true, id: result.data.id, at: Date.now() };
}
