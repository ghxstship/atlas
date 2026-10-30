"use server";

import {
  addChecklistItem,
  assignRecord,
  clearRecurrence,
  createRecord,
  formatRecordKey,
  getRecord,
  removeChecklistItem,
  restoreRecord,
  saveRecordExtension,
  saveRecordExtensionFields,
  saveRecordFields,
  setChecklistItemChecked,
  setRecurrence,
  transitionRecord,
  trashRecord,
  unassignRecord,
  unwatchRecord,
  updateRecord,
  watchRecord,
  type ExtensionValues,
  type RecordFields,
} from "@xos/data/work";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { customFieldsOf } from "@/lib/custom-fields/form";
import { getOrgContext } from "@/lib/shell/context";
import { done, failed, invalid, type ActionResult, type VersionedResult } from "./action-result";
import { initialExtension } from "./kind-fields";

/**
 * Record actions (A08): create, edit, move through states, Trash and restore, checklists,
 * assignments, watching and recurrence. Each resolves the viewer's org context again (404 when it
 * is gone); row level security, the RPCs and the record guards of migrations 0310 and 0311 decide
 * every write, and their refusals come back as catalog keys under `work.errors`.
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
const optionalId = z.uuid().nullable().optional();
const instant = z.iso.datetime({ offset: true }).nullable().optional();

const createSchema = z.object({
  projectId: z.uuid(),
  kind: z.string().min(1).max(40),
  subtype: z.string().min(1).max(80).nullable().optional(),
  title: z.string().trim().min(1).max(200),
  scopeNodeId: optionalId,
  phaseCode: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
  urid: z
    .string()
    .regex(/^\d{4}\.\d{2}\.\d{2}$/)
    .nullable()
    .optional(),
  xyz: z.string().length(1).nullable().optional(),
  ownerId: optionalId,
  startsAt: instant,
  endsAt: instant,
  dueAt: instant,
  /** The form's custom field inputs by field key (A117); absent when the form showed none. */
  customFields: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
      z.object({ value: z.string().max(10_000), currency: z.string().max(3).optional() }),
    )
    .optional(),
});

export type CreateRecordInput = z.input<typeof createSchema>;

export async function createRecordAction(
  org: string,
  input: CreateRecordInput,
): Promise<ActionResult<{ key: string }>> {
  const ctx = await context(org);
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const { customFields, ...fields } = parsed.data;
  const custom = await customFieldsOf(ctx, "app.records", customFields);
  if (custom.fieldErrors) return invalid("customFields");
  const created = await createRecord(ctx.viewer.db, {
    orgId: ctx.org.id,
    ...fields,
    extension: initialExtension(parsed.data.kind, ctx.viewer.person?.id ?? null),
  });
  if (!created.ok) return failed(created.error);
  await custom.save(created.data.id);
  const record = await getRecord(ctx.viewer.db, created.data.id);
  refresh(org);
  return done({ key: record.ok ? record.data.key : formatRecordKey("", created.data.number) });
}

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  subtype: z.string().min(1).max(80).nullable().optional(),
  scopeNodeId: optionalId,
  phaseCode: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
  ownerId: optionalId,
  accountableId: optionalId,
  startsAt: instant,
  endsAt: instant,
  dueAt: instant,
  replanReason: z.string().trim().min(1).max(500).nullable().optional(),
});

export type RecordPatchInput = z.input<typeof patchSchema>;

