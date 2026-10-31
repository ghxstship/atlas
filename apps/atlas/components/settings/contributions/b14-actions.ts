"use server";

import {
  adoptStandardDocumentTypes,
  removeDocumentType,
  saveDocumentType,
} from "@xos/data/document-types";
import {
  archiveEventType,
  createEventType,
  getEventType,
  removeEventType,
  setEventTypeFields,
  setEventTypeRequirements,
  setEventTypeTemplates,
  updateEventType,
} from "@xos/data/event-types";
import {
  EVENT_AUDIENCES,
  EVENT_SCALES,
  type EventAudience,
  type EventScale,
} from "@xos/data/setup";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { contextFor } from "@/lib/platform/action-context";
import { fromDataError } from "@/lib/platform/data-error";
import { done, field, inputError, type PlatformActionState } from "@/lib/platform/state";

/**
 * Server actions of B14's panels on Settings, Templates (RRR-238, ADR 0153 D2, D3 and D7): event types with their
 * template rules, field sets and document requirements, and the org's document types. Each writes with the viewer's
 * client, so row level security (projects.template.write) and the 3030 and 3031 guards decide; `intent` picks the
 * change. A name already taken comes back as `event_type_taken` or `document_type_taken`.
 */

const uuid = z.uuid();
const gate = z.coerce.number().int().min(1).max(9);

function refresh(slug: string): void {
  revalidatePath(`/${slug}/settings/templates`);
  revalidatePath(`/${slug}/projects`);
}

function fail(error: Parameters<typeof fromDataError>[0], taken: string): PlatformActionState {
  if (error.kind === "conflict") return { rule: taken, at: Date.now() };
  return fromDataError(error);
}

const text = (form: FormData, key: string, max: number) => {
  const value = field(form, key);
  return value.length <= max ? value : null;
};

export async function eventTypeAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const intent = field(form, "intent");
  const id = field(form, "id");
  if (intent !== "create" && !uuid.safeParse(id).success) return inputError();
  const db = ctx.viewer.db;
  if (intent === "archive" || intent === "restore") {
    const result = await archiveEventType(db, id, intent === "archive");
    if (!result.ok) return fromDataError(result.error);
    refresh(ctx.org.slug);
    return done(id);
  }
  if (intent === "remove") {
    const result = await removeEventType(db, id);
    if (!result.ok) return fromDataError(result.error);
    refresh(ctx.org.slug);
    return done(id);
  }
  const name = field(form, "name");
  const description = text(form, "description", 2000);
  const guidance = text(form, "intakeGuidance", 2000);
  if (!name || name.length > 100 || description === null || guidance === null) return inputError();
  const input = { name, description, intakeGuidance: guidance };
  const result =
    intent === "create"
      ? await createEventType(db, ctx.org.id, input)
      : await updateEventType(db, id, input);
  if (!result.ok) return fail(result.error, "event_type_taken");
  refresh(ctx.org.slug);
  return done(intent === "create" && result.data ? (result.data as { id: string }).id : id);
}

const band = <T extends string>(values: readonly T[], raw: string): T | null | undefined =>
  raw === "" ? null : (values as readonly string[]).includes(raw) ? (raw as T) : undefined;

/** Adds a template rule for a (scale, audience) pair, replacing the one the pair had, or removes one. */
export async function eventTypeRuleAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const typeId = field(form, "eventTypeId");
  if (!uuid.safeParse(typeId).success) return inputError();
  const type = await getEventType(ctx.viewer.db, typeId);
  if (!type.ok) return fromDataError(type.error);
  const rule = (r: (typeof type.data.templates)[number]) => ({
    scale: r.scale,
    audience: r.audience,
    templateId: r.templateId,
  });
  let next: { scale: EventScale | null; audience: EventAudience | null; templateId: string }[];
  if (field(form, "intent") === "remove") {
    const ruleId = field(form, "ruleId");
    next = type.data.templates.filter((r) => r.id !== ruleId).map(rule);
  } else {
    const scale = band<EventScale>(EVENT_SCALES, field(form, "scale"));
    const audience = band<EventAudience>(EVENT_AUDIENCES, field(form, "audience"));
    const templateId = field(form, "templateId");
    if (scale === undefined || audience === undefined || !uuid.safeParse(templateId).success)
      return inputError();
    next = [
      ...type.data.templates.map(rule).filter((r) => r.scale !== scale || r.audience !== audience),
      { scale, audience, templateId },
    ];
  }
  const result = await setEventTypeTemplates(ctx.viewer.db, type.data, next);
  if (!result.ok) return fromDataError(result.error);
  refresh(ctx.org.slug);
  return done(typeId);
}

