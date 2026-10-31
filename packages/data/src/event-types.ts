import type { XosClient } from "./client.ts";
import type { DocumentRequirement, EventAudience, EventScale } from "./projects.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Event types (B14, G-250, migrations 3030 and 3038, ADR 0153 decisions D2 and D7): the kinds of event an org produces.
 * Each picks the template a new project starts from by scale and audience band, carries the A117 project fields intake
 * shows (Visible, or Required by a gate) and the document types a project of the type needs (document-types.ts).
 * Reads go through row level security (the org's members); writes need projects.template.write. A type a live project
 * names is archived, never deleted (event_type_in_use).
 */

export interface EventTypeTemplateRule {
  readonly id: string;
  /** NULL band means any. */
  readonly scale: EventScale | null;
  readonly audience: EventAudience | null;
  readonly templateId: string;
  readonly templateName: string | null;
}

export interface EventTypeField {
  readonly id: string;
  readonly customFieldDefinitionId: string;
  readonly fieldKey: string | null;
  readonly label: string | null;
  /** Required for the type: the gate refuses while it is empty. False shows it at intake without requiring it. */
  readonly requiredForType: boolean;
  readonly requiredByGate: number;
  readonly sortOrder: number;
}

export interface EventTypeRequirement {
  readonly id: string;
  readonly documentTypeId: string;
  readonly documentTypeName: string | null;
  readonly requirement: DocumentRequirement;
  readonly requiredByGate: number;
  readonly sortOrder: number;
}

export interface EventType {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly intakeGuidance: string | null;
  readonly sortOrder: number;
  /** When the type was archived; an archived type is hidden from intake. */
  readonly archivedAt: string | null;
  readonly templates: readonly EventTypeTemplateRule[];
  readonly fields: readonly EventTypeField[];
  readonly requirements: readonly EventTypeRequirement[];
}

interface TypeRow {
  id: string;
  name: string;
  description: string | null;
  intake_guidance: string | null;
  sort_order: number;
  retired_at: string | null;
  templates: {
    id: string;
    event_scale: EventScale | null;
    event_audience: EventAudience | null;
    template_id: string;
    deleted_at: string | null;
    template: { name: string } | null;
  }[];
  fields: {
    id: string;
    custom_field_definition_id: string;
    required_for_type: boolean;
    required_by_gate: number;
    sort_order: number;
    deleted_at: string | null;
    definition: { field_key: string; label: string; deleted_at: string | null } | null;
  }[];
  requirements: {
    id: string;
    document_type_id: string;
    requirement: DocumentRequirement;
    required_by_gate: number;
    sort_order: number;
    deleted_at: string | null;
    document_type: { name: string; deleted_at: string | null } | null;
  }[];
}

const TYPE_COLUMNS =
  "id, name, description, intake_guidance, sort_order, retired_at, " +
  "templates:event_type_templates(id, event_scale, event_audience, template_id, deleted_at, template:templates(name)), " +
  "fields:event_type_fields(id, custom_field_definition_id, required_for_type, required_by_gate, sort_order, deleted_at, definition:custom_field_definitions(field_key, label, deleted_at)), " +
  "requirements:event_type_document_requirements(id, document_type_id, requirement, required_by_gate, sort_order, deleted_at, document_type:document_types(name, deleted_at))";

const SCALE_ORDER: readonly EventScale[] = ["Intimate", "Small", "Medium", "Large", "Major"];
const AUDIENCE_ORDER: readonly EventAudience[] = [
  "Public Ticketed",
  "Public Free",
  "Invite Only",
  "Trade",
  "Internal",
];
const bandIndex = <T>(order: readonly T[], value: T | null) =>
  value === null ? order.length : order.indexOf(value);

function toEventType(r: TypeRow): EventType {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    intakeGuidance: r.intake_guidance,
    sortOrder: r.sort_order,
    archivedAt: r.retired_at,
    templates: r.templates
      .filter((t) => t.deleted_at === null)
      .map((t) => ({
        id: t.id,
        scale: t.event_scale,
        audience: t.event_audience,
        templateId: t.template_id,
        templateName: t.template?.name ?? null,
      }))
      .sort(
        (a, b) =>
          bandIndex(SCALE_ORDER, a.scale) - bandIndex(SCALE_ORDER, b.scale) ||
          bandIndex(AUDIENCE_ORDER, a.audience) - bandIndex(AUDIENCE_ORDER, b.audience),
      ),
    fields: r.fields
      .filter((f) => f.deleted_at === null && f.definition?.deleted_at === null)
      .map((f) => ({
        id: f.id,
        customFieldDefinitionId: f.custom_field_definition_id,
        fieldKey: f.definition?.field_key ?? null,
        label: f.definition?.label ?? null,
        requiredForType: f.required_for_type,
        requiredByGate: f.required_by_gate,
        sortOrder: f.sort_order,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder),
    requirements: r.requirements
      .filter((q) => q.deleted_at === null && q.document_type?.deleted_at === null)
      .map((q) => ({
        id: q.id,
        documentTypeId: q.document_type_id,
        documentTypeName: q.document_type?.name ?? null,
        requirement: q.requirement,
        requiredByGate: q.required_by_gate,
        sortOrder: q.sort_order,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

/** The org's live event types with their rules, fields and requirements, in their order; archived ones on request. */
export async function listEventTypes(
  db: XosClient,
  orgId: string,
  options: { readonly includeArchived?: boolean } = {},
): Promise<Result<EventType[]>> {
  let query = untyped(db)
    .from("event_types")
    .select(TYPE_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (!options.includeArchived) query = query.is("retired_at", null);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok((data as unknown as TypeRow[]).map(toEventType));
}

/** One live event type, archived or not. */
export async function getEventType(db: XosClient, id: string): Promise<Result<EventType>> {
  const { data, error } = await untyped(db)
    .from("event_types")
    .select(TYPE_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toEventType(data as unknown as TypeRow));
}

export interface EventTypeInput {
  readonly name: string;
  readonly description?: string | null;
  readonly intakeGuidance?: string | null;
  readonly sortOrder?: number;
}

const blank = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

/** Adds an event type to the org. */
export async function createEventType(
  db: XosClient,
  orgId: string,
  input: EventTypeInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await untyped(db)
    .from("event_types")
    .insert({
      org_id: orgId,
      name: input.name.trim(),
      description: blank(input.description),
      intake_guidance: blank(input.intakeGuidance),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: (data as { id: string }).id });
}

/** Renames or redescribes an event type. */
export async function updateEventType(
  db: XosClient,
  id: string,
  input: EventTypeInput,
): Promise<Result<null>> {
  return touched(
    await untyped(db)
      .from("event_types")
      .update({
        name: input.name.trim(),
        description: blank(input.description),
        intake_guidance: blank(input.intakeGuidance),
        ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      })
      .eq("id", id)
      .is("deleted_at", null)
      .select("id"),
  );
}

/** Archives an event type, hiding it from intake while projects keep it, or brings it back. */
export async function archiveEventType(
  db: XosClient,
  id: string,
  archived: boolean,
): Promise<Result<null>> {
  return touched(
    await untyped(db)
      .from("event_types")
      .update({ retired_at: archived ? new Date().toISOString() : null })
      .eq("id", id)
      .is("deleted_at", null)
      .select("id"),
  );
}

/** Moves an event type to Trash; refused with event_type_in_use while a live project names it. */
export async function removeEventType(db: XosClient, id: string): Promise<Result<null>> {
  return touched(
    await untyped(db)
      .from("event_types")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .is("deleted_at", null)
      .select("id"),
  );
}

function touched(result: {
  data: unknown[] | null;
  error: Parameters<typeof toDataError>[0] | null;
}): Result<null> {
  if (result.error) return fail(toDataError(result.error));
  if (!result.data || result.data.length === 0) return fail({ kind: "not-found" });
  return ok(null);
}

/**
 * Replaces an event type's template rules: rules no longer listed go to Trash, new ones are added, and a rule for the
 * same band pair takes the new template. A NULL band is "any".
 */
export async function setEventTypeTemplates(
  db: XosClient,
  eventType: EventType,
  rules: readonly {
    readonly scale: EventScale | null;
    readonly audience: EventAudience | null;
    readonly templateId: string;
  }[],
): Promise<Result<null>> {
  const key = (s: EventScale | null, a: EventAudience | null) => `${s ?? ""}|${a ?? ""}`;
  const wanted = new Map(rules.map((r) => [key(r.scale, r.audience), r]));
  const now = new Date().toISOString();
  for (const current of eventType.templates) {
    const next = wanted.get(key(current.scale, current.audience));
    if (next && next.templateId === current.templateId) {
      wanted.delete(key(current.scale, current.audience));
      continue;
    }
    const { error } = await untyped(db)
      .from("event_type_templates")
      .update({ deleted_at: now })
      .eq("id", current.id);
    if (error) return fail(toDataError(error));
  }
  if (wanted.size > 0) {
    const { error } = await untyped(db)
      .from("event_type_templates")
      .insert(
        [...wanted.values()].map((r) => ({
          event_type_id: eventType.id,
          event_scale: r.scale,
          event_audience: r.audience,
          template_id: r.templateId,
        })),
      );
    if (error) return fail(toDataError(error));
  }
  return ok(null);
}

/** Replaces an event type's field set, in the given order: fields no longer listed go to Trash. */
export async function setEventTypeFields(
  db: XosClient,
  eventType: EventType,
  fields: readonly {
    readonly customFieldDefinitionId: string;
    readonly requiredForType: boolean;
    readonly requiredByGate: number;
  }[],
): Promise<Result<null>> {
  const now = new Date().toISOString();
  const current = new Map(eventType.fields.map((f) => [f.customFieldDefinitionId, f]));
  const listed = new Set(fields.map((f) => f.customFieldDefinitionId));
  for (const f of eventType.fields) {
    if (listed.has(f.customFieldDefinitionId)) continue;
    const { error } = await untyped(db)
      .from("event_type_fields")
      .update({ deleted_at: now })
      .eq("id", f.id);
    if (error) return fail(toDataError(error));
  }
  for (const [index, f] of fields.entries()) {
    const row = {
      required_for_type: f.requiredForType,
      required_by_gate: f.requiredByGate,
      sort_order: index + 1,
    };
    const existing = current.get(f.customFieldDefinitionId);
    const { error } = existing
      ? await untyped(db).from("event_type_fields").update(row).eq("id", existing.id)
      : await untyped(db)
          .from("event_type_fields")
          .insert({
            ...row,
            event_type_id: eventType.id,
            custom_field_definition_id: f.customFieldDefinitionId,
          });
    if (error) return fail(toDataError(error));
  }
  return ok(null);
}

/** Replaces an event type's document requirements, in the given order: requirements no longer listed go to Trash. */
export async function setEventTypeRequirements(
  db: XosClient,
  eventType: EventType,
  requirements: readonly {
    readonly documentTypeId: string;
    readonly requirement: DocumentRequirement;
    readonly requiredByGate: number;
  }[],
): Promise<Result<null>> {
  const now = new Date().toISOString();
  const current = new Map(eventType.requirements.map((r) => [r.documentTypeId, r]));
  const listed = new Set(requirements.map((r) => r.documentTypeId));
  for (const r of eventType.requirements) {
    if (listed.has(r.documentTypeId)) continue;
    const { error } = await untyped(db)
      .from("event_type_document_requirements")
      .update({ deleted_at: now })
      .eq("id", r.id);
    if (error) return fail(toDataError(error));
  }
  for (const [index, r] of requirements.entries()) {
    const row = {
      requirement: r.requirement,
      required_by_gate: r.requiredByGate,
      sort_order: index + 1,
    };
    const existing = current.get(r.documentTypeId);
    const { error } = existing
      ? await untyped(db).from("event_type_document_requirements").update(row).eq("id", existing.id)
      : await untyped(db)
          .from("event_type_document_requirements")
          .insert({ ...row, event_type_id: eventType.id, document_type_id: r.documentTypeId });
    if (error) return fail(toDataError(error));
  }
  return ok(null);
}

/**
 * The rule that picks a type's template for a scale and audience, as private.resolve_event_type_template reads the
 * rules (3030): the most specific matching one, (scale, audience) before (scale, any) before (any, audience) before
 * (any, any). Pure, for the wizard's Review step; the database resolves again when the project is created, and also
 * skips a rule whose template is unpublished.
 */
export function resolveTemplate(
  eventType: Pick<EventType, "templates">,
  scale: EventScale | null,
  audience: EventAudience | null,
  published: (templateId: string) => boolean = () => true,
): EventTypeTemplateRule | null {
  const matches = eventType.templates.filter(
    (r) =>
      (r.scale === null || r.scale === scale) &&
      (r.audience === null || r.audience === audience) &&
      published(r.templateId),
  );
  matches.sort(
    (a, b) =>
      Number(b.scale !== null) - Number(a.scale !== null) ||
      Number(b.audience !== null) - Number(a.audience !== null),
  );
  return matches[0] ?? null;
}

export type IntakeTemplateChoice = "type" | "template" | "none";
export type ProjectCopyPart =
  "Plan" | "Pass Categories" | "Hotel Blocks" | "Budgets" | "Advance Forms";

export interface IntakeInput {
  readonly orgId: string;
  readonly key: string;
  readonly name: string;
  readonly timeZone: string;
  readonly startsOn?: string | null;
  readonly endsOn?: string | null;
  readonly venueId?: string | null;
  readonly eventTypeId?: string | null;
  readonly eventScale?: EventScale | null;
  readonly eventAudience?: EventAudience | null;
  readonly templateChoice: IntakeTemplateChoice;
  readonly templateId?: string | null;
  readonly withoutDates?: boolean;
  readonly loadInFrom?: string | null;
  readonly loadInTo?: string | null;
  readonly loadOutFrom?: string | null;
  readonly loadOutTo?: string | null;
  readonly copyFromProjectId?: string | null;
  readonly copyParts?: readonly ProjectCopyPart[];
  readonly copyOffsetDays?: number | null;
}

/**
 * Creates a project through the staged intake (app.create_project_from_intake, 3038) in one transaction: the template,
 * the type and bands, the Load In and Load Out days and an optional copy from a past project. Any refusal leaves no
 * project and comes back typed.
 */
export async function createProjectFromIntake(
  db: XosClient,
  input: IntakeInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await untyped(db).rpc("create_project_from_intake", {
    p_org_id: input.orgId,
    p_project_key: input.key,
    p_name: input.name.trim(),
    p_time_zone: input.timeZone,
    p_starts_on: input.startsOn ?? null,
    p_ends_on: input.endsOn ?? null,
    p_venue_id: input.venueId ?? null,
    p_event_type_id: input.eventTypeId ?? null,
    p_event_scale: input.eventScale ?? null,
    p_event_audience: input.eventAudience ?? null,
    p_template_choice: input.templateChoice,
    p_template_id: input.templateId ?? null,
    p_without_dates: input.withoutDates ?? false,
    p_load_in_from: input.loadInFrom ?? null,
    p_load_in_to: input.loadInTo ?? null,
    p_load_out_from: input.loadOutFrom ?? null,
    p_load_out_to: input.loadOutTo ?? null,
    p_copy_from_project_id: input.copyFromProjectId ?? null,
    p_copy_parts: [...(input.copyParts ?? [])],
    p_copy_offset_days: input.copyOffsetDays ?? null,
  });
  if (error) return fail(toDataError(error));
  if (typeof data !== "string")
    return fail({ kind: "unexpected", message: "create_project_from_intake returned no id." });
  return ok({ id: data });
}