export async function updateRecordAction(
  org: string,
  recordId: string,
  input: RecordPatchInput,
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = patchSchema.safeParse(input);
  if (!id.safeParse(recordId).success || !parsed.success) return invalid();
  const result = await updateRecord(ctx.viewer.db, recordId, parsed.data);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

const fieldsSchema = z.object({
  title: z.string().trim().min(1).max(200).nullable().optional(),
  subtype: z.string().min(1).max(80).nullable().optional(),
  scopeNodeId: optionalId,
  phaseCode: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
  ownerId: optionalId,
  accountableId: optionalId,
  startsAt: instant,
  endsAt: instant,
  dueAt: instant,
});

// A record always has a title (records.title is not null), so a save may change it but never clear it.
const versionedSchema = z.object({
  set: fieldsSchema.refine((set) => set.title !== null, { path: ["title"] }),
  expect: fieldsSchema.partial().optional(),
  version: z.string().min(1).max(64).nullable().optional(),
  replanReason: z.string().trim().min(1).max(500).nullable().optional(),
});

export type RecordFieldsInput = z.input<typeof versionedSchema>;

/**
 * Saves record properties against the version the person edited (Section 11.7, ADR 0077): the values they started
 * from and the record's updated_at go with the change. A save over someone else's change to the same property comes
 * back as a conflict with their values; nothing is overwritten until the person chooses. Undo and redo send the
 * inverse the same way, without a version, so only the properties they change are compared.
 */
export async function saveRecordFieldsAction(
  org: string,
  recordId: string,
  input: RecordFieldsInput,
): Promise<VersionedResult<RecordFields>> {
  const ctx = await context(org);
  const parsed = versionedSchema.safeParse(input);
  if (!id.safeParse(recordId).success || !parsed.success) return invalid();
  const { set, expect, version, replanReason } = parsed.data;
  const fields = (values: Record<string, string | null | undefined>): RecordFields =>
    Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as RecordFields;
  const result = await saveRecordFields(ctx.viewer.db, recordId, {
    set: fields(set),
    ...(expect ? { expect: fields(expect) } : {}),
    ...(version ? { version } : {}),
    ...(replanReason ? { replanReason } : {}),
  });
  if (!result.ok) return failed(result.error);
  if (!result.data.saved) {
    return {
      ok: false,
      error: { key: "conflict" },
      conflict: { theirs: result.data.current, version: result.data.version },
    };
  }
  refresh(org);
  return done({ version: result.data.version });
}

const transitionSchema = z.object({
  recordId: z.uuid(),
  expected: z.string().min(1).max(40),
  next: z.string().min(1).max(40),
  reason: z.string().trim().min(1).max(500),
  blockerText: z.string().trim().min(1).max(500).nullable().optional(),
  replanReason: z.string().trim().min(1).max(500).nullable().optional(),
});

export async function transitionRecordAction(
  org: string,
  input: z.input<typeof transitionSchema>,
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = transitionSchema.safeParse(input);
  if (!parsed.success) return invalid("reasonRequired");
  const result = await transitionRecord(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function trashRecordAction(org: string, recordId: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(recordId).success) return invalid();
  const result = await trashRecord(ctx.viewer.db, recordId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function restoreRecordAction(org: string, recordId: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(recordId).success) return invalid();
  const result = await restoreRecord(ctx.viewer.db, recordId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

const extensionValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

export async function saveExtensionAction(
  org: string,
  input: { recordId: string; kind: string; fields: ExtensionValues },
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({
      recordId: z.uuid(),
      kind: z.string().regex(/^[A-Z][A-Za-z]+$/),
      fields: z.record(z.string().regex(/^[a-z_]+$/), extensionValue),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await saveRecordExtension(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

/**
 * Saves some of the kind's own attributes against the values the person started from (Section 11.7); someone else's
 * change to one of the same attributes since comes back as a conflict with their values.
 */
export async function saveExtensionFieldsAction(
  org: string,
  input: { recordId: string; kind: string; set: ExtensionValues; expect: ExtensionValues },
): Promise<VersionedResult<ExtensionValues>> {
  const ctx = await context(org);
  const values = z.record(z.string().regex(/^[a-z_]+$/), extensionValue);
  const parsed = z
    .object({
      recordId: z.uuid(),
      kind: z.string().regex(/^[A-Z][A-Za-z]+$/),
      set: values,
      expect: values,
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await saveRecordExtensionFields(ctx.viewer.db, {
    orgId: ctx.org.id,
    ...parsed.data,
  });
  if (!result.ok) return failed(result.error);
  if (!result.data.saved) {
    return {
      ok: false,
      error: { key: "conflict" },
      conflict: { theirs: result.data.current, version: null },
    };
  }
  refresh(org);
  return done({ version: null });
}

export async function addChecklistItemAction(
  org: string,
  recordId: string,
  label: string,
): Promise<ActionResult> {
  const ctx = await context(org);
  const text = z.string().trim().min(1).max(300).safeParse(label);
  if (!id.safeParse(recordId).success || !text.success) return invalid("checklistLabel");
  const result = await addChecklistItem(ctx.viewer.db, {
    orgId: ctx.org.id,
    recordId,
    label: text.data,
  });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function checkItemAction(
  org: string,
  itemId: string,
  checked: boolean,
): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(itemId).success) return invalid();
  const result = await setChecklistItemChecked(ctx.viewer.db, itemId, checked);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function removeChecklistItemAction(
  org: string,
  itemId: string,
): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(itemId).success) return invalid();
  const result = await removeChecklistItem(ctx.viewer.db, itemId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function assignAction(
  org: string,
  recordId: string,
  membershipId: string,
): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(recordId).success || !id.safeParse(membershipId).success) return invalid();
  const result = await assignRecord(ctx.viewer.db, { orgId: ctx.org.id, recordId, membershipId });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function unassignAction(org: string, assignmentId: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(assignmentId).success) return invalid();
  const result = await unassignRecord(ctx.viewer.db, assignmentId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function watchAction(
  org: string,
  recordId: string,
  watchId: string | null,
): Promise<ActionResult> {
  const ctx = await context(org);
  const person = ctx.viewer.person;
  if (!person || !id.safeParse(recordId).success) return invalid();
  const result = watchId
    ? await unwatchRecord(ctx.viewer.db, watchId)
    : await watchRecord(ctx.viewer.db, { orgId: ctx.org.id, recordId, personId: person.id });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

const recurrenceSchema = z.object({
  recordId: z.uuid(),
  rrule: z
    .string()
    .regex(/^FREQ=(DAILY|WEEKLY|MONTHLY)(;[A-Z]+=[A-Za-z0-9,+-]+)*$/)
    .nullable(),
  timeZone: z.string().min(1).max(64),
  untilAt: instant,
});

export async function setRecurrenceAction(
  org: string,
  input: z.input<typeof recurrenceSchema>,
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = recurrenceSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const { recordId, rrule, timeZone, untilAt } = parsed.data;
  const result = rrule
    ? await setRecurrence(ctx.viewer.db, {
        orgId: ctx.org.id,
        recordId,
        rrule,
        timeZone,
        untilAt: untilAt ?? null,
      })
    : await clearRecurrence(ctx.viewer.db, recordId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}
