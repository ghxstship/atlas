"use server";

import {
  addTemplateItem,
  applyTemplate,
  createDraftVersion,
  createTemplate,
  createTemplateFromProject,
  deleteTemplate,
  listTemplates,
  publishTemplateVersion,
  removeTemplateItem,
  updateTemplateVersion,
} from "@xos/data/workflow";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { fromDataError, type WorkflowActionState } from "@/lib/workflow/state";

/**
 * Projects > Templates actions (A33): create and edit templates, their draft versions and items,
 * publish, create a project from a template and save a project as one. The database decides every
 * rule (projects.template.write, projects.project.create, frozen published versions).
 */

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

const blank = (v: FormDataEntryValue | null) =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const optionalText = (max: number) => z.string().max(max).nullable();
const zone = z
  .string()
  .nullable()
  .refine((v) => v === null || Intl.supportedValuesOf("timeZone").includes(v));
const currency = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .nullable();
const days = z.coerce.number().int().min(1).max(3660).nullable();

function done(slug: string, id?: string): WorkflowActionState {
  revalidatePath(`/${slug}/projects/templates`);
  return { ok: true, ...(id ? { id } : {}), at: Date.now() };
}

const input = { error: "input" as const };

export async function createTemplateAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      name: z.string().min(1).max(200),
      description: optionalText(2000),
      timeZone: zone,
      currency,
      durationDays: days,
    })
    .safeParse({
      name: blank(form.get("name")),
      description: blank(form.get("description")),
      timeZone: blank(form.get("timeZone")),
      currency: blank(form.get("currency")),
      durationDays: blank(form.get("durationDays")),
    });
  if (!parsed.success) return { ...input, at: Date.now() };
  const result = await createTemplate(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  return result.ok ? done(ctx.org.slug, result.data) : fromDataError(result.error);
}

export async function deleteTemplateAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { ...input, at: Date.now() };
  const result = await deleteTemplate(ctx.viewer.db, id.data);
  return result.ok ? done(ctx.org.slug) : fromDataError(result.error);
}

export async function newDraftAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("templateId"));
  if (!id.success) return { ...input, at: Date.now() };
  const templates = await listTemplates(ctx.viewer.db, ctx.org.id);
  if (!templates.ok) return fromDataError(templates.error);
  const template = templates.data.find((x) => x.id === id.data);
  if (!template) return { error: "notFound", at: Date.now() };
  const result = await createDraftVersion(ctx.viewer.db, { template });
  return result.ok ? done(ctx.org.slug, result.data) : fromDataError(result.error);
}

export async function updateVersionAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      id: z.uuid(),
      notes: optionalText(2000),
      timeZone: zone,
      currency,
      durationDays: days,
    })
    .safeParse({
      id: form.get("id"),
      notes: blank(form.get("notes")),
      timeZone: blank(form.get("timeZone")),
      currency: blank(form.get("currency")),
      durationDays: blank(form.get("durationDays")),
    });
  if (!parsed.success) return { ...input, at: Date.now() };
  const result = await updateTemplateVersion(ctx.viewer.db, parsed.data);
  return result.ok ? done(ctx.org.slug) : fromDataError(result.error);
}

export async function addItemAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("Scope Node"),
        versionId: z.uuid(),
        name: z.string().min(1).max(200),
        scopeKind: z.enum(["Show", "Standing Venue"]),
        scopeCodeSuffix: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,15}$/),
      }),
      z.object({
        kind: z.literal("Record"),
        versionId: z.uuid(),
        name: z.string().min(1).max(200),
        recordKind: z.string().min(1).max(50),
        xyz: z.enum(["X", "Y", "Z"]),
        phaseCode: z.string().max(10).nullable(),
        dueOffsetDays: z.coerce.number().int().min(-3660).max(3660).nullable(),
      }),
    ])
    .safeParse({
      kind: form.get("kind"),
      versionId: form.get("versionId"),
      name: blank(form.get("name")),
      scopeKind: blank(form.get("scopeKind")),
      scopeCodeSuffix: blank(form.get("scopeCodeSuffix"))?.toUpperCase() ?? null,
      recordKind: blank(form.get("recordKind")),
      xyz: blank(form.get("xyz")),
      phaseCode: blank(form.get("phaseCode")),
      dueOffsetDays: blank(form.get("dueOffsetDays")),
    });
  if (!parsed.success) return { ...input, at: Date.now() };
  const d = parsed.data;
  const result = await addTemplateItem(
    ctx.viewer.db,
    d.kind === "Scope Node"
      ? {
          versionId: d.versionId,
          kind: d.kind,
          name: d.name,
          scopeKind: d.scopeKind,
          scopeCodeSuffix: d.scopeCodeSuffix,
          recordKind: null,
          xyz: null,
          phaseCode: null,
          dueOffsetDays: null,
        }
      : {
          versionId: d.versionId,
          kind: d.kind,
          name: d.name,
          scopeKind: null,
          scopeCodeSuffix: null,
          recordKind: d.recordKind,
          xyz: d.xyz,
          phaseCode: d.phaseCode,
          dueOffsetDays: d.dueOffsetDays,
        },
  );
  return result.ok ? done(ctx.org.slug, result.data) : fromDataError(result.error);
}

export async function removeItemAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { ...input, at: Date.now() };
  const result = await removeTemplateItem(ctx.viewer.db, id.data);
  return result.ok ? done(ctx.org.slug) : fromDataError(result.error);
}

export async function publishAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("versionId"));
  if (!id.success) return { ...input, at: Date.now() };
  const result = await publishTemplateVersion(ctx.viewer.db, id.data);
  return result.ok ? done(ctx.org.slug) : fromDataError(result.error);
}

export async function applyTemplateAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      templateId: z.uuid(),
      projectKey: z.string().regex(/^[A-Za-z]{2,5}$/),
      name: z.string().min(1).max(200),
      startsOn: z.iso.date().nullable(),
      timeZone: zone,
    })
    .safeParse({
      templateId: form.get("templateId"),
      projectKey: blank(form.get("projectKey")),
      name: blank(form.get("name")),
      startsOn: blank(form.get("startsOn")),
      timeZone: blank(form.get("timeZone")),
    });
  if (!parsed.success) return { ...input, at: Date.now() };
  const result = await applyTemplate(ctx.viewer.db, {
    ...parsed.data,
    projectKey: parsed.data.projectKey.toUpperCase(),
    venueId: null,
  });
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/projects`, "layout");
  return { ok: true, id: parsed.data.projectKey.toUpperCase(), at: Date.now() };
}

export async function saveProjectAsTemplateAction(
  _: WorkflowActionState,
  form: FormData,
): Promise<WorkflowActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      projectId: z.uuid(),
      name: z.string().min(1).max(200),
      description: optionalText(2000),
    })
    .safeParse({
      projectId: form.get("projectId"),
      name: blank(form.get("name")),
      description: blank(form.get("description")),
    });
  if (!parsed.success) return { ...input, at: Date.now() };
  const result = await createTemplateFromProject(ctx.viewer.db, parsed.data);
  return result.ok ? done(ctx.org.slug, result.data) : fromDataError(result.error);
}