/** Adds a project field to a type's field set, changes whether it is required and by which gate, or removes it. */
export async function eventTypeFieldAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const typeId = field(form, "eventTypeId");
  const definitionId = field(form, "customFieldDefinitionId");
  if (!uuid.safeParse(typeId).success || !uuid.safeParse(definitionId).success) return inputError();
  const type = await getEventType(ctx.viewer.db, typeId);
  if (!type.ok) return fromDataError(type.error);
  const current = type.data.fields.map((f) => ({
    customFieldDefinitionId: f.customFieldDefinitionId,
    requiredForType: f.requiredForType,
    requiredByGate: f.requiredByGate,
  }));
  let next = current.filter((f) => f.customFieldDefinitionId !== definitionId);
  if (field(form, "intent") !== "remove") {
    const by = gate.safeParse(field(form, "requiredByGate") || "1");
    if (!by.success) return inputError();
    const entry = {
      customFieldDefinitionId: definitionId,
      requiredForType: form.get("requiredForType") === "on",
      requiredByGate: by.data,
    };
    const at = current.findIndex((f) => f.customFieldDefinitionId === definitionId);
    next = at >= 0 ? current.map((f, i) => (i === at ? entry : f)) : [...current, entry];
  }
  const result = await setEventTypeFields(ctx.viewer.db, type.data, next);
  if (!result.ok) return fromDataError(result.error);
  refresh(ctx.org.slug);
  return done(typeId);
}

/** Adds a document type a project of the type needs, Required or Recommended by a gate, or removes it. */
export async function eventTypeRequirementAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const typeId = field(form, "eventTypeId");
  const documentTypeId = field(form, "documentTypeId");
  if (!uuid.safeParse(typeId).success || !uuid.safeParse(documentTypeId).success)
    return inputError();
  const type = await getEventType(ctx.viewer.db, typeId);
  if (!type.ok) return fromDataError(type.error);
  const current = type.data.requirements.map((r) => ({
    documentTypeId: r.documentTypeId,
    requirement: r.requirement,
    requiredByGate: r.requiredByGate,
  }));
  let next = current.filter((r) => r.documentTypeId !== documentTypeId);
  if (field(form, "intent") !== "remove") {
    const by = gate.safeParse(field(form, "requiredByGate") || "1");
    const requirement = field(form, "requirement");
    if (!by.success || (requirement !== "Required" && requirement !== "Recommended"))
      return inputError();
    const entry = { documentTypeId, requirement, requiredByGate: by.data } as const;
    const at = current.findIndex((r) => r.documentTypeId === documentTypeId);
    next = at >= 0 ? current.map((r, i) => (i === at ? entry : r)) : [...current, entry];
  }
  const result = await setEventTypeRequirements(ctx.viewer.db, type.data, next);
  if (!result.ok) return fromDataError(result.error);
  refresh(ctx.org.slug);
  return done(typeId);
}

export async function documentTypeAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const intent = field(form, "intent");
  const db = ctx.viewer.db;
  if (intent === "adopt") {
    const result = await adoptStandardDocumentTypes(db, ctx.org.id);
    if (!result.ok) return fromDataError(result.error);
    refresh(ctx.org.slug);
    return done(undefined, String(result.data));
  }
  const id = field(form, "id");
  if (intent !== "create" && !uuid.safeParse(id).success) return inputError();
  if (intent === "remove") {
    const result = await removeDocumentType(db, id);
    if (!result.ok) return fromDataError(result.error);
    refresh(ctx.org.slug);
    return done(id);
  }
  const name = field(form, "name");
  const description = text(form, "description", 2000);
  if (!name || name.length > 100 || description === null) return inputError();
  const result = await saveDocumentType(db, {
    ...(intent === "update" ? { id } : {}),
    orgId: ctx.org.id,
    name,
    description,
  });
  if (!result.ok) return fail(result.error, "document_type_taken");
  refresh(ctx.org.slug);
  return done(result.data.id);
}
